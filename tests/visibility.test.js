'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseGitHub, checkVisibility, rawAllowed } = require('../plugin/src/worker/visibility.js');

const fake = (status, body) => async () => ({ status, body: JSON.stringify(body) });
const memoryCache = () => { const m = new Map(); return { get: (k) => m.get(k), set: (k, v) => m.set(k, v) }; };

test('https and ssh remote forms both parse, with credentials ignored', () => {
  for (const url of ['https://github.com/o/r.git', 'https://github.com/o/r', 'https://user:token@github.com/o/r.git', 'git@github.com:o/r.git', 'ssh://git@github.com/o/r.git']) {
    assert.deepEqual(parseGitHub(url), { owner: 'o', repo: 'r' }, url);
  }
  assert.equal(parseGitHub('https://gitlab.com/o/r.git'), null);
  assert.equal(parseGitHub('/tmp/remote.git'), null);
});

test('public, private, unknown, and rate-limited responses map correctly', async () => {
  const url = 'https://github.com/o/r.git';
  assert.equal(await checkVisibility(url, { request: fake(200, { private: false }), cache: memoryCache() }), 'public');
  assert.equal(await checkVisibility(url, { request: fake(200, { private: true }), cache: memoryCache() }), 'private');
  assert.equal(await checkVisibility(url, { request: fake(404, {}), cache: memoryCache() }), 'private');
  assert.equal(await checkVisibility(url, { request: fake(403, {}), cache: memoryCache() }), 'unknown');
  assert.equal(await checkVisibility(url, { request: async () => { throw new Error('offline'); }, cache: memoryCache() }), 'unknown');
});

test('a non-GitHub host is unknown, and nothing is requested', async () => {
  let asked = false;
  assert.equal(await checkVisibility('https://gitlab.com/o/r.git', { request: async () => { asked = true; return { status: 200, body: '{}' }; }, cache: memoryCache() }), 'unknown');
  assert.equal(asked, false);
});

test('the answer is cached for 24 hours, and the request carries no credentials', async () => {
  const cache = memoryCache();
  const urls = [];
  const request = async (u) => { urls.push(u); return { status: 200, body: '{"private":true}' }; };
  const now = Date.parse('2026-11-07T10:00:00Z');
  await checkVisibility('https://ana:secret@github.com/o/r.git', { request, cache, now });
  await checkVisibility('https://ana:secret@github.com/o/r.git', { request, cache, now: now + 3600 * 1000 });
  assert.equal(urls.length, 1);
  assert.equal(urls[0], 'https://api.github.com/repos/o/r');
  await checkVisibility('https://github.com/o/r.git', { request, cache, now: now + 25 * 3600 * 1000 });
  assert.equal(urls.length, 2);
});

test('rawAllowed follows the visibility policy', () => {
  const config = (raw) => ({ publish: { raw } });
  assert.equal(rawAllowed('private', config('auto')), true);
  assert.equal(rawAllowed('public', config('auto')), false);
  assert.equal(rawAllowed('public', config('always')), false);
  assert.equal(rawAllowed('unknown', config('auto')), false);
  assert.equal(rawAllowed('unknown', config('always')), true);
});
