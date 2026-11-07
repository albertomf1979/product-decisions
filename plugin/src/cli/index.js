#!/usr/bin/env node
'use strict';

const { UsageError } = require('./shared.js');

const USAGE = `Usage: product-decisions <command>

Commands:
  init [--yes]     Activate capture for you in this repository
  status [--json]  Show what is active and what has been captured
  pause            Stop capture for you on this clone
  resume           Restart capture and record the gap
  verify [--json]  Check that the record has not been altered`;

const COMMANDS = {
  init: () => require('./init.js').init,
  status: () => require('./status.js').status,
  pause: () => require('./pause.js').pause,
  resume: () => require('./pause.js').resume,
  verify: () => require('./verify.js').verify,
};

async function main(argv) {
  const positional = argv.filter((arg) => !arg.startsWith('--'));
  const flags = { yes: argv.includes('--yes'), json: argv.includes('--json') };

  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return 0;
  }
  const [name] = positional;
  if (!name) {
    console.error(USAGE);
    return 1;
  }
  if (!Object.prototype.hasOwnProperty.call(COMMANDS, name)) {
    console.error(`Unknown command: ${name}\n\n${USAGE}`);
    return 1;
  }
  return COMMANDS[name]()({ cwd: process.cwd(), flags });
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.error(err instanceof UsageError ? err.message : `Error: ${err.message}`);
    process.exitCode = 1;
  },
);
