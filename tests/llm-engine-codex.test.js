'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
require('./helpers/repo.js');
const { resolveCodex, runCodex } = require('../plugin/src/synth/llm/engine-codex.js');
const { installFakeCodex, shimFor } = require('./helpers/fake-codex.js');
const { CONSENT } = require('../plugin/src/core/consent.js');
const { sanitizeConfig } = require('../plugin/src/core/config.js');

const SCHEMA = { type: 'object', properties: { decisions: { type: 'array' } }, required: ['decisions'] };

function setup(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pd-codex-')));
  // On Windows a process the test just killed can hold its folder for a moment.
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  const bin = resolveCodex({ env: { PRODUCT_DECISIONS_CODEX_BIN: installFakeCodex(path.join(dir, 'bin')) } });
  const log = path.join(dir, 'log.jsonl');
  const env = (mode, extra = {}) => ({ ...process.env, FAKE_CODEX_MODE: mode, FAKE_CODEX_LOG: log, CODEX_THREAD_ID: 'parent-thread', ...extra });
  const seen = () => fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).pop();
  const args = { bin, prompt: 'p', system: 'S', schema: SCHEMA, model: 'gpt-5-codex', workDir: path.join(dir, 'work') };
  return { dir, bin, env, seen, args };
}

test('runCodex passes the S5 flags, turns hooks off, and reads the final message from its file', async (t) => {
  const { env, seen, args } = setup(t);
  const outcome = await runCodex({ ...args, env: env('ok', { FAKE_CODEX_OUTPUT: '{"decisions":["x"]}' }) });
  assert.deepEqual(outcome, { ok: true, output: { decisions: ['x'] }, costUsd: null });
  const s = seen();
  assert.equal(s.argv[0], 'exec');
  assert.equal(s.argv[1], '-');
  for (const flag of ['--ephemeral', '--ignore-rules', '--skip-git-repo-check']) assert.ok(s.argv.includes(flag), flag);
  assert.equal(s.argv[s.argv.indexOf('--disable') + 1], 'hooks');
  assert.equal(s.argv[s.argv.indexOf('--sandbox') + 1], 'read-only');
  assert.equal(fs.realpathSync(s.argv[s.argv.indexOf('-C') + 1]), fs.realpathSync(args.workDir));
  assert.deepEqual(JSON.parse(fs.readFileSync(s.argv[s.argv.indexOf('--output-schema') + 1], 'utf8')), SCHEMA);
  assert.equal(s.argv[s.argv.indexOf('-m') + 1], 'gpt-5-codex');
  assert.ok(!s.argv.includes('--dangerously-bypass-hook-trust'));
  assert.equal(s.stdin, 'System instructions:\nS\n\np');
  assert.equal(s.synth, '1');
  assert.equal(s.thread, undefined);
});

test('a Claude model alias is not passed to Codex', async (t) => {
  const { env, seen, args } = setup(t);
  await runCodex({ ...args, model: 'sonnet', env: env('ok') });
  assert.ok(!seen().argv.includes('-m'));
});

test('a missing final message is no_output, a non-JSON one is parse, a non-zero exit is exit, and a timeout is timeout', async (t) => {
  const { env, args } = setup(t);
  for (const [mode, reason] of [['no_output', 'no_output'], ['garbage', 'parse'], ['exit', 'exit']]) {
    const outcome = await runCodex({ ...args, env: env(mode) });
    assert.equal(outcome.reason, reason, mode);
    assert.ok(!/not json/.test(outcome.detail), outcome.detail);
  }
  assert.equal((await runCodex({ ...args, timeoutMs: 500, env: env('sleep') })).reason, 'timeout');
  assert.equal((await runCodex({ ...args, bin: null, env: env('ok') })).reason, 'missing');
});

test('resolveCodex honours PRODUCT_DECISIONS_CODEX_BIN, then PATH, and runs an npm shim through node on Windows', (t) => {
  const { dir } = setup(t);
  assert.equal(resolveCodex({ env: { PRODUCT_DECISIONS_CODEX_BIN: path.join(dir, 'missing') } }), null);
  const win = path.join(dir, 'win');
  fs.mkdirSync(win);
  fs.writeFileSync(path.join(win, 'codex.cmd'), shimFor('node_modules\\@openai\\codex\\bin\\codex.js'));
  assert.deepEqual(resolveCodex({ env: { Path: win }, platform: 'win32' }), { command: process.execPath, prefix: [path.join(win, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')] });
  // A POSIX PATH cannot hold a Windows absolute path (C:\…): checked on POSIX systems only.
  if (process.platform === 'win32') return;
  const posix = path.join(dir, 'posix');
  fs.mkdirSync(posix);
  fs.writeFileSync(path.join(posix, 'codex'), '#!/bin/sh\n', { mode: 0o755 });
  assert.deepEqual(resolveCodex({ env: { PATH: posix }, platform: 'linux' }), { command: path.join(posix, 'codex'), prefix: [] });
});

test('the test helpers hide any real codex on this machine', () => {
  assert.equal(resolveCodex(), null);
  assert.match(process.env.PRODUCT_DECISIONS_CODEX_BIN, /no-codex-in-tests$/);
});

test('consent says Codex synthesis is unverified, runs only on request, and has no per-run budget', () => {
  assert.match(CONSENT, /For Codex sessions this is unverified/);
  assert.match(CONSENT, /Codex\s+has\s+no\s+per-run\s+spending\s+limit/);
});

test('the config accepts codex as an engine', () => {
  assert.equal(sanitizeConfig({ llm: { engine: 'codex' } }).config.llm.engine, 'codex');
});
