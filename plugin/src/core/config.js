'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { storeDir } = require('./state.js');

/** The project configuration. The shared copy lives on the docs branch as config.json. */
const DEFAULT_CONFIG = Object.freeze({
  schema_version: 1,
  folder: 'product-decisions',
  language: 'en',
  tracked_documents: [],
  publish: { raw: 'auto' },
  redact_patterns: [],
});

const copyPath = (commonDir) => path.join(storeDir(commonDir), 'config.json');

/** @returns {object} The store's copy of the project config, completed with defaults. */
function readConfig(commonDir) {
  try {
    const stored = JSON.parse(fs.readFileSync(copyPath(commonDir), 'utf8'));
    return { ...DEFAULT_CONFIG, ...stored, publish: { ...DEFAULT_CONFIG.publish, ...(stored.publish || {}) } };
  } catch {
    return { ...DEFAULT_CONFIG, publish: { ...DEFAULT_CONFIG.publish } };
  }
}

function writeConfigCopy(commonDir, config) {
  fs.mkdirSync(storeDir(commonDir), { recursive: true, mode: 0o700 });
  fs.writeFileSync(copyPath(commonDir), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

/** One plain path segment, so the folder can never point outside the project root. */
function validateFolderName(name) {
  return typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name) && name !== '.git' && !name.includes('..');
}

module.exports = { DEFAULT_CONFIG, readConfig, writeConfigCopy, validateFolderName };
