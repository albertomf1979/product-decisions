'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { extractSources } = require('../plugin/src/core/sources.js');

const git = { branch: 'main', head: 'abc123', worktree: '.' };
const tool = (toolName, tool_input, tool_response, extra = {}) => ({
  eventType: 'tool_call', toolName, cwd: '/p', payload: { tool_input, tool_response }, ...extra,
});

test('file tools give a file source with the current commit', () => {
  assert.deepEqual(extractSources(tool('Read', { file_path: 'src/a.js' }), git), [{ type: 'file', path: 'src/a.js', commit: 'abc123' }]);
});

test('file paths are relative to the session folder', () => {
  assert.deepEqual(extractSources(tool('Read', { file_path: '/p/src/a.js' }), git), [{ type: 'file', path: 'src/a.js', commit: 'abc123' }]);
});

test('web tools give a URL source', () => {
  assert.deepEqual(extractSources(tool('WebFetch', { url: 'https://example.com/x' }), git), [{ type: 'url', url: 'https://example.com/x' }]);
});

test('MCP tools give an MCP source and their returned links', () => {
  const out = extractSources(tool('mcp__srv__do', { a: 1 }, 'see https://example.com/from-mcp.', { mcp: { server: 'srv', tool: 'do' } }), git);
  assert.deepEqual(out, [{ type: 'mcp', server: 'srv', tool: 'do' }, { type: 'url', url: 'https://example.com/from-mcp' }]);
});

test('GitHub links in a prompt become issues and PRs', () => {
  const out = extractSources({ eventType: 'user_prompt', payload: { prompt: 'see https://github.com/o/r/issues/1 and https://github.com/o/r/pull/2' } }, git);
  assert.deepEqual(out, [
    { type: 'issue', url: 'https://github.com/o/r/issues/1' },
    { type: 'pr', url: 'https://github.com/o/r/pull/2' },
  ]);
});

test('links in a final response are collected', () => {
  const out = extractSources({ eventType: 'agent_response', payload: { last_assistant_message: 'read (https://example.com/a)' } }, git);
  assert.deepEqual(out, [{ type: 'url', url: 'https://example.com/a' }]);
});

test('links inside files read are not sources', () => {
  assert.deepEqual(extractSources(tool('Read', { file_path: 'a' }, 'https://example.com/in-file'), git), [{ type: 'file', path: 'a', commit: 'abc123' }]);
});

test('session start records the transcript as local only', () => {
  const out = extractSources({ eventType: 'session_start', transcriptPath: '/t.jsonl', payload: {} }, git);
  assert.deepEqual(out, [{ type: 'transcript', path: '/t.jsonl', local_only: true }]);
});

test('duplicates collapse', () => {
  const out = extractSources({ eventType: 'user_prompt', payload: { prompt: 'https://example.com/a https://example.com/a' } }, git);
  assert.equal(out.length, 1);
});

test('links are capped per event', () => {
  const prompt = Array.from({ length: 200 }, (_, i) => `https://example.com/${i}`).join(' ');
  assert.equal(extractSources({ eventType: 'user_prompt', payload: { prompt } }, git).length, 50);
});

test('only the first 64 KB of a string is scanned', () => {
  const prompt = `${'x '.repeat(40000)}https://example.com/late`;
  assert.deepEqual(extractSources({ eventType: 'user_prompt', payload: { prompt } }, git), []);
});
