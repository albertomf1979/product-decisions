'use strict';

const crypto = require('node:crypto');
const { git } = require('../git/plumbing.js');

function statusOf(xy) {
  if (xy === '??') return 'untracked';
  if (xy.includes('R')) return 'renamed';
  if (xy.includes('D')) return 'deleted';
  if (xy.includes('A')) return 'added';
  return 'modified';
}

/** Line counts against HEAD for tracked files; null for binary files. */
function numstat(worktreeRoot) {
  const counts = new Map();
  const result = git(['diff', '--numstat', '-z', 'HEAD'], { cwd: worktreeRoot, allowFail: true });
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
 * The net state of the working tree: what changed, by whatever means, including shell
 * commands that no hook reports as edits (PRD CAP-10).
 *
 * @returns {{ files: Array<{ path, status, added, removed }>, key: string } | null}
 *   Null when nothing changed, or when the state equals the last one recorded.
 */
function snapshot({ worktreeRoot, last }) {
  const raw = git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: worktreeRoot }).stdout.toString('utf8');
  const counts = numstat(worktreeRoot);
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
