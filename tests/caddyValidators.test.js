'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  escapeHtmlForDefender,
  buildDefenderConfig,
  parseStatusCodes,
  isValidHeaderName,
  isValidHeaderValue,
  sanitizeRateWindow,
  sanitizeStickyCookieName,
} = require('../src/services/caddyValidators');

test('escapeHtmlForDefender: escapes HTML special chars', () => {
  assert.equal(escapeHtmlForDefender('<b>&"\'</b>'), '&lt;b&gt;&amp;&quot;&#39;&lt;/b&gt;');
  assert.equal(escapeHtmlForDefender('plain'), 'plain');
  assert.equal(escapeHtmlForDefender(null), null);
  assert.equal(escapeHtmlForDefender(123), 123);
});

test('buildDefenderConfig: default ranges + no bot_blocker_config', () => {
  const cfg = buildDefenderConfig({ bot_blocker_mode: 'block' });
  assert.equal(cfg.handler, 'defender');
  assert.equal(cfg.raw_responder, 'block');
  assert.ok(Array.isArray(cfg.ranges));
  assert.ok(cfg.ranges.length > 0);
});

test('buildDefenderConfig: escapes message when provided', () => {
  const cfg = buildDefenderConfig({
    bot_blocker_mode: 'block',
    bot_blocker_config: JSON.stringify({ message: '<script>x</script>' }),
  });
  assert.equal(cfg.message, '&lt;script&gt;x&lt;/script&gt;');
});

test('buildDefenderConfig: passes through status_code and url', () => {
  const cfg = buildDefenderConfig({
    bot_blocker_config: JSON.stringify({ status_code: 418, url: 'https://example.com' }),
  });
  assert.equal(cfg.status_code, 418);
  assert.equal(cfg.url, 'https://example.com');
});

test('parseStatusCodes: valid CSV, dedup, range-check', () => {
  assert.deepEqual(parseStatusCodes('502,503,504'), [502, 503, 504]);
  assert.deepEqual(parseStatusCodes('502, 502, 503'), [502, 503]);
  assert.deepEqual(parseStatusCodes('200,99,600,abc,503'), [200, 503]);
  assert.deepEqual(parseStatusCodes(''), []);
  assert.deepEqual(parseStatusCodes(null), []);
});

test('isValidHeaderName: alnum+dash only, length limit', () => {
  assert.equal(isValidHeaderName('X-Custom-Header'), true);
  assert.equal(isValidHeaderName('X-Custom_Header'), false, 'underscore not allowed');
  assert.equal(isValidHeaderName('X Custom'), false, 'space not allowed');
  assert.equal(isValidHeaderName(''), false);
  assert.equal(isValidHeaderName('a'.repeat(257)), false, 'over length limit');
});

test('isValidHeaderValue: length limit + no Caddy placeholders', () => {
  assert.equal(isValidHeaderValue('some value'), true);
  assert.equal(isValidHeaderValue('has {placeholder}'), false);
  assert.equal(isValidHeaderValue(''), true);
  assert.equal(isValidHeaderValue('a'.repeat(4097)), false);
});

test('sanitizeRateWindow: allowed values pass, anything else → 1m', () => {
  assert.equal(sanitizeRateWindow('1s'), '1s');
  assert.equal(sanitizeRateWindow('1m'), '1m');
  assert.equal(sanitizeRateWindow('5m'), '5m');
  assert.equal(sanitizeRateWindow('1h'), '1h');
  assert.equal(sanitizeRateWindow('10m'), '1m');
  assert.equal(sanitizeRateWindow('evil'), '1m');
  assert.equal(sanitizeRateWindow(null), '1m');
});

test('sanitizeStickyCookieName: alnum+_+- ok, else default gc_sticky', () => {
  assert.equal(sanitizeStickyCookieName('my-cookie_1'), 'my-cookie_1');
  assert.equal(sanitizeStickyCookieName('my cookie'), 'gc_sticky');
  assert.equal(sanitizeStickyCookieName(''), 'gc_sticky');
  assert.equal(sanitizeStickyCookieName(null), 'gc_sticky');
});
