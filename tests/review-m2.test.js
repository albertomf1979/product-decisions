'use strict';

// Reproductions of the M2 review findings. Each test failed before its fix.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { buildEvent } = require('../plugin/src/core/event.js');
const { rawFilePath } = require('../plugin/src/core/store.js');
const { readLocal, writeLocal } = require('../plugin/src/core/state.js');
const { readConfig } = require('../plugin/src/core/config.js');
const { DOCS_REF, RAW_REF, git: plumbingGit, readRef, readTreeFiles, readBlob, commitFiles } = require('../plugin/src/git/plumbing.js');
const { publish } = require('../plugin/src/worker/publish.js');
const { runTurn } = require('../plugin/src/worker/turn.js');
const { snapshot } = require('../plugin/src/worker/snapshot.js');
const { acquireLock } = require('../plugin/src/worker/queue.js');
const { makeRepo, git } = require('./helpers/repo.js');
const { runCli } = require('./helpers/cli-runner.js');
const { capturedEvents, walk } = require('./helpers/hook-runner.js');

const common = (root) => path.resolve(root, plumbingGit(['rev-parse', '--git-common-dir'], { cwd: root }).stdout.toString().trim());
const machine = (root) => readLocal(common(root)).machine;
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const vis = (value) => async () => value;
const blobAt = (repo, ref, file) => readBlob(repo, readTreeFiles(repo, readRef(repo, ref)).get(file)).toString();

function team(t) {
  const { root, base, cleanup } = makeRepo();
  t.after(cleanup);
  const remote = path.join(base, 'remote.git');
  git(base, 'init', '-q', '--bare', remote);
  git(root, 'remote', 'add', 'origin', remote);
  git(root, 'push', '-q', 'origin', 'main');
  assert.equal(runCli(['init', '--yes', '--track', 'PRD.md'], { cwd: root }).status, 0);
  const join = (name) => {
    const dir = path.join(base, name);
    git(base, 'clone', '-q', remote, dir);
    git(dir, 'config', 'user.name', name);
    git(dir, 'config', 'commit.gpgsign', 'false');
    git(dir, 'config', 'maintenance.auto', 'false');
    assert.equal(runCli(['init', '--yes'], { cwd: dir }).status, 0);
    return dir;
  };
  return { root, base, remote, join };
}

function addEvents(root, sessionId, list) {
  const file = rawFilePath(common(root), 'claude-code', sessionId, machine(root));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, list.map((e) => `${JSON.stringify(e)}\n`).join(''));
  return file;
}
let tick = 0;
const ev = (sessionId, eventType, payload = {}, extra = {}) => buildEvent(
  { eventType, actorType: eventType === 'agent_response' || eventType === 'tool_call' ? 'llm' : 'user', llmName: 'claude', agent: { name: 'main' }, payload },
  { tool: 'claude-code', sessionId, actorName: 'Ana', git: extra.git || { branch: 'main', head: null, worktree: '.' }, sources: [], summary: eventType, now: extra.now || new Date(Date.parse('2026-11-07T10:00:00Z') + (tick += 1000)) },
);

// C1
test('C1: a publish never reverts newer files from another clone, in docs or raw', async (t) => {
  const { root, remote, join } = team(t);
  const second = join('second');
  addEvents(second, 's-b', [ev('s-b', 'user_prompt', { prompt: 'FIRST-PROMPT' })]);
  await publish({ commonDir: common(second), visibilityOf: vis('private') });
  addEvents(root, 's-a', [ev('s-a', 'user_prompt', { prompt: 'from a' })]);
  await publish({ commonDir: common(root), visibilityOf: vis('private') }); // root now holds B's v1
  addEvents(second, 's-b', [ev('s-b', 'user_prompt', { prompt: 'SECOND-PROMPT' })]);
  await publish({ commonDir: common(second), visibilityOf: vis('private') });
  await publish({ commonDir: common(root), visibilityOf: vis('private') });
  const rawFile = [...readTreeFiles(remote, readRef(remote, RAW_REF)).keys()].find((f) => f.includes('s-b'));
  assert.match(blobAt(remote, RAW_REF, rawFile), /SECOND-PROMPT/);
  const timeline = [...readTreeFiles(remote, readRef(remote, DOCS_REF)).keys()].find((f) => f.startsWith('timeline/') && f.includes('s-b'));
  assert.match(blobAt(remote, DOCS_REF, timeline), /SECOND-PROMPT/);
});

// C2
async function pushTeamConfig(dir, change) {
  const ref = readRef(dir, DOCS_REF);
  const current = JSON.parse(readBlob(dir, readTreeFiles(dir, ref).get('config.json')).toString());
  commitFiles({ cwd: dir, storeDir: path.join(common(dir), 'product-decisions'), ref: DOCS_REF, parents: [ref], base: ref, files: { 'config.json': Buffer.from(JSON.stringify({ ...current, ...change })) }, message: 'edit', authorName: 'x' });
  git(dir, 'push', '-q', 'origin', DOCS_REF);
}

test('C2: a team config whose folder is taken or invalid is not adopted, and project files stay untouched', async (t) => {
  const { root, join } = team(t);
  const second = join('second');
  fs.mkdirSync(path.join(second, 'src'));
  fs.writeFileSync(path.join(second, 'src', 'README.md'), 'project file\n');
  git(second, 'add', 'src');
  git(second, 'commit', '-q', '-m', 'src');
  for (const folder of ['src', '.']) {
    await pushTeamConfig(root, { folder });
    const before = { readme: hash(path.join(second, 'src', 'README.md')), root: hash(path.join(second, 'PRD.md')) };
    const result = runCli(['sync'], { cwd: second });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /not adopted|kept/i);
    assert.equal(hash(path.join(second, 'src', 'README.md')), before.readme);
    assert.equal(hash(path.join(second, 'PRD.md')), before.root);
    assert.equal(readConfig(common(second)).folder, 'product-decisions');
    assert.equal(git(second, 'status', '--porcelain'), '');
  }
});

test('C2: tracked documents outside the repository are ignored', async (t) => {
  const { root, base, join } = team(t);
  fs.writeFileSync(path.join(base, 'outside-notes.txt'), 'OUTSIDE-SECRET\n');
  await pushTeamConfig(root, { tracked_documents: ['../outside-notes.txt', '/etc/hosts', 'PRD.md'] });
  const second = join('second');
  assert.deepEqual(readConfig(common(second)).tracked_documents, ['PRD.md']);
});

test('C2: joining a project whose folder name is taken locally is refused', async (t) => {
  const { base, remote } = team(t);
  const dir = path.join(base, 'joiner');
  git(base, 'clone', '-q', remote, dir);
  git(dir, 'config', 'user.name', 'joiner');
  fs.mkdirSync(path.join(dir, 'product-decisions'));
  fs.writeFileSync(path.join(dir, 'product-decisions', 'README.md'), 'mine\n');
  const result = runCli(['init', '--yes'], { cwd: dir });
  assert.equal(result.status, 1);
  assert.equal(fs.readFileSync(path.join(dir, 'product-decisions', 'README.md'), 'utf8'), 'mine\n');
});

// C3
test('C3: sync does not add later commits or changes to a closed session', async (t) => {
  const { root, cleanup } = makeRepo();
  t.after(cleanup);
  runCli(['init', '--yes'], { cwd: root });
  const head = git(root, 'rev-parse', 'HEAD').slice(0, 12);
  addEvents(root, 's-closed', [ev('s-closed', 'session_start', { source: 'startup' }, { git: { branch: 'main', head, worktree: '.' } }), ev('s-closed', 'session_end', { reason: 'other' })]);
  await runTurn({ kind: 'close', tool: 'claude-code', sessionId: 's-closed', cwd: root }, { commonDir: common(root) });
  fs.writeFileSync(path.join(root, 'later.md'), 'x\n');
  git(root, 'add', 'later.md');
  git(root, 'commit', '-q', '-m', 'later work');
  fs.writeFileSync(path.join(root, 'wip.txt'), 'wip\n');
  assert.equal(runCli(['sync', '--no-push'], { cwd: root }).status, 0);
  const types = capturedEvents(root, { all: true }).filter((e) => e.session_id === 's-closed').map((e) => e.event_type);
  assert(!types.includes('commit_linked'), types.join());
  assert(!types.includes('file_changes'), types.join());
});

test('C3: a close job processed late links only commits made before the session ended', async (t) => {
  const { root, cleanup } = makeRepo();
  t.after(cleanup);
  runCli(['init', '--yes'], { cwd: root });
  const head = git(root, 'rev-parse', 'HEAD').slice(0, 12);
  fs.writeFileSync(path.join(root, 'during.md'), 'x\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'during');
  const end = new Date(Date.now() + 2000);
  addEvents(root, 's-late', [ev('s-late', 'session_start', { source: 'startup' }, { git: { branch: 'main', head, worktree: '.' }, now: new Date(Date.now() - 5000) }), ev('s-late', 'session_end', { reason: 'other' }, { now: end })]);
  await new Promise((r) => setTimeout(r, 3500));
  fs.writeFileSync(path.join(root, 'after.md'), 'x\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'after the end');
  await runTurn({ kind: 'close', tool: 'claude-code', sessionId: 's-late', cwd: root }, { commonDir: common(root) });
  const subjects = capturedEvents(root, { all: true }).filter((e) => e.event_type === 'commit_linked').map((e) => e.payload.subject);
  assert.deepEqual(subjects, ['during']);
});

// C4
test('C4: the raw record is held when any push URL is not verified private', async (t) => {
  const { root, base, remote } = team(t);
  const mirror = path.join(base, 'public-mirror.git');
  git(base, 'init', '-q', '--bare', mirror);
  git(root, 'remote', 'set-url', '--add', '--push', 'origin', remote);
  git(root, 'remote', 'set-url', '--add', '--push', 'origin', mirror);
  addEvents(root, 's-mirror', [ev('s-mirror', 'user_prompt', { prompt: 'x' })]);
  const result = await publish({ commonDir: common(root), visibilityOf: async (url) => (url.includes('mirror') ? 'public' : 'private') });
  assert.equal(result.raw, 'local');
  assert.equal(readRef(mirror, RAW_REF), null);
  assert.equal(readRef(remote, RAW_REF), null);
});

// I1
test('I1: the worker never runs Git in another repository the session moved into', async (t) => {
  const { root, cleanup } = makeRepo();
  t.after(cleanup);
  const other = makeRepo();
  t.after(other.cleanup);
  runCli(['init', '--yes'], { cwd: root });
  const head = git(root, 'rev-parse', 'HEAD').slice(0, 12);
  addEvents(root, 's-moved', [ev('s-moved', 'user_prompt', { prompt: 'x' }, { git: { branch: 'main', head, worktree: '.' } })]);
  fs.writeFileSync(path.join(other.root, 'other.md'), 'x\n');
  git(other.root, 'add', '-A');
  git(other.root, 'commit', '-q', '-m', 'OTHER-REPO-COMMIT');
  fs.writeFileSync(path.join(other.root, 'other-wip.md'), 'x\n');
  await runTurn({ kind: 'turn', tool: 'claude-code', sessionId: 's-moved', cwd: other.root }, { commonDir: common(root) });
  const text = JSON.stringify(capturedEvents(root, { all: true }));
  assert(!text.includes('OTHER-REPO-COMMIT'));
  assert(!text.includes('other-wip.md'));
});

// I2
test('I2: a submodule publishes to its own refs, never to the superproject', async (t) => {
  const { root: sub, cleanup } = makeRepo();
  t.after(cleanup);
  const superproject = makeRepo();
  t.after(superproject.cleanup);
  git(superproject.root, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'sub');
  git(superproject.root, 'commit', '-q', '-m', 'add sub');
  assert.equal(runCli(['init', '--yes', '--no-push'], { cwd: superproject.root }).status, 0);
  const before = readRef(superproject.root, DOCS_REF);
  const inner = path.join(superproject.root, 'sub');
  git(inner, 'config', 'user.name', 'Inner');
  assert.equal(runCli(['init', '--yes', '--folder', 'sub-decisions'], { cwd: inner }).status, 0);
  addEvents(inner, 's-sub', [ev('s-sub', 'user_prompt', { prompt: 'x' })]);
  await publish({ commonDir: common(inner), visibilityOf: vis('private'), push: false });
  assert.equal(readRef(superproject.root, DOCS_REF), before);
  assert.equal(fs.existsSync(path.join(superproject.root, 'sub-decisions')), false);
  assert.notEqual(readRef(inner, DOCS_REF), null);
});

// I3
test('I3: a snapshot leaves the user index untouched', (t) => {
  const { root, cleanup } = makeRepo();
  t.after(cleanup);
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(root, 'PRD.md'), later, later);
  const before = hash(path.join(root, '.git', 'index'));
  snapshot({ worktreeRoot: root, gitDir: path.join(root, '.git'), storeDir: path.join(root, '.git', 'product-decisions') });
  assert.equal(hash(path.join(root, '.git', 'index')), before);
});

// I4
test('I4: background Git never runs a credential prompt', async (t) => {
  const { root, base, cleanup } = makeRepo();
  t.after(cleanup);
  runCli(['init', '--yes', '--no-push'], { cwd: root });
  const port = await new Promise((resolve) => {
    const s = require('node:http').createServer((q, r) => { r.writeHead(401, { 'WWW-Authenticate': 'Basic realm=x' }); r.end(); });
    s.listen(0, () => { const p = s.address().port; s.close(); resolve(p); });
  });
  const child = spawn(process.execPath, ['-e', `require('http').createServer((q,s)=>{s.writeHead(401,{'WWW-Authenticate':'Basic realm=x'});s.end()}).listen(${port})`], { stdio: 'ignore' });
  t.after(() => child.kill());
  await new Promise((r) => setTimeout(r, 300));
  git(root, 'remote', 'add', 'origin', `http://127.0.0.1:${port}/repo.git`);
  const marker = path.join(base, 'askpass-ran');
  const askpass = path.join(base, 'askpass.sh');
  fs.writeFileSync(askpass, `#!/bin/sh\necho x >> "${marker}"\necho user\n`, { mode: 0o755 });
  const saved = process.env.GIT_ASKPASS;
  process.env.GIT_ASKPASS = askpass;
  t.after(() => { if (saved === undefined) delete process.env.GIT_ASKPASS; else process.env.GIT_ASKPASS = saved; });
  addEvents(root, 's-ask', [ev('s-ask', 'user_prompt', { prompt: 'x' })]);
  await publish({ commonDir: common(root), visibilityOf: vis('private') });
  assert.equal(fs.existsSync(marker), false, 'askpass must never run');
}, { skip: process.platform === 'win32' });

// I5
test('I5: only one contender takes over a stale lock, and release never removes a lock it does not own', (t) => {
  const { root, cleanup } = makeRepo();
  t.after(cleanup);
  const lock = path.join(common(root), 'product-decisions', 'state', 'worker.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, JSON.stringify({ pid: 999999, at: 0, token: 'old' }));
  const old = new Date(Date.now() - 3600 * 1000);
  fs.utimesSync(lock, old, old);
  const first = acquireLock(common(root), { staleMs: 1000 });
  const second = acquireLock(common(root), { staleMs: 1000 });
  assert.equal(typeof first, 'function');
  assert.equal(second, null);
  // Someone else's lock appears: the first holder's release must leave it.
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now(), token: 'someone-else' }));
  first();
  assert.equal(fs.existsSync(lock), true);
});

// I6
test('I6: raw publication checks visibility every time, without a cached answer', async (t) => {
  const { root } = team(t);
  const seen = [];
  addEvents(root, 's-vis', [ev('s-vis', 'user_prompt', { prompt: 'x' })]);
  await publish({ commonDir: common(root), visibilityOf: async (url, options) => { seen.push(options && options.fresh); return 'private'; } });
  assert(seen.length > 0);
  assert(seen.every((fresh) => fresh === true), 'the raw decision asks for a fresh answer');
});

// I7
test('I7: the worker does not push until pushing is enabled for this person', async (t) => {
  const { root, remote } = team(t);
  const state = readLocal(common(root));
  writeLocal(common(root), { ...state, push_enabled: undefined });
  const docsBefore = readRef(remote, DOCS_REF);
  addEvents(root, 's-nopush', [ev('s-nopush', 'user_prompt', { prompt: 'x' })]);
  await require('../plugin/src/worker/jobs.js').publish({ commonDir: common(root) });
  assert.equal(readRef(remote, DOCS_REF), docsBefore);
});

test('I7: init asks for consent again when the consent text has changed', (t) => {
  const { root, cleanup } = makeRepo();
  t.after(cleanup);
  runCli(['init', '--yes', '--no-push'], { cwd: root });
  const state = readLocal(common(root));
  writeLocal(common(root), { ...state, consent_sha: 'an-older-text' });
  const refused = runCli(['init'], { cwd: root });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /--yes/);
  const accepted = runCli(['init', '--yes', '--no-push'], { cwd: root });
  assert.equal(accepted.status, 0);
  assert.notEqual(readLocal(common(root)).consent_sha, 'an-older-text');
  assert.equal(capturedEvents(root).filter((e) => e.event_type === 'consent').length, 2);
});

// I8
test('I8: reading the PRD does not make the reader the author of a manual edit', async (t) => {
  const { root, cleanup } = makeRepo();
  t.after(cleanup);
  runCli(['init', '--yes', '--no-push', '--track', 'PRD.md'], { cwd: root });
  fs.writeFileSync(path.join(root, 'PRD.md'), '# PRD\nedited by hand\n');
  addEvents(root, 's-read', [ev('s-read', 'tool_call', { tool_name: 'Read', tool_input: { file_path: path.join(root, 'PRD.md') } })]);
  await runTurn({ kind: 'turn', tool: 'claude-code', sessionId: 's-read', cwd: root }, { commonDir: common(root) });
  const [change] = capturedEvents(root, { all: true }).filter((e) => e.event_type === 'document_change');
  assert.equal(change.payload.outside_session, true);
});

// I9
test('I9: init shows the public-repository notice before consent', (t) => {
  const { root, cleanup } = makeRepo();
  t.after(cleanup);
  git(root, 'remote', 'add', 'origin', 'https://github.com/someone/public-thing.git');
  const stateDir = path.join(common(root), 'product-decisions', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'visibility.json'), JSON.stringify({ 'someone/public-thing': { value: 'public', at: Date.now() } }));
  const result = runCli(['init', '--yes', '--no-push'], { cwd: root });
  assert.match(result.stdout, /This repository is public, so its documents will be public\./);
  assert(result.stdout.indexOf('is public') < result.stdout.indexOf('Activated'));
});

// I10
test('I10: a malformed data file on the shared branch is skipped, and a failed publish is recorded as pending', async (t) => {
  const { root, remote, join } = team(t);
  const ref = readRef(root, DOCS_REF);
  commitFiles({ cwd: root, storeDir: path.join(common(root), 'product-decisions'), ref: DOCS_REF, parents: [ref], base: ref, files: { '.data/sessions/future.json': Buffer.from('{"schema_version":2}') }, message: 'future', authorName: 'x' });
  git(root, 'push', '-q', 'origin', DOCS_REF);
  const second = join('second');
  addEvents(second, 's-ok', [ev('s-ok', 'user_prompt', { prompt: 'x' })]);
  const result = await publish({ commonDir: common(second), visibilityOf: vis('private') });
  assert.equal(result.docs, 'published');
  assert([...readTreeFiles(remote, readRef(remote, DOCS_REF)).keys()].some((f) => f.includes('s-ok')));
  const { publish: failing } = require('../plugin/src/worker/publish.js');
  const broken = await failing({ commonDir: common(second), visibilityOf: async () => { throw new Error('boom'); } });
  assert.equal(broken.raw, 'pending');
  const recorded = JSON.parse(fs.readFileSync(path.join(common(second), 'product-decisions', 'state', 'publish.json'), 'utf8'));
  assert.equal(recorded.raw_pending, true);
});

// Units behind the fixes above.

test('checkVisibility with fresh ignores the cached answer but stores the new one', async () => {
  const { checkVisibility } = require('../plugin/src/worker/visibility.js');
  const store = { 'o/r': { value: 'private', at: Date.now() } };
  const cache = { get: (k) => store[k], set: (k, v) => { store[k] = v; } };
  const request = async () => ({ status: 200, body: JSON.stringify({ private: false }) });
  assert.equal(await checkVisibility('https://github.com/o/r.git', { request, cache }), 'private');
  assert.equal(await checkVisibility('https://github.com/o/r.git', { request, cache, fresh: true }), 'public');
  assert.equal(store['o/r'].value, 'public');
});

test('sanitizeConfig keeps only usable shared values', () => {
  const { sanitizeConfig } = require('../plugin/src/core/config.js');
  const { config, rejected } = sanitizeConfig({
    folder: '../escape', language: 'fr', tracked_documents: ['docs/PRD.md', './x', 'a/../b', 'C:/x', '.git/config'],
    redact_patterns: ['ok-\\d+', '(unclosed'], publish: { raw: 'sometimes' },
  }, { folder: 'mine', language: 'es' });
  assert.equal(config.folder, 'mine');
  assert.equal(config.language, 'es');
  assert.deepEqual(config.tracked_documents, ['docs/PRD.md']);
  assert.deepEqual(config.redact_patterns, ['ok-\\d+']);
  assert.equal(config.publish.raw, 'auto');
  assert.deepEqual(rejected.sort(), ['folder', 'language', 'publish', 'redact_patterns', 'tracked_documents']);
  assert.deepEqual(sanitizeConfig({ folder: 'decisions', publish: { raw: 'always' } }).rejected, []);
});

test('a folder change leaves the old folder as it was', (t) => {
  const { root, cleanup } = makeRepo();
  t.after(cleanup);
  const { exportFolder } = require('../plugin/src/worker/folder.js');
  const location = { mainRoot: root, commonDir: common(root) };
  exportFolder({ location, config: { folder: 'old-name' }, files: new Map([['README.md', 'one\n']]) });
  exportFolder({ location, config: { folder: 'new-name' }, files: new Map([['index.md', 'two\n']]) });
  assert.equal(fs.readFileSync(path.join(root, 'old-name', 'README.md'), 'utf8'), 'one\n');
  assert.equal(fs.readFileSync(path.join(root, 'new-name', 'index.md'), 'utf8'), 'two\n');
});

test('refresh keeps a long-held lock from looking stale', (t) => {
  const { root, cleanup } = makeRepo();
  t.after(cleanup);
  const release = acquireLock(common(root), { staleMs: 60000 });
  const lock = path.join(common(root), 'product-decisions', 'state', 'worker.lock');
  const old = new Date(Date.now() - 3600 * 1000);
  fs.utimesSync(lock, old, old);
  release.refresh();
  assert(Date.now() - fs.statSync(lock).mtimeMs < 5000);
  assert.equal(acquireLock(common(root), { staleMs: 60000 }), null);
  release();
  assert.equal(fs.existsSync(lock), false);
});

test('sync explains why nothing was pushed when consent is out of date', (t) => {
  const { root } = team(t);
  writeLocal(common(root), { ...readLocal(common(root)), consent_sha: 'old' });
  const result = runCli(['sync'], { cwd: root });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /consent text has changed/);
});
