'use strict';

const fs = require('node:fs');

/**
 * Reads the model, tool version, and token usage from the end of a transcript. Both
 * vendors say the format is unstable (PRD CAP-13), so anything unexpected gives null.
 *
 * @returns {{ model: string | null, toolVersion: string | null, usage: object | null } | null}
 */
function readTranscriptTail(file, { maxBytes = 262144 } = {}) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const { size } = fs.fstatSync(fd);
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.toString('utf8').split('\n');
    if (length < size) lines.shift(); // the first line was cut by the window
    let model = null;
    let usage = null;
    let toolVersion = null;
    for (let i = lines.length - 1; i >= 0 && !(model && toolVersion); i -= 1) {
      let record;
      try {
        record = JSON.parse(lines[i]);
      } catch {
        continue;
      }
      const candidate = record && record.type === 'assistant' && record.message && record.message.model;
      // Claude Code writes "<synthetic>" for messages no model produced.
      if (!model && typeof candidate === 'string' && !candidate.startsWith('<')) {
        model = candidate;
        usage = record.message.usage || null;
      }
      if (!toolVersion && record && typeof record.version === 'string') toolVersion = record.version;
    }
    return model || toolVersion ? { model, toolVersion, usage } : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Reads the complete lines written after `offset`. A file shorter than the offset was
 * replaced, so it is read again from the start. Anything unreadable gives no records.
 *
 * @returns {{ records: object[], nextOffset: number }}
 */
function readTranscriptSince(file, offset = 0, { maxBytes = 4194304 } = {}) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const { size } = fs.fstatSync(fd);
    const start = Number.isInteger(offset) && offset >= 0 && offset <= size ? offset : 0;
    const length = Math.min(size - start, maxBytes);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, start);
    const end = buffer.lastIndexOf(0x0a);
    if (end < 0) return { records: [], nextOffset: start };
    const records = [];
    for (const line of buffer.subarray(0, end).toString('utf8').split('\n')) {
      try {
        const record = JSON.parse(line);
        if (record && typeof record === 'object') records.push(record);
      } catch {
        // A damaged line loses only itself.
      }
    }
    return { records, nextOffset: start + end + 1 };
  } catch {
    return { records: [], nextOffset: 0 };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

const MAX_TEXT = 16000;
const DENIAL = /doesn['’]t want to proceed|tool use was rejected/i;
const blocksOf = (record) => (record.message && Array.isArray(record.message.content) ? record.message.content : []);
const textOf = (content) => (typeof content === 'string' ? content
  : Array.isArray(content) ? content.map((c) => (c && typeof c.text === 'string' ? c.text : '')).join('\n') : '');
const keyOf = (record, extra) => record.uuid
  || require('node:crypto').createHash('sha256').update(`${record.timestamp}\n${extra}`).digest('hex').slice(0, 32);
const capped = (text) => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)} […]` : text);
const oneLine = (text, max) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/**
 * Turns transcript records into derived events: the main agent's intermediate text
 * (not its captured final response) and denials by a person. Thinking, subagent
 * (sidechain) records, and records already seen give nothing.
 *
 * @returns {Array<{ eventType: string, actorType: string, agent: object, payload: object, summary: string, at: string }>}
 */
function transcriptEvents(records, { capturedTexts = new Set(), seenUuids = new Set() } = {}) {
  const captured = new Set([...capturedTexts].map((x) => String(x).trim()));
  const out = [];
  for (const record of records) {
    if (!record || record.isSidechain) continue;
    const at = typeof record.timestamp === 'string' ? record.timestamp : null;
    if (record.type === 'assistant') {
      for (const block of blocksOf(record)) {
        if (!block || block.type !== 'text' || typeof block.text !== 'string') continue;
        const text = block.text.trim();
        if (!text || captured.has(text)) continue;
        const uuid = keyOf(record, text);
        if (seenUuids.has(uuid)) continue;
        out.push({
          eventType: 'agent_response', actorType: 'llm', agent: { name: 'main' }, at,
          payload: { last_assistant_message: capped(text), intermediate: true, source: 'transcript', transcript_uuid: uuid },
          summary: `Intermediate text: ${oneLine(text, 80)}`,
        });
      }
    } else if (record.type === 'user') {
      for (const block of blocksOf(record)) {
        if (!block || block.type !== 'tool_result' || !block.is_error || !DENIAL.test(textOf(block.content))) continue;
        const uuid = keyOf(record, String(block.tool_use_id));
        if (seenUuids.has(uuid)) continue;
        out.push({
          eventType: 'tool_denied', actorType: 'user', agent: { name: 'main' }, at,
          payload: { tool_use_id: typeof block.tool_use_id === 'string' ? block.tool_use_id : null, source: 'transcript', transcript_uuid: uuid },
          summary: 'Tool call denied (from the transcript)',
        });
      }
    }
  }
  return out;
}

/**
 * Adds the main agent's token usage to running totals, per model. Claude Code repeats a
 * message's usage on each of its content blocks, so each message id counts once.
 */
function addTokenTotals(totals, records, countedIds = new Set()) {
  const next = JSON.parse(JSON.stringify(totals || {}));
  for (const record of records) {
    const message = record && record.type === 'assistant' && !record.isSidechain ? record.message : null;
    if (!message || !message.usage || typeof message.model !== 'string' || message.model.startsWith('<')) continue;
    if (message.id && countedIds.has(message.id)) continue;
    if (message.id) countedIds.add(message.id);
    const sum = next[message.model] || { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    for (const key of Object.keys(sum)) sum[key] += Number.isFinite(message.usage[key]) ? message.usage[key] : 0;
    next[message.model] = sum;
  }
  return next;
}

/** @returns {string | null} The model a subagent ran on, from its meta file next to the transcript. */
function subagentModel(transcriptPath, agentId) {
  if (typeof agentId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(agentId) || typeof transcriptPath !== 'string') return null;
  const dir = transcriptPath.replace(/\.jsonl$/, '');
  try {
    const meta = JSON.parse(fs.readFileSync(require('node:path').join(dir, 'subagents', `agent-${agentId}.meta.json`), 'utf8'));
    const model = [meta.pickedEffortModel, meta.model].find((m) => typeof m === 'string' && m.length > 0 && m.length <= 100);
    return model || null;
  } catch {
    return null;
  }
}

module.exports = { readTranscriptTail, readTranscriptSince, transcriptEvents, addTokenTotals, subagentModel };
