'use strict';

// Reproduction of the jennybackes.de incident (docs/feature-tls-guard.md):
// A → this server, AAAA → a foreign server, no server IPv6. The domain check
// fails with aaaa_without_ipv6, a host created for it is paused before the
// first Caddy sync, lands in automatic_https.skip and is missing from the
// ACME subjects. Standalone DB, stubbed Caddy sync (zones_hosts.test.js style).

const { describe, it, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

process.env.NODE_ENV = 'test';
process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const V4 = '198.51.100.7';
const FOREIGN6 = '2001:41d0:301:1::29';

describe('tls guard: preflight pauses a host before the first sync', () => {
  let db, hosts, routes, domainZones, domains, tlsGuard, caddy;
  let gw1, zoneId;
  let syncCount = 0;
  let dnsMap = {};

  const nodata = () => { const e = new Error('ENODATA'); e.code = 'ENODATA'; throw e; };
  const addZone = (domain, { status = 'verified', peer = null, external = 0 } = {}) => db.prepare(
    `INSERT INTO domains (domain, status, gateway_kind, gateway_peer_id, default_external_enabled)
     VALUES (?, ?, ?, ?, ?)`).run(domain, status, peer ? 'gateway' : null, peer, external).lastInsertRowid;
  const skipOf = (cfg) => cfg.apps.http.servers.srv0.automatic_https.skip;
  const acmeSubjects = (cfg) => (cfg.apps.tls.automation.policies || [])
    .filter((p) => p.issuers.some((i) => i.module === 'acme')).flatMap((p) => p.subjects || []);

  before(() => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-tls-repro-'));
    process.env.GC_DB_PATH = path.join(tmp, 'test.db');
    process.env.GC_DATA_DIR = tmp;
    require('../src/db/migrations').runMigrations();
    caddy = require('../src/services/caddyConfig');
    caddy.syncToCaddy = async () => { syncCount++; return true; };
    require('../src/services/license')._overrideForTest({
      http_routes: 100, l4_routes: 100, gateway_peers: 10, gateway_tcp_routing: true,
    });
    db = require('../src/db/connection').getDb();
    routes = require('../src/services/routes');
    hosts = require('../src/services/hosts');
    domainZones = require('../src/services/domainZones');
    domains = require('../src/services/domains');
    tlsGuard = require('../src/services/tlsGuard');

    domains._setServerIpsForTest({ v4: V4, v6: null });
    domains._setCaaResolverForTest(async () => nodata());
    domains._setResolverForTest(async (host, family) => {
      const r = dnsMap[host] || { a: [], aaaa: [] };
      return family === 4 ? r.a : r.aaaa;
    });

    gw1 = db.prepare("INSERT INTO peers (name, public_key, allowed_ips, enabled, peer_type) VALUES ('gw', 'k1', '10.8.0.2/32', 1, 'gateway')").run().lastInsertRowid;
    db.prepare(`INSERT INTO gateway_meta (peer_id, api_port, api_token_hash, push_token_encrypted, created_at, last_health, alive)
      VALUES (?, 9876, 'h', 'e', strftime('%s','now')*1000, '{}', 1)`).run(gw1);
    zoneId = addZone('example.com', { peer: gw1, external: 1 });
  });

  beforeEach(() => { syncCount = 0; });

  it('domain check: A ok, AAAA foreign, no server v6 → failed / aaaa_without_ipv6', async () => {
    dnsMap = { 'jenny.example.com': { a: [V4], aaaa: [FOREIGN6] }, 'example.com': { a: [V4], aaaa: [] } };
    const v = await domains.verify('jenny.example.com');
    assert.equal(v.status, 'failed');
    assert.equal(v.error, 'aaaa_without_ipv6');
    assert.match(v.check.detail, /2001:41d0:301:1::29/);
  });

  it('hosts.create: the host is created, paused with preflight:aaaa_without_ipv6, skipped in Caddy', async () => {
    const host = await hosts.create(zoneId, {
      subdomain: 'jenny', lan_host: '192.168.1.10',
      entries: [{ type: 'http', target_port: 80 }],
    });
    assert.equal(host.fqdn, 'jenny.example.com');
    assert.equal(host.entry_count, 1, 'the failed preflight does not block the write');
    assert.deepEqual(host.tls, { state: 'paused', code: 'aaaa_without_ipv6', detail: `AAAA ${FOREIGN6} but this server has no IPv6 address` });
    assert.equal(syncCount, 1);

    const row = tlsGuard.getRow('jenny.example.com');
    assert.equal(row.state, 'paused');
    assert.equal(row.paused_reason, 'preflight');
    assert.equal(row.last_error_code, 'preflight:aaaa_without_ipv6');
    assert.equal(JSON.parse(row.preflight_json).records.aaaa[0], FOREIGN6);

    const cfg = caddy.buildCaddyConfig();
    assert.ok(skipOf(cfg).includes('gc-owner.invalid'), 'existing marker entry kept');
    assert.ok(skipOf(cfg).includes('jenny.example.com'), 'paused host in automatic_https.skip');
    assert.ok(!acmeSubjects(cfg).includes('jenny.example.com'), 'paused host absent from ACME subjects');
    assert.ok(cfg.logging.logs.tls, 'tls log block present');
    // Gegen das konfigurierte Caddy-Datenverzeichnis, nicht gegen '/data/caddy':
    // die Testumgebung lenkt GC_CADDY_DATA_DIR in ein Temp-Verzeichnis
    // (tests/helpers/test-env.js), damit kein Test nach /data schreibt.
    assert.equal(cfg.logging.logs.tls.writer.filename,
      path.join(process.env.GC_CADDY_DATA_DIR || '/data/caddy', 'tls.log'));
    assert.deepEqual(cfg.logging.logs.tls.include, ['tls.obtain', 'tls.renew', 'tls.issuance.acme', 'tls.issuance.acme.acme_client', 'tls.issuance.zerossl']);
  });

  it('GET /zones: entry.tls, host.tls_problem and degraded health', () => {
    const view = domainZones.listZones();
    const zone = view.zones.find((z) => z.domain === 'example.com');
    const host = zone.hosts.find((h) => h.fqdn === 'jenny.example.com');
    assert.equal(host.tls_problem, true);
    assert.equal(host.health, 'degraded');
    assert.equal(zone.health, 'degraded');
    assert.deepEqual(host.entries[0].tls, { state: 'paused', last_error_code: 'preflight:aaaa_without_ipv6', not_after: null, days_left: null });
  });

  it('a healthy host is not paused and keeps state pending', async () => {
    dnsMap['ok.example.com'] = { a: [V4], aaaa: [] };
    const host = await hosts.create(zoneId, { subdomain: 'ok', lan_host: '192.168.1.11', entries: [{ type: 'http', target_port: 80 }] });
    assert.deepEqual(host.tls, { state: 'pending', code: 'ok', detail: null });
    const cfg = caddy.buildCaddyConfig();
    assert.ok(!skipOf(cfg).includes('ok.example.com'));
    assert.ok(acmeSubjects(cfg).includes('ok.example.com'));
    const view = domainZones.listZones();
    const h = view.zones[0].hosts.find((x) => x.fqdn === 'ok.example.com');
    assert.equal(h.tls_problem, false);
    assert.equal(h.entries[0].tls.state, 'pending');
  });

  it('a plain TCP entry does not run the preflight; an SNI entry does', async () => {
    dnsMap['tcp.example.com'] = { a: ['203.0.113.9'], aaaa: [] };
    const host = await hosts.create(zoneId, { subdomain: 'tcp', lan_host: '192.168.1.12', entries: [{ type: 'tcp', target_port: 22, listen_port: 2222 }] });
    assert.equal(host.tls, undefined);
    assert.equal(tlsGuard.getRow('tcp.example.com'), null);
    const entry = await hosts.addEntry(host.id, { type: 'tcp', target_port: 443, listen_port: 8443, tls_mode: 'passthrough' });
    assert.equal(entry.tls.state, 'paused');
    assert.equal(entry.tls.code, 'a_mismatch');
    assert.equal(tlsGuard.getRow('tcp.example.com').state, 'paused');
    assert.equal(entry.route_type, 'l4');
    assert.equal(domainZones.getEntry(entry.id).tls.state, 'paused', 'SNI entries carry tls in the zones view');
  });

  it('renaming a host preflights the new name', async () => {
    dnsMap['ok2.example.com'] = { a: ['203.0.113.9'], aaaa: [] };
    const host = domainZones.listZones().zones[0].hosts.find((x) => x.fqdn === 'ok.example.com');
    const updated = await hosts.update(host.id, { subdomain: 'ok2' });
    assert.equal(updated.fqdn, 'ok2.example.com');
    assert.equal(updated.tls.state, 'paused');
    assert.equal(updated.tls.code, 'a_mismatch');
    assert.ok(skipOf(caddy.buildCaddyConfig()).includes('ok2.example.com'));
  });

  it('routes.create / routes.update run the guard when a route gets HTTPS or a new name', async () => {
    dnsMap['plain.example.com'] = { a: [V4], aaaa: [] };
    dnsMap['bad.example.com'] = { a: [V4], aaaa: [FOREIGN6] };
    const r = await routes.create({ domain: 'plain.example.com', target_ip: '203.0.113.10', target_port: 8080, https_enabled: false });
    assert.equal(r.tls, undefined, 'HTTP-only route: no preflight');
    let u = await routes.update(r.id, { https_enabled: true });
    assert.deepEqual(u.tls, { state: 'pending', code: 'ok', detail: null });
    u = await routes.update(r.id, { description: 'no tls change' });
    assert.equal(u.tls, undefined, 'unrelated update: no preflight');
    u = await routes.update(r.id, { domain: 'bad.example.com' });
    assert.equal(u.tls.state, 'paused');
    assert.equal(u.tls.code, 'aaaa_without_ipv6');
    assert.ok(skipOf(caddy.buildCaddyConfig()).includes('bad.example.com'));

    const c = await routes.create({ domain: 'bad2.example.com', target_ip: '203.0.113.10', target_port: 8080 });
    assert.equal(c.tls.state, 'paused');
    assert.equal(c.tls.code, 'no_records');
  });

  it('retryHost: still failing → PREFLIGHT_FAILED and paused; fixed DNS → pending and out of skip', async () => {
    await assert.rejects(tlsGuard.retryHost('jenny.example.com'), (err) => {
      assert.equal(err.code, 'PREFLIGHT_FAILED');
      assert.equal(err.statusCode, 409);
      assert.equal(err.result.code, 'aaaa_without_ipv6');
      return true;
    });
    assert.equal(tlsGuard.getRow('jenny.example.com').state, 'paused');

    dnsMap['jenny.example.com'] = { a: [V4], aaaa: [] };
    syncCount = 0;
    const status = await tlsGuard.retryHost('jenny.example.com');
    assert.equal(status.state, 'pending');
    assert.equal(status.attempts, 0);
    assert.equal(status.host, 'jenny.example.com');
    assert.equal(status.kind, 'acme');
    assert.ok(status.route_id);
    assert.equal(status.domain_id, zoneId);
    assert.equal(syncCount, 1);
    assert.ok(!skipOf(caddy.buildCaddyConfig()).includes('jenny.example.com'));
    assert.ok(acmeSubjects(caddy.buildCaddyConfig()).includes('jenny.example.com'));
  });

  it('a failed sync rolls the pause back', async () => {
    dnsMap['roll.example.com'] = { a: [V4], aaaa: [] };
    await routes.create({ domain: 'roll.example.com', target_ip: '203.0.113.10', target_port: 8080 });
    caddy.syncToCaddy = async () => { throw new Error('sync boom'); };
    try {
      await assert.rejects(tlsGuard.pauseHost('roll.example.com', 'attempts'), /sync boom/);
      assert.equal(tlsGuard.getRow('roll.example.com').state, 'pending');
    } finally {
      caddy.syncToCaddy = async () => { syncCount++; return true; };
    }
  });

  it('listStatus: one row per hostname, summary counts, statusFor for unknown names', () => {
    const s = tlsGuard.listStatus();
    const names = s.hosts.map((h) => h.host);
    assert.equal(new Set(names).size, names.length, 'hosts are unique');
    const tcp = s.hosts.find((h) => h.host === 'tcp.example.com');
    assert.equal(tcp.kind, 'acme', 'SNI entry counts as acme');
    assert.equal(tcp.state, 'paused');
    assert.equal(tcp.paused_reason, 'preflight');
    assert.equal(tcp.preflight.code, 'a_mismatch');
    assert.equal(tcp.max_attempts, 3);
    const plain = s.hosts.find((h) => h.host === 'bad.example.com');
    assert.equal(plain.kind, 'acme');
    assert.equal(s.summary.total, s.hosts.length);
    assert.equal(s.summary.paused, s.hosts.filter((h) => h.state === 'paused').length);
    assert.equal(s.summary.acme_email_missing, true);
    assert.deepEqual(s.settings, { max_attempts: 3 });
    const [unknown] = tlsGuard.statusFor(['nobody.example.com']);
    assert.equal(unknown.kind, 'none'); assert.equal(unknown.state, 'none'); assert.equal(unknown.route_id, null);
  });
});
