'use strict';

const { enqueue, takePending, finishJob, acquireLock } = require('./queue.js');

const PASSES = 3;

/**
 * Runs every pending job, then publishes once if any job asked for it. After a close,
 * LLM synthesis runs and, if it created files, publishes again. Jobs queued meanwhile
 * get another pass before the worker exits. A failing job stays pending for the next
 * run and does not stop the others.
 *
 * @param {{ commonDir: string, jobs: { turn: Function, publish: Function, recover: Function, synthesize?: Function }, log?: Function }} options
 */
async function runWorker({ commonDir, jobs, log = () => {} }) {
  const release = acquireLock(commonDir);
  if (!release) return;
  const failed = new Set();
  const waiting = () => takePending(commonDir).some((job) => !failed.has(job.file + job.raw));
  try {
    for (let pass = 0; pass < PASSES; pass += 1) {
      if (!(await runPass({ commonDir, jobs, log, release, failed })) || !waiting()) break;
    }
  } finally {
    release();
  }
}

/** One pass: the queue, then publication and synthesis when a session closed. */
async function runPass({ commonDir, jobs, log, release, failed }) {
  let publish = false;
  let ran = false;
  for (let round = 0; round < 50; round += 1) {
    const pending = takePending(commonDir).filter((job) => !failed.has(job.file + job.raw));
    if (pending.length === 0) break;
    ran = true;
    for (const job of pending) {
      release.refresh();
      try {
        if (job.kind === 'recover') {
          for (const found of await jobs.recover({ commonDir })) enqueue(commonDir, found);
          publish = true;
        } else {
          await jobs.turn(job, { commonDir });
          if (job.kind === 'close') publish = true;
        }
        finishJob(commonDir, job);
      } catch (err) {
        failed.add(job.file + job.raw);
        log(err);
      }
    }
  }
  if (!publish) return ran;
  release.refresh();
  try {
    await jobs.publish({ commonDir });
  } catch (err) {
    log(err);
  }
  if (!jobs.synthesize) return ran;
  try {
    const made = await jobs.synthesize({ commonDir, refresh: release.refresh });
    if (made && made.decisions + made.notes > 0) {
      release.refresh();
      await jobs.publish({ commonDir });
    }
  } catch (err) {
    log(err);
  }
  return ran;
}

module.exports = { runWorker };

if (require.main === module) {
  // Same silence as the hook: nothing this process does may surface anywhere.
  const done = () => process.exit(0);
  process.stdout.write = () => true;
  process.stderr.write = () => true;
  process.on('uncaughtException', done);
  process.on('unhandledRejection', done);
  const commonDir = process.argv[2];
  const { logError } = require('../core/diagnostics.js');
  runWorker({ commonDir, jobs: require('./jobs.js'), log: (err) => logError(commonDir, 'worker', err) }).then(done, done);
}
