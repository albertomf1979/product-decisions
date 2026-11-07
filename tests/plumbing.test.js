'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DOCS_REF, RAW_REF, git, readRef, readTreeFiles, readBlob, commitFiles, unionTrees } = require('../plugin/src/git/plumbing.js');
const { makeRepo, addWorktree, git: sh } = require('./helpers/repo.js');

const buf = (text) => Buffer.from(text);
const storeOf = (root) => path.join(root, '.git', 'product-decisions');
const contents = (root, commit) => Object.fromEntries([...readTreeFiles(root, commit)].map(([p, sha]) => [p, readBlob(root, sha).toString()]));
const fileHash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function repo(t, options) {
  const made = makeRepo(options);
  t.after(made.cleanup);
  return made.root;
}

test('the refs are the agreed names', () => {
  assert.equal(DOCS_REF, 'refs/heads/product-decisions/docs');
  assert.equal(RAW_REF, 'refs/product-decisions/raw');
});

test('commitFiles creates a ref with no parents', (t) => {
  const root = repo(t);
  const sha = commitFiles({ cwd: root, storeDir: storeOf(root), ref: DOCS_REF, files: { 'config.json': buf('{}') }, message: 'init', authorName: 'Ana' });
  assert.equal(readRef(root, DOCS_REF), sha);
  assert.equal(sh(root, 'rev-list', '--count', sha), '1');
  assert.deepEqual(contents(root, sha), { 'config.json': '{}' });
});

test('commitFiles keeps the base and replaces what files names', (t) => {
  const root = repo(t);
  const first = commitFiles({ cwd: root, storeDir: storeOf(root), ref: DOCS_REF, files: { 'a.md': buf('a'), 'b.md': buf('b') }, message: '1', authorName: 'Ana' });
  const second = commitFiles({ cwd: root, storeDir: storeOf(root), ref: DOCS_REF, parents: [first], base: first, files: { 'b.md': buf('B'), 'c/d.md': buf('d') }, message: '2', authorName: 'Ana' });
  assert.deepEqual(contents(root, second), { 'a.md': 'a', 'b.md': 'B', 'c/d.md': 'd' });
});

test('a null file removes it', (t) => {
  const root = repo(t);
  const first = commitFiles({ cwd: root, storeDir: storeOf(root), ref: DOCS_REF, files: { 'a.md': buf('a'), 'b.md': buf('b') }, message: '1', authorName: 'Ana' });
  const second = commitFiles({ cwd: root, storeDir: storeOf(root), ref: DOCS_REF, parents: [first], base: first, files: { 'a.md': null }, message: '2', authorName: 'Ana' });
  assert.deepEqual(contents(root, second), { 'b.md': 'b' });
});

test('commitFiles refuses when the ref moved', (t) => {
  const root = repo(t);
  const first = commitFiles({ cwd: root, storeDir: storeOf(root), ref: DOCS_REF, files: { 'a.md': buf('a') }, message: '1', authorName: 'Ana' });
  commitFiles({ cwd: root, storeDir: storeOf(root), ref: DOCS_REF, parents: [first], base: first, files: { 'a.md': buf('x') }, message: '2', authorName: 'Ana' });
  assert.throws(
    () => commitFiles({ cwd: root, storeDir: storeOf(root), ref: DOCS_REF, parents: [first], base: first, files: { 'a.md': buf('y') }, message: '3', authorName: 'Ana' }),
    (err) => err.code === 'REF_MOVED',
  );
});

test('creating a ref refuses when it already exists', (t) => {
  const root = repo(t);
  commitFiles({ cwd: root, storeDir: storeOf(root), ref: DOCS_REF, files: { 'a.md': buf('a') }, message: '1', authorName: 'Ana' });
  assert.throws(
    () => commitFiles({ cwd: root, storeDir: storeOf(root), ref: DOCS_REF, files: { 'b.md': buf('b') }, message: '2', authorName: 'Ana' }),
    (err) => err.code === 'REF_MOVED',
  );
});

test('an unchanged tree creates no empty commit', (t) => {
  const root = repo(t);
  const first = commitFiles({ cwd: root, storeDir: storeOf(root), ref: DOCS_REF, files: { 'a.md': buf('a') }, message: '1', authorName: 'Ana' });
  const again = commitFiles({ cwd: root, storeDir: storeOf(root), ref: DOCS_REF, parents: [first], base: first, files: { 'a.md': buf('a') }, message: '2', authorName: 'Ana' });
  assert.equal(again, first);
});

test('commitFiles leaves HEAD, the index, the working tree, and the status untouched', (t) => {
  const root = repo(t);
  fs.writeFileSync(path.join(root, 'PRD.md'), '# changed\n');
  fs.writeFileSync(path.join(root, 'new.md'), 'untracked\n');
  sh(root, 'add', 'new.md');
  const before = { head: sh(root, 'rev-parse', 'HEAD'), index: fileHash(path.join(root, '.git', 'index')), status: sh(root, 'status', '--porcelain'), prd: fileHash(path.join(root, 'PRD.md')) };
  commitFiles({ cwd: root, storeDir: storeOf(root), ref: DOCS_REF, files: { 'a.md': buf('a') }, message: '1', authorName: 'Ana' });
  assert.deepEqual({ head: sh(root, 'rev-parse', 'HEAD'), index: fileHash(path.join(root, '.git', 'index')), status: sh(root, 'status', '--porcelain'), prd: fileHash(path.join(root, 'PRD.md')) }, before);
});

test('commitFiles from a linked worktree writes to the shared refs', (t) => {
  const root = repo(t);
  const wt = addWorktree(root, 'wt');
  const sha = commitFiles({ cwd: wt, storeDir: storeOf(root), ref: DOCS_REF, files: { 'a.md': buf('a') }, message: '1', authorName: 'Ana' });
  assert.equal(readRef(root, DOCS_REF), sha);
});

test('repository hooks and core.hooksPath do not run', (t) => {
  const root = repo(t);
  const marker = path.join(root, '..', 'hook-ran');
  const script = `#!/bin/sh\ntouch "${marker}"\n`;
  for (const name of ['pre-commit', 'post-commit', 'reference-transaction', 'post-index-change']) {
    fs.writeFileSync(path.join(root, '.git', 'hooks', name), script, { mode: 0o755 });
  }
  const custom = path.join(root, '..', 'custom-hooks');
  fs.mkdirSync(custom);
  fs.writeFileSync(path.join(custom, 'reference-transaction'), script, { mode: 0o755 });
  commitFiles({ cwd: root, storeDir: storeOf(root), ref: DOCS_REF, files: { 'a.md': buf('a') }, message: '1', authorName: 'Ana' });
  sh(root, 'config', 'core.hooksPath', custom);
  commitFiles({ cwd: root, storeDir: storeOf(root), ref: RAW_REF, files: { 'b.md': buf('b') }, message: '1', authorName: 'Ana' });
  assert.equal(fs.existsSync(marker), false);
});

test('commit.gpgsign=true in the repository causes no prompt and no failure', (t) => {
  const root = repo(t);
  sh(root, 'config', 'commit.gpgsign', 'true');
  sh(root, 'config', 'gpg.program', path.join(root, 'no-such-gpg'));
  const sha = commitFiles({ cwd: root, storeDir: storeOf(root), ref: DOCS_REF, files: { 'a.md': buf('a') }, message: '1', authorName: 'Ana' });
  assert.equal(readRef(root, DOCS_REF), sha);
});

test('the commit has the given name and the placeholder email, not the Git config email', (t) => {
  const root = repo(t);
  const sha = commitFiles({ cwd: root, storeDir: storeOf(root), ref: DOCS_REF, files: { 'a.md': buf('a') }, message: 'publish', authorName: 'Ana Pérez' });
  assert.equal(sh(root, 'log', '-1', '--format=%an|%ae|%cn|%ce|%s', sha), 'Ana Pérez|product-decisions@users.noreply.invalid|Ana Pérez|product-decisions@users.noreply.invalid|publish');
});

test('unionTrees keeps files from every commit, later commits winning', (t) => {
  const root = repo(t);
  const a = commitFiles({ cwd: root, storeDir: storeOf(root), ref: 'refs/heads/x', files: { 'one.md': buf('1'), 'same.md': buf('old') }, message: 'a', authorName: 'Ana' });
  const b = commitFiles({ cwd: root, storeDir: storeOf(root), ref: 'refs/heads/y', files: { 'two.md': buf('2'), 'same.md': buf('new') }, message: 'b', authorName: 'Ana' });
  const union = unionTrees(root, [a, b]);
  assert.deepEqual([...union.keys()].sort(), ['one.md', 'same.md', 'two.md']);
  assert.equal(readBlob(root, union.get('same.md')).toString(), 'new');
  assert.deepEqual([...unionTrees(root, [a, null]).keys()].sort(), ['one.md', 'same.md']);
});

test('a repository with no commits works', (t) => {
  const root = repo(t, { commit: false });
  const sha = commitFiles({ cwd: root, storeDir: storeOf(root), ref: DOCS_REF, files: { 'a.md': buf('a') }, message: '1', authorName: 'Ana' });
  assert.equal(readRef(root, DOCS_REF), sha);
  assert.equal(sh(root, 'status', '--porcelain'), '');
});

test('a detached HEAD works', (t) => {
  const root = repo(t);
  sh(root, 'checkout', '-q', '--detach');
  const sha = commitFiles({ cwd: root, storeDir: storeOf(root), ref: DOCS_REF, files: { 'a.md': buf('a') }, message: '1', authorName: 'Ana' });
  assert.equal(readRef(root, DOCS_REF), sha);
});

test('paths with spaces and accents survive', (t) => {
  const root = repo(t, { dirName: 'Proyecto Año' });
  const name = 'carpeta ñ/archivo con espacios é.md';
  const sha = commitFiles({ cwd: root, storeDir: storeOf(root), ref: DOCS_REF, files: { [name]: buf('x') }, message: '1', authorName: 'Ana' });
  assert.deepEqual(contents(root, sha), { [name]: 'x' });
});

test('the private index file is removed afterwards, even on failure', (t) => {
  const root = repo(t);
  commitFiles({ cwd: root, storeDir: storeOf(root), ref: DOCS_REF, files: { 'a.md': buf('a') }, message: '1', authorName: 'Ana' });
  assert.throws(() => commitFiles({ cwd: root, storeDir: storeOf(root), ref: DOCS_REF, files: { 'b.md': buf('b') }, message: '2', authorName: 'Ana' }));
  assert.deepEqual(fs.readdirSync(path.join(storeOf(root), 'tmp')), []);
});

test('readRef returns null for a missing ref, and git reports failures with a code', (t) => {
  const root = repo(t);
  assert.equal(readRef(root, DOCS_REF), null);
  assert.throws(() => git(['rev-parse', 'no-such-thing'], { cwd: root }), (err) => err.code === 'GIT_FAILED');
  assert.equal(git(['rev-parse', 'no-such-thing'], { cwd: root, allowFail: true }).status !== 0, true);
});
