'use strict';

require('./no-real-claude.js');

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CLI = path.join(__dirname, '..', '..', 'plugin', 'src', 'cli', 'index.js');

/** Runs the real CLI. stdin is a closed pipe, so it never counts as a terminal. */
function runCli(args, { cwd, env, input = '' } = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    input,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

module.exports = { CLI, runCli };
