'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** Reads a `gitdir: <path>` pointer file. Returns the absolute Git directory, or null. */
function readGitPointer(file, dir) {
  try {
    const match = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(file, 'utf8'));
    return match ? path.resolve(dir, match[1]) : null;
  } catch {
    return null;
  }
}

/** Resolves the common directory shared by linked worktrees. */
function resolveCommonDir(gitDir) {
  try {
    const relative = fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim();
    return path.resolve(gitDir, relative);
  } catch {
    return gitDir;
  }
}

function isDirectory(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Finds the repository that contains `startDir`, with no Git subprocess, because
 * this runs on the hook path.
 *
 * @param {string} startDir
 * @returns {{ worktreeRoot: string, gitDir: string, commonDir: string, mainRoot: string } | null}
 */
function locateRepo(startDir) {
  let dir = path.resolve(startDir);
  for (;;) {
    const candidate = path.join(dir, '.git');
    let stat = null;
    try {
      stat = fs.statSync(candidate);
    } catch {
      // Keep walking up.
    }
    if (stat) {
      const gitDir = stat.isDirectory() ? candidate : readGitPointer(candidate, dir);
      if (!gitDir || !isDirectory(gitDir)) return null;
      const commonDir = resolveCommonDir(gitDir);
      const mainRoot = path.basename(commonDir) === '.git' ? path.dirname(commonDir) : dir;
      return { worktreeRoot: dir, gitDir, commonDir, mainRoot };
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function samePath(a, b) {
  const real = (p) => {
    try {
      return fs.realpathSync.native(p);
    } catch {
      return path.resolve(p);
    }
  };
  return real(a) === real(b);
}

/**
 * Finds the repository a store belongs to, from its common directory. A submodule's
 * common directory lives inside the superproject's, so the parent folder is not enough:
 * the main checkout recorded at init comes first, and every answer must lead back to
 * the same common directory, or there is none.
 *
 * @param {string} commonDir
 * @param {{ main_root?: string } | null} [state]
 */
function locateStore(commonDir, state) {
  const candidates = [];
  if (state && typeof state.main_root === 'string') candidates.push(state.main_root);
  if (path.basename(commonDir) === '.git') candidates.push(path.dirname(commonDir));
  for (const dir of candidates) {
    const found = locateRepo(dir);
    if (found && samePath(found.commonDir, commonDir)) return found;
  }
  return null;
}

module.exports = { locateRepo, locateStore, samePath };
