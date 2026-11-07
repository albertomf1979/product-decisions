'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { addExclude, exportFolder } = require('../plugin/src/worker/folder.js');
const { DEFAULT_CONFIG } = require('../plugin/src/core/config.js');
const { locateRepo } = require('../plugin/src/core/locate.js');
const { makeRepo, git } = require('./helpers/repo.js');

function repo(t) {
  const made = makeRepo();
  t.after(made.cleanup);
  return made.root;
}
const files = (entries) => new Map(Object.entries(entries).map(([k, v]) => [k, Buffer.from(v)]));

test('the exclude line is added once', (t) => {
  const root = repo(t);
  addExclude(path.join(root, '.git'), 'product-decisions');
  addExclude(path.join(root, '.git'), 'product-decisions');
  const lines = fs.readFileSync(path.join(root, '.git', 'info', 'exclude'), 'utf8').split('\n');
  assert.equal(lines.filter((l) => l === '/product-decisions/').length, 1);
});

test('the exported folder is invisible to git status and git add -A', (t) => {
  const root = repo(t);
  addExclude(path.join(root, '.git'), 'product-decisions');
  exportFolder({ location: locateRepo(root), config: DEFAULT_CONFIG, files: files({ 'README.md': '# x', 'timeline/a.md': 'a' }) });
  assert.equal(fs.readFileSync(path.join(root, 'product-decisions', 'timeline', 'a.md'), 'utf8'), 'a');
  assert.equal(git(root, 'status', '--porcelain'), '');
  git(root, 'add', '-A');
  assert.equal(git(root, 'diff', '--cached', '--name-only'), '');
});

test('exportFolder removes a file it wrote that is gone, and leaves other files alone', (t) => {
  const root = repo(t);
  const location = locateRepo(root);
  exportFolder({ location, config: DEFAULT_CONFIG, files: files({ 'a.md': 'a', 'b.md': 'b' }) });
  fs.writeFileSync(path.join(root, 'product-decisions', 'mine.md'), 'a person put this here');
  exportFolder({ location, config: DEFAULT_CONFIG, files: files({ 'a.md': 'A' }) });
  const folder = path.join(root, 'product-decisions');
  assert.deepEqual(fs.readdirSync(folder).sort(), ['a.md', 'mine.md']);
  assert.equal(fs.readFileSync(path.join(folder, 'a.md'), 'utf8'), 'A');
});

test('exportFolder refuses paths that leave the folder', (t) => {
  const root = repo(t);
  assert.throws(() => exportFolder({ location: locateRepo(root), config: DEFAULT_CONFIG, files: files({ '../escape.md': 'x' }) }));
  assert.equal(fs.existsSync(path.join(root, 'escape.md')), false);
});

test('from a linked worktree the folder goes to the main checkout', (t) => {
  const root = repo(t);
  const wt = path.join(path.dirname(root), 'wt');
  git(root, 'worktree', 'add', '-q', '-b', 'wt', wt);
  exportFolder({ location: locateRepo(wt), config: DEFAULT_CONFIG, files: files({ 'a.md': 'a' }) });
  assert.equal(fs.existsSync(path.join(root, 'product-decisions', 'a.md')), true);
  assert.equal(fs.existsSync(path.join(wt, 'product-decisions')), false);
});
