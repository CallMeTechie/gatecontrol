'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'pihole.js'), 'utf8');

test('pihole.js wires the pause countdown (state + ticker)', () => {
  assert.ok(/function updateBlocking\(/.test(src), 'updateBlocking helper');
  assert.ok(/pauseEndsAt/.test(src), 'pause deadline tracked');
  assert.ok(/setInterval\(/.test(src), 'per-second ticker');
  // The badge text gets the countdown appended when a pause is active.
  assert.ok(/fmtCountdown\(rem\)/.test(src), 'countdown appended to Off badge');
  // Toggle is optimistic — no immediate load() racing the async server resync.
  assert.ok(/updateBlocking\(enabled \?/.test(src), 'optimistic badge update on toggle');
});

test('fmtCountdown uses zero-padded m:ss math', () => {
  // pihole.js is a DOM-bound IIFE with no exports, so assert on the formula:
  // minutes = floor(sec/60), seconds = sec%60 zero-padded to 2 digits.
  assert.ok(/Math\.floor\(sec \/ 60\)/.test(src), 'minutes = floor(sec/60)');
  assert.ok(/sec % 60/.test(src), 'seconds = sec % 60');
  assert.ok(/padStart\(2, '0'\)/.test(src), 'seconds zero-padded to 2 digits');
});
