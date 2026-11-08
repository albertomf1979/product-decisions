'use strict';

// Runs `claude -p` headless for synthesis, as validated in spike S4: no tools, no hooks,
// no plugins or MCP servers, no saved session, and never --bare (which would hide a plan
// login). The plugin writes every file itself (PRD LLM-3, LLM-4).

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

/** Variables that tie a process to the session that started the worker. */
const SESSION_VARS = [
  'CLAUDECODE', 'CLAUDE_CODE_SIMPLE', 'CLAUDE_CODE_SAFE_MODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_HOST_SESSION_ID', 'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_PID', 'CODEX_THREAD_ID',
];

/**
 * The environment for the synthesis process: the worker's own, without what binds it to
 * a parent session (a bare parent would make the child bare too), and with the recursion
 * guard set. Provider settings such as API keys and base URLs are kept.
 */
function childEnv(env) {
  const out = { ...env };
  for (const name of SESSION_VARS) delete out[name];
  out.PRODUCT_DECISIONS_SYNTH = '1';
  return out;
}

const isFile = (file) => {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
};

/** An npm `.cmd` shim cannot be spawned without a shell, so its JavaScript entry runs on node. */
function fromShim(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const match = /"%dp0%\\([^"]+\.(?:c|m)?js)"/i.exec(text);
  if (!match) return null;
  return { command: process.execPath, prefix: [path.join(path.dirname(file), ...match[1].split('\\'))] };
}

const asCommand = (file) => (/\.cmd$/i.test(file) ? fromShim(file) : { command: file, prefix: [] });

/**
 * Finds an agent's executable: its override variable first, then PATH (`<name>.exe`,
 * then `<name>.cmd` on Windows).
 *
 * @returns {{ command: string, prefix: string[] } | null}
 */
function resolveCommand(name, overrideVar, { env = process.env, platform = process.platform } = {}) {
  const override = env[overrideVar];
  if (override) return isFile(override) ? asCommand(override) : null;
  const windows = platform === 'win32';
  const dirs = String(env.PATH ?? env.Path ?? '').split(windows ? ';' : ':').filter(Boolean);
  for (const file of windows ? [`${name}.exe`, `${name}.cmd`] : [name]) {
    for (const dir of dirs) {
      const full = path.join(dir, file);
      if (isFile(full)) return asCommand(full);
    }
  }
  return null;
}

/** Finds `claude`: PRODUCT_DECISIONS_CLAUDE_BIN first, then PATH. */
const resolveClaude = (options) => resolveCommand('claude', 'PRODUCT_DECISIONS_CLAUDE_BIN', options);

const AUTH = /not logged in|log ?in|authenticat|credential|api key|401|403/i;

function classify(stdout, code) {
  let result;
  try {
    result = JSON.parse(stdout);
  } catch {
    return { ok: false, reason: code === 0 ? 'parse' : 'exit', detail: `exit ${code}` };
  }
  if (!result || typeof result !== 'object') return { ok: false, reason: 'parse', detail: `exit ${code}` };
  const detail = `exit ${code}, subtype ${typeof result.subtype === 'string' ? result.subtype.slice(0, 40) : 'none'}`;
  if (result.subtype === 'error_max_budget_usd') return { ok: false, reason: 'budget', detail };
  if (result.is_error) {
    const text = [result.result, ...(Array.isArray(result.errors) ? result.errors : [])].filter((x) => typeof x === 'string').join(' ');
    return { ok: false, reason: AUTH.test(text) ? 'auth' : 'exit', detail };
  }
  if (code !== 0) return { ok: false, reason: 'exit', detail };
  const output = result.structured_output;
  if (!output || typeof output !== 'object' || Array.isArray(output)) return { ok: false, reason: 'no_output', detail };
  return { ok: true, output, costUsd: Number.isFinite(result.total_cost_usd) ? result.total_cost_usd : null };
}

/**
 * Runs one synthesis request. The prompt goes on stdin (arguments cannot carry it,
 * especially on Windows), the system prompt in a file inside the empty work directory.
 *
 * @returns {Promise<{ ok: true, output: object, costUsd: number | null } | { ok: false, reason: 'missing' | 'timeout' | 'auth' | 'budget' | 'no_output' | 'exit' | 'parse', detail: string }>}
 */
function runClaude({ bin, prompt, system, schema, model, maxBudgetUsd, workDir, timeoutMs = 600000, env = process.env }) {
  return new Promise((resolve) => {
    if (!bin) {
      resolve({ ok: false, reason: 'missing', detail: 'claude not found' });
      return;
    }
    fs.mkdirSync(workDir, { recursive: true, mode: 0o700 });
    const systemFile = path.join(workDir, 'system.txt');
    fs.writeFileSync(systemFile, system, { mode: 0o600 });
    const args = [
      '-p', '--safe-mode', '--settings', '{"disableAllHooks":true}', '--tools', '', '--strict-mcp-config',
      '--no-session-persistence', '--output-format', 'json', '--json-schema', JSON.stringify(schema),
      '--system-prompt-file', systemFile, '--model', model, '--max-budget-usd', String(maxBudgetUsd),
    ];
    let settled = false;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    let child;
    try {
      child = spawn(bin.command, [...bin.prefix, ...args], { cwd: workDir, env: childEnv(env), windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    } catch (err) {
      resolve({ ok: false, reason: 'missing', detail: String(err.code || 'spawn failed') });
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // Already gone.
      }
      finish({ ok: false, reason: 'timeout', detail: `after ${timeoutMs} ms` });
    }, timeoutMs);
    const chunks = [];
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.on('error', (err) => finish({ ok: false, reason: err.code === 'ENOENT' || err.code === 'EACCES' ? 'missing' : 'exit', detail: String(err.code || 'spawn error') }));
    child.on('close', (code) => finish(classify(Buffer.concat(chunks).toString('utf8'), code)));
    child.stdin.on('error', () => {}); // A child that exits early closes its stdin.
    child.stdin.end(prompt);
  });
}

module.exports = { resolveClaude, resolveCommand, childEnv, runClaude, SESSION_VARS };
