'use strict';
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown } = require('./helpers/setup');
const { getDb } = require('../src/db/connection');
let svc;
beforeEach(async () => { await setup(); svc = require('../src/services/accessRules'); });
afterEach(teardown);
function addRule(o) { return svc.createRule({ target_type:'route', target_id:1, mode:'allow', schedule:'Mo-Fr 09:00-17:00', ...o }); }
const MON10 = new Date(2026,5,1,10,0,0); // Mon 2026-06-01 10:00 local
const MON20 = new Date(2026,5,1,20,0,0);
const SUN10 = new Date(2026,5,7,10,0,0); // Sunday

test('no rules -> allowed (default open)', () => {
  assert.equal(svc.evaluate('route',1,MON10).state, 'allowed');
});
test('allow rule: in window allowed, out denied', () => {
  addRule({});
  assert.equal(svc.evaluate('route',1,MON10).state, 'allowed');
  assert.equal(svc.evaluate('route',1,MON20).state, 'denied');
  assert.equal(svc.evaluate('route',1,SUN10).state, 'denied');
});
test('block wins over allow', () => {
  addRule({});                                   // allow Mo-Fr 09-17
  addRule({ mode:'block', schedule:'Mo 09:00-12:00' });
  assert.equal(svc.evaluate('route',1,MON10).state, 'denied'); // block matches 10:00
});
test('date bounds: allow active through valid_until end-of-day; default-open after', () => {
  addRule({ valid_until:'2026-06-01' });                                   // allow Mo-Fr 09-17 until 2026-06-01
  assert.equal(svc.evaluate('route',1,new Date(2026,5,1,10,0,0)).state, 'allowed');  // Mon in window + in date
  assert.equal(svc.evaluate('route',1,new Date(2026,5,1,20,0,0)).state, 'denied');   // Mon out of window + in date
  // after valid_until the only allow rule is out of date -> no applicable allow, no block -> default-open
  assert.equal(svc.evaluate('route',1,new Date(2026,5,2,20,0,0)).state, 'allowed');
});
test('in-date block denies regardless of allow', () => {
  svc.createRule({ target_type:'route', target_id:1, mode:'block', schedule:'Mo 09:00-23:00', valid_until:'2026-06-30' });
  assert.equal(svc.evaluate('route',1,new Date(2026,5,1,10,0,0)).state, 'denied');
});
test('disabled rule ignored', () => {
  const r = addRule({}); svc.updateRule(r.id, { enabled: 0 });
  assert.equal(svc.evaluate('route',1,MON10).state, 'allowed'); // back to default-open
});
