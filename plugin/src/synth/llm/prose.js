'use strict';

const { redactString } = require('../../core/redact.js');

/**
 * Model text made safe for a Markdown file anyone can read: redacted like the record,
 * no HTML, no remote images (which a prompt injection could use to send data out), and
 * no line that could pose as one of the template's headings.
 */
function sanitizeProse(text, { extra = [], home = null } = {}) {
  return redactString(String(text ?? ''), extra, home)
    .replace(/\r\n?/g, '\n')
    .replace(/<\/?[A-Za-z][^>]*>/g, '')
    .replace(/!\[([^\]]*)\]\(([^)]*)\)/g, '$1 ($2)')
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
