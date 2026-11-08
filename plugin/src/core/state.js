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
 * @property {boolean} [llm_enabled] False when this person turned LLM synthesis off (--no-llm)
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

/**
 * A new random identifier for one activation, stored in local.json and stable from
 * then on. It is random rather than derived from the host name: two clones on one
 * host, or two people whose computers share a common name, must never own the same
 * file names (PRD STO-6), and nothing about the host is revealed.
 *
 * @returns {string} 8 hex characters.
 */
function machineId() {
  return require('node:crypto').randomBytes(4).toString('hex');
}

module.exports = { storeDir, readLocal, writeLocal, isCapturing, machineId };
