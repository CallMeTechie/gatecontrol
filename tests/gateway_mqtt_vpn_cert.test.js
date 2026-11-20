'use strict';

// "Gerätezertifikat verwenden" for the MQTT broker of a gateway (docs/feature-vpn-names.md „MQTT eines
// Gateways mit dem Gerätezertifikat“, gateway docs/vpn-cert.md): switch per gateway (off by default),
// features.mqtt_tls { vpn_cert, vpn_name } in the config pull, the name mqtt-<gateway>.<device area> in the
// VPN DNS only while on, the part for the TLS card, and what the edge status passes on.

const crypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown, getCsrf } = require('./helpers/setup');

const ZONE = 'vpn.example.test';
const AREA = `geraete.${ZONE}`;
let agent, csrf, db, features, gateways, vpnCert, vpnNames, dns, license, id, token, hostname;
const orig = {};
const put = (body) => agent.put(`/api/v1/gateways/${id}/features`).set('X-CSRF-Token', csrf).send(body);

function summary() {
  return { wildcard: `*.${AREA}`, zone: ZONE, device_zone: AREA, server_host: `server.${ZONE}`, host: `${hostname}.${AREA}`, fingerprint: 'ab'.repeat(32), not_after: '2027-02-01T00:00:00.000Z' };
}
function customZone() {
  vpnNames.current = () => ({ base: 'example.test', sub: 'vpn', custom: true, primary: ZONE, legacy: 'gc.internal', zones: [ZONE, 'gc.internal'], removed: false });
}
async function heartbeat(telemetry) {
  await agent.post('/api/v1/gateway/heartbeat').set('Authorization', `Bearer ${token}`).send({ telemetry }).expect(200);
}

before(async () => {
  ({ agent } = await setup());
  csrf = getCsrf();
  db = require('../src/db/connection').getDb();
  features = require('../src/services/gatewayFeatures');
  gateways = require('../src/services/gateways');
  vpnCert = require('../src/services/vpnCert');
  vpnNames = require('../src/services/vpnNames');
  dns = require('../src/services/dns');
  license = require('../src/services/license');
  license._overrideForTest({ gateway_peers: 20, http_routes: -1, gateway_http_targets: -1 });
  orig.summary = vpnCert.shareSummary;
  orig.current = vpnNames.current;
  const r = await agent.post('/api/v1/peers').set('X-CSRF-Token', csrf).send({ name: 'Pi Keller', is_gateway: true, platform: 'rpi' }).expect(201);
  id = r.body.peer.id;
  // the gateway's name in the VPN (set in the peer's settings)
  hostname = 'gw-keller';
  db.prepare('UPDATE peers SET hostname = ? WHERE id = ?').run(hostname, id);
  const code = (await agent.post(`/api/v1/peers/${id}/gateway-pairing-code`).set('X-CSRF-Token', csrf).send({}).expect(200)).body.code;
  const env = (await agent.post('/api/v1/gateway/pair').send({ code }).expect(200)).body.envContent;
  token = /^GC_API_TOKEN=(gc_gw_[0-9a-f]{64})$/m.exec(env)[1];
});
after(() => { vpnCert.shareSummary = orig.summary; vpnNames.current = orig.current; teardown(); });
afterEach(() => { vpnCert.shareSummary = orig.summary; vpnNames.current = orig.current; });

describe('MQTT with the device certificate: switch and config pull', () => {
  it('is off by default: no mqtt_tls in the config pull, no name in the DNS', () => {
    customZone();
    assert.ok(hostname, 'the gateway has a name in the VPN');
    assert.deepEqual(features.get(id).mqttVpnCert, { enabled: false, fingerprintPort: false });
    assert.equal('mqtt_tls' in features.configPayload(id), false);
    assert.ok(!dns.renderHostsContent().includes(`mqtt-${hostname}.`));
  });

  it('switched on: mqtt_tls { vpn_cert, vpn_name: mqtt-<gateway> }, the hash changes, the name resolves to the tunnel address', async () => {
    customZone();
    vpnCert.shareSummary = (peerId) => (Number(peerId) === id ? summary() : null);
    const hash0 = gateways.computeConfigHash(id);
    await put({ mqttVpnCert: { enabled: true } }).expect(200);
    assert.deepEqual(features.get(id).mqttVpnCert, { enabled: true, fingerprintPort: false });
    assert.deepEqual(features.configPayload(id).mqtt_tls, { vpn_cert: true, vpn_name: `mqtt-${hostname}` });
    assert.notEqual(gateways.computeConfigHash(id), hash0);
    const ip = db.prepare('SELECT allowed_ips FROM peers WHERE id = ?').get(id).allowed_ips.split('/')[0];
    const lines = dns.renderHostsContent().split('\n');
    assert.ok(lines.includes(`${ip}\tmqtt-${hostname}.${AREA}`), 'one level below the device area — covered by the wildcard');
    assert.ok(!lines.some((l) => l.includes(`mqtt.${hostname}.`) || l.endsWith(`\tmqtt.${AREA}`)), 'never two levels, never the bare mqtt name');
    await put({ mqttVpnCert: { enabled: 'yes' } }).expect(400);
    await put({ mqttVpnCert: { host: 'x' } }).expect(400);
    // off again: the field and the record are gone
    await put({ mqttVpnCert: { enabled: false } }).expect(200);
    assert.equal('mqtt_tls' in features.configPayload(id), false);
    assert.ok(!dns.renderHostsContent().includes(`mqtt-${hostname}.`));
  });

  it('mqttVpnName: one label, unique per gateway; problems instead of a wrong name', () => {
    assert.deepEqual(features.mqttVpnName('gw-keller', { deviceZone: AREA }), { label: 'mqtt-gw-keller', host: `mqtt-gw-keller.${AREA}` });
    assert.deepEqual(features.mqttVpnName('gw-keller', { deviceZone: null }), { problem: 'no_zone' });
    assert.deepEqual(features.mqttVpnName('', { deviceZone: AREA }), { problem: 'no_name' });
    assert.deepEqual(features.mqttVpnName('mqtt', { deviceZone: AREA }), { problem: 'no_name' }, 'a name kept free in the device area');
    assert.deepEqual(features.mqttVpnName('a.b', { deviceZone: AREA }), { problem: 'no_name' });
    assert.deepEqual(features.mqttVpnName('x'.repeat(60), { deviceZone: AREA }), { problem: 'too_long' });
    db.prepare("UPDATE peers SET hostname = 'mqtt-gw-taken' WHERE id = ?").run(id);
    try {
      assert.deepEqual(features.mqttVpnName('gw-taken', { deviceZone: AREA }), { problem: 'name_taken' }, 'a device of that name keeps its record');
    } finally { db.prepare('UPDATE peers SET hostname = ? WHERE id = ?').run(hostname, id); }
  });

  it('without an own zone for the names: switched on, but no vpn_name and no record', async () => {
    vpnNames.current = () => ({ base: '', sub: 'vpn', custom: false, primary: 'gc.internal', legacy: 'gc.internal', zones: ['gc.internal'], removed: false });
    await put({ mqttVpnCert: { enabled: true } }).expect(200);
    try {
      assert.deepEqual(features.configPayload(id).mqtt_tls, { vpn_cert: true });
      assert.ok(!dns.renderHostsContent().includes('mqtt-'));
    } finally { await put({ mqttVpnCert: { enabled: false } }).expect(200); }
  });
});

describe('MQTT with the device certificate: the part for the TLS card', () => {
  it('supported only by the capability; state and tunnel from the heartbeat; shown in the edge overview', async () => {
    customZone();
    vpnCert.shareSummary = () => summary();
    await heartbeat({ gateway_version: '1.43.0', capabilities: ['vpn-cert', 'vpn-cert-devices'] });
    let v = features.mqttVpnCertPart(id);
    assert.deepEqual(v, { enabled: false, supported: false, shared: true, wildcard: `*.${AREA}`, notAfter: '2027-02-01T00:00:00.000Z',
      host: `mqtt-${hostname}.${AREA}`, problem: null, state: null, tunnel: null, minGateway: '1.44.0',
      fingerprintPort: { enabled: false, supported: false, port: 8884, state: null, tunnel: null, minGateway: '1.45.0' } });
    await put({ mqttVpnCert: { enabled: true } }).expect(200);
    await heartbeat({ gateway_version: '1.44.0', capabilities: ['vpn-cert', 'vpn-cert-devices', 'mqtt-vpn-cert'],
      mqtt_tls: { vpn_cert: { enabled: true, state: 'active', host: `mqtt-${hostname}.${AREA}`, tunnel: 'port_in_use' } } });
    v = features.mqttVpnCertPart(id);
    assert.equal(v.supported, true);
    assert.equal(v.state, 'active');
    assert.equal(v.tunnel, 'port_in_use');
    await heartbeat({ gateway_version: '1.44.0', capabilities: ['mqtt-vpn-cert'], mqtt_tls: { vpn_cert: { state: 'evil', tunnel: '<x>' } } });
    v = features.mqttVpnCertPart(id);
    assert.equal(v.state, null);
    assert.equal(v.tunnel, null);
    vpnCert.shareSummary = () => null;
    assert.equal(features.mqttVpnCertPart(id).shared, false);
    const edge = require('../src/services/edge');
    assert.equal(edge.overview(id, 'de').mqttVpnCert.enabled, true);
    await put({ mqttVpnCert: { enabled: false } }).expect(200);
  });

  it('an older gateway (no capability) keeps working: the switch is off and nothing goes into the config pull', async () => {
    await heartbeat({ gateway_version: '1.40.0', capabilities: ['vpn-cert'] });
    assert.equal(features.mqttVpnCertPart(id).supported, false);
    assert.equal('mqtt_tls' in features.configPayload(id), false);
  });
});

describe('MQTT with the device certificate: edge status', () => {
  it('tlsSourceOf: self | vpn-cert with a valid name only', () => {
    const { tlsSourceOf } = require('../src/services/edge/hub');
    assert.deepEqual(tlsSourceOf({ tlsSource: 'self' }), { tlsSource: 'self' });
    assert.deepEqual(tlsSourceOf({}), {}, 'an older gateway reports no source');
    assert.deepEqual(tlsSourceOf({ tlsSource: 'vpn-cert', tlsHost: `MQTT-GW.${AREA}` }), { tlsSource: 'vpn-cert', tlsHost: `mqtt-gw.${AREA}` });
    assert.deepEqual(tlsSourceOf({ tlsSource: 'vpn-cert', tlsHost: 'a b.example.test' }), { tlsSource: 'vpn-cert' });
    assert.deepEqual(tlsSourceOf({ tlsSource: 'vpn-cert', tlsHost: 'localhost' }), { tlsSource: 'vpn-cert' });
    assert.deepEqual(tlsSourceOf({ tlsSource: 'other' }), {});
  });
});
