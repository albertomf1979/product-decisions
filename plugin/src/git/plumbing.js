'use strict';

// Writes to the plugin's own refs with Git plumbing and a private index, so that the
// user's HEAD, index, working tree, and code branches are never touched (PRD STO-3).

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const DOCS_REF = 'refs/heads/product-decisions/docs';
// A custom ref, so that normal clones and fetches do not download it (spike S3).
const RAW_REF = 'refs/product-decisions/raw';

const AUTHOR_EMAIL = 'product-decisions@users.noreply.invalid';
const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null';

// No user hook may run, no signing may prompt, and nothing may wait for credentials.
const SAFE_CONFIG = [
  '-c', `core.hooksPath=${NULL_DEVICE}`,
  '-c', 'commit.gpgsign=false',
  '-c', 'tag.gpgsign=false',
  '-c', 'core.fsmonitor=false',
  '-c', 'gc.auto=0',
  '-c', 'maintenance.auto=false',
  '-c', 'credential.interactive=false',
  // A stalled HTTP transfer gives up instead of hanging.
  '-c', 'http.lowSpeedLimit=1000',
  '-c', 'http.lowSpeedTime=60',
];

// An empty GIT_ASKPASS wins over core.askPass and SSH_ASKPASS, and with terminal prompts
// off Git fails instead of asking. The worker runs without a terminal, so SSH cannot ask
// either. Credential helpers still answer from their stores, without windows.
const QUIET_ENV = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_ASKPASS: '',
  SSH_ASKPASS: '',
  SSH_ASKPASS_REQUIRE: 'never',
  GCM_INTERACTIVE: 'never',
};

const NETWORK = new Set(['fetch', 'push', 'ls-remote']);
const LOCAL_TIMEOUT_MS = 120000;
const NETWORK_TIMEOUT_MS = 600000;

/**
 * Runs Git with the safe configuration.
 *
 * @param {string[]} args
 * @param {{ cwd: string, env?: object, input?: Buffer | string, allowFail?: boolean }} options
 *   A call that times out throws, even with allowFail.
 * @returns {{ status: number, stdout: Buffer }}
 */
function git(args, { cwd, env = {}, input, allowFail = false }) {
  const result = spawnSync('git', [...SAFE_CONFIG, ...args], {
    cwd,
    input,
    env: { ...process.env, ...QUIET_ENV, ...env },
    maxBuffer: 1024 * 1024 * 1024,
    windowsHide: true,
    timeout: NETWORK.has(args[0]) ? NETWORK_TIMEOUT_MS : LOCAL_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFail) {
    const err = new Error(`git ${args[0]} failed with status ${result.status}`);
    err.code = 'GIT_FAILED';
    err.status = result.status;
    err.stderr = String(result.stderr || '').slice(0, 300);
    throw err;
  }
  return { status: result.status, stdout: result.stdout };
}

const text = (result) => result.stdout.toString('utf8').trim();

/** @returns {string | null} The commit a ref points at, or null when it does not exist. */
function readRef(cwd, ref) {
  const result = git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd, allowFail: true });
  return result.status === 0 ? text(result) : null;
}

/** @returns {Map<string, string>} Every file path in a commit, mapped to its blob. */
function readTreeFiles(cwd, commit) {
  const files = new Map();
  if (!commit) return files;
  const raw = git(['ls-tree', '-r', '-z', commit], { cwd }).stdout.toString('utf8');
  for (const entry of raw.split('\0')) {
    const tab = entry.indexOf('\t');
    if (tab < 0) continue;
    const [, type, sha] = entry.slice(0, tab).split(' ');
    if (type === 'blob') files.set(entry.slice(tab + 1), sha);
  }
  return files;
}

/** @returns {Buffer} */
function readBlob(cwd, sha) {
  return git(['cat-file', 'blob', sha], { cwd }).stdout;
}

/** @returns {Map<string, string>} The files of several commits, later commits winning. */
function unionTrees(cwd, commits) {
  const union = new Map();
  for (const commit of commits) {
    for (const [file, sha] of readTreeFiles(cwd, commit)) union.set(file, sha);
  }
  return union;
}

function refMoved(ref) {
  const err = new Error(`${ref} changed while publishing`);
  err.code = 'REF_MOVED';
  return err;
}

/**
 * Commits files to a ref without a checkout.
 *
 * @param {object} options
 * @param {string} options.cwd Any folder of the repository, linked worktrees included.
 * @param {string} options.storeDir Where the temporary index lives.
 * @param {string} options.ref
 * @param {string[]} [options.parents]
 * @param {string | null} [options.base] Commit whose files are kept unless `files` replaces them.
 * @param {Object<string, Buffer | { sha: string } | null>} options.files Path to content, or to an
 *   existing blob by its sha so large files are never read; null removes the path.
 * @param {string} options.message
 * @param {string} options.authorName
 * @param {string | null} [options.expected] What the ref must point at now; null means it must not exist.
 * @returns {string} The new commit, or the first parent when nothing changed.
 */
function commitFiles({ cwd, storeDir, ref, parents = [], base = null, files, message, authorName, expected = parents[0] ?? null }) {
  const tmp = path.join(storeDir, 'tmp');
  fs.mkdirSync(tmp, { recursive: true, mode: 0o700 });
  const index = path.join(tmp, `index-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  const env = { GIT_INDEX_FILE: index };
  try {
    git(base ? ['read-tree', base] : ['read-tree', '--empty'], { cwd, env });
    for (const [file, content] of Object.entries(files)) {
      if (content === null) {
        git(['update-index', '--force-remove', '--', file], { cwd, env });
        continue;
      }
      const blob = Buffer.isBuffer(content) ? text(git(['hash-object', '-w', '--stdin'], { cwd, input: content })) : content.sha;
      git(['update-index', '--add', '--cacheinfo', `100644,${blob},${file}`], { cwd, env });
    }
    const tree = text(git(['write-tree'], { cwd, env }));
    if (parents.length === 1 && text(git(['rev-parse', `${parents[0]}^{tree}`], { cwd })) === tree) {
      return parents[0];
    }

    const identity = {
      GIT_AUTHOR_NAME: authorName,
      GIT_AUTHOR_EMAIL: AUTHOR_EMAIL,
      GIT_COMMITTER_NAME: authorName,
      GIT_COMMITTER_EMAIL: AUTHOR_EMAIL,
    };
    const commit = text(git(['commit-tree', tree, ...parents.flatMap((p) => ['-p', p]), '-m', message], { cwd, env: identity }));
    const instruction = expected ? `update ${ref} ${commit} ${expected}\n` : `create ${ref} ${commit}\n`;
    if (git(['update-ref', '--stdin'], { cwd, input: instruction, allowFail: true }).status !== 0) throw refMoved(ref);
    return commit;
  } finally {
    fs.rmSync(index, { force: true });
  }
}

module.exports = { DOCS_REF, RAW_REF, git, readRef, readTreeFiles, readBlob, unionTrees, commitFiles };
