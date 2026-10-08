'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateEmail } = require('../src/utils/validate');

test('validateEmail accepts normal addresses', () => {
  assert.equal(validateEmail('me@example.com'), null);
  assert.equal(validateEmail('  me@example.com  '), null); // wird getrimmt geprüft
  assert.equal(validateEmail('first.last+tag@sub.example.co.uk'), null);
});

test('validateEmail rejects anything that would break an ACME registration', () => {
  for (const bad of [
    '', '   ', null, undefined, 42, {},
    'no-at-sign', '@leading.example', 'trailing@',
    'a@b',                                  // Kontaktdomain ohne Punkt
    'me@ex\0ample.com', 'a@b\nc.de', 'a b@example.com', 'me@exa\vmple.com',
    'me@examp‮le.com', 'me@exämple.com', // RTL-Override / Nicht-ASCII
    'a@@example.com',
    'me@.example.com', 'me@example.com.', 'me@exa..mple.com', 'me@-example.com',
    '.me@example.com', 'me.@example.com', 'me..you@example.com', // lokaler Teil: führender/abschließender Punkt, doppelter Punkt
    'a'.repeat(65) + '@example.com',        // Local Part > 64 (RFC 5321)
    'a'.repeat(250) + '@example.com',       // Gesamtlänge > 254
  ]) {
    assert.equal(typeof validateEmail(bad), 'string', `akzeptierte fälschlich: ${JSON.stringify(bad)}`);
  }
});
