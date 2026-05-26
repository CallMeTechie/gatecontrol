'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseSchedule } = require('../src/services/rdpMaintenance');
test('valid multi-window schedule', () => {
  const r = parseSchedule('Mo-Fr 09:00-17:00; Sa 10:00-12:00');
  assert.equal(r.errors.length, 0);
  assert.equal(r.windows.length, 2);
});
test('empty schedule -> no windows', () => {
  const r = parseSchedule('   ');
  assert.equal(r.windows.length, 0);
});
test('garbage line -> error, no silent skip', () => {
  const r = parseSchedule('Montag 9-17');
  assert.ok(r.errors.length >= 1);
  assert.equal(r.windows.length, 0);
});
test('partially-bad -> reports the bad line', () => {
  const r = parseSchedule('Mo-Fr 09:00-17:00\nXX 99:99-00:00');
  assert.ok(r.errors.length >= 1);
});
