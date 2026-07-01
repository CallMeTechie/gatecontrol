'use strict';
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const nodeCrypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || nodeCrypto.randomBytes(32).toString('hex');
const { setup, teardown } = require('./helpers/setup');

let dev, rules, svc;
beforeEach(async () => {
  await setup();
  dev = require('../src/services/smarthome/smarthomeDevices');
  svc = require('../src/services/smarthome');
  rules = require('../src/services/smarthome/smarthomeRules');
});
afterEach(async () => { await teardown(); });

// Fake deconz client capturing calls; injected via rules._setClientFactoryForTest.
function fakeClient(log, opts = {}) {
  let n = 0;
  return {
    getRules: async () => opts.rules || {},
    createRule: async (r) => { log.push(['createRule', r.name]); if (opts.failOnRule && r.name.includes(opts.failOnRule)) { const e = new Error('limit'); e.code = 'DECONZ_HTTP_503'; throw e; } return `R${++n}`; },
    updateRule: async (id, r) => log.push(['updateRule', id]),
    deleteRule: async (id) => log.push(['deleteRule', id]),
    createSchedule: async (s) => { log.push(['createSchedule', s.name]); return `S${++n}`; },
    deleteSchedule: async (id) => log.push(['deleteSchedule', id]),
    createClipSensor: async (s) => { log.push(['createClipSensor', s.name]); return `C${++n}`; },
    deleteClipSensor: async (id) => log.push(['deleteClipSensor', id]),
  };
}

function mkGatewayAndMotionGroup() {
  const gw = dev.createGateway({ name: 'GW', route_id: null, apiKey: 'K', enabled: true });
  const motion = dev.upsertResource({ gateway_id: gw.id, deconz_id: '12', deconz_type: 'sensors', kind: 'sensor', name: 'M', capabilities: {} });
  const group = dev.upsertResource({ gateway_id: gw.id, deconz_id: '30', deconz_type: 'groups', kind: 'group', name: 'G', capabilities: { on: true } });
  return { gw, motion, group };
}

test('create persists deconz_rule_id and lists as synced', async () => {
  const log = [];
  rules._setClientFactoryForTest(() => fakeClient(log));
  const { gw, motion, group } = mkGatewayAndMotionGroup();
  const def = { triggers: [{ kind: 'motion', resourceId: motion, event: 'detected' }], actions: [{ kind: 'group', resourceId: group, set: { on: true } }] };
  const row = await rules.create(gw.id, 'Flur', def);
  assert.ok(row.deconz_rule_id);
  const list = rules.list(gw.id);
  assert.equal(list[0].synced, true);
  assert.ok(log.some((l) => l[0] === 'createRule'));
});

test('create compensates: schedule created then rule fails → schedule deleted, no GC row', async () => {
  const log = [];
  rules._setClientFactoryForTest(() => fakeClient(log, { failOnRule: 'Flur' }));
  const { gw, motion, group } = mkGatewayAndMotionGroup();
  const def = { triggers: [{ kind: 'motion', resourceId: motion, event: 'ended' }], actions: [{ kind: 'group', resourceId: group, set: { on: false } }], delay: { minutes: 5, onRetrigger: 'ignore' } };
  await assert.rejects(() => rules.create(gw.id, 'Flur', def), (e) => e.code === 'DECONZ_RULE_LIMIT_REACHED');
  assert.ok(log.some((l) => l[0] === 'deleteSchedule')); // compensation ran
  assert.equal(rules.list(gw.id).length, 0); // no orphan GC row
});

test('update nulls ids before delete; on success re-persists', async () => {
  const log = [];
  rules._setClientFactoryForTest(() => fakeClient(log));
  const { gw, motion, group } = mkGatewayAndMotionGroup();
  const def = { triggers: [{ kind: 'motion', resourceId: motion, event: 'detected' }], actions: [{ kind: 'group', resourceId: group, set: { on: true } }] };
  const row = await rules.create(gw.id, 'R', def);
  const updated = await rules.update(row.id, 'R2', def);
  assert.equal(updated.name, 'R2');
  assert.ok(updated.deconz_rule_id);
  assert.ok(log.some((l) => l[0] === 'deleteRule')); // old deleted
});

test('remove deletes deconz objects then row (404 ignored)', async () => {
  const log = [];
  rules._setClientFactoryForTest(() => ({ ...fakeClient(log), deleteRule: async () => { const e = new Error('gone'); e.code = 'DECONZ_HTTP_404'; throw e; } }));
  const { gw, motion, group } = mkGatewayAndMotionGroup();
  // seed a row directly with a fake id:
  const { getDb } = require('../src/db/connection');
  const id = Number(getDb().prepare("INSERT INTO smarthome_rules (gateway_id, name, enabled, definition_json, deconz_rule_id) VALUES (?,?,1,?,?)").run(gw.id, 'X', '{}', 'R9').lastInsertRowid);
  await rules.remove(id); // must not throw despite 404
  assert.equal(rules.list(gw.id).length, 0);
});

test('DECONZ_RULE_LIMIT_REACHED mapped from 503/507', async () => {
  const log = [];
  rules._setClientFactoryForTest(() => fakeClient(log, { failOnRule: 'L' }));
  const { gw, motion, group } = mkGatewayAndMotionGroup();
  const def = { triggers: [{ kind: 'motion', resourceId: motion, event: 'detected' }], actions: [{ kind: 'group', resourceId: group, set: { on: true } }] };
  await assert.rejects(() => rules.create(gw.id, 'L', def), (e) => e.code === 'DECONZ_RULE_LIMIT_REACHED');
});

test('gatewayRuleCount attributes GC-named rules (incl #reset/#cancel) to gc, not external', async () => {
  rules._setClientFactoryForTest(() => ({
    getRules: async () => ({
      '1': { name: 'GC:5:Flur' },        // primary GC rule
      '2': { name: 'GC:5:Flur#reset' },  // secondary GC rule (reset chain)
      '3': { name: 'GC:8:Bad#cancel' },  // secondary GC rule (cancel chain)
      '4': { name: 'pir-fsm-reset' },    // external (Phoscon-created)
      '5': { name: 'my hue rule' },      // external
    }),
  }));
  const { gw } = mkGatewayAndMotionGroup();
  const c = await rules.gatewayRuleCount(gw.id);
  assert.equal(c.total_rules, 5);
  assert.equal(c.gc_rules, 3);       // GC: prefix, incl #reset/#cancel — not the DB deconz_rule_id column
  assert.equal(c.external_rules, 2); // only the two genuinely external rules
});
