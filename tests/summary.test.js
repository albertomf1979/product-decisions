'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { summarize } = require('../plugin/src/core/summary.js');

const tool = (toolName, tool_input, eventType = 'tool_call', extra = {}) => ({
  eventType, toolName, cwd: '/p', agent: { name: 'main' }, payload: { tool_input }, ...extra,
});

test('file tools name the file, relative to the session folder', () => {
  assert.equal(summarize(tool('Read', { file_path: 'src/a.js' })), 'Read src/a.js');
  assert.equal(summarize(tool('Edit', { file_path: '/p/src/b.js' })), 'Edit src/b.js');
  assert.equal(summarize(tool('Read', { file_path: '/other/c.js' })), 'Read /other/c.js');
});

test('web tools name the address without its scheme', () => {
  assert.equal(summarize(tool('WebFetch', { url: 'https://example.com/x' })), 'WebFetch example.com/x');
});

test('search tools name the query', () => {
  assert.equal(summarize(tool('WebSearch', { query: 'hook events' })), 'WebSearch hook events');
});

test('shell commands keep the first 80 characters on one line', () => {
  const out = summarize(tool('Bash', { command: `echo one\n${'x'.repeat(200)}` }));
  assert.equal(out.length, 'Bash '.length + 80);
  assert(!out.includes('\n'));
  assert(out.startsWith('Bash echo one x'));
});

test('MCP tools read as server and tool', () => {
  const out = summarize(tool('mcp__github__create_issue', { title: 't' }, 'tool_call', { mcp: { server: 'github', tool: 'create_issue' } }));
  assert.equal(out, 'MCP github.create_issue');
});

test('subagent launches name the description', () => {
  assert.equal(summarize(tool('Agent', { description: 'Review it', prompt: 'long' })), 'Agent Review it');
});

test('failures and denials say so', () => {
  assert.equal(summarize(tool('Read', { file_path: 'a' }, 'tool_failure')), 'Failed: Read a');
  assert.equal(summarize(tool('Bash', { command: 'rm x' }, 'tool_denied')), 'Denied: Bash rm x');
});

test('prompts keep the first 80 characters on one line', () => {
  const out = summarize({ eventType: 'user_prompt', agent: { name: 'main' }, payload: { prompt: `Hola\n  ${'y'.repeat(200)}` } });
  assert.equal(out.length, 80);
  assert(out.startsWith('Hola y'));
});

test('session, turn, subagent, compaction, and model events have a line', () => {
  const agent = { name: 'main' };
  const line = (eventType, payload, a = agent) => summarize({ eventType, agent: a, payload });
  assert.equal(line('session_start', { source: 'startup' }), 'Session started (startup)');
  assert.equal(line('session_end', { reason: 'other' }), 'Session ended (other)');
  assert.equal(line('agent_response', { last_assistant_message: 'Done.' }), 'Done.');
  assert.equal(line('agent_response', {}), 'Turn ended');
  assert.equal(line('turn_failure', { error: 'rate_limit' }), 'Turn failed: rate_limit');
  assert.equal(line('subagent_start', {}, { name: 'reviewer', id: 'a' }), 'Subagent started: reviewer');
  assert.equal(line('subagent_stop', {}, { name: 'reviewer', id: 'a' }), 'Subagent stopped: reviewer');
  assert.equal(line('compaction', { stage: 'PreCompact', trigger: 'auto' }), 'Compaction, PreCompact (auto)');
  assert.equal(line('model_change', { to_model: 'x' }), 'Model changed to x');
});

test('an oversized payload still gets a line', () => {
  assert.equal(summarize({ eventType: 'tool_call', toolName: 'Read', agent: { name: 'main' }, payload: { oversized: true } }), 'Read');
});

test('an unknown event type falls back to its name', () => {
  assert.equal(summarize({ eventType: 'gap', agent: { name: 'main' }, payload: {} }), 'gap');
});
