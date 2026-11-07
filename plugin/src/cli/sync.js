'use strict';

const { readLocal } = require('../core/state.js');
const { mayPush, consentIsCurrent } = require('../core/consent.js');
const { UsageError, requireRepo } = require('./shared.js');
const project = require('./project.js');

const PHRASES = {
  docs: { published: 'Documents published.', local: 'Documents committed on this machine only.', pending: 'Documents could not be pushed yet; they will be retried.' },
  raw: { published: 'Raw record published.', local: 'Raw record kept on this machine.', pending: 'Raw record could not be pushed yet; it will be retried.' },
};

/**
 * Processes the sessions that were never finished (no seal after their last event),
 * then publishes. Finished sessions are left as they are: they must not collect work
 * done after them.
 */
async function sync({ cwd, flags }) {
  const location = requireRepo(cwd);
  const state = readLocal(location.commonDir);
  if (!state || !state.activated) throw new UsageError('product-decisions is not active in this repository. Run: product-decisions init');
  const declared = project.findDeclaration(location.mainRoot);
  if (!declared) throw new UsageError('This project is not declared yet. Run: product-decisions init');

  // The worker may be running; wait for it rather than race it.
  const { withLock } = require('../worker/queue.js');
  const outcome = await withLock(location.commonDir, async () => {
    const adopted = project.materialize(location, declared);
    if (adopted.blocked) throw new UsageError(`The team's documents use the folder name "${adopted.config.folder}", but a path with that name already exists here. Move it aside, then run sync again.`);
    project.adopt(location, declared);
    const { runTurn, recoverSessions } = require('../worker/turn.js');
    for (const job of await recoverSessions({ commonDir: location.commonDir })) await runTurn(job, { commonDir: location.commonDir });
    const push = !flags.noPush && mayPush(state);
    const result = await require('../worker/publish.js').publish({ commonDir: location.commonDir, push });
    return { result, rejected: [...new Set([...adopted.rejected, ...(result.rejected || [])])] };
  });
  if (!outcome.ran) throw new UsageError('The background worker is busy. Try again in a moment.');
  const { result, rejected } = outcome.value;
  if (!result) throw new UsageError('This repository could not be matched to its product-decisions store. Run: product-decisions init');
  const config = require('../core/config.js').readConfig(location.commonDir);
  const notice = project.rejectionNotice(rejected, config);
  if (notice) console.log(notice);
  console.log(PHRASES.docs[result.docs]);
  if (result.remote) console.log(`${PHRASES.raw[result.raw]}${result.raw === 'local' ? ` Repository visibility: ${result.visibility}.` : ''}`);
  else if (!require('../worker/publish.js').remoteOf(location.mainRoot)) console.log('No remote: nothing is shared.');
  else if (flags.noPush) console.log('Nothing was pushed (--no-push).');
  else if (!mayPush(state)) {
    console.log(consentIsCurrent(state)
      ? 'Publishing from this machine is off, so nothing was pushed. Run init without --no-push to turn it on.'
      : 'The consent text has changed, so nothing was pushed. Run init to read and accept it.');
  } else console.log('No remote: nothing is shared.');
  for (const warning of result.warnings) {
    if (warning === 'raw_ref_public') console.log('Warning: this repository is public and already holds a published raw record. See the README for how to remove it.');
  }
  console.log(`The folder ${config.folder}/ is up to date.`);
  return 0;
}

module.exports = { sync };
