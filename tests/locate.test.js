'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { locateRepo } = require('../plugin/src/core/locate.js');
const { makeRepo, addWorktree } = require('./helpers/repo.js');

test('finds the repository from a nested subdirectory', (t) => {
  const { root, cleanup } = makeRepo();
  t.after(cleanup);
  const nested = path.join(root, 'a', 'b');
  fs.mkdirSync(nested, { recursive: true });
  const loc = locateRepo(nested);
  assert.equal(loc.worktreeRoot, root);
  assert.equal(loc.commonDir, path.join(root, '.git'));
  assert.equal(loc.gitDir, path.join(root, '.git'));
  assert.equal(loc.mainRoot, root);
});

test('a linked worktree resolves to the main common dir', (t) => {
  const { root, cleanup } = makeRepo();
  t.after(cleanup);
  const wt = addWorktree(root, 'wt');
  const loc = locateRepo(wt);
  assert.equal(loc.worktreeRoot, wt);
  assert.equal(fs.realpathSync(loc.commonDir), path.join(root, '.git'));
  assert.notEqual(loc.gitDir, loc.commonDir);
  assert.equal(fs.realpathSync(loc.mainRoot), root);
});

test('a subdirectory of a linked worktree resolves to the same common dir', (t) => {
  const { root, cleanup } = makeRepo();
  t.after(cleanup);
  const wt = addWorktree(root, 'wt');
  const nested = path.join(wt, 'x');
  fs.mkdirSync(nested);
  assert.equal(fs.realpathSync(locateRepo(nested).commonDir), path.join(root, '.git'));
});

test('a submodule is its own repository', (t) => {
  const { root, cleanup } = makeRepo();
  t.after(cleanup);
  const modDir = path.join(root, '.git', 'modules', 'sub');
  const sub = path.join(root, 'sub');
  fs.mkdirSync(modDir, { recursive: true });
  fs.mkdirSync(sub);
  fs.writeFileSync(path.join(sub, '.git'), 'gitdir: ../.git/modules/sub\n');
  const loc = locateRepo(sub);
  assert.equal(loc.gitDir, modDir);
  assert.equal(loc.commonDir, modDir);
  assert.equal(loc.worktreeRoot, sub);
  assert.equal(loc.mainRoot, sub);
});

test('returns null outside a repository', (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pd-none-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(locateRepo(dir), null);
});

test('returns null on a malformed .git file', (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pd-bad-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, '.git'), 'nonsense');
  assert.equal(locateRepo(dir), null);
});

test('returns null for a directory that does not exist', () => {
  assert.equal(locateRepo(path.join(os.tmpdir(), 'pd-does-not-exist-xyz', 'a')), null);
});

test('paths with spaces and accents work', (t) => {
  const { root, cleanup } = makeRepo({ dirName: 'Proyecto Año' });
  t.after(cleanup);
  assert.equal(locateRepo(root).worktreeRoot, root);
});
