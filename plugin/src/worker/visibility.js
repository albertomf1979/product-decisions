'use strict';

// Whether the remote repository is public or private, for the publication policy
// (PRD STO-5). Anything uncertain is "unknown", which keeps the raw record local.

const DAY = 24 * 3600 * 1000;

/** @returns {{ owner: string, repo: string } | null} For GitHub remotes only; credentials are ignored. */
function parseGitHub(url) {
  const match = /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(String(url).trim());
  return match ? { owner: match[1], repo: match[2] } : null;
}

/** An unauthenticated GET with a generic user agent and a short timeout. */
function httpsGet(url, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const request = require('node:https').get(url, {
      headers: { 'User-Agent': 'product-decisions', Accept: 'application/vnd.github+json' },
      timeout: timeoutMs,
    }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body }));
    });
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', reject);
  });
}

/**
 * @param {string} url The remote's URL.
 * @param {{ request?: Function, cache?: { get: Function, set: Function }, fresh?: boolean, now?: number }} options
 *   With `fresh`, the cache is written but never read: a repository made public since
 *   the last check must stop the raw record at once.
 * @returns {Promise<'private' | 'public' | 'unknown'>}
 */
async function checkVisibility(url, { request = httpsGet, cache, fresh = false, now = Date.now() } = {}) {
  const repo = parseGitHub(url);
  if (!repo) return 'unknown';
  const key = `${repo.owner}/${repo.repo}`.toLowerCase();
  const cached = cache && !fresh && cache.get(key);
  if (cached && now - cached.at < DAY) return cached.value;
  let value = 'unknown';
  try {
    const { status, body } = await request(`https://api.github.com/repos/${repo.owner}/${repo.repo}`);
    // Without credentials a private repository answers 404, since it is invisible.
    if (status === 404) value = 'private';
    else if (status === 200) value = JSON.parse(body).private === true ? 'private' : 'public';
  } catch {
    value = 'unknown';
  }
  if (cache && value !== 'unknown') cache.set(key, { value, at: now });
  return value;
}

/** @returns {boolean} Whether the raw record may leave this machine. */
function rawAllowed(visibility, config) {
  if (visibility === 'private') return true;
  if (visibility === 'unknown') return Boolean(config && config.publish && config.publish.raw === 'always');
  return false;
}

module.exports = { parseGitHub, checkVisibility, rawAllowed, httpsGet };
