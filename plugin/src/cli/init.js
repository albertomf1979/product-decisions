'use strict';

const { execFileSync } = require('node:child_process');
const readline = require('node:readline/promises');
const { readLocal, writeLocal, machineId } = require('../core/state.js');
const { formatTimestamp } = require('../core/event.js');
const { UsageError, requireRepo, appendLocalEvent } = require('./shared.js');

const CONSENT = `product-decisions records your agent sessions in this repository.

What is recorded: your prompts, agent responses, and tool inputs and results in
full, including files the agent reads, plus your Git user name. Secrets are
redacted by pattern, which is not perfect. Contents of files such as .env are
never stored.

Where it goes: only .git/product-decisions on this machine. Nothing is shared.

Change your mind at any time with: product-decisions pause`;

function gitUserName(cwd) {
  try {
    return execFileSync('git', ['config', 'user.name'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

async function confirm() {
  if (!process.stdin.isTTY) {
    throw new UsageError('Consent is required. Run in a terminal to answer, or pass --yes to accept the text above.');
  }
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await prompt.question('Activate capture on this machine? [y/N] ');
  prompt.close();
  return /^y(es)?$/i.test(answer.trim());
}

/** Activates capture for this person on this clone, after explicit consent. */
async function init({ cwd, flags }) {
  const location = requireRepo(cwd);
  if (readLocal(location.commonDir)?.activated) {
    console.log('product-decisions is already active in this repository.');
    return 0;
  }

  console.log(`${CONSENT}\n`);
  if (!flags.yes && !(await confirm())) {
    console.log('Nothing was activated.');
    return 0;
  }

  const name = gitUserName(cwd);
  if (!name) console.error('Warning: Git user.name is not set, so events will name you as "unknown".');

  const state = {
    schema_version: 1,
    activated: true,
    activated_at: formatTimestamp(),
    actor_name: name || 'unknown',
    machine: machineId(),
    paused: false,
    paused_at: null,
    redact_patterns: [],
  };
  writeLocal(location.commonDir, state);
  appendLocalEvent(location, state, cwd, {
    eventType: 'consent',
    summary: `Capture activated by ${state.actor_name}`,
    payload: { statement: CONSENT },
  });
  console.log('Activated. New sessions in this repository will be captured.');
  return 0;
}

module.exports = { init };
