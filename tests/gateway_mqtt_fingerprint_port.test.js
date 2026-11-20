'use strict';

// "Zweiter Port für Geräte mit Fingerabdruck (8884)" under "Gerätezertifikat verwenden" (docs/feature-vpn-names.md
// „MQTT eines Gateways mit dem Gerätezertifikat“, gateway docs/vpn-cert.md „Zweiter Port für Geräte mit
// Fingerabdruck“): sub-switch per gateway (off by default, only with the device certificate),
// features.mqtt_tls.fingerprint_port in the config pull, the part for the TLS card, and tlsFp in the edge status.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown, getCsrf } = require('./helpers/setup');

const ZONE = 'vpn.example.test';
let agent, csrf, db, features, gateways, vpnNames, license, id, token;
const orig = {};
const put = (body) => agent.put(`/api/v1/gateways/${id}/features`).set('X-CSRF-Token', csrf).send(body);
async function heartbeat(telemetry) {
  await agent.post('/api/v1/gateway/heartbeat').set('Authorization', `Bearer ${token}`).send({ telemetry }).expect(200);
}
function customZone() {
  vpnNames.current = () => ({ base: 'example.test', sub: 'vpn', custom: true, primary: ZONE, legacy: 'gc.internal', zones: [ZONE, 'gc.internal'], removed: false });
}

before(async () => {
  ({ agent } = await setup());
  csrf = getCsrf();
  db = require('../src/db/connection').getDb();
  features = require('../src/services/gatewayFeatures');
  gateways = require('../src/services/gateways');
  vpnNames = require('../src/services/vpnNames');
  license = require('../src/services/license');
  license._overrideForTest({ gateway_peers: 20, http_routes: -1, gateway_http_targets: -1 });
  orig.current = vpnNames.current;
  const r = await agent.post('/api/v1/peers').set('X-CSRF-Token', csrf).send({ name: 'Pi Flur', is_gateway: true, platform: 'rpi' }).expect(201);
  id = r.body.peer.id;
  db.prepare('UPDATE peers SET hostname = ? WHERE id = ?').run('gw-flur', id);
  const code = (await agent.post(`/api/v1/peers/${id}/gateway-pairing-code`).set('X-CSRF-Token', csrf).send({}).expect(200)).body.code;
  const env = (await agent.post('/api/v1/gateway/pair').send({ code }).expect(200)).body.envContent;
  token = /^GC_API_TOKEN=(gc_gw_[0-9a-f]{64})$/m.exec(env)[1];
});
after(() => { vpnNames.current = orig.current; teardown(); });
afterEach(async () => { vpnNames.current = orig.current; await put({ mqttVpnCert: { enabled: false } }).expect(200); });

describe('MQTT port 8884 with the self-made certificate: sub-switch and config pull', () => {
  it('off by default; switched on with the device certificate: fingerprint_port: true, the hash changes', async () => {
    customZone();
    await put({ mqttVpnCert: { enabled: true } }).expect(200);
    assert.deepEqual(features.get(id).mqttVpnCert, { enabled: true, fingerprintPort: false });
    assert.deepEqual(features.configPayload(id).mqtt_tls, { vpn_cert: true, vpn_name: 'mqtt-gw-flur' }, 'without the sub-switch exactly as before');
    const hash0 = gateways.computeConfigHash(id);
    await put({ mqttVpnCert: { fingerprintPort: true } }).expect(200);
    assert.deepEqual(features.get(id).mqttVpnCert, { enabled: true, fingerprintPort: true });
    assert.deepEqual(features.configPayload(id).mqtt_tls, { vpn_cert: true, vpn_name: 'mqtt-gw-flur', fingerprint_port: true });
    assert.notEqual(gateways.computeConfigHash(id), hash0);
    await put({ mqttVpnCert: { fingerprintPort: false } }).expect(200);
    assert.deepEqual(features.configPayload(id).mqtt_tls, { vpn_cert: true, vpn_name: 'mqtt-gw-flur' });
    assert.equal(gateways.computeConfigHash(id), hash0, 'off again: the same hash as before');
    await put({ mqttVpnCert: { fingerprintPort: 'yes' } }).expect(400);
  });

  it('only together with the device certificate: alone refused, switching the device certificate off also switches it off', async () => {
    customZone();
    await put({ mqttVpnCert: { fingerprintPort: true } }).expect(400);
    assert.deepEqual(features.get(id).mqttVpnCert, { enabled: false, fingerprintPort: false });
    await put({ mqttVpnCert: { enabled: true, fingerprintPort: true } }).expect(200);
    assert.equal(features.configPayload(id).mqtt_tls.fingerprint_port, true);
    await put({ mqttVpnCert: { enabled: false } }).expect(200);
    assert.deepEqual(features.get(id).mqttVpnCert, { enabled: false, fingerprintPort: false });
    assert.equal('mqtt_tls' in features.configPayload(id), false);
    // switching it off always works, also on its own
    await put({ mqttVpnCert: { fingerprintPort: false } }).expect(200);
    // a stored value without the main switch counts as off
    assert.deepEqual(features.normalize({ mqttVpnCert: { enabled: false, fingerprintPort: true } }).mqttVpnCert, { enabled: false, fingerprintPort: false });
  });
});

describe('MQTT port 8884: the part for the TLS card', () => {
  it('supported only by the capability; state and tunnel from the heartbeat, invalid values dropped', async () => {
    customZone();
    await heartbeat({ gateway_version: '1.44.0', capabilities: ['mqtt-vpn-cert'] });
    assert.deepEqual(features.mqttVpnCertPart(id).fingerprintPort, { enabled: false, supported: false, port: 8884, state: null, tunnel: null, minGateway: '1.45.0' },
      'an older gateway (1.44.0) has no capability — the UI shows no sub-switch');
    await put({ mqttVpnCert: { enabled: true, fingerprintPort: true } }).expect(200);
    await heartbeat({ gateway_version: '1.45.0', capabilities: ['mqtt-vpn-cert', 'mqtt-fingerprint-port'],
      mqtt_tls: { vpn_cert: { enabled: true, state: 'active', tunnel: 'listening' }, fingerprint_port: { enabled: true, port: 8884, state: 'active', tunnel: 'port_in_use' } } });
    let f = features.mqttVpnCertPart(id).fingerprintPort;
    assert.equal(f.enabled, true);
    assert.equal(f.supported, true);
    assert.equal(f.state, 'active');
    assert.equal(f.tunnel, 'port_in_use');
    await heartbeat({ gateway_version: '1.45.0', capabilities: ['mqtt-fingerprint-port'], mqtt_tls: { fingerprint_port: { state: '<b>', tunnel: 'evil' } } });
    f = features.mqttVpnCertPart(id).fingerprintPort;
    assert.equal(f.state, null);
    assert.equal(f.tunnel, null);
    await heartbeat({ gateway_version: '1.45.0', capabilities: ['mqtt-fingerprint-port'], mqtt_tls: { fingerprint_port: { state: 'fallback' } } });
    assert.equal(features.mqttVpnCertPart(id).fingerprintPort.state, 'fallback');
    assert.equal(require('../src/services/edge').overview(id, 'de').mqttVpnCert.fingerprintPort.enabled, true);
  });
});

describe('MQTT port 8884: edge status', () => {
  it('tlsFpOf: only next to the device certificate, the PEM only with the reported fingerprint', () => {
    const { tlsFpOf } = require('../src/services/edge/hub');
    // a self-signed certificate like the gateway's (openssl, made-up name)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-fp-'));
    let pem;
    try {
      execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
        '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem'), '-days', '30', '-subj', '/CN=GateControl MQTT'], { stdio: 'ignore' });
      pem = fs.readFileSync(path.join(dir, 'c.pem'), 'utf8');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    const sha = crypto.createHash('sha256').update(new crypto.X509Certificate(pem).raw).digest('hex');
    const out = tlsFpOf({ tlsSource: 'vpn-cert', tlsFp: { port: 8884, sha256: sha, cert: pem } });
    assert.equal(out.tlsFp.port, 8884);
    assert.equal(out.tlsFp.sha256, sha);
    assert.equal(out.tlsFp.cert, pem.trim() + '\n');
    assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(out.tlsFp.validTo));
    assert.deepEqual(tlsFpOf({ tlsSource: 'vpn-cert', tlsFp: { port: 8884, sha256: 'ab'.repeat(32), cert: pem } }), { tlsFp: { port: 8884, sha256: 'ab'.repeat(32) } },
      'another fingerprint: the PEM is dropped');
    assert.deepEqual(tlsFpOf({ tlsSource: 'self', tlsFp: { port: 8884, sha256: sha, cert: pem } }), {}, 'with the self-made certificate on 8883 there is no second port');
    assert.deepEqual(tlsFpOf({ tlsSource: 'vpn-cert' }), {}, 'a gateway without the sub-switch (or older)');
    assert.deepEqual(tlsFpOf({ tlsSource: 'vpn-cert', tlsFp: { port: 'x', sha256: sha } }), {});
    assert.deepEqual(tlsFpOf({ tlsSource: 'vpn-cert', tlsFp: { port: 8884, sha256: 'nope' } }), {});
  });
});
