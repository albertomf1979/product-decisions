'use strict';

// `product-decisions import` (PRD 8.12): brings a person's past Claude Code sessions for
// this repository into the record, labelled as imported, through the same redaction,
// secret-file protection, and write boundary as live capture. Explicit only.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readLocal } = require('../core/state.js');
const { consentIsCurrent } = require('../core/consent.js');
const { rawFilePath, appendLine, readSessionMeta, writeSessionMeta } = require('../core/store.js');
const { buildEvent, formatTimestamp } = require('../core/event.js');
const { readGit } = require('../core/githead.js');
const { locateRepo, samePath } = require('../core/locate.js');
const { storeDir } = require('../core/state.js');
const { maskHome } = require('../core/redact.js');
const { UsageError, requireRepo } = require('./shared.js');
const { IMPORTER_VERSION, readTranscript, toPayloads, findTranscripts, checkouts } = require('../import/claude-code.js');

const TOOL = 'claude-code';

function readEvents(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  return text.split('\n').filter(Boolean).map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }).filter(Boolean);
}

/** The pauses this person recorded on this clone, as [from, to] in milliseconds. */
function pausesOf(commonDir, machine) {
  return readEvents(rawFilePath(commonDir, 'cli', 'local', machine))
    .filter((event) => event.event_type === 'gap' && event.payload)
    .map((event) => [Date.parse(event.payload.from), Date.parse(event.payload.to)])
    .filter(([from, to]) => Number.isFinite(from) && Number.isFinite(to));
}

/** The checkout a folder is in, if any, among the repository's own. */
function rootOf(roots, folder) {
  if (typeof folder !== 'string' || !path.isAbsolute(folder)) return null;
  const target = path.resolve(folder);
  for (const root of roots) {
    const rel = path.relative(root, target);
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return { root, rel: rel.split(path.sep).join('/') || '.' };
  }
  return null;
}

/** Every transcript key already in this repository's record, from any session. */
function recordedKeys(commonDir) {
  const dir = path.join(storeDir(commonDir), 'raw', TOOL);
  const keys = new Set();
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith('.jsonl'));
  } catch {
    return keys;
  }
  for (const name of names) {
    for (const event of readEvents(path.join(dir, name))) {
      if (event.payload && typeof event.payload.transcript_uuid === 'string') keys.add(event.payload.transcript_uuid);
    }
  }
  return keys;
}

const add = (counts, key, n = 1) => {
  if (n) counts[key] = (counts[key] || 0) + n;
};

/**
 * Imports, or with dryRun only counts, the sessions of this repository's transcripts.
 *
 * @returns {{ sessions: Array<{ sessionId: string, kind: string, events: number, skipped: Record<string, number>, status: 'imported' | 'grown' | 'unchanged' | 'captured' | 'empty' }>, damaged: number, left: Record<string, number>, byType: Record<string, number> }}
 */
function importSessions({ location, state, dryRun = false, sessionFilter = null, now = new Date(), env = process.env }) {
  const { buildCapturedEvent } = require('../hook/run.js');
  const adapter = require('../adapters/claude-code.js');
  const home = os.homedir();
  const roots = [...new Set(checkouts(location).flatMap((root) => {
    try {
      return [root, fs.realpathSync.native(root)];
    } catch {
      return [root];
    }
  }))];
  const linked = new Set(checkouts(location).slice(1));
  const pauses = pausesOf(location.commonDir, state.machine);
  const paused = (ms) => pauses.some(([from, to]) => ms >= from && ms <= to);
  // A folder inside the repository that belongs to a nested repository is not this one's,
  // as on the capture path. A folder deleted since resolves to this repository.
  const owned = new Map();
  const placeOf = (cwd) => {
    if (owned.has(cwd)) return owned.get(cwd);
    let place = rootOf(roots, cwd);
    if (place) {
      const found = locateRepo(cwd);
      if (found && !samePath(found.commonDir, location.commonDir)) place = null;
    }
    owned.set(cwd, place);
    return place;
  };
  // Keys from every session, kept up to date as this run goes: a forked session repeats
  // its parent's records, and a record must enter the record once.
  const seen = recordedKeys(location.commonDir);

  const sessions = [];
  const left = {};
  const byType = {};
  let damaged = 0;
  for (const transcript of findTranscripts(location, { env })) {
    if (sessionFilter && transcript.sessionId !== sessionFilter) continue;
    const file = rawFilePath(location.commonDir, TOOL, transcript.sessionId, state.machine);
    const existing = readEvents(file);
    const session = { sessionId: transcript.sessionId, kind: transcript.kind, events: 0, skipped: {}, status: 'empty' };
    sessions.push(session);
    // Imported and live events never mix in one file.
    if (existing.some((event) => event.origin === 'hook')) {
      session.status = 'captured';
      continue;
    }
    const read = readTranscript(transcript.file);
    damaged += read.damaged;
    // Records from elsewhere, or written during a pause, are dropped before anything else
    // is read from them: only their cwd and time are looked at.
    const kept = [];
    for (const record of read.records) {
      const ms = Date.parse(record.timestamp);
      if (typeof record.cwd === 'string' && !placeOf(record.cwd)) add(left, 'outside');
      else if (Number.isFinite(ms) && paused(ms)) add(left, 'paused');
      else kept.push(record);
    }
    const { items, skipped } = toPayloads(kept, { sessionId: transcript.sessionId });
    for (const [key, n] of Object.entries(skipped)) add(byType, key, n);
    Object.assign(session.skipped, skipped);

    const fresh = [];
    for (const item of items) {
      const at = Date.parse(item.at);
      const place = typeof item.cwd === 'string' ? placeOf(item.cwd) : null;
      if (!place) add(left, 'outside');
      else if (!Number.isFinite(at)) add(left, 'no_time');
      else if (!seen.has(item.uuid)) {
        seen.add(item.uuid);
        fresh.push({ item, at, place });
      }
    }
    if (fresh.length === 0) {
      session.status = existing.some((event) => event.event_type === 'import') ? 'unchanged' : 'empty';
      continue;
    }
    session.status = existing.some((event) => event.event_type === 'import') ? 'grown' : 'imported';
    session.events = fresh.length;
    if (dryRun) continue;

    let lastGit = null;
    for (const { item, at, place } of fresh) {
      const git = {
        branch: item.gitBranch ?? null,
        head: null,
        worktree: place.rel,
        worktree_name: linked.has(place.root) ? path.basename(place.root) : null,
      };
      const raw = Buffer.from(JSON.stringify(item.payload));
      const event = buildCapturedEvent({
        payload: item.payload, raw, location, state, tool: TOOL, adapter, cwd: item.cwd, origin: 'imported', now: new Date(at), git,
        model: item.model, toolVersion: item.version,
      });
      if (!event) continue;
      appendLine(file, JSON.stringify(event));
      lastGit = git;
    }
    const marker = buildEvent(
      {
        eventType: 'import',
        actorType: 'user',
        agent: { name: 'main' },
        payload: {
          importer_version: IMPORTER_VERSION,
          transcript: maskHome(transcript.file, home),
          records_read: kept.length,
          events: fresh.length,
          skipped,
          imported_at: formatTimestamp(now),
        },
      },
      {
        tool: TOOL,
        sessionId: transcript.sessionId,
        actorName: state.actor_name,
        git: lastGit || readGit(location, location.worktreeRoot),
        sources: [],
        summary: `Imported ${fresh.length} events from the transcript`,
        origin: 'imported',
        now,
      },
    );
    appendLine(file, JSON.stringify(marker));
    require('../worker/seal.js').sealFile(file, { now });
    writeSessionMeta(location.commonDir, TOOL, transcript.sessionId, {
      ...(readSessionMeta(location.commonDir, TOOL, transcript.sessionId) || {}), closed_through: marker.event_id,
    });
  }
  return { sessions, damaged, left, byType };
}

const countOf = (sessions, ...statuses) => sessions.filter((s) => statuses.includes(s.status)).length;

function report(outcome, transcripts, dryRun, llm) {
  const lines = [];
  const kinds = (kind) => transcripts.filter((t) => t.kind === kind).length;
  lines.push(`Found ${transcripts.length} transcripts: ${kinds('repository')} in the repository, ${kinds('worktree')} in worktrees, ${kinds('subfolder')} in subfolders, ${kinds('ancestor')} in parent folders.`);
  const { sessions } = outcome;
  const brought = sessions.filter((s) => s.status === 'imported' || s.status === 'grown');
  const events = brought.reduce((sum, s) => sum + s.events, 0);
  if (brought.length === 0) lines.push('Nothing new to import.');
  else lines.push(`${dryRun ? 'Would import' : 'Imported'} ${brought.length} sessions (${events} events).`);
  const skippedLine = `Skipped: ${countOf(sessions, 'captured')} captured live, ${countOf(sessions, 'unchanged')} already imported, ${countOf(sessions, 'empty')} with nothing for this repository.`;
  lines[lines.length - 1] += ` ${skippedLine}`;
  const left = [];
  if (outcome.left.outside) left.push(`${outcome.left.outside} outside this repository`);
  if (outcome.left.paused) left.push(`${outcome.left.paused} while capture was paused`);
  if (outcome.left.no_time) left.push(`${outcome.left.no_time} with no time`);
  if (left.length) lines.push(`Records left out: ${left.join(', ')}.`);
  const types = Object.entries(outcome.byType).sort(([a], [b]) => a.localeCompare(b)).map(([key, n]) => `${key} ${n}`);
  if (types.length) lines.push(`Records skipped by type: ${types.join(', ')}.`);
  if (outcome.damaged) lines.push(`Damaged lines: ${outcome.damaged}.`);
  if (dryRun) lines.push('Dry run: nothing was written.');
  else if (brought.length && llm && llm.off) lines.push('LLM synthesis is off for you here, so imported sessions keep their chronicle only.');
  else if (llm && llm.sessions > 0) {
    lines.push(`${llm.sessions} imported sessions wait for LLM synthesis, about ${llm.runs} runs. Automatic synthesis leaves them alone; sync --llm runs them all at once, past the daily cap of ${llm.cap} runs. Run: product-decisions sync --llm`);
  }
  return lines.join('\n');
}

/** The import command. */
async function importCommand({ cwd, flags, env = process.env }) {
  if (flags.session !== null && flags.session !== undefined && (!flags.session || flags.session.startsWith('-'))) {
    throw new UsageError('--session needs a session id. Usage: product-decisions import [--dry-run] [--session <id>]');
  }
  const location = requireRepo(cwd);
  const state = readLocal(location.commonDir);
  if (!state || !state.activated) throw new UsageError('product-decisions is not active in this repository. Run: product-decisions init');
  if (state.paused) throw new UsageError('Capture is paused here. Run: product-decisions resume');
  if (!consentIsCurrent(state)) throw new UsageError('The consent text has changed. Run init to read and accept it before importing.');

  const transcripts = findTranscripts(location, { env }).filter((t) => !flags.session || t.sessionId === flags.session);
  const options = { location, state, dryRun: flags.dryRun, sessionFilter: flags.session || null, env };
  let outcome;
  if (flags.dryRun) outcome = importSessions(options);
  else {
    // The worker may be sealing or rendering: wait for it rather than race it.
    const { withLock } = require('../worker/queue.js');
    const locked = await withLock(location.commonDir, async () => {
      const result = importSessions(options);
      require('../worker/render.js').refreshFolder({ commonDir: location.commonDir });
      return result;
    });
    if (!locked.ran) throw new UsageError('The background worker is busy. Try again in a moment.');
    outcome = locked.value;
  }
  const llm = flags.dryRun ? null : await require('../worker/synthesis.js').importedBacklog(location.commonDir);
  console.log(report(outcome, transcripts, flags.dryRun, llm));
  return 0;
}

module.exports = { importSessions, importCommand };
