'use strict';

// Tests must never reach a real `claude`: CI has no login, and on a developer's machine a
// real one would spend that person's quota. Every helper that runs plugin code loads this
// file, so synthesis, and any worker a hook starts, finds no engine unless a test points
// PRODUCT_DECISIONS_CLAUDE_BIN at the fake.

const path = require('node:path');

const NO_CLAUDE = path.join(__dirname, 'no-claude-in-tests');
// Unconditional: a developer may have exported the real path, as sync --llm advises.
process.env.PRODUCT_DECISIONS_CLAUDE_BIN = NO_CLAUDE;

module.exports = { NO_CLAUDE };
