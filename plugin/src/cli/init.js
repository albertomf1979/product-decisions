'use strict';

const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline/promises');
const { readLocal, writeLocal, machineId } = require('../core/state.js');
const { formatTimestamp } = require('../core/event.js');
const { DEFAULT_CONFIG, validateFolderName } = require('../core/config.js');
const { UsageError, requireRepo, appendLocalEvent } = require('./shared.js');
const project = require('./project.js');

const CONSENT = `product-decisions records your agent sessions in this repository.

What is recorded: your prompts, agent responses, and tool inputs and results in
full, including files the agent reads, plus your Git user name. Secrets are
redacted by pattern, which is not perfect. When a tool names a file such as
.env, its content is not stored, but content printed indirectly can be.

Where it goes: first to .git/product-decisions on this machine. Readable documents
are then published to the branch product-decisions/docs for anyone who can read
this repository. The full record goes to its own branch only if the repository is
verified private. In a public repository it stays on this machine.

Change your mind at any time with: product-decisions pause`;

function gitUserName(cwd) {
  try {
    return execFileSync('git', ['config', 'user.name'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

/** Asks one question in a terminal. Ctrl+D or a closed input counts as no answer. */
async function ask(question) {
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await prompt.question(question)).trim();
  } catch {
    return null;
  } finally {
    prompt.close();
  }
}

function suggestDocuments(location) {
  const listed = execFileSync('git', ['ls-files'], { cwd: location.mainRoot, encoding: 'utf8' }).split('\n');
  return listed.filter((file) => /(^|\/)(prd|spec|requirements)[^/]*\.(md|txt|docx|pdf)$/i.test(file) && file.split('/').length <= 3);
}

/** Settings for a new declaration, from flags or, in a terminal, from questions. */
async function newConfig(location, flags) {
  const config = { ...DEFAULT_CONFIG, publish: { ...DEFAULT_CONFIG.publish }, tracked_documents: [] };
  if (flags.folder !== undefined) config.folder = flags.folder;
  if (flags.language) config.language = flags.language;
  if (flags.track.length > 0) config.tracked_documents = flags.track;
  if (!process.stdin.isTTY || flags.yes) return config;
  if (!flags.language) {
    const answer = await ask(`Language for generated documents, en or es [${config.language}]: `);
    if (answer === 'es' || answer === 'en') config.language = answer;
  }
  if (flags.track.length === 0) {
    const candidates = suggestDocuments(location);
    if (candidates.length > 0) {
      candidates.forEach((file, i) => console.log(`  ${i + 1}. ${file}`));
      const answer = await ask('Track which of these as the PRD or specs? Numbers separated by commas, or Enter for none: ');
      config.tracked_documents = String(answer || '').split(',').map((n) => candidates[Number(n.trim()) - 1]).filter(Boolean);
    }
  }
  return config;
}

function checkFlags(location, flags) {
  if (flags.language && !['en', 'es'].includes(flags.language)) throw new UsageError('--language must be en or es.');
  if (flags.folder !== undefined && !validateFolderName(flags.folder)) {
    throw new UsageError(`"${flags.folder}" is not a valid folder name. Use one plain name, such as product-decisions.`);
  }
  for (const file of flags.track) {
    if (!fs.existsSync(path.join(location.mainRoot, file))) throw new UsageError(`Cannot track ${file}: there is no such file in this repository.`);
  }
}

/** Declares the project, or joins its existing declaration, then materializes the folder. */
async function declareOrJoin(location, flags, authorName) {
  const existing = project.findDeclaration(location.mainRoot);
  if (existing) {
    project.adopt(location, existing);
    const config = project.materialize(location, existing);
    return { joined: true, config };
  }
  const config = await newConfig(location, flags);
  if (!project.folderIsFree(location, config.folder)) {
    throw new UsageError(`A path named "${config.folder}" already exists in this project. Choose another name with --folder.`);
  }
  const commit = project.declare(location, config, authorName);
  const materialized = project.materialize(location, commit);
  const { declareBaseline } = require('../worker/documents.js');
  const { overlayDir } = require('../worker/render.js');
  for (const rel of materialized.tracked_documents) {
    declareBaseline({ location, commonDir: location.commonDir, path: rel, overlayDir: overlayDir(location.commonDir) });
  }
  return { joined: false, config: materialized };
}

function report(result) {
  console.log(result.joined
    ? `Joined the project. Its documents are in the folder ${result.config.folder}/.`
    : `Declared the project. Its documents will appear in the folder ${result.config.folder}/.`);
}

/** Activates capture for this person on this clone, after explicit consent. */
async function init({ cwd, flags }) {
  const location = requireRepo(cwd);
  checkFlags(location, flags);
  const existing = readLocal(location.commonDir);

  if (existing && existing.activated) {
    console.log(existing.paused
      ? 'product-decisions is active in this repository, but paused. Run: product-decisions resume'
      : 'product-decisions is already active in this repository.');
    if (!project.findDeclaration(location.mainRoot) || !fs.existsSync(path.join(location.commonDir, 'product-decisions', 'config.json'))) {
      report(await declareOrJoin(location, flags, existing.actor_name));
    }
    if (!existing.salt) writeLocal(location.commonDir, { ...existing, salt: crypto.randomBytes(32).toString('hex') });
    return 0;
  }

  // Before asking anything, make sure the folder is usable.
  const declared = project.findDeclaration(location.mainRoot);
  const folder = declared ? project.configAt(location.mainRoot, declared).folder : (flags.folder ?? DEFAULT_CONFIG.folder);
  if (!project.folderIsFree(location, folder) && !declared) {
    throw new UsageError(`A path named "${folder}" already exists in this project. Choose another name with --folder.`);
  }

  console.log(`${CONSENT}\n`);
  let method = 'flag';
  if (!flags.yes) {
    if (!process.stdin.isTTY) {
      throw new UsageError('Consent is required. Run in a terminal to answer, or pass --yes to accept the text above.');
    }
    const answer = await ask('Activate capture on this machine? [y/N] ');
    if (!/^y(es)?$/i.test(answer || '')) {
      console.log('Nothing was activated.');
      return 0;
    }
    method = 'interactive';
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
    salt: crypto.randomBytes(32).toString('hex'),
  };
  // The consent record comes first: if it cannot be written, nothing is activated.
  appendLocalEvent(location, state, cwd, {
    eventType: 'consent',
    summary: `Capture activated by ${state.actor_name}`,
    payload: { statement: CONSENT, method },
  });
  writeLocal(location.commonDir, state);
  const result = await declareOrJoin(location, flags, state.actor_name);
  report(result);
  require('../worker/render.js').refreshFolder({ commonDir: location.commonDir });
  // Publishing the declaration lets teammates join it instead of declaring their own.
  if (!result.joined && !flags.noPush) {
    try {
      await require('../worker/publish.js').publish({ commonDir: location.commonDir });
    } catch {
      // Publication is retried by the worker; activation does not depend on it.
    }
  }
  console.log('Activated. Sessions here are captured from now on, including any already open.');
  return 0;
}

module.exports = { init, CONSENT };
