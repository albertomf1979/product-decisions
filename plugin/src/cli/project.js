'use strict';

// Project declaration and joining (PRD ACT-1, ACT-2), shared by init and sync.

const fs = require('node:fs');
const path = require('node:path');
const { DOCS_REF, git, readRef, readTreeFiles, readBlob, commitFiles } = require('../git/plumbing.js');
const { storeDir } = require('../core/state.js');
const { DEFAULT_CONFIG, writeConfigCopy } = require('../core/config.js');
const { addExclude, exportFolder } = require('../worker/folder.js');

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

function configAt(cwd, commit) {
  const sha = readTreeFiles(cwd, commit).get('config.json');
  if (!sha) return { ...DEFAULT_CONFIG };
  return { ...DEFAULT_CONFIG, ...JSON.parse(readBlob(cwd, sha).toString('utf8')) };
}

/** Whether a folder name is free: neither tracked nor present, except as our own export. */
function folderIsFree(location, folder) {
  if (git(['ls-files', '--', folder], { cwd: location.mainRoot }).stdout.length > 0) return false;
  const full = path.join(location.mainRoot, folder);
  if (!fs.existsSync(full)) return true;
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(storeDir(location.commonDir), 'state', 'export-manifest.json'), 'utf8'));
    return Array.isArray(manifest);
  } catch {
    return false;
  }
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

/** Stores the config copy, excludes the folder, and exports the docs tree into it. */
function materialize(location, commit) {
  const config = configAt(location.mainRoot, commit);
  writeConfigCopy(location.commonDir, config);
  addExclude(location.commonDir, config.folder);
  exportFolder({ location, config, files: treeFiles(location.mainRoot, commit) });
  return config;
}

module.exports = { remoteOf, fetchDocs, findDeclaration, configAt, folderIsFree, declare, adopt, materialize, treeFiles, REMOTE_DOCS };
