'use strict';

// "Zertifikat für die Namen", part 3: while the wildcard *.<zone> is valid and
// in use (services/vpnCert.js servedZone), the portal also answers under
// home.<zone> — given only to apps that resolve the zone — and the management
// also under server.<zone> / gc-server.<zone>; home.<legacy> and GC_BASE_URL
// stay. All names and values are made up.

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const supertest = require('supertest');

const { setup, teardown, getAgent, getCsrf } = require('./helpers/setup');

const confDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-vpn-cert-portal-'));
process.env.GC_DNSMASQ_CONF = path.join(confDir, 'dnsmasq.conf');
process.on('exit', () => { try { fs.rmSync(confDir, { recursive: true, force: true }); } catch { /* ignore */ } });

const TOKEN = 'fake-desec-token-0101';

describe('Zertifikat für die Namen: Portal und Verwaltung unter der Zone', () => {
  let db; let vpnCert; let vpnNames; let portalConfig; let tlsGuard; let caddyConfig; let license; let dns; let config;

  before(async () => {
    await setup();
    db = require('../src/db/connection').getDb();
    vpnCert = require('../src/services/vpnCert');
    vpnNames = require('../src/services/vpnNames');
    portalConfig = require('../src/services/portalConfig');
    tlsGuard = require('../src/services/tlsGuard');
    caddyConfig = require('../src/services/caddyConfig');
    license = require('../src/services/license');
    dns = require('../src/services/dns');
    config = require('../config/default');
    license._overrideForTest({ internal_dns: true, api_tokens: true });
    fs.mkdirSync(path.dirname(config.dns.hostsFile), { recursive: true });
    dns.restartDnsmasq = () => {};
  });

  after(() => teardown());

  beforeEach(() => {
    vpnCert._resetForTest();
    db.prepare('DELETE FROM routes').run();
    db.prepare('DELETE FROM domains').run();
    db.prepare("DELETE FROM settings WHERE key LIKE 'dns.names.%' OR key LIKE 'vpn_cert.%' OR key LIKE 'portal.%'").run();
    db.prepare('DELETE FROM tls_status').run();
    vpnCert.removeSecretFiles();
    license._overrideForTest({ internal_dns: true, api_tokens: true });
    fs.writeFileSync(process.env.GC_DNSMASQ_CONF, 'local=/gc.internal/\n');
  });

  const legacy = () => `home.${config.dns.domain}`;
  async function setUp({ valid = true } = {}) {
    db.prepare("INSERT INTO domains (domain, status) VALUES ('example.com', 'verified')").run();
    assert.equal(vpnNames.save('example.com', 'vpn').ok, true);
    const res = await getAgent().put('/api/v1/settings/vpn-cert').set('X-CSRF-Token', getCsrf()).send({ provider: 'desec', credentials: { token: TOKEN } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    if (valid) {
      tlsGuard.writeRow('*.vpn.example.com', { state: 'issued', not_after: new Date(Date.now() + 80 * 86400000).toISOString(), issuer: "Let's Encrypt" });
      vpnCert.refreshServed('test');
    }
  }
  async function token(name) {
    const res = await getAgent().post('/api/v1/tokens').set('x-csrf-token', getCsrf()).send({ name, scopes: ['client'] }).expect(201);
    return res.body.token;
  }
  function hostsOf(cfg) {
    const out = new Set();
    for (const r of cfg.apps.http.servers.srv0.routes) for (const m of r.match || []) for (const h of m.host || []) out.add(h);
    return out;
  }
  function policySubjects(cfg) { return cfg.apps.tls.automation.policies.flatMap((p) => p.subjects || []); }

  describe('when the wildcard is served', () => {
    it('without a valid certificate: everything as before', async () => {
      await setUp({ valid: false });
      assert.equal(vpnCert.servedZone({ fresh: true }), null);
      const p = portalConfig.effectivePortalHost();
      assert.equal(p.host, legacy());
      assert.deepEqual(p.hosts, [legacy()]);
      assert.deepEqual(vpnCert.managementHosts(), []);
      const cfg = caddyConfig.buildCaddyConfig([]);
      assert.ok(!hostsOf(cfg).has('home.vpn.example.com'));
      assert.ok(!hostsOf(cfg).has('server.vpn.example.com'));
    });

    it('with a valid certificate: home.<zone> first, home.<legacy> stays; server./gc-server.<zone>', async () => {
      await setUp();
      assert.equal(vpnCert.servedZone({ fresh: true }), 'vpn.example.com');
      const p = portalConfig.effectivePortalHost();
      assert.equal(p.host, 'home.vpn.example.com');
      assert.equal(p.vpn, true);
      assert.equal(p.compatHost, legacy());
      assert.deepEqual(p.hosts, ['home.vpn.example.com', legacy()]);
      assert.equal(portalConfig.isPortalHost(legacy()), true);
      assert.equal(portalConfig.isPortalHost('HOME.vpn.example.com.'), true);
      assert.deepEqual(vpnCert.managementHosts(), ['server.vpn.example.com', 'gc-server.vpn.example.com']);
      assert.deepEqual(vpnCert.view().used_by.map((u) => u.kind + ':' + u.host), [
        'portal:home.vpn.example.com', 'management:gc-server.vpn.example.com', 'management:server.vpn.example.com']);
    });

    it('a paused wildcard or a switched-off setup ends it', async () => {
      await setUp();
      tlsGuard.writeRow('*.vpn.example.com', { state: 'paused', paused_reason: 'attempts' });
      assert.equal(vpnCert.refreshServed('test'), true);
      assert.equal(portalConfig.effectivePortalHost().host, legacy());
      tlsGuard.writeRow('*.vpn.example.com', { state: 'issued', paused_reason: null });
      assert.equal(vpnCert.refreshServed('test'), true);
      assert.equal(portalConfig.effectivePortalHost().host, 'home.vpn.example.com');
      await getAgent().delete('/api/v1/settings/vpn-cert').set('X-CSRF-Token', getCsrf()).expect(200);
      assert.equal(portalConfig.effectivePortalHost().host, legacy());
      assert.equal(settingsGet(vpnCert.KEY.served), '');
    });

    it('a public portal domain wins: no home.<zone>', async () => {
      await setUp();
      require('../src/services/settings').set('portal.base_domain', 'example.com');
      const p = portalConfig.effectivePortalHost();
      assert.equal(p.public, true);
      assert.equal(p.host, 'home.example.com');
      assert.deepEqual(p.hosts, ['home.example.com']);
    });

    it('the certificate issued in the tls.log switches over by itself', async () => {
      await setUp({ valid: false });
      assert.equal(settingsGet(vpnCert.KEY.served), '');
      tlsGuard.writeRow('*.vpn.example.com', { not_after: new Date(Date.now() + 90 * 86400000).toISOString() });
      await tlsGuard.applyLogEvent({ kind: 'success', host: '*.vpn.example.com', at: new Date().toISOString() });
      assert.equal(settingsGet(vpnCert.KEY.served), 'vpn.example.com');
      assert.equal(portalConfig.effectivePortalHost().host, 'home.vpn.example.com');
    });
  });

  function settingsGet(k) { return require('../src/services/settings').get(k, ''); }

  describe('apps', () => {
    it('only apps that resolve the zone get home.<zone>', () => {
      const req = (h) => ({ headers: h });
      assert.equal(portalConfig.resolvesZone(req({ 'x-client-platform': 'android', 'x-client-version': '1.0.0' })), true);
      assert.equal(portalConfig.resolvesZone(req({ 'x-client-type': 'pro', 'x-client-version': '1.85.0' })), true);
      assert.equal(portalConfig.resolvesZone(req({ 'x-client-type': 'gatecontrol-pro', 'x-client-version': '1.90.2' })), true);
      assert.equal(portalConfig.resolvesZone(req({ 'x-client-type': 'pro', 'x-client-version': '1.84.9' })), false);
      assert.equal(portalConfig.resolvesZone(req({ 'x-client-type': 'community', 'x-client-version': '1.49.0' })), true);
      assert.equal(portalConfig.resolvesZone(req({ 'x-client-type': 'community', 'x-client-version': '1.48.3' })), false);
      assert.equal(portalConfig.resolvesZone(req({ 'x-client-type': 'pro' })), false);
      assert.equal(portalConfig.resolvesZone(req({})), false);
    });

    it('GET /client/permissions and POST /client/portal-link follow the app version', async () => {
      await setUp();
      const app = getAgent().app;
      const t = await token('vcp-1');
      const perm = (h) => supertest(app).get('/api/v1/client/permissions').set('X-API-Key', t).set(h);
      assert.equal((await perm({ 'X-Client-Platform': 'android', 'X-Client-Version': '2.3.1' })).body.portalUrl, 'https://home.vpn.example.com');
      assert.equal((await perm({ 'X-Client-Type': 'community', 'X-Client-Version': '1.49.0' })).body.portalUrl, 'https://home.vpn.example.com');
      assert.equal((await perm({ 'X-Client-Type': 'pro', 'X-Client-Version': '1.80.0' })).body.portalUrl, `https://${legacy()}`);
      assert.equal((await perm({})).body.portalUrl, `https://${legacy()}`);
    });
  });

  describe('Caddy', () => {
    it('portal under both names; management names inside the VPN only; certificates from the wildcard', async () => {
      await setUp();
      const cfg = caddyConfig.buildCaddyConfig([]);
      const hosts = hostsOf(cfg);
      for (const h of ['home.vpn.example.com', legacy(), 'server.vpn.example.com', 'gc-server.vpn.example.com']) assert.ok(hosts.has(h), h);
      const skip = cfg.apps.http.servers.srv0.automatic_https.skip_certificates;
      assert.deepEqual([...skip].sort(), ['gc-server.vpn.example.com', 'home.vpn.example.com', 'server.vpn.example.com']);
      const subjects = policySubjects(cfg);
      assert.ok(subjects.includes('*.vpn.example.com'));
      for (const h of skip) assert.ok(!subjects.includes(h), h + ' has no certificate of its own');
      const internal = cfg.apps.tls.automation.policies.find((p) => p.issuers[0].module === 'internal');
      assert.ok(internal && internal.subjects.includes(legacy()), 'home.<legacy> keeps the internal CA');
      // the management names: VPN sources only, then 404
      const route = cfg.apps.http.servers.srv0.routes.find((r) => r['@id'] !== 'gc_https_redirect' && (r.match || []).some((m) => (m.host || []).includes('server.vpn.example.com')));
      const text = JSON.stringify(route);
      assert.match(text, /"remote_ip"/);
      assert.match(text, /"status_code":404/);
      assert.match(text, /X-GC-Portal-Peer-IP/);
      // https only
      const redirect = cfg.apps.http.servers.srv0.routes.find((r) => r['@id'] === 'gc_https_redirect');
      assert.ok(redirect && redirect.match[0].host.includes('server.vpn.example.com'));
      assert.ok(!redirect.match[0].host.includes('home.vpn.example.com'), 'the portal keeps its own rules');
    });

    it('a wildcard that could not be set up: no names under the zone, no certificate attempt for them', async () => {
      await setUp();
      vpnCert.removeSecretFiles();
      fs.mkdirSync(vpnCert.secretsDir(), { recursive: true });
      // the policy needs its files; without readable credentials it is left out
      require('../src/services/settings').set(vpnCert.KEY.credentials, 'aaaaaaaaaaaaaaaaaaaaaaaa:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:cc');
      vpnCert._resetForTest();
      const cfg = caddyConfig.buildCaddyConfig([]);
      assert.ok(!hostsOf(cfg).has('server.vpn.example.com'));
      assert.ok(!policySubjects(cfg).includes('home.vpn.example.com'));
    });
  });

  describe('names', () => {
    it('the hosts file has home.<zone> and home.<legacy>', async () => {
      await setUp();
      const content = dns.renderHostsContent();
      assert.match(content, /^10\.8\.0\.1\thome\.vpn\.example\.com$/m);
      assert.ok(content.split('\n').includes(`${config.wireguard.gatewayIp}\t${legacy()}`));
    });

    it('saving the same zone again is no collision with its own portal name; routes cannot take the names', async () => {
      await setUp();
      assert.equal(vpnNames.check('example.com', 'vpn').ok, true);
      const { checkDomainPolicy } = require('../src/services/routeDomainPolicy');
      assert.equal(checkDomainPolicy(legacy()).error, 'domain_collision');
      assert.equal(checkDomainPolicy('home.vpn.example.com').error, 'domain_collision');
    });

    it('human links keep the name every device resolves', async () => {
      await setUp();
      assert.equal(portalConfig.effectivePortalHost().compatHost, legacy());
      const users = fs.readFileSync(path.join(__dirname, '..', 'src/routes/api/users.js'), 'utf8');
      assert.match(users, /effectivePortalHost\(\)\.compatHost/);
    });
  });

  describe('management under the second name', () => {
    it('the session cookie is host-only and CSRF lives in the session', async () => {
      const res = await supertest(getAgent().app).get('/login').set('Host', 'server.vpn.example.com');
      const cookie = [].concat(res.headers['set-cookie'] || []).find((c) => c.startsWith('gc.sid=')) || '';
      assert.ok(!/;\s*domain=/i.test(cookie), 'no Domain attribute: a login there is a session of that name only');
    });
  });
});
