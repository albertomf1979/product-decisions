'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { readLocal, storeDir } = require('../core/state.js');
const { readSessionMeta } = require('../core/store.js');
const { UsageError, requireRepo } = require('./shared.js');
const project = require('./project.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Turn jobs for every session on this machine, so sync brings everything up to date. */
function ownJobs(commonDir, machine, mainRoot) {
  const raw = path.join(storeDir(commonDir), 'raw');
  const jobs = [];
  for (const tool of fs.existsSync(raw) ? fs.readdirSync(raw).filter((name) => name !== 'cli') : []) {
    for (const name of fs.readdirSync(path.join(raw, tool)).filter((n) => n.endsWith(`-${machine}.jsonl`))) {
      const first = fs.readFileSync(path.join(raw, tool, name), 'utf8').split('\n')[0];
      let sessionId;
      try {
        sessionId = JSON.parse(first).session_id;
      } catch {
        continue;
      }
      const meta = readSessionMeta(commonDir, tool, sessionId) || {};
      jobs.push({ kind: 'close', tool, sessionId, cwd: meta.cwd || mainRoot, transcriptPath: meta.transcript_path || null });
    }
  }
  return jobs;
}

const PHRASES = {
  docs: { published: 'Documents published.', local: 'Documents committed on this machine only.', pending: 'Documents could not be pushed yet; they will be retried.' },
  raw: { published: 'Raw record published.', local: 'Raw record kept on this machine.', pending: 'Raw record could not be pushed yet; it will be retried.' },
};

/** Recovers and processes every session, then publishes. */
async function sync({ cwd, flags }) {
  const location = requireRepo(cwd);
  const state = readLocal(location.commonDir);
  if (!state || !state.activated) throw new UsageError('product-decisions is not active in this repository. Run: product-decisions init');
  const declared = project.findDeclaration(location.mainRoot);
  if (!declared) throw new UsageError('This project is not declared yet. Run: product-decisions init');
  project.adopt(location, declared);
  project.materialize(location, declared);

  // The worker may be running; wait for it rather than race it.
  const { acquireLock } = require('../worker/queue.js');
  let release = null;
  for (let waited = 0; !release && waited < 30000; waited += 250) {
    release = acquireLock(location.commonDir);
    if (!release) await sleep(250);
  }
  if (!release) throw new UsageError('The background worker is busy. Try again in a moment.');
  try {
    const { runTurn } = require('../worker/turn.js');
    for (const job of ownJobs(location.commonDir, state.machine, location.mainRoot)) await runTurn(job, { commonDir: location.commonDir });
    const result = await require('../worker/publish.js').publish({ commonDir: location.commonDir, push: !flags.noPush });
    const config = require('../core/config.js').readConfig(location.commonDir);
    console.log(PHRASES.docs[result.docs]);
    if (result.remote) console.log(`${PHRASES.raw[result.raw]}${result.raw === 'local' ? ` Repository visibility: ${result.visibility}.` : ''}`);
    else console.log('No remote: nothing is shared.');
    for (const warning of result.warnings) {
      if (warning === 'raw_ref_public') console.log('Warning: this repository is public and already holds a published raw record. See the README for how to remove it.');
    }
    console.log(`The folder ${config.folder}/ is up to date.`);
  } finally {
    release();
  }
  return 0;
}

module.exports = { sync };
