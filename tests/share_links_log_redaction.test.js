'use strict';
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown } = require('./helpers/setup');

beforeEach(setup);
afterEach(teardown);

test('generated Caddy config redacts the share token in the access log URI', () => {
  const { buildCaddyConfig } = require('../src/services/caddyConfig');
  const cfg = buildCaddyConfig();
  const enc = cfg.logging.logs.access.encoder;
  const json = JSON.stringify(enc);
  assert.match(json, /route-auth\\?\/share/); // a filter targeting the share path exists
  assert.match(json, /REDACTED/);
});
