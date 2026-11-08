'use strict';

// Who accepted which consent text, and when: rebuilt from every machine's consent data
// file, so an audit can answer it from the folder (G8, decided 2026-11-08).

const { escapeMarkdown } = require('./excerpt.js');
const { t } = require('./i18n.js');

const byTime = (a, b) => (Date.parse(a.at) - Date.parse(b.at)) || (a.actor < b.actor ? -1 : a.actor > b.actor ? 1 : 0);

/** @returns {{ section: string[], files: Map<string, string> }} */
function renderConsent(consents, lang) {
  const records = consents.flatMap((c) => c.records).sort(byTime);
  const files = new Map();
  if (records.length === 0) return { section: [], files };
  const section = [
    `## ${t(lang, 'consent_section')}`, '',
    `| ${t(lang, 'consent_person')} | ${t(lang, 'consent_accepted')} | ${t(lang, 'consent_text')} | ${t(lang, 'consent_method')} |`, '|---|---|---|---|',
    ...records.map((r) => `| ${escapeMarkdown(r.actor)} | ${String(r.at).slice(0, 16).replace('T', ' ')} | [${r.version}](consent/${r.version}.md) | ${t(lang, `method_${r.method}`)} |`),
    '',
  ];
  for (const c of consents) {
    for (const [version, text] of Object.entries(c.texts)) {
      if (files.has(`consent/${version}.md`)) continue;
      files.set(`consent/${version}.md`, [`# ${t(lang, 'consent_title', { version })}`, '', `> ${t(lang, 'generated_index')}`, '', '```text', text.replace(/```/g, "'''"), '```', ''].join('\n'));
    }
  }
  return { section, files };
}

module.exports = { renderConsent };
