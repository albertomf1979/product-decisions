'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

/** Creates a temporary Git repository. Paths are resolved, so macOS /var symlinks do not break comparisons. */
function makeRepo({ commit = true, dirName = 'repo' } = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pd-test-')));
  const root = path.join(base, dirName);
  fs.mkdirSync(root, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Test Person');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'commit.gpgsign', 'false');
  if (commit) {
    fs.writeFileSync(path.join(root, 'PRD.md'), '# PRD\n');
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'init');
  }
  return { root, base, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

/** Adds a linked worktree next to the repository and returns its path. */
function addWorktree(root, name) {
  const target = path.join(path.dirname(root), name);
  git(root, 'worktree', 'add', '-q', '-b', `wt-${name}`, target);
  return fs.realpathSync(target);
}

/** Activates capture directly, without going through the CLI. */
function activate(root, overrides = {}) {
  const { writeLocal } = require('../../plugin/src/core/state.js');
  writeLocal(path.join(root, '.git'), {
    schema_version: 1,
    activated: true,
    activated_at: '2026-11-05T10:00:00+01:00',
    actor_name: 'Test Person',
    machine: 'abcd1234',
    paused: false,
    paused_at: null,
    redact_patterns: [],
    ...overrides,
  });
}

module.exports = { makeRepo, addWorktree, activate, git };
