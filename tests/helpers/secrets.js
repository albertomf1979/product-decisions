'use strict';

// Fake secrets, built by concatenation so that no literal token shape sits in the
// repository for secret scanners to flag.
const fill = (n, c = 'x') => c.repeat(n);
const j = (...parts) => parts.join('');

/** @type {{ type: string, value: string, secret: string }[]} */
const corpus = [
  { type: 'private_key', value: j('-----BEGIN ', 'RSA PRIVATE KEY-----\nabc\ndef\n-----END ', 'RSA PRIVATE KEY-----'), secret: 'abc\ndef' },
  { type: 'anthropic_key', value: j('sk-', 'ant-', fill(24, 'a')) },
  { type: 'openai_key', value: j('sk-', 'proj-', fill(24, 'b')) },
  { type: 'openai_key', value: j('sk-', fill(24, 'c')) },
  { type: 'github_token', value: j('gh', 'p_', fill(36, 'd')) },
  { type: 'github_token', value: j('github', '_pat_', fill(40, 'e')) },
  { type: 'aws_key', value: j('AK', 'IA', fill(16, 'F')) },
  { type: 'google_key', value: j('AI', 'za', fill(35, 'g')) },
  { type: 'slack_token', value: j('xo', 'xb-', fill(24, '1')) },
  { type: 'stripe_key', value: j('sk', '_live_', fill(24, 'h')) },
  { type: 'npm_token', value: j('np', 'm_', fill(36, 'i')) },
  { type: 'jwt', value: j('ey', 'Jhbbbbbbbb.', fill(12, 'j'), '.', fill(12, 'k')) },
  { type: 'auth_header', value: j('Authorization: ', 'Basic ', 'dXNlcjpwYXNz'), secret: 'dXNlcjpwYXNz' },
  { type: 'bearer', value: j('bearer ', fill(24, 'm')), secret: fill(24, 'm') },
  { type: 'url_credentials', value: j('https://', 'ana:hunter2', '@example.com/x'), secret: 'ana:hunter2' },
  { type: 'env_assignment', value: j('DB_', 'PASSWORD=', 'correcthorse'), secret: 'correcthorse' },
  { type: 'env_assignment', value: j('API_', 'KEY="', 'quotedvalue', '"'), secret: 'quotedvalue' },
  { type: 'assignment', value: j('"pass', 'word": "', 'batterystaple', '"'), secret: 'batterystaple' },
].map((entry) => ({ secret: entry.value, ...entry }));

module.exports = { corpus, fill };
