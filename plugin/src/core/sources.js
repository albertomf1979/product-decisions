'use strict';

const { relativeTo } = require('./paths.js');

const URL_PATTERN = /https?:\/\/[^\s"'<>)\]]+/g;
const SCAN_LIMIT = 64 * 1024;
const MAX_SOURCES = 50;
const WEB_TOOLS = new Set(['WebFetch', 'WebSearch']);

function classify(rawUrl) {
  // A loop, because the equivalent regex goes quadratic on URLs full of dots.
  let end = rawUrl.length;
  while (end > 0 && '.,;:!?'.includes(rawUrl[end - 1])) end -= 1;
  const url = rawUrl.slice(0, end);
  if (/github\.com\/[^/]+\/[^/]+\/issues\/\d+/.test(url)) return { type: 'issue', url };
  if (/github\.com\/[^/]+\/[^/]+\/pull\/\d+/.test(url)) return { type: 'pr', url };
  return { type: 'url', url };
}

/** Calls `visit` with every string inside a value. */
function eachString(value, visit) {
  if (typeof value === 'string') visit(value);
  else if (Array.isArray(value)) value.forEach((item) => eachString(item, visit));
  else if (value && typeof value === 'object') Object.values(value).forEach((item) => eachString(item, visit));
}

/**
 * Lists what an event referenced. Links are read only from prompts, final responses,
 * and MCP or web results: a URL inside a file the agent read is not a source it consulted.
 *
 * @returns {object[]} `file`, `url`, `mcp`, `issue`, `pr`, or `transcript` entries.
 */
function extractSources(normalized, git) {
  const { payload, eventType, toolName, mcp, cwd, transcriptPath } = normalized;
  const input = payload.tool_input && typeof payload.tool_input === 'object' ? payload.tool_input : {};
  const found = new Map();
  const add = (source) => {
    if (found.size < MAX_SOURCES) found.set(JSON.stringify(source), source);
  };
  const scan = (value) => eachString(value, (text) => {
    for (const match of text.slice(0, SCAN_LIMIT).match(URL_PATTERN) || []) add(classify(match));
  });

  if (eventType === 'session_start' && transcriptPath) {
    add({ type: 'transcript', path: transcriptPath, local_only: true });
  }
  const file = input.file_path || input.notebook_path || input.path;
  if (typeof file === 'string') add({ type: 'file', path: relativeTo(file, cwd), commit: git.head });
  if (mcp) add({ type: 'mcp', server: mcp.server, tool: mcp.tool });
  if (typeof input.url === 'string') add(classify(input.url));

  scan(payload.prompt);
  scan(payload.last_assistant_message);
  if (mcp || WEB_TOOLS.has(toolName)) scan(payload.tool_response);

  return [...found.values()];
}

module.exports = { extractSources };
