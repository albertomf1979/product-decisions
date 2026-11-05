'use strict';

const crypto = require('node:crypto');

const BASE64_MIN_RUN = 4096;
const MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const mark = (type) => `[REDACTED:${type}]`;

// Order matters: specific token shapes first, then the broader assignment rules.
// Every pattern must stay linear on large input, because this runs inside a hook.
const RULES = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, mark('private_key')],
  [/\bsk-ant-[A-Za-z0-9_-]{10,}/g, mark('anthropic_key')],
  [/\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g, mark('openai_key')],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, mark('github_token')],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, mark('github_token')],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, mark('aws_key')],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, mark('google_key')],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, mark('slack_token')],
  [/\b[rs]k_live_[A-Za-z0-9]{16,}\b/g, mark('stripe_key')],
  [/\bnpm_[A-Za-z0-9]{30,}\b/g, mark('npm_token')],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, mark('jwt')],
  [/\b(authorization\s*[:=]\s*)(?:(?:bearer|basic|token)\s+)?[^\s"',;]+/gi, `$1${mark('auth_header')}`],
  [/\bbearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi, mark('bearer')],
  // The scheme length is bounded: unbounded, 'a.a.a.a…' text goes quadratic.
  [/\b([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s:@/]+:[^\s@/]+@/gi, `$1${mark('url_credentials')}@`],
  [
    /\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|CREDENTIAL|ACCESS_?KEY)[A-Z0-9_]*\s*[=:]\s*)("[^"\n]*"|'[^'\n]*'|[^\s"',;]+)/g,
    `$1${mark('env_assignment')}`,
  ],
  [/((?:password|passwd|secret|token|api[_-]?key)["']?\s*[:=]\s*)(["'])[^"'\n]{8,}\2/gi, `$1${mark('quoted_secret')}`],
];

const SECRET_KEY = /^(password|passwd|secret|token|api[_-]?key|authorization|private[_-]?key|access[_-]?key)$/i;

const SECRET_BASENAMES = [
  /^\.env(\..*)?$/,
  /\.(pem|key|p12|pfx)$/,
  /^id_(rsa|dsa|ecdsa|ed25519)$/,
  /^credentials(\..*)?$/,
];

// Tool input fields that carry a file's content.
const CONTENT_FIELDS = ['content', 'old_string', 'new_string', 'new_source', 'edits'];

const isBase64Code = (c) =>
  (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 43 || c === 47;

/**
 * Replaces long base64 runs with a hash and a size. A hand-written scan, because
 * the equivalent regex goes quadratic on text with many runs just under the minimum.
 */
function replaceBinaryRuns(text) {
  if (text.length < BASE64_MIN_RUN) return text;
  const parts = [];
  let copied = 0;
  let runStart = -1;
  for (let i = 0; i <= text.length; i += 1) {
    if (i < text.length && isBase64Code(text.charCodeAt(i))) {
      if (runStart < 0) runStart = i;
      continue;
    }
    if (runStart >= 0 && i - runStart >= BASE64_MIN_RUN) {
      let end = i;
      while (end - i < 2 && text[end] === '=') end += 1;
      const run = text.slice(runStart, end);
      parts.push(text.slice(copied, runStart), `[BINARY:sha256:${sha256(run).slice(0, 16)}:${run.length}]`);
      copied = end;
      i = end - 1;
    }
    runStart = -1;
  }
  if (parts.length === 0) return text;
  parts.push(text.slice(copied));
  return parts.join('');
}

/**
 * @param {string} text
 * @param {RegExp[]} [extra] Patterns from `compileExtra`.
 * @returns {string}
 */
function redactString(text, extra = []) {
  let out = replaceBinaryRuns(text);
  for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement);
  for (const pattern of extra) out = out.replace(pattern, mark('custom'));
  return out;
}

/** Deep copy with every string redacted. The input is not mutated. */
function redactValue(value, extra = []) {
  if (typeof value === 'string') return redactString(value, extra);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, extra));
  if (value === null || typeof value !== 'object') return value;
  // Object.fromEntries defines own properties, so a "__proto__" key stays inert.
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (SECRET_KEY.test(key) && typeof item === 'string' && item !== '') return [key, mark('key')];
    return [key, redactValue(item, extra)];
  }));
}

/** @returns {boolean} Whether a path names a file whose content must never be stored. */
function isSecretPath(target) {
  const basename = String(target).split(/[\\/]/).pop();
  return SECRET_BASENAMES.some((pattern) => pattern.test(basename));
}

/** @returns {boolean} Whether a shell command mentions a secret file. */
function commandTouchesSecretFile(command) {
  return String(command).split(/[\s"'`;|&<>()=]+/).filter(Boolean).some(isSecretPath);
}

const hashedContent = (value) => ({
  redacted_file: true,
  sha256: sha256(typeof value === 'string' ? value : JSON.stringify(value)),
});

/**
 * Keeps only a hash of any content that belongs to a secret file. Pattern redaction
 * alone would miss values that look like nothing in particular.
 *
 * @returns {{ toolInput: any, toolResponse: any }}
 */
function protectSecretFiles(_toolName, toolInput, toolResponse) {
  const input = toolInput && typeof toolInput === 'object' ? toolInput : {};
  const paths = [input.file_path, input.path, input.notebook_path].filter((p) => typeof p === 'string');
  const touched = paths.some(isSecretPath)
    || (typeof input.command === 'string' && commandTouchesSecretFile(input.command));
  if (!touched) return { toolInput, toolResponse };

  const safeInput = { ...input };
  for (const field of CONTENT_FIELDS) {
    if (safeInput[field] !== undefined) safeInput[field] = hashedContent(safeInput[field]);
  }
  return {
    toolInput: safeInput,
    toolResponse: toolResponse === undefined ? undefined : hashedContent(toolResponse),
  };
}

/** Compiles user patterns, silently dropping any that are not valid. */
function compileExtra(patterns) {
  const compiled = [];
  for (const source of Array.isArray(patterns) ? patterns : []) {
    if (typeof source !== 'string') continue;
    try {
      compiled.push(new RegExp(source, 'g'));
    } catch {
      // An invalid pattern must never stop capture.
    }
  }
  return compiled;
}

/** @returns {{ oversized: true, bytes: number, sha256: string } | null} */
function oversizedPayload(rawBytes) {
  if (rawBytes.length <= MAX_PAYLOAD_BYTES) return null;
  return { oversized: true, bytes: rawBytes.length, sha256: sha256(rawBytes) };
}

module.exports = {
  BASE64_MIN_RUN,
  MAX_PAYLOAD_BYTES,
  redactString,
  redactValue,
  isSecretPath,
  commandTouchesSecretFile,
  protectSecretFiles,
  compileExtra,
  oversizedPayload,
};
