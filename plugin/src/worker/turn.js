'use strict';

// The work done at the end of each turn, in the detached worker.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { locateRepo, locateStore, samePath } = require('../core/locate.js');
const { readLocal, storeDir } = require('../core/state.js');
const { rawFilePath, appendLine, readSessionMeta, writeSessionMeta } = require('../core/store.js');
const { buildEvent } = require('../core/event.js');
const { readGit } = require('../core/githead.js');
const { redactString, redactValue, compileExtra } = require('../core/redact.js');
const { oneLine } = require('../core/text.js');
const { snapshot } = require('./snapshot.js');
const { resolveCommit, newCommits } = require('./commits.js');
const { readTranscriptTail, readTranscriptSince, transcriptEvents, addTokenTotals, subagentModel } = require('./enrich.js');
const { sealFile } = require('./seal.js');


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

const lastOf = (events, type) => {
  for (let i = events.length - 1; i >= 0; i -= 1) if (events[i].event_type === type) return events[i];
  return null;
};

const isCaptured = (e) => e.origin !== 'derived' && e.event_type !== 'seal';

/**
 * A session whose last end was processed, with nothing captured after it: nothing may be
 * added to it. A resumed session captures again after its end, so it is not finished.
 */
function isFinished(events) {
  let end = -1;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i].event_type === 'session_end') {
      end = i;
      break;
    }
  }
  if (end < 0) return false;
  const after = events.slice(end + 1);
  return after.some((e) => e.event_type === 'seal') && !after.some(isCaptured);
}

/** The events since the last end that has captured events after it: a resumed part starts there. */
function currentPart(events) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i].event_type === 'session_end' && events.slice(i + 1).some(isCaptured)) return events.slice(i + 1);
  }
  return events;
}

/** The last event the tool itself reported: work after it is not this session's. */
const lastCaptured = (events) => [...events].reverse().find((e) => e.origin !== 'derived' && e.event_type !== 'seal') || null;

/**
 * Runs the turn steps for one session: snapshot, commits, model, documents, seal,
 * render. Progress is read back from the record itself, so a run after a crash
 * writes no duplicates.
 */
async function runTurn(job, { commonDir, now = new Date() }) {
  const state = readLocal(commonDir);
  if (!state || !state.activated || state.paused) return;
  const file = rawFilePath(commonDir, job.tool, job.sessionId, state.machine);
  if (!fs.existsSync(file)) return;

  const events = readEvents(file);
  if (isFinished(events)) return;
  // Personal and project patterns, as on the capture path.
  const extra = compileExtra([...(state.redact_patterns || []), ...(require('../core/config.js').readConfig(commonDir).redact_patterns || [])]);
  const home = os.homedir();
  // Git runs only in the repository this store belongs to: a session that moved into
  // another repository gets no snapshot, commits, or document checks from it.
  const found = job.cwd && fs.existsSync(job.cwd) ? locateRepo(job.cwd) : null;
  const location = found && samePath(found.commonDir, commonDir) ? found : null;
  const git = location ? readGit(location, job.cwd) : null;
  const derive = (eventType, payload, summary) => appendLine(file, JSON.stringify(buildEvent(
    { eventType, actorType: 'plugin', agent: { name: 'main' }, payload },
    { tool: job.tool, sessionId: job.sessionId, actorName: null, git, sources: [], summary, origin: 'derived', now },
  )));

  writeSessionMeta(commonDir, job.tool, job.sessionId, {
    ...(readSessionMeta(commonDir, job.tool, job.sessionId) || {}),
    cwd: job.cwd || null,
    transcript_path: job.transcriptPath || null,
  });

  if (location) {
    const changes = snapshot({
      worktreeRoot: location.worktreeRoot, gitDir: location.gitDir, storeDir: storeDir(commonDir), last: lastOf(events, 'file_changes')?.payload.key,
    });
    if (changes) derive('file_changes', changes, `${changes.files.length} files changed`);

    const linked = new Set(events.filter((e) => e.event_type === 'commit_linked').map((e) => e.payload.sha));
    // A resumed part starts from its own HEAD: commits made while the session was closed are not its.
    const startHead = (currentPart(events).find((e) => isCaptured(e) && e.git && e.git.head) || events.find((e) => e.git && e.git.head))?.git.head;
    const since = resolveCommit(location.worktreeRoot, startHead);
    const until = lastCaptured(events)?.timestamp || null;
    for (const commit of newCommits({ worktreeRoot: location.worktreeRoot, sinceHead: since, until })) {
      if (linked.has(commit.sha)) continue;
      const subject = redactString(commit.subject, extra, home);
      derive('commit_linked', { sha: commit.sha, subject, files: commit.files }, `Commit ${commit.sha.slice(0, 7)}: ${oneLine(subject, 60)}`);
    }
  }

  // The transcript formats are tool-specific and unstable; only Claude Code's is read (CAP-13).
  const readsTranscript = job.tool === 'claude-code' && Boolean(job.transcriptPath);
  const tail = readsTranscript ? readTranscriptTail(job.transcriptPath) : null;
  if (tail && tail.model) {
    const meta = readSessionMeta(commonDir, job.tool, job.sessionId) || {};
    writeSessionMeta(commonDir, job.tool, job.sessionId, {
      ...meta, model: tail.model, model_source: 'transcript', tool_version: tail.toolVersion ?? null,
    });
    if (lastOf(events, 'model_usage')?.payload.model !== tail.model) {
      derive('model_usage', { model: tail.model, tool_version: tail.toolVersion ?? null }, `Model ${tail.model}`);
    }
  }

  if (readsTranscript) {
    const roots = [locateStore(commonDir, state)?.mainRoot, location && location.worktreeRoot].filter(Boolean);
    enrichFromTranscript({ job, commonDir, file, events: readEvents(file), state, extra, home, git, roots });
  }
  if (job.kind === 'close') {
    const through = lastCaptured(events);
    writeSessionMeta(commonDir, job.tool, job.sessionId, {
      ...(readSessionMeta(commonDir, job.tool, job.sessionId) || {}), closed_through: through ? through.event_id : null,
    });
    addTokenEvents({ job, commonDir, file, events: readEvents(file), git, now });
  }

  if (location) {
    const { checkDocuments } = require('./documents.js');
    const { readConfig } = require('../core/config.js');
    const { overlayDir } = require('./render.js');
    checkDocuments({ location, commonDir, config: readConfig(commonDir), state, job, events: readEvents(file), git, overlayDir: overlayDir(commonDir), now });
  }
  sealFile(file, { now });
  require('./render.js').refreshFolder({ commonDir });
}

const sameUsage = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function appendDerived(file, { eventType, actorType, agent, payload, summary }, { job, actorName, git, now }) {
  appendLine(file, JSON.stringify(buildEvent(
    { eventType, actorType, llmName: 'claude', agent, payload },
    { tool: job.tool, sessionId: job.sessionId, actorName, git, sources: [], summary, origin: 'derived', now },
  )));
}

/**
 * Best-effort enrichment from the transcript (PRD CAP-13): intermediate text, denials by
 * a person, token totals, and subagent models. Hooks stay the source of truth, and
 * every derived payload is redacted like a captured one.
 */
function enrichFromTranscript({ job, commonDir, file, events, state, extra, home, git, roots }) {
  const meta = readSessionMeta(commonDir, job.tool, job.sessionId) || {};
  let offset = Number.isInteger(meta.transcript_offset) ? meta.transcript_offset : 0;
  try {
    if (fs.statSync(job.transcriptPath).size < offset) offset = 0;
  } catch {
    return;
  }
  const read = readTranscriptSince(job.transcriptPath, offset);
  const records = capturable(read.records, { events, gaps: require('./render.js').gapsOf(commonDir, state.machine), roots });
  const { nextOffset } = read;
  const seenUuids = new Set(events.map((e) => e.payload && e.payload.transcript_uuid).filter(Boolean));
  const capturedTexts = new Set(events.filter((e) => e.event_type === 'agent_response' && e.origin !== 'derived')
    .map((e) => e.payload && e.payload.last_assistant_message).filter((x) => typeof x === 'string'));
  const normalize = (text) => redactString(text, extra, home);
  for (const found of transcriptEvents(records, { capturedTexts, seenUuids, normalize })) {
    const at = found.at && !Number.isNaN(Date.parse(found.at)) ? new Date(found.at) : new Date();
    appendDerived(file, { ...found, payload: redactValue(found.payload, extra, home), summary: redactString(found.summary, extra, home) },
      { job, actorName: found.actorType === 'user' ? state.actor_name : null, git, now: at });
  }
  const counted = new Set(offset === 0 ? [] : (meta.token_last_ids || []));
  const totals = addTokenTotals(offset === 0 ? {} : meta.token_totals, records, counted);

  const known = new Set(events.filter((e) => e.event_type === 'model_usage' && e.agent && e.agent.id).map((e) => e.agent.id));
  for (const stop of events.filter((e) => e.event_type === 'subagent_stop' && e.agent && e.agent.id && !known.has(e.agent.id))) {
    known.add(stop.agent.id);
    const model = subagentModel(job.transcriptPath, stop.agent.id);
    if (model) {
      appendDerived(file, { eventType: 'model_usage', actorType: 'plugin', agent: { name: stop.agent.name, id: stop.agent.id }, payload: { model, source: 'transcript' }, summary: `Model ${model} (subagent ${stop.agent.name})` },
        { job, actorName: null, git, now: new Date() });
    }
  }
  writeSessionMeta(commonDir, job.tool, job.sessionId, {
    ...(readSessionMeta(commonDir, job.tool, job.sessionId) || {}),
    transcript_offset: nextOffset, token_totals: totals, token_last_ids: [...counted].slice(-50),
  });
}

const within = (root, target) => {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/**
 * Only what capture itself would have recorded: nothing from before this session's first
 * captured event here (before activation, or before it reached this repository), nothing
 * written while capture was paused, and nothing done in another folder (PRD ACT-5, CAP-14).
 */
function capturable(records, { events, gaps, roots }) {
  const first = events.find(isCaptured);
  const start = first ? Date.parse(first.timestamp) : Infinity;
  const paused = gaps.map((g) => [Date.parse(g.from), Date.parse(g.to)]);
  return records.filter((record) => {
    const at = Date.parse(record.timestamp);
    if (!Number.isFinite(at) || at < start) return false;
    if (paused.some(([from, to]) => at >= from && at <= to)) return false;
    return typeof record.cwd !== 'string' || roots.some((root) => within(root, record.cwd));
  });
}

/** At close: one model_usage per model with the main agent's token totals so far. */
function addTokenEvents({ job, commonDir, file, events, git, now }) {
  const totals = (readSessionMeta(commonDir, job.tool, job.sessionId) || {}).token_totals || {};
  for (const model of Object.keys(totals).sort()) {
    const usage = totals[model];
    const previous = [...events].reverse().find((e) => e.event_type === 'model_usage' && e.payload && e.payload.model === model && e.payload.usage);
    if (previous && sameUsage(previous.payload.usage, usage)) continue;
    const input = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens;
    appendDerived(file, { eventType: 'model_usage', actorType: 'plugin', agent: { name: 'main' }, payload: { model, usage, source: 'transcript' }, summary: `Tokens for ${model}: ${input} in, ${usage.output_tokens} out` },
      { job, actorName: null, git, now });
  }
}

/**
 * Sessions on this machine whose last event is not a seal, as close jobs: they ended
 * without a SessionEnd hook, or their worker was killed.
 */
async function recoverSessions({ commonDir }) {
  const state = readLocal(commonDir);
  if (!state || !state.activated) return [];
  const raw = path.join(storeDir(commonDir), 'raw');
  const jobs = [];
  let tools = [];
  try {
    tools = fs.readdirSync(raw).filter((name) => name !== 'cli');
  } catch {
    return jobs;
  }
  const mainRoot = locateStore(commonDir, state)?.mainRoot || null;
  for (const tool of tools) {
    for (const name of fs.readdirSync(path.join(raw, tool)).filter((n) => n.endsWith(`-${state.machine}.jsonl`))) {
      const events = readEvents(path.join(raw, tool, name));
      const last = events[events.length - 1];
      if (!last || last.event_type === 'seal') continue;
      const meta = readSessionMeta(commonDir, tool, last.session_id) || {};
      jobs.push({ kind: 'close', tool, sessionId: last.session_id, cwd: meta.cwd || mainRoot, transcriptPath: meta.transcript_path || null });
    }
  }
  return jobs;
}

module.exports = { runTurn, recoverSessions, isFinished };
