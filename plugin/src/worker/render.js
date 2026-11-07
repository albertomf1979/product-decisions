'use strict';

// Builds the docs tree for this machine's view: the docs branch, overlaid with this
// machine's own sessions and create-once files, with every index rebuilt.

const fs = require('node:fs');
const path = require('node:path');
const { locateRepo } = require('../core/locate.js');
const { readLocal, storeDir } = require('../core/state.js');
const { readConfig } = require('../core/config.js');
const { DOCS_REF, readRef, readTreeFiles, readBlob } = require('../git/plumbing.js');
const { renderSession } = require('../synth/deterministic/session.js');
const { renderIndexes } = require('../synth/deterministic/indexes.js');
const { exportFolder } = require('./folder.js');

function readEvents(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.pop();
  return lines.map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }).filter(Boolean);
}

function walk(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      return entry.isDirectory() ? walk(full) : [full];
    });
  } catch {
    return [];
  }
}

/** This machine's sessions, as event lists. */
function ownSessions(commonDir, machine) {
  const raw = path.join(storeDir(commonDir), 'raw');
  return walk(raw)
    .filter((file) => file.endsWith(`-${machine}.jsonl`) && path.basename(path.dirname(file)) !== 'cli')
    .map(readEvents)
    .filter((events) => events.length > 0);
}

/** Pauses recorded by the CLI on this machine. */
function gapsOf(commonDir, machine) {
  const file = path.join(storeDir(commonDir), 'raw', 'cli', `local-${machine}.jsonl`);
  if (!fs.existsSync(file)) return [];
  return readEvents(file).filter((e) => e.event_type === 'gap').map((e) => ({ from: e.payload.from, to: e.payload.to }));
}

const overlayDir = (commonDir) => path.join(storeDir(commonDir), 'state', 'docs-overlay');

/**
 * @returns {Map<string, Buffer>} The full docs tree as this machine sees it.
 */
function buildDocsFiles({ location, commonDir, state, config, bases = [] }) {
  const files = new Map();
  // Later bases win for the same path; each machine's own files are added on top.
  for (const base of bases.filter(Boolean)) {
    for (const [file, sha] of readTreeFiles(location.mainRoot, base)) files.set(file, readBlob(location.mainRoot, sha));
  }

  const gaps = gapsOf(commonDir, state.machine);
  for (const events of ownSessions(commonDir, state.machine)) {
    const home = require('node:os').homedir();
    for (const [file, content] of renderSession(events, config, { machine: state.machine, gaps, home })) files.set(file, Buffer.from(content));
  }
  const overlay = overlayDir(commonDir);
  for (const full of walk(overlay)) files.set(path.relative(overlay, full).split(path.sep).join('/'), fs.readFileSync(full));

  const sessions = [];
  const documentChanges = [];
  for (const [file, content] of files) {
    try {
      if (file.startsWith('.data/sessions/')) sessions.push(JSON.parse(content.toString('utf8')));
      if (file.startsWith('.data/documents/')) documentChanges.push(JSON.parse(content.toString('utf8')));
    } catch {
      // A damaged data file is skipped, not fatal.
    }
  }
  for (const [file, content] of renderIndexes(sessions, documentChanges, config)) files.set(file, Buffer.from(content));
  return files;
}

/** Refreshes the local folder. Does nothing until the project is declared. */
function refreshFolder({ commonDir }) {
  const state = readLocal(commonDir);
  const location = locateRepo(path.dirname(commonDir));
  if (!state || !location) return null;
  const base = readRef(location.mainRoot, DOCS_REF);
  if (!base) return null;
  const config = readConfig(commonDir);
  const files = buildDocsFiles({ location, commonDir, state, config, bases: [base] });
  exportFolder({ location, config, files });
  return files;
}

module.exports = { buildDocsFiles, refreshFolder, ownSessions, overlayDir, walk };
