'use strict';

// Reproductions of the M4 review findings. Each test failed before its fix.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildEvent } = require('../plugin/src/core/event.js');
const { rawFilePath, readSessionMeta, writeSessionMeta } = require('../plugin/src/core/store.js');
const { readLocal, storeDir } = require('../plugin/src/core/state.js');
const { readConfig, writeConfigCopy } = require('../plugin/src/core/config.js');
const { protectSecretFiles } = require('../plugin/src/core/redact.js');
const { CONSENT } = require('../plugin/src/core/consent.js');
const codex = require('../plugin/src/adapters/codex.js');
const { runTurn } = require('../plugin/src/worker/turn.js');
const { runSynthesis } = require('../plugin/src/worker/synthesis.js');
const { renderSession } = require('../plugin/src/synth/deterministic/session.js');
const { buildChunks } = require('../plugin/src/synth/llm/input.js');
const { runCodex, resolveCodex } = require('../plugin/src/synth/llm/engine-codex.js');
const { DEFAULT_CONFIG } = require('../plugin/src/core/config.js');
const { makeRepo } = require('./helpers/repo.js');
const { runCli } = require('./helpers/cli-runner.js');
const { runHook, assertSilent, codexFixture } = require('./helpers/hook-runner.js');
const { installFakeClaude } = require('./helpers/fake-claude.js');
const { installFakeCodex } = require('./helpers/fake-codex.js');

const common = (root) => path.join(root, '.git');
function setup(t, llm = {}) {
  const { root, cleanup } = makeRepo();
  t.after(cleanup);
  assert.equal(runCli(['init', '--yes', '--no-push'], { cwd: root }).status, 0);
  const config = readConfig(common(root));
  writeConfigCopy(common(root), { ...config, llm: { ...config.llm, ...llm } });
  return root;
}
function addSession(root, tool, sessionId, words) {
  const file = rawFilePath(common(root), tool, sessionId, readLocal(common(root)).machine);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const events = [['user_prompt', { prompt: words }, 'user'], ['agent_response', { last_assistant_message: 'ok' }, 'llm']].map(([eventType, payload, actorType]) => buildEvent(
    { eventType, actorType, llmName: tool === 'codex' ? 'codex' : 'claude', agent: { name: 'main' }, payload },
    { tool, sessionId, actorName: 'Test Person', git: null, sources: [], summary: eventType },
  ));
  fs.appendFileSync(file, events.map((e) => `${JSON.stringify(e)}\n`).join(''));
  return file;
}
const close = (root, tool, sessionId) => runTurn({ kind: 'close', tool, sessionId, cwd: root, transcriptPath: null }, { commonDir: common(root) });
function fakeBins(t, root) {
  const bins = path.join(root, '..', 'fake-bins');
  const logs = { claude: path.join(bins, 'claude.jsonl'), codex: path.join(bins, 'codex.jsonl') };
  const saved = { ...process.env };
  t.after(() => { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); });
  Object.assign(process.env, {
    PRODUCT_DECISIONS_CLAUDE_BIN: installFakeClaude(path.join(bins, 'claude')), FAKE_CLAUDE_LOG: logs.claude, FAKE_CLAUDE_MODE: 'ok',
    PRODUCT_DECISIONS_CODEX_BIN: installFakeCodex(path.join(bins, 'codex')), FAKE_CODEX_LOG: logs.codex, FAKE_CODEX_MODE: 'ok',
  });
  const read = (name) => (fs.existsSync(logs[name]) ? fs.readFileSync(logs[name], 'utf8') : '');
  return { read };
}

// C1
test('C1: a Codex shell command array or an apply_patch that names .env keeps its content out of the record', () => {
  const shell = codex.normalize(codexFixture('PostToolUse-shell.json', { tool_input: { command: ['bash', '-lc', 'cat .env'] }, tool_response: 'API_KEY=very-secret-value' })).payload;
  const safeShell = protectSecretFiles(shell, 'salt');
  assert.equal(safeShell.tool_response.redacted_file, true);
  assert.ok(!JSON.stringify(safeShell).includes('very-secret-value'));
  const patch = codex.normalize(codexFixture('PostToolUse-apply_patch.json', { tool_input: { input: '*** Begin Patch\n*** Add File: config/.env\n+API_KEY=very-secret-value\n*** End Patch' } })).payload;
  const safePatch = protectSecretFiles(patch, 'salt');
  assert.ok(!JSON.stringify(safePatch).includes('very-secret-value'));
  assert.equal(protectSecretFiles(codex.normalize(codexFixture('PostToolUse-shell.json')).payload, 'salt').tool_response, 'PRD.md\nsrc\n');
});

// C2
test('C2: Codex sessions are never synthesized automatically, only on an explicit sync --llm', async (t) => {
  const root = setup(t);
  addSession(root, 'codex', 'cx1', 'codex ask');
  await close(root, 'codex', 'cx1');
  const bins = fakeBins(t, root);
  const auto = await runSynthesis({ commonDir: common(root) });
  assert.equal(auto.runs, 0);
  assert.equal(auto.pending, 1);
  assert.equal(bins.read('codex'), '');
  const forced = await runSynthesis({ commonDir: common(root), force: true });
  assert.equal(forced.runs, 1);
  assert.match(bins.read('codex'), /codex ask/);
});

test('C2: codex exec ignores the user config, and consent says Codex synthesis is unverified and runs only on request', async (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pd-c2-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const log = path.join(dir, 'log.jsonl');
  const bin = resolveCodex({ env: { PRODUCT_DECISIONS_CODEX_BIN: installFakeCodex(path.join(dir, 'bin')) } });
  await runCodex({ bin, prompt: 'p', system: 's', schema: { type: 'object' }, model: 'gpt-5-codex', workDir: path.join(dir, 'w'), env: { ...process.env, FAKE_CODEX_LOG: log, FAKE_CODEX_MODE: 'ok' } });
  assert.ok(JSON.parse(fs.readFileSync(log, 'utf8').trim()).argv.includes('--ignore-user-config'));
  assert.match(CONSENT, /unverified/);
  assert.match(CONSENT, /sync\s+--llm/);
});

// I1
test('I1: a Codex hook keeps the session data the worker wrote, and records the model', (t) => {
  const root = setup(t);
  const payload = codexFixture('Stop.json', { cwd: root, session_id: 'cx-meta' });
  writeSessionMeta(common(root), 'codex', 'cx-meta', { cwd: '/some/worktree', closed_through: 'EVENT-1' });
  assertSilent(runHook({ stdin: JSON.stringify(payload), cwd: root, tool: 'codex', event: 'Stop' }));
  const meta = readSessionMeta(common(root), 'codex', 'cx-meta');
  assert.equal(meta.cwd, '/some/worktree');
  assert.equal(meta.closed_through, 'EVENT-1');
  assert.equal(meta.model, 'gpt-5-codex');
});

// I2
test('I2: repeated model requests show once in the chronicle and the model input, and Codex token usage is totalled at close', async (t) => {
  const root = setup(t);
  for (let i = 0; i < 3; i += 1) {
    const payload = codexFixture('PostModelRequest.json', { cwd: root, session_id: 'cx-tok' });
    assertSilent(runHook({ stdin: JSON.stringify(payload), cwd: root, tool: 'codex', event: 'PostModelRequest' }));
  }
  const file = rawFilePath(common(root), 'codex', 'cx-tok', readLocal(common(root)).machine);
  await close(root, 'codex', 'cx-tok');
  const events = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const chronicle = [...renderSession(events, DEFAULT_CONFIG, { machine: 'm' }).values()][0];
  assert.equal((chronicle.match(/Model in use: gpt-5-codex/g) || []).length, 1);
  const totals = events.filter((e) => e.event_type === 'model_usage' && e.payload.usage);
  assert.deepEqual(totals.map((e) => e.payload.usage), [{ input_tokens: 3600, output_tokens: 450, cache_read_input_tokens: 2400, cache_creation_input_tokens: 0 }]);
  const text = buildChunks(events, { maxChars: 400000, header: 'H' })[0].text;
  assert.equal((text.match(/ model_usage\n/g) || []).length, 1);
});

// I3
test('I3: a parse failure is not retried automatically', async (t) => {
  const root = setup(t);
  addSession(root, 'claude-code', 's1', 'ask');
  await close(root, 'claude-code', 's1');
  let calls = 0;
  const engine = async () => { calls += 1; return { ok: false, reason: 'parse', detail: 'exit 0' }; };
  await runSynthesis({ commonDir: common(root), engine });
  await runSynthesis({ commonDir: common(root), engine });
  assert.equal(calls, 1);
});

// I4
test('I4: Codex hook commands use the braced plugin root, and init says native Windows Codex is pending review', (t) => {
  const { hooks } = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'plugin', 'hooks', 'codex.json'), 'utf8'));
  for (const [event, groups] of Object.entries(hooks)) assert.equal(groups[0].hooks[0].command, `node "\${PLUGIN_ROOT}/scripts/hook.js" codex ${event}`);
  const { root, cleanup } = makeRepo();
  t.after(cleanup);
  assert.match(runCli(['init', '--yes', '--no-push'], { cwd: root }).stdout, /Codex support, including native Windows, is pending review\./);
});

// I5
test('I5: a shared config that forces codex cannot send Claude Code sessions to it', async (t) => {
  const root = setup(t, { engine: 'codex' });
  addSession(root, 'claude-code', 's1', 'claude ask');
  await close(root, 'claude-code', 's1');
  const bins = fakeBins(t, root);
  await runSynthesis({ commonDir: common(root), force: true });
  assert.match(bins.read('claude'), /claude ask/);
  assert.equal(bins.read('codex'), '');
});

// I6
test('I6: a consent event that did not record how it was given says so', async (t) => {
  const root = setup(t);
  const file = path.join(storeDir(common(root)), 'raw', 'cli', `local-${readLocal(common(root)).machine}.jsonl`);
  const old = buildEvent({ eventType: 'consent', actorType: 'user', agent: { name: 'main' }, payload: { statement: 'An M1 consent text' } },
    { tool: 'cli', sessionId: 'local', actorName: 'Old Person', git: null, sources: [], summary: 'consent' });
  fs.appendFileSync(file, `${JSON.stringify(old)}\n`);
  assert.equal(runCli(['sync', '--no-push'], { cwd: root }).status, 0);
  const readme = fs.readFileSync(path.join(root, 'product-decisions', 'README.md'), 'utf8');
  assert.match(readme, /\| Old Person \|[^\n]*\| not recorded \|/);
});

// I7
test('I7: a first rollout line longer than 64 KiB still gives its folder', (t) => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pd-i7-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const day = path.join(home, 'sessions', '2026', '11', '08');
  fs.mkdirSync(day, { recursive: true });
  const project = path.join(home, 'project');
  fs.writeFileSync(path.join(day, 'rollout-long.jsonl'), `${JSON.stringify({ type: 'session_meta', payload: { cwd: project, instructions: 'x'.repeat(100 * 1024) } })}\n{"type":"response_item"}\n`);
  assert.ok(codex.latestSessionAt(project, { CODEX_HOME: home }));
});
