'use strict';

require('./helpers/no-real-claude.js');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { IMPORTER_VERSION, readTranscript, toPayloads } = require('../plugin/src/import/claude-code.js');

const FIXTURE = path.join(__dirname, 'fixtures', 'claude-code', 'transcript-import.jsonl');
const SESSION = 'c3d4e5f6-0000-4000-8000-000000000001';

const imported = () => toPayloads(readTranscript(FIXTURE).records, { sessionId: SESSION });

test('the importer has a version', () => {
  assert.equal(IMPORTER_VERSION, 1);
});

test('prompts, responses, tool calls, failures, denials, and compactions become hook payloads in order', () => {
  const { items } = imported();
  assert.deepEqual(items.map((item) => item.payload.hook_event_name), [
    'UserPromptSubmit', 'Stop', 'PostToolUse', 'Stop', 'PostToolUseFailure', 'PermissionDenied', 'Stop',
    'UserPromptSubmit', 'Stop', 'PostCompact',
  ]);
  const [first, , , , failure, denial, , second, , compact] = items.map((item) => item.payload);
  assert.equal(first.prompt, 'Add a scope section to the PRD.');
  assert.equal(second.prompt, 'Put it at the end.\nKeep it short.');
  assert.equal(failure.tool_name, 'Bash');
  assert.deepEqual(failure.tool_input, { command: 'ls docs', description: 'List docs' });
  assert.equal(failure.error, 'Exit code 1\nls: docs: No such file or directory');
  assert.equal(denial.tool_name, 'Edit');
  assert.equal(denial.reason, 'user');
  assert.equal(compact.trigger, 'auto');
  assert.match(compact.compact_summary, /the scope section was added/);
  for (const { payload } of items) {
    assert.equal(payload.session_id, SESSION);
    assert.equal(payload.cwd, '/home/user/project');
    assert.equal(payload.imported, true);
    assert.equal(typeof payload.transcript_uuid, 'string');
  }
});

test('the last text before the next prompt is the final response; earlier texts are marked intermediate', () => {
  const stops = imported().items.map((item) => item.payload).filter((p) => p.hook_event_name === 'Stop');
  assert.deepEqual(stops.map((p) => [p.last_assistant_message, p.intermediate === true]), [
    ['I will read the PRD first.', true],
    ['The PRD has no scope section.', true],
    ['I stopped, as you asked.', false],
    ['Done: the scope section is at the end.', false],
  ]);
  for (const stop of stops.filter((p) => !p.intermediate)) assert.equal('intermediate' in stop, false);
});

test('a tool result is paired with its call by tool_use_id', () => {
  const read = imported().items.find((item) => item.payload.hook_event_name === 'PostToolUse').payload;
  assert.equal(read.tool_name, 'Read');
  assert.equal(read.tool_use_id, 'toolu_01');
  assert.deepEqual(read.tool_input, { file_path: '/home/user/project/PRD.md' });
  assert.deepEqual(read.tool_response, { type: 'text', file: { filePath: '/home/user/project/PRD.md', content: '# PRD\n', numLines: 1 } });
});

test('a tool result with no structured result keeps its content, and a call with no result yet gives nothing', () => {
  const records = [
    { type: 'user', uuid: 'u1', timestamp: '2026-11-01T10:00:00Z', cwd: '/p', message: { content: 'go' } },
    { type: 'assistant', uuid: 'u2', timestamp: '2026-11-01T10:01:00Z', cwd: '/p', message: { content: [{ type: 'tool_use', id: 't1', name: 'Grep', input: { pattern: 'x' } }] } },
    { type: 'user', uuid: 'u3', timestamp: '2026-11-01T10:02:00Z', cwd: '/p', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'a.js' }] }] } },
    { type: 'assistant', uuid: 'u4', timestamp: '2026-11-01T10:03:00Z', cwd: '/p', message: { content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'sleep 9' } }] } },
  ];
  const { items, skipped } = toPayloads(records, { sessionId: 's' });
  assert.deepEqual(items.map((item) => item.payload.hook_event_name), ['UserPromptSubmit', 'PostToolUse']);
  assert.equal(items[1].payload.tool_response, 'a.js');
  assert.equal(skipped.unanswered_tool, 1);
});

test('thinking, isMeta, sidechain, system, and unknown records are skipped and counted by type', () => {
  assert.deepEqual(imported().skipped, {
    thinking: 1, meta: 1, sidechain: 1, 'system:compact_boundary': 1, 'record:future-record': 1,
  });
});

test('damaged lines are counted, and nothing throws on missing fields', () => {
  const { records, damaged } = readTranscript(FIXTURE);
  assert.equal(damaged, 1);
  assert.equal(records.length, 18);
  const odd = [null, 7, 'text', [], {}, { type: 'user' }, { type: 'user', message: null }, { type: 'user', message: { content: 42 } },
    { type: 'assistant', message: { content: [null, { type: 'text' }, { type: 'tool_use' }] } },
    { type: 'user', message: { content: [{ type: 'tool_result' }, { type: 'image', source: {} }] } }, { type: 'system' }];
  assert.doesNotThrow(() => toPayloads(odd, { sessionId: 's' }));
  const { items } = toPayloads(odd, { sessionId: 's' });
  assert.equal(items.length, 0);
});

test('a missing or unreadable transcript gives no records', () => {
  const missing = path.join(os.tmpdir(), 'pd-no-such-transcript.jsonl');
  assert.deepEqual(readTranscript(missing), { records: [], damaged: 0 });
});

test('each item keeps the record time, uuid, cwd, and git branch', () => {
  const { items } = imported();
  const prompt = items[7];
  assert.equal(prompt.at, '2026-11-01T10:13:00.000Z');
  assert.equal(prompt.uuid, '00000000-0000-4000-8000-000000000113');
  assert.equal(prompt.payload.transcript_uuid, prompt.uuid);
  assert.equal(prompt.cwd, '/home/user/project');
  assert.equal(prompt.gitBranch, 'feature');
  assert.equal(items[2].at, '2026-11-01T10:06:00.000Z', 'a tool call is timed by its result');
  assert.equal(new Set(items.map((item) => item.uuid)).size, items.length, 'every item has its own key');
});

test('an interruption notice is not a prompt', () => {
  const records = [
    { type: 'user', uuid: 'u1', timestamp: '2026-11-01T10:00:00Z', cwd: '/p', message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } },
  ];
  const { items, skipped } = toPayloads(records, { sessionId: 's' });
  assert.equal(items.length, 0);
  assert.equal(skipped.interrupt, 1);
});

test('a file that is not a transcript is read without throwing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-reader-'));
  const file = path.join(dir, 'x.jsonl');
  fs.writeFileSync(file, Buffer.from([0xff, 0xfe, 0x00, 0x0a, 0x7b, 0x0a]));
  assert.doesNotThrow(() => readTranscript(file));
  assert.equal(readTranscript(file).records.length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

const { findTranscripts } = require('../plugin/src/import/claude-code.js');
const { makeRepo, addWorktree } = require('./helpers/repo.js');
const { locateRepo } = require('../plugin/src/core/locate.js');

const projectFolder = (claudeHome, folder) => path.join(claudeHome, 'projects', folder.replace(/[^A-Za-z0-9]/g, '-'));
const putTranscript = (claudeHome, folder, sessionId) => {
  const dir = projectFolder(claudeHome, folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), '{}\n');
};

test('transcripts come from the repository, its worktrees, and its ancestor folders, and nowhere else', (t) => {
  const repo = makeRepo();
  t.after(repo.cleanup);
  const wt = addWorktree(repo.root, 'wt');
  const claudeHome = path.join(repo.base, 'claude-home');
  putTranscript(claudeHome, repo.root, 'in-repo');
  putTranscript(claudeHome, wt, 'in-worktree');
  putTranscript(claudeHome, repo.base, 'in-parent');
  putTranscript(claudeHome, path.join(repo.base, 'other-project'), 'unrelated');
  // A subagent transcript lives one level down and is not a session of its own.
  fs.mkdirSync(path.join(projectFolder(claudeHome, repo.root), 'in-repo', 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(projectFolder(claudeHome, repo.root), 'in-repo', 'subagents', 'agent-x.jsonl'), '{}\n');

  const found = findTranscripts(locateRepo(repo.root), { env: { CLAUDE_CONFIG_DIR: claudeHome, HOME: repo.base } });
  assert.deepEqual(found.map(({ sessionId, kind, folder }) => [sessionId, kind, folder]), [
    ['in-repo', 'repository', repo.root],
    ['in-worktree', 'worktree', wt],
    ['in-parent', 'ancestor', repo.base],
  ]);
  assert.equal(found[0].file, path.join(projectFolder(claudeHome, repo.root), 'in-repo.jsonl'));
});

test('from a linked worktree, the same transcripts are found', (t) => {
  const repo = makeRepo();
  t.after(repo.cleanup);
  const wt = addWorktree(repo.root, 'wt');
  const claudeHome = path.join(repo.base, 'claude-home');
  putTranscript(claudeHome, repo.root, 'in-repo');
  const found = findTranscripts(locateRepo(wt), { env: { CLAUDE_CONFIG_DIR: claudeHome, HOME: repo.base } });
  assert.deepEqual(found.map((item) => item.sessionId), ['in-repo']);
});

test('ancestors stop at the home folder', (t) => {
  const repo = makeRepo();
  t.after(repo.cleanup);
  const claudeHome = path.join(repo.base, 'claude-home');
  putTranscript(claudeHome, path.dirname(repo.base), 'above-home');
  const found = findTranscripts(locateRepo(repo.root), { env: { CLAUDE_CONFIG_DIR: claudeHome, HOME: repo.base } });
  assert.deepEqual(found, []);
});

test('a missing Claude home gives no transcripts', (t) => {
  const repo = makeRepo();
  t.after(repo.cleanup);
  const found = findTranscripts(locateRepo(repo.root), { env: { CLAUDE_CONFIG_DIR: path.join(repo.base, 'nowhere'), HOME: repo.base } });
  assert.deepEqual(found, []);
});
