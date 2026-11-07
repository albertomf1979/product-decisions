'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildEvent } = require('../plugin/src/core/event.js');
const { locateRepo } = require('../plugin/src/core/locate.js');
const { readGit } = require('../plugin/src/core/githead.js');
const { rawFilePath, readSessionMeta } = require('../plugin/src/core/store.js');
const { runTurn, recoverSessions } = require('../plugin/src/worker/turn.js');
const { readTranscriptTail } = require('../plugin/src/worker/enrich.js');
const { verifyFile } = require('../plugin/src/worker/seal.js');
const { makeRepo, activate, git } = require('./helpers/repo.js');
const { runHook, assertSilent, fixture, capturedEvents } = require('./helpers/hook-runner.js');

const TRANSCRIPT = path.join(__dirname, 'fixtures', 'claude-code', 'transcript-sample.jsonl');

function setup(t, options) {
  const repo = makeRepo(options);
  t.after(repo.cleanup);
  activate(repo.root);
  return repo.root;
}
const common = (root) => path.join(root, '.git');
const file = (root) => rawFilePath(common(root), 'claude-code', 's1', 'abcd1234');
function seed(root, cwd = root) {
  const event = buildEvent(
    { eventType: 'user_prompt', actorType: 'user', agent: { name: 'main' }, payload: { prompt: 'hi' } },
    { tool: 'claude-code', sessionId: 's1', actorName: 'Test Person', git: readGit(locateRepo(cwd), cwd), sources: [], summary: 'hi' },
  );
  fs.mkdirSync(path.dirname(file(root)), { recursive: true });
  fs.appendFileSync(file(root), `${JSON.stringify(event)}\n`);
}
const job = (root, over = {}) => ({ kind: 'turn', tool: 'claude-code', sessionId: 's1', cwd: root, transcriptPath: TRANSCRIPT, ...over });
const ofType = (root, type) => capturedEvents(root, { all: true }).filter((e) => e.event_type === type);
const commit = (root, message) => { git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', message); return git(root, 'rev-parse', 'HEAD'); };

test('a change made through the shell appears in file_changes', async (t) => {
  const root = setup(t);
  seed(root);
  fs.writeFileSync(path.join(root, 'PRD.md'), '# PRD\nchanged\n');
  fs.writeFileSync(path.join(root, 'notes.md'), 'new\n');
  await runTurn(job(root), { commonDir: common(root) });
  const [changes] = ofType(root, 'file_changes');
  assert.deepEqual(changes.payload.files, [
    { path: 'PRD.md', status: 'modified', added: 1, removed: 0 },
    { path: 'notes.md', status: 'untracked', added: null, removed: null },
  ]);
});

test('an identical snapshot writes no second event', async (t) => {
  const root = setup(t);
  seed(root);
  fs.writeFileSync(path.join(root, 'notes.md'), 'new\n');
  await runTurn(job(root), { commonDir: common(root) });
  await runTurn(job(root), { commonDir: common(root) });
  assert.equal(ofType(root, 'file_changes').length, 1);
});

test('the documentation folder and the store never appear in a snapshot', async (t) => {
  const root = setup(t);
  seed(root);
  fs.appendFileSync(path.join(root, '.git', 'info', 'exclude'), '/product-decisions/\n');
  fs.mkdirSync(path.join(root, 'product-decisions'));
  fs.writeFileSync(path.join(root, 'product-decisions', 'README.md'), 'generated\n');
  fs.writeFileSync(path.join(root, 'notes.md'), 'new\n');
  await runTurn(job(root), { commonDir: common(root) });
  const paths = ofType(root, 'file_changes')[0].payload.files.map((f) => f.path);
  assert.deepEqual(paths, ['notes.md']);
});

test('renames, deletions, and untracked files are listed', async (t) => {
  const root = setup(t);
  fs.writeFileSync(path.join(root, 'a.md'), 'a\n');
  fs.writeFileSync(path.join(root, 'b.md'), 'b\n');
  commit(root, 'files');
  seed(root);
  git(root, 'mv', 'a.md', 'renamed.md');
  fs.rmSync(path.join(root, 'b.md'));
  fs.writeFileSync(path.join(root, 'c.md'), 'c\n');
  await runTurn(job(root), { commonDir: common(root) });
  const byPath = Object.fromEntries(ofType(root, 'file_changes')[0].payload.files.map((f) => [f.path, f.status]));
  assert.equal(byPath['renamed.md'], 'renamed');
  assert.equal(byPath['b.md'], 'deleted');
  assert.equal(byPath['c.md'], 'untracked');
});

test('binary files are listed with null line counts', async (t) => {
  const root = setup(t);
  fs.writeFileSync(path.join(root, 'image.bin'), Buffer.from([0, 1, 2, 3]));
  commit(root, 'binary');
  seed(root);
  fs.writeFileSync(path.join(root, 'image.bin'), Buffer.from([0, 9, 9, 9]));
  await runTurn(job(root), { commonDir: common(root) });
  assert.deepEqual(ofType(root, 'file_changes')[0].payload.files, [{ path: 'image.bin', status: 'modified', added: null, removed: null }]);
});

test('a new commit writes one commit_linked event with its files', async (t) => {
  const root = setup(t);
  seed(root);
  fs.writeFileSync(path.join(root, 'feature.md'), 'x\n');
  const sha = commit(root, 'Add the feature');
  await runTurn(job(root), { commonDir: common(root) });
  const linked = ofType(root, 'commit_linked');
  assert.equal(linked.length, 1);
  assert.deepEqual(linked[0].payload, { sha, subject: 'Add the feature', files: ['feature.md'] });
});

test('a commit is linked once, even across runs', async (t) => {
  const root = setup(t);
  seed(root);
  fs.writeFileSync(path.join(root, 'feature.md'), 'x\n');
  commit(root, 'one');
  await runTurn(job(root), { commonDir: common(root) });
  await runTurn(job(root), { commonDir: common(root) });
  assert.equal(ofType(root, 'commit_linked').length, 1);
});

test('commit subjects are redacted', async (t) => {
  const root = setup(t);
  seed(root);
  fs.writeFileSync(path.join(root, 'x.md'), 'x\n');
  commit(root, 'Set DB_PASSWORD=hunter2secret');
  await runTurn(job(root), { commonDir: common(root) });
  assert(!JSON.stringify(ofType(root, 'commit_linked')).includes('hunter2secret'));
});

test('the first event of a session sets the starting commit, so older commits are not linked', async (t) => {
  const root = setup(t);
  fs.writeFileSync(path.join(root, 'old.md'), 'x\n');
  commit(root, 'before the session');
  seed(root);
  fs.writeFileSync(path.join(root, 'new.md'), 'x\n');
  commit(root, 'during the session');
  await runTurn(job(root), { commonDir: common(root) });
  assert.deepEqual(ofType(root, 'commit_linked').map((e) => e.payload.subject), ['during the session']);
});

test('the model and tool version from the transcript reach the session meta', async (t) => {
  const root = setup(t);
  seed(root);
  await runTurn(job(root), { commonDir: common(root) });
  const meta = readSessionMeta(common(root), 'claude-code', 's1');
  assert.equal(meta.model, 'claude-opus-5-5');
  assert.equal(meta.model_source, 'transcript');
  assert.match(meta.tool_version, /^\d+\.\d+\.\d+$/);
  const [usage] = ofType(root, 'model_usage');
  assert.equal(usage.payload.model, 'claude-opus-5-5');
});

test('later main-agent events carry the transcript model with model_source transcript', async (t) => {
  const root = setup(t);
  seed(root);
  await runTurn(job(root), { commonDir: common(root) });
  assertSilent(runHook({ stdin: JSON.stringify(fixture('PostToolUse-Read.json', { cwd: root, session_id: 's1' })), cwd: root, event: 'PostToolUse' }));
  const call = ofType(root, 'tool_call')[0];
  assert.equal(call.model, 'claude-opus-5-5');
  assert.equal(call.model_source, 'transcript');
  assert.match(call.tool_version, /^\d+\.\d+\.\d+$/);
});

test('an unreadable, missing, or unknown transcript changes nothing', async (t) => {
  const root = setup(t);
  seed(root);
  const garbage = path.join(root, '..', 'garbage.jsonl');
  fs.writeFileSync(garbage, 'not json\n{"type":"something-new"}\n');
  for (const transcriptPath of [path.join(root, 'missing.jsonl'), garbage, null, root]) {
    await runTurn(job(root, { transcriptPath }), { commonDir: common(root) });
  }
  assert.equal(ofType(root, 'model_usage').length, 0);
  assert.equal(readSessionMeta(common(root), 'claude-code', 's1')?.model ?? null, null);
  assert.equal(readTranscriptTail(garbage), null);
});

test('the transcript reader skips synthetic models and reads only the tail', (t) => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'pd-tail-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const f = path.join(dir, 't.jsonl');
  const line = (model) => JSON.stringify({ type: 'assistant', version: '2.1.1', message: { model } });
  fs.writeFileSync(f, `${line('old-model')}\n${'x'.repeat(300000)}\n${line('real-model')}\n${line('<synthetic>')}\n`);
  assert.equal(readTranscriptTail(f).model, 'real-model');
  // A window too small to reach a real model still yields the version, but no model.
  assert.equal(readTranscriptTail(f, { maxBytes: 100 }).model, null);
});

test('events are written with origin derived and the session id of the job', async (t) => {
  const root = setup(t);
  seed(root);
  fs.writeFileSync(path.join(root, 'notes.md'), 'new\n');
  await runTurn(job(root), { commonDir: common(root) });
  for (const event of capturedEvents(root, { all: true }).filter((e) => e.event_type !== 'user_prompt')) {
    assert.equal(event.origin, 'derived');
    assert.equal(event.session_id, 's1');
    assert.deepEqual(event.actor, { type: 'plugin', name: 'product-decisions' });
  }
});

test('each turn ends with a seal, and the record verifies', async (t) => {
  const root = setup(t);
  seed(root);
  await runTurn(job(root), { commonDir: common(root) });
  const events = capturedEvents(root, { all: true });
  assert.equal(events[events.length - 1].event_type, 'seal');
  assert.deepEqual(verifyFile(file(root)).problems, []);
});

test('a repeated run after a crash writes no duplicates', async (t) => {
  const root = setup(t);
  seed(root);
  fs.writeFileSync(path.join(root, 'notes.md'), 'new\n');
  fs.writeFileSync(path.join(root, 'f.md'), 'x\n');
  commit(root, 'one');
  fs.writeFileSync(path.join(root, 'notes.md'), 'dirty\n');
  await runTurn(job(root), { commonDir: common(root) });
  fs.rmSync(path.join(common(root), 'product-decisions', 'sessions'), { recursive: true, force: true });
  await runTurn(job(root), { commonDir: common(root) });
  assert.equal(ofType(root, 'commit_linked').length, 1);
  assert.equal(ofType(root, 'file_changes').length, 1);
  assert.equal(ofType(root, 'model_usage').length, 1);
});

test('a repository with no commits works', async (t) => {
  const root = setup(t, { commit: false });
  seed(root);
  fs.writeFileSync(path.join(root, 'first.md'), 'x\n');
  await runTurn(job(root), { commonDir: common(root) });
  assert.deepEqual(ofType(root, 'file_changes')[0].payload.files, [{ path: 'first.md', status: 'untracked', added: null, removed: null }]);
  const sha = commit(root, 'first commit');
  await runTurn(job(root), { commonDir: common(root) });
  assert.equal(ofType(root, 'commit_linked')[0].payload.sha, sha);
});

test('a detached HEAD works', async (t) => {
  const root = setup(t);
  git(root, 'checkout', '-q', '--detach');
  seed(root);
  fs.writeFileSync(path.join(root, 'x.md'), 'x\n');
  const sha = commit(root, 'detached work');
  await runTurn(job(root), { commonDir: common(root) });
  assert.equal(ofType(root, 'commit_linked')[0].payload.sha, sha);
});

test('a session folder that no longer exists only skips the Git steps', async (t) => {
  const root = setup(t);
  seed(root);
  await runTurn(job(root, { cwd: path.join(root, 'gone') }), { commonDir: common(root) });
  assert.equal(ofType(root, 'file_changes').length, 0);
  assert.equal(ofType(root, 'seal').length, 1);
});

test('a paused repository is left alone', async (t) => {
  const { root, cleanup } = makeRepo();
  t.after(cleanup);
  activate(root, { paused: true, paused_at: 'x' });
  seed(root);
  fs.writeFileSync(path.join(root, 'notes.md'), 'new\n');
  await runTurn(job(root), { commonDir: common(root) });
  assert.equal(capturedEvents(root, { all: true }).length, 1);
});

test('recovery finds sessions with unsealed events', async (t) => {
  const root = setup(t);
  seed(root);
  await runTurn(job(root), { commonDir: common(root) });
  assert.deepEqual(await recoverSessions({ commonDir: common(root) }), []);
  seed(root);
  const found = await recoverSessions({ commonDir: common(root) });
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'close');
  assert.equal(found[0].sessionId, 's1');
  assert.equal(found[0].cwd, root);
});
