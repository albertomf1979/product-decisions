'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { storeDir } = require('./state.js');
const { appendLine } = require('./store.js');

const MAX_LOG_BYTES = 1024 * 1024;

function writeLog(commonDir, name, record) {
  if (!commonDir) return;
  try {
    const target = path.join(storeDir(commonDir), 'logs', name);
    try {
      if (fs.statSync(target).size > MAX_LOG_BYTES) fs.renameSync(target, `${target}.1`);
    } catch {
      // No log yet.
    }
    appendLine(target, JSON.stringify({ ts: new Date().toISOString(), ...record }));
  } catch {
    // Diagnostics must never become the failure.
  }
}

/**
 * Records a failure with no payload content. Only system errors keep their message,
 * because others can quote their input: JSON.parse errors include a snippet of it.
 */
function logError(commonDir, where, err) {
  const record = { where, name: err && err.name, code: err && err.code };
  if (err && err.code && err.message) record.message = String(err.message).slice(0, 200);
  writeLog(commonDir, 'diagnostics.log', record);
}

/** @param {{ tool: string, event: string, ms: number, bytes: number }} record */
function logLatency(commonDir, record) {
  writeLog(commonDir, 'latency.jsonl', record);
}

module.exports = { logError, logLatency };
