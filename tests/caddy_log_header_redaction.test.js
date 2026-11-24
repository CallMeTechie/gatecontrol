'use strict';

// Credentials in request headers never reach a Caddy log: the access log and
// Caddy's default log (container log: reverse_proxy warnings, http.log.error)
// both carry a filter encoder that replaces the sensitive headers.

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown } = require('./helpers/setup');

beforeEach(setup);
afterEach(teardown);

const MUST_REDACT = [
  'X-Api-Token', 'X-Api-Key', 'X-Machine-Fingerprint', 'X-Gateway-Token',
  'Csrfpreventiontoken', 'X-Csrf-Token', 'Proxy-Authorization',
];

function assertRedacts(fields, where) {
  for (const h of MUST_REDACT) {
    assert.deepEqual(fields[`request>headers>${h}`], { filter: 'replace', value: 'REDACTED' }, `${where}: ${h}`);
  }
}

test('access log redacts the token headers and keeps the URI filter', () => {
  const { buildCaddyConfig } = require('../src/services/caddyConfig');
  const enc = buildCaddyConfig().logging.logs.access.encoder;
  assert.equal(enc.format, 'filter');
  assert.deepEqual(enc.wrap, { format: 'json' });
  assertRedacts(enc.fields, 'access');
  assert.equal(enc.fields['request>uri'].filter, 'multi_regexp', 'share/app link redaction still there');
});

test('default log (container log) redacts the token headers and leaves the access lines to their file', () => {
  const { buildCaddyConfig } = require('../src/services/caddyConfig');
  const def = buildCaddyConfig().logging.logs.default;
  assert.equal(def.encoder.format, 'filter');
  assert.deepEqual(def.encoder.wrap, { format: 'json' });
  assertRedacts(def.encoder.fields, 'default');
  assert.deepEqual(def.exclude, ['http.log.access']);
  assert.equal(def.writer, undefined, 'stays on stderr');
});

test('header names are in Go canonical form (the filter matches case-sensitively)', () => {
  const { __test } = require('../src/services/caddyConfig');
  assert.equal(__test.canonicalHeaderKey('x-api-token'), 'X-Api-Token');
  assert.equal(__test.canonicalHeaderKey('CSRFPreventionToken'), 'Csrfpreventiontoken');
  assert.equal(__test.canonicalHeaderKey('X-API-KEY'), 'X-Api-Key');
  for (const key of Object.keys(__test.sensitiveHeaderLogFields())) {
    const name = key.slice('request>headers>'.length);
    assert.equal(name, __test.canonicalHeaderKey(name), key);
  }
});

test('every X- header of the code base carrying a token/key/fingerprint is in the list', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { __test } = require('../src/services/caddyConfig');
  const listed = new Set(__test.SENSITIVE_LOG_HEADERS.map(__test.canonicalHeaderKey));
  const found = new Set();
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.js$/.test(e.name)) {
        const src = fs.readFileSync(p, 'utf8');
        for (const m of src.matchAll(/['"`](x-[a-z0-9-]*(?:token|secret|key|fingerprint)[a-z0-9-]*)['"`]/gi)) {
          found.add(__test.canonicalHeaderKey(m[1]));
        }
      }
    }
  };
  walk(path.join(__dirname, '..', 'src'));
  assert.ok(found.has('X-Api-Token') && found.has('X-Gateway-Token'), 'scan finds the known headers');
  for (const h of found) assert.ok(listed.has(h), `${h} missing in SENSITIVE_LOG_HEADERS`);
});
