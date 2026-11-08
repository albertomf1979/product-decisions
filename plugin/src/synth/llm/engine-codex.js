'use strict';

// Runs `codex exec` for synthesis of Codex sessions (PRD LLM-11). Built from Codex CLI
// 0.167.0's flags (spike S5) and never run against a real account: pending review.
// Hooks off, read-only sandbox, no saved session; the plugin writes every file itself.
// Codex has no budget flag, so runs are capped by size and count only.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { resolveCommand, childEnv } = require('./engine.js');

/** Finds `codex`: PRODUCT_DECISIONS_CODEX_BIN first, then PATH. */
const resolveCodex = (options) => resolveCommand('codex', 'PRODUCT_DECISIONS_CODEX_BIN', options);

/** A Claude model alias means nothing to Codex: Codex then uses its own default. */
const CLAUDE_MODEL = /^(sonnet|opus|haiku|fable)$|^claude/i;

/**
 * @returns {Promise<{ ok: true, output: object, costUsd: null } | { ok: false, reason: 'missing' | 'timeout' | 'no_output' | 'exit' | 'parse', detail: string }>}
 */
function runCodex({ bin, prompt, system, schema, model, workDir, timeoutMs = 600000, env = process.env }) {
  return new Promise((resolve) => {
    if (!bin) {
      resolve({ ok: false, reason: 'missing', detail: 'codex not found' });
      return;
    }
    fs.mkdirSync(workDir, { recursive: true, mode: 0o700 });
    const schemaFile = path.join(workDir, 'schema.json');
    const lastFile = path.join(workDir, 'last.json');
    fs.writeFileSync(schemaFile, JSON.stringify(schema), { mode: 0o600 });
    fs.rmSync(lastFile, { force: true });
    const args = [
      'exec', '-', '--ephemeral', '--disable', 'hooks', '--sandbox', 'read-only', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check',
      '-C', workDir, '--output-schema', schemaFile, '-o', lastFile,
      ...(model && !CLAUDE_MODEL.test(model) ? ['-m', model] : []),
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
      child = spawn(bin.command, [...bin.prefix, ...args], { cwd: workDir, env: childEnv(env), windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
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
    child.on('error', (err) => finish({ ok: false, reason: err.code === 'ENOENT' || err.code === 'EACCES' ? 'missing' : 'exit', detail: String(err.code || 'spawn error') }));
    child.on('close', (code) => {
      if (code !== 0) {
        finish({ ok: false, reason: 'exit', detail: `exit ${code}` });
        return;
      }
      let text;
      try {
        text = fs.readFileSync(lastFile, 'utf8');
      } catch {
        finish({ ok: false, reason: 'no_output', detail: 'exit 0, no final message' });
        return;
      }
      try {
        const output = JSON.parse(text);
        if (!output || typeof output !== 'object' || Array.isArray(output)) throw new Error('not an object');
        finish({ ok: true, output, costUsd: null });
      } catch {
        finish({ ok: false, reason: 'parse', detail: 'exit 0, final message is not a JSON object' });
      }
    });
    child.stdin.on('error', () => {});
    // codex exec has no system-prompt flag: the instructions lead the prompt.
    child.stdin.end(`System instructions:\n${system}\n\n${prompt}`);
  });
}

module.exports = { resolveCodex, runCodex };
