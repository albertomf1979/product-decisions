'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * @typedef {Object} LocalState
 * @property {1} schema_version
 * @property {boolean} activated
 * @property {string} activated_at
 * @property {string} actor_name
 * @property {string} machine
 * @property {boolean} paused
 * @property {string | null} paused_at
 * @property {string[]} redact_patterns
 */

/** @returns {string} The plugin's private directory inside the Git common directory. */
function storeDir(commonDir) {
  return path.join(commonDir, 'product-decisions');
}

/** @returns {LocalState | null} Never throws: an unreadable state means "not activated". */
function readLocal(commonDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(storeDir(commonDir), 'local.json'), 'utf8'));
  } catch {
    return null;
  }
}

/** Replaces the state atomically, so a reader never sees a partial file. */
function writeLocal(commonDir, state) {
  const dir = storeDir(commonDir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = path.join(dir, 'local.json');
  const temp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, target);
}

/** @param {LocalState | null} state */
function isCapturing(state) {
  return Boolean(state && state.activated === true && state.paused !== true);
}

/** @returns {string} Short stable identifier that does not expose the host name. */
function machineId() {
  const crypto = require('node:crypto');
  const os = require('node:os');
  return crypto.createHash('sha256').update(os.hostname()).digest('hex').slice(0, 8);
}

module.exports = { storeDir, readLocal, writeLocal, isCapturing, machineId };
