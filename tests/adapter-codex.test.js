'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { normalize, projectDir, pathsTouched, latestSessionAt } = require('../plugin/src/adapters/codex.js');

const dir = path.join(__dirname, 'fixtures', 'codex');
const load = (name) => JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), 'utf8'));

test('each registered Codex event maps to its event type, with codex as the agent', () => {
  const cases = {
    SessionStart: 'session_start', SessionEnd: 'session_end', UserPromptSubmit: 'user_prompt', 'PostToolUse-shell': 'tool_call',
    SubagentStart: 'subagent_start', SubagentStop: 'subagent_stop', Stop: 'agent_response', Interrupt: 'interrupt',
    PreCompact: 'compaction', PostCompact: 'compaction', PostModelRequest: 'model_usage',
  };
  for (const [name, type] of Object.entries(cases)) {
    const n = normalize(load(name));
    assert.equal(n.eventType, type, name);
    assert.equal(n.llmName, 'codex', name);
    assert.equal(n.sessionId, '019a6f2e-0000-7000-8000-000000000001', name);
  }
  assert.equal(normalize(load('PreCompact')).payload.stage, 'PreCompact');
});

test('people start sessions and write prompts; the agent does the rest', () => {
  assert.equal(normalize(load('UserPromptSubmit')).actorType, 'user');
  assert.equal(normalize(load('SessionEnd')).actorType, 'user');
  assert.equal(normalize(load('Stop')).actorType, 'llm');
  assert.equal(normalize(load('PostToolUse-shell')).actorType, 'llm');
});

test('PreToolUse, PermissionRequest, PreModelRequest, unknown names, and prototype names give null', () => {
  for (const name of ['PreToolUse', 'PermissionRequest', 'PreModelRequest', 'Unknown', 'constructor', '__proto__', 'toString']) {
    assert.equal(normalize({ ...load('Stop'), hook_event_name: name }), null, name);
  }
  for (const bad of [null, 'text', [], 42]) assert.equal(normalize(bad), null);
});

test('the model on every event becomes a hook model hint', () => {
  for (const name of ['SessionStart', 'Stop', 'PostToolUse-shell']) {
    assert.deepEqual(normalize(load(name)).modelHint, { model: 'gpt-5-codex', source: 'hook' }, name);
  }
  assert.equal(normalize({ ...load('Stop'), model: undefined }).modelHint, undefined);
});

test('PostModelRequest keeps status, error, and token usage in the payload, and the model for the chronicle', () => {
  const n = normalize(load('PostModelRequest'));
  assert.equal(n.payload.status, 'ok');
  assert.equal(n.payload.error, null);
  assert.deepEqual(n.payload.token_usage, { input_tokens: 1200, cached_input_tokens: 800, output_tokens: 150 });
  assert.equal(n.payload.model, 'gpt-5-codex');
});

test('turn_id and permission_mode stay in the payload; the envelope does not', () => {
  const n = normalize(load('UserPromptSubmit'));
  assert.equal(n.payload.turn_id, 'turn-1');
  assert.equal(n.payload.permission_mode, 'default');
  assert.equal(n.payload.prompt, 'Add a scope section to the PRD');
  for (const key of ['session_id', 'cwd', 'hook_event_name', 'transcript_path']) assert.ok(!(key in n.payload), key);
});

test('subagent events carry agent_id, and the main agent is labelled main', () => {
  assert.deepEqual(normalize(load('SubagentStart')).agent, { name: 'explorer', id: 'agent-7' });
  assert.equal(normalize(load('SubagentStop')).actorType, 'subagent');
  assert.deepEqual(normalize(load('Stop')).agent, { name: 'main' });
  assert.deepEqual(normalize({ ...load('SubagentStop'), agent_id: undefined }).agent, { name: 'explorer' });
});

test('an MCP tool name gives its server and tool', () => {
  const n = normalize(load('PostToolUse-mcp'));
  assert.deepEqual(n.mcp, { server: 'github', tool: 'create_issue' });
  assert.equal(n.toolName, 'mcp__github__create_issue');
  assert.equal(normalize(load('PostToolUse-shell')).mcp, undefined);
});

test('apply_patch paths come from its file headers', () => {
  // Resolved as this system resolves them: D:\home\user\project on Windows.
  const abs = (p) => require('node:path').resolve(p);
  assert.deepEqual(pathsTouched(load('PostToolUse-apply_patch')), [abs('/home/user/project/PRD.md'), abs('/home/user/project/src/new.js')]);
  assert.deepEqual(pathsTouched({ ...load('PostToolUse-apply_patch'), tool_input: '*** Begin Patch\n*** Delete File: old.md\n*** End Patch' }), [abs('/home/user/project/old.md')]);
  assert.deepEqual(pathsTouched(load('PostToolUse-shell')), [abs('/home/user/project')]);
  assert.deepEqual(pathsTouched({}), []);
});

test('missing or null fields never throw', () => {
  for (const payload of [{}, { hook_event_name: 'Stop' }, { ...load('Stop'), turn_id: null, transcript_path: null }, { ...load('PostToolUse-apply_patch'), tool_input: null }]) {
    assert.doesNotThrow(() => normalize(payload));
    assert.doesNotThrow(() => pathsTouched(payload));
  }
  assert.equal(normalize({ ...load('Stop'), transcript_path: null }).transcriptPath, null);
});

test('Codex has no project folder variable', () => {
  assert.equal(projectDir({ CLAUDE_PROJECT_DIR: '/x' }), null);
});

test('latestSessionAt reads only the first line of recent rollouts and matches this folder', (t) => {
  const os = require('node:os');
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pd-codex-home-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const day = path.join(home, 'sessions', '2026', '11', '08');
  fs.mkdirSync(day, { recursive: true });
  const project = path.join(home, 'project');
  const write = (name, cwd, at) => {
    const file = path.join(day, name);
    fs.writeFileSync(file, `${JSON.stringify({ type: 'session_meta', payload: { id: name, cwd } })}\n${JSON.stringify({ type: 'response_item', payload: { secret: 'NEVER-READ' } })}\n`);
    fs.utimesSync(file, at / 1000, at / 1000);
  };
  write('rollout-a.jsonl', path.join(project, 'src'), Date.parse('2026-11-08T10:00:00Z'));
  write('rollout-b.jsonl', path.join(home, 'elsewhere'), Date.parse('2026-11-08T11:00:00Z'));
  fs.writeFileSync(path.join(day, 'rollout-broken.jsonl'), '{ not json');
  assert.equal(latestSessionAt(project, { CODEX_HOME: home }), '2026-11-08T10:00:00.000Z');
  assert.equal(latestSessionAt(path.join(home, 'nothing-here'), { CODEX_HOME: home }), null);
  assert.equal(latestSessionAt(project, { CODEX_HOME: path.join(home, 'missing') }), null);
});
