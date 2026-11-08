'use strict';

// Tests must never reach a real `claude` or `codex`: CI has no login, and on a developer's machine a
// real one would spend that person's quota. Every helper that runs plugin code loads this
// file, so synthesis, and any worker a hook starts, finds no engine unless a test points
// PRODUCT_DECISIONS_CLAUDE_BIN at the fake.

const path = require('node:path');

const NO_CLAUDE = path.join(__dirname, 'no-claude-in-tests');
// Unconditional: a developer may have exported the real path, as sync --llm advises.
process.env.PRODUCT_DECISIONS_CLAUDE_BIN = NO_CLAUDE;
const NO_CODEX = path.join(__dirname, 'no-codex-in-tests');
process.env.PRODUCT_DECISIONS_CODEX_BIN = NO_CODEX;
// status reads the first line of recent Codex rollouts: never the developer's own.
process.env.CODEX_HOME = path.join(__dirname, 'no-codex-home-in-tests');

module.exports = { NO_CLAUDE, NO_CODEX };
