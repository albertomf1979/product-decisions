'use strict';

const fs = require('node:fs');

/**
 * Reads the model, tool version, and token usage from the end of a transcript. Both
 * vendors say the format is unstable (PRD CAP-13), so anything unexpected gives null.
 *
 * @returns {{ model: string | null, toolVersion: string | null, usage: object | null } | null}
 */
function readTranscriptTail(file, { maxBytes = 262144 } = {}) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const { size } = fs.fstatSync(fd);
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.toString('utf8').split('\n');
    if (length < size) lines.shift(); // the first line was cut by the window
    let model = null;
    let usage = null;
    let toolVersion = null;
    for (let i = lines.length - 1; i >= 0 && !(model && toolVersion); i -= 1) {
      let record;
      try {
        record = JSON.parse(lines[i]);
      } catch {
        continue;
      }
      const candidate = record && record.type === 'assistant' && record.message && record.message.model;
      // Claude Code writes "<synthetic>" for messages no model produced.
      if (!model && typeof candidate === 'string' && !candidate.startsWith('<')) {
        model = candidate;
        usage = record.message.usage || null;
      }
      if (!toolVersion && record && typeof record.version === 'string') toolVersion = record.version;
    }
    return model || toolVersion ? { model, toolVersion, usage } : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

module.exports = { readTranscriptTail };
