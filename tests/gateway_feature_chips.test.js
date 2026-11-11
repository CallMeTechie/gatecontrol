'use strict';

// The switched-on functions of a gateway for the chips of its fleet card:
// services/gatewayFeatures.js enabledKeys → `features_on` of GET /api/v1/gateways
// (public/js/gateways.js featureChips; the rule for "+N": tests/gateway_pool_kit.test.js).

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown, getAgent } = require('./helpers/setup');

let agent, db, features;
beforeEach(async () => {
  await setup();
  agent = getAgent();
  db = require('../src/db/connection').getDb();
  features = require('../src/services/gatewayFeatures');
  require('../src/services/gateways').notifyConfigChanged = async () => ({ ok: true });
});
afterEach(teardown);

function gateway(id, name, telemetry) {
  db.prepare("INSERT INTO peers (id, name, public_key, peer_type, allowed_ips, enabled) VALUES (?, ?, ?, 'gateway', ?, 1)")
    .run(id, name, 'pk' + id, `10.8.0.${id}/32`);
  db.prepare(`INSERT INTO gateway_meta (peer_id, api_port, api_token_hash, push_token_encrypted, alive, last_seen_at, created_at, last_health)
    VALUES (?, 9876, ?, 'e', 1, ?, ?, ?)`).run(id, 'h' + id, Date.now(), Date.now(), JSON.stringify({ telemetry: telemetry || {} }));
}

test('a new gateway: what is on from the start, in the order of the card', () => {
  gateway(31, 'Pi Keller');
  assert.deepEqual(features.enabledKeys(31), ['netwatch', 'inetq', 'presence']);
});

test('switched on deliberately comes first; presence needs the network watch', () => {
  gateway(31, 'Pi Keller');
  features.set(31, { print: { enabled: true }, cameras: { enabled: true }, ai: { enabled: true }, radio: { ble: true },
    ups: { enabled: true, host: '192.168.1.9' } });
  require('../src/services/homeCache').set(31, { enabled: true });
  require('../src/services/edge/store').setSettings(31, { edgeEnabled: true, mqttEnabled: true });
  assert.deepEqual(features.enabledKeys(31), ['print', 'cameras', 'radio', 'ai', 'cache', 'edge', 'mqtt', 'ups', 'netwatch', 'inetq', 'presence']);
  assert.ok(features.enabledKeys(31).every((k) => features.CHIP_KEYS.includes(k)));

  features.set(31, { netwatch: { enabled: false }, inetq: { enabled: false }, print: { enabled: false } });
  assert.deepEqual(features.enabledKeys(31), ['cameras', 'radio', 'ai', 'cache', 'edge', 'mqtt', 'ups'], 'no presence without the network watch');
  // MQTT only counts with the edge part
  require('../src/services/edge/store').setSettings(31, { edgeEnabled: false });
  assert.equal(features.enabledKeys(31).includes('mqtt'), false);
  assert.equal(features.enabledKeys(31).includes('edge'), false);
});

test('Funk on "automatic": on when the gateway found a Zigbee radio and wants it', () => {
  gateway(31, 'Pi Keller');
  assert.equal(features.enabledKeys(31, {}).includes('radio'), false, 'no stick, nothing switched on');
  const tel = { capabilities: ['radio'], radio: { zigbee: { want: true, state: 'running', service: 'running' }, ble: { state: 'off' }, thread: { sticks: [] }, sticks: [] } };
  const hr = require('../src/services/homeRadio');
  assert.equal(features.enabledKeys(31, tel).includes('radio'), hr.enabledOf(features.get(31).radio, hr.telemetryRadio(tel)));
  features.set(31, { radio: { zigbee: true } });
  assert.equal(features.enabledKeys(31, {}).includes('radio'), true);
});

test('GET /api/v1/gateways: features_on per gateway — the same as the card "Funktionen" of its overview', async () => {
  gateway(31, 'Pi Keller');
  gateway(32, 'DS918');
  features.set(32, { print: { enabled: true }, cameras: { enabled: true }, netwatch: { enabled: false } });
  const r = await agent.get('/api/v1/gateways?peek=1');
  assert.equal(r.status, 200);
  const by = Object.fromEntries(r.body.gateways.map((g) => [g.peer_id, g.features_on]));
  assert.deepEqual(by[31], ['netwatch', 'inetq', 'presence']);
  assert.deepEqual(by[32], ['print', 'cameras', 'inetq']);

  // the overview of the gateway says the same (public/js/gateway-pool-kit.js featureStates)
  const PK = require('../public/js/gateway-pool-kit');
  for (const id of [31, 32]) {
    const on = PK.featureStates(features.overview(id)).filter((x) => x.on).map((x) => x.key).filter((k) => PK.CHIP_KEYS.includes(k)).sort();
    assert.deepEqual(by[id].slice().sort(), on, 'gateway ' + id);
  }
});

test('the card: chips from features_on, "+N" as a link to the tab "Funktionen"', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'public/js/gateways.js'), 'utf8');
  assert.match(src, /PK\.featureChips\(g\.features_on\)/);
  assert.match(src, /'gwe-chips gw-card-feats'/);
  assert.match(src, /m\.href = '#gw\/' \+ encodeURIComponent\(g\.peer_id\) \+ '\/features'/);
  const css = fs.readFileSync(path.join(__dirname, '..', 'public/css/app.css'), 'utf8');
  assert.match(css, /\.gw-fleet \.gw-card-feats \.gwe-chip \{/);
});
