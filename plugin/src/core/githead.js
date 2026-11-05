'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SHA = /^[0-9a-f]{40,64}$/;
const SHORT = 12;

function readTrimmed(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return null;
  }
}

function resolveRef(commonDir, ref) {
  const loose = readTrimmed(path.join(commonDir, ...ref.split('/')));
  if (loose && SHA.test(loose)) return loose;
  const packed = readTrimmed(path.join(commonDir, 'packed-refs'));
  if (!packed) return null;
  const line = packed.split('\n').find((entry) => entry.endsWith(` ${ref}`));
  return line ? line.split(' ')[0] : null;
}

/**
 * Reads the branch and commit from Git's files, with no subprocess, because this
 * runs on the hook path.
 *
 * @returns {{ branch: string | null, head: string | null, worktree: string }}
 */
function readGit(location, cwd) {
  const worktree = path.relative(location.worktreeRoot, cwd).split(path.sep).join('/') || '.';
  const head = readTrimmed(path.join(location.gitDir, 'HEAD')) || '';
  if (SHA.test(head)) return { branch: null, head: head.slice(0, SHORT), worktree };
  const match = /^ref:\s*(\S+)$/.exec(head);
  if (!match) return { branch: null, head: null, worktree };
  const sha = resolveRef(location.commonDir, match[1]);
  return {
    branch: match[1].replace(/^refs\/heads\//, ''),
    head: sha ? sha.slice(0, SHORT) : null,
    worktree,
  };
}

module.exports = { readGit };
