'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { readGit } = require('../plugin/src/core/githead.js');
const { locateRepo } = require('../plugin/src/core/locate.js');
const { makeRepo, addWorktree, git } = require('./helpers/repo.js');

const sha = (root) => git(root, 'rev-parse', 'HEAD').slice(0, 12);

test('a normal repository gives its branch and commit', (t) => {
  const { root, cleanup } = makeRepo();
  t.after(cleanup);
  assert.deepEqual(readGit(locateRepo(root), root), { branch: 'main', head: sha(root), worktree: '.' });
});

test('worktree is the session folder relative to its root', (t) => {
  const { root, cleanup } = makeRepo();
  t.after(cleanup);
  const nested = path.join(root, 'a', 'b');
  fs.mkdirSync(nested, { recursive: true });
  assert.equal(readGit(locateRepo(nested), nested).worktree, 'a/b');
});

test('a linked worktree gives its own branch', (t) => {
  const { root, cleanup } = makeRepo();
  t.after(cleanup);
  const wt = addWorktree(root, 'wt');
  assert.deepEqual(readGit(locateRepo(wt), wt), { branch: 'wt-wt', head: sha(root), worktree: '.' });
});

test('packed refs are read', (t) => {
  const { root, cleanup } = makeRepo();
  t.after(cleanup);
  git(root, 'pack-refs', '--all');
  assert.equal(fs.existsSync(path.join(root, '.git', 'refs', 'heads', 'main')), false);
  assert.equal(readGit(locateRepo(root), root).head, sha(root));
});

test('a repository with no commits gives head null', (t) => {
  const { root, cleanup } = makeRepo({ commit: false });
  t.after(cleanup);
  assert.deepEqual(readGit(locateRepo(root), root), { branch: 'main', head: null, worktree: '.' });
});

test('a detached HEAD gives branch null and the commit as head', (t) => {
  const { root, cleanup } = makeRepo();
  t.after(cleanup);
  const expected = sha(root);
  git(root, 'checkout', '-q', '--detach');
  assert.deepEqual(readGit(locateRepo(root), root), { branch: null, head: expected, worktree: '.' });
});

test('a corrupt HEAD does not throw', (t) => {
  const { root, cleanup } = makeRepo();
  t.after(cleanup);
  fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'garbage\n');
  const out = readGit({ worktreeRoot: root, gitDir: path.join(root, '.git'), commonDir: path.join(root, '.git'), mainRoot: root }, root);
  assert.deepEqual(out, { branch: null, head: null, worktree: '.' });
});
