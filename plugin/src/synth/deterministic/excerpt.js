'use strict';

const { stripReminders } = require('../../core/text.js');

/** Escapes what could break a Markdown page from inside a list item. */
const escapeMarkdown = (text) => text.replace(/([\\`*_[\]<>|~])/g, '\\$1');

/** One short, safe line: no system reminders, no line breaks, no live Markdown. */
function excerpt(text, max = 280) {
  const flat = stripReminders(String(text ?? '')).replace(/\s+/g, ' ').trim();
  const cut = flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
  let out = escapeMarkdown(cut);
  // Escaping can lengthen the text; trim again without splitting an escape.
  while (out.length > max) {
    out = out.slice(0, max - 1);
    if (out.endsWith('\\')) out = out.slice(0, -1);
    out += '…';
  }
  return out;
}

/** An identifier, path, or URL as a code span, which shows it exactly and cannot break the page. */
const code = (text) => `\`${String(text ?? '').replace(/[`\r\n]/g, '')}\``;

module.exports = { excerpt, escapeMarkdown, code };
