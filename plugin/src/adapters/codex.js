'use strict';

// Codex CLI hook payloads → NormalizedEvent. Built from the Codex documentation of
// 2026-11-08 and Codex CLI 0.167.0 behaviour without a login (spike S5): pending review,
// since no real Codex session could be captured.

const path = require('node:path');

const EVENT_TYPES = {
  SessionStart: 'session_start',
  SessionEnd: 'session_end',
  UserPromptSubmit: 'user_prompt',
  PostToolUse: 'tool_call',
  SubagentStart: 'subagent_start',
  SubagentStop: 'subagent_stop',
  Stop: 'agent_response',
  Interrupt: 'interrupt',
  PreCompact: 'compaction',
  PostCompact: 'compaction',
  PostModelRequest: 'model_usage',
};

const USER_EVENTS = new Set(['SessionStart', 'SessionEnd', 'UserPromptSubmit']);
const SUBAGENT_EVENTS = new Set(['SubagentStart', 'SubagentStop']);

// Where the event happened: these become top-level fields. turn_id and permission_mode
// stay in the payload, as the turn's own facts.
const ENVELOPE = new Set(['session_id', 'cwd', 'hook_event_name', 'transcript_path', 'agent_id', 'agent_type', 'model']);

function agentOf(payload) {
  if (payload.agent_id) return { name: payload.agent_type || 'subagent', id: payload.agent_id };
  if (SUBAGENT_EVENTS.has(payload.hook_event_name)) return { name: payload.agent_type || 'unknown' };
  return { name: 'main' };
}

function mcpOf(payload) {
  const parts = /^mcp__(.+?)__(.+)$/.exec(typeof payload.tool_name === 'string' ? payload.tool_name : '');
  return parts ? { server: parts[1], tool: parts[2] } : undefined;
}

/**
 * @param {any} payload
 * @returns {import('./claude-code.js').NormalizedEvent | null}
 */
function normalize(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const hookEvent = payload.hook_event_name;
  // Own keys only: a name such as "constructor" must not reach the prototype.
  const eventType = Object.prototype.hasOwnProperty.call(EVENT_TYPES, hookEvent) ? EVENT_TYPES[hookEvent] : null;
  if (!eventType) return null;

  const rest = Object.fromEntries(Object.entries(payload).filter(([key]) => !ENVELOPE.has(key)));
  if (eventType === 'compaction') rest.stage = hookEvent;
  // The chronicle reads the model of a model_usage event from its payload.
  if (eventType === 'model_usage' && typeof payload.model === 'string') rest.model = payload.model;

  const agent = agentOf(payload);
  const normalized = {
    hookEvent,
    eventType,
    actorType: USER_EVENTS.has(hookEvent) ? 'user' : (agent.id || SUBAGENT_EVENTS.has(hookEvent) ? 'subagent' : 'llm'),
    llmName: 'codex',
    agent,
    sessionId: payload.session_id,
    cwd: payload.cwd,
    transcriptPath: typeof payload.transcript_path === 'string' ? payload.transcript_path : null,
    payload: rest,
  };
  if (typeof payload.tool_name === 'string') normalized.toolName = payload.tool_name;
  const mcp = mcpOf(payload);
  if (mcp) normalized.mcp = mcp;
  // Codex reports the model on every event.
  if (typeof payload.model === 'string' && payload.model) normalized.modelHint = { model: payload.model, source: 'hook' };
  return normalized;
}

/** Codex has no variable for the folder a session was opened in: its cwd decides. */
function projectDir() {
  return null;
}

const PATCH_HEADER = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm;

/**
 * Absolute paths a tool event names: path fields, a shell's working folder, and the file
 * headers of an apply_patch input (CAP-14).
 *
 * @returns {string[]}
 */
function pathsTouched(payload) {
  if (!payload || typeof payload !== 'object') return [];
  const input = payload.tool_input;
  const base = typeof payload.cwd === 'string' ? payload.cwd : process.cwd();
  const found = [];
  if (input && typeof input === 'object') {
    for (const value of [input.path, input.file_path, input.workdir]) if (typeof value === 'string' && value) found.push(value);
  }
  const patch = typeof input === 'string' ? input : input && typeof input.input === 'string' ? input.input : null;
  if (patch) for (const match of patch.matchAll(PATCH_HEADER)) found.push(match[1].trim());
  return [...new Set(found.map((value) => path.resolve(base, value)))];
}

/** When Codex last ran a session in this folder. Task 5 of M4 fills this in. */
function latestSessionAt() {
  return null;
}

module.exports = { normalize, projectDir, pathsTouched, latestSessionAt, EVENT_TYPES };
