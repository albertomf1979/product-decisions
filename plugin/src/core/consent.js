'use strict';

// The consent text, shared by init and the worker: publication needs consent to the
// text in force, so a changed text is asked again before anything leaves the machine.

const crypto = require('node:crypto');

const CONSENT = `product-decisions records your agent sessions in this repository.

What is recorded: your prompts, agent responses, and tool inputs and results in
full, including files the agent reads, plus your Git user name. Secrets are
redacted by pattern, which is not perfect. When a tool names a file such as
.env, its content is not stored, but content printed indirectly can be.

Where it goes: first to .git/product-decisions on this machine. Readable documents
are then published to the branch product-decisions/docs for anyone who can read
this repository. The full record goes to its own branch only if every place this
repository pushes to is verified private. In a public repository it stays on this
machine. Nothing is pushed if you activate with --no-push.

Change your mind at any time with: product-decisions pause`;

const CONSENT_SHA = crypto.createHash('sha256').update(CONSENT).digest('hex');

/** Whether this person accepted the current text. */
const consentIsCurrent = (state) => Boolean(state && state.consent_sha === CONSENT_SHA);

/** Whether the worker may push for this person: current consent and pushing on. */
const mayPush = (state) => consentIsCurrent(state) && state.push_enabled === true;

module.exports = { CONSENT, CONSENT_SHA, consentIsCurrent, mayPush };
