'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { enqueue, takePending, finishJob, acquireLock } = require('../plugin/src/worker/queue.js');
const { runWorker } = require('../plugin/src/worker/main.js');
const { makeRepo } = require('./helpers/repo.js');

function common(t) {
  const { root, cleanup } = makeRepo();
  t.after(cleanup);
  return path.join(root, '.git');
}
const job = (over = {}) => ({ tool: 'claude-code', sessionId: 's1', cwd: '/p', transcriptPath: '/t.jsonl', kind: 'turn', ...over });

test('enqueue writes one small file per session', (t) => {
  const dir = common(t);
  enqueue(dir, job());
  enqueue(dir, job({ sessionId: 's2' }));
  enqueue(dir, job());
  const jobs = takePending(dir);
  assert.equal(jobs.length, 2);
  assert.deepEqual(jobs.map((j) => j.sessionId).sort(), ['s1', 's2']);
});

test('a close job is not downgraded by a later turn job', (t) => {
  const dir = common(t);
  enqueue(dir, job({ kind: 'close' }));
  enqueue(dir, job({ kind: 'turn' }));
  assert.equal(takePending(dir)[0].kind, 'close');
});

test('a recover job belongs to no session', (t) => {
  const dir = common(t);
  enqueue(dir, { kind: 'recover' });
  enqueue(dir, { kind: 'recover' });
  const jobs = takePending(dir);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].kind, 'recover');
});

test('pending files hold only the job fields, never prompt or response text', (t) => {
  const dir = common(t);
  enqueue(dir, { ...job(), prompt: 'SECRET-PROMPT', last_assistant_message: 'SECRET-REPLY' });
  const files = fs.readdirSync(path.join(dir, 'product-decisions', 'state', 'pending'));
  const text = files.map((f) => fs.readFileSync(path.join(dir, 'product-decisions', 'state', 'pending', f), 'utf8')).join('');
  assert(!text.includes('SECRET'));
});

test('a session id cannot escape the pending folder', (t) => {
  const dir = common(t);
  enqueue(dir, job({ sessionId: '../../evil' }));
  assert.equal(fs.readdirSync(path.join(dir, 'product-decisions', 'state', 'pending')).length, 1);
});

test('finishJob keeps a job that was queued again while it ran', (t) => {
  const dir = common(t);
  enqueue(dir, job());
  const [taken] = takePending(dir);
  enqueue(dir, job({ kind: 'close' }));
  finishJob(dir, taken);
  assert.equal(takePending(dir)[0].kind, 'close');
});

test('only one worker holds the lock', (t) => {
  const dir = common(t);
  const release = acquireLock(dir);
  assert.equal(typeof release, 'function');
  assert.equal(acquireLock(dir), null);
  release();
  const again = acquireLock(dir);
  assert.equal(typeof again, 'function');
  again();
});

test('a stale lock is taken over', (t) => {
  const dir = common(t);
  const lock = path.join(dir, 'product-decisions', 'state', 'worker.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, JSON.stringify({ pid: 999999, at: 0 }));
  const old = new Date(Date.now() - 3600 * 1000);
  fs.utimesSync(lock, old, old);
  const release = acquireLock(dir, { staleMs: 1000 });
  assert.equal(typeof release, 'function');
  release();
});

test('a lock held by a live process is respected', (t) => {
  const dir = common(t);
  const lock = path.join(dir, 'product-decisions', 'state', 'worker.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now() }));
  assert.equal(acquireLock(dir), null);
});

test('runWorker runs turn jobs and publishes after a close job', async (t) => {
  const dir = common(t);
  const seen = [];
  enqueue(dir, job({ kind: 'turn' }));
  enqueue(dir, job({ sessionId: 's2', kind: 'close' }));
  await runWorker({ commonDir: dir, jobs: { turn: async (j) => seen.push(j.sessionId), publish: async () => seen.push('publish'), recover: async () => [] } });
  assert.deepEqual(seen.slice(0, 2).sort(), ['s1', 's2']);
  assert.equal(seen[2], 'publish');
  assert.equal(takePending(dir).length, 0);
});

test('a turn job alone does not publish', async (t) => {
  const dir = common(t);
  let published = false;
  enqueue(dir, job());
  await runWorker({ commonDir: dir, jobs: { turn: async () => {}, publish: async () => { published = true; }, recover: async () => [] } });
  assert.equal(published, false);
});

test('a job that fails stays pending and does not stop the others', async (t) => {
  const dir = common(t);
  const seen = [];
  enqueue(dir, job({ sessionId: 'bad' }));
  enqueue(dir, job({ sessionId: 'good' }));
  await runWorker({
    commonDir: dir,
    jobs: { turn: async (j) => { if (j.sessionId === 'bad') throw new Error('boom'); seen.push(j.sessionId); }, publish: async () => {}, recover: async () => [] },
  });
  assert.deepEqual(seen, ['good']);
  assert.deepEqual(takePending(dir).map((j) => j.sessionId), ['bad']);
});

test('a job queued during a run is picked up before the worker exits', async (t) => {
  const dir = common(t);
  const seen = [];
  enqueue(dir, job({ sessionId: 'first' }));
  await runWorker({
    commonDir: dir,
    jobs: {
      turn: async (j) => { seen.push(j.sessionId); if (j.sessionId === 'first') enqueue(dir, job({ sessionId: 'second' })); },
      publish: async () => {},
      recover: async () => [],
    },
  });
  assert.deepEqual(seen, ['first', 'second']);
});

test('a worker killed mid-run leaves its jobs pending for the next run', async (t) => {
  const dir = common(t);
  enqueue(dir, job());
  takePending(dir); // taken, never finished: what a killed worker leaves behind
  const seen = [];
  await runWorker({ commonDir: dir, jobs: { turn: async (j) => seen.push(j.sessionId), publish: async () => {}, recover: async () => [] } });
  assert.deepEqual(seen, ['s1']);
});

test('a recover job runs recovery, the jobs it finds, and a publish', async (t) => {
  const dir = common(t);
  const seen = [];
  enqueue(dir, { kind: 'recover' });
  await runWorker({
    commonDir: dir,
    jobs: { recover: async () => [job({ sessionId: 'orphan', kind: 'close' })], turn: async (j) => seen.push(j.sessionId), publish: async () => seen.push('publish') },
  });
  assert.deepEqual(seen, ['orphan', 'publish']);
});

test('the worker does nothing while another holds the lock', async (t) => {
  const dir = common(t);
  const release = acquireLock(dir);
  enqueue(dir, job());
  let ran = false;
  await runWorker({ commonDir: dir, jobs: { turn: async () => { ran = true; }, publish: async () => {}, recover: async () => [] } });
  assert.equal(ran, false);
  release();
});

test('after a close the worker publishes, synthesizes, and publishes again only when something was created', async (t) => {
  for (const [created, expected] of [[1, ['s2', 'publish', 'synthesize', 'publish']], [0, ['s2', 'publish', 'synthesize']]]) {
    const dir = common(t);
    const seen = [];
    enqueue(dir, job({ sessionId: 's2', kind: 'close' }));
    await runWorker({
      commonDir: dir,
      jobs: {
        turn: async (j) => seen.push(j.sessionId),
        publish: async () => seen.push('publish'),
        recover: async () => [],
        synthesize: async ({ commonDir, refresh }) => {
          assert.equal(commonDir, dir);
          assert.equal(typeof refresh, 'function');
          seen.push('synthesize');
          return { decisions: created, notes: 0 };
        },
      },
    });
    assert.deepEqual(seen, expected);
  }
});

test('a turn job alone does not synthesize', async (t) => {
  const dir = common(t);
  let synthesized = false;
  enqueue(dir, job());
  await runWorker({ commonDir: dir, jobs: { turn: async () => {}, publish: async () => {}, recover: async () => [], synthesize: async () => { synthesized = true; return null; } } });
  assert.equal(synthesized, false);
});

test('jobs queued while synthesis ran are processed before the worker exits', async (t) => {
  const dir = common(t);
  const seen = [];
  enqueue(dir, job({ sessionId: 's1', kind: 'close' }));
  await runWorker({
    commonDir: dir,
    jobs: {
      turn: async (j) => seen.push(j.sessionId),
      publish: async () => seen.push('publish'),
      recover: async () => [],
      synthesize: async () => {
        seen.push('synthesize');
        if (!seen.includes('s3')) enqueue(dir, job({ sessionId: 's3' }));
        return { decisions: 0, notes: 0 };
      },
    },
  });
  assert.deepEqual(seen, ['s1', 'publish', 'synthesize', 's3']);
  assert.equal(takePending(dir).length, 0);
});
