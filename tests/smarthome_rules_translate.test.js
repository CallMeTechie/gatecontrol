'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const T = require('../src/services/smarthome/rulesTranslate');
const caps = require('../src/services/smarthome/deconzCapabilities');
const vectors = require('./fixtures/deconz_spike_vectors');

// Stub-resolve: bildet resourceId → deCONZ-Koordinaten ab.
const R = {
  1:  { deconz_id: '1',  deconz_type: 'sensors', kind: 'sensor', capabilities: {} }, // Daylight sensor
  12: { deconz_id: '12', deconz_type: 'sensors', kind: 'sensor', capabilities: {} }, // motion (presence)
  5:  { deconz_id: '5',  deconz_type: 'sensors', kind: 'sensor', capabilities: {} }, // temperature
  20: { deconz_id: '20', deconz_type: 'lights',  kind: 'light',  capabilities: { on: true, bri: true } },
  30: { deconz_id: '30', deconz_type: 'groups',  kind: 'group',  capabilities: { on: true } },
  40: { deconz_id: '40', deconz_type: 'lights',  kind: 'plug',   capabilities: { on: true } },
  41: { deconz_id: '8/2', deconz_type: 'scenes', kind: 'scene',  capabilities: {} }, // group 8, scene 2
};
const resolve = (id) => { const r = R[id]; if (!r) { const e = new Error('missing'); e.code = 'SMARTHOME_RULE_INVALID'; e.detail = 'unknown_resource'; throw e; } return r; };

test('motion trigger → presence eq + lastupdated dx; temperature threshold ×100; time window in', () => {
  const def = {
    triggers: [
      { kind: 'motion', resourceId: 12, event: 'detected' },
      { kind: 'temperature', resourceId: 5, op: 'lt', value: 5 },
    ],
    timeWindow: { from: '18:00', to: '06:00' },
    actions: [{ kind: 'group', resourceId: 30, set: { on: false } }],
  };
  const c = T.buildConditions(def, resolve);
  assert.deepEqual(c, [
    { address: '/sensors/12/state/presence', operator: 'eq', value: 'true' },
    { address: '/sensors/12/state/lastupdated', operator: 'dx' },
    { address: '/sensors/5/state/temperature', operator: 'lt', value: '500' },
    { address: '/config/localtime', operator: 'in', value: 'T18:00:00/T06:00:00' },
  ]);
});

test('multiple event triggers each get their own dx (edge-OR / state-AND)', () => {
  const def = { triggers: [
    { kind: 'motion', resourceId: 12, event: 'ended' },
    { kind: 'button', resourceId: 12, button: 1, action: 'short' }, // reuse 12 as a switch for address shape
  ], actions: [{ kind: 'group', resourceId: 30, set: { on: false } }] };
  const c = T.buildConditions(def, resolve);
  const dx = c.filter((x) => x.operator === 'dx');
  assert.equal(dx.length, 2); // both event triggers carry dx
});

test('actions: light set on+bri, group on, scene recall body, plug rejects bri', () => {
  const a = T.buildActions({ actions: [
    { kind: 'light', resourceId: 20, set: { on: true, bri: 60 } },
    { kind: 'group', resourceId: 30, set: { on: false } },
    { kind: 'scene', resourceId: 41 },
  ] }, resolve);
  assert.deepEqual(a[0], { address: '/lights/20/state', method: 'PUT', body: { on: true, bri: 152 } }); // 60% → 152 (round(0.6*254), deconzClient uses ×254)
  assert.deepEqual(a[1], { address: '/groups/30/action', method: 'PUT', body: { on: false } });
  assert.deepEqual(a[2], { address: '/groups/8/scenes/2/recall', method: 'PUT', body: { on: true } });
  assert.throws(() => T.buildActions({ actions: [{ kind: 'plug', resourceId: 40, set: { on: true, bri: 50 } }] }, resolve),
    (e) => e.code === 'SMARTHOME_RULE_INVALID' && e.detail === 'plug_no_bri');
});

test('unknown resource throws SMARTHOME_RULE_INVALID', () => {
  assert.throws(() => T.buildActions({ actions: [{ kind: 'light', resourceId: 999, set: { on: true } }] }, resolve),
    (e) => e.code === 'SMARTHOME_RULE_INVALID');
});

test('daylight trigger → daylight eq false (sunset) + lastupdated dx', () => {
  // daylight needs the Daylight sensor's resourceId (the §3 no-resourceId shorthand is UI-latent; the API resolves it).
  const def = { triggers: [{ kind: 'daylight', resourceId: 1, event: 'sunset' }], actions: [{ kind: 'group', resourceId: 30, set: { on: false } }] };
  const c = T.buildConditions(def, resolve);
  assert.deepEqual(c, [
    { address: '/sensors/1/state/daylight', operator: 'eq', value: 'false' }, // sunset = daylight false
    { address: '/sensors/1/state/lastupdated', operator: 'dx' },
  ]);
});

test('button with unknown action throws unknown_button_action', () => {
  const def = { triggers: [{ kind: 'button', resourceId: 12, button: 1, action: 'triple' }], actions: [{ kind: 'group', resourceId: 30, set: { on: false } }] };
  assert.throws(() => T.buildConditions(def, resolve),
    (e) => e.code === 'SMARTHOME_RULE_INVALID' && e.detail === 'unknown_button_action');
});

// Step 4b: spike-vector-grounded assertions to anchor the live contract.
test('spike vectors: buttonCode resolves RWL021 button 4 short → 4002', () => {
  const { modelid, state: { buttonevent } } = vectors.zhaSwitchSample;
  assert.equal(caps.buttonCode(modelid, 4, 'short'), buttonevent); // 4002
});

test('spike vectors: daylight field is "daylight" and daylightSample.state has matching bool', () => {
  assert.equal(caps.daylight.sunrise.field, 'daylight');
  // sunrise value is 'true'; daylightSample.state.daylight is true at time of spike.
  assert.equal(String(vectors.daylightSample.state.daylight), caps.daylight.sunrise.value);
});
