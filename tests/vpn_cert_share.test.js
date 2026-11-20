'use strict';

// "Zertifikat für die Namen", part 5: passing certificate and key of the
// wildcard on to devices and gateways — off by default, a list of allowed
// peers, an explicit risk confirmation, fetching only authenticated and from
// the peer's VPN address, every fetch logged without the key, a new key after
// passing it on. The certificate is a throw-away self-signed one (openssl);
// all names and values are made up.

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const supertest = require('supertest');

const { setup, teardown, getAgent, getCsrf } = require('./helpers/setup');

const confDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-vpn-cert-share-'));
process.env.GC_DNSMASQ_CONF = path.join(confDir, 'dnsmasq.conf');
process.on('exit', () => { try { fs.rmSync(confDir, { recursive: true, force: true }); } catch { /* ignore */ } });

const TOKEN = 'fake-desec-token-0301';

describe('Zertifikat für die Namen: Weitergabe an Geräte und Gateways', () => {
  let db; let vpnCert; let vpnNames; let tlsGuard; let license; let config; let gatewayFeatures;
  let certDir; let keyPem;

  before(async () => {
    await setup();
    db = require('../src/db/connection').getDb();
    vpnCert = require('../src/services/vpnCert');
    vpnNames = require('../src/services/vpnNames');
    tlsGuard = require('../src/services/tlsGuard');
    license = require('../src/services/license');
    gatewayFeatures = require('../src/services/gatewayFeatures');
    config = require('../config/default');
    license._overrideForTest({ internal_dns: true, api_tokens: true, vpn_peers: -1 });
    fs.mkdirSync(path.dirname(config.dns.hostsFile), { recursive: true });
    require('../src/services/dns').restartDnsmasq = () => {};
  });

  after(() => teardown());

  let deviceId; let gatewayId;
  beforeEach(async () => {
    vpnCert._resetForTest();
    for (const t of ['routes', 'service_bundles', 'peers', 'domains', 'tls_status']) db.prepare(`DELETE FROM ${t}`).run();
    db.prepare("DELETE FROM settings WHERE key LIKE 'dns.names.%' OR key LIKE 'vpn_cert.%'").run();
    db.prepare("DELETE FROM activity_log WHERE event_type LIKE 'tls_vpn_cert%'").run();
    vpnCert.removeSecretFiles();
    license._overrideForTest({ internal_dns: true, api_tokens: true, vpn_peers: -1 });
    fs.writeFileSync(process.env.GC_DNSMASQ_CONF, 'local=/gc.internal/\n');
    db.prepare("INSERT INTO domains (domain, status) VALUES ('example.com', 'verified')").run();
    assert.equal(vpnNames.save('example.com', 'vpn').ok, true);
    deviceId = Number(db.prepare("INSERT INTO peers (name, public_key, allowed_ips, enabled) VALUES ('laptop', 'pk-laptop', '10.8.0.21/32', 1)").run().lastInsertRowid);
    gatewayId = Number(db.prepare("INSERT INTO peers (name, public_key, allowed_ips, enabled, peer_type) VALUES ('gw-home', 'pk-gw', '10.8.0.2/32', 1, 'gateway')").run().lastInsertRowid);
    // the wildcard in Caddy's storage, the way Caddy keeps it
    certDir = path.join(config.caddy.dataDir, 'caddy', 'certificates', 'acme-v02.api.letsencrypt.org-directory', 'wildcard_.vpn.example.com');
    fs.rmSync(certDir, { recursive: true, force: true });
    fs.mkdirSync(certDir, { recursive: true });
    const crt = path.join(certDir, 'wildcard_.vpn.example.com.crt');
    const key = path.join(certDir, 'wildcard_.vpn.example.com.key');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', key, '-out', crt,
      '-days', '60', '-subj', '/CN=*.vpn.example.com'], { stdio: 'ignore' });
    keyPem = fs.readFileSync(key, 'utf8');
    const res = await getAgent().put('/api/v1/settings/vpn-cert').set('X-CSRF-Token', getCsrf()).send({ provider: 'desec', credentials: { token: TOKEN } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    tlsGuard.writeRow('*.vpn.example.com', { state: 'issued', not_after: new Date(Date.now() + 59 * 86400000).toISOString(), issuer: 'Test' });
    vpnCert.refreshServed('test');
  });

  const share = (body) => getAgent().put('/api/v1/settings/vpn-cert/share').set('X-CSRF-Token', getCsrf()).send(body);
  const activity = () => db.prepare("SELECT event_type, message, details FROM activity_log WHERE event_type LIKE 'tls_vpn_cert%'").all();

  it('off by default: nothing for anyone', () => {
    const v = vpnCert.view().share;
    assert.equal(v.enabled, false);
    assert.deepEqual(v.allowed, []);
    assert.equal(vpnCert.shareSummary(gatewayId), null);
    assert.equal(vpnCert.fetchFor(gatewayId, { ip: '10.8.0.2' }).code, 'not_shared');
    assert.equal('vpn_cert' in gatewayFeatures.configPayload(gatewayId), false);
  });

  it('switching on needs the risk confirmation and known peers', async () => {
    let res = await share({ enabled: true, peers: [gatewayId] });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'risk_not_accepted');
    res = await share({ enabled: true, peers: [999999], accept_risk: true });
    assert.equal(res.body.code, 'peers_invalid');
    res = await share({ enabled: true, peers: [gatewayId], accept_risk: true });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.share.enabled, true);
    assert.deepEqual(res.body.data.share.allowed, [gatewayId]);
    assert.match(res.body.data.share.fingerprint, /^[0-9a-f]{64}$/);
    assert.ok(!JSON.stringify(res.body).includes('PRIVATE KEY'), 'no key in the admin view');
    assert.ok(activity().some((a) => a.event_type === 'tls_vpn_cert_share_on'));
  });

  it('only allowed peers, only from their VPN address; the key is logged by fingerprint only', async () => {
    await share({ enabled: true, peers: [gatewayId], accept_risk: true });
    assert.equal(vpnCert.fetchFor(deviceId, { ip: '10.8.0.21' }).code, 'not_allowed');
    assert.equal(vpnCert.fetchFor(gatewayId, { ip: '203.0.113.9' }).code, 'not_from_vpn');
    const r = vpnCert.fetchFor(gatewayId, { via: 'gateway', ip: '::ffff:10.8.0.2' });
    assert.equal(r.ok, true);
    assert.equal(r.key_pem, keyPem);
    assert.match(r.cert_pem, /BEGIN CERTIFICATE/);
    assert.equal(r.wildcard, '*.vpn.example.com');
    const log = activity().filter((a) => a.event_type === 'tls_vpn_cert_key_fetched');
    assert.equal(log.length, 1);
    assert.ok(!JSON.stringify(log).includes('PRIVATE KEY'));
    assert.ok(JSON.parse(log[0].details).fingerprint);
    // the config pull of the allowed gateway names it; no other gateway's config changes
    const s = vpnCert.shareSummary(gatewayId);
    assert.equal(s.fingerprint, r.fingerprint);
    assert.equal(vpnCert.shareSummary(deviceId), null);
    assert.deepEqual(gatewayFeatures.configPayload(gatewayId).vpn_cert, s);
  });

  it('the gateway API: token, tunnel address', async () => {
    await share({ enabled: true, peers: [gatewayId], accept_risk: true });
    const crypto = require('node:crypto');
    const tokenPlain = 'gc_gw_' + crypto.randomBytes(16).toString('hex');
    const { hashToken } = require('../src/middleware/gatewayAuth');
    db.prepare("INSERT INTO gateway_meta (peer_id, api_port, api_token_hash, push_token_encrypted, created_at) VALUES (?, 9876, ?, 'e', strftime('%s','now')*1000)")
      .run(gatewayId, hashToken(tokenPlain));
    const app = getAgent().app;
    // supertest comes from 127.0.0.1 — not the gateway's VPN address
    const res = await supertest(app).get('/api/v1/gateway/vpn-cert').set('Authorization', 'Bearer ' + tokenPlain);
    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'not_from_vpn');
    assert.equal(res.headers['cache-control'], 'no-store');
    const none = await supertest(app).get('/api/v1/gateway/vpn-cert');
    assert.equal(none.status, 401);
  });

  it('the app API needs a token bound to the device', async () => {
    await share({ enabled: true, peers: [deviceId], accept_risk: true });
    const tok = await getAgent().post('/api/v1/tokens').set('x-csrf-token', getCsrf()).send({ name: 'vcs-1', scopes: ['client'] }).expect(201);
    const res = await supertest(getAgent().app).get('/api/v1/client/vpn-cert').set('X-API-Key', tok.body.token);
    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'not_registered');
    const session = await getAgent().get('/api/v1/client/vpn-cert');
    assert.ok(session.status === 403 || session.status === 401);
  });

  it('switching off, then a new key: the stored certificate goes, the row waits for the new one', async () => {
    await share({ enabled: true, peers: [gatewayId], accept_risk: true });
    assert.equal(vpnCert.fetchFor(gatewayId, { ip: '10.8.0.2' }).ok, true);
    let res = await getAgent().post('/api/v1/settings/vpn-cert/rotate-key').set('X-CSRF-Token', getCsrf());
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'share_on');
    res = await share({ enabled: false, peers: [] });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.share.used, true);
    assert.equal(vpnCert.fetchFor(gatewayId, { ip: '10.8.0.2' }).code, 'not_shared');
    res = await getAgent().post('/api/v1/settings/vpn-cert/rotate-key').set('X-CSRF-Token', getCsrf());
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(fs.existsSync(certDir), false);
    assert.equal(tlsGuard.getRow('*.vpn.example.com').state, 'pending');
    assert.equal(res.body.data.share.used, false);
    assert.ok(activity().some((a) => a.event_type === 'tls_vpn_cert_key_rotated'));
    res = await getAgent().post('/api/v1/settings/vpn-cert/rotate-key').set('X-CSRF-Token', getCsrf());
    assert.equal(res.body.code, 'rotate_not_needed');
  });

  it('switching the certificate off ends passing on', async () => {
    await share({ enabled: true, peers: [gatewayId], accept_risk: true });
    await getAgent().delete('/api/v1/settings/vpn-cert').set('X-CSRF-Token', getCsrf()).expect(200);
    assert.equal(vpnCert.view().share.enabled, false);
    assert.equal(vpnCert.fetchFor(gatewayId, { ip: '10.8.0.2' }).code, 'not_shared');
  });
});
