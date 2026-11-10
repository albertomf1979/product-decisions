'use strict';

const crypto = require('node:crypto');

const { MAX_PAYLOAD_BYTES } = require('./limits.js');

const BASE64_MIN_RUN = 4096;

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const mark = (type) => `[REDACTED:${type}]`;

// Order matters: specific token shapes first, then the broader assignment rules.
// This runs synchronously in a hook, where no watchdog can interrupt it, so every
// repeated part that can fail after a long scan has an upper bound. Tests in
// redact.test.js hold each rule to its budget on the input that used to break it.
const RULES = [
  // An unterminated key runs to the end of the text: "head -5 key.pem" still counts.
  [/-----BEGIN [A-Z ]{0,32}PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]{0,32}PRIVATE KEY-----|$)/g, mark('private_key')],
  [/\bsk-ant-[A-Za-z0-9_-]{10,}/g, mark('anthropic_key')],
  [/\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g, mark('openai_key')],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, mark('github_token')],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, mark('github_token')],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, mark('aws_key')],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, mark('google_key')],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, mark('slack_token')],
  [/\b[rs]k_live_[A-Za-z0-9]{16,}\b/g, mark('stripe_key')],
  [/\bnpm_[A-Za-z0-9]{30,}\b/g, mark('npm_token')],
  // Only the header is bounded: it is short in real tokens, and each start must pass it.
  [/\beyJ[A-Za-z0-9_-]{8,256}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, mark('jwt')],
  [/\b(authorization\s{0,8}[:=]\s{0,8})(?:(?:bearer|basic|token)\s{1,8})?[^\s"',;]+/gi, `$1${mark('auth_header')}`],
  [/\bbearer\s{1,8}[A-Za-z0-9._~+/-]{16,}=*/gi, mark('bearer')],
  [/(?<![\w-])((?:x-[a-z0-9-]{0,32}(?:key|token|secret|auth)[a-z0-9-]{0,16}|set-cookie|cookie|proxy-authorization)\s{0,8}:\s{0,8})[^\n"']+/gi, `$1${mark('auth_header')}`],
  [/([?&][a-z0-9_-]{0,32}(?:key|token|secret|password|passwd|signature)[a-z0-9_-]{0,16}=)[^&\s"'#]+/gi, `$1${mark('url_param')}`],
  [/(?<![\w-])((?:-u|--user)[\s=]{1,8})[^\s:]{1,256}:\S+/g, `$1${mark('basic_auth')}`],
  [/(?<![\w-])(--?[a-z0-9-]{0,32}(?:password|passwd|token|secret|api-?key)\s{1,8})(?!-)\S+/gi, `$1${mark('cli_flag')}`],
  // Environment style: the value runs to the end of the line, because it may be unquoted.
  [
    /(?<![A-Z0-9_])([A-Z0-9_]{0,64}(?:SECRET|TOKEN(?!S\b)|PASSWORD|PASSWD|_PASS(?![A-Z])|API_?KEY|_KEY|CREDENTIALS?|WEBHOOK)[A-Z0-9_]{0,64}\s{0,8}[=:]\s{0,8})("[^"\n]*"|'[^'\n]*'|[^\n]*)/g,
    `$1${mark('env_assignment')}`,
  ],
  // Code and configuration style. A call such as getToken() is not a value worth hiding.
  [
    /(?<![a-z0-9_.-])((?:--?)?[a-z0-9_.-]{0,48}(?:pass(?:word|wd)|secret|token|api[_-]?key|credential|webhook|(?:secret|private|access|signing|encryption|client)[_-]?key)\\?["']?\s{0,8}[:=]\s{0,8})(?!\[REDACTED)(\\"[^"\n]{0,4096}?\\"|"[^"\n]*"|'[^'\n]*'|(?![\w.$]{0,256}\()[^\s"',;)}]+)/gi,
    `$1${mark('assignment')}`,
  ],
];

// A rule runs only when the text contains one of its hints, which keeps ordinary text
// fast. Hints are compared with the lower-cased text.
const HINTS = new Map([
  [0, ['private key']], [1, ['sk-ant-']], [2, ['sk-']], [3, ['ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_']],
  [4, ['github_pat_']], [5, ['akia', 'asia']], [6, ['aiza']], [7, ['xox']], [8, ['_live_']], [9, ['npm_']],
  [10, ['eyj']], [11, ['authorization']], [12, ['bearer']], [13, ['cookie', 'x-', 'proxy-authorization']],
  [14, ['=']], [15, ['-u', '--user']], [16, ['pass', 'token', 'secret', 'api']],
  [17, ['secret', 'token', 'pass', 'key', 'credential', 'webhook']],
  [18, ['pass', 'secret', 'token', 'key', 'credential', 'webhook']],
]);

const isSchemeChar = (c) => (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 43 || c === 46 || c === 45;
const isLetter = (c) => (c >= 97 && c <= 122) || (c >= 65 && c <= 90);
const isSpace = (c) => c === 32 || (c >= 9 && c <= 13);

/**
 * Hides credentials in URLs such as scheme://user:pass@host or scheme://token@host,
 * including passwords that contain '/' or '@'. A linear scan: each URL is read only up
 * to the next '://', so text full of short schemes stays fast.
 */
function replaceUrlCredentials(text) {
  let out = '';
  let copied = 0;
  let at = text.indexOf('://');
  while (at >= 0) {
    const next = text.indexOf('://', at + 3);
    const limit = next < 0 ? text.length : next;
    let start = at;
    while (start > 0 && at - start < 32 && isSchemeChar(text.charCodeAt(start - 1))) start -= 1;
    const from = at + 3;
    if (start < at && isLetter(text.charCodeAt(start)) && from >= copied) {
      // User info ends at the last '@' before the path, query, or fragment.
      let lastAt = -1;
      let colon = -1;
      for (let i = from; i < limit && i - from < 512; i += 1) {
        const c = text.charCodeAt(i);
        if (isSpace(c)) break;
        if (c === 64) lastAt = i;
        else if (c === 58 && colon < 0) colon = i;
        else if ((c === 47 || c === 63 || c === 35) && colon < 0) break;
      }
      if (lastAt > from) {
        out += text.slice(copied, from) + mark('url_credentials');
        copied = lastAt;
      }
    }
    at = next;
  }
  return copied === 0 ? text : out + text.slice(copied);
}

const SECRET_KEY = /(?:pass(?:word|wd)?|secret|token|api[_-]?key|authorization|credentials?|cookie|(?:private|access|secret|signing|encryption|client)[_-]?key)$/i;

// The PRD's globs (.env*, *.pem, *.key, id_rsa*, credentials*) and their relatives.
const SECRET_BASENAMES = [
  /^\.env/i,
  /\.(pem|key|p12|pfx)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)/i,
  /^credentials/i,
  /^\.(netrc|npmrc|pgpass|pypirc|git-credentials)$/i,
];

// Input fields that name a file. Everything else in the input may carry its content.
const PATH_FIELD = /(?:path|paths|file|files|filename|filenames|glob)$/i;

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

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const homePatterns = new Map();

/**
 * Replaces the home folder with `~`, so the person's account name stays out of the
 * record. Only at a path boundary: /Users/ana must not touch /Users/anabel. Also its
 * encoded form, as Claude Code names project folders (/Users/ana → -Users-ana), which
 * shows up in transcript and temporary paths such as /private/tmp/claude-501/-Users-ana-x.
 * The encoded form is masked only where a path segment begins, so a short home such as
 * /u never turns `git push -u` into `git push ~`, or between dashes, where a folder that
 * already held it was encoded again (-private-tmp-claude-501--Users-ana-x).
 */
function maskHome(text, home) {
  if (!home || home.length < 2) return text;
  if (!homePatterns.has(home)) {
    const forms = [...new Set([home, home.replace(/\\/g, '/')])].map(escapeRegExp);
    const encoded = escapeRegExp(home.replace(/[^A-Za-z0-9]/g, '-'));
    homePatterns.set(home, new RegExp(
      `(?:${forms.join('|')})(?=$|[\\\\/\\s"'<>:;,)\\]}])|(?<=^|[\\\\/])${encoded}(?=$|[-\\\\/\\s"'<>:;,)\\]}])|(?<=-)${encoded}(?=-)`,
      'g',
    ));
  }
  return text.replace(homePatterns.get(home), '~');
}

/**
 * @param {string} text
 * @param {RegExp[]} [extra] Patterns from `compileExtra`.
 * @param {string | null} [home] Home folder to mask, if any.
 * @returns {string}
 */
function redactString(text, extra = [], home = null) {
  let out = replaceBinaryRuns(maskHome(text, home));
  const lower = out.toLowerCase();
  RULES.forEach(([pattern, replacement], index) => {
    const hints = HINTS.get(index);
    if (hints && !hints.some((hint) => lower.includes(hint))) return;
    out = out.replace(pattern, replacement);
  });
  if (lower.includes('://')) out = replaceUrlCredentials(out);
  for (const pattern of extra) out = out.replace(pattern, mark('custom'));
  return out;
}

/** Deep copy with every string redacted, keys included. The input is not mutated. */
function redactValue(value, extra = [], home = null) {
  if (typeof value === 'string') return redactString(value, extra, home);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, extra, home));
  if (value === null || typeof value !== 'object') return value;
  // Object.fromEntries defines own properties, so a "__proto__" key stays inert.
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    const safeKey = redactString(key, extra, home);
    if (SECRET_KEY.test(key) && item !== null && item !== '' && typeof item !== 'boolean') return [safeKey, mark('key')];
    return [safeKey, redactValue(item, extra, home)];
  }));
}

/** @returns {boolean} Whether a path names a file whose content must never be stored. */
function isSecretPath(target) {
  const basename = String(target).split(/[\\/]/).pop();
  return SECRET_BASENAMES.some((pattern) => pattern.test(basename));
}

/** @returns {boolean} Whether a shell command mentions a secret file. */
function commandTouchesSecretFile(command) {
  return String(command).split(/[\s"'`;|&<>(){},=]+/).filter(Boolean).some(isSecretPath);
}

/** With a salt, an HMAC: a published hash then cannot be used to guess a short value. */
const hashedContent = (value, salt) => {
  const data = typeof value === 'string' ? value : JSON.stringify(value);
  const digest = salt ? crypto.createHmac('sha256', salt).update(data).digest('hex') : sha256(data);
  return { redacted_file: true, sha256: digest };
};

/** File headers of a patch (Codex apply_patch): every file it adds, updates, deletes, or moves to. */
const PATCH_HEADER = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm;
const patchNamesSecret = (text) => typeof text === 'string' && [...text.matchAll(PATCH_HEADER)].some((m) => isSecretPath(m[1].trim()));

function namesSecretFile(input) {
  return Object.entries(input).some(([key, value]) => {
    if (key === 'command' || key === 'cmd') {
      // Codex passes a command as an argument array.
      const text = Array.isArray(value) ? value.filter((item) => typeof item === 'string').join(' ') : value;
      return typeof text === 'string' && commandTouchesSecretFile(text);
    }
    if (patchNamesSecret(value)) return true;
    if (!PATH_FIELD.test(key)) return false;
    return (Array.isArray(value) ? value : [value]).some((item) => typeof item === 'string' && isSecretPath(item));
  });
}

/**
 * When a tool names a secret file, keeps only where it pointed. Everything else that
 * could carry the content is hashed, deny by default: pattern redaction alone would
 * miss values that look like nothing in particular. A command that prints a secret
 * without naming the file cannot be caught here.
 *
 * @param {object} payload The payload of a tool event.
 * @returns {object} A copy when a secret file is involved, or the same payload.
 */
function protectSecretFiles(payload, salt) {
  const input = payload.tool_input;
  if (typeof input === 'string' && patchNamesSecret(input)) {
    const safe = { ...payload, tool_input: hashedContent(input, salt) };
    for (const field of ['tool_response', 'error']) if (safe[field] !== undefined) safe[field] = hashedContent(safe[field], salt);
    return safe;
  }
  if (!input || typeof input !== 'object' || !namesSecretFile(input)) return payload;

  const isCarrier = (value) => typeof value === 'string' || (value !== null && typeof value === 'object');
  const safeInput = Object.fromEntries(Object.entries(input).map(([key, value]) => (
    [key, PATH_FIELD.test(key) || !isCarrier(value) ? value : hashedContent(value, salt)]
  )));
  const safe = { ...payload, tool_input: safeInput };
  for (const field of ['tool_response', 'error']) {
    if (safe[field] !== undefined) safe[field] = hashedContent(safe[field], salt);
  }
  return safe;
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
  maskHome,
  redactString,
  redactValue,
  isSecretPath,
  commandTouchesSecretFile,
  protectSecretFiles,
  compileExtra,
  oversizedPayload,
};
