'use strict';

// Jobs for the detached worker. One small file per session holds only what the worker
// needs to find the session: never prompt or response text.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { storeDir } = require('../core/state.js');

const RANK = { turn: 1, close: 2 };
const safeName = (value) => String(value ?? '').replace(/[^A-Za-z0-9_-]/g, '_') || 'unknown';
const stateDir = (commonDir) => path.join(storeDir(commonDir), 'state');
const pendingDir = (commonDir) => path.join(stateDir(commonDir), 'pending');

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function writeAtomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(temp, content, { mode: 0o600 });
  fs.renameSync(temp, file);
}

/**
 * Queues work for a session, or a recovery pass when `kind` is "recover".
 * A close job is never downgraded to a turn job.
 *
 * @param {string} commonDir
 * @param {{ kind: 'turn' | 'close' | 'recover', tool?: string, sessionId?: string, cwd?: string, transcriptPath?: string }} job
 */
function enqueue(commonDir, job) {
  const recover = job.kind === 'recover';
  const file = path.join(pendingDir(commonDir), recover ? 'recover.json' : `${safeName(job.tool)}-${safeName(job.sessionId)}.json`);
  const record = recover
    ? { kind: 'recover' }
    : { kind: job.kind, tool: job.tool, sessionId: job.sessionId, cwd: job.cwd ?? null, transcriptPath: job.transcriptPath ?? null };
  if (!recover) {
    try {
      const current = JSON.parse(readText(file));
      if (RANK[current.kind] > RANK[record.kind]) record.kind = current.kind;
    } catch {
      // Nothing queued yet.
    }
  }
  // The nonce makes a job queued again look different from the one already taken.
  writeAtomic(file, JSON.stringify({ ...record, nonce: crypto.randomBytes(6).toString('hex') }));
}

/** @returns {Array<object>} Every pending job, each with the file and text it came from. */
function takePending(commonDir) {
  let names;
  try {
    names = fs.readdirSync(pendingDir(commonDir)).filter((name) => name.endsWith('.json')).sort();
  } catch {
    return [];
  }
  const jobs = [];
  for (const name of names) {
    const raw = readText(path.join(pendingDir(commonDir), name));
    try {
      jobs.push({ ...JSON.parse(raw), file: name, raw });
    } catch {
      // A file still being renamed into place; the next round sees it.
    }
  }
  return jobs;
}

/** Removes a job, unless it was queued again while it ran. */
function finishJob(commonDir, job) {
  const file = path.join(pendingDir(commonDir), job.file);
  if (readText(file) === job.raw) fs.rmSync(file, { force: true });
}

function isAlive(pid) {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function isStale(text, mtimeMs, staleMs) {
  try {
    const { pid } = JSON.parse(text);
    return Date.now() - mtimeMs > staleMs || !isAlive(pid);
  } catch {
    return true;
  }
}

function tokenOf(text) {
  try {
    return JSON.parse(text).token || null;
  } catch {
    return null;
  }
}

/**
 * Moves a stale lock aside. Only one contender can rename it; if what was moved is no
 * longer the lock judged stale, someone took it meanwhile, and it is put back.
 *
 * @returns {boolean} Whether the stale lock is gone.
 */
function clearStale(lock, judged) {
  const aside = `${lock}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.stale`;
  try {
    fs.renameSync(lock, aside);
  } catch {
    return false;
  }
  if (readText(aside) !== judged) {
    try {
      fs.linkSync(aside, lock);
    } catch {
      // Someone holds the lock again: theirs stands.
    }
    fs.rmSync(aside, { force: true });
    return false;
  }
  fs.rmSync(aside, { force: true });
  return true;
}

/**
 * Takes the worker lock. The returned release removes the lock only while it is still
 * this holder's, and its `refresh` keeps a long run from looking stale.
 *
 * @returns {((() => void) & { refresh: () => void }) | null} Null when another live holder has it.
 */
function acquireLock(commonDir, { staleMs = 600000 } = {}) {
  const lock = path.join(stateDir(commonDir), 'worker.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
  const token = crypto.randomBytes(8).toString('hex');
  const owned = () => tokenOf(readText(lock)) === token;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(lock, 'wx', 0o600);
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now(), token }));
      fs.closeSync(fd);
      const release = () => {
        if (owned()) fs.rmSync(lock, { force: true });
      };
      release.refresh = () => {
        if (!owned()) return;
        const now = new Date();
        try {
          fs.utimesSync(lock, now, now);
        } catch {
          // The next refresh tries again.
        }
      };
      return release;
    } catch (err) {
      if (err.code !== 'EEXIST') return null;
      const text = readText(lock);
      let mtimeMs = Date.now();
      try {
        mtimeMs = fs.statSync(lock).mtimeMs;
      } catch {
        continue; // Released meanwhile: try again.
      }
      if (text === null || !isStale(text, mtimeMs, staleMs) || !clearStale(lock, text)) return null;
    }
  }
  return null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs `work` while holding the worker lock, waiting for a running worker first.
 *
 * @returns {Promise<{ ran: boolean, value?: unknown }>} ran is false when the lock never came free.
 */
async function withLock(commonDir, work, { waitMs = 30000 } = {}) {
  let release = null;
  for (let waited = 0; !release; waited += 250) {
    release = acquireLock(commonDir);
    if (release) break;
    if (waited >= waitMs) return { ran: false };
    await sleep(250);
  }
  try {
    return { ran: true, value: await work(release) };
  } finally {
    release();
  }
}

module.exports = { enqueue, takePending, finishJob, acquireLock, withLock };
