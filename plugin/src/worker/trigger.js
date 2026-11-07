'use strict';

const path = require('node:path');

const TRIGGERS = { agent_response: 'turn', turn_failure: 'turn', session_end: 'close', session_start: 'recover' };

/** @returns {'turn' | 'close' | 'recover' | null} */
function triggerFor(eventType) {
  return Object.prototype.hasOwnProperty.call(TRIGGERS, eventType) ? TRIGGERS[eventType] : null;
}

/**
 * Starts the worker fully detached, so it outlives the hook and even a `claude -p` run,
 * and holds none of the hook's pipes: the hook can return at once.
 */
function startWorker(commonDir) {
  const { spawn } = require('node:child_process');
  const child = spawn(process.execPath, [path.join(__dirname, 'main.js'), commonDir], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.on('error', () => {});
  child.unref();
}

module.exports = { triggerFor, startWorker };
