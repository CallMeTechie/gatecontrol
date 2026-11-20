'use strict';

// "Zertifikat für die Namen", passing on: has a gateway in "Darf abholen"
// fetched the wildcard? The gateway (since 1.41.0, capability `vpn-cert`)
// reports telemetry.vpn_cert { fingerprint, not_after } in its heartbeat;
// the server compares it with the certificate it hands out now:
// abgeholt · veraltet · noch nicht abgeholt · Gateway zu alt. "veraltet" for
// more than 24 h is a dashboard problem. The certificate is a throw-away
// self-signed one (openssl); all names and values are made up.

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const { setup, teardown, getAgent, getCsrf } = require('./helpers/setup');

const confDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-vpn-cert-gwstate-'));
process.env.GC_DNSMASQ_CONF = path.join(confDir, 'dnsmasq.conf');
process.on('exit', () => { try { fs.rmSync(confDir, { recursive: true, force: true }); } catch { /* ignore */ } });

const TOKEN = 'fake-desec-token-0417';
const OTHER_FP = 'ab'.repeat(32);
const DAY = 24 * 3600 * 1000;

describe('Zertifikat für die Namen: abgeholt je Gateway', () => {
  let db; let vpnCert; let vpnNames; let tlsGuard; let license; let config; let problems;
  let deviceId; let gatewayId; let otherGwId; let currentFp; let notAfter;

  before(async () => {
    await setup();
    db = require('../src/db/connection').getDb();
    vpnCert = require('../src/services/vpnCert');
    vpnNames = require('../src/services/vpnNames');
    tlsGuard = require('../src/services/tlsGuard');
    license = require('../src/services/license');
    problems = require('../src/services/dashboardProblems');
    config = require('../config/default');
    license._overrideForTest({ internal_dns: true, api_tokens: true, vpn_peers: -1 });
    fs.mkdirSync(path.dirname(config.dns.hostsFile), { recursive: true });
    require('../src/services/dns').restartDnsmasq = () => {};
  });

  after(() => teardown());

  function gatewayMeta(peerId, health) {
    db.prepare(`INSERT OR REPLACE INTO gateway_meta (peer_id, api_port, api_token_hash, push_token_encrypted, created_at, last_seen_at, last_health)
      VALUES (?, 9876, ?, 'x', ?, ?, ?)`).run(peerId, 'hash-' + peerId, Date.now(), Date.now(), health === undefined ? null : JSON.stringify(health));
  }
  const heartbeat = (version, caps, vpnCertTel) => ({ telemetry: { gateway_version: version, capabilities: caps, ...(vpnCertTel !== undefined ? { vpn_cert: vpnCertTel } : {}) } });
  const share = (body) => getAgent().put('/api/v1/settings/vpn-cert/share').set('X-CSRF-Token', getCsrf()).send(body);
  const stateOf = (id) => { const s = vpnCert.gatewayCertStates().get(id); return s ? s.state : null; };

  beforeEach(async () => {
    vpnCert._resetForTest();
    for (const t of ['routes', 'service_bundles', 'gateway_meta', 'peers', 'domains', 'tls_status']) db.prepare(`DELETE FROM ${t}`).run();
    db.prepare("DELETE FROM settings WHERE key LIKE 'dns.names.%' OR key LIKE 'vpn_cert.%'").run();
    vpnCert.removeSecretFiles();
    license._overrideForTest({ internal_dns: true, api_tokens: true, vpn_peers: -1 });
    fs.writeFileSync(process.env.GC_DNSMASQ_CONF, 'local=/gc.internal/\n');
    db.prepare("INSERT INTO domains (domain, status) VALUES ('example.com', 'verified')").run();
    assert.equal(vpnNames.save('example.com', 'vpn').ok, true);
    deviceId = Number(db.prepare("INSERT INTO peers (name, public_key, allowed_ips, enabled) VALUES ('laptop', 'pk-laptop', '10.8.0.21/32', 1)").run().lastInsertRowid);
    gatewayId = Number(db.prepare("INSERT INTO peers (name, public_key, allowed_ips, enabled, peer_type) VALUES ('gw-home', 'pk-gw', '10.8.0.2/32', 1, 'gateway')").run().lastInsertRowid);
    otherGwId = Number(db.prepare("INSERT INTO peers (name, public_key, allowed_ips, enabled, peer_type) VALUES ('gw-garage', 'pk-gw2', '10.8.0.3/32', 1, 'gateway')").run().lastInsertRowid);
    const certDir = path.join(config.caddy.dataDir, 'caddy', 'certificates', 'acme-v02.api.letsencrypt.org-directory', 'wildcard_.vpn.example.com');
    fs.rmSync(certDir, { recursive: true, force: true });
    fs.mkdirSync(certDir, { recursive: true });
    const crt = path.join(certDir, 'wildcard_.vpn.example.com.crt');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
      '-keyout', path.join(certDir, 'wildcard_.vpn.example.com.key'), '-out', crt, '-days', '60', '-subj', '/CN=*.vpn.example.com'], { stdio: 'ignore' });
    const x509 = new crypto.X509Certificate(fs.readFileSync(crt));
    currentFp = x509.fingerprint256.replace(/:/g, '').toLowerCase();
    notAfter = new Date(x509.validTo).toISOString();
    const res = await getAgent().put('/api/v1/settings/vpn-cert').set('X-CSRF-Token', getCsrf()).send({ provider: 'desec', credentials: { token: TOKEN } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    tlsGuard.writeRow('*.vpn.example.com', { state: 'issued', not_after: new Date(Date.now() + 59 * 86400000).toISOString(), issuer: 'Test' });
    vpnCert.refreshServed('test');
  });

  it('passing on off: nothing is shown, not on the gateway, not in the card', async () => {
    gatewayMeta(gatewayId, heartbeat('1.41.0', ['vpn-cert'], null));
    assert.equal(vpnCert.gatewayCertStates().size, 0);
    assert.ok(vpnCert.view().share.peers.every((p) => p.cert === null));
    const res = await getAgent().get('/api/v1/gateways');
    assert.equal(res.status, 200);
    assert.equal(res.body.gateways.find((g) => g.peer_id === gatewayId).vpn_cert, null);
  });

  it('only gateways in "Darf abholen" — no devices, no other gateways', async () => {
    gatewayMeta(gatewayId, heartbeat('1.41.0', ['vpn-cert'], null));
    gatewayMeta(otherGwId, heartbeat('1.41.0', ['vpn-cert'], null));
    const res = await share({ enabled: true, peers: [gatewayId, deviceId], accept_risk: true });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const states = vpnCert.gatewayCertStates();
    assert.deepEqual([...states.keys()], [gatewayId]);
    const peers = res.body.data.share.peers;
    assert.equal(peers.find((p) => p.id === gatewayId).cert.state, 'pending');
    assert.equal(peers.find((p) => p.id === deviceId).cert, null);
    assert.equal(peers.find((p) => p.id === otherGwId).cert, null);
    const gws = (await getAgent().get('/api/v1/gateways')).body.gateways;
    assert.equal(gws.find((g) => g.peer_id === gatewayId).vpn_cert.state, 'pending');
    assert.equal(gws.find((g) => g.peer_id === otherGwId).vpn_cert, null);
  });

  it('the four states from the heartbeat', async () => {
    await share({ enabled: true, peers: [gatewayId], accept_risk: true });
    // never reported: nothing fetched yet (its version is unknown)
    assert.equal(stateOf(gatewayId), 'pending');
    gatewayMeta(gatewayId);
    assert.equal(stateOf(gatewayId), 'pending');
    // without the capability: too old, with the version that can
    gatewayMeta(gatewayId, heartbeat('1.40.2', ['udp-routes']));
    let s = vpnCert.gatewayCertStates().get(gatewayId);
    assert.equal(s.state, 'too_old');
    assert.equal(s.min_version, '1.41.0');
    // able, nothing stored
    gatewayMeta(gatewayId, heartbeat('1.41.0', ['udp-routes', 'vpn-cert'], null));
    assert.equal(stateOf(gatewayId), 'pending');
    // the current one (fingerprint as the gateway writes it, also with colons/upper case)
    gatewayMeta(gatewayId, heartbeat('1.41.0', ['vpn-cert'], { fingerprint: currentFp.toUpperCase().match(/../g).join(':'), not_after: notAfter }));
    s = vpnCert.gatewayCertStates().get(gatewayId);
    assert.equal(s.state, 'fetched');
    assert.equal(s.fingerprint, currentFp);
    assert.equal(s.not_after, notAfter);
    assert.equal(s.stale_since, null);
    // an older one
    gatewayMeta(gatewayId, heartbeat('1.41.0', ['vpn-cert'], { fingerprint: OTHER_FP, not_after: notAfter }));
    s = vpnCert.gatewayCertStates().get(gatewayId);
    assert.equal(s.state, 'stale');
    assert.equal(s.fingerprint, OTHER_FP);
    assert.equal(s.current_fingerprint, currentFp);
    assert.ok(Date.parse(s.stale_since) > Date.now() - 60000, 'counts from switching on');
    // garbage instead of a fingerprint: nothing usable reported
    gatewayMeta(gatewayId, heartbeat('1.41.0', ['vpn-cert'], { fingerprint: 'not-a-fingerprint' }));
    assert.equal(stateOf(gatewayId), 'pending');
    db.prepare("UPDATE gateway_meta SET last_health = '{broken' WHERE peer_id = ?").run(gatewayId);
    assert.equal(stateOf(gatewayId), 'pending');
  });

  it('"veraltet" is a dashboard problem only after 24 h', async () => {
    await share({ enabled: true, peers: [gatewayId], accept_risk: true });
    gatewayMeta(gatewayId, heartbeat('1.41.0', ['vpn-cert'], { fingerprint: OTHER_FP, not_after: notAfter }));
    const soon = await problems.list({ now: Date.now() + 2 * 3600 * 1000, access: null });
    assert.equal(soon.problems.some((p) => p.kind === 'gateway_vpn_cert_stale'), false, 'a short delay is no problem');
    const later = await problems.list({ now: Date.now() + DAY + 60000, access: null });
    const row = later.problems.find((p) => p.kind === 'gateway_vpn_cert_stale');
    assert.ok(row, JSON.stringify(later.problems));
    assert.equal(row.severity, 'warning');
    assert.equal(row.href, '/gateways#gw/' + gatewayId);
    assert.equal(row.gateway.name, 'gw-home');
    assert.equal(row.vpn_cert.current_fingerprint, currentFp);
    assert.ok(row.since);
    // fetched, too old or not yet fetched: never a problem
    for (const h of [heartbeat('1.41.0', ['vpn-cert'], { fingerprint: currentFp, not_after: notAfter }), heartbeat('1.40.0', []), heartbeat('1.41.0', ['vpn-cert'], null)]) {
      gatewayMeta(gatewayId, h);
      const p = await problems.list({ now: Date.now() + 3 * DAY, access: null });
      assert.equal(p.problems.some((x) => x.kind === 'gateway_vpn_cert_stale'), false);
    }
  });

  it('a new fingerprint starts the 24 h anew', async () => {
    await share({ enabled: true, peers: [gatewayId], accept_risk: true });
    gatewayMeta(gatewayId, heartbeat('1.41.0', ['vpn-cert'], { fingerprint: OTHER_FP, not_after: notAfter }));
    // switched on two days ago, the certificate changed just now
    db.prepare("UPDATE settings SET value = ? WHERE key = 'vpn_cert.share_fingerprint_at'").run(new Date(Date.now() - 2 * DAY).toISOString());
    assert.equal(vpnCert.staleGateways(Date.now() + DAY + 60000).length, 1);
    assert.equal(vpnCert.shareRefresh(), true);
    const since = Date.parse(vpnCert.gatewayCertStates().get(gatewayId).stale_since);
    assert.ok(since > Date.now() - 60000);
    assert.equal(vpnCert.staleGateways(Date.now() + 3600 * 1000).length, 0);
  });

  it('passing on switched off: gone again; "Ausschalten" forgets the time', async () => {
    await share({ enabled: true, peers: [gatewayId], accept_risk: true });
    gatewayMeta(gatewayId, heartbeat('1.41.0', ['vpn-cert'], { fingerprint: OTHER_FP, not_after: notAfter }));
    await share({ enabled: false, peers: [gatewayId] });
    assert.equal(vpnCert.gatewayCertStates().size, 0);
    assert.equal(vpnCert.staleGateways(Date.now() + 3 * DAY).length, 0);
    await vpnCert.disable();
    const row = db.prepare("SELECT value FROM settings WHERE key = 'vpn_cert.share_fingerprint_at'").get();
    assert.ok(!row || row.value === '');
  });

  it('without the licence nothing is shown', async () => {
    await share({ enabled: true, peers: [gatewayId], accept_risk: true });
    license._overrideForTest({ internal_dns: false, api_tokens: true, vpn_peers: -1 });
    assert.equal(vpnCert.gatewayCertStates().size, 0);
  });
});
