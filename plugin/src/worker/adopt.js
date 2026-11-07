'use strict';

// Adopting the team's shared config on this machine (PRD ACT-2). The config comes from a
// branch anyone with push access can write, so nothing in it may make the plugin write
// outside its own folder or read outside the repository (PRD P2).

const fs = require('node:fs');
const path = require('node:path');
const { git } = require('../git/plumbing.js');
const { storeDir } = require('../core/state.js');
const { readConfig, writeConfigCopy, validateFolderName, sanitizeConfig } = require('../core/config.js');
const { addExclude, readManifest } = require('./folder.js');

const hasConfigCopy = (commonDir) => fs.existsSync(path.join(storeDir(commonDir), 'config.json'));

/** Whether a folder name is free: neither tracked nor present, except as this machine's own export. */
function folderIsFree(location, folder) {
  if (!validateFolderName(folder)) return false;
  if (git(['ls-files', '--', folder], { cwd: location.mainRoot }).stdout.length > 0) return false;
  if (!fs.existsSync(path.join(location.mainRoot, folder))) return true;
  const manifest = readManifest(location.commonDir);
  if (manifest.folder !== null) return manifest.folder === folder;
  // An older manifest names no folder: the stored config says which one it was.
  return manifest.files.length > 0 && hasConfigCopy(location.commonDir) && readConfig(location.commonDir).folder === folder;
}

/**
 * Checks the team's config and stores what is usable as this machine's copy. A folder
 * that is invalid or taken here is not adopted: the current one stays. On a first
 * adoption there is no current folder, so a taken folder blocks joining instead.
 *
 * @param {object} location
 * @param {unknown} team The parsed config.json from the docs branch.
 * @returns {{ config: object, rejected: string[], blocked: boolean }}
 */
function adoptConfig(location, team) {
  const first = !hasConfigCopy(location.commonDir);
  const current = readConfig(location.commonDir);
  const { config, rejected } = sanitizeConfig(team, current);
  if ((first || config.folder !== current.folder) && !folderIsFree(location, config.folder)) {
    if (first) return { config, rejected, blocked: true };
    if (!rejected.includes('folder')) rejected.push('folder');
    config.folder = current.folder;
  }
  writeConfigCopy(location.commonDir, config);
  addExclude(location.commonDir, config.folder);
  return { config, rejected, blocked: false };
}

/** @returns {unknown} The parsed content, or null when it is not JSON. */
function parseConfig(content) {
  try {
    return JSON.parse(String(content));
  } catch {
    return null;
  }
}

module.exports = { folderIsFree, adoptConfig, parseConfig };
