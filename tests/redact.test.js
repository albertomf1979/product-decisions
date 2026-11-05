'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  redactString, redactValue, isSecretPath, commandTouchesSecretFile,
  protectSecretFiles, compileExtra, oversizedPayload, MAX_PAYLOAD_BYTES,
} = require('../plugin/src/core/redact.js');
const { corpus } = require('./helpers/secrets.js');

const factor = Number(process.env.PD_LATENCY_FACTOR || 1);

for (const { type, value, secret } of corpus) {
  test(`no ${type} survives: ${value.slice(0, 12)}…`, () => {
    const out = redactString(`before ${value} after`);
    assert(!out.includes(secret), out);
    assert(out.includes(`[REDACTED:${type}]`), out);
    assert(out.startsWith('before ') && out.endsWith(' after'), out);
  });
}

test('harmless text is unchanged', () => {
  for (const text of ['const total = getTotal(items);', 'sk-short', 'TOKEN_LIMIT', 'a normal sentence',
    'token = getToken()', 'https://example.com/a/b?x=1', 'keyboard.key is pressed']) {
    assert.equal(redactString(text), text);
  }
});

test('redactValue handles nested objects, arrays, and secret-looking keys', () => {
  const input = { password: 'x', config: { apiKey: 'y' }, list: [corpus[4].value, 7, true, null], ok: 'fine' };
  const copy = structuredClone(input);
  const out = redactValue(input);
  assert.equal(out.password, '[REDACTED:key]');
  assert.equal(out.config.apiKey, '[REDACTED:key]');
  assert.equal(out.list[0], '[REDACTED:github_token]');
  assert.deepEqual(out.list.slice(1), [7, true, null]);
  assert.equal(out.ok, 'fine');
  assert.deepEqual(input, copy, 'the input must not be mutated');
});

test('redactValue does not let a __proto__ key change the prototype', () => {
  const out = redactValue(JSON.parse('{"__proto__": {"polluted": "yes"}}'));
  assert.equal(Object.getPrototypeOf(out), Object.prototype);
  assert.equal(out.polluted, undefined);
});

test('binary runs become a hash and a size', () => {
  const out = redactString(`x ${'A'.repeat(5000)} y`);
  assert.match(out, /^x \[BINARY:sha256:[0-9a-f]{16}:5000\] y$/);
  const short = 'A'.repeat(100);
  assert.equal(redactString(short), short);
});

test('isSecretPath', () => {
  for (const p of ['.env', '.env.local', 'a/b/.env', 'a\\b\\.env', 'x.pem', 'x.key', 'id_rsa', 'id_ed25519', 'credentials', 'credentials.json']) {
    assert.equal(isSecretPath(p), true, p);
  }
  for (const p of ['environment.md', 'keyboard.js', 'README.md', 'src/key/index.js']) {
    assert.equal(isSecretPath(p), false, p);
  }
});

test('commandTouchesSecretFile', () => {
  assert.equal(commandTouchesSecretFile('cat .env'), true);
  assert.equal(commandTouchesSecretFile('source "config/.env.local" && run'), true);
  assert.equal(commandTouchesSecretFile('ls -la src'), false);
});

test('secret files keep only the hash', () => {
  const read = protectSecretFiles('Read', { file_path: '.env' }, 'A=1');
  assert.equal(read.toolResponse.redacted_file, true);
  assert.match(read.toolResponse.sha256, /^[0-9a-f]{64}$/);

  const bash = protectSecretFiles('Bash', { command: 'cat .env' }, 'A=1');
  assert.deepEqual(bash.toolResponse, read.toolResponse);

  const write = protectSecretFiles('Write', { file_path: '.env', content: 'A=1' }, { type: 'create' });
  assert.equal(write.toolInput.file_path, '.env');
  assert.equal(write.toolInput.content.redacted_file, true);

  const edit = protectSecretFiles('Edit', { file_path: 'x.pem', old_string: 'a', new_string: 'b' }, {});
  assert.equal(edit.toolInput.old_string.redacted_file, true);
  assert.equal(edit.toolInput.new_string.redacted_file, true);

  const normal = protectSecretFiles('Read', { file_path: 'a.js' }, 'x');
  assert.deepEqual(normal, { toolInput: { file_path: 'a.js' }, toolResponse: 'x' });
});

test('a failed tool on a secret file has no response to hash', () => {
  const out = protectSecretFiles('Read', { file_path: '.env' }, undefined);
  assert.equal(out.toolResponse, undefined);
});

test('oversized payloads', () => {
  const record = oversizedPayload(Buffer.alloc(5 * 1024 * 1024));
  assert.equal(record.oversized, true);
  assert.equal(record.bytes, 5 * 1024 * 1024);
  assert.match(record.sha256, /^[0-9a-f]{64}$/);
  assert.equal(oversizedPayload(Buffer.alloc(10)), null);
  assert.equal(oversizedPayload(Buffer.alloc(MAX_PAYLOAD_BYTES)), null);
});

test('extra patterns apply, and invalid ones are ignored without throwing', () => {
  const extra = compileExtra(['internal-[0-9]+', '(unclosed', 42]);
  assert.equal(extra.length, 1);
  assert.equal(redactString('id internal-77 end', extra), 'id [REDACTED:custom] end');
});

const size = Math.floor(3.9 * 1024 * 1024);
const cases = {
  'source code': 'const value = compute(items, { retries: 3 }); // a normal line of code\n',
  'wrapped base64': `${'QUJD'.repeat(19)}\n`,
  'dotted text': 'a.',
  'long underscore words': `${'AB_'.repeat(1000)} `,
};
for (const [name, unit] of Object.entries(cases)) {
  test(`a 3.9 MiB payload of ${name} is redacted in under 1 second`, () => {
    const text = unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
    const start = performance.now();
    redactString(text);
    const ms = performance.now() - start;
    assert(ms < 1000 * factor, `${name} took ${ms.toFixed(0)} ms`);
  });
}
