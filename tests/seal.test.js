'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildEvent, contentHash } = require('../plugin/src/core/event.js');
const { sealFile, verifyFile } = require('../plugin/src/worker/seal.js');
const { makeRepo, activate } = require('./helpers/repo.js');
const { runCli } = require('./helpers/cli-runner.js');

function tmpFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-seal-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 's1-m.jsonl');
}

let counter = 0;
function event(over = {}) {
  counter += 1;
  return buildEvent(
    { eventType: 'tool_call', actorType: 'llm', llmName: 'claude', agent: { name: 'main' }, payload: { n: counter }, ...over },
    { tool: 'claude-code', sessionId: 's1', actorName: 'Ana', git: { branch: 'main', head: null, worktree: '.' }, sources: [], summary: `event ${counter}`, now: new Date(1793873793000 + counter) },
  );
}
const write = (file, events) => fs.appendFileSync(file, events.map((e) => `${JSON.stringify(e)}\n`).join(''));
const lines = (file) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
const rewrite = (file, list) => fs.writeFileSync(file, list.map((l) => `${l}\n`).join(''));

test('a seal covers the lines since the previous seal and links to it', (t) => {
  const file = tmpFile(t);
  const [a, b, c] = [event(), event(), event()];
  write(file, [a, b]);
  const first = sealFile(file);
  assert.equal(first.event_type, 'seal');
  assert.equal(first.origin, 'derived');
  assert.deepEqual(first.actor, { type: 'plugin', name: 'product-decisions' });
  assert.equal(first.payload.count, 2);
  assert.equal(first.payload.through_event_id, b.event_id);
  assert.equal(first.payload.previous, null);
  const expected = crypto.createHash('sha256').update(`\n${a.content_hash}\n${b.content_hash}`).digest('hex');
  assert.equal(first.payload.chain, expected);
  write(file, [c]);
  const second = sealFile(file);
  assert.equal(second.payload.count, 1);
  assert.equal(second.payload.previous, first.event_id);
  assert.equal(second.payload.chain, crypto.createHash('sha256').update(`${first.payload.chain}\n${c.content_hash}`).digest('hex'));
});

test('sealing twice with nothing new adds nothing', (t) => {
  const file = tmpFile(t);
  write(file, [event()]);
  sealFile(file);
  const before = lines(file).length;
  assert.equal(sealFile(file), null);
  assert.equal(lines(file).length, before);
});

test('a clean file verifies', (t) => {
  const file = tmpFile(t);
  write(file, [event(), event()]);
  sealFile(file);
  write(file, [event()]);
  sealFile(file);
  write(file, [event()]);
  const result = verifyFile(file);
  assert.deepEqual(result.problems, []);
  assert.equal(result.sealed, 3);
  assert.equal(result.unsealed, 1);
});

test('editing any field of a sealed line is reported as altered', (t) => {
  const file = tmpFile(t);
  write(file, [event(), event()]);
  sealFile(file);
  const all = lines(file);
  const changed = JSON.parse(all[0]);
  changed.summary = 'rewritten';
  all[0] = JSON.stringify(changed);
  rewrite(file, all);
  const { problems } = verifyFile(file);
  assert(problems.some((p) => p.kind === 'altered' && p.line === 1), JSON.stringify(problems));
});

test('rewriting a line and its own hash is still caught by the seal', (t) => {
  const file = tmpFile(t);
  write(file, [event(), event()]);
  sealFile(file);
  const all = lines(file);
  const changed = JSON.parse(all[0]);
  changed.summary = 'rewritten';
  changed.content_hash = contentHash(changed);
  all[0] = JSON.stringify(changed);
  rewrite(file, all);
  assert(verifyFile(file).problems.length > 0);
});

test('removing a sealed line is reported', (t) => {
  const file = tmpFile(t);
  write(file, [event(), event(), event()]);
  sealFile(file);
  const all = lines(file);
  all.splice(1, 1);
  rewrite(file, all);
  const { problems } = verifyFile(file);
  assert(problems.some((p) => p.kind === 'removed' || p.kind === 'broken_chain'), JSON.stringify(problems));
});

test('swapping two sealed lines is reported', (t) => {
  const file = tmpFile(t);
  write(file, [event(), event(), event()]);
  sealFile(file);
  const all = lines(file);
  [all[0], all[1]] = [all[1], all[0]];
  rewrite(file, all);
  const { problems } = verifyFile(file);
  assert(problems.some((p) => p.kind === 'reordered' || p.kind === 'broken_chain'), JSON.stringify(problems));
});

test('removing a seal in the middle breaks the chain', (t) => {
  const file = tmpFile(t);
  write(file, [event()]);
  sealFile(file);
  write(file, [event()]);
  sealFile(file);
  write(file, [event()]);
  sealFile(file);
  const all = lines(file);
  rewrite(file, all.filter((_, i) => i !== 3));
  assert(verifyFile(file).problems.some((p) => p.kind === 'broken_chain'));
});

test('editing an unsealed line is still caught by its own hash', (t) => {
  const file = tmpFile(t);
  write(file, [event()]);
  sealFile(file);
  write(file, [event()]);
  const all = lines(file);
  const changed = JSON.parse(all[2]);
  changed.summary = 'rewritten';
  all[2] = JSON.stringify(changed);
  rewrite(file, all);
  assert(verifyFile(file).problems.some((p) => p.kind === 'altered' && p.line === 3));
});

test('lines appended between reading and sealing fall to the next seal', (t) => {
  const file = tmpFile(t);
  const [a, b, c] = [event(), event(), event()];
  write(file, [a, b]);
  const seal = sealFile(file);
  // Rebuild as if a hook appended c after the worker read the file but before it wrote the seal.
  rewrite(file, [a, b, c, seal].map((e) => JSON.stringify(e)));
  assert.deepEqual(verifyFile(file).problems, []);
  const next = sealFile(file);
  assert.equal(next.payload.count, 1);
  assert.equal(next.payload.through_event_id, c.event_id);
  assert.deepEqual(verifyFile(file).problems, []);
});

test('a torn last line is counted as unsealed, not as tampering', (t) => {
  const file = tmpFile(t);
  write(file, [event()]);
  sealFile(file);
  fs.appendFileSync(file, '{"event_id":"partial');
  const result = verifyFile(file);
  assert.deepEqual(result.problems, []);
  assert.equal(result.unsealed, 1);
  assert.equal(sealFile(file), null, 'a torn line is not sealed');
});

test('a garbled line in the middle is reported as unparsable', (t) => {
  const file = tmpFile(t);
  write(file, [event()]);
  fs.appendFileSync(file, 'not json\n');
  write(file, [event()]);
  assert(verifyFile(file).problems.some((p) => p.kind === 'unparsable' && p.line === 2));
});

test('imported-origin events are reported separately', (t) => {
  const file = tmpFile(t);
  const imported = buildEvent(
    { eventType: 'user_prompt', actorType: 'user', agent: { name: 'main' }, payload: {} },
    { tool: 'claude-code', sessionId: 's1', actorName: 'Ana', git: null, sources: [], summary: 'x', origin: 'imported' },
  );
  write(file, [imported, event()]);
  sealFile(file);
  assert.equal(verifyFile(file).imported, 1);
});

test('verify covers every session on the machine and exits 1 on a problem, naming file and line', (t) => {
  const { root, cleanup } = makeRepo();
  t.after(cleanup);
  activate(root);
  const raw = path.join(root, '.git', 'product-decisions', 'raw', 'claude-code');
  fs.mkdirSync(raw, { recursive: true });
  const good = path.join(raw, 'good-m.jsonl');
  const bad = path.join(raw, 'bad-m.jsonl');
  write(good, [event()]);
  write(bad, [event(), event()]);
  sealFile(good);
  sealFile(bad);
  const clean = runCli(['verify'], { cwd: root });
  assert.equal(clean.status, 0, clean.stderr);
  assert.match(clean.stdout, /2 sessions/);
  const all = lines(bad);
  all.splice(0, 1);
  rewrite(bad, all);
  const broken = runCli(['verify', '--json'], { cwd: root });
  assert.equal(broken.status, 1);
  const report = JSON.parse(broken.stdout);
  const file = report.files.find((f) => f.file.endsWith('bad-m.jsonl'));
  assert(file.problems.length > 0);
  assert.equal(typeof file.problems[0].line, 'number');
});
