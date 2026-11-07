'use strict';

// Publication to the dedicated refs (PRD 8.6). Each machine writes only files it owns,
// and indexes are rebuilt after merging, so publishing cannot conflict. Never forces.

const fs = require('node:fs');
const path = require('node:path');
const { locateStore } = require('../core/locate.js');
const { readLocal, storeDir } = require('../core/state.js');
const { readConfig } = require('../core/config.js');
const { formatTimestamp } = require('../core/event.js');
const { DOCS_REF, RAW_REF, git, readRef, readTreeFiles, readBlob, commitFiles } = require('../git/plumbing.js');
const { checkVisibility, rawAllowed } = require('./visibility.js');
const { buildDocsFiles, refreshFolder, walk } = require('./render.js');
const { adoptConfig, parseConfig } = require('./adopt.js');

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

/** Every URL a push to this remote reaches: its push URLs, or its URLs when it has none. */
function pushUrls(cwd, name) {
  return git(['remote', 'get-url', '--push', '--all', name], { cwd, allowFail: true }).stdout.toString('utf8').split('\n').map((u) => u.trim()).filter(Boolean);
}

/**
 * The visibility of everywhere a push goes, asked fresh: private only when every
 * destination is verified private, public when any is public.
 */
async function destinationVisibility(urls, visibilityOf, cache) {
  if (urls.length === 0) return 'unknown';
  const values = [];
  for (const url of urls) values.push(await visibilityOf(url, { cache, fresh: true }));
  if (values.includes('public')) return 'public';
  return values.every((v) => v === 'private') ? 'private' : 'unknown';
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
        cwd, storeDir: storeDir(commonDir), ref, parents, files: build({ local, remoteTip }), message, authorName, expected: local,
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

/**
 * Own raw files by content, everyone else's by blob, so large records are never read.
 * The remote tip is applied after the local ref: other machines' files are newest there.
 */
function rawFiles({ cwd, commonDir, machine, local, remoteTip }) {
  const files = {};
  for (const base of [local, remoteTip].filter(Boolean)) {
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
 * or with push off, everything is committed locally only. A step that fails is
 * recorded as pending, never thrown, so status always tells the truth.
 *
 * @returns {Promise<{ remote, visibility, docs, raw, warnings } | null>}
 */
async function publish({ commonDir, push = true, visibilityOf = checkVisibility, beforePush, now = new Date() }) {
  const state = readLocal(commonDir);
  const location = locateStore(commonDir, state);
  if (!state || !state.activated || !location || !readRef(location.mainRoot, DOCS_REF)) return null;
  const cwd = location.mainRoot;
  const config = readConfig(commonDir);
  const remote = push ? remoteOf(cwd) : null;
  const authorName = state.actor_name || 'unknown';
  const cache = {
    get: (key) => readJson(stateFile(commonDir, 'visibility.json'), {})[key],
    set: (key, value) => writeJson(stateFile(commonDir, 'visibility.json'), { ...readJson(stateFile(commonDir, 'visibility.json'), {}), [key]: value }),
  };

  // Consent and pause events live in a file no session job seals; seal it before publishing.
  const cliFile = path.join(storeDir(commonDir), 'raw', 'cli', `local-${state.machine}.jsonl`);
  if (fs.existsSync(cliFile)) require('./seal.js').sealFile(cliFile, { now });

  const result = { remote: remote ? remote.name : null, visibility: null, docs: 'local', raw: 'local', warnings: [], rejected: [] };
  try {
    result.docs = await publishRef({
      cwd, commonDir, remote, ref: DOCS_REF, authorName, message: 'Publish the product decisions record', beforePush,
      build: ({ local, remoteTip }) => {
        // The team's declaration wins: someone who declared separately adopts what is usable of it.
        const teamConfig = remoteTip && readTreeFiles(cwd, remoteTip).get('config.json');
        let current = config;
        if (teamConfig) {
          const adopted = adoptConfig(location, parseConfig(readBlob(cwd, teamConfig)));
          current = adopted.config;
          result.rejected = adopted.rejected;
        }
        const files = buildDocsFiles({ location, commonDir, state, config: current, bases: [local, remoteTip] });
        if (teamConfig) files.set('config.json', { sha: teamConfig });
        return Object.fromEntries(files);
      },
    });
  } catch (err) {
    result.docs = 'pending';
    result.error = err.code || 'error';
  }

  if (remote) {
    try {
      result.visibility = await destinationVisibility(pushUrls(cwd, remote.name), visibilityOf, cache);
      if (rawAllowed(result.visibility, config)) {
        result.raw = await publishRef({
          cwd, commonDir, remote, ref: RAW_REF, authorName, message: 'Publish the raw record', beforePush,
          build: ({ local, remoteTip }) => rawFiles({ cwd, commonDir, machine: state.machine, local, remoteTip }),
        });
      } else if (result.visibility === 'public') {
        const listed = git(['ls-remote', remote.name, RAW_REF], { cwd, allowFail: true }).stdout.toString('utf8').trim();
        if (listed) result.warnings.push('raw_ref_public');
      }
    } catch (err) {
      result.raw = 'pending';
      result.error = err.code || 'error';
    }
  }

  try {
    refreshFolder({ commonDir });
  } catch {
    // The folder is refreshed again on the next turn.
  }
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

module.exports = { publish, remoteOf, pushUrls };
