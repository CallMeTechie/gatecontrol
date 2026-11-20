'use strict';

// "Zertifikat für die Namen", part 5: passing certificate and key on to
// devices and gateways — off by default, a list of allowed peers, an explicit
// risk confirmation, fetching only authenticated and from the peer's VPN
// address, every fetch logged without the key, a new key after passing it on.
// Only the device area's wildcard *.<label>.<zone> is handed out, never the
// main *.<zone>; a main key passed on before is renewed once. The
// certificates are throw-away self-signed ones (openssl); all names and
// values are made up.

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
  let certDir; let keyPem; let mainDir; let mainKeyPem;

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
    db.prepare('UPDATE peers SET hostname = ? WHERE id = ?').run('gw-home', gatewayId);
    // both wildcards in Caddy's storage, the way Caddy keeps them
    const stored = (name) => {
      const dir = path.join(config.caddy.dataDir, 'caddy', 'certificates', 'acme-v02.api.letsencrypt.org-directory', `wildcard_.${name}`);
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
      const key = path.join(dir, `wildcard_.${name}.key`);
      execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', key,
        '-out', path.join(dir, `wildcard_.${name}.crt`), '-days', '60', '-subj', `/CN=*.${name}`], { stdio: 'ignore' });
      return { dir, keyPem: fs.readFileSync(key, 'utf8') };
    };
    ({ dir: mainDir, keyPem: mainKeyPem } = stored('vpn.example.com'));
    ({ dir: certDir, keyPem } = stored('geraete.vpn.example.com'));
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
    // the device area's key — never the main one
    assert.equal(r.key_pem, keyPem);
    assert.notEqual(r.key_pem, mainKeyPem);
    assert.match(r.cert_pem, /BEGIN CERTIFICATE/);
    assert.equal(r.wildcard, '*.geraete.vpn.example.com');
    assert.equal(r.zone, 'vpn.example.com');
    assert.equal(r.device_zone, 'geraete.vpn.example.com');
    assert.equal(r.server_host, 'server.vpn.example.com');
    assert.equal(r.host, 'gw-home.geraete.vpn.example.com');
    const log = activity().filter((a) => a.event_type === 'tls_vpn_cert_key_fetched');
    assert.equal(log.length, 1);
    assert.ok(!JSON.stringify(log).includes('PRIVATE KEY'));
    assert.ok(JSON.parse(log[0].details).fingerprint);
    // the config pull of the allowed gateway names it; no other gateway's config changes
    const s = vpnCert.shareSummary(gatewayId);
    assert.equal(s.fingerprint, r.fingerprint);
    assert.deepEqual(Object.keys(s).sort(), ['device_zone', 'fingerprint', 'host', 'not_after', 'server_host', 'wildcard', 'zone']);
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

  it('a new key: only the certificate of the device area goes — portal, management and routes keep theirs', async () => {
    await share({ enabled: true, peers: [gatewayId], accept_risk: true });
    assert.equal(vpnCert.fetchFor(gatewayId, { ip: '10.8.0.2' }).ok, true);
    // while passing on is on: Caddy fetches the new one at once, the gateways follow
    let res = await getAgent().post('/api/v1/settings/vpn-cert/rotate-key').set('X-CSRF-Token', getCsrf());
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(fs.existsSync(certDir), false);
    assert.equal(fs.existsSync(mainDir), true, 'the main wildcard stays');
    assert.equal(tlsGuard.getRow('*.geraete.vpn.example.com').state, 'pending');
    assert.equal(tlsGuard.getRow('*.vpn.example.com').state, 'issued');
    assert.equal(vpnCert.servedZone({ fresh: true }), 'vpn.example.com');
    assert.equal(res.body.data.share.used, false);
    assert.ok(activity().some((a) => a.event_type === 'tls_vpn_cert_key_rotated' && JSON.parse(a.details).wildcard === '*.geraete.vpn.example.com'));
    res = await getAgent().post('/api/v1/settings/vpn-cert/rotate-key').set('X-CSRF-Token', getCsrf());
    assert.equal(res.body.code, 'rotate_not_needed');
    assert.equal(vpnCert.fetchFor(gatewayId, { ip: '10.8.0.2' }).code, 'no_certificate');
  });

  it('Caddy requests the device area only while passing on is on; Caddy serves nothing there', async () => {
    const caddyConfig = require('../src/services/caddyConfig');
    const automate = () => (caddyConfig.buildCaddyConfig([]).apps.tls.certificates || {}).automate;
    assert.deepEqual(automate(), ['*.vpn.example.com']);
    await share({ enabled: true, peers: [gatewayId], accept_risk: true });
    assert.deepEqual(automate(), ['*.vpn.example.com', '*.geraete.vpn.example.com']);
    const pol = caddyConfig.buildCaddyConfig([]).apps.tls.automation.policies[0];
    assert.deepEqual(pol.subjects, ['*.vpn.example.com', '*.geraete.vpn.example.com']);
    assert.ok(!JSON.stringify(caddyConfig.buildCaddyConfig([]).apps.http || {}).includes('geraete.vpn.example.com'), 'no site under the device area');
    // the TLS guard lists it, pausing it leaves it out
    assert.ok(tlsGuard.statusFor(['*.geraete.vpn.example.com'])[0]);
    tlsGuard.writeRow('*.geraete.vpn.example.com', { state: 'paused', paused_reason: 'attempts' });
    assert.deepEqual(automate(), ['*.vpn.example.com']);
    await share({ enabled: false, peers: [] });
    assert.deepEqual(automate(), ['*.vpn.example.com']);
  });

  it('the device area: a name of its own, renamed only while off; no route and no device there', async () => {
    let res = await share({ enabled: false, peers: [], device_label: 'Server' });
    assert.equal(res.body.code, 'device_label_reserved');
    res = await share({ enabled: false, peers: [], device_label: 'a.b' });
    assert.equal(res.body.code, 'device_label_invalid');
    res = await share({ enabled: false, peers: [], device_label: 'gw-home' });
    assert.equal(res.body.code, 'device_label_taken', 'a device has that name');
    res = await share({ enabled: true, peers: [gatewayId], accept_risk: true, device_label: 'devices' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.share.device_zone, 'devices.vpn.example.com');
    assert.equal(res.body.data.share.wildcard, '*.devices.vpn.example.com');
    res = await share({ enabled: true, peers: [gatewayId], device_label: 'geraete' });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'share_on');
    // routes there are refused, a device cannot take the name
    const { checkDomainPolicy } = require('../src/services/routeDomainPolicy');
    assert.equal(checkDomainPolicy('devices.vpn.example.com').error, 'domain_collision');
    assert.equal(require('../src/services/vpnNames').deviceNameCollision('devices'), 'devices.vpn.example.com');
    // dnsmasq answers <device>.<area>.<zone> with the tunnel address; mqtt & co. stay free
    db.prepare('UPDATE peers SET hostname = ? WHERE id = ?').run('mqtt', deviceId);
    const hosts = require('../src/services/dns').renderHostsContent();
    assert.match(hosts, /^10\.8\.0\.2\tgw-home\.devices\.vpn\.example\.com$/m);
    assert.ok(!hosts.includes('mqtt.devices.vpn.example.com'));
    await share({ enabled: false, peers: [], device_label: 'geraete' });
    assert.equal(vpnCert.deviceLabel(), 'geraete');
  });

  it('a main key passed on before the device area: renewed once, said in the log and the card', async () => {
    const settings = require('../src/services/settings');
    settings.set(vpnCert.KEY.shareUsed, '1');
    settings.set(vpnCert.KEY.mainKeyMigrated, '');
    assert.equal(await vpnCert.migrateSharedMainKey(), true);
    assert.equal(fs.existsSync(mainDir), false);
    assert.equal(tlsGuard.getRow('*.vpn.example.com').state, 'pending');
    assert.equal(settings.get(vpnCert.KEY.shareUsed, ''), '');
    const log = activity().filter((a) => a.event_type === 'tls_vpn_cert_main_key_renewed');
    assert.equal(log.length, 1);
    assert.match(log[0].message, /\*\.geraete\.vpn\.example\.com/);
    assert.ok(vpnCert.view().share.main_key_renewed_at);
    // once only
    settings.set(vpnCert.KEY.shareUsed, '1');
    assert.equal(await vpnCert.migrateSharedMainKey(), false);
    // a server whose main key never left: nothing renewed
    settings.set(vpnCert.KEY.mainKeyMigrated, '');
    settings.set(vpnCert.KEY.shareUsed, '');
    assert.equal(await vpnCert.migrateSharedMainKey(), false);
  });

  it('switching the certificate off ends passing on', async () => {
    await share({ enabled: true, peers: [gatewayId], accept_risk: true });
    await getAgent().delete('/api/v1/settings/vpn-cert').set('X-CSRF-Token', getCsrf()).expect(200);
    assert.equal(vpnCert.view().share.enabled, false);
    assert.equal(vpnCert.fetchFor(gatewayId, { ip: '10.8.0.2' }).code, 'not_shared');
  });
});
