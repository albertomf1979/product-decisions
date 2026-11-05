'use strict';

const { locateRepo } = require('../core/locate.js');
const { readLocal, isCapturing } = require('../core/state.js');
const { MAX_PAYLOAD_BYTES } = require('../core/limits.js');

const ENVELOPE_WINDOW = 64 * 1024;
const ENVELOPE_FIELDS = ['session_id', 'cwd', 'transcript_path', 'hook_event_name', 'tool_name', 'agent_id', 'agent_type'];

function loadAdapter(tool) {
  return tool === 'claude-code' ? require('../adapters/claude-code.js') : null;
}

/** Replaces the payload with what may be stored: secret files hashed, secrets redacted. */
function sanitize(normalized, raw, state) {
  const { redactValue, protectSecretFiles, compileExtra, oversizedPayload } = require('../core/redact.js');
  return oversizedPayload(raw)
    || redactValue(protectSecretFiles(normalized.payload), compileExtra(state.redact_patterns));
}

/** A subagent's model is unknown here: assuming the main agent's would be a guess. */
function resolveModel(normalized, commonDir, tool) {
  const { readSessionMeta, writeSessionMeta } = require('../core/store.js');
  if (normalized.agent.id) return { model: null, modelSource: null };
  if (normalized.modelHint) {
    const { model, source } = normalized.modelHint;
    try {
      writeSessionMeta(commonDir, tool, normalized.sessionId, { model, model_source: source });
    } catch (err) {
      require('../core/diagnostics.js').logError(commonDir, 'session-meta', err);
    }
    return { model, modelSource: source };
  }
  const meta = readSessionMeta(commonDir, tool, normalized.sessionId);
  return meta ? { model: meta.model, modelSource: meta.model_source } : { model: null, modelSource: null };
}

/** The active path. These modules load only here, so inactive projects stay fast. */
function capture({ payload, raw, location, state, tool, adapter, cwd }) {
  const normalized = adapter.normalize(payload);
  if (!normalized) return;

  const { readGit } = require('../core/githead.js');
  const { extractSources } = require('../core/sources.js');
  const { summarize } = require('../core/summary.js');
  const { buildEvent } = require('../core/event.js');
  const { rawFilePath, appendLine } = require('../core/store.js');
  const { logLatency } = require('../core/diagnostics.js');

  normalized.payload = sanitize(normalized, raw, state);
  const { model, modelSource } = resolveModel(normalized, location.commonDir, tool);
  const git = readGit(location, payload.cwd || cwd);
  const event = buildEvent(normalized, {
    tool,
    sessionId: normalized.sessionId,
    actorName: state.actor_name,
    model,
    modelSource,
    git,
    sources: extractSources(normalized, git),
    summary: summarize(normalized),
  });

  appendLine(rawFilePath(location.commonDir, tool, normalized.sessionId, state.machine), JSON.stringify(event));
  // Measured from process start, so it includes Node's own startup.
  logLatency(location.commonDir, { tool, event: normalized.hookEvent, ms: performance.now(), bytes: raw.length });
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

/**
 * Decides which repository an event belongs to. The first activated repository wins,
 * paused or not: the one the session was opened in governs even after the session
 * changes directory, and the current folder serves sessions opened above a repository.
 */
function resolveRepo(folders) {
  for (const folder of folders) {
    const location = folder ? locateRepo(folder) : null;
    const state = location ? readLocal(location.commonDir) : null;
    if (state && state.activated) return { location, state };
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
    const resolved = resolveRepo([adapter.projectDir(env), payload.cwd || cwd]);
    if (!resolved) return;
    location = resolved.location;
    if (!isCapturing(resolved.state)) return;
    capture({ payload, raw, location, state: resolved.state, tool, adapter, cwd });
  } catch (err) {
    report(err, location, cwd);
  }
}

module.exports = { handlePayload };
