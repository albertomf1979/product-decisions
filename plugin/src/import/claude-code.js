'use strict';

// Reads Claude Code transcripts for `product-decisions import` (PRD 8.12). The transcript
// format is not a stable interface, so the reader is tolerant: what it does not know it
// skips and counts, and it never throws. Built from the record shapes of Claude Code
// 2.1.310.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const IMPORTER_VERSION = 1;

// The denial text Claude Code writes when a person rejects a tool call, as in M3.
const DENIAL = /doesn['’]t want to proceed|tool use was rejected/i;
const INTERRUPT = /^\[Request interrupted by user/;
// What a person runs outside the conversation: no hook ever sends it, so it is never a
// prompt. Bash mode (`!`) output and local command output may hold anything.
const BASH_MODE = /^\s*<bash-(?:input|stdout|stderr)>/;
const LOCAL_COMMAND = /^\s*<local-command-(?:stdout|stderr)>/;
const COMMAND_NAME = /<command-name>([\s\S]*?)<\/command-name>/;
const COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/;
// Context the tool attaches to a prompt, not the person's words.
const IDE_CONTEXT = /^\s*<ide_[a-z_]+>/;
const REMINDER = /^\s*<system-reminder>/;
const SYNTHETIC_MODEL = '<synthetic>';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const stringOr = (value, fallback = null) => (typeof value === 'string' ? value : fallback);
const textOf = (content) => (typeof content === 'string' ? content
  : Array.isArray(content) ? content.map((c) => (c && typeof c.text === 'string' ? c.text : '')).filter(Boolean).join('\n') : '');

/**
 * Reads a transcript, one record per line. Damaged lines are counted, never fatal.
 *
 * @returns {{ records: object[], damaged: number }}
 */
function readTranscript(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { records: [], damaged: 0 };
  }
  const records = [];
  let damaged = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      damaged += 1;
      continue;
    }
    if (isObject(record)) records.push(record);
    else damaged += 1;
  }
  return { records, damaged };
}

/**
 * Turns transcript records into the hook payloads Claude Code would have sent, in order.
 * Only the main agent's own records count: thinking, injected (isMeta), subagent
 * (sidechain), and system records are skipped, as is anything unknown, and each is
 * counted by type.
 *
 * @returns {{ items: Array<{ payload: object, at: string | null, uuid: string, cwd: string | null, gitBranch: string | null, model: string | null, version: string | null }>, skipped: Record<string, number> }}
 */
function toPayloads(records, { sessionId }) {
  const items = [];
  const skipped = {};
  const count = (key) => {
    skipped[key] = (skipped[key] || 0) + 1;
  };
  const calls = new Map();
  let turnStops = [];
  let compactTrigger = null;
  // The model of the turn: a prompt before the first response takes the session's first.
  const modelOf = (record) => {
    const model = isObject(record) && record.type === 'assistant' && !record.isSidechain && isObject(record.message) ? record.message.model : null;
    return typeof model === 'string' && model && model !== SYNTHETIC_MODEL ? model : null;
  };
  const list = Array.isArray(records) ? records : [];
  let model = list.map(modelOf).find(Boolean) || null;
  let version = list.map((record) => (isObject(record) ? stringOr(record.version) : null)).find(Boolean) || null;

  // The last text before the next prompt is the turn's response; the rest is intermediate.
  const closeTurn = () => {
    const last = turnStops[turnStops.length - 1];
    if (last !== undefined) delete items[last].payload.intermediate;
    turnStops = [];
  };

  for (const record of list) {
    if (!isObject(record)) {
      count('record:malformed');
      continue;
    }
    const type = stringOr(record.type, 'unknown');
    if (type === 'system') {
      if (record.subtype === 'compact_boundary' && isObject(record.compactMetadata)) compactTrigger = stringOr(record.compactMetadata.trigger);
      count(`system:${stringOr(record.subtype, 'unknown')}`);
      continue;
    }
    if (type !== 'user' && type !== 'assistant') {
      count(`record:${type}`);
      continue;
    }
    if (record.isSidechain) {
      count('sidechain');
      continue;
    }
    if (record.isMeta) {
      count('meta');
      continue;
    }
    const message = isObject(record.message) ? record.message : null;
    const content = message ? message.content : undefined;
    if (typeof content !== 'string' && !Array.isArray(content)) {
      count('malformed');
      continue;
    }

    model = modelOf(record) || model;
    version = stringOr(record.version) || version;
    const cwd = stringOr(record.cwd);
    const base = stringOr(record.uuid) || crypto.createHash('sha256').update(JSON.stringify(record)).digest('hex').slice(0, 32);
    let made = 0;
    const emit = (hookEvent, fields) => {
      const uuid = made === 0 ? base : `${base}:${made}`;
      made += 1;
      items.push({
        payload: { session_id: sessionId, cwd, hook_event_name: hookEvent, ...fields, transcript_uuid: uuid, imported: true },
        at: stringOr(record.timestamp),
        uuid,
        cwd,
        gitBranch: stringOr(record.gitBranch),
        model,
        version,
      });
      return items.length - 1;
    };

    if (type === 'assistant') {
      const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : content;
      for (const block of blocks) {
        if (!isObject(block)) continue;
        if (block.type === 'thinking' || block.type === 'redacted_thinking') count('thinking');
        else if (block.type === 'text') {
          if (typeof block.text === 'string' && block.text.trim()) turnStops.push(emit('Stop', { last_assistant_message: block.text, intermediate: true }));
        } else if (block.type === 'tool_use') {
          if (typeof block.id === 'string') calls.set(block.id, { name: stringOr(block.name, 'unknown'), input: block.input ?? null });
        } else count(`block:${stringOr(block.type, 'unknown')}`);
      }
      continue;
    }

    // A user record carries either tool results or a prompt.
    const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : content;
    const results = blocks.filter((block) => isObject(block) && block.type === 'tool_result');
    if (results.length) {
      const structured = results.length === 1 && isObject(record.toolUseResult) ? record.toolUseResult : null;
      for (const block of blocks) {
        if (!isObject(block)) continue;
        if (block.type !== 'tool_result') {
          if (block.type === 'text' && INTERRUPT.test(stringOr(block.text, ''))) count('interrupt');
          else count(`block:${stringOr(block.type, 'unknown')}`);
          continue;
        }
        const call = typeof block.tool_use_id === 'string' ? calls.get(block.tool_use_id) : undefined;
        if (!call) {
          count('orphan_result');
          continue;
        }
        calls.delete(block.tool_use_id);
        const text = textOf(block.content);
        const tool = { tool_name: call.name, tool_input: call.input, tool_use_id: block.tool_use_id };
        if (block.is_error && DENIAL.test(text)) emit('PermissionDenied', { ...tool, reason: 'user' });
        else if (block.is_error) emit('PostToolUseFailure', { ...tool, error: text });
        else emit('PostToolUse', { ...tool, tool_response: structured || text });
      }
      continue;
    }

    for (const block of blocks) if (isObject(block) && block.type !== 'text') count(`block:${stringOr(block.type, 'unknown')}`);
    const texts = blocks.filter((block) => {
      if (!isObject(block) || block.type !== 'text') return false;
      if (typeof content === 'string') return true;
      if (IDE_CONTEXT.test(stringOr(block.text, ''))) count('ide_context');
      else if (REMINDER.test(stringOr(block.text, ''))) count('reminder');
      else return true;
      return false;
    });
    const text = textOf(texts);
    if (!text.trim()) {
      if (texts.length || !blocks.some((block) => isObject(block) && block.type === 'text')) count('malformed');
      continue;
    }
    const command = COMMAND_NAME.exec(text);
    if (record.isCompactSummary) {
      emit('PostCompact', { trigger: compactTrigger || 'auto', compact_summary: text });
      compactTrigger = null;
    } else if (INTERRUPT.test(text)) count('interrupt');
    else if (BASH_MODE.test(text)) count('bash_mode');
    else if (LOCAL_COMMAND.test(text)) count('local_command');
    else if (command) {
      // A command is the person's prompt only through its arguments: /review the login page.
      const args = (COMMAND_ARGS.exec(text) || [])[1];
      if (args && args.trim()) {
        closeTurn();
        emit('UserPromptSubmit', { prompt: `${command[1].trim()} ${args.trim()}` });
      } else count('command');
    } else {
      closeTurn();
      emit('UserPromptSubmit', { prompt: text });
    }
  }
  closeTurn();
  if (calls.size) skipped.unanswered_tool = calls.size;
  return { items, skipped };
}

/** The checkouts of a repository: the main one first, then each linked worktree. */
function checkouts(location) {
  const main = path.resolve(location.mainRoot);
  const found = [main];
  try {
    const { git } = require('../git/plumbing.js');
    const out = git(['worktree', 'list', '--porcelain'], { cwd: location.worktreeRoot, allowFail: true }).stdout.toString('utf8');
    for (const line of out.split('\n')) {
      if (line.startsWith('worktree ')) found.push(path.resolve(line.slice('worktree '.length)));
    }
  } catch {
    // Without Git, the main checkout is still known.
  }
  return [...new Set(found)];
}

/** Every parent of a folder, nearest first, up to and including home; never the filesystem root. */
function ancestors(folder, home) {
  const out = [];
  let dir = path.dirname(folder);
  const stop = path.resolve(home);
  const underHome = path.relative(stop, folder) !== '' && !path.relative(stop, folder).startsWith('..') && !path.isAbsolute(path.relative(stop, folder));
  while (dir !== path.dirname(dir)) {
    out.push(dir);
    if (underHome && dir === stop) break;
    dir = path.dirname(dir);
  }
  return out;
}

/**
 * The transcripts Claude Code kept for this repository: sessions opened in the main
 * checkout, in each worktree, in a folder below either (removed worktrees included), or
 * in a folder above the repository. The importer then filters every record by cwd.
 * Only file and folder names are read here. A folder below is known only by its encoded
 * name, so its `folder` is null.
 *
 * @returns {Array<{ file: string, sessionId: string, folder: string | null, kind: 'repository' | 'worktree' | 'subfolder' | 'ancestor' }>}
 */
function findTranscripts(location, { env = process.env } = {}) {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  const claudeHome = env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  const projects = path.join(claudeHome, 'projects');
  const encode = (folder) => folder.replace(/[^A-Za-z0-9]/g, '-');
  const [main, ...worktrees] = checkouts(location);
  const known = [
    { folder: main, kind: 'repository' },
    ...worktrees.map((folder) => ({ folder, kind: 'worktree' })),
  ];
  // The encoding is lossy, so a sibling such as repo-old matches too: harmless, since
  // nothing outside the repository survives the cwd filter.
  let below = [];
  try {
    const prefixes = known.map(({ folder }) => `${encode(folder)}-`);
    const taken = new Set(known.map(({ folder }) => encode(folder)));
    below = fs.readdirSync(projects, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !taken.has(entry.name) && prefixes.some((prefix) => entry.name.startsWith(prefix)))
      .map((entry) => entry.name).sort((a, b) => a.localeCompare(b));
  } catch {
    // No projects folder: nothing below either.
  }
  const folders = [
    ...known.map(({ folder, kind }) => ({ name: encode(folder), folder, kind })),
    ...below.map((name) => ({ name, folder: null, kind: 'subfolder' })),
    ...ancestors(main, home).map((folder) => ({ name: encode(folder), folder, kind: 'ancestor' })),
  ];
  const found = [];
  const listed = new Set();
  for (const { name, folder, kind } of folders) {
    if (listed.has(name)) continue;
    listed.add(name);
    const dir = path.join(projects, name);
    let names;
    try {
      names = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of names.filter((e) => e.isFile() && e.name.endsWith('.jsonl')).sort((a, b) => a.name.localeCompare(b.name))) {
      found.push({ file: path.join(dir, entry.name), sessionId: entry.name.slice(0, -'.jsonl'.length), folder, kind });
    }
  }
  return found;
}

module.exports = { IMPORTER_VERSION, readTranscript, toPayloads, findTranscripts, checkouts };
