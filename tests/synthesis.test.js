'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildEvent } = require('../plugin/src/core/event.js');
const { rawFilePath } = require('../plugin/src/core/store.js');
const { readLocal, writeLocal, storeDir } = require('../plugin/src/core/state.js');
const { readConfig, writeConfigCopy } = require('../plugin/src/core/config.js');
const { runTurn } = require('../plugin/src/worker/turn.js');
const { runSynthesis, pendingSessions, llmStatus } = require('../plugin/src/worker/synthesis.js');
const { makeRepo } = require('./helpers/repo.js');
const { installFakeClaude } = require('./helpers/fake-claude.js');
const { installFakeCodex } = require('./helpers/fake-codex.js');
const { runCli } = require('./helpers/cli-runner.js');

const common = (root) => path.join(root, '.git');
function setup(t, llm = {}) {
  const { root, cleanup } = makeRepo();
  t.after(cleanup);
  assert.equal(runCli(['init', '--yes', '--no-push'], { cwd: root }).status, 0);
  const config = readConfig(common(root));
  writeConfigCopy(common(root), { ...config, llm: { ...config.llm, ...llm } });
  return root;
}
let tick = 0;
function addEvents(root, sessionId, list) {
  const file = rawFilePath(common(root), 'claude-code', sessionId, readLocal(common(root)).machine);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const events = list.map(([eventType, payload, actorType]) => buildEvent(
    { eventType, actorType, llmName: 'claude', agent: { name: 'main' }, payload },
    { tool: 'claude-code', sessionId, actorName: 'Test Person', git: null, sources: [], summary: eventType, now: new Date(Date.now() - 600000 + (tick += 1000)) },
  ));
  fs.appendFileSync(file, events.map((e) => `${JSON.stringify(e)}\n`).join(''));
  return events;
}
const talk = (root, sessionId, text = 'Choose a custom ref') => addEvents(root, sessionId, [
  ['user_prompt', { prompt: text }, 'user'], ['agent_response', { last_assistant_message: 'Done' }, 'llm'],
]);
const close = (root, sessionId) => runTurn({ kind: 'close', tool: 'claude-code', sessionId, cwd: root, transcriptPath: null }, { commonDir: common(root) });
const turn = (root, sessionId) => runTurn({ kind: 'turn', tool: 'claude-code', sessionId, cwd: root, transcriptPath: null }, { commonDir: common(root) });

/** Cites the first prompt it was shown, as a person's decision. */
const citeFirstPrompt = (req, title = 'Use a custom ref') => {
  const id = /^\[([0-9A-Z]{26})\] \S+ user:/m.exec(req.prompt)[1];
  return { ok: true, costUsd: 0.01, output: { decisions: [{ title, decided_by: 'user', context: 'c', decision: 'd', alternatives: [], consequences: 'q', evidence: [id], related: [], supersedes: [] }], phase_notes: [] } };
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

test('only ranges a close job has closed are synthesized', async (t) => {
  const root = setup(t);
  talk(root, 's1');
  await turn(root, 's1');
  const engine = fakeEngine();
  assert.equal((await runSynthesis({ commonDir: common(root), engine })).status, 'nothing');
  assert.equal(engine.calls.length, 0);
  await close(root, 's1');
  const result = await runSynthesis({ commonDir: common(root), engine });
  assert.equal(result.status, 'ran');
  assert.deepEqual([result.runs, result.decisions, result.notes, result.rejected, result.pending], [1, 1, 0, 0, 0]);
  assert.equal(engine.calls.length, 1);
});

test('a second run creates nothing new, and a resumed session gives only its new range', async (t) => {
  const root = setup(t);
  const first = talk(root, 's1');
  await close(root, 's1');
  const engine = fakeEngine();
  await runSynthesis({ commonDir: common(root), engine });
  await runSynthesis({ commonDir: common(root), engine });
  assert.equal(engine.calls.length, 1);
  const second = talk(root, 's1', 'Now drop the raw branch');
  await close(root, 's1');
  await runSynthesis({ commonDir: common(root), engine });
  assert.equal(engine.calls.length, 2);
  assert.ok(engine.calls[1].prompt.includes(second[0].event_id));
  assert.ok(!engine.calls[1].prompt.includes(first[0].event_id));
});

test('created files go to the overlay once, and the folder shows them', async (t) => {
  const root = setup(t);
  const [prompt] = talk(root, 's1');
  await close(root, 's1');
  await runSynthesis({ commonDir: common(root), engine: fakeEngine() });
  const decisions = path.join(root, 'product-decisions', 'decisions');
  const adr = fs.readdirSync(decisions).find((f) => /^ADR-\d{8}-[0-9a-f]{6}-use-a-custom-ref\.md$/.test(f));
  assert.ok(adr);
  assert.match(fs.readFileSync(path.join(decisions, adr), 'utf8'), /Decided by:\*\* user, Test Person/);
  assert.match(fs.readFileSync(path.join(root, 'product-decisions', 'README.md'), 'utf8'), /## Decisions/);
  const overlayFile = path.join(storeDir(common(root)), 'state', 'docs-overlay', 'decisions', adr);
  fs.writeFileSync(overlayFile, 'kept');
  talk(root, 's1');
  await close(root, 's1');
  // The same decision again: same first evidence and title, so the same file.
  const again = await runSynthesis({ commonDir: common(root), engine: fakeEngine((req) => {
    const answer = citeFirstPrompt(req);
    answer.output.decisions[0].evidence = [prompt.event_id];
    return answer;
  }) });
  assert.equal(again.decisions, 0);
  assert.equal(fs.readFileSync(overlayFile, 'utf8'), 'kept');
});

test('past the daily cap the rest stays pending, and the next day continues', async (t) => {
  const root = setup(t, { max_runs_per_day: 1 });
  talk(root, 's1');
  talk(root, 's2');
  await close(root, 's1');
  await close(root, 's2');
  const now = new Date('2026-11-08T12:00:00Z');
  const engine = fakeEngine();
  const today = await runSynthesis({ commonDir: common(root), engine, now });
  assert.deepEqual([today.runs, today.pending], [1, 1]);
  assert.equal(pendingSessions(common(root)).length, 1);
  const again = await runSynthesis({ commonDir: common(root), engine, now });
  assert.deepEqual([again.runs, again.pending], [0, 1]);
  const tomorrow = await runSynthesis({ commonDir: common(root), engine, now: new Date('2026-11-09T12:00:00Z') });
  assert.deepEqual([tomorrow.runs, tomorrow.pending], [1, 0]);
});

test('a long range is split into parts, each one a run', async (t) => {
  const root = setup(t, { max_input_chars: 10000 });
  for (let i = 0; i < 6; i += 1) addEvents(root, 's1', [['user_prompt', { prompt: `${i} ${'x'.repeat(3000)}` }, 'user']]);
  await close(root, 's1');
  const engine = fakeEngine();
  const result = await runSynthesis({ commonDir: common(root), engine });
  assert.ok(engine.calls.length >= 2);
  assert.equal(result.runs, engine.calls.length);
  engine.calls.forEach((call, i) => {
    assert.ok(call.prompt.length <= 10000);
    assert.match(call.prompt, new RegExp(`Part ${i + 1} of ${engine.calls.length}\\.`));
  });
});

test('force ignores the daily count but not consent', async (t) => {
  const root = setup(t, { max_runs_per_day: 0 });
  talk(root, 's1');
  await close(root, 's1');
  const engine = fakeEngine();
  assert.equal((await runSynthesis({ commonDir: common(root), engine })).status, 'off');
  assert.equal((await runSynthesis({ commonDir: common(root), engine, force: true })).status, 'ran');
  talk(root, 's1');
  await close(root, 's1');
  writeLocal(common(root), { ...readLocal(common(root)), consent_sha: 'older-text' });
  assert.equal((await runSynthesis({ commonDir: common(root), engine, force: true })).status, 'no_consent');
  assert.equal(engine.calls.length, 1);
});

test('personal opt-out and project switch stop automatic runs only', async (t) => {
  const root = setup(t);
  talk(root, 's1');
  await close(root, 's1');
  const engine = fakeEngine();
  writeLocal(common(root), { ...readLocal(common(root)), llm_enabled: false });
  assert.equal((await runSynthesis({ commonDir: common(root), engine })).status, 'off');
  writeLocal(common(root), { ...readLocal(common(root)), llm_enabled: true });
  const config = readConfig(common(root));
  writeConfigCopy(common(root), { ...config, llm: { ...config.llm, enabled: false } });
  assert.equal((await runSynthesis({ commonDir: common(root), engine })).status, 'off');
  assert.equal(engine.calls.length, 0);
  assert.equal((await runSynthesis({ commonDir: common(root), engine, force: true })).status, 'ran');
});

test('without the current consent nothing runs, also when forced', async (t) => {
  const root = setup(t);
  talk(root, 's1');
  await close(root, 's1');
  writeLocal(common(root), { ...readLocal(common(root)), consent_sha: 'older-text' });
  const engine = fakeEngine();
  assert.equal((await runSynthesis({ commonDir: common(root), engine })).status, 'no_consent');
  assert.equal((await runSynthesis({ commonDir: common(root), engine, force: true })).status, 'no_consent');
  assert.equal(engine.calls.length, 0);
});

test('a transient failure stops the run, keeps the range pending, and records the reason', async (t) => {
  const root = setup(t);
  for (const s of ['s1', 's2', 's3']) {
    talk(root, s);
    await close(root, s);
  }
  const engine = fakeEngine({ ok: false, reason: 'auth', detail: 'exit 1' });
  const result = await runSynthesis({ commonDir: common(root), engine });
  assert.equal(result.status, 'stopped');
  assert.deepEqual(result.error, { reason: 'auth' });
  assert.equal(engine.calls.length, 1);
  assert.equal(result.pending, 3);
  assert.equal(llmStatus(common(root)).last_error.reason, 'auth');
  // The next close retries it.
  const retry = fakeEngine();
  assert.equal((await runSynthesis({ commonDir: common(root), engine: retry })).runs, 3);
});

test('a budget failure is not retried automatically, but force retries it', async (t) => {
  const root = setup(t);
  talk(root, 's1');
  await close(root, 's1');
  const engine = fakeEngine((req, n) => (n === 1 ? { ok: false, reason: 'budget', detail: 'exit 1' } : citeFirstPrompt(req)));
  await runSynthesis({ commonDir: common(root), engine });
  await runSynthesis({ commonDir: common(root), engine });
  assert.equal(engine.calls.length, 1);
  assert.equal(pendingSessions(common(root)).length, 1);
  const forced = await runSynthesis({ commonDir: common(root), engine, force: true });
  assert.equal(engine.calls.length, 2);
  assert.equal(forced.decisions, 1);
});

test('rejected items are counted and logged without their content', async (t) => {
  const root = setup(t);
  talk(root, 's1');
  await close(root, 's1');
  const engine = fakeEngine({ ok: true, output: { decisions: [{ title: 'SECRET-TITLE', decided_by: 'user', context: '', decision: '', alternatives: [], consequences: '', evidence: ['01ZZZZZZZZZZZZZZZZZZZZZZZZ'], related: [], supersedes: [] }], phase_notes: [] } });
  const result = await runSynthesis({ commonDir: common(root), engine });
  assert.deepEqual([result.decisions, result.rejected], [0, 1]);
  const log = fs.readFileSync(path.join(storeDir(common(root)), 'logs', 'diagnostics.log'), 'utf8');
  assert.match(log, /unknown_evidence/);
  assert.ok(!log.includes('SECRET-TITLE'));
});

test('the lock is refreshed while the engine runs', async (t) => {
  const root = setup(t);
  talk(root, 's1');
  await close(root, 's1');
  let refreshed = 0;
  const engine = fakeEngine(async (req) => {
    await new Promise((resolve) => setTimeout(resolve, 120));
    return citeFirstPrompt(req);
  });
  await runSynthesis({ commonDir: common(root), engine, refresh: () => { refreshed += 1; }, refreshEveryMs: 20 });
  assert.ok(refreshed >= 1);
});

test('auto picks codex for a Codex session and claude for a Claude Code session, on an explicit run', async (t) => {
  const root = setup(t);
  talk(root, 's1');
  await close(root, 's1');
  const file = rawFilePath(common(root), 'codex', 'cx1', readLocal(common(root)).machine);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, [['user_prompt', { prompt: 'codex ask' }, 'user'], ['agent_response', { last_assistant_message: 'ok' }, 'llm']].map(([eventType, payload, actorType]) => JSON.stringify(buildEvent(
    { eventType, actorType, llmName: 'codex', agent: { name: 'main' }, payload },
    { tool: 'codex', sessionId: 'cx1', actorName: 'Test Person', git: null, sources: [], summary: eventType },
  ))).join('\n') + '\n');
  await runTurn({ kind: 'close', tool: 'codex', sessionId: 'cx1', cwd: root, transcriptPath: null }, { commonDir: common(root) });
  const bins = path.join(root, '..', 'fake-bins');
  const logs = { claude: path.join(bins, 'claude.jsonl'), codex: path.join(bins, 'codex.jsonl') };
  const saved = { ...process.env };
  t.after(() => { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); });
  Object.assign(process.env, {
    PRODUCT_DECISIONS_CLAUDE_BIN: installFakeClaude(path.join(bins, 'claude')), FAKE_CLAUDE_LOG: logs.claude, FAKE_CLAUDE_MODE: 'ok',
    PRODUCT_DECISIONS_CODEX_BIN: installFakeCodex(path.join(bins, 'codex')), FAKE_CODEX_LOG: logs.codex, FAKE_CODEX_MODE: 'ok',
  });
  const auto = await runSynthesis({ commonDir: common(root) });
  assert.equal(auto.runs, 1);
  assert.equal(fs.existsSync(logs.codex), false);
  const result = await runSynthesis({ commonDir: common(root), force: true });
  assert.equal(result.runs, 1);
  assert.match(fs.readFileSync(logs.codex, 'utf8'), /codex ask/);
  assert.ok(!fs.readFileSync(logs.claude, 'utf8').includes('codex ask'));
});

test('imported ranges are synthesized only on an explicit run', async (t) => {
  const root = setup(t);
  const claudeHome = path.join(path.dirname(root), 'claude-home');
  const dir = path.join(claudeHome, 'projects', root.replace(/[^A-Za-z0-9]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  const fixtureText = fs.readFileSync(path.join(__dirname, 'fixtures', 'claude-code', 'transcript-import.jsonl'), 'utf8');
  fs.writeFileSync(path.join(dir, 'imported-1.jsonl'), fixtureText.split('/home/user/project').join(root));
  const imported = runCli(['import'], { cwd: root, env: { CLAUDE_CONFIG_DIR: claudeHome } });
  assert.equal(imported.status, 0, imported.stderr);

  const engine = fakeEngine();
  const auto = await runSynthesis({ commonDir: common(root), engine });
  assert.equal(engine.calls.length, 0, 'automatic synthesis leaves imported sessions alone');
  assert.equal(auto.runs, 0);
  const forced = await runSynthesis({ commonDir: common(root), engine, force: true });
  assert.equal(forced.runs, 1);
  assert.equal(engine.calls.length, 1);
});
