'use strict';

// "Zertifikat für die Namen", part 4: internal routes below the zone of the
// device names — only while its wildcard is in use, one level deep, never a
// device name or a fixed name of the server, always internal only.
// All names and values are made up.

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { setup, teardown, getAgent, getCsrf } = require('./helpers/setup');

const confDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-vpn-cert-routes-'));
process.env.GC_DNSMASQ_CONF = path.join(confDir, 'dnsmasq.conf');
process.on('exit', () => { try { fs.rmSync(confDir, { recursive: true, force: true }); } catch { /* ignore */ } });

const TOKEN = 'fake-desec-token-0201';

describe('Zertifikat für die Namen: interne Routen unter der Zone', () => {
  let db; let vpnCert; let vpnNames; let tlsGuard; let caddyConfig; let license; let routes; let config; let policy; let domainZones;

  before(async () => {
    await setup();
    db = require('../src/db/connection').getDb();
    vpnCert = require('../src/services/vpnCert');
    vpnNames = require('../src/services/vpnNames');
    tlsGuard = require('../src/services/tlsGuard');
    caddyConfig = require('../src/services/caddyConfig');
    license = require('../src/services/license');
    routes = require('../src/services/routes');
    policy = require('../src/services/routeDomainPolicy');
    domainZones = require('../src/services/domainZones');
    config = require('../config/default');
    license._overrideForTest({ internal_dns: true, http_routes: -1, vpn_peers: -1 });
    fs.mkdirSync(path.dirname(config.dns.hostsFile), { recursive: true });
    require('../src/services/dns').restartDnsmasq = () => {};
  });

  after(() => teardown());

  let domainId;
  beforeEach(async () => {
    vpnCert._resetForTest();
    db.prepare('DELETE FROM routes').run();
    db.prepare('DELETE FROM service_bundles').run();
    db.prepare('DELETE FROM peers').run();
    db.prepare('DELETE FROM domains').run();
    db.prepare("DELETE FROM settings WHERE key LIKE 'dns.names.%' OR key LIKE 'vpn_cert.%'").run();
    db.prepare('DELETE FROM tls_status').run();
    vpnCert.removeSecretFiles();
    license._overrideForTest({ internal_dns: true, http_routes: -1, vpn_peers: -1 });
    fs.writeFileSync(process.env.GC_DNSMASQ_CONF, 'local=/gc.internal/\n');
    domainId = Number(db.prepare("INSERT INTO domains (domain, status) VALUES ('example.com', 'verified')").run().lastInsertRowid);
    assert.equal(vpnNames.save('example.com', 'vpn').ok, true);
  });

  async function serve() {
    const res = await getAgent().put('/api/v1/settings/vpn-cert').set('X-CSRF-Token', getCsrf()).send({ provider: 'desec', credentials: { token: TOKEN } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    tlsGuard.writeRow('*.vpn.example.com', { state: 'issued', not_after: new Date(Date.now() + 80 * 86400000).toISOString(), issuer: "Let's Encrypt" });
    vpnCert.refreshServed('test');
  }
  function addPeer(name, hostname) {
    return Number(db.prepare("INSERT INTO peers (name, public_key, allowed_ips, hostname, hostname_source) VALUES (?, ?, '10.8.0.40/32', ?, 'admin')")
      .run(name, 'pk-' + name, hostname).lastInsertRowid);
  }
  const createRoute = (domain, extra = {}) => routes.create({ domain, target_ip: '10.0.0.5', target_port: 5000, route_type: 'http', https_enabled: true, ...extra });

  describe('the domain policy', () => {
    it('without the wildcard in use: still the zone of the devices', () => {
      assert.equal(policy.checkDomainPolicy('nas-web.vpn.example.com').error, 'device_zone');
    });

    it('with it: one level, no device name, no fixed name; internal only', async () => {
      await serve();
      addPeer('nas', 'nas');
      const r = policy.checkDomainPolicy('nas-web.vpn.example.com');
      assert.equal(r.error, null);
      assert.equal(r.internalOnly, true);
      assert.equal(policy.checkDomainPolicy('a.b.vpn.example.com').error, 'device_zone_level');
      assert.equal(policy.checkDomainPolicy('nas.vpn.example.com').error, 'device_name');
      for (const fixed of ['home', 'server', 'gc-server', 'gateway']) {
        assert.equal(policy.checkDomainPolicy(`${fixed}.vpn.example.com`).error, 'domain_collision', fixed);
      }
      assert.equal(policy.checkDomainPolicy('app.example.com').internalOnly, undefined, 'outside the zone: unchanged');
    });

    it('a paused wildcard closes the zone again (existing routes keep their name)', async () => {
      await serve();
      tlsGuard.writeRow('*.vpn.example.com', { state: 'paused', paused_reason: 'attempts' });
      vpnCert.refreshServed('test');
      assert.equal(policy.checkDomainPolicy('nas-web.vpn.example.com').error, 'device_zone');
      assert.equal(policy.checkDomainPolicy('nas-web.vpn.example.com', { currentDomain: 'nas-web.vpn.example.com' }).error, null);
    });
  });

  describe('always internal only', () => {
    it('create, update and the bulk change keep external_enabled = 0', async () => {
      await serve();
      const r = await createRoute('nas-web.vpn.example.com', { external_enabled: true });
      const id = r.id || r.lastInsertRowid || db.prepare("SELECT id FROM routes WHERE domain = 'nas-web.vpn.example.com'").get().id;
      const ext = () => db.prepare('SELECT external_enabled FROM routes WHERE id = ?').get(id).external_enabled;
      assert.equal(ext(), 0);
      await routes.update(id, { external_enabled: true });
      assert.equal(ext(), 0);
      await routes.bulkUpdate({ ids: [id], set: { external_enabled: true } }).catch(() => {});
      assert.equal(ext(), 0);
      const rows = routes.toApiRows([db.prepare('SELECT * FROM routes WHERE id = ?').get(id)]);
      assert.equal(rows[0].vpn_internal, true);
      // a route outside the zone is untouched
      const other = await createRoute('app.example.com', { external_enabled: true });
      const oid = other.id || db.prepare("SELECT id FROM routes WHERE domain = 'app.example.com'").get().id;
      assert.equal(db.prepare('SELECT external_enabled FROM routes WHERE id = ?').get(oid).external_enabled, 1);
    });

    it('a host of the zone via the host API: created, internal only', async () => {
      await serve();
      db.prepare("UPDATE domains SET gateway_kind = 'peer', gateway_peer_id = ? WHERE id = ?").run(addPeer('target', null), domainId);
      const res = await getAgent().post(`/api/v1/domains/${domainId}/hosts`).set('X-CSRF-Token', getCsrf())
        .send({ subdomain: 'nas-web.vpn', external_enabled: true, entries: [{ type: 'http', target_port: 5000 }] });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(db.prepare("SELECT external_enabled FROM routes WHERE domain = 'nas-web.vpn.example.com'").get().external_enabled, 0);
      const deep = await getAgent().post(`/api/v1/domains/${domainId}/hosts`).set('X-CSRF-Token', getCsrf())
        .send({ subdomain: 'a.b.vpn', entries: [{ type: 'http', target_port: 5000 }] });
      assert.equal(deep.status, 400);
      assert.equal(deep.body.code, 'DEVICE_ZONE_LEVEL');
    });

    it('the zones page knows the zone and whether its wildcard is in use', async () => {
      assert.deepEqual(domainZones.listZones().vpn_zone, { zone: 'vpn.example.com', served: false });
      await serve();
      assert.deepEqual(domainZones.listZones().vpn_zone, { zone: 'vpn.example.com', served: true });
    });
  });

  describe('certificates', () => {
    it('Caddy: the wildcard by SNI, no certificate of its own; without the wildcard the internal CA', async () => {
      await serve();
      await createRoute('nas-web.vpn.example.com');
      let cfg = caddyConfig.buildCaddyConfig();
      const skip = new Set(cfg.apps.http.servers.srv0.automatic_https.skip_certificates || []);
      assert.equal(skip.has('nas-web.vpn.example.com'), true);
      const subjectsOf = (c, mod) => new Set(c.apps.tls.automation.policies.filter((p) => p.issuers[0].module === mod).flatMap((p) => p.subjects || []));
      assert.equal(subjectsOf(cfg, 'acme').has('nas-web.vpn.example.com'), false);
      // the wildcard paused: the route stays, with the internal CA, never Let's Encrypt
      tlsGuard.writeRow('*.vpn.example.com', { state: 'paused', paused_reason: 'attempts' });
      vpnCert.refreshServed('test');
      cfg = caddyConfig.buildCaddyConfig();
      assert.equal(subjectsOf(cfg, 'internal').has('nas-web.vpn.example.com'), true);
      assert.equal(subjectsOf(cfg, 'acme').has('nas-web.vpn.example.com'), false);
    });

    it('TLS guard: no public check, the state of the wildcard, retry goes to the wildcard', async () => {
      await serve();
      await createRoute('nas-web.vpn.example.com');
      const pf = await tlsGuard.preflight('nas-web.vpn.example.com');
      assert.equal(pf.ok, true);
      assert.equal(pf.code, 'not_public');
      const st = tlsGuard.statusFor(['nas-web.vpn.example.com'])[0];
      assert.equal(st.kind, 'wildcard');
      assert.equal(st.wildcard, '*.vpn.example.com');
      assert.equal(st.state, 'issued');
      assert.ok(st.days_left > 70);
      tlsGuard.writeRow('*.vpn.example.com', { state: 'failed', attempts: 1 });
      await tlsGuard.retryHost('nas-web.vpn.example.com');
      assert.equal(tlsGuard.getRow('*.vpn.example.com').attempts, 0, 'the wildcard was retried');
    });
  });

  it('"Genutzt von" lists the route', async () => {
    await serve();
    await createRoute('nas-web.vpn.example.com');
    const used = vpnCert.view().used_by;
    assert.equal(used.filter((u) => u.kind === 'route').map((u) => u.host).join(), 'nas-web.vpn.example.com');
  });
});
