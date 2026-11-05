'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { normalize } = require('../plugin/src/adapters/claude-code.js');

const dir = path.join(__dirname, 'fixtures', 'claude-code');
const fixtures = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
const load = (name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));

const EXPECTED = {
  SessionStart: ['session_start', 'user'],
  SessionEnd: ['session_end', 'user'],
  UserPromptSubmit: ['user_prompt', 'user'],
  PostToolUse: ['tool_call', 'llm'],
  PostToolUseFailure: ['tool_failure', 'llm'],
  PermissionDenied: ['tool_denied', 'llm'],
  SubagentStart: ['subagent_start', 'subagent'],
  SubagentStop: ['subagent_stop', 'subagent'],
  Stop: ['agent_response', 'llm'],
  StopFailure: ['turn_failure', 'llm'],
  PreCompact: ['compaction', 'llm'],
  PostCompact: ['compaction', 'llm'],
  PostModelSwitch: ['model_change', 'llm'],
};

test('every hook event in the mapping has a fixture', () => {
  for (const event of Object.keys(EXPECTED)) {
    assert(fixtures.some((f) => f === `${event}.json` || f.startsWith(`${event}-`)), event);
  }
});

for (const name of fixtures) {
  test(`${name} normalizes with its expected event type`, () => {
    const payload = load(name);
    const out = normalize(payload);
    const [eventType, actorType] = EXPECTED[payload.hook_event_name];
    assert.equal(out.eventType, eventType);
    assert.equal(out.actorType, payload.agent_id && actorType === 'llm' ? 'subagent' : actorType);
    assert.equal(out.hookEvent, payload.hook_event_name);
    assert.equal(out.sessionId, payload.session_id);
    assert.equal(out.cwd, payload.cwd);
    assert.equal(out.transcriptPath, payload.transcript_path);
    assert.equal(out.llmName, 'claude');
  });

  test(`${name} moves the envelope out of the payload`, () => {
    const { payload } = normalize(load(name));
    for (const field of ['session_id', 'cwd', 'hook_event_name', 'transcript_path', 'agent_id', 'agent_type', 'scratchpad_dir']) {
      assert(!(field in payload), field);
    }
  });
}

test('everything else stays in the payload, including unknown future fields', () => {
  const { payload } = normalize({ ...load('Stop.json'), some_future_field: 42 });
  assert.equal(payload.some_future_field, 42);
  assert(typeof payload.last_assistant_message === 'string');
  assert(typeof payload.permission_mode === 'string');
});

test('a configured main agent is not mistaken for a subagent', () => {
  const out = normalize(load('Stop.json'));
  assert.equal(out.actorType, 'llm');
  assert.deepEqual(out.agent, { name: 'main', type: 'ui-color-palette:uicper' });
});

test('with no configured agent, the agent is just main', () => {
  const { agent_type: _ignored, ...payload } = load('Stop.json');
  assert.deepEqual(normalize(payload).agent, { name: 'main' });
});

test('a subagent is named by its type and carries its id', () => {
  const out = normalize(load('SubagentStop.json'));
  assert.equal(out.agent.name, 'general-purpose');
  assert.equal(typeof out.agent.id, 'string');
});

test('tool events inside a subagent are attributed to it', () => {
  const out = normalize(load('PostToolUseFailure-Read-subagent.json'));
  assert.equal(out.actorType, 'subagent');
  assert.equal(out.agent.name, 'general-purpose');
  assert.equal(out.toolName, 'Read');
});

test('MCP tools prefer the mcp_server name', () => {
  const out = normalize(load('PostToolUse-mcp.json'));
  assert.deepEqual(out.mcp, { server: 'probe', tool: 'echo' });
});

test('MCP tool names are parsed when there is no mcp_server', () => {
  const out = normalize({ hook_event_name: 'PostToolUse', tool_name: 'mcp__github__create_issue' });
  assert.deepEqual(out.mcp, { server: 'github', tool: 'create_issue' });
});

test('ordinary tools have no mcp field', () => {
  assert.equal(normalize(load('PostToolUse-Read.json')).mcp, undefined);
});

test('compaction keeps its stage', () => {
  assert.equal(normalize(load('PreCompact.json')).payload.stage, 'PreCompact');
  assert.equal(normalize(load('PostCompact.json')).payload.stage, 'PostCompact');
});

test('model hints come only from SessionStart and PostModelSwitch', () => {
  assert.deepEqual(normalize(load('SessionStart-compact-model.json')).modelHint, { model: 'claude-haiku-5-5', source: 'session_start' });
  assert.deepEqual(normalize(load('PostModelSwitch.json')).modelHint, { model: 'claude-sonnet-5-5', source: 'model_switch' });
  assert.equal(normalize(load('SessionStart-startup.json')).modelHint, undefined);
  assert.equal(normalize(load('Stop.json')).modelHint, undefined);
});

test('unknown hook events and non-objects return null', () => {
  assert.equal(normalize({ hook_event_name: 'Nope' }), null);
  assert.equal(normalize(null), null);
  assert.equal(normalize([]), null);
  assert.equal(normalize('text'), null);
});
