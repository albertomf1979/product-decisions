'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveClaude, childEnv, runClaude } = require('../plugin/src/synth/llm/engine.js');
const { installFakeClaude, npmShim } = require('./helpers/fake-claude.js');

const SCHEMA = { type: 'object', properties: { decisions: { type: 'array' } }, required: ['decisions'] };

/**
 * On Windows a process the test just killed can hold its folder for a while, and Node 18's
 * rmSync does not retry EBUSY on a subfolder. Retry for up to 5 s, then leave the
 * temporary folder to the system: removing it is not what the test checks.
 */
function removeWhenFree(dir) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if (!['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(err.code)) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
}

function setup(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pd-engine-')));
  t.after(() => removeWhenFree(dir));
  const fake = installFakeClaude(path.join(dir, 'bin'));
  const log = path.join(dir, 'log.jsonl');
  const bin = resolveClaude({ env: { PRODUCT_DECISIONS_CLAUDE_BIN: fake } });
  const fakeEnv = (mode, extra = {}) => ({ ...process.env, FAKE_CLAUDE_MODE: mode, FAKE_CLAUDE_LOG: log, CLAUDE_CODE_SIMPLE: '1', ...extra });
  const readLog = () => fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).pop();
  const args = { bin, prompt: 'p', system: 'S', schema: SCHEMA, model: 'sonnet', maxBudgetUsd: 1, workDir: path.join(dir, 'work') };
  return { dir, fake, bin, fakeEnv, readLog, args };
}

test('runClaude passes the S4 flags, never --bare, and sends the prompt on stdin', async (t) => {
  const { bin, fakeEnv, readLog, args } = setup(t);
  assert.ok(bin);
  const outcome = await runClaude({ ...args, prompt: 'x'.repeat(100000), env: fakeEnv('ok', { FAKE_CLAUDE_OUTPUT: '{"decisions":[]}' }) });
  assert.deepEqual(outcome, { ok: true, output: { decisions: [] }, costUsd: 0.01 });
  const seen = readLog();
  for (const flag of ['-p', '--safe-mode', '--strict-mcp-config', '--no-session-persistence', '--json-schema', '--system-prompt-file', '--max-budget-usd']) assert.ok(seen.argv.includes(flag), flag);
  assert.equal(seen.argv[seen.argv.indexOf('--tools') + 1], '');
  assert.equal(seen.argv[seen.argv.indexOf('--settings') + 1], '{"disableAllHooks":true}');
  assert.equal(seen.argv[seen.argv.indexOf('--output-format') + 1], 'json');
  assert.equal(seen.argv[seen.argv.indexOf('--model') + 1], 'sonnet');
  assert.equal(seen.argv[seen.argv.indexOf('--max-budget-usd') + 1], '1');
  assert.deepEqual(JSON.parse(seen.argv[seen.argv.indexOf('--json-schema') + 1]), SCHEMA);
  assert.ok(!seen.argv.includes('--bare'));
  assert.equal(seen.stdinLength, 100000);
  assert.equal(seen.system, 'S');
  assert.equal(seen.synth, '1');
  assert.equal(seen.simple, undefined);
  assert.equal(fs.realpathSync(seen.cwd), fs.realpathSync(args.workDir));
});

test('each failure has its own reason, and no output text reaches the detail', async (t) => {
  const { fakeEnv, args } = setup(t);
  for (const [mode, reason] of [['budget', 'budget'], ['auth', 'auth'], ['garbage', 'parse'], ['no_output', 'no_output'], ['exit', 'exit']]) {
    const outcome = await runClaude({ ...args, env: fakeEnv(mode) });
    assert.equal(outcome.ok, false, mode);
    assert.equal(outcome.reason, reason, mode);
    assert.ok(!/logged|hello|text only/.test(outcome.detail), outcome.detail);
  }
});

test('a run that exceeds its time is killed and reported as timeout', async (t) => {
  const { fakeEnv, args } = setup(t);
  const started = Date.now();
  const outcome = await runClaude({ ...args, timeoutMs: 500, env: fakeEnv('sleep') });
  assert.equal(outcome.reason, 'timeout');
  assert.ok(Date.now() - started < 8000);
});

test('a missing executable is reported as missing', async (t) => {
  const { args, dir } = setup(t);
  const outcome = await runClaude({ ...args, bin: { command: path.join(dir, 'nope'), prefix: [] }, env: process.env });
  assert.equal(outcome.reason, 'missing');
});

test('childEnv drops session-binding variables and keeps provider settings', () => {
  const env = childEnv({ CLAUDECODE: '1', CLAUDE_CODE_SIMPLE: '1', CLAUDE_CODE_SESSION_ID: 'x', ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE_URL: 'u', CLAUDE_CODE_USE_BEDROCK: '1', PATH: 'p' });
  assert.deepEqual(env, { ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE_URL: 'u', CLAUDE_CODE_USE_BEDROCK: '1', PATH: 'p', PRODUCT_DECISIONS_SYNTH: '1' });
});

test('resolveClaude honours PRODUCT_DECISIONS_CLAUDE_BIN, then PATH, and returns null when absent', (t) => {
  const { fake, dir } = setup(t);
  assert.equal(resolveClaude({ env: { PRODUCT_DECISIONS_CLAUDE_BIN: path.join(dir, 'missing') } }), null);
  assert.ok(resolveClaude({ env: { PRODUCT_DECISIONS_CLAUDE_BIN: fake } }));
  // A POSIX PATH cannot hold a Windows absolute path (C:\…): checked on POSIX systems only.
  if (process.platform === 'win32') return;
  const posixDir = path.join(dir, 'posix');
  fs.mkdirSync(posixDir);
  fs.writeFileSync(path.join(posixDir, 'claude'), '#!/bin/sh\n', { mode: 0o755 });
  assert.deepEqual(resolveClaude({ env: { PATH: `${path.join(dir, 'empty')}:${posixDir}` }, platform: 'linux' }), { command: path.join(posixDir, 'claude'), prefix: [] });
  assert.equal(resolveClaude({ env: { PATH: path.join(dir, 'empty') }, platform: 'linux' }), null);
  assert.equal(resolveClaude({ env: {}, platform: 'linux' }), null);
  assert.ok(resolveClaude({ env: { PRODUCT_DECISIONS_CLAUDE_BIN: fake } }));
});

test('resolveClaude runs an npm .cmd shim through node on Windows, and prefers claude.exe', (t) => {
  const { dir } = setup(t);
  const win = path.join(dir, 'win');
  fs.mkdirSync(win);
  fs.writeFileSync(path.join(win, 'claude.cmd'), npmShim());
  assert.deepEqual(resolveClaude({ env: { Path: win }, platform: 'win32' }), {
    command: process.execPath, prefix: [path.join(win, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js')],
  });
  fs.writeFileSync(path.join(win, 'claude.exe'), '');
  assert.deepEqual(resolveClaude({ env: { Path: win }, platform: 'win32' }), { command: path.join(win, 'claude.exe'), prefix: [] });
  fs.writeFileSync(path.join(dir, 'odd.cmd'), '@echo off\r\nsomething else\r\n');
  assert.equal(resolveClaude({ env: { PRODUCT_DECISIONS_CLAUDE_BIN: path.join(dir, 'odd.cmd') }, platform: 'win32' }), null);
});

test('the test helpers hide any real claude on this machine', () => {
  require('./helpers/repo.js');
  assert.equal(resolveClaude(), null);
  assert.match(process.env.PRODUCT_DECISIONS_CLAUDE_BIN, /no-claude-in-tests$/);
});
