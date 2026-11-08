'use strict';

// Turns a range of session events into bounded text for the model. Every event starts
// with its id in square brackets, which is what the model must cite (PRD LLM-5).

/** Event types the text includes. */
const INPUT_TYPES = new Set([
  'user_prompt', 'agent_response', 'tool_call', 'tool_failure', 'tool_denied', 'subagent_start', 'subagent_stop',
  'compaction', 'document_change', 'commit_linked', 'model_change', 'file_changes',
]);

const LONG = 8000;
const TOOL_PART = 1500;
const MAX_FILES = 50;
const CUT = ' […]';
const PART_LINE_RESERVE = 40;

const cut = (text, max) => (text.length > max ? `${text.slice(0, Math.max(0, max - CUT.length))}${CUT}` : text);
const asText = (value) => {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
};
// Reminders are tool scaffolding, not what the person said; payload lines must not look
// like event headers.
const clean = (text) => text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').replace(/^\[/gm, ' [').trim();

function bodyOf(event) {
  const p = event.payload || {};
  switch (event.event_type) {
    case 'user_prompt': return cut(clean(asText(p.prompt)), LONG);
    case 'agent_response':
    case 'subagent_stop': return cut(clean(asText(p.last_assistant_message)), LONG);
    case 'compaction': return cut(clean(asText(p.compact_summary)), LONG);
    case 'tool_call':
    case 'tool_failure': return [
      `tool: ${asText(p.tool_name) || event.summary}`,
      `input: ${cut(clean(asText(p.tool_input)), TOOL_PART)}`,
      `${event.event_type === 'tool_failure' ? 'error' : 'result'}: ${cut(clean(asText(p.tool_response ?? p.error)), TOOL_PART)}`,
    ].join('\n');
    case 'document_change': return `${asText(p.path)} ${asText(p.status)}`;
    case 'commit_linked': return `${asText(p.sha).slice(0, 7)} ${clean(asText(p.subject))}`;
    case 'file_changes': return `files: ${(Array.isArray(p.files) ? p.files : []).slice(0, MAX_FILES).map((f) => f && f.path).filter(Boolean).join(', ')}`;
    case 'model_change': return asText(p.to_model);
    case 'model_usage': return asText(p.model);
    default: return clean(asText(event.summary));
  }
}

/** @returns {string | null} The event as text, or null for events the model never sees. */
function formatEvent(event) {
  if (!event || event.event_type === 'seal') return null;
  const actor = event.actor || {};
  const head = `[${event.event_id}] ${event.timestamp} ${actor.type}:${actor.name} ${event.event_type}`;
  const body = bodyOf(event);
  return body ? `${head}\n${body}` : head;
}

/** Whether a range holds something a person or agent did, not only what the plugin added. */
const isWorthARun = (events) => events.some((e) => e && INPUT_TYPES.has(e.event_type) && e.origin !== 'derived');

/**
 * Packs the events into consecutive parts of at most `maxChars`, each starting with the
 * shared header. An event too large for a whole part is cut to fit, never dropped.
 *
 * @returns {Array<{ from: string, to: string, text: string }>}
 */
function buildChunks(events, { maxChars, header }) {
  const budget = maxChars - header.length - PART_LINE_RESERVE;
  const parts = [];
  let current = null;
  let lastModel = null;
  for (const event of events) {
    if (event && event.event_type === 'model_usage') {
      const model = event.payload && event.payload.model;
      if (model === lastModel) continue;
      lastModel = model;
    }
    const formatted = formatEvent(event);
    if (formatted === null) continue;
    const text = cut(formatted, budget);
    if (!current || current.size + text.length + 1 > budget) {
      current = { from: event.event_id, to: event.event_id, lines: [], size: 0 };
      parts.push(current);
    }
    current.lines.push(text);
    current.size += text.length + 1;
    current.to = event.event_id;
  }
  return parts.map((part, i) => ({
    from: part.from,
    to: part.to,
    text: `${header}\nPart ${i + 1} of ${parts.length}.\n\nEvents:\n${part.lines.join('\n')}`,
  }));
}

module.exports = { INPUT_TYPES, formatEvent, buildChunks, isWorthARun };
