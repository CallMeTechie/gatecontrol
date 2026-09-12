'use strict';

// Migrations v68 (zones_hosts) + v69 (zones_gateway): backfill of hosts,
// zone links (longest suffix) and zone gateways. Pattern:
// migration_backfill_autobundle.test.js — seed with skipSync (no host
// assignment), then exec the migration SQL (without its ALTERs, which already
// ran on the empty schema) twice.

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

// The ALTER TABLE statements ran with runMigrations() on the empty schema;
// everything else (backfill) must be re-runnable.
function backfillOnly(sql) {
  return sql.split(';').filter((s) => !/^\s*ALTER TABLE/i.test(s)).join(';');
}

describe('migrations v68/v69: domain zones backfill', () => {
  let routesService, db, gw1, gw2, poolId;
  let v68, v69;
  const ids = {};

  before(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-zones-mig-'));
    process.env.GC_DB_PATH = path.join(tmp, 'test.db');
    process.env.GC_DATA_DIR = tmp;
    ['../config/default', '../src/db/connection', '../src/db/migrations',
     '../src/db/migrationList', '../src/services/serviceBundle', '../src/services/routes',
     '../src/services/caddyConfig', '../src/services/license', '../src/services/gateways',
    ].forEach((p) => { try { delete require.cache[require.resolve(p)]; } catch (_) {} });
    require('../src/db/migrations').runMigrations();
    require('../src/services/caddyConfig').syncToCaddy = async () => true;
    routesService = require('../src/services/routes');
    db = require('../src/db/connection').getDb();
    require('../src/services/license')._overrideForTest({
      http_routes: 100, l4_routes: 100, gateway_peers: 10, gateway_tcp_routing: true,
      gateway_pools: true, gateway_pool_failover: true, gateway_pools_limit: 10,
    });
    const list = require('../src/db/migrationList').migrations;
    v68 = backfillOnly(list.find((m) => m.version === 68).sql);
    v69 = backfillOnly(list.find((m) => m.version === 69).sql);

    const gateways = require('../src/services/gateways');
    gw1 = (await gateways.createGateway({ name: 'gw-home', apiPort: 9876 })).peer.id;
    gw2 = (await gateways.createGateway({ name: 'gw-nas', apiPort: 9877 })).peer.id;
    const gatewayPool = require('../src/services/gatewayPool');
    poolId = gatewayPool.createPool({ name: 'pool-a', mode: 'failover', failback_cooldown_s: 60 });
    gatewayPool.addMember(poolId, gw1, 10);

    const dom = db.prepare('INSERT INTO domains (domain, status) VALUES (?, ?)');
    for (const [d, s] of [['example.com', 'verified'], ['lab.example.com', 'verified'],
      ['example.co.uk', 'pending'], ['other.net', 'verified'], ['direct.net', 'verified'], ['pool.net', 'verified']]) {
      dom.run(d, s);
    }

    const gw = (peer, lan, extra = {}) => ({ target_kind: 'gateway', target_peer_id: peer, target_lan_host: lan, ...extra });
    const http = (domain, target, external, port = 80) => routesService.create(
      { route_type: 'http', domain, target_port: port, target_lan_port: port, external_enabled: external, ...target }, { skipSync: true });
    const l4 = (domain, listen, target, external, port = 22) => routesService.create(
      { route_type: 'l4', domain, l4_protocol: 'tcp', l4_listen_port: String(listen), l4_tls_mode: 'none',
        target_port: port, target_lan_port: port, external_enabled: external, ...target }, { skipSync: true });

    ids.nasHttp = (await http('nas.example.com', gw(gw1, '192.168.1.10'), 1, 5001)).id;
    ids.nasSsh = (await l4('nas.example.com', 2022, gw(gw1, '192.168.1.10'), 1)).id;
    ids.app = (await http('app.example.com', gw(gw1, '192.168.1.11'), 1)).id;
    ids.mail = (await http('mail.example.com', gw(gw2, '192.168.1.12'), 0)).id;
    ids.apex = (await http('example.com', gw(gw1, '192.168.1.13'), 1)).id;
    ids.lab = (await http('x.lab.example.com', gw(gw1, '192.168.1.14'), 0)).id;
    ids.failover = (await http('y.lab.example.com', gw(gw2, '192.168.1.15'), 0)).id;
    db.prepare('UPDATE routes SET original_peer_id = ? WHERE id = ?').run(gw1, ids.failover); // mid-failover, home = gw1
    ids.couk = (await http('a.b.example.co.uk', gw(gw1, '192.168.1.16'), 1)).id;
    ids.portOnly = (await l4(null, 9100, gw(gw1, '192.168.1.17'), 0, 9100)).id;
    ids.direct = (await http('svc.direct.net', { target_ip: '10.8.0.50' }, 0)).id;
    ids.pool = (await http('web.pool.net', { target_kind: 'gateway', target_pool_id: poolId, target_lan_host: '192.168.1.18' }, 1)).id;

    // A pre-existing (legacy) bundle without zone columns, plus a loose L4 with its domain.
    const legacyHttp = await http('legacy.example.com', gw(gw1, '192.168.1.19'), 0);
    ids.legacyHttp = legacyHttp.id;
    ids.legacyBundle = db.prepare("INSERT INTO service_bundles (name, domain) VALUES ('Legacy', 'legacy.example.com')").run().lastInsertRowid;
    db.prepare('UPDATE routes SET bundle_id = ? WHERE id = ?').run(ids.legacyBundle, ids.legacyHttp);
    ids.legacyL4 = (await l4('legacy.example.com', 2023, gw(gw1, '192.168.1.19'), 0)).id;

    // RDP-owned L4 — never hosted.
    ids.rdp = (await l4(null, 3390, gw(gw1, '192.168.1.20'), 0, 3389)).id;
    db.prepare("INSERT INTO rdp_routes (name, host, gateway_l4_route_id) VALUES ('rdp', '192.168.1.20', ?)").run(ids.rdp);

    db.exec(v68);
    db.exec(v69);
  });

  const hostOf = (routeId) => db.prepare(
    'SELECT sb.* FROM service_bundles sb JOIN routes r ON r.bundle_id = sb.id WHERE r.id = ?').get(routeId);
  const zone = (d) => db.prepare('SELECT * FROM domains WHERE domain = ?').get(d);

  it('gives every non-RDP route a host, RDP-owned L4 stays out', () => {
    const loose = db.prepare('SELECT id FROM routes WHERE bundle_id IS NULL').all().map((r) => r.id);
    assert.deepEqual(loose, [ids.rdp]);
  });

  it('groups routes of one fqdn into one host and joins an existing host of that fqdn', () => {
    assert.equal(hostOf(ids.nasHttp).id, hostOf(ids.nasSsh).id);
    assert.equal(hostOf(ids.legacyL4).id, ids.legacyBundle, 'loose L4 joined the legacy bundle');
    const legacy = db.prepare('SELECT * FROM service_bundles WHERE id = ?').get(ids.legacyBundle);
    assert.equal(legacy.domain_id, zone('example.com').id);
    assert.equal(legacy.subdomain, 'legacy');
  });

  it('links hosts by LONGEST suffix, including multi-label bases and the apex', () => {
    assert.equal(hostOf(ids.nasHttp).domain_id, zone('example.com').id);
    assert.equal(hostOf(ids.nasHttp).subdomain, 'nas');
    assert.equal(hostOf(ids.apex).subdomain, '@');
    assert.equal(hostOf(ids.lab).domain_id, zone('lab.example.com').id, 'lab.example.com beats example.com');
    assert.equal(hostOf(ids.lab).subdomain, 'x');
    assert.equal(hostOf(ids.couk).domain_id, zone('example.co.uk').id);
    assert.equal(hostOf(ids.couk).subdomain, 'a.b');
  });

  it('keeps a port-forward without domain in a host without zone', () => {
    const h = hostOf(ids.portOnly);
    assert.equal(h.domain_id, null);
    assert.equal(h.subdomain, null);
    assert.equal(h.domain, null);
    assert.equal(h.name, 'Port 9100');
  });

  it('sets each zone gateway to the most common target (triple mapping)', () => {
    const ex = zone('example.com');
    assert.equal(ex.gateway_kind, 'gateway');
    assert.equal(ex.gateway_peer_id, gw1);
    assert.equal(ex.gateway_pool_id, null);
    assert.equal(ex.default_external_enabled, 1, '4 of 7 entries are external');
    const lab = zone('lab.example.com');
    assert.equal(lab.gateway_peer_id, gw1, 'a mid-failover route counts for its home gateway');
    assert.equal(lab.default_external_enabled, 0);
    assert.equal(zone('direct.net').gateway_kind, 'peer');
    assert.equal(zone('direct.net').gateway_peer_id, null);
    const pool = zone('pool.net');
    assert.equal(pool.gateway_kind, 'pool');
    assert.equal(pool.gateway_pool_id, poolId);
    assert.equal(pool.gateway_peer_id, null);
    assert.equal(zone('other.net').gateway_kind, null, 'a zone without hosts keeps no gateway');
  });

  it('flags exactly the deviating host with gateway_override', () => {
    const flagged = db.prepare('SELECT id FROM service_bundles WHERE gateway_override = 1').all().map((r) => r.id);
    assert.deepEqual(flagged, [hostOf(ids.mail).id]);
  });

  it('produces no (domain_id, subdomain) duplicates', () => {
    const dups = db.prepare(`SELECT domain_id, subdomain, COUNT(*) n FROM service_bundles
      WHERE domain_id IS NOT NULL GROUP BY domain_id, subdomain HAVING n > 1`).all();
    assert.deepEqual(dups, []);
  });

  it('is idempotent', () => {
    const snap = () => JSON.stringify([
      db.prepare('SELECT * FROM service_bundles ORDER BY id').all(),
      db.prepare('SELECT id, bundle_id FROM routes ORDER BY id').all(),
      db.prepare('SELECT * FROM domains ORDER BY id').all(),
    ]);
    const before = snap();
    db.exec(v68);
    db.exec(v69);
    assert.equal(snap(), before);
  });

  it('never reuses the id of a deleted bundle (AUTOINCREMENT)', () => {
    const doomed = db.prepare("INSERT INTO service_bundles (name) VALUES ('doomed')").run().lastInsertRowid;
    db.prepare('DELETE FROM service_bundles WHERE id = ?').run(doomed);
    const r = db.prepare(`INSERT INTO routes (domain, target_ip, target_port, route_type, enabled)
      VALUES ('late.example.com', '10.0.0.9', 80, 'http', 1)`).run().lastInsertRowid;
    db.exec(v68);
    assert.ok(hostOf(r).id > doomed, 'new host id is above the deleted one');
  });
});
