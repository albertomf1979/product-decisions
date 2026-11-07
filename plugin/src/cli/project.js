'use strict';

// Project declaration and joining (PRD ACT-1, ACT-2), shared by init and sync.

const { DOCS_REF, git, readRef, readTreeFiles, readBlob, commitFiles } = require('../git/plumbing.js');
const { storeDir } = require('../core/state.js');
const { DEFAULT_CONFIG, sanitizeConfig } = require('../core/config.js');
const { exportFolder } = require('../worker/folder.js');
const { folderIsFree, adoptConfig, parseConfig } = require('../worker/adopt.js');

const REMOTE_DOCS = 'refs/remotes/origin/product-decisions/docs';

/** @returns {{ name: string } | null} origin, or the first remote. */
function remoteOf(cwd) {
  const names = git(['remote'], { cwd, allowFail: true }).stdout.toString('utf8').split('\n').filter(Boolean);
  if (names.length === 0) return null;
  return { name: names.includes('origin') ? 'origin' : names[0] };
}

/** Fetches the docs branch, ignoring any failure: no network must never block. */
function fetchDocs(cwd) {
  const remote = remoteOf(cwd);
  if (!remote) return null;
  git(['fetch', '--quiet', '--no-tags', remote.name, `+${DOCS_REF}:${REMOTE_DOCS}`], { cwd, allowFail: true });
  return readRef(cwd, REMOTE_DOCS);
}

/** The commit holding the project declaration, local or remote, or null. */
function findDeclaration(cwd) {
  return readRef(cwd, DOCS_REF) || fetchDocs(cwd);
}

function treeFiles(cwd, commit) {
  const files = new Map();
  for (const [file, sha] of readTreeFiles(cwd, commit)) files.set(file, readBlob(cwd, sha));
  return files;
}

/** The raw config.json of a docs commit, parsed but not yet checked. */
function teamConfigAt(cwd, commit) {
  const sha = readTreeFiles(cwd, commit).get('config.json');
  return sha ? parseConfig(readBlob(cwd, sha)) : null;
}

/** The checked config of a docs commit. */
function configAt(cwd, commit) {
  return sanitizeConfig(teamConfigAt(cwd, commit), DEFAULT_CONFIG).config;
}

/** Creates the docs branch with config.json. */
function declare(location, config, authorName) {
  return commitFiles({
    cwd: location.mainRoot,
    storeDir: storeDir(location.commonDir),
    ref: DOCS_REF,
    files: { 'config.json': Buffer.from(`${JSON.stringify(config, null, 2)}\n`) },
    message: 'Declare the project for product-decisions',
    authorName,
  });
}

/** Points the local docs branch at the remote's, when the local one is missing. */
function adopt(location, commit) {
  if (!readRef(location.mainRoot, DOCS_REF)) git(['update-ref', DOCS_REF, commit], { cwd: location.mainRoot });
}

/**
 * Adopts the checked config, excludes the folder, and exports the docs tree into it.
 *
 * @returns {{ config: object, rejected: string[], blocked: boolean }} Blocked when the
 *   team's folder is taken here on a first adoption: nothing was written.
 */
function materialize(location, commit) {
  const adopted = adoptConfig(location, teamConfigAt(location.mainRoot, commit));
  if (!adopted.blocked) exportFolder({ location, config: adopted.config, files: treeFiles(location.mainRoot, commit) });
  return adopted;
}

/** The message for config values that were not adopted, or null. */
function rejectionNotice(rejected, config) {
  if (rejected.length === 0) return null;
  const folder = rejected.includes('folder') ? ` The folder stays ${config.folder}/, because the shared name is invalid or already taken here.` : '';
  return `Some shared settings were not adopted on this machine: ${rejected.join(', ')}.${folder}`;
}

module.exports = {
  remoteOf, fetchDocs, findDeclaration, configAt, teamConfigAt, folderIsFree, declare, adopt, materialize, rejectionNotice, treeFiles, REMOTE_DOCS,
};
