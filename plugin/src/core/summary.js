'use strict';

const { relativeTo } = require('./paths.js');

const MAX = 80;
const oneLine = (text) => String(text).replace(/\s+/g, ' ').trim().slice(0, MAX);

/** The most telling field of a tool's input, whatever the tool is. */
function toolTarget(input, cwd) {
  if (!input || typeof input !== 'object') return '';
  const file = input.file_path || input.notebook_path || input.path;
  if (typeof file === 'string') return relativeTo(file, cwd);
  if (typeof input.url === 'string') return oneLine(input.url.replace(/^[a-z]+:\/\//i, ''));
  const text = input.query || input.command || input.cmd || input.description;
  return typeof text === 'string' ? oneLine(text) : '';
}

function toolLine(normalized) {
  if (normalized.mcp) return `MCP ${normalized.mcp.server}.${normalized.mcp.tool}`;
  const target = toolTarget(normalized.payload.tool_input, normalized.cwd);
  return target ? `${normalized.toolName} ${target}` : String(normalized.toolName);
}

/** @returns {string} A deterministic one-line description, built only from redacted content. */
function summarize(normalized) {
  const { eventType, payload, agent } = normalized;
  switch (eventType) {
    case 'tool_call': return toolLine(normalized);
    case 'tool_failure': return `Failed: ${toolLine(normalized)}`;
    case 'tool_denied': return `Denied: ${toolLine(normalized)}`;
    case 'user_prompt': return oneLine(payload.prompt ?? '');
    case 'agent_response': return oneLine(payload.last_assistant_message ?? '') || 'Turn ended';
    case 'turn_failure': return `Turn failed: ${payload.error}`;
    case 'session_start': return `Session started (${payload.source})`;
    case 'session_end': return `Session ended (${payload.reason})`;
    case 'subagent_start': return `Subagent started: ${agent.name}`;
    case 'subagent_stop': return `Subagent stopped: ${agent.name}`;
    case 'compaction': return `Compaction, ${payload.stage} (${payload.trigger})`;
    case 'model_change': return `Model changed to ${payload.to_model}`;
    default: return eventType;
  }
}

module.exports = { summarize };
