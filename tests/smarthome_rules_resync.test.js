'use strict';
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const nodeCrypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || nodeCrypto.randomBytes(32).toString('hex');
const { setup, teardown } = require('./helpers/setup');
const { getDb } = require('../src/db/connection');

let dev, rules;
beforeEach(async () => { await setup(); dev = require('../src/services/smarthome/smarthomeDevices'); rules = require('../src/services/smarthome/smarthomeRules'); });
afterEach(async () => { await teardown(); });

test('resyncPending rewrites enabled rules with NULL deconz_rule_id', async () => {
  const log = [];
  rules._setClientFactoryForTest(() => ({
    getRules: async () => ({}), createRule: async () => { log.push('createRule'); return 'R1'; },
    updateRule: async () => {}, deleteRule: async () => {}, createSchedule: async () => 'S1', deleteSchedule: async () => {}, createClipSensor: async () => 'C1',
  }));
  const gw = dev.createGateway({ name: 'GW', route_id: null, apiKey: 'K', enabled: true });
  const m = dev.upsertResource({ gateway_id: gw.id, deconz_id: '12', deconz_type: 'sensors', kind: 'sensor', name: 'M', capabilities: {} });
  const g = dev.upsertResource({ gateway_id: gw.id, deconz_id: '30', deconz_type: 'groups', kind: 'group', name: 'G', capabilities: { on: true } });
  const def = JSON.stringify({ triggers: [{ kind: 'motion', resourceId: m, event: 'detected' }], actions: [{ kind: 'group', resourceId: g, set: { on: true } }] });
  getDb().prepare('INSERT INTO smarthome_rules (gateway_id, name, enabled, definition_json, deconz_rule_id) VALUES (?,?,1,?,NULL)').run(gw.id, 'Pending', def);
  const n = await rules.resyncPending();
  assert.equal(n, 1);
  assert.ok(log.includes('createRule'));
  assert.ok(rules.list(gw.id)[0].deconz_rule_id);
});
