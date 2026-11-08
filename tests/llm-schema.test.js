'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { OUTPUT_SCHEMA, PHASES, checkOutput } = require('../plugin/src/synth/llm/schema.js');

const promptId = '01KAAAAAAAAAAAAAAAAAAA0001';
const responseId = '01KAAAAAAAAAAAAAAAAAAA0002';
const laterPromptId = '01KAAAAAAAAAAAAAAAAAAA0003';
const events = [
  { event_id: promptId, actor: { type: 'user', name: 'Test Person' }, event_type: 'user_prompt' },
  { event_id: responseId, actor: { type: 'llm', name: 'claude' }, event_type: 'agent_response' },
  { event_id: laterPromptId, actor: { type: 'user', name: 'Second Person' }, event_type: 'user_prompt' },
];
const existing = 'ADR-20261101-abcdef';
const ctx = { events, existingIds: new Set([existing]) };
const good = (over = {}) => ({
  title: 'Keep the raw record outside the working tree', decided_by: 'user', context: 'c', decision: 'd',
  alternatives: ['a branch'], consequences: 'q', evidence: [promptId], related: [], supersedes: [], ...over,
});
const note = (over = {}) => ({ phase: 'design', title: 'Flows', summary: 's', evidence: [responseId], ...over });

test('a decision citing real events of this session passes, with the name taken from the record', () => {
  const { decisions, rejected } = checkOutput({ decisions: [good({ decided_by: 'user', evidence: [laterPromptId, promptId] })], phase_notes: [] }, ctx);
  assert.equal(rejected.length, 0);
  assert.deepEqual(decisions[0].decided_by, { type: 'user', name: 'Test Person' });
  assert.deepEqual(decisions[0].evidence, [laterPromptId, promptId]);
});

test('one unknown id rejects the whole item, and the others still pass', () => {
  const out = checkOutput({ decisions: [good({ evidence: [promptId, '01JZZZZZZZZZZZZZZZZZZZZZZZ'] }), good()], phase_notes: [] }, ctx);
  assert.equal(out.decisions.length, 1);
  assert.deepEqual(out.rejected, [{ kind: 'decision', reason: 'unknown_evidence' }]);
});

test('no evidence, an attribution the evidence does not show, or an unknown phase are rejected', () => {
  const out = checkOutput({
    decisions: [good({ evidence: [] }), good({ decided_by: 'subagent' }), good({ decided_by: 'boss' })],
    phase_notes: [note({ phase: 'marketing' }), note({ evidence: [] }), note()],
  }, ctx);
  assert.deepEqual(out.rejected, [
    { kind: 'decision', reason: 'no_evidence' }, { kind: 'decision', reason: 'attribution' }, { kind: 'decision', reason: 'attribution' },
    { kind: 'note', reason: 'phase' }, { kind: 'note', reason: 'no_evidence' },
  ]);
  assert.equal(out.notes.length, 1);
  assert.equal(out.notes[0].phase, 'design');
});

test('related and supersedes keep only existing ADR ids', () => {
  const { decisions } = checkOutput({ decisions: [good({ related: [existing, 'ADR-20990101-000000', 'junk'], supersedes: ['ADR-20990101-111111', existing, existing] })] }, ctx);
  assert.deepEqual(decisions[0].related, [existing]);
  assert.deepEqual(decisions[0].supersedes, [existing]);
});

test('anything that is not the expected object throws nothing and creates nothing', () => {
  for (const bad of [null, 'text', [], { decisions: 'x' }, { phase_notes: 7 }]) {
    let out;
    assert.doesNotThrow(() => { out = checkOutput(bad, ctx); });
    assert.deepEqual([out.decisions, out.notes], [[], []]);
  }
  const out = checkOutput({ decisions: [null, 'x', good({ title: '' })], phase_notes: [42] }, ctx);
  assert.deepEqual(out.rejected.map((r) => r.reason), ['shape', 'shape', 'shape', 'shape']);
});

test('over-long fields are cut to their limits', () => {
  const long = (n) => 'x'.repeat(n);
  const { decisions, notes } = checkOutput({
    decisions: [good({ title: long(500), context: long(9000), decision: long(9000), consequences: long(9000), alternatives: Array(20).fill(long(900)) })],
    phase_notes: [note({ title: long(500), summary: long(9000) })],
  }, ctx);
  const d = decisions[0];
  assert.ok(d.title.length <= 120 && d.context.length <= 2000 && d.decision.length <= 2000 && d.consequences.length <= 2000);
  assert.equal(d.alternatives.length, 8);
  assert.ok(d.alternatives.every((a) => a.length <= 500));
  assert.ok(notes[0].title.length <= 120 && notes[0].summary.length <= 3000);
});

test('the schema allows no extra fields and pins ids and phases', () => {
  const decision = OUTPUT_SCHEMA.properties.decisions.items;
  assert.equal(OUTPUT_SCHEMA.additionalProperties, false);
  assert.equal(decision.additionalProperties, false);
  assert.deepEqual(decision.properties.decided_by.enum, ['user', 'llm', 'subagent']);
  assert.equal(decision.properties.evidence.items.pattern, '^[0-9A-HJKMNP-TV-Z]{26}$');
  assert.equal(decision.properties.related.items.pattern, '^ADR-\\d{8}-[0-9a-f]{6}$');
  assert.equal(decision.properties.evidence.minItems, 1);
  assert.deepEqual(OUTPUT_SCHEMA.properties.phase_notes.items.properties.phase.enum, PHASES);
  assert.deepEqual(PHASES, ['discovery', 'definition', 'design', 'development', 'release', 'monitoring']);
});
