'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readLocal } = require('../plugin/src/core/state.js');
const { contentHash } = require('../plugin/src/core/event.js');
const { makeRepo, git } = require('./helpers/repo.js');
const { runCli } = require('./helpers/cli-runner.js');
const { runHook, assertSilent, fixture, capturedEvents, storeText, storeOf, walk } = require('./helpers/hook-runner.js');

function repo(t, options) {
  const made = makeRepo(options);
  t.after(made.cleanup);
  return made;
}
const common = (root) => path.join(root, '.git');
const ofType = (root, type) => capturedEvents(root).filter((event) => event.event_type === type);
const init = (root) => runCli(['init', '--yes'], { cwd: root });
const hook = (root, name, overrides = {}) => {
  const payload = fixture(name, { cwd: root, ...overrides });
  assertSilent(runHook({ stdin: JSON.stringify(payload), cwd: root, event: payload.hook_event_name }));
};

test('init outside a repository fails with exit 1 and a clear message', (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pd-cli-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const result = runCli(['init', '--yes'], { cwd: dir });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not inside a Git repository/i);
});

test('init with --yes activates and stores the Git name', (t) => {
  const { root } = repo(t);
  const result = init(root);
  assert.equal(result.status, 0, result.stderr);
  const state = readLocal(common(root));
  assert.equal(state.activated, true);
  assert.equal(state.paused, false);
  assert.equal(state.actor_name, 'Test Person');
  assert.match(state.machine, /^[0-9a-f]{8}$/);
  assert.deepEqual(state.redact_patterns, []);
});

test('init shows what is recorded and where it goes', (t) => {
  const { root } = repo(t);
  const { stdout } = init(root);
  assert.match(stdout, /What is recorded/);
  assert.match(stdout, /Where it goes: only \.git\/product-decisions on this machine/);
  assert.match(stdout, /product-decisions pause/);
});

test('init writes a consent event that records the statement', (t) => {
  const { root } = repo(t);
  init(root);
  const [event] = ofType(root, 'consent');
  assert.equal(event.tool, 'cli');
  assert.equal(event.session_id, 'local');
  assert.deepEqual(event.actor, { type: 'user', name: 'Test Person' });
  assert.match(event.payload.statement, /What is recorded/);
  assert.equal(contentHash(event), event.content_hash);
});

test('init with no Git user.name uses "unknown" and warns', (t) => {
  const { root } = repo(t);
  git(root, 'config', '--unset', 'user.name');
  const missing = path.join(os.tmpdir(), 'pd-no-such-git-config');
  const result = runCli(['init', '--yes'], { cwd: root, env: { GIT_CONFIG_GLOBAL: missing, GIT_CONFIG_SYSTEM: missing } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readLocal(common(root)).actor_name, 'unknown');
  assert.match(result.stderr, /user\.name/);
});

test('init without --yes and without a terminal refuses, and activates nothing', (t) => {
  const { root } = repo(t);
  const result = runCli(['init'], { cwd: root });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--yes/);
  assert.equal(readLocal(common(root)), null);
  assert.equal(fs.existsSync(storeOf(root)), false);
});

test('init twice stays activated, and does not repeat consent', (t) => {
  const { root } = repo(t);
  init(root);
  const first = readLocal(common(root));
  const again = init(root);
  assert.equal(again.status, 0);
  assert.match(again.stdout, /already active/i);
  assert.deepEqual(readLocal(common(root)), first);
  assert.equal(ofType(root, 'consent').length, 1);
});

test('init from a linked worktree activates the whole repository', (t) => {
  const { root } = repo(t);
  const wt = path.join(path.dirname(root), 'wt');
  git(root, 'worktree', 'add', '-q', '-b', 'wt', wt);
  assert.equal(runCli(['init', '--yes'], { cwd: wt }).status, 0);
  assert.equal(readLocal(common(root)).activated, true);
});

test('pause stops capture', (t) => {
  const { root } = repo(t);
  init(root);
  assert.equal(runCli(['pause'], { cwd: root }).status, 0);
  const state = readLocal(common(root));
  assert.equal(state.paused, true);
  assert.equal(typeof state.paused_at, 'string');
  hook(root, 'UserPromptSubmit.json', { prompt: 'MARKER-WHILE-PAUSED' });
  assert.equal(ofType(root, 'user_prompt').length, 0);
  assert(!storeText(root).includes('MARKER-WHILE-PAUSED'));
});

test('resume restores capture and writes one gap event with no content', (t) => {
  const { root } = repo(t);
  init(root);
  runCli(['pause'], { cwd: root });
  const pausedAt = readLocal(common(root)).paused_at;
  hook(root, 'UserPromptSubmit.json', { prompt: 'MARKER-WHILE-PAUSED' });
  assert.equal(runCli(['resume'], { cwd: root }).status, 0);

  const state = readLocal(common(root));
  assert.equal(state.paused, false);
  assert.equal(state.paused_at, null);

  const gaps = ofType(root, 'gap');
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].payload.from, pausedAt);
  assert.equal(typeof gaps[0].payload.to, 'string');
  assert.deepEqual(Object.keys(gaps[0].payload).sort(), ['from', 'to']);
  assert(!storeText(root).includes('MARKER-WHILE-PAUSED'));

  hook(root, 'UserPromptSubmit.json', { prompt: 'after resume' });
  assert.equal(ofType(root, 'user_prompt').length, 1);
});

test('pause twice keeps the first time, and resume without pause adds no gap', (t) => {
  const { root } = repo(t);
  init(root);
  runCli(['pause'], { cwd: root });
  const first = readLocal(common(root)).paused_at;
  assert.equal(runCli(['pause'], { cwd: root }).status, 0);
  assert.equal(readLocal(common(root)).paused_at, first);
  runCli(['resume'], { cwd: root });
  assert.equal(runCli(['resume'], { cwd: root }).status, 0);
  assert.equal(ofType(root, 'gap').length, 1);
});

test('pause and resume on an inactive repository fail with exit 1', (t) => {
  const { root } = repo(t);
  for (const command of ['pause', 'resume']) {
    const result = runCli([command], { cwd: root });
    assert.equal(result.status, 1, command);
    assert.match(result.stderr, /not active/i);
  }
  assert.equal(fs.existsSync(storeOf(root)), false);
});

test('status --json reports the agreed shape', (t) => {
  const { root } = repo(t);
  init(root);
  hook(root, 'SessionStart-startup.json', { session_id: 'one' });
  hook(root, 'Stop.json', { session_id: 'one' });
  hook(root, 'Stop.json', { session_id: 'two' });
  const result = runCli(['status', '--json'], { cwd: root });
  assert.equal(result.status, 0, result.stderr);
  const status = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(status).sort(), ['activated', 'actor', 'errors', 'latency', 'paused', 'repo', 'runtime', 'store', 'tools']);
  assert.equal(status.repo.root, root);
  assert.equal(status.activated, true);
  assert.equal(status.paused, false);
  assert.equal(status.actor, 'Test Person');
  assert.deepEqual(Object.keys(status.tools), ['claude-code']);
  assert.equal(status.tools['claude-code'].sessions, 2);
  assert.equal(status.tools['claude-code'].events, 3);
  assert.match(status.tools['claude-code'].last_event_at, /^\d{4}-/);
  assert(status.store.bytes > 0);
  assert.equal(status.latency.count, 3);
  assert(status.latency.p50 > 0 && status.latency.p95 >= status.latency.p50);
  assert.deepEqual(status.errors, { count: 0, last_at: null });
  assert.equal(status.runtime.node, process.version);
  assert.match(status.runtime.git, /\d+\.\d+/);
});

test('status counts errors', (t) => {
  const { root } = repo(t);
  init(root);
  assertSilent(runHook({ stdin: '{broken', cwd: root }));
  const status = JSON.parse(runCli(['status', '--json'], { cwd: root }).stdout);
  assert.equal(status.errors.count, 1);
  assert.match(status.errors.last_at, /^\d{4}-/);
});

test('status ignores an incomplete last line', (t) => {
  const { root } = repo(t);
  init(root);
  hook(root, 'Stop.json', { session_id: 'one' });
  const file = walk(path.join(storeOf(root), 'raw', 'claude-code'))[0];
  fs.appendFileSync(file, '{"event_id":"partial');
  const status = JSON.parse(runCli(['status', '--json'], { cwd: root }).stdout);
  assert.equal(status.tools['claude-code'].events, 1);
});

test('status on an inactive repository says so, with exit 0', (t) => {
  const { root } = repo(t);
  const text = runCli(['status'], { cwd: root });
  assert.equal(text.status, 0);
  assert.match(text.stdout, /not active/i);
  const json = JSON.parse(runCli(['status', '--json'], { cwd: root }).stdout);
  assert.equal(json.activated, false);
  assert.equal(fs.existsSync(storeOf(root)), false);
});

test('status outside a repository fails with exit 1', (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pd-cli-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(runCli(['status'], { cwd: dir }).status, 1);
});

test('status text shows the state and has no payload content', (t) => {
  const { root } = repo(t);
  init(root);
  hook(root, 'UserPromptSubmit.json', { prompt: 'MARKER-IN-PROMPT' });
  const { stdout } = runCli(['status'], { cwd: root });
  assert.match(stdout, /active/i);
  assert.match(stdout, /claude-code/);
  assert.match(stdout, /p95/);
  assert(!stdout.includes('MARKER'));
});

test('status text shows a paused state', (t) => {
  const { root } = repo(t);
  init(root);
  runCli(['pause'], { cwd: root });
  assert.match(runCli(['status'], { cwd: root }).stdout, /paused/i);
});

test('the CLI writes nothing to the project', (t) => {
  const { root } = repo(t);
  const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const store = storeOf(root);
  const snapshot = () => Object.fromEntries(walk(root)
    .filter((file) => !file.startsWith(store + path.sep))
    .map((file) => [file, hash(file)]));
  const before = { files: snapshot(), status: git(root, 'status', '--porcelain') };
  for (const args of [['init', '--yes'], ['status'], ['pause'], ['resume'], ['status', '--json']]) {
    assert.equal(runCli(args, { cwd: root }).status, 0, args.join(' '));
  }
  assert.deepEqual(snapshot(), before.files);
  assert.equal(git(root, 'status', '--porcelain'), before.status);
});

test('help works, and an unknown command fails', (t) => {
  const { root } = repo(t);
  const help = runCli(['--help'], { cwd: root });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /init/);
  const none = runCli([], { cwd: root });
  assert.equal(none.status, 1);
  const unknown = runCli(['nope'], { cwd: root });
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Unknown command/);
});
