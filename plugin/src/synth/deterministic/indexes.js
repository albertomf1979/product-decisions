'use strict';

// Indexes rebuilt from every session's data file in the docs tree.

const { escapeMarkdown, excerpt, code } = require('./excerpt.js');
const { t } = require('./i18n.js');
const { renderDecisionViews, readmeSection } = require('./decisions.js');

const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const ordered = (all) => [...all].sort((a, b) => byText(`${a.started} ${a.session} ${a.machine}`, `${b.started} ${b.session} ${b.machine}`));
const people = (data) => data.actors.filter((a) => a.type === 'user').map((a) => escapeMarkdown(a.name)).join(', ');
const label = (data) => `${data.started.slice(0, 10)} ${data.tool} ${String(data.session).slice(0, 8)}`;

function readme(all, documentChanges, lang, decisions = [], notes = []) {
  const out = [
    `# ${t(lang, 'readme_title')}`, '', `> ${t(lang, 'generated_index')}`, '',
    t(lang, 'readme_intro'), '', ...readmeSection(decisions, notes, lang),
    `## ${t(lang, 'sessions')}`, '',
    `| ${t(lang, 'date')} | ${t(lang, 'tool')} | ${t(lang, 'people')} | ${t(lang, 'events')} | ${t(lang, 'chronicle')} |`, '|---|---|---|---|---|',
    ...all.map((d) => `| ${d.started.slice(0, 16).replace('T', ' ')} | ${d.tool} | ${people(d)} | ${d.event_count} | [${String(d.session).slice(0, 8)}](${d.file}) |`),
    '',
  ];
  if (documentChanges.length > 0) {
    out.push(`## ${t(lang, 'document_changes')}`, '', ...documentChanges.map((c) => `- ${c.at.slice(0, 16).replace('T', ' ')} · ${escapeMarkdown(c.path)} · [${escapeMarkdown(c.actor)}](${c.file})`), '');
  }
  out.push(`## ${t(lang, 'more')}`, '', `- [${t(lang, 'changes_title')}](03-development/changes.md)`, `- [${t(lang, 'sources_title')}](sources/README.md)`, '');
  return out.join('\n');
}

function changes(all, lang) {
  const out = [`# ${t(lang, 'changes_title')}`, '', `> ${t(lang, 'generated_index')}`, ''];
  for (const d of all.filter((x) => x.files.length > 0 || x.commits.length > 0)) {
    out.push(`## [${label(d)}](../${d.file})`, '');
    if (d.files.length > 0) {
      out.push(`| ${t(lang, 'file')} | ${t(lang, 'change')} | ${t(lang, 'lines')} |`, '|---|---|---|');
      for (const f of d.files) out.push(`| ${code(f.path)} | ${t(lang, `status_${f.status}`)} | ${f.added === null ? '' : `+${f.added} −${f.removed}`} |`);
      out.push('');
    }
    for (const c of d.commits) out.push(`- \`${String(c.sha).slice(0, 7)}\` ${excerpt(c.subject, 120)}`);
    if (d.commits.length > 0) out.push('');
  }
  return out.join('\n');
}

const GROUPS = [
  ['file', 'files', (s) => code(s.path)],
  ['url', 'urls', (s) => code(s.url)],
  ['mcp', 'mcp', (s) => `${code(s.server)} · ${code(s.tool)}`],
  ['issue', 'issues', (s) => code(s.url)],
  ['pr', 'prs', (s) => code(s.url)],
];

function sources(all, lang) {
  const out = [`# ${t(lang, 'sources_title')}`, '', `> ${t(lang, 'generated_index')}`, ''];
  for (const [type, key, show] of GROUPS) {
    const items = new Map();
    for (const d of all) {
      for (const s of d.sources.filter((x) => x.type === type)) {
        const name = show(s);
        if (!items.has(name)) items.set(name, []);
        items.get(name).push({ d, ids: s.event_ids });
      }
    }
    if (items.size === 0) continue;
    out.push(`## ${t(lang, key)}`, '');
    for (const name of [...items.keys()].sort(byText)) {
      const uses = items.get(name).map(({ d, ids }) => `[${label(d)}](../${d.file}) ${ids.map((id) => `\`${id}\``).join(' ')}`);
      out.push(`- ${name}, ${t(lang, 'used_in')}: ${uses.join('; ')}`);
    }
    out.push('');
  }
  return out.join('\n');
}

/**
 * @param {object[]} allSessionData Every .data/sessions/*.json in the merged docs tree.
 * @param {Array<{ at, path, actor, file }>} documentChanges
 * @param {{ decisions?: object[], notes?: object[] }} [generated] Decision and phase note data files.
 * @returns {Map<string, string>}
 */
function renderIndexes(allSessionData, documentChanges, config, { decisions = [], notes = [] } = {}) {
  const all = ordered(allSessionData);
  const docs = [...documentChanges].sort((a, b) => byText(`${a.at} ${a.file}`, `${b.at} ${b.file}`));
  const lang = config.language;
  return new Map([
    ['README.md', `${readme(all, docs, lang, decisions, notes)}\n`],
    ['03-development/changes.md', `${changes(all, lang)}\n`],
    ['sources/README.md', `${sources(all, lang)}\n`],
    ...renderDecisionViews(decisions, notes, all, docs, config),
  ]);
}

module.exports = { renderIndexes };
