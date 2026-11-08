'use strict';

// End to end: two clones, real hook processes fed with real fixtures, the worker, sync,
// and verify, against a local bare remote.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { makeRepo, git } = require('./helpers/repo.js');
const { runCli } = require('./helpers/cli-runner.js');
const { runHook, assertSilent, fixture, codexFixture } = require('./helpers/hook-runner.js');

const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function captureSession(dir, sessionId, prompt, { editPrd = false } = {}) {
  const send = (name, overrides = {}) => {
    const payload = fixture(name, { cwd: dir, session_id: sessionId, ...overrides });
    assertSilent(runHook({ stdin: JSON.stringify(payload), cwd: dir, event: payload.hook_event_name }), name);
  };
  send('SessionStart-startup.json');
  send('UserPromptSubmit.json', { prompt });
  if (editPrd) {
    fs.writeFileSync(path.join(dir, 'PRD.md'), '# PRD\n\nGoal: a shared record.\n');
    send('PostToolUse-Edit.json', { tool_input: { file_path: path.join(dir, 'PRD.md'), old_string: '# PRD', new_string: '# PRD\n\nGoal: a shared record.' } });
  }
  send('Stop.json', { last_assistant_message: `Done: ${prompt}` });
  send('SessionEnd-other.json');
}

test('end to end: two clones capture, publish, and see the same record', (t) => {
  const { root, base, cleanup } = makeRepo();
  t.after(cleanup);
  const remote = path.join(base, 'remote.git');
  git(base, 'init', '-q', '--bare', remote);
  git(root, 'remote', 'add', 'origin', remote);
  git(root, 'push', '-q', 'origin', 'main');

  assert.equal(runCli(['init', '--yes', '--track', 'PRD.md'], { cwd: root }).status, 0);
  const second = path.join(base, 'second');
  git(base, 'clone', '-q', remote, second);
  git(second, 'config', 'user.name', 'Second Person');
  git(second, 'config', 'user.email', 'second@example.com');
  assert.match(runCli(['init', '--yes'], { cwd: second }).stdout, /Joined/);

  const statusBefore = { first: git(root, 'status', '--porcelain'), second: git(second, 'status', '--porcelain') };
  captureSession(root, 'e2e-first-session', 'write the first part', { editPrd: true });
  const prdAfterEdit = hash(path.join(root, 'PRD.md'));
  captureSession(second, 'e2e-second-session', 'write the second part');

  for (const dir of [root, second, root]) assert.equal(runCli(['sync'], { cwd: dir }).status, 0);

  for (const dir of [root, second]) {
    const timeline = fs.readdirSync(path.join(dir, 'product-decisions', 'timeline'));
    assert(timeline.some((f) => f.includes('e2e-first-session')), `${dir} sees the first session`);
    assert(timeline.some((f) => f.includes('e2e-second-session')), `${dir} sees the second session`);
    const verify = runCli(['verify'], { cwd: dir });
    assert.equal(verify.status, 0, verify.stdout);
  }
  assert.equal(git(second, 'status', '--porcelain'), statusBefore.second);
  // The only change in the first clone is the PRD edit the session made itself.
  const others = (status) => status.split('\n').filter((line) => line && !line.endsWith('PRD.md'));
  assert.deepEqual(others(git(root, 'status', '--porcelain')), others(statusBefore.first));
  assert.equal(hash(path.join(root, 'PRD.md')), prdAfterEdit, 'the PRD is only read');
  const changes = fs.readdirSync(path.join(root, 'product-decisions', '01-definition', 'changes'));
  assert.equal(changes.length, 1);
  assert(fs.readdirSync(path.join(second, 'product-decisions', '01-definition', 'changes')).length === 1, 'the second clone sees the change record');
});

test('a Codex session goes from hooks to a chronicle and the indexes, labelled pending review', (t) => {
  const { root, cleanup } = makeRepo();
  t.after(cleanup);
  assert.equal(runCli(['init', '--yes', '--no-push'], { cwd: root }).status, 0);
  const session = 'codex-e2e-1';
  for (const name of ['SessionStart', 'UserPromptSubmit', 'PostToolUse-apply_patch', 'PostModelRequest', 'Stop', 'SessionEnd']) {
    const payload = codexFixture(`${name}.json`, { cwd: root, session_id: session, transcript_path: null });
    assertSilent(runHook({ stdin: JSON.stringify(payload), cwd: root, tool: 'codex', event: payload.hook_event_name }), name);
  }
  assert.equal(runCli(['sync', '--no-push'], { cwd: root }).status, 0);
  const folder = path.join(root, 'product-decisions');
  const chronicle = fs.readdirSync(path.join(folder, 'timeline')).find((f) => f.includes(`-codex-${session}-`));
  assert.ok(chronicle, 'chronicle for the Codex session');
  const text = fs.readFileSync(path.join(folder, 'timeline', chronicle), 'utf8');
  assert.match(text, /gpt-5-codex/);
  assert.match(text, /Add a scope section to the PRD/);
  assert.match(text, /pending review/);
  assert.match(fs.readFileSync(path.join(folder, 'README.md'), 'utf8'), /\| codex \|/);
});
