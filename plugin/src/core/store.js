'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { storeDir } = require('./state.js');

// Session ids come from outside, so they never reach a path unchecked.
const safeName = (value) => String(value ?? '').replace(/[^A-Za-z0-9_-]/g, '_') || 'unknown';

/** @returns {string} `raw/<tool>/<session_id>-<machine>.jsonl` inside the store. */
function rawFilePath(commonDir, tool, sessionId, machine) {
  return path.join(storeDir(commonDir), 'raw', safeName(tool), `${safeName(sessionId)}-${safeName(machine)}.jsonl`);
}

/** Appends one line in a single write. Files stay private to their owner. */
function appendLine(target, line) {
  const data = `${line}\n`;
  try {
    fs.appendFileSync(target, data, { mode: 0o600 });
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.appendFileSync(target, data, { mode: 0o600 });
  }
}

const sessionMetaPath = (commonDir, tool, sessionId) =>
  path.join(storeDir(commonDir), 'sessions', `${safeName(tool)}-${safeName(sessionId)}.json`);

/** @returns {{ model: string, model_source: string } | null} Never throws. */
function readSessionMeta(commonDir, tool, sessionId) {
  try {
    return JSON.parse(fs.readFileSync(sessionMetaPath(commonDir, tool, sessionId), 'utf8'));
  } catch {
    return null;
  }
}

function writeSessionMeta(commonDir, tool, sessionId, meta) {
  const target = sessionMetaPath(commonDir, tool, sessionId);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, JSON.stringify(meta), { mode: 0o600 });
}

module.exports = { rawFilePath, appendLine, readSessionMeta, writeSessionMeta };
