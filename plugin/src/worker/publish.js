'use strict';

// Publication to the dedicated refs (PRD 8.6). Each machine writes only files it owns,
// and indexes are rebuilt after merging, so publishing cannot conflict. Never forces.

const fs = require('node:fs');
const path = require('node:path');
const { locateRepo } = require('../core/locate.js');
const { readLocal, storeDir } = require('../core/state.js');
const { readConfig, writeConfigCopy, DEFAULT_CONFIG } = require('../core/config.js');
const { formatTimestamp } = require('../core/event.js');
const { DOCS_REF, RAW_REF, git, readRef, readTreeFiles, readBlob, commitFiles } = require('../git/plumbing.js');
const { checkVisibility, rawAllowed } = require('./visibility.js');
const { buildDocsFiles, refreshFolder, walk } = require('./render.js');

const TRACKING = {
  [DOCS_REF]: 'refs/remotes/origin/product-decisions/docs',
  [RAW_REF]: 'refs/product-decisions/remotes/raw',
};
const MAX_ATTEMPTS = 4;

const stateFile = (commonDir, name) => path.join(storeDir(commonDir), 'state', name);
function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function remoteOf(cwd) {
  const names = git(['remote'], { cwd, allowFail: true }).stdout.toString('utf8').split('\n').filter(Boolean);
  if (names.length === 0) return null;
  const name = names.includes('origin') ? 'origin' : names[0];
  const url = git(['remote', 'get-url', name], { cwd, allowFail: true }).stdout.toString('utf8').trim();
  return { name, url };
}

const isAncestor = (cwd, a, b) => git(['merge-base', '--is-ancestor', a, b], { cwd, allowFail: true }).status === 0;

function parentsFor(cwd, local, remoteTip) {
  if (!local) return remoteTip ? [remoteTip] : [];
  if (!remoteTip || local === remoteTip || isAncestor(cwd, remoteTip, local)) return [local];
  if (isAncestor(cwd, local, remoteTip)) return [remoteTip];
  return [local, remoteTip];
}

/**
 * Commits what `build` produces onto a ref and pushes it, merging with the remote and
 * retrying when someone else published first.
 *
 * @returns {Promise<'local' | 'published' | 'pending'>}
 */
async function publishRef({ cwd, commonDir, remote, ref, build, authorName, message, beforePush }) {
  const tracking = TRACKING[ref];
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    let remoteTip = null;
    if (remote) {
      git(['fetch', '--quiet', '--no-tags', remote.name, `+${ref}:${tracking}`], { cwd, allowFail: true });
      remoteTip = readRef(cwd, tracking);
    }
    const local = readRef(cwd, ref);
    const parents = parentsFor(cwd, local, remoteTip);
    let commit;
    try {
      commit = commitFiles({
        cwd, storeDir: storeDir(commonDir), ref, parents, files: build([remoteTip, local]), message, authorName, expected: local,
      });
    } catch (err) {
      if (err.code === 'REF_MOVED') continue;
      throw err;
    }
    // An unchanged tree returns the parent without moving the ref.
    if (readRef(cwd, ref) !== commit) git(['update-ref', ref, commit], { cwd });
    if (!remote) return 'local';
    if (commit === remoteTip) return 'published';
    if (beforePush) await beforePush({ ref, attempt });
    const pushed = git(['push', '--no-verify', '--quiet', remote.name, `${ref}:${ref}`], { cwd, allowFail: true });
    if (pushed.status === 0) {
      git(['update-ref', tracking, commit], { cwd });
      return 'published';
    }
  }
  return 'pending';
}

/** Own raw files by content, everyone else's by blob, so large records are never read. */
function rawFiles({ cwd, commonDir, machine, bases }) {
  const files = {};
  for (const base of bases.filter(Boolean)) {
    for (const [file, sha] of readTreeFiles(cwd, base)) files[file] = { sha };
  }
  const raw = path.join(storeDir(commonDir), 'raw');
  for (const full of walk(raw).filter((f) => f.endsWith(`-${machine}.jsonl`))) {
    files[path.relative(raw, full).split(path.sep).join('/')] = fs.readFileSync(full);
  }
  return files;
}

/**
 * Publishes the docs and, when the policy allows, the raw record. Without a remote,
 * or with push off, everything is committed locally only.
 *
 * @returns {Promise<{ remote, visibility, docs, raw, warnings } | null>}
 */
async function publish({ commonDir, push = true, visibilityOf = checkVisibility, beforePush, now = new Date() }) {
  const state = readLocal(commonDir);
  const location = locateRepo(path.dirname(commonDir));
  if (!state || !state.activated || !location || !readRef(location.mainRoot, DOCS_REF)) return null;
  const cwd = location.mainRoot;
  const config = readConfig(commonDir);
  const remote = push ? remoteOf(cwd) : null;
  const authorName = state.actor_name || 'unknown';
  const cache = {
    get: (key) => readJson(stateFile(commonDir, 'visibility.json'), {})[key],
    set: (key, value) => writeJson(stateFile(commonDir, 'visibility.json'), { ...readJson(stateFile(commonDir, 'visibility.json'), {}), [key]: value }),
  };

  const result = { remote: remote ? remote.name : null, visibility: null, docs: 'local', raw: 'local', warnings: [] };
  result.docs = await publishRef({
    cwd, commonDir, remote, ref: DOCS_REF, authorName, message: 'Publish the product decisions record', beforePush,
    build: ([remoteTip, local]) => {
      const files = buildDocsFiles({ location, commonDir, state, config, bases: [remoteTip, local] });
      // The team's declaration wins: someone who declared separately adopts it.
      const teamConfig = remoteTip && readTreeFiles(cwd, remoteTip).get('config.json');
      if (teamConfig) {
        const content = readBlob(cwd, teamConfig);
        files.set('config.json', content);
        writeConfigCopy(commonDir, { ...DEFAULT_CONFIG, ...JSON.parse(content.toString('utf8')) });
      }
      return Object.fromEntries(files);
    },
  });

  if (remote) {
    result.visibility = await visibilityOf(remote.url, { cache });
    if (rawAllowed(result.visibility, config)) {
      result.raw = await publishRef({
        cwd, commonDir, remote, ref: RAW_REF, authorName, message: 'Publish the raw record', beforePush,
        build: (bases) => rawFiles({ cwd, commonDir, machine: state.machine, bases }),
      });
    } else if (result.visibility === 'public') {
      const listed = git(['ls-remote', remote.name, RAW_REF], { cwd, allowFail: true }).stdout.toString('utf8').trim();
      if (listed) result.warnings.push('raw_ref_public');
    }
  }

  refreshFolder({ commonDir });
  const previous = readJson(stateFile(commonDir, 'publish.json'), {});
  writeJson(stateFile(commonDir, 'publish.json'), {
    remote: result.remote,
    visibility: result.visibility,
    docs_pending: result.docs === 'pending',
    raw_pending: result.raw === 'pending',
    warnings: result.warnings,
    last_published_at: result.docs === 'published' ? formatTimestamp(now) : previous.last_published_at || null,
  });
  return result;
}

module.exports = { publish, remoteOf };
