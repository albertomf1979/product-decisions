'use strict';

// Tamper evidence for the raw record (PRD 8.4). Hooks never take part: the worker
// appends seal events, each chaining the lines since the previous seal.

const crypto = require('node:crypto');
const fs = require('node:fs');
const { buildEvent, contentHash } = require('../core/event.js');
const { appendLine } = require('../core/store.js');

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
const chainOf = (previous, hashes) => sha256([previous, ...hashes].join('\n'));

/** Complete lines only: a line still being written has no newline yet. */
function readRecord(file) {
  const text = fs.readFileSync(file, 'utf8');
  const parts = text.split('\n');
  const torn = parts.pop() !== '';
  return { lines: parts, torn };
}

const tryParse = (line) => {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
};

/**
 * Appends a seal covering every complete line since the previous seal.
 *
 * @returns {object | null} The seal event, or null when there is nothing new.
 */
function sealFile(file, { now = new Date() } = {}) {
  // Walk the file as verify does: a hook may have appended lines after the last sealed
  // event but before the seal itself, and those still need sealing.
  let previous = null;
  let covered = [];
  for (const event of readRecord(file).lines.map(tryParse).filter(Boolean)) {
    if (event.event_type !== 'seal') {
      covered.push(event);
      continue;
    }
    const through = covered.findIndex((entry) => entry.event_id === event.payload.through_event_id);
    covered = covered.slice(through + 1);
    previous = event;
  }
  if (covered.length === 0) return null;

  const last = covered[covered.length - 1];
  const seal = buildEvent(
    {
      eventType: 'seal',
      actorType: 'plugin',
      agent: { name: 'main' },
      payload: {
        through_event_id: last.event_id,
        count: covered.length,
        chain: chainOf(previous ? previous.payload.chain : '', covered.map((event) => event.content_hash)),
        previous: previous ? previous.event_id : null,
      },
    },
    {
      tool: last.tool,
      toolVersion: last.tool_version ?? null,
      sessionId: last.session_id,
      actorName: null,
      git: last.git ?? null,
      sources: [],
      summary: `Sealed ${covered.length} events`,
      origin: 'derived',
      now,
    },
  );
  appendLine(file, JSON.stringify(seal));
  return seal;
}

/**
 * Checks every hash and seal in one session file.
 *
 * @returns {{ sealed: number, unsealed: number, imported: number, problems: Array<{ line: number, kind: string, detail?: string }> }}
 */
function verifyFile(file) {
  const { lines, torn } = readRecord(file);
  const problems = [];
  let pending = [];
  let previousChain = '';
  let previousSeal = null;
  let sealed = 0;
  let imported = 0;

  lines.forEach((text, i) => {
    const line = i + 1;
    if (text === '') return;
    const event = tryParse(text);
    if (!event) {
      problems.push({ line, kind: 'unparsable' });
      return;
    }
    if (contentHash(event) !== event.content_hash) problems.push({ line, kind: 'altered' });
    if (event.origin === 'imported') imported += 1;
    if (event.event_type !== 'seal') {
      pending.push({ line, id: event.event_id, hash: event.content_hash });
      return;
    }

    const seal = event.payload || {};
    if ((seal.previous ?? null) !== previousSeal) {
      problems.push({ line, kind: 'broken_chain', detail: 'previous seal does not match' });
    }
    const through = pending.findIndex((entry) => entry.id === seal.through_event_id);
    if (through < 0) {
      problems.push({ line, kind: 'removed', detail: 'the last sealed event is missing' });
    } else {
      const covered = pending.slice(0, through + 1);
      if (covered.length !== seal.count) {
        problems.push({ line, kind: 'removed', detail: `${seal.count} events sealed, ${covered.length} found` });
      } else if (chainOf(previousChain, covered.map((entry) => entry.hash)) !== seal.chain) {
        // Event ids sort by time, so ids out of order point at moved lines.
        const reordered = covered.some((entry, k) => k > 0 && entry.id < covered[k - 1].id);
        problems.push({ line, kind: reordered ? 'reordered' : 'broken_chain', detail: 'chain does not match' });
      }
      sealed += covered.length;
      pending = pending.slice(through + 1);
    }
    previousChain = seal.chain;
    previousSeal = event.event_id;
  });

  return { sealed, unsealed: pending.length + (torn ? 1 : 0), imported, problems };
}

module.exports = { sealFile, verifyFile };
