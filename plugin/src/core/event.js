'use strict';

const crypto = require('node:crypto');

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** @returns {string} A 26-character ULID: sortable by time, unique without coordination. */
function newEventId(nowMs = Date.now()) {
  let time = '';
  let rest = nowMs;
  for (let i = 0; i < 10; i += 1) {
    time = CROCKFORD[rest % 32] + time;
    rest = Math.floor(rest / 32);
  }
  let random = '';
  for (const byte of crypto.randomBytes(16)) random += CROCKFORD[byte % 32];
  return time + random;
}

const pad = (n) => String(n).padStart(2, '0');

/** @returns {string} ISO 8601 in local time, with the time zone offset. */
function formatTimestamp(date = new Date()) {
  const offset = -date.getTimezoneOffset();
  const local = new Date(date.getTime() + offset * 60000).toISOString().slice(0, -1);
  const abs = Math.abs(offset);
  return `${local}${offset >= 0 ? '+' : '-'}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** @returns {string} Hash of the event without its own `content_hash` field. */
function contentHash(event) {
  const { content_hash: _ignored, ...rest } = event;
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(rest)).digest('hex')}`;
}

function buildActor(normalized, ctx) {
  if (normalized.actorType === 'user') return { type: 'user', name: ctx.actorName };
  if (normalized.actorType === 'subagent') return { type: 'subagent', name: normalized.agent.name };
  return { type: 'llm', name: normalized.llmName };
}

/**
 * Builds a complete record from a normalized event (see the adapters).
 * The product phase is deliberately absent: it lives in separate annotations.
 */
function buildEvent(normalized, ctx) {
  const now = ctx.now || new Date();
  const event = {
    schema_version: 1,
    event_id: newEventId(now.getTime()),
    timestamp: formatTimestamp(now),
    tool: ctx.tool,
    tool_version: ctx.toolVersion ?? null,
    session_id: ctx.sessionId,
    origin: ctx.origin || 'hook',
    actor: buildActor(normalized, ctx),
    model: ctx.model ?? null,
    model_source: ctx.modelSource ?? null,
    agent: normalized.agent,
    event_type: normalized.eventType,
    summary: ctx.summary,
    payload: normalized.payload,
    sources: ctx.sources,
    git: ctx.git,
  };
  event.content_hash = contentHash(event);
  return event;
}

module.exports = { newEventId, formatTimestamp, contentHash, buildEvent };
