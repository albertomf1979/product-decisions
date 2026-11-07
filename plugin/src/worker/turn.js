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
const { redactString, compileExtra } = require('../core/redact.js');
const { oneLine } = require('../core/text.js');
const { snapshot } = require('./snapshot.js');
const { resolveCommit, newCommits } = require('./commits.js');
const { readTranscriptTail } = require('./enrich.js');
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

/** A session that ended and was processed after its end: nothing may be added to it. */
function isFinished(events) {
  const end = events.findIndex((e) => e.event_type === 'session_end');
  return end >= 0 && events.slice(end + 1).some((e) => e.event_type === 'seal');
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
  const extra = compileExtra(state.redact_patterns);
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
    const startHead = events.find((e) => e.git && e.git.head)?.git.head;
    const since = resolveCommit(location.worktreeRoot, startHead);
    const until = lastCaptured(events)?.timestamp || null;
    for (const commit of newCommits({ worktreeRoot: location.worktreeRoot, sinceHead: since, until })) {
      if (linked.has(commit.sha)) continue;
      const subject = redactString(commit.subject, extra, home);
      derive('commit_linked', { sha: commit.sha, subject, files: commit.files }, `Commit ${commit.sha.slice(0, 7)}: ${oneLine(subject, 60)}`);
    }
  }

  const tail = job.transcriptPath ? readTranscriptTail(job.transcriptPath) : null;
  if (tail && tail.model) {
    const meta = readSessionMeta(commonDir, job.tool, job.sessionId) || {};
    writeSessionMeta(commonDir, job.tool, job.sessionId, {
      ...meta, model: tail.model, model_source: 'transcript', tool_version: tail.toolVersion ?? null,
    });
    if (lastOf(events, 'model_usage')?.payload.model !== tail.model) {
      derive('model_usage', { model: tail.model, tool_version: tail.toolVersion ?? null }, `Model ${tail.model}`);
    }
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

module.exports = { runTurn, recoverSessions };
