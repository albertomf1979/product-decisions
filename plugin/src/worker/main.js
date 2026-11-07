'use strict';

const { enqueue, takePending, finishJob, acquireLock } = require('./queue.js');

/**
 * Runs every pending job, then publishes once if any job asked for it. A failing job
 * stays pending for the next run and does not stop the others.
 *
 * @param {{ commonDir: string, jobs: { turn: Function, publish: Function, recover: Function }, log?: Function }} options
 */
async function runWorker({ commonDir, jobs, log = () => {} }) {
  const release = acquireLock(commonDir);
  if (!release) return;
  const failed = new Set();
  let publish = false;
  try {
    for (let round = 0; round < 50; round += 1) {
      const pending = takePending(commonDir).filter((job) => !failed.has(job.file + job.raw));
      if (pending.length === 0) break;
      for (const job of pending) {
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
    if (publish) {
      try {
        await jobs.publish({ commonDir });
      } catch (err) {
        log(err);
      }
    }
  } finally {
    release();
  }
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
