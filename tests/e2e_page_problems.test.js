'use strict';

// tests/e2e/page-problems.js: which console errors of the browser tests are not
// faults of the app (run 44044226830: three font files of Google not reached).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { isExternalNetError } = require('./e2e/page-problems');

const BASE = 'http://127.0.0.1:3000';
const CLOSED = 'Failed to load resource: net::ERR_CONNECTION_CLOSED';
const FONTS = [
  'https://fonts.gstatic.com/s/hankengrotesk/v12/ieVn2YZDLWuGJpnzaiwFXS9tYtpd59A.woff2',
  'https://fonts.gstatic.com/s/bricolagegrotesque/v9/3y9K6as8bTXq_nANBjzKo3IeZx8z6up5BeSl9D4dj_x9PpZBMlGIInE.woff2',
  'https://fonts.gstatic.com/s/jetbrainsmono/v24/tDbv2o-flEEny0FZhsfKu5WU4zr3E_BX0PnT8RD8yKwBNntkaToggR7BYRbKPxDcwg.woff2',
];

test('the three font files of the failed run: another host, not counted', () => {
  for (const url of FONTS) assert.equal(isExternalNetError(CLOSED, url, BASE), true, url);
  assert.equal(isExternalNetError('Failed to load resource: net::ERR_CONNECTION_RESET',
    'https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@400&display=swap', BASE), true);
});

test('a network error of the app counts — under each of its addresses', () => {
  assert.equal(isExternalNetError(CLOSED, BASE + '/api/v1/gateways', BASE), false);
  assert.equal(isExternalNetError(CLOSED, 'http://localhost:3000/api/v1/peers', BASE), false);
  assert.equal(isExternalNetError(CLOSED, 'http://[::1]:3000/js/app.js', BASE), false);
  // the app on another port (the licensed app of 31-vpn-names.js) is still the app
  assert.equal(isExternalNetError(CLOSED, 'http://127.0.0.1:41234/api/v1/ping', BASE), false);
  assert.equal(isExternalNetError(CLOSED, 'http://example.com:3000/x', 'http://example.com:3000'), false);
});

test('only a network error: an answer of another host still counts', () => {
  assert.equal(isExternalNetError('Failed to load resource: the server responded with a status of 404 ()', FONTS[0], BASE), false);
  assert.equal(isExternalNetError('Uncaught TypeError: x is not a function', FONTS[0], BASE), false);
  assert.equal(isExternalNetError(CLOSED + ' (and more)', FONTS[0], BASE), false);
});

test('without a resource address it counts', () => {
  assert.equal(isExternalNetError(CLOSED, '', BASE), false);
  assert.equal(isExternalNetError(CLOSED, undefined, BASE), false);
  assert.equal(isExternalNetError(CLOSED, 'not a url', BASE), false);
  assert.equal(isExternalNetError(CLOSED, 'data:font/woff2;base64,AA==', BASE), false);
});

test('run.js leaves out exactly these console errors and still reports them', () => {
  const src = fs.readFileSync(path.join(__dirname, 'e2e', 'run.js'), 'utf8');
  assert.match(src, /require\('\.\/page-problems'\)/);
  assert.match(src, /if \(isExternalNetError\(m\.text\(\), at, BASE\)\) \{ notes\.push\(p\);/);
  assert.match(src, /annotate\('not counted, another host was not reached: '/);
});
