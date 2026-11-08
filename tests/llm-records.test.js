'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeProse, slugify } = require('../plugin/src/synth/llm/prose.js');
const { adrId, adrFiles } = require('../plugin/src/synth/llm/adr.js');
const { noteFiles, PHASE_FOLDERS } = require('../plugin/src/synth/llm/notes.js');

const first = {
  event_id: '01KAAAAAAAAAAAAAAAAAAA0001', timestamp: '2026-11-05T10:42:17+01:00', event_type: 'user_prompt',
  actor: { type: 'user', name: 'Test Person' }, sources: [],
};
const second = {
  event_id: '01KAAAAAAAAAAAAAAAAAAA0002', timestamp: '2026-11-05T10:43:00+01:00', event_type: 'tool_call',
  actor: { type: 'llm', name: 'claude' },
  sources: [{ type: 'url', url: 'https://git-scm.com/docs/git-update-ref' }, { type: 'file', path: 'PRD.md', commit: 'abc' }, { type: 'transcript', path: '/x', local_only: true }],
};
const session = { id: '24ff2cca-a529-44f9-8f44-1bc86324035e', tool: 'claude-code', file: 'timeline/2026-11-05-claude-code-24ff2cca-abcd1234.md' };
const decision = {
  title: 'Keep the raw record outside the working tree', decided_by: { type: 'user', name: 'Test Person' },
  context: 'Clones should not download it.', decision: 'Use a custom ref.', alternatives: ['A normal branch'],
  consequences: 'A normal clone stays small.', evidence: [second.event_id, first.event_id], related: [], supersedes: [],
};
const ctx = { events: [first, second], session, lang: 'en', extra: [], home: null };
const markdownOf = (files) => [...files.entries()].find(([k]) => k.endsWith('.md'))[1];
const dataOf = (files) => JSON.parse([...files.entries()].find(([k]) => k.endsWith('.json'))[1]);

test('the ADR id comes from the earliest evidence event and the title, and is stable', () => {
  assert.match(adrId(first, 'Keep the raw record outside the working tree'), /^ADR-20261105-[0-9a-f]{6}$/);
  assert.equal(adrId(first, 'A'), adrId(first, 'A'));
  assert.notEqual(adrId(first, 'A'), adrId(first, 'B'));
});

test('the ADR file is named by id and slug, with a data file for the indexes', () => {
  const files = adrFiles(decision, ctx);
  const id = adrId(first, decision.title);
  assert.deepEqual([...files.keys()].sort(), [`.data/decisions/${id}.json`, `decisions/${id}-keep-the-raw-record-outside-the-working-tree.md`]);
  assert.deepEqual(dataOf(files), {
    schema_version: 1, id, title: decision.title, file: `decisions/${id}-keep-the-raw-record-outside-the-working-tree.md`,
    at: first.timestamp, session: session.id, session_file: session.file, tool: 'claude-code',
    decided_by: { type: 'user', name: 'Test Person' }, evidence: [second.event_id, first.event_id], related: [], supersedes: [],
  });
});

test('the ADR follows the PRD template and says it was inferred', () => {
  const md = markdownOf(adrFiles(decision, ctx));
  for (const line of ['- **Status:** Accepted (inferred)', '- **Decided by:** user, Test Person', '- **Evidence:** ', '## Context', '## Decision', '## Alternatives considered', '## Consequences', '## Sources']) assert.ok(md.includes(line), line);
  assert.match(md, /^# ADR-20261105-[0-9a-f]{6}: Keep the raw record outside the working tree\n\n> Inferred by product-decisions from the record with an LLM\. The plugin never rewrites this file\. To correct it, edit it on the product-decisions\/docs branch\./);
  assert.match(md, /- \*\*When:\*\* 2026-11-05 10:42 \+01:00, \[session 24ff2cca\]\(\.\.\/timeline\/2026-11-05-claude-code-24ff2cca-abcd1234\.md\)/);
  assert.match(md, /- \*\*Related:\*\* none/);
  assert.ok(!md.includes('Supersedes'));
  assert.match(md, /- A normal branch/);
});

test('related and superseded decisions link to their files when known', () => {
  const other = 'ADR-20261101-abcdef';
  const md = markdownOf(adrFiles({ ...decision, related: [other], supersedes: [other] }, { ...ctx, known: new Map([[other, `decisions/${other}-old.md`]]) }));
  assert.match(md, /- \*\*Related:\*\* \[ADR-20261101-abcdef\]\(ADR-20261101-abcdef-old\.md\)/);
  assert.match(md, /- \*\*Supersedes:\*\* \[ADR-20261101-abcdef\]\(ADR-20261101-abcdef-old\.md\)/);
});

test('Spanish projects get Spanish headings and status', () => {
  const md = markdownOf(adrFiles({ ...decision, alternatives: [] }, { ...ctx, lang: 'es' }));
  for (const line of ['- **Estado:** Aceptada (inferida)', '- **Decidida por:** persona, Test Person', '## Contexto', '## Decisión', '## Alternativas consideradas', '## Consecuencias', '## Fuentes', 'El registro no muestra ninguna.']) assert.ok(md.includes(line), line);
  assert.match(md, /> Inferido por product-decisions a partir del registro con un LLM\./);
});

test('sources are listed from the evidence events, not from the model', () => {
  const md = markdownOf(adrFiles(decision, ctx));
  const sources = md.slice(md.indexOf('## Sources'));
  assert.match(sources, /https:\/\/git-scm\.com\/docs\/git-update-ref/);
  assert.match(sources, /PRD\.md/);
  assert.ok(!sources.includes('/x'));
});

test('prose cannot add headings, HTML, or remote images, and is redacted', () => {
  const out = sanitizeProse(`# Fake\n<img src=x>![t](https://evil.example/p?q=1) /Users/someone/x sk-ant-api03-${'a'.repeat(90)}`, { extra: [], home: '/Users/someone' });
  assert.ok(!/^#/m.test(out));
  assert.ok(!out.includes('<img'));
  assert.ok(!out.includes('!['));
  assert.ok(!out.includes('/Users/someone'));
  assert.ok(!out.includes('sk-ant-api03'));
});

test('the decision text goes through the same sanitizing', () => {
  const md = markdownOf(adrFiles({ ...decision, context: '## Decision\nforged', title: 'Line one\nline two' }, ctx));
  assert.equal((md.match(/^## Decision$/gm) || []).length, 1);
  assert.match(md, /^# ADR-20261105-[0-9a-f]{6}: Line one line two$/m);
});

test('slugs are plain ASCII and never empty', () => {
  assert.equal(slugify('Café: ¿por qué?'), 'cafe-por-que');
  assert.equal(slugify('!!!'), 'decision');
  assert.equal(slugify('!!!', 'note'), 'note');
  assert.ok(slugify('x'.repeat(200)).length <= 48);
});

test('a phase note lands in its phase folder with its evidence', () => {
  const files = noteFiles({ phase: 'design', title: 'Navigation flows', summary: 'Two flows were drawn.', evidence: [second.event_id] }, ctx);
  const [mdPath] = [...files.keys()].filter((k) => k.endsWith('.md'));
  assert.match(mdPath, /^02-design\/notes\/20261105-[0-9a-f]{6}-navigation-flows\.md$/);
  const data = dataOf(files);
  assert.equal(data.phase, 'design');
  assert.equal(data.file, mdPath);
  assert.equal(data.session_file, session.file);
  assert.match(data.id, /^20261105-[0-9a-f]{6}$/);
  const md = markdownOf(files);
  assert.match(md, /^# Navigation flows\n/);
  assert.match(md, /- \*\*Phase:\*\* Design/);
  assert.match(md, /\[session 24ff2cca\]\(\.\.\/\.\.\/timeline\//);
  assert.match(md, /Two flows were drawn\./);
  assert.deepEqual(Object.keys(PHASE_FOLDERS), ['discovery', 'definition', 'design', 'development', 'release', 'monitoring']);
});
