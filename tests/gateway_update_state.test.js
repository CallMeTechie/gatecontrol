'use strict';
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const gw = require('../src/services/gateways');

test('_normalizeTargetVersion strips leading v', () => {
  assert.equal(gw._normalizeTargetVersion('v1.9.4'), '1.9.4');
  assert.equal(gw._normalizeTargetVersion('1.9.4'), '1.9.4');
  assert.equal(gw._normalizeTargetVersion(null), null);
});

const TIMEOUT = 15 * 60 * 1000;
function row(over) { return Object.assign({ update_request_id: null, update_requested_at: null, update_target_version: null }, over); }

test('_deriveUpdateState: idle when no request', () => {
  assert.equal(gw._deriveUpdateState(row(), {}).state, 'idle');
});
test('_deriveUpdateState: updating until request_id matches', () => {
  const r = row({ update_request_id: 'rid', update_requested_at: Date.now(), update_target_version: '1.9.4' });
  assert.equal(gw._deriveUpdateState(r, { last_pull_request_id: 'OTHER', gateway_version: '1.9.3' }).state, 'updating');
});
test('_deriveUpdateState: done on matching id + ok + version satisfied', () => {
  const r = row({ update_request_id: 'rid', update_requested_at: Date.now(), update_target_version: '1.9.4' });
  assert.equal(gw._deriveUpdateState(r, { last_pull_request_id: 'rid', last_pull_ok: true, gateway_version: '1.9.4' }).state, 'done');
});
test('_deriveUpdateState: failed on matching id + ok:false', () => {
  const r = row({ update_request_id: 'rid', update_requested_at: Date.now(), update_target_version: '1.9.4' });
  assert.equal(gw._deriveUpdateState(r, { last_pull_request_id: 'rid', last_pull_ok: false, gateway_version: '1.9.3' }).state, 'failed');
});
test('_deriveUpdateState: unknown version -> failed (never green)', () => {
  const r = row({ update_request_id: 'rid', update_requested_at: Date.now(), update_target_version: '1.9.4' });
  assert.equal(gw._deriveUpdateState(r, { last_pull_request_id: 'rid', last_pull_ok: true, gateway_version: 'unknown' }).state, 'failed');
});
test('_deriveUpdateState: clock skew does NOT cause false done', () => {
  const r = row({ update_request_id: 'rid', update_requested_at: Date.now(), update_target_version: '1.9.4' });
  assert.equal(gw._deriveUpdateState(r, { last_pull_request_id: 'stale', last_pull_at: Date.now() + 1e9, last_pull_ok: true, gateway_version: '1.9.4' }).state, 'updating');
});
test('_deriveUpdateState: unknown(sticky) after timeout with no match', () => {
  const r = row({ update_request_id: 'rid', update_requested_at: Date.now() - TIMEOUT - 1000, update_target_version: '1.9.4' });
  assert.equal(gw._deriveUpdateState(r, { last_pull_request_id: null }).state, 'unknown');
});
test('_deriveUpdateState: null target -> done only if reported version parses', () => {
  const base = { update_request_id: 'rid', update_requested_at: Date.now(), update_target_version: null };
  assert.equal(gw._deriveUpdateState(row(base), { last_pull_request_id: 'rid', last_pull_ok: true, gateway_version: '1.9.4' }).state, 'done');
  assert.equal(gw._deriveUpdateState(row(base), { last_pull_request_id: 'rid', last_pull_ok: true, gateway_version: 'unknown' }).state, 'failed');
});
