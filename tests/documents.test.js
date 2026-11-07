'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { buildEvent } = require('../plugin/src/core/event.js');
const { locateRepo } = require('../plugin/src/core/locate.js');
const { readGit } = require('../plugin/src/core/githead.js');
const { rawFilePath } = require('../plugin/src/core/store.js');
const { readConfig, writeConfigCopy } = require('../plugin/src/core/config.js');
const { runTurn } = require('../plugin/src/worker/turn.js');
const { makeRepo, git } = require('./helpers/repo.js');
const { runCli } = require('./helpers/cli-runner.js');
const { capturedEvents, walk } = require('./helpers/hook-runner.js');

const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const common = (root) => path.join(root, '.git');
const overlay = (root) => path.join(common(root), 'product-decisions', 'state', 'docs-overlay');
const records = (root) => walk(path.join(overlay(root), '01-definition', 'changes')).sort();
const machine = (root) => JSON.parse(fs.readFileSync(path.join(common(root), 'product-decisions', 'local.json'), 'utf8')).machine;

function setup(t, flags = ['--track', 'PRD.md']) {
  const repo = makeRepo();
  t.after(repo.cleanup);
  const result = runCli(['init', '--yes', ...flags], { cwd: repo.root });
  assert.equal(result.status, 0, result.stderr);
  return repo.root;
}

function seed(root, { editPath } = {}) {
  const file = rawFilePath(common(root), 'claude-code', 's1', machine(root));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const git_ = readGit(locateRepo(root), root);
  const events = [buildEvent(
    { eventType: 'user_prompt', actorType: 'user', agent: { name: 'main' }, payload: { prompt: 'update the PRD' } },
    { tool: 'claude-code', sessionId: 's1', actorName: 'Test Person', git: git_, sources: [], summary: 'update the PRD' },
  )];
  if (editPath) {
    events.push(buildEvent(
      { eventType: 'tool_call', actorType: 'llm', llmName: 'claude', agent: { name: 'main' }, payload: { tool_name: 'Edit', tool_input: { file_path: editPath } } },
      { tool: 'claude-code', sessionId: 's1', actorName: 'Test Person', git: git_, sources: [], summary: 'Edit PRD.md' },
    ));
  }
  fs.appendFileSync(file, events.map((e) => `${JSON.stringify(e)}\n`).join(''));
  return events;
}
const turn = (root) => runTurn({ kind: 'turn', tool: 'claude-code', sessionId: 's1', cwd: root, transcriptPath: null }, { commonDir: common(root) });
const changeEvents = (root) => capturedEvents(root, { all: true }).filter((e) => e.event_type === 'document_change');

test('declaring copies a baseline, and the original is untouched', (t) => {
  const repo = makeRepo();
  t.after(repo.cleanup);
  const before = hash(path.join(repo.root, 'PRD.md'));
  runCli(['init', '--yes', '--track', 'PRD.md'], { cwd: repo.root });
  assert.equal(fs.readFileSync(path.join(overlay(repo.root), '01-definition', 'baseline', 'PRD.md'), 'utf8'), '# PRD\n');
  assert.equal(hash(path.join(repo.root, 'PRD.md')), before);
});

test('an agent edit creates one change record with diff, session, events, actor, and branch', async (t) => {
  const root = setup(t);
  fs.writeFileSync(path.join(root, 'PRD.md'), '# PRD\n\nNew goal: ship M2.\n');
  const [, edit] = seed(root, { editPath: path.join(root, 'PRD.md') });
  await turn(root);
  const [record] = records(root);
  const text = fs.readFileSync(record, 'utf8');
  assert.match(text, /\+New goal: ship M2\./);
  assert.match(text, /s1/);
  assert(text.includes(edit.event_id));
  assert.match(text, /claude/);
  assert.match(text, /main/);
  const [event] = changeEvents(root);
  assert.equal(event.payload.path, 'PRD.md');
  assert.equal(event.payload.outside_session, false);
});

test('the tracked document is byte-identical after every check, and nothing else in the project changes', async (t) => {
  const root = setup(t);
  fs.writeFileSync(path.join(root, 'PRD.md'), '# PRD\nchanged\n');
  const before = { prd: hash(path.join(root, 'PRD.md')), status: git(root, 'status', '--porcelain') };
  seed(root, { editPath: 'PRD.md' });
  await turn(root);
  await turn(root);
  assert.equal(hash(path.join(root, 'PRD.md')), before.prd);
  assert.equal(git(root, 'status', '--porcelain'), before.status);
});

test('a manual edit is labelled as outside a session, with no invented actor', async (t) => {
  const root = setup(t);
  fs.writeFileSync(path.join(root, 'PRD.md'), '# PRD\nedited by hand\n');
  seed(root);
  await turn(root);
  const [event] = changeEvents(root);
  assert.equal(event.payload.outside_session, true);
  assert.match(fs.readFileSync(records(root)[0], 'utf8'), /outside a session/i);
});

test('no change, no record', async (t) => {
  const root = setup(t);
  seed(root);
  await turn(root);
  assert.equal(records(root).length, 0);
});

test('a binary document gets a hash-only note, with no diff', async (t) => {
  const root = setup(t, []);
  fs.writeFileSync(path.join(root, 'spec.pdf'), Buffer.from([0x25, 0x50, 0x44, 0x46, 0, 1, 2]));
  git(root, 'add', 'spec.pdf');
  git(root, 'commit', '-q', '-m', 'spec');
  writeConfigCopy(common(root), { ...readConfig(common(root)), tracked_documents: ['spec.pdf'] });
  seed(root);
  await turn(root);
  fs.writeFileSync(path.join(root, 'spec.pdf'), Buffer.from([0x25, 0x50, 0x44, 0x46, 0, 9, 9]));
  await turn(root);
  const text = fs.readFileSync(records(root)[0], 'utf8');
  assert(!text.includes('```diff'));
  assert.match(text, /sha256/i);
});

test('a secret in the diff is redacted', async (t) => {
  const root = setup(t);
  fs.writeFileSync(path.join(root, 'PRD.md'), '# PRD\nDB_PASSWORD=hunter2secret\n');
  seed(root);
  await turn(root);
  assert(!fs.readFileSync(records(root)[0], 'utf8').includes('hunter2secret'));
});

test('a deleted document, and a restored one, are recorded', async (t) => {
  const root = setup(t);
  seed(root);
  fs.rmSync(path.join(root, 'PRD.md'));
  await turn(root);
  fs.writeFileSync(path.join(root, 'PRD.md'), '# PRD\n');
  await turn(root);
  assert.deepEqual(changeEvents(root).map((e) => e.payload.status), ['deleted', 'restored']);
});

test('a change record is never rewritten by a later check', async (t) => {
  const root = setup(t);
  fs.writeFileSync(path.join(root, 'PRD.md'), '# PRD\none\n');
  seed(root);
  await turn(root);
  const [first] = records(root);
  const before = fs.readFileSync(first);
  fs.writeFileSync(path.join(root, 'PRD.md'), '# PRD\ntwo\n');
  await turn(root);
  assert.equal(records(root).length, 2);
  assert(fs.readFileSync(first).equals(before));
});

test('a change on another branch records that branch', async (t) => {
  const root = setup(t);
  git(root, 'switch', '-q', '-c', 'feature-x');
  fs.writeFileSync(path.join(root, 'PRD.md'), '# PRD\nfeature\n');
  seed(root);
  await turn(root);
  assert.match(fs.readFileSync(records(root)[0], 'utf8'), /feature-x/);
});

test('a missing tracked path does not stop the other documents', async (t) => {
  const root = setup(t);
  writeConfigCopy(common(root), { ...readConfig(common(root)), tracked_documents: ['GONE.md', 'PRD.md'] });
  fs.writeFileSync(path.join(root, 'PRD.md'), '# PRD\nchanged\n');
  seed(root);
  await turn(root);
  assert.equal(changeEvents(root).filter((e) => e.payload.path === 'PRD.md').length, 1);
});

test('change records use the configured language', async (t) => {
  const root = setup(t, ['--track', 'PRD.md', '--language', 'es']);
  fs.writeFileSync(path.join(root, 'PRD.md'), '# PRD\ncambio\n');
  seed(root);
  await turn(root);
  assert.match(fs.readFileSync(records(root)[0], 'utf8'), /Cambio en/);
});

test('the change appears in the folder and the README', async (t) => {
  const root = setup(t);
  fs.writeFileSync(path.join(root, 'PRD.md'), '# PRD\nchanged\n');
  seed(root);
  await turn(root);
  const folder = path.join(root, 'product-decisions');
  assert.equal(fs.readdirSync(path.join(folder, '01-definition', 'changes')).length, 1);
  assert.equal(fs.existsSync(path.join(folder, '01-definition', 'baseline', 'PRD.md')), true);
  assert.match(fs.readFileSync(path.join(folder, 'README.md'), 'utf8'), /PRD\.md/);
});
