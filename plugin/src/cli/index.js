#!/usr/bin/env node
'use strict';

const { UsageError } = require('./shared.js');

const USAGE = `Usage: product-decisions <command>

Commands:
  init [--yes] [--no-push] [--no-llm] [--language en|es] [--folder <name>] [--track <path>]...
                   Activate capture for you, and declare or join the project
  status [--json]  Show what is active and what has been captured
  pause            Stop capture for you on this clone
  resume           Restart capture and record the gap
  verify [--json]  Check that the record has not been altered
  sync [--no-push] [--llm]
                   Bring the record and the folder up to date; --llm also runs
                   LLM synthesis now
  import [--dry-run] [--session <id>]
                   Bring in your past Claude Code sessions for this repository`;

const COMMANDS = {
  init: () => require('./init.js').init,
  status: () => require('./status.js').status,
  pause: () => require('./pause.js').pause,
  resume: () => require('./pause.js').resume,
  verify: () => require('./verify.js').verify,
  sync: () => require('./sync.js').sync,
  import: () => require('./import.js').importCommand,
};

async function main(argv) {
  const flags = { yes: false, json: false, noPush: false, noLlm: false, llm: false, dryRun: false, session: null, track: [] };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--yes') flags.yes = true;
    else if (arg === '--json') flags.json = true;
    else if (arg === '--no-push') flags.noPush = true;
    else if (arg === '--no-llm') flags.noLlm = true;
    else if (arg === '--llm') flags.llm = true;
    else if (arg === '--dry-run') flags.dryRun = true;
    else if (arg === '--session') flags.session = argv[(i += 1)] ?? '';
    else if (arg === '--language') flags.language = argv[(i += 1)];
    else if (arg === '--folder') flags.folder = argv[(i += 1)] ?? '';
    else if (arg === '--track') flags.track.push(argv[(i += 1)]);
    else if (!arg.startsWith('-')) positional.push(arg);
  }

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
