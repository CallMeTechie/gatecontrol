'use strict';

// "Statusseite im VPN (HTTPS)" (docs/feature-vpn-names.md „Statusseite eines
// Gateways im VPN“, gateway docs/setup-page.md „Aus dem VPN per HTTPS“):
// switch per gateway (off by default), features.setup_page.vpn_https +
// vpn_name in the config pull, the overview part, and "Im VPN öffnen" — a
// one-time ticket of which only the SHA-256 goes to the gateway.

const crypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown, getCsrf } = require('./helpers/setup');

const AREA = 'geraete.vpn.example.com';
const HOST = `gw-keller.${AREA}`;
let agent, csrf, db, features, gateways, vpnCert, license, id, token;
const origShare = {};
const put = (body) => agent.put(`/api/v1/gateways/${id}/features`).set('X-CSRF-Token', csrf).send(body);
const open = () => agent.post(`/api/v1/gateways/${id}/setup-page/vpn-open`).set('X-CSRF-Token', csrf).send({});

function summary(host = HOST) {
  return { wildcard: `*.${AREA}`, zone: 'vpn.example.com', device_zone: AREA, server_host: 'server.vpn.example.com', host, fingerprint: 'ab'.repeat(32), not_after: '2027-02-01T00:00:00.000Z' };
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
  license = require('../src/services/license');
  license._overrideForTest({ gateway_peers: 20, http_routes: -1, gateway_http_targets: -1 });
  origShare.summary = vpnCert.shareSummary;
  origShare.mgmt = gateways.mgmtCall;
  const r = await agent.post('/api/v1/peers').set('X-CSRF-Token', csrf).send({ name: 'Pi Keller', is_gateway: true, platform: 'rpi' }).expect(201);
  id = r.body.peer.id;
  const code = (await agent.post(`/api/v1/peers/${id}/gateway-pairing-code`).set('X-CSRF-Token', csrf).send({}).expect(200)).body.code;
  const env = (await agent.post('/api/v1/gateway/pair').send({ code }).expect(200)).body.envContent;
  token = /^GC_API_TOKEN=(gc_gw_[0-9a-f]{64})$/m.exec(env)[1];
});
after(() => { vpnCert.shareSummary = origShare.summary; gateways.mgmtCall = origShare.mgmt; teardown(); });
afterEach(() => { vpnCert.shareSummary = origShare.summary; gateways.mgmtCall = origShare.mgmt; });

describe('status page over the VPN: switch and config pull', () => {
  it('is off by default and leaves the config pull as it was', () => {
    assert.deepEqual(features.get(id).setupPageVpn, { enabled: false });
    assert.deepEqual(features.configPayload(id).setup_page, { status: true });
  });

  it('switched on: vpn_https and vpn_name (the device name in the device area) — the hash changes', async () => {
    vpnCert.shareSummary = (peerId) => (Number(peerId) === id ? summary() : null);
    const hash0 = gateways.computeConfigHash(id);
    const o = (await put({ setupPageVpn: { enabled: true } }).expect(200)).body.gateway;
    assert.deepEqual(o.features.setupPageVpn, { enabled: true });
    assert.deepEqual(features.configPayload(id).setup_page, { status: true, vpn_https: true, vpn_name: 'gw-keller' });
    assert.notEqual(gateways.computeConfigHash(id), hash0);
    // no name in the device area (kept free / no device name) or nothing passed on: no vpn_name
    vpnCert.shareSummary = () => summary(null);
    assert.deepEqual(features.configPayload(id).setup_page, { status: true, vpn_https: true });
    vpnCert.shareSummary = () => null;
    assert.deepEqual(features.configPayload(id).setup_page, { status: true, vpn_https: true });
    await put({ setupPageVpn: { enabled: 'yes' } }).expect(400);
    await put({ setupPageVpn: { port: 443 } }).expect(400);
  });

  it('overview: hint for an older gateway, the button only with capability and device wildcard', async () => {
    vpnCert.shareSummary = () => summary();
    await heartbeat({ gateway_version: '1.41.0', capabilities: ['setup-page', 'vpn-cert'] });
    let v = (await agent.get(`/api/v1/gateways/${id}/features`).expect(200)).body.gateway.setupPageVpn;
    assert.deepEqual(v, { enabled: true, supported: false, shared: true, host: HOST, port: null, state: null, canOpen: false, minGateway: '1.42.0' });
    await heartbeat({ gateway_version: '1.43.0', capabilities: ['setup-page', 'setup-page-vpn', 'vpn-cert', 'vpn-cert-devices'],
      setup_page: { status: true, mode: 'connected', vpn_https: { enabled: true, state: 'listening', host: HOST, port: 8643, sessions: 0 } } });
    v = (await agent.get(`/api/v1/gateways/${id}/features`).expect(200)).body.gateway.setupPageVpn;
    assert.equal(v.supported, true);
    assert.equal(v.state, 'listening');
    assert.equal(v.port, 8643);
    assert.equal(v.canOpen, true);
    vpnCert.shareSummary = () => null;
    v = (await agent.get(`/api/v1/gateways/${id}/features`).expect(200)).body.gateway.setupPageVpn;
    assert.equal(v.shared, false);
    assert.equal(v.canOpen, false);
  });
});

describe('status page over the VPN: "Im VPN öffnen"', () => {
  it('hands only the SHA-256 of a one-time ticket to the gateway and answers with the URL', async () => {
    vpnCert.shareSummary = () => summary();
    const calls = [];
    gateways.mgmtCall = async (peerId, path, payload) => {
      calls.push({ peerId, path, payload });
      return { status: 200, body: { ok: true, host: HOST, port: 8643, expires_in_s: 60 } };
    };
    const r = await open().expect(200);
    assert.match(r.headers['cache-control'], /no-store/);
    const u = new URL(r.body.url);
    assert.equal(u.protocol, 'https:');
    assert.equal(u.host, `${HOST}:8643`);
    assert.equal(u.pathname, '/login');
    const ticket = u.searchParams.get('t');
    assert.match(ticket, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].path, '/api/status-page/ticket');
    assert.equal(calls[0].payload.ttl_s, 60);
    assert.equal(calls[0].payload.ticket_sha256, crypto.createHash('sha256').update(ticket).digest('hex'));
    assert.equal(JSON.stringify(calls[0].payload).includes(ticket), false, 'never the ticket itself');
    const act = db.prepare("SELECT details FROM activity_log WHERE event_type = 'gateway_status_page_vpn_opened' ORDER BY id DESC LIMIT 1").get();
    assert.ok(act);
    assert.equal(act.details.includes(ticket), false, 'the ticket is not logged');
    // a second click: a new ticket
    const r2 = await open().expect(200);
    assert.notEqual(new URL(r2.body.url).searchParams.get('t'), ticket);
  });

  it('refuses when off, without wildcard or name, and when the gateway answers something else', async () => {
    gateways.mgmtCall = async () => ({ status: 200, body: { ok: true, host: HOST, port: 8643 } });
    vpnCert.shareSummary = () => null;
    assert.equal((await open().expect(409)).body.code, 'unavailable');
    vpnCert.shareSummary = () => summary(null);
    assert.equal((await open().expect(409)).body.code, 'unavailable');
    vpnCert.shareSummary = () => summary();
    gateways.mgmtCall = async () => ({ status: 200, body: { ok: true, host: 'evil.example.net', port: 8643 } });
    assert.equal((await open().expect(502)).body.code, 'gateway_error');
    gateways.mgmtCall = async () => ({ status: 409, body: { ok: false, error: 'no_cert' } });
    const refused = (await open().expect(409)).body;
    assert.equal(refused.code, 'gateway_refused');
    assert.equal(refused.reason, 'no_cert');
    gateways.mgmtCall = async () => null;
    assert.equal((await open().expect(502)).body.code, 'gateway_unreachable');
    await put({ setupPageVpn: { enabled: false } }).expect(200);
    gateways.mgmtCall = async () => { throw new Error('must not be called'); };
    assert.equal((await open().expect(409)).body.code, 'unavailable');
    assert.deepEqual(features.configPayload(id).setup_page, { status: true });
  });

  it('needs CSRF and an admin session', async () => {
    await agent.post(`/api/v1/gateways/${id}/setup-page/vpn-open`).send({}).expect(403);
    await agent.post('/api/v1/gateways/999999/setup-page/vpn-open').set('X-CSRF-Token', csrf).send({}).expect(404);
  });
});
