'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readTranscriptSince, transcriptEvents, subagentModel } = require('../plugin/src/worker/enrich.js');

const FIXTURE = path.join(__dirname, 'fixtures', 'claude-code', 'transcript-enrich.jsonl');
const FINAL_TEXT = 'Done: the scope section is at the end of the PRD.';
const records = () => readTranscriptSince(FIXTURE, 0).records;

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-enrich-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('intermediate text becomes a derived agent_response, and the captured final response is not repeated', () => {
  const events = transcriptEvents(records(), { capturedTexts: new Set([FINAL_TEXT]), seenUuids: new Set() });
  const texts = events.filter((e) => e.eventType === 'agent_response');
  assert.deepEqual(texts.map((e) => e.payload.last_assistant_message), [
    'I will read the PRD first.',
    'The PRD has no scope section. I will add one after the summary.',
  ]);
  assert.ok(texts.every((e) => e.payload.intermediate === true && e.payload.source === 'transcript' && e.actorType === 'llm'));
  assert.ok(texts.every((e) => typeof e.payload.transcript_uuid === 'string' && e.at.endsWith('Z')));
  assert.match(texts[0].summary, /^Intermediate text: I will read the PRD first\.$/);
});

test('thinking blocks, sidechain records, and already seen uuids give nothing', () => {
  const all = transcriptEvents(records(), { capturedTexts: new Set([FINAL_TEXT]), seenUuids: new Set() });
  const text = JSON.stringify(all);
  assert.ok(!text.includes('Private reasoning'));
  assert.ok(!text.includes('Subagent text'));
  const seen = new Set(all.map((e) => e.payload.transcript_uuid));
  assert.deepEqual(transcriptEvents(records(), { capturedTexts: new Set([FINAL_TEXT]), seenUuids: seen }), []);
});

test('a denial by a person becomes a derived tool_denied with source transcript', () => {
  const denied = transcriptEvents(records(), { capturedTexts: new Set(), seenUuids: new Set() }).filter((e) => e.eventType === 'tool_denied');
  assert.equal(denied.length, 1);
  assert.equal(denied[0].payload.tool_use_id, 'toolu_02');
  assert.equal(denied[0].payload.source, 'transcript');
  assert.equal(denied[0].actorType, 'user');
});

test('readTranscriptSince reads only complete lines and resumes from its offset', (t) => {
  const file = path.join(tempDir(t), 't.jsonl');
  fs.writeFileSync(file, '{"type":"a","uuid":"1"}\n{"type":"b","uu');
  const first = readTranscriptSince(file, 0);
  assert.deepEqual(first.records.map((r) => r.type), ['a']);
  fs.appendFileSync(file, 'id":"2"}\n');
  const second = readTranscriptSince(file, first.nextOffset);
  assert.deepEqual(second.records.map((r) => r.type), ['b']);
  assert.equal(readTranscriptSince(file, second.nextOffset).records.length, 0);
  // A file shorter than the offset was replaced: read it again from the start.
  fs.writeFileSync(file, '{"type":"c"}\n');
  assert.deepEqual(readTranscriptSince(file, second.nextOffset).records.map((r) => r.type), ['c']);
  assert.deepEqual(readTranscriptSince(path.join(path.dirname(file), 'missing.jsonl'), 0), { records: [], nextOffset: 0 });
});

test('subagentModel reads pickedEffortModel, then model, from the subagent meta file', (t) => {
  assert.equal(subagentModel(FIXTURE, 'a0f1e2d3c4b5a6978'), 'claude-opus-5-5');
  assert.equal(subagentModel(FIXTURE, 'unknown'), null);
  assert.equal(subagentModel(FIXTURE, '../../etc'), null);
  const dir = tempDir(t);
  fs.mkdirSync(path.join(dir, 's', 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(dir, 's', 'subagents', 'agent-x1.meta.json'), '{"model":"haiku"}');
  assert.equal(subagentModel(path.join(dir, 's.jsonl'), 'x1'), 'haiku');
});
