'use strict';

const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline/promises');
const { readLocal, writeLocal, machineId, storeDir } = require('../core/state.js');
const { formatTimestamp } = require('../core/event.js');
const { DEFAULT_CONFIG, validateFolderName, isSafeRelativePath } = require('../core/config.js');
const { CONSENT, CONSENT_SHA, consentIsCurrent } = require('../core/consent.js');
const { UsageError, requireRepo, appendLocalEvent } = require('./shared.js');
const project = require('./project.js');

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
  flags.track = flags.track.map((file) => path.posix.normalize(String(file).split(path.sep).join('/')));
  for (const file of flags.track) {
    if (!isSafeRelativePath(file) || !fs.existsSync(path.join(location.mainRoot, file))) {
      throw new UsageError(`Cannot track ${file}: there is no such file in this repository.`);
    }
  }
}

/**
 * Where this repository pushes, and whether those places are public, from the last
 * known answers. Read only: nothing is written before consent.
 */
async function visibilityNotice(location) {
  const { remoteOf, pushUrls } = require('../worker/publish.js');
  const { checkVisibility } = require('../worker/visibility.js');
  const remote = remoteOf(location.mainRoot);
  if (!remote) return null;
  let known = {};
  try {
    known = JSON.parse(fs.readFileSync(path.join(storeDir(location.commonDir), 'state', 'visibility.json'), 'utf8'));
  } catch {
    // Not checked before.
  }
  const cache = { get: (key) => known[key], set: () => {} };
  const values = [];
  for (const url of pushUrls(location.mainRoot, remote.name)) values.push(await checkVisibility(url, { cache }));
  if (values.includes('public')) return 'This repository is public, so its documents will be public. The full record stays on this machine.';
  if (values.length === 0 || values.some((v) => v !== 'private')) return 'The visibility of this repository could not be verified, so the full record stays on this machine until it is.';
  return null;
}

/** Shows the consent text and returns how it was accepted, or null when it was not. */
async function askConsent(location, flags) {
  const notice = await visibilityNotice(location);
  if (notice) console.log(`${notice}\n`);
  console.log(`${CONSENT}\n`);
  if (flags.yes) return 'flag';
  if (!process.stdin.isTTY) {
    throw new UsageError('Consent is required. Run in a terminal to answer, or pass --yes to accept the text above.');
  }
  const answer = await ask('Activate capture on this machine? [y/N] ');
  if (!/^y(es)?$/i.test(answer || '')) {
    console.log('Nothing was activated.');
    return null;
  }
  return 'interactive';
}

/** Publishes under the worker lock, so it never races a running worker. */
async function publishNow(location) {
  const { withLock } = require('../worker/queue.js');
  try {
    await withLock(location.commonDir, () => require('../worker/publish.js').publish({ commonDir: location.commonDir }));
  } catch {
    // Publication is retried by the worker; activation does not depend on it.
  }
}

/** Declares the project, or joins its existing declaration, then materializes the folder. */
async function declareOrJoin(location, flags, authorName) {
  const existing = project.findDeclaration(location.mainRoot);
  if (existing) {
    const adopted = project.materialize(location, existing);
    if (adopted.blocked) throw new UsageError(takenFolder(adopted.config.folder));
    project.adopt(location, existing);
    return { joined: true, config: adopted.config, rejected: adopted.rejected };
  }
  const config = await newConfig(location, flags);
  if (!project.folderIsFree(location, config.folder)) {
    throw new UsageError(`A path named "${config.folder}" already exists in this project. Choose another name with --folder.`);
  }
  const commit = project.declare(location, config, authorName);
  const materialized = project.materialize(location, commit).config;
  const { declareBaseline } = require('../worker/documents.js');
  const { overlayDir } = require('../worker/render.js');
  for (const rel of materialized.tracked_documents) {
    declareBaseline({ location, commonDir: location.commonDir, path: rel, overlayDir: overlayDir(location.commonDir) });
  }
  return { joined: false, config: materialized, rejected: [] };
}

const takenFolder = (folder) => `The team's documents use the folder name "${folder}", but a path with that name already exists here. Move it aside, then run init again.`;

function report(result) {
  console.log(result.joined
    ? `Joined the project. Its documents are in the folder ${result.config.folder}/.`
    : `Declared the project. Its documents will appear in the folder ${result.config.folder}/.`);
  const notice = project.rejectionNotice(result.rejected || [], result.config);
  if (notice) console.log(notice);
}

const pushReport = (on) => console.log(on
  ? 'Publishing from this machine is on.'
  : 'Publishing from this machine is off: everything stays here. Run init again without --no-push to turn it on.');

/** Activates capture for this person on this clone, after explicit consent. */
async function init({ cwd, flags }) {
  const location = requireRepo(cwd);
  checkFlags(location, flags);
  const existing = readLocal(location.commonDir);

  if (existing && existing.activated) {
    console.log(existing.paused
      ? 'product-decisions is active in this repository, but paused. Run: product-decisions resume'
      : 'product-decisions is already active in this repository.');
    let state = { ...existing, main_root: location.mainRoot, push_enabled: !flags.noPush };
    if (!consentIsCurrent(existing)) {
      // The text changed since this person accepted it: nothing is published until they accept the new one.
      console.log('The consent text has changed since you accepted it.\n');
      const method = await askConsent(location, flags);
      if (!method) return 0;
      appendLocalEvent(location, existing, cwd, {
        eventType: 'consent',
        summary: `Consent renewed by ${existing.actor_name}`,
        payload: { statement: CONSENT, method },
      });
      state = { ...state, consent_sha: CONSENT_SHA };
    }
    if (!state.salt) state.salt = crypto.randomBytes(32).toString('hex');
    writeLocal(location.commonDir, state);
    if (!project.findDeclaration(location.mainRoot) || !fs.existsSync(path.join(storeDir(location.commonDir), 'config.json'))) {
      report(await declareOrJoin(location, flags, existing.actor_name));
    }
    pushReport(state.push_enabled);
    return 0;
  }

  // Before asking anything, make sure the folder is usable, also when joining.
  const declared = project.findDeclaration(location.mainRoot);
  const folder = declared ? project.configAt(location.mainRoot, declared).folder : (flags.folder ?? DEFAULT_CONFIG.folder);
  if (!project.folderIsFree(location, folder)) {
    throw new UsageError(declared ? takenFolder(folder) : `A path named "${folder}" already exists in this project. Choose another name with --folder.`);
  }

  const method = await askConsent(location, flags);
  if (!method) return 0;

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
    consent_sha: CONSENT_SHA,
    push_enabled: !flags.noPush,
    main_root: location.mainRoot,
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
  if (!result.joined && state.push_enabled) await publishNow(location);
  pushReport(state.push_enabled);
  console.log('Activated. Sessions here are captured from now on, including any already open.');
  return 0;
}

module.exports = { init, CONSENT };
