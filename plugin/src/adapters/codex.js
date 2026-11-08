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

const MAX_ROLLOUTS = 20;
const FIRST_LINE_BYTES = 64 * 1024;

function rollouts(dir) {
  const fs = require('node:fs');
  const found = [];
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/^rollout-.*\.jsonl$/.test(entry.name)) {
        try {
          found.push({ file: full, mtimeMs: fs.statSync(full).mtimeMs });
        } catch {
          // Gone meanwhile.
        }
      }
    }
  };
  walk(dir);
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, MAX_ROLLOUTS);
}

const CHUNK = 4096;
const CWD_FIELD = /"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/;

/**
 * The folder a rollout was started in. Reads in small chunks up to the end of the first
 * line (session_meta), never past it, and at most 64 KiB. A longer first line is not
 * parsed: its cwd field is found by pattern instead.
 */
function rolloutCwd(file) {
  const fs = require('node:fs');
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const chunks = [];
    let total = 0;
    let line = null;
    while (total < FIRST_LINE_BYTES) {
      const buffer = Buffer.alloc(Math.min(CHUNK, FIRST_LINE_BYTES - total));
      const read = fs.readSync(fd, buffer, 0, buffer.length, total);
      if (read === 0) break;
      const end = buffer.subarray(0, read).indexOf(0x0a);
      chunks.push(buffer.subarray(0, end < 0 ? read : end));
      total += read;
      if (end >= 0) {
        line = Buffer.concat(chunks).toString('utf8');
        break;
      }
    }
    if (line !== null) {
      const first = JSON.parse(line);
      const cwd = first && (first.payload ? first.payload.cwd : first.cwd);
      return typeof cwd === 'string' ? cwd : null;
    }
    const match = CWD_FIELD.exec(Buffer.concat(chunks).toString('utf8'));
    return match ? JSON.parse(`"${match[1]}"`) : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * When Codex last ran a session in this folder. Reads only the first line of the 20 most
 * recent rollout files: the rollout format "isn't a stable interface", so this is
 * pending review, and anything unexpected gives null.
 *
 * @returns {string | null}
 */
function latestSessionAt(folder, env = process.env) {
  const home = env.CODEX_HOME || path.join(require('node:os').homedir(), '.codex');
  const root = path.resolve(folder);
  for (const { file, mtimeMs } of rollouts(path.join(home, 'sessions'))) {
    const cwd = rolloutCwd(file);
    if (!cwd) continue;
    const rel = path.relative(root, path.resolve(cwd));
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return new Date(mtimeMs).toISOString();
  }
  return null;
}

module.exports = { normalize, projectDir, pathsTouched, latestSessionAt, EVENT_TYPES };
