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

const userText = (uuid, minute, content, extra = {}) => ({
  type: 'user', uuid, cwd: '/p', timestamp: `2026-11-01T10:${String(minute).padStart(2, '0')}:00Z`, message: { role: 'user', content }, ...extra,
});

test('bash-mode and local-command records are not prompts; a command with arguments is', () => {
  const records = [
    userText('c0', 0, 'Caveat: The messages below were generated by the user while running local commands.', { isMeta: true }),
    userText('c1', 1, '<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>'),
    userText('c2', 2, '<local-command-stdout></local-command-stdout>'),
    userText('c3', 3, '<command-name>/review</command-name>\n<command-message>review</command-message>\n<command-args>the login page</command-args>'),
    userText('c4', 4, '<bash-input>cat .env</bash-input>'),
    userText('c5', 5, '<bash-stdout>ADMIN_PIN=482913</bash-stdout><bash-stderr></bash-stderr>'),
    userText('c6', 6, '<local-command-stderr>failed</local-command-stderr>'),
    userText('c7', 7, [
      { type: 'text', text: '<ide_opened_file>The user opened the file /p/a.js in the IDE.</ide_opened_file>' },
      { type: 'text', text: '<system-reminder>Injected context.</system-reminder>' },
      { type: 'text', text: 'Fix the bug in a.js.' },
    ]),
  ];
  const { items, skipped } = toPayloads(records, { sessionId: 's' });
  assert.deepEqual(items.map((item) => item.payload.prompt), ['/review the login page', 'Fix the bug in a.js.']);
  assert.deepEqual(skipped, { meta: 1, command: 1, local_command: 2, bash_mode: 2, ide_context: 1, reminder: 1 });
});

test('each item carries the model and Claude Code version of its turn', () => {
  const { items } = imported();
  assert.equal(items[0].model, 'claude-opus-5-5', 'a prompt before the first response takes the session model');
  assert.equal(items[0].version, '2.1.310');
  const records = [
    userText('m1', 1, 'Go.'),
    { type: 'assistant', uuid: 'm2', cwd: '/p', timestamp: '2026-11-01T10:02:00Z', version: '2.1.311', message: { model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'One.' }] } },
    { type: 'assistant', uuid: 'm3', cwd: '/p', timestamp: '2026-11-01T10:03:00Z', message: { model: '<synthetic>', content: [{ type: 'text', text: 'No response requested.' }] } },
    { type: 'assistant', uuid: 'm4', cwd: '/p', timestamp: '2026-11-01T10:04:00Z', message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Two.' }] } },
  ];
  assert.deepEqual(toPayloads(records, { sessionId: 's' }).items.map((item) => item.model),
    ['claude-sonnet-5-5', 'claude-sonnet-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5']);
});

test('sessions opened in a subfolder of the repository or of a worktree are found', (t) => {
  const repo = makeRepo();
  t.after(repo.cleanup);
  const claudeHome = path.join(repo.base, 'claude-home');
  putTranscript(claudeHome, repo.root, 'in-repo');
  putTranscript(claudeHome, path.join(repo.root, 'plugin', 'src'), 'in-subfolder');
  putTranscript(claudeHome, path.join(repo.root, '.claude', 'worktrees', 'gone'), 'in-removed-worktree');
  const found = findTranscripts(locateRepo(repo.root), { env: { CLAUDE_CONFIG_DIR: claudeHome, HOME: repo.base } });
  assert.deepEqual(found.map(({ sessionId, kind }) => [sessionId, kind]), [
    ['in-repo', 'repository'], ['in-removed-worktree', 'subfolder'], ['in-subfolder', 'subfolder'],
  ]);
});

test('messages the tool injects, or another session sends, are not the person\'s prompts', () => {
  const records = [
    userText('i1', 1, '<task-notification>\n<task-id>abc</task-id>\n<status>completed</status>\n</task-notification>', { origin: { kind: 'task-notification' }, promptSource: 'system', turnOrigin: 'task_notification' }),
    userText('i2', 2, '<system-reminder>\nThe user started your proposal.\n</system-reminder>', { promptSource: 'sdk', turnOrigin: 'sdk' }),
    userText('i3', 3, 'A report from another session.', { turnOrigin: 'peer' }),
    userText('i4', 4, 'Scheduled check-in.', { origin: { kind: 'scheduled' } }),
    userText('i5', 5, 'Typed by the person.', { origin: { kind: 'human' }, promptSource: 'sdk', turnOrigin: 'human' }),
    userText('i6', 6, 'An older transcript, with no origin fields.'),
  ];
  const { items, skipped } = toPayloads(records, { sessionId: 's' });
  assert.deepEqual(items.map((item) => item.payload.prompt), ['Typed by the person.', 'An older transcript, with no origin fields.']);
  assert.deepEqual(skipped, { notification: 1, reminder: 1, peer_message: 1, 'origin:scheduled': 1 });
});
