'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { git } = require('../git/plumbing.js');

function statusOf(xy) {
  if (xy === '??') return 'untracked';
  if (xy.includes('R')) return 'renamed';
  if (xy.includes('D')) return 'deleted';
  if (xy.includes('A')) return 'added';
  return 'modified';
}

/** Line counts against HEAD for tracked files; null for binary files. */
function numstat(worktreeRoot, env) {
  const counts = new Map();
  const result = git(['diff', '--no-ext-diff', '--no-textconv', '--numstat', '-z', 'HEAD'], { cwd: worktreeRoot, env, allowFail: true });
  if (result.status !== 0) return counts;
  const parts = result.stdout.toString('utf8').split('\0');
  for (let i = 0; i < parts.length; i += 1) {
    const fields = parts[i].split('\t');
    if (fields.length < 3) continue;
    const [added, removed] = fields;
    // A rename has an empty path here, followed by the old and new paths.
    const file = fields[2] === '' ? parts[(i += 2)] : fields[2];
    counts.set(file, added === '-' ? { added: null, removed: null } : { added: Number(added), removed: Number(removed) });
  }
  return counts;
}

/**
 * A copy of the worktree's index in the store. Status refreshes stat data and may
 * write the index it reads; on a copy, the person's index and its lock stay untouched.
 */
function privateIndex(gitDir, storeDir) {
  const dir = path.join(storeDir, 'tmp');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const copy = path.join(dir, `snapshot-index-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  try {
    fs.copyFileSync(path.join(gitDir, 'index'), copy);
  } catch {
    // No index yet: Git reads a missing file as an empty index, which is the truth.
  }
  return copy;
}

/**
 * The net state of the working tree: what changed, by whatever means, including shell
 * commands that no hook reports as edits (PRD CAP-10).
 *
 * @param {{ worktreeRoot: string, gitDir: string, storeDir: string, last?: string }} options
 * @returns {{ files: Array<{ path, status, added, removed }>, key: string } | null}
 *   Null when nothing changed, or when the state equals the last one recorded.
 */
function snapshot({ worktreeRoot, gitDir, storeDir, last }) {
  const index = privateIndex(gitDir, storeDir);
  try {
    return snapshotWith({ worktreeRoot, last, env: { GIT_INDEX_FILE: index } });
  } finally {
    fs.rmSync(index, { force: true });
  }
}

function snapshotWith({ worktreeRoot, last, env }) {
  const raw = git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: worktreeRoot, env }).stdout.toString('utf8');
  const counts = numstat(worktreeRoot, env);
  const files = [];
  const parts = raw.split('\0');
  for (let i = 0; i < parts.length; i += 1) {
    const entry = parts[i];
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    const file = entry.slice(3);
    if (xy[0] === 'R' || xy[0] === 'C') i += 1; // the original path follows
    const count = counts.get(file) || { added: null, removed: null };
    files.push({ path: file, status: statusOf(xy), added: count.added, removed: count.removed });
  }
  if (files.length === 0) return null;
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const key = crypto.createHash('sha256').update(JSON.stringify(files)).digest('hex');
  return key === last ? null : { files, key };
}

module.exports = { snapshot };
