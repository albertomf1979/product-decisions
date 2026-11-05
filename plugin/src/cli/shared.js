'use strict';

const { locateRepo } = require('../core/locate.js');
const { readGit } = require('../core/githead.js');
const { buildEvent } = require('../core/event.js');
const { rawFilePath, appendLine } = require('../core/store.js');

/** Thrown for failures the person can act on. Its message is shown as is. */
class UsageError extends Error {}

/** @returns {NonNullable<ReturnType<typeof locateRepo>>} */
function requireRepo(cwd) {
  const location = locateRepo(cwd);
  if (!location) throw new UsageError('Not inside a Git repository. product-decisions needs one.');
  return location;
}

/** Records an event that belongs to no session, such as consent or a gap. */
function appendLocalEvent(location, state, cwd, { eventType, summary, payload }) {
  const event = buildEvent(
    { eventType, actorType: 'user', agent: { name: 'main' }, payload },
    {
      tool: 'cli',
      sessionId: 'local',
      actorName: state.actor_name,
      git: readGit(location, cwd),
      sources: [],
      summary,
    },
  );
  appendLine(rawFilePath(location.commonDir, 'cli', 'local', state.machine), JSON.stringify(event));
}

module.exports = { UsageError, requireRepo, appendLocalEvent };
