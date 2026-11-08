'use strict';

const { redactString } = require('../../core/redact.js');

/**
 * Model text made safe for a Markdown file anyone can read: redacted like the record,
 * and neutralised character by character rather than parsed, so nesting cannot rebuild
 * what was removed. No HTML, comments, or autolinks (every `<` is escaped), no images
 * (which a prompt injection could use to send data out: every `![` is escaped, and
 * reference definitions are broken), and no line that could pose as a heading of the
 * template (ATX or setext).
 */
function sanitizeProse(text, { extra = [], home = null } = {}) {
  return redactString(String(text ?? ''), extra, home)
    .replace(/\r\n?/g, '\n')
    .replace(/\\/g, '\\\\')
    .replace(/</g, '\\<')
    .replace(/!\[/g, '\\![')
    .replace(/^(\s{0,3})\[([^\]\n]*)\]:/gm, '$1\\[$2]:')
    .replace(/^(\s{0,3})(=+|-+)(\s*)$/gm, '$1\\$2$3')
    .replace(/^(\s*)#/gm, '$1\\#')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** One line of sanitized prose, for titles. */
const sanitizeLine = (text, options) => sanitizeProse(text, options).replace(/\s+/g, ' ').replace(/^\\#/, '#').trim();

/** A plain ASCII file name part, at most 48 characters, never empty. */
function slugify(title, fallback = 'decision') {
  const slug = String(title ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').slice(0, 48).replace(/^-+|-+$/g, '');
  return slug || fallback;
}

module.exports = { sanitizeProse, sanitizeLine, slugify };
