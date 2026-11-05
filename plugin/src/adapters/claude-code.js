'use strict';

const EVENT_TYPES = {
  SessionStart: 'session_start',
  SessionEnd: 'session_end',
  UserPromptSubmit: 'user_prompt',
  PostToolUse: 'tool_call',
  PostToolUseFailure: 'tool_failure',
  PermissionDenied: 'tool_denied',
  SubagentStart: 'subagent_start',
  SubagentStop: 'subagent_stop',
  Stop: 'agent_response',
  StopFailure: 'turn_failure',
  PreCompact: 'compaction',
  PostCompact: 'compaction',
  PostModelSwitch: 'model_change',
};

const USER_EVENTS = new Set(['SessionStart', 'SessionEnd', 'UserPromptSubmit']);

// These describe where the event happened and become top-level event fields.
const ENVELOPE = new Set([
  'session_id', 'cwd', 'hook_event_name', 'transcript_path', 'agent_id', 'agent_type', 'scratchpad_dir',
]);

function agentOf(payload) {
  // Only agent_id marks a subagent: agent_type also appears on a configured main agent.
  if (payload.agent_id) return { name: payload.agent_type || 'subagent', id: payload.agent_id };
  return payload.agent_type ? { name: 'main', type: payload.agent_type } : { name: 'main' };
}

function mcpOf(payload) {
  const parts = /^mcp__(.+?)__(.+)$/.exec(payload.tool_name || '');
  if (!parts) return undefined;
  return { server: (payload.mcp_server && payload.mcp_server.name) || parts[1], tool: parts[2] };
}

function modelHintOf(payload) {
  const event = payload.hook_event_name;
  if (event === 'SessionStart' && payload.model) return { model: payload.model, source: 'session_start' };
  if (event === 'PostModelSwitch' && payload.to_model) return { model: payload.to_model, source: 'model_switch' };
  return undefined;
}

/**
 * Turns a Claude Code hook payload into a tool-agnostic event description.
 *
 * @typedef {Object} NormalizedEvent
 * @property {string} hookEvent
 * @property {string} eventType
 * @property {'user' | 'llm' | 'subagent'} actorType
 * @property {string} llmName
 * @property {{ name: string, id?: string, type?: string }} agent
 * @property {string} sessionId
 * @property {string} cwd
 * @property {string} transcriptPath
 * @property {string} [toolName]
 * @property {{ server: string, tool: string }} [mcp]
 * @property {{ model: string, source: string }} [modelHint]
 * @property {object} payload
 *
 * @param {any} payload
 * @returns {NormalizedEvent | null}
 */
function normalize(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const hookEvent = payload.hook_event_name;
  const eventType = EVENT_TYPES[hookEvent];
  if (!eventType) return null;

  const rest = Object.fromEntries(Object.entries(payload).filter(([key]) => !ENVELOPE.has(key)));
  if (eventType === 'compaction') rest.stage = hookEvent;

  const agent = agentOf(payload);
  const normalized = {
    hookEvent,
    eventType,
    actorType: USER_EVENTS.has(hookEvent) ? 'user' : (agent.id ? 'subagent' : 'llm'),
    llmName: 'claude',
    agent,
    sessionId: payload.session_id,
    cwd: payload.cwd,
    transcriptPath: payload.transcript_path,
    payload: rest,
  };
  if (payload.tool_name) normalized.toolName = payload.tool_name;
  const mcp = mcpOf(payload);
  if (mcp) normalized.mcp = mcp;
  const modelHint = modelHintOf(payload);
  if (modelHint) normalized.modelHint = modelHint;
  return normalized;
}

/**
 * The folder the session was opened in. Unlike the payload's cwd, it stays put when
 * the session changes directory.
 *
 * @returns {string | null}
 */
function projectDir(env) {
  return env.CLAUDE_PROJECT_DIR || null;
}

module.exports = { normalize, projectDir };
