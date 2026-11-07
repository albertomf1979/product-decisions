'use strict';

const OPEN = '<system-reminder>';
const CLOSE = '</system-reminder>';

/**
 * Removes system reminders that apps add to prompts. A loop, not a regex, so text
 * with many unclosed tags stays linear. An unclosed tag is left as it is.
 */
function stripReminders(text) {
  const source = String(text);
  let out = '';
  let from = 0;
  for (;;) {
    const open = source.indexOf(OPEN, from);
    const close = open < 0 ? -1 : source.indexOf(CLOSE, open + OPEN.length);
    if (close < 0) return out + source.slice(from);
    out += source.slice(from, open);
    from = close + CLOSE.length;
  }
}

/** One line of at most `max` characters. */
const oneLine = (text, max = 80) => String(text).replace(/\s+/g, ' ').trim().slice(0, max);

module.exports = { stripReminders, oneLine };
