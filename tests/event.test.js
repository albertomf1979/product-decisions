'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { newEventId, formatTimestamp, contentHash, buildEvent } = require('../plugin/src/core/event.js');

const normalized = (over = {}) => ({
  hookEvent: 'PostToolUse', eventType: 'tool_call', actorType: 'llm', llmName: 'claude',
  agent: { name: 'main' }, sessionId: 's1', cwd: '/p', transcriptPath: '/t.jsonl',
  toolName: 'Read', payload: { tool_name: 'Read' }, ...over,
});
const ctx = (over = {}) => ({
  tool: 'claude-code', sessionId: 's1', actorName: 'Ana', model: null, modelSource: null,
  git: { branch: 'main', head: 'abc', worktree: '.' }, sources: [], summary: 'Read a', ...over,
});

test('event ids are 26-character ULIDs', () => {
  assert.match(newEventId(), /^[0-9A-HJKMNP-TV-Z]{26}$/);
});

test('event ids are unique', () => {
  const ids = new Set(Array.from({ length: 2000 }, () => newEventId()));
  assert.equal(ids.size, 2000);
});

test('event ids sort by time', () => {
  assert(newEventId(1000) < newEventId(2000));
  assert(newEventId(1793873793661) < newEventId(1793873793662));
});

test('timestamps are ISO 8601 with a time zone offset', () => {
  assert.match(formatTimestamp(new Date()), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?([+-]\d\d:\d\d|Z)$/);
});

test('a formatted timestamp is the same instant', () => {
  const date = new Date('2026-11-05T09:42:17.123Z');
  assert.equal(new Date(formatTimestamp(date)).getTime(), date.getTime());
});

test('buildEvent emits every PRD 8.3 field and no phase field', () => {
  const event = buildEvent(normalized(), ctx());
  for (const field of ['schema_version', 'event_id', 'timestamp', 'tool', 'tool_version', 'session_id', 'origin',
    'actor', 'model', 'model_source', 'agent', 'event_type', 'summary', 'payload', 'sources', 'git', 'content_hash']) {
    assert(field in event, field);
  }
  assert.equal(event.schema_version, 1);
  assert.equal(event.origin, 'hook');
  assert.equal(event.event_type, 'tool_call');
  assert.equal(event.tool_version, null);
  assert(!('phase' in event));
});

test('contentHash survives a JSON round-trip', () => {
  const event = buildEvent(normalized(), ctx());
  assert.match(event.content_hash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(contentHash(JSON.parse(JSON.stringify(event))), event.content_hash);
});

test('contentHash changes when any field changes', () => {
  const event = buildEvent(normalized(), ctx());
  assert.notEqual(contentHash({ ...event, summary: 'changed' }), event.content_hash);
  assert.notEqual(contentHash({ ...event, payload: { tool_name: 'Edit' } }), event.content_hash);
});

test('actor uses the Git name for people, with no email', () => {
  const event = buildEvent(normalized({ actorType: 'user' }), ctx());
  assert.deepEqual(event.actor, { type: 'user', name: 'Ana' });
});

test('actor names the LLM and the subagent', () => {
  assert.deepEqual(buildEvent(normalized(), ctx()).actor, { type: 'llm', name: 'claude' });
  const sub = normalized({ actorType: 'subagent', agent: { name: 'reviewer', id: 'a1' } });
  assert.deepEqual(buildEvent(sub, ctx()).actor, { type: 'subagent', name: 'reviewer' });
});

test('origin and tool version can be set', () => {
  const event = buildEvent(normalized(), ctx({ origin: 'derived', toolVersion: '2.1.310' }));
  assert.equal(event.origin, 'derived');
  assert.equal(event.tool_version, '2.1.310');
});
