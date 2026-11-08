'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { storeDir } = require('./state.js');

/** The project configuration. The shared copy lives on the docs branch as config.json. */
const DEFAULT_CONFIG = Object.freeze({
  schema_version: 1,
  folder: 'product-decisions',
  language: 'en',
  tracked_documents: [],
  publish: { raw: 'auto' },
  redact_patterns: [],
  llm: Object.freeze({ enabled: true, engine: 'auto', model: 'sonnet', max_input_chars: 400000, max_runs_per_day: 10, max_budget_usd: 1.00 }),
});

const copyPath = (commonDir) => path.join(storeDir(commonDir), 'config.json');

/** @returns {object} The store's copy of the project config, completed with defaults. */
function readConfig(commonDir) {
  try {
    const stored = JSON.parse(fs.readFileSync(copyPath(commonDir), 'utf8'));
    return {
      ...DEFAULT_CONFIG,
      ...stored,
      publish: { ...DEFAULT_CONFIG.publish, ...(stored.publish || {}) },
      llm: { ...DEFAULT_CONFIG.llm, ...(stored.llm && typeof stored.llm === 'object' ? stored.llm : {}) },
    };
  } catch {
    return { ...DEFAULT_CONFIG, publish: { ...DEFAULT_CONFIG.publish }, llm: { ...DEFAULT_CONFIG.llm } };
  }
}

function writeConfigCopy(commonDir, config) {
  fs.mkdirSync(storeDir(commonDir), { recursive: true, mode: 0o700 });
  fs.writeFileSync(copyPath(commonDir), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

/** One plain path segment, so the folder can never point outside the project root. */
function validateFolderName(name) {
  return typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name) && name !== '.git' && !name.includes('..');
}

/** A path relative to the repository root that cannot leave it. */
function isSafeRelativePath(value) {
  if (typeof value !== 'string' || value === '' || value.length > 500) return false;
  if (value.includes('\0') || value.includes('\\') || /^[A-Za-z]:/.test(value) || value.startsWith('/')) return false;
  return value.split('/').every((part) => part !== '' && part !== '.' && part !== '..') && !value.split('/').includes('.git');
}

const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;

/** What each LLM setting may hold. A shared config cannot raise spending without bound. */
const LLM_RULES = {
  enabled: (v) => typeof v === 'boolean',
  engine: (v) => ['auto', 'claude', 'codex'].includes(v),
  model: (v) => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:\[\]-]{0,63}$/.test(v),
  max_input_chars: (v) => isInt(v, 10000, 2000000),
  max_runs_per_day: (v) => isInt(v, 0, 100),
  max_budget_usd: (v) => typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 100,
};

/** @returns {{ llm: object, bad: boolean }} Each bad field keeps the fallback's value. */
function sanitizeLlm(input, fallback) {
  const base = { ...DEFAULT_CONFIG.llm, ...(fallback && typeof fallback === 'object' ? fallback : {}) };
  if (input === undefined) return { llm: base, bad: false };
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return { llm: base, bad: true };
  let bad = false;
  const llm = { ...base };
  for (const [key, valid] of Object.entries(LLM_RULES)) {
    if (input[key] === undefined) continue;
    if (valid(input[key])) llm[key] = input[key];
    else bad = true;
  }
  return { llm, bad };
}

function compiles(pattern) {
  try {
    new RegExp(pattern, 'g'); // eslint-disable-line no-new
    return true;
  } catch {
    return false;
  }
}

/**
 * The shared config.json comes from a branch anyone with push access can write, so
 * every value is checked before this machine uses it. Unusable values fall back to
 * `fallback` (this machine's current copy) and are named in `rejected`.
 *
 * @returns {{ config: object, rejected: string[] }}
 */
function sanitizeConfig(input, fallback = DEFAULT_CONFIG) {
  const value = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const rejected = [];
  const config = { ...DEFAULT_CONFIG, ...value, publish: { ...DEFAULT_CONFIG.publish } };
  if (!validateFolderName(config.folder)) {
    rejected.push('folder');
    config.folder = fallback.folder;
  }
  if (!['en', 'es'].includes(config.language)) {
    if (value.language !== undefined) rejected.push('language');
    config.language = fallback.language || DEFAULT_CONFIG.language;
  }
  const tracked = Array.isArray(value.tracked_documents) ? value.tracked_documents : [];
  config.tracked_documents = tracked.filter(isSafeRelativePath);
  if (config.tracked_documents.length !== tracked.length || (value.tracked_documents !== undefined && !Array.isArray(value.tracked_documents))) rejected.push('tracked_documents');
  const patterns = Array.isArray(value.redact_patterns) ? value.redact_patterns : [];
  config.redact_patterns = patterns.filter((p) => typeof p === 'string' && p.length <= 500 && compiles(p));
  if (config.redact_patterns.length !== patterns.length) rejected.push('redact_patterns');
  const raw = value.publish && typeof value.publish === 'object' ? value.publish.raw : undefined;
  if (['auto', 'always'].includes(raw)) config.publish.raw = raw;
  else if (raw !== undefined) rejected.push('publish');
  const { llm, bad } = sanitizeLlm(value.llm, fallback.llm);
  config.llm = llm;
  if (bad) rejected.push('llm');
  return { config, rejected };
}

module.exports = { DEFAULT_CONFIG, readConfig, writeConfigCopy, validateFolderName, isSafeRelativePath, sanitizeConfig };
