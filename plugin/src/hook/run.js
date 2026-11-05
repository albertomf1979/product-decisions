'use strict';

const { locateRepo } = require('../core/locate.js');
const { readLocal, isCapturing } = require('../core/state.js');

function loadAdapter(tool) {
  return tool === 'claude-code' ? require('../adapters/claude-code.js') : null;
}

/** Replaces the payload with what may be stored: secret files hashed, secrets redacted. */
function sanitize(normalized, raw, state) {
  const { redactValue, protectSecretFiles, compileExtra, oversizedPayload } = require('../core/redact.js');
  const oversized = oversizedPayload(raw);
  if (oversized) return oversized;

  const payload = { ...normalized.payload };
  if ('tool_input' in payload) {
    const safe = protectSecretFiles(normalized.toolName, payload.tool_input, payload.tool_response);
    payload.tool_input = safe.toolInput;
    if (safe.toolResponse !== undefined) payload.tool_response = safe.toolResponse;
  }
  return redactValue(payload, compileExtra(state.redact_patterns));
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
 * Handles one hook payload. Never throws.
 *
 * @param {{ raw: Buffer, tool: string, cwd: string }} input
 */
function handlePayload({ raw, tool, cwd }) {
  let location = null;
  try {
    const adapter = loadAdapter(tool);
    if (!adapter) return;
    const payload = JSON.parse(raw.toString('utf8'));
    location = locateRepo(payload.cwd || cwd);
    if (!location) return;
    const state = readLocal(location.commonDir);
    if (!isCapturing(state)) return;
    capture({ payload, raw, location, state, tool, adapter, cwd });
  } catch (err) {
    report(err, location, cwd);
  }
}

module.exports = { handlePayload };
