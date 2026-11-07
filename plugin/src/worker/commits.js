'use strict';

const { git } = require('../git/plumbing.js');

/** @returns {string | null} The full hash of a commit, from a short or full one. */
function resolveCommit(cwd, ref) {
  if (!ref) return null;
  const result = git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd, allowFail: true });
  return result.status === 0 ? result.stdout.toString('utf8').trim() : null;
}

/**
 * Commits made since the session started, oldest first.
 *
 * @returns {Array<{ sha: string, subject: string, files: string[] }>}
 */
function newCommits({ worktreeRoot, sinceHead }) {
  if (!resolveCommit(worktreeRoot, 'HEAD')) return [];
  const range = sinceHead ? `${sinceHead}..HEAD` : 'HEAD';
  const list = git(['rev-list', '--reverse', range], { cwd: worktreeRoot, allowFail: true });
  if (list.status !== 0) return [];
  return list.stdout.toString('utf8').split('\n').filter(Boolean).map((sha) => {
    const subject = git(['show', '--no-patch', '--format=%s', sha], { cwd: worktreeRoot }).stdout.toString('utf8').trim();
    const files = git(['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', '--root', sha], { cwd: worktreeRoot })
      .stdout.toString('utf8').split('\0').filter(Boolean);
    return { sha, subject, files };
  });
}

module.exports = { resolveCommit, newCommits };
