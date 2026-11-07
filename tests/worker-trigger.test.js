'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { triggerFor } = require('../plugin/src/worker/trigger.js');
const { makeRepo, activate } = require('./helpers/repo.js');
const { factor, runHook, assertSilent, fixture, capturedEvents, copyPlugin } = require('./helpers/hook-runner.js');

test('triggerFor maps turn ends, session ends, and session starts', () => {
  assert.equal(triggerFor('agent_response'), 'turn');
  assert.equal(triggerFor('turn_failure'), 'turn');
  assert.equal(triggerFor('session_end'), 'close');
  assert.equal(triggerFor('session_start'), 'recover');
  for (const other of ['user_prompt', 'tool_call', 'compaction', 'subagent_stop']) assert.equal(triggerFor(other), null);
});

function activeRepo(t) {
  const repo = makeRepo();
  t.after(repo.cleanup);
  activate(repo.root);
  return repo;
}

const pendingDir = (root) => path.join(root, '.git', 'product-decisions', 'state', 'pending');

async function waitFor(check, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return check();
}

test('Stop starts a worker that consumes the job', async (t) => {
  const { root } = activeRepo(t);
  assertSilent(runHook({ stdin: JSON.stringify(fixture('Stop.json', { cwd: root })), cwd: root }));
  const done = await waitFor(() => !fs.existsSync(pendingDir(root)) || fs.readdirSync(pendingDir(root)).length === 0, 5000 * factor);
  assert(done, 'the pending job should be consumed');
});

test('events other than turn and session boundaries queue nothing', (t) => {
  const { root } = activeRepo(t);
  assertSilent(runHook({ stdin: JSON.stringify(fixture('UserPromptSubmit.json', { cwd: root })), cwd: root, event: 'UserPromptSubmit' }));
  assert.equal(fs.existsSync(pendingDir(root)), false);
});

test('the hook still exits silently, and still captures, when the worker cannot start', (t) => {
  const { root, base } = activeRepo(t);
  const plugin = copyPlugin(base, 'broken-worker');
  fs.rmSync(path.join(plugin, 'src', 'worker', 'main.js'));
  assertSilent(runHook({ stdin: JSON.stringify(fixture('Stop.json', { cwd: root })), cwd: root, hookPath: path.join(plugin, 'scripts', 'hook.js') }));
  assert.equal(capturedEvents(root).length, 1);
});

test('the hook returns before the worker finishes', (t) => {
  const { root, base } = activeRepo(t);
  const plugin = copyPlugin(base, 'slow-worker');
  fs.writeFileSync(path.join(plugin, 'src', 'worker', 'main.js'), 'setTimeout(() => {}, 3000);\n');
  const result = runHook({ stdin: JSON.stringify(fixture('Stop.json', { cwd: root })), cwd: root, hookPath: path.join(plugin, 'scripts', 'hook.js') });
  assertSilent(result);
  assert(result.ms < 1500 * factor, `took ${result.ms.toFixed(0)} ms`);
});

test('a paused repository starts no worker', (t) => {
  const { root, cleanup } = makeRepo();
  t.after(cleanup);
  activate(root, { paused: true, paused_at: 'x' });
  assertSilent(runHook({ stdin: JSON.stringify(fixture('Stop.json', { cwd: root })), cwd: root }));
  assert.equal(fs.existsSync(pendingDir(root)), false);
});

test('the worker does not run inside the repository folder', (t) => {
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'plugin', 'src', 'worker', 'trigger.js'), 'utf8');
  assert.match(source, /cwd: require\('node:os'\)\.tmpdir\(\)/);
});
