'use strict';

const { locateRepo } = require('../core/locate.js');
const { readLocal, isCapturing } = require('../core/state.js');
const { MAX_PAYLOAD_BYTES } = require('../core/limits.js');

const ENVELOPE_WINDOW = 64 * 1024;
const ENVELOPE_FIELDS = ['session_id', 'cwd', 'transcript_path', 'hook_event_name', 'tool_name', 'agent_id', 'agent_type'];

function loadAdapter(tool) {
  if (tool === 'claude-code') return require('../adapters/claude-code.js');
  if (tool === 'codex') return require('../adapters/codex.js');
  return null;
}

/** Replaces the payload with what may be stored: secret files hashed, secrets redacted. */
function sanitize(normalized, raw, state, commonDir) {
  const { redactValue, protectSecretFiles, compileExtra, oversizedPayload } = require('../core/redact.js');
  const home = require('node:os').homedir();
  const oversized = oversizedPayload(raw);
  // An imported record keeps its key, so a second import still recognizes it.
  if (oversized && typeof normalized.payload.transcript_uuid === 'string') {
    return { ...oversized, transcript_uuid: normalized.payload.transcript_uuid, imported: true };
  }
  return oversized
    || redactValue(
      protectSecretFiles(normalized.payload, state.salt),
      compileExtra([...(state.redact_patterns || []), ...require('../core/config.js').readConfig(commonDir).redact_patterns]),
      home,
    );
}

/** A subagent's model is unknown here: assuming the main agent's would be a guess. */
function resolveModel(normalized, commonDir, tool) {
  const { readSessionMeta, writeSessionMeta } = require('../core/store.js');
  if (normalized.agent.id) return { model: null, modelSource: null, toolVersion: null };
  if (normalized.modelHint) {
    const { model, source } = normalized.modelHint;
    try {
      // Merge, and write only on a change: Codex reports the model on every event, and
      // the worker keeps its own fields in the same file.
      const meta = readSessionMeta(commonDir, tool, normalized.sessionId) || {};
      if (meta.model !== model || meta.model_source !== source) writeSessionMeta(commonDir, tool, normalized.sessionId, { ...meta, model, model_source: source });
    } catch (err) {
      require('../core/diagnostics.js').logError(commonDir, 'session-meta', err);
    }
    return { model, modelSource: source, toolVersion: null };
  }
  const meta = readSessionMeta(commonDir, tool, normalized.sessionId);
  if (!meta) return { model: null, modelSource: null, toolVersion: null };
  return { model: meta.model ?? null, modelSource: meta.model_source ?? null, toolVersion: meta.tool_version ?? null };
}

/**
 * Builds the event a payload becomes: normalized, sanitized, home folder masked, model
 * resolved. It neither appends nor starts the worker. An imported event brings its own
 * time and git, and leaves the session meta alone: the transcript, not the hook, is its
 * source.
 *
 * @returns {object | null}
 */
function buildCapturedEvent({ payload, raw, location, state, tool, adapter, cwd, origin = 'hook', now, git, model: transcriptModel = null, toolVersion: transcriptVersion = null }) {
  const normalized = adapter.normalize(payload);
  if (!normalized) return null;

  const { readGit } = require('../core/githead.js');
  const { extractSources } = require('../core/sources.js');
  const { summarize } = require('../core/summary.js');
  const { buildEvent } = require('../core/event.js');

  normalized.payload = sanitize(normalized, raw, state, location.commonDir);
  // Masked like the payload, so paths inside it still read as relative to the session.
  const { maskHome } = require('../core/redact.js');
  const home = require('node:os').homedir();
  if (normalized.cwd) normalized.cwd = maskHome(normalized.cwd, home);
  if (normalized.transcriptPath) normalized.transcriptPath = maskHome(normalized.transcriptPath, home);
  const { model, modelSource, toolVersion } = origin === 'hook'
    ? resolveModel(normalized, location.commonDir, tool)
    : transcriptModel
      ? { model: transcriptModel, modelSource: 'transcript', toolVersion: transcriptVersion }
      : { model: normalized.modelHint ? normalized.modelHint.model : null, modelSource: normalized.modelHint ? normalized.modelHint.source : null, toolVersion: transcriptVersion };
  const gitState = git || readGit(location, payload.cwd || cwd);
  const event = buildEvent(normalized, {
    tool,
    toolVersion,
    sessionId: normalized.sessionId,
    actorName: state.actor_name,
    model,
    modelSource,
    git: gitState,
    sources: extractSources(normalized, gitState),
    summary: summarize(normalized),
    origin,
    now,
  });
  return event;
}

/** The active path. These modules load only here, so inactive projects stay fast. */
function capture({ payload, raw, location, state, tool, adapter, cwd }) {
  const event = buildCapturedEvent({ payload, raw, location, state, tool, adapter, cwd });
  if (!event) return;
  const { rawFilePath, appendLine } = require('../core/store.js');
  const { logLatency } = require('../core/diagnostics.js');

  appendLine(rawFilePath(location.commonDir, tool, event.session_id, state.machine), JSON.stringify(event));

  // The worker does the heavy work. Failing to start it must never lose the event above.
  const { triggerFor } = require('../worker/trigger.js');
  const kind = triggerFor(event.event_type);
  if (kind) {
    try {
      const { enqueue } = require('../worker/queue.js');
      enqueue(location.commonDir, kind === 'recover' ? { kind } : {
        kind,
        tool,
        sessionId: event.session_id,
        cwd: payload.cwd || cwd,
        transcriptPath: payload.transcript_path || null,
      });
      require('../worker/trigger.js').startWorker(location.commonDir);
    } catch (err) {
      require('../core/diagnostics.js').logError(location.commonDir, 'trigger', err);
    }
  }
  // Measured from process start, so it includes Node's own startup.
  logLatency(location.commonDir, { tool, event: payload.hook_event_name, ms: performance.now(), bytes: raw.length });
}

/** Logs a failure, but only where capture is active: otherwise the project stays untouched. */
function report(err, location, cwd) {
  try {
    const where = location || locateRepo(cwd);
    if (where && isCapturing(readLocal(where.commonDir))) {
      require('../core/diagnostics.js').logError(where.commonDir, 'hook', err);
    }
  } catch {
    // Nothing more can be done, and nothing may surface.
  }
}

/**
 * Reads the envelope from the start of an oversized payload, without parsing the rest:
 * parsing can take far longer than a hook may. Hook payloads put these fields first.
 */
function readEnvelope(raw, hookEvent) {
  const text = raw.subarray(0, ENVELOPE_WINDOW).toString('utf8');
  const envelope = { hook_event_name: hookEvent };
  for (const field of ENVELOPE_FIELDS) {
    const match = new RegExp(`"${field}"\\s*:\\s*("(?:[^"\\\\]|\\\\.){0,4096}")`).exec(text);
    if (match) envelope[field] = JSON.parse(match[1]);
  }
  return envelope;
}

const activatedAt = (folder) => {
  const location = folder ? locateRepo(folder) : null;
  const state = location ? readLocal(location.commonDir) : null;
  return { location, state: state && state.activated ? state : null };
};

/**
 * Decides which repository an event belongs to (PRD CAP-14):
 * 1. the repository the session was opened in, if activated, paused or not, so it
 *    governs even after the session changes directory;
 * 2. otherwise the repository of the current folder, activated or not;
 * 3. only when the current folder is in no repository, the activated repository of a
 *    file the event touches. Checked last, because looking up paths costs time.
 */
function resolveRepo(adapter, payload, env, cwd) {
  const project = activatedAt(adapter.projectDir(env));
  if (project.state) return project;
  const current = activatedAt(payload.cwd || cwd);
  if (current.location) return current.state ? current : null;
  for (const file of adapter.pathsTouched(payload)) {
    const touched = activatedAt(file);
    if (touched.state) return touched;
  }
  return null;
}

/**
 * Handles one hook payload. Never throws.
 *
 * @param {{ raw: Buffer, tool: string, hookEvent?: string, cwd: string, env?: object }} input
 */
function handlePayload({ raw, tool, hookEvent, cwd, env = process.env }) {
  let location = null;
  try {
    const adapter = loadAdapter(tool);
    if (!adapter) return;
    const payload = raw.length > MAX_PAYLOAD_BYTES ? readEnvelope(raw, hookEvent) : JSON.parse(raw.toString('utf8'));
    const resolved = resolveRepo(adapter, payload, env, cwd);
    if (!resolved) return;
    location = resolved.location;
    if (!isCapturing(resolved.state)) return;
    capture({ payload, raw, location, state: resolved.state, tool, adapter, cwd });
  } catch (err) {
    report(err, location, cwd);
  }
}

module.exports = { handlePayload, buildCapturedEvent };
