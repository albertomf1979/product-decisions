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
    // On its own line, because environment-style values run to the end of the line.
    const out = redactString(`before ${value}\nafter`);
    assert(!out.includes(secret), out);
    assert(out.includes(`[REDACTED:${type}]`), out);
    assert(out.startsWith('before ') && out.endsWith('\nafter'), out);
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
  const read = protectSecretFiles({ tool_input: { file_path: '.env' }, tool_response: 'A=1' });
  assert.equal(read.tool_response.redacted_file, true);
  assert.match(read.tool_response.sha256, /^[0-9a-f]{64}$/);

  const bash = protectSecretFiles({ tool_input: { command: 'cat .env' }, tool_response: 'A=1' });
  assert.deepEqual(bash.tool_response, read.tool_response);

  const write = protectSecretFiles({ tool_input: { file_path: '.env', content: 'A=1' }, tool_response: { type: 'create' } });
  assert.equal(write.tool_input.file_path, '.env');
  assert.equal(write.tool_input.content.redacted_file, true);

  const edit = protectSecretFiles({ tool_input: { file_path: 'x.pem', old_string: 'a', new_string: 'b' }, tool_response: {} });
  assert.equal(edit.tool_input.old_string.redacted_file, true);
  assert.equal(edit.tool_input.new_string.redacted_file, true);

  const normal = { tool_input: { file_path: 'a.js' }, tool_response: 'x' };
  assert.deepEqual(protectSecretFiles(normal), normal);
});

test('a failed tool on a secret file has no response to hash', () => {
  const out = protectSecretFiles({ tool_input: { file_path: '.env' } });
  assert.equal('tool_response' in out, false);
});

test('names narrower than the PRD list are covered, in any case', () => {
  for (const p of ['.envrc', '.env-prod', '.env_backup', 'id_rsa_work', 'id_rsa.bak', 'credentials-prod.json',
    'credentials_backup', '.ENV', 'SERVER.PEM', '.netrc', '.npmrc', '.pgpass', '.pypirc', '.git-credentials']) {
    assert.equal(isSecretPath(p), true, p);
  }
});

test('shell forms name a secret file', () => {
  for (const c of ['cat .env*', 'cat {.env,.env.local}', 'echo DB_PASS=x >> .env', 'cat <<EOF > .env.local', 'cat ./config/.ENV']) {
    assert.equal(commandTouchesSecretFile(c), true, c);
  }
});

test('a failed command that read a secret file keeps no error text', () => {
  const out = protectSecretFiles({ tool_input: { command: 'cat .env && npm test' }, error: 'Exit code 1\nDB_PASS=SENTINEL' });
  assert(!JSON.stringify(out).includes('SENTINEL'));
  assert.equal(out.error.redacted_file, true);
});

test('a shell write to a secret file keeps no value in the command', () => {
  const out = protectSecretFiles({ tool_input: { command: 'echo DB_PASS=SENTINEL >> .env' }, tool_response: {} });
  assert(!JSON.stringify(out).includes('SENTINEL'));
});

test('secret targets are found in any path-like field', () => {
  for (const tool_input of [
    { pattern: 'x', glob: '.env*' },
    { paths: ['a.js', '.env'] },
    { relative_path: 'config/.env' },
    { filename: 'x.pem' },
    { files: ['credentials.json'] },
  ]) {
    const out = protectSecretFiles({ tool_input, tool_response: 'SENTINEL' });
    assert(!JSON.stringify(out).includes('SENTINEL'), JSON.stringify(tool_input));
  }
});

test('every unknown input field of a secret file is hashed, and the path stays', () => {
  const out = protectSecretFiles({ tool_input: { path: '.env', text: 'SENTINEL', file_text: 'SENTINEL', nested: { a: 'SENTINEL' }, limit: 5 } });
  assert(!JSON.stringify(out).includes('SENTINEL'));
  assert.equal(out.tool_input.path, '.env');
  assert.equal(out.tool_input.limit, 5);
});

for (const text of [
  '--password=SENTINEL', 'secret_key=SENTINEL', 'stripe_webhook=SENTINEL', 'password: SENTINEL', 'Password = SENTINEL',
  'https://example.com/x?api_key=SENTINEL&y=1', 'https://SENTINEL@github.com/o/r',
  'postgres://u:SENTINEL@tail@host/db', 'postgres://u:SENTINEL/x@host/db',
  'DB_PASSWORD=aaa,SENTINEL', 'DB_PASSWORD=aaa;SENTINEL', 'PASSWORD: aaa SENTINEL',
  'x-api-key: SENTINEL', 'X-API-KEY: SENTINEL', 'Cookie: session=SENTINEL', 'Set-Cookie: a=SENTINEL',
  'curl -u ana:SENTINEL https://example.com', 'mytool --token SENTINEL', 'DB_PASS=SENTINEL', 'JWT_KEY=SENTINEL',
  '-----BEGIN RSA PRIVATE KEY-----\nSENTINEL\nmore', '{\\"password\\":\\"SENTINEL\\"}', 'client_secret: "SENTINEL"',
]) {
  test(`no secret survives in: ${text.slice(0, 40).replace(/\n/g, ' ')}`, () => {
    assert(!redactString(text).includes('SENTINEL'), redactString(text));
  });
}

test('ordinary output that resembles a secret is unchanged', () => {
  for (const text of ['PASSED: 10', 'TOKENS: 1234', 'https://unpkg.com/react@18.3.1/index.js', 'const token = getToken();',
    'https://example.com/x?page=2&sort=name', 'BYPASS: yes']) {
    assert.equal(redactString(text), text);
  }
});

test('redactValue matches secret keys by suffix, for any value', () => {
  const out = redactValue({ client_secret: 'a', access_token: 'b', db_password: 'c', password: ['d'], Password: 12345678, secret: true, usage: { input_tokens: 5 } });
  assert.equal(out.client_secret, '[REDACTED:key]');
  assert.equal(out.access_token, '[REDACTED:key]');
  assert.equal(out.db_password, '[REDACTED:key]');
  assert.equal(out.password, '[REDACTED:key]');
  assert.equal(out.Password, '[REDACTED:key]');
  assert.equal(out.secret, true);
  assert.equal(out.usage.input_tokens, 5);
});

test('a secret used as an object key is redacted', () => {
  const out = redactValue({ [corpus[4].value]: 1 });
  assert.deepEqual(Object.keys(out), ['[REDACTED:github_token]']);
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
  'JWT-like segments': 'eyJaaaaaaaaaa-',
  'repeated keywords': 'SECRET_',
  'lower-case keywords': 'secret_',
  'repeated key headers': '-----BEGIN RSA PRIVATE KEY-----\n',
  'repeated schemes': 'a://',
  'scheme with long user info': 'a://bbbbbbbbbb',
  'repeated flags': '--token-',
  'repeated custom headers': 'x-api-key-',
  'repeated assignments': 'password=',
  'query parameters': '?key_key_key_key',
};
for (const [name, unit] of Object.entries(cases)) {
  test(`a 3.9 MiB payload of ${name} is redacted in under 1 second`, () => {
    const text = unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
    // The best of three: the rest of the suite runs in parallel, so one slow run says more
    // about the machine's load than about the patterns. A real regression is slow every time.
    let ms = Infinity;
    for (let attempt = 0; attempt < 3 && ms >= 1000 * factor; attempt += 1) {
      const start = performance.now();
      redactString(text);
      ms = Math.min(ms, performance.now() - start);
    }
    assert(ms < 1000 * factor, `${name} took ${ms.toFixed(0)} ms`);
  });
}

const { maskHome } = require('../plugin/src/core/redact.js');

test('the secret-file hash depends on the salt', () => {
  const crypto = require('node:crypto');
  const input = { tool_input: { file_path: '.env' }, tool_response: 'A=1' };
  const one = protectSecretFiles(input, 'salt-one').tool_response.sha256;
  const two = protectSecretFiles(input, 'salt-two').tool_response.sha256;
  assert.notEqual(one, two);
  assert.equal(protectSecretFiles(input).tool_response.sha256, crypto.createHash('sha256').update('A=1').digest('hex'));
});

test('maskHome replaces the home folder only at a path boundary', () => {
  assert.equal(maskHome('/Users/ana/x and /Users/anabel/y', '/Users/ana'), '~/x and /Users/anabel/y');
  assert.equal(maskHome('cd /Users/ana', '/Users/ana'), 'cd ~');
  assert.equal(maskHome('C:\\Users\\ana\\x', 'C:\\Users\\ana'), '~\\x');
  assert.equal(maskHome('C:/Users/ana/x', 'C:\\Users\\ana'), '~/x');
  assert.equal(maskHome('nothing here', '/'), 'nothing here');
});

test('redactValue masks the home folder in keys and values', () => {
  const out = redactValue({ ['/Users/ana/a']: '/Users/ana/b' }, [], '/Users/ana');
  assert.deepEqual(out, { '~/a': '~/b' });
});

test('the encoded home is masked too', () => {
  assert.equal(maskHome('/private/tmp/claude-501/-Users-ana-Documents/s/x', '/Users/ana'), '/private/tmp/claude-501/~-Documents/s/x');
  assert.equal(maskHome('~/.claude/projects/-Users-ana/s.jsonl', '/Users/ana'), '~/.claude/projects/~/s.jsonl');
  assert.equal(maskHome('/tmp/-Users-anabel-x and /tmp/x-Users-ana-y', '/Users/ana'), '/tmp/-Users-anabel-x and /tmp/x-Users-ana-y');
  assert.equal(maskHome('cd -Users-ana', '/Users/ana'), 'cd ~');
  assert.equal(maskHome('C:\\Users\\ana\\.claude\\projects\\C--Users-ana-repo\\s.jsonl', 'C:\\Users\\ana'), '~\\.claude\\projects\\~-repo\\s.jsonl');
});
