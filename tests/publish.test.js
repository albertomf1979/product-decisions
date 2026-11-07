'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { buildEvent } = require('../plugin/src/core/event.js');
const { rawFilePath } = require('../plugin/src/core/store.js');
const { readConfig, writeConfigCopy } = require('../plugin/src/core/config.js');
const { DOCS_REF, RAW_REF, readRef, readTreeFiles } = require('../plugin/src/git/plumbing.js');
const { publish } = require('../plugin/src/worker/publish.js');
const { enqueue } = require('../plugin/src/worker/queue.js');
const { runWorker } = require('../plugin/src/worker/main.js');
const { makeRepo, git } = require('./helpers/repo.js');
const { runCli } = require('./helpers/cli-runner.js');

const common = (root) => path.join(root, '.git');
const machine = (root) => JSON.parse(fs.readFileSync(path.join(common(root), 'product-decisions', 'local.json'), 'utf8')).machine;
const remoteFiles = (remote, ref) => [...readTreeFiles(remote, readRef(remote, ref)).keys()].sort();
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

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
    git(dir, 'config', 'user.email', `${name}@example.com`);
    git(dir, 'config', 'commit.gpgsign', 'false');
    assert.equal(runCli(['init', '--yes'], { cwd: dir }).status, 0);
    return dir;
  };
  return { root, base, remote, join };
}

function session(root, sessionId, prompt = 'hello') {
  const file = rawFilePath(common(root), 'claude-code', sessionId, machine(root));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const at = (s) => new Date(Date.parse('2026-11-07T10:00:00Z') + s * 1000);
  const ev = (eventType, payload, s) => buildEvent(
    { eventType, actorType: eventType === 'agent_response' ? 'llm' : 'user', llmName: 'claude', agent: { name: 'main' }, payload },
    { tool: 'claude-code', sessionId, actorName: 'Ana', git: { branch: 'main', head: null, worktree: '.' }, sources: [], summary: prompt, now: at(s) },
  );
  fs.appendFileSync(file, [ev('session_start', { source: 'startup' }, 0), ev('user_prompt', { prompt }, 1), ev('agent_response', { last_assistant_message: 'ok' }, 2), ev('session_end', { reason: 'other' }, 3)].map((e) => `${JSON.stringify(e)}\n`).join(''));
}
const visibility = (value) => async () => value;
const sessionsIn = (remote) => remoteFiles(remote, DOCS_REF).filter((f) => f.startsWith('timeline/'));

test('private: docs and raw are both pushed', async (t) => {
  const { root, remote } = team(t);
  session(root, 's-private-1');
  const result = await publish({ commonDir: common(root), visibilityOf: visibility('private') });
  assert.equal(result.docs, 'published');
  assert.equal(result.raw, 'published');
  assert.equal(sessionsIn(remote).length, 1);
  assert(remoteFiles(remote, RAW_REF).some((f) => f.includes('s-privat')));
  assert.equal(git(remote, 'for-each-ref', '--format=%(refname)', 'refs/heads/product-decisions/raw'), '');
});

test('public: docs are pushed and raw is not', async (t) => {
  const { root, remote } = team(t);
  session(root, 's-public-1');
  const result = await publish({ commonDir: common(root), visibilityOf: visibility('public') });
  assert.equal(result.docs, 'published');
  assert.equal(result.raw, 'local');
  assert.equal(readRef(remote, RAW_REF), null);
});

test('unknown: raw is not pushed until publish.raw is always', async (t) => {
  const { root, remote } = team(t);
  session(root, 's-unknown-1');
  await publish({ commonDir: common(root), visibilityOf: visibility('unknown') });
  assert.equal(readRef(remote, RAW_REF), null);
  writeConfigCopy(common(root), { ...readConfig(common(root)), publish: { raw: 'always' } });
  await publish({ commonDir: common(root), visibilityOf: visibility('unknown') });
  assert.notEqual(readRef(remote, RAW_REF), null);
});

test('two clones publish in turn with no conflict and no lost file', async (t) => {
  const { root, remote, join } = team(t);
  const second = join('second');
  session(root, 's-first-01');
  session(second, 's-second-1');
  await publish({ commonDir: common(root), visibilityOf: visibility('private') });
  await publish({ commonDir: common(second), visibilityOf: visibility('private') });
  await publish({ commonDir: common(root), visibilityOf: visibility('private') });
  assert.equal(sessionsIn(remote).length, 2);
  assert.equal(remoteFiles(remote, RAW_REF).filter((f) => f.startsWith('claude-code/')).length, 2);
  const readme = fs.readFileSync(path.join(root, 'product-decisions', 'README.md'), 'utf8');
  assert(readme.includes('s-first-') && readme.includes('s-second'));
});

test('two clones publish at the same moment, and the loser retries and succeeds', async (t) => {
  const { root, remote, join } = team(t);
  const second = join('second');
  session(root, 's-race-a-1');
  session(second, 's-race-b-1');
  let raced = false;
  const beforePush = async () => {
    if (raced) return;
    raced = true;
    await publish({ commonDir: common(root), visibilityOf: visibility('private') });
  };
  const result = await publish({ commonDir: common(second), visibilityOf: visibility('private'), beforePush });
  assert.equal(result.docs, 'published');
  assert.equal(sessionsIn(remote).length, 2);
});

test('a clone that worked offline publishes everything when it returns', async (t) => {
  const { root, remote, join } = team(t);
  const second = join('second');
  git(second, 'remote', 'set-url', 'origin', path.join(path.dirname(remote), 'missing.git'));
  session(second, 's-offline1');
  const offline = await publish({ commonDir: common(second), visibilityOf: visibility('private') });
  assert.equal(offline.docs, 'pending');
  session(root, 's-online-1');
  await publish({ commonDir: common(root), visibilityOf: visibility('private') });
  git(second, 'remote', 'set-url', 'origin', remote);
  const back = await publish({ commonDir: common(second), visibilityOf: visibility('private') });
  assert.equal(back.docs, 'published');
  assert.equal(sessionsIn(remote).length, 2);
});

test('a third clone sees every session in the indexes, with no raw data available', async (t) => {
  const { root, remote, join } = team(t);
  const second = join('second');
  session(root, 's-third-a1');
  session(second, 's-third-b1');
  await publish({ commonDir: common(root), visibilityOf: visibility('public') });
  await publish({ commonDir: common(second), visibilityOf: visibility('public') });
  const third = join('third');
  const readme = fs.readFileSync(path.join(third, 'product-decisions', 'README.md'), 'utf8');
  assert(readme.includes('s-third-') && readme.includes('timeline/'));
  assert.equal(readRef(remote, RAW_REF), null);
  assert.equal(fs.readdirSync(path.join(third, 'product-decisions', 'timeline')).length, 2);
});

test('a rejected push stays pending, is reported, and is retried at the next run', async (t) => {
  const { root, remote } = team(t);
  session(root, 's-reject-1');
  const hook = path.join(remote, 'hooks', 'pre-receive');
  fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const rejected = await publish({ commonDir: common(root), visibilityOf: visibility('private') });
  assert.equal(rejected.docs, 'pending');
  assert.equal(JSON.parse(fs.readFileSync(path.join(common(root), 'product-decisions', 'state', 'publish.json'), 'utf8')).docs_pending, true);
  fs.rmSync(hook);
  const retried = await publish({ commonDir: common(root), visibilityOf: visibility('private') });
  assert.equal(retried.docs, 'published');
  assert.equal(JSON.parse(fs.readFileSync(path.join(common(root), 'product-decisions', 'state', 'publish.json'), 'utf8')).docs_pending, false);
});

test('a pre-push hook does not run', async (t) => {
  const { root } = team(t);
  const marker = path.join(root, '..', 'pre-push-ran');
  fs.writeFileSync(path.join(root, '.git', 'hooks', 'pre-push'), `#!/bin/sh\ntouch "${marker}"\n`, { mode: 0o755 });
  session(root, 's-hooks-01');
  await publish({ commonDir: common(root), visibilityOf: visibility('private') });
  assert.equal(fs.existsSync(marker), false);
});

test('no remote: everything works locally, and nothing is shared', async (t) => {
  const { root, cleanup } = makeRepo();
  t.after(cleanup);
  runCli(['init', '--yes'], { cwd: root });
  session(root, 's-local-01');
  const result = await publish({ commonDir: common(root), visibilityOf: visibility('private') });
  assert.equal(result.remote, null);
  assert.equal(result.docs, 'local');
  assert(readTreeFiles(root, readRef(root, DOCS_REF)).has('README.md'));
});

test('a repository that became public gets a warning, and raw publication stops', async (t) => {
  const { root, remote } = team(t);
  session(root, 's-became-1');
  await publish({ commonDir: common(root), visibilityOf: visibility('private') });
  const rawBefore = readRef(remote, RAW_REF);
  session(root, 's-became-2');
  const result = await publish({ commonDir: common(root), visibilityOf: visibility('public') });
  assert.equal(readRef(remote, RAW_REF), rawBefore);
  assert(result.warnings.includes('raw_ref_public'));
});

test('code branches, HEAD, the index, and git status never change', async (t) => {
  const { root } = team(t);
  fs.writeFileSync(path.join(root, 'PRD.md'), '# changed by a person\n');
  const before = { head: git(root, 'rev-parse', 'HEAD'), status: git(root, 'status', '--porcelain'), index: hash(path.join(root, '.git', 'index')), main: git(root, 'rev-parse', 'refs/remotes/origin/main') };
  session(root, 's-boundary');
  await publish({ commonDir: common(root), visibilityOf: visibility('private') });
  assert.deepEqual({ head: git(root, 'rev-parse', 'HEAD'), status: git(root, 'status', '--porcelain'), index: hash(path.join(root, '.git', 'index')), main: git(root, 'rev-parse', 'refs/remotes/origin/main') }, before);
});

test('publishing the same state twice creates no empty commit', async (t) => {
  const { root, remote } = team(t);
  session(root, 's-twice-01');
  await publish({ commonDir: common(root), visibilityOf: visibility('private') });
  const first = readRef(remote, DOCS_REF);
  await publish({ commonDir: common(root), visibilityOf: visibility('private') });
  assert.equal(readRef(remote, DOCS_REF), first);
});

test('the remote history only grows: every earlier tip is an ancestor of the last', async (t) => {
  const { root, remote, join } = team(t);
  const second = join('second');
  const tips = [];
  for (const [dir, id] of [[root, 's-grow-a1'], [second, 's-grow-b1'], [root, 's-grow-a2']]) {
    session(dir, id);
    await publish({ commonDir: common(dir), visibilityOf: visibility('private') });
    tips.push(readRef(remote, DOCS_REF));
  }
  for (const tip of tips.slice(0, -1)) assert.equal(git(remote, 'merge-base', '--is-ancestor', tip, tips[tips.length - 1]) === '', true);
});

test('sync works from a linked worktree, and --no-push pushes nothing', (t) => {
  const { root, remote } = team(t);
  const wt = path.join(path.dirname(root), 'wt');
  git(root, 'worktree', 'add', '-q', '-b', 'wt', wt);
  session(root, 's-sync-001');
  const local = runCli(['sync', '--no-push'], { cwd: wt });
  assert.equal(local.status, 0, local.stderr);
  assert.equal(readRef(remote, DOCS_REF), readRef(remote, DOCS_REF));
  assert.equal(sessionsIn(remote).length, 0);
  assert(readTreeFiles(root, readRef(root, DOCS_REF)).has('README.md'));
  const pushed = runCli(['sync'], { cwd: wt });
  assert.equal(pushed.status, 0, pushed.stderr);
  assert.equal(sessionsIn(remote).length, 1);
});

test('a close job publishes, and a turn job does not', async (t) => {
  const { root, remote } = team(t);
  session(root, 's-jobs-001');
  const jobs = require('../plugin/src/worker/jobs.js');
  const declared = readRef(remote, DOCS_REF);
  enqueue(common(root), { kind: 'turn', tool: 'claude-code', sessionId: 's-jobs-001', cwd: root });
  await runWorker({ commonDir: common(root), jobs });
  assert.equal(readRef(remote, DOCS_REF), declared, 'a turn job publishes nothing');
  enqueue(common(root), { kind: 'close', tool: 'claude-code', sessionId: 's-jobs-001', cwd: root });
  await runWorker({ commonDir: common(root), jobs });
  assert.notEqual(readRef(remote, DOCS_REF), declared);
  assert.equal(sessionsIn(remote).length, 1);
});

test('init publishes the declaration, so a teammate joins it instead of declaring', (t) => {
  const { root, base, remote } = team(t);
  assert.notEqual(readRef(remote, DOCS_REF), null);
  const dir = path.join(base, 'joiner');
  git(base, 'clone', '-q', remote, dir);
  git(dir, 'config', 'user.name', 'joiner');
  assert.match(runCli(['init', '--yes'], { cwd: dir }).stdout, /Joined/);
  void root;
});

test('init --no-push publishes nothing', (t) => {
  const { root, base, cleanup } = makeRepo();
  t.after(cleanup);
  const remote = path.join(base, 'remote.git');
  git(base, 'init', '-q', '--bare', remote);
  git(root, 'remote', 'add', 'origin', remote);
  assert.equal(runCli(['init', '--yes', '--no-push'], { cwd: root }).status, 0);
  assert.equal(readRef(remote, DOCS_REF), null);
});

test('someone who declared separately adopts the team config when publishing', async (t) => {
  const { base, cleanup, root } = makeRepo();
  t.after(cleanup);
  const remote = path.join(base, 'remote.git');
  git(base, 'init', '-q', '--bare', remote);
  git(root, 'remote', 'add', 'origin', remote);
  git(root, 'push', '-q', 'origin', 'main');
  const other = path.join(base, 'other');
  git(base, 'clone', '-q', remote, other);
  git(other, 'config', 'user.name', 'other');
  // Both declare before either publishes.
  assert.equal(runCli(['init', '--yes', '--no-push', '--language', 'es'], { cwd: root }).status, 0);
  assert.equal(runCli(['init', '--yes', '--no-push', '--language', 'en'], { cwd: other }).status, 0);
  await publish({ commonDir: common(root), visibilityOf: visibility('private') });
  await publish({ commonDir: common(other), visibilityOf: visibility('private') });
  assert.equal(readConfig(common(other)).language, 'es');
  assert.equal(JSON.parse(require('node:child_process').execFileSync('git', ['show', `${DOCS_REF}:config.json`], { cwd: remote, encoding: 'utf8' })).language, 'es');
});
