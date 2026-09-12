'use strict';

// services/hosts.js + the "every route has a host" hook in services/routes.js.
// Standalone DB; caddyConfig.syncToCaddy is stubbed BEFORE routes/serviceBundle
// load (they capture the reference) so syncs can be counted and failed.

const { describe, it, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

process.env.NODE_ENV = 'test';
process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

describe('domain zones: hosts service', () => {
  let db, hosts, routes, domainZones, eventBus;
  let gw1, gw2, zoneId;
  let syncCount = 0;
  let failNextSync = false;

  const gmInsert = (pid, telemetry = {}) => db.prepare(`INSERT INTO gateway_meta
    (peer_id, api_port, api_token_hash, push_token_encrypted, created_at, last_health, alive)
    VALUES (?, 9876, ?, 'e', strftime('%s','now')*1000, ?, 1)`).run(pid, 'h' + pid, JSON.stringify({ telemetry }));
  const gateway = (name, ip, telemetry) => {
    const id = db.prepare("INSERT INTO peers (name, public_key, allowed_ips, enabled, peer_type) VALUES (?, ?, ?, 1, 'gateway')")
      .run(name, 'k-' + name, ip + '/32').lastInsertRowid;
    gmInsert(id, telemetry);
    return id;
  };
  const addZone = (domain, { status = 'verified', peer = null, external = 0 } = {}) => db.prepare(
    `INSERT INTO domains (domain, status, gateway_kind, gateway_peer_id, default_external_enabled)
     VALUES (?, ?, ?, ?, ?)`).run(domain, status, peer ? 'gateway' : null, peer, external).lastInsertRowid;
  const routeRows = (hostId) => db.prepare('SELECT * FROM routes WHERE bundle_id = ? ORDER BY id').all(hostId);

  before(() => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-zones-hosts-'));
    process.env.GC_DB_PATH = path.join(tmp, 'test.db');
    process.env.GC_DATA_DIR = tmp;
    require('../src/db/migrations').runMigrations();
    const caddy = require('../src/services/caddyConfig');
    caddy.syncToCaddy = async () => {
      syncCount++;
      if (failNextSync) { failNextSync = false; throw new Error('sync boom'); }
      return true;
    };
    require('../src/services/license')._overrideForTest({
      http_routes: 100, l4_routes: 100, gateway_peers: 10, gateway_tcp_routing: true,
      rdp_via_gateway: true, remote_desktop: true, gateway_scan_egress: true,
    });
    db = require('../src/db/connection').getDb();
    routes = require('../src/services/routes');
    hosts = require('../src/services/hosts');
    domainZones = require('../src/services/domainZones');
    eventBus = require('../src/services/eventBus');

    gw1 = gateway('gw-home', '10.8.0.2', { lan_subnets: [{ cidr: '192.168.1.0/24' }] });
    gw2 = gateway('gw-nas', '10.8.0.3');
    zoneId = addZone('example.com', { peer: gw1, external: 1 });
  });

  beforeEach(() => { syncCount = 0; failNextSync = false; });

  // ── create ─────────────────────────────────────────────

  it('creates a host with entries on the zone gateway and the zone default access', async () => {
    const host = await hosts.create(zoneId, {
      subdomain: 'nas', description: 'Synology', lan_host: '192.168.1.10',
      entries: [
        { type: 'http', target_port: 5001, backend_https: true },
        { type: 'tcp', target_port: 22, listen_port: 2022 },
      ],
    });
    assert.equal(host.fqdn, 'nas.example.com');
    assert.equal(host.subdomain, 'nas');
    assert.equal(host.domain_id, zoneId);
    assert.equal(host.lan_host, '192.168.1.10');
    assert.equal(host.name, 'Synology');
    assert.equal(host.gateway_override, false);
    assert.equal(host.entry_count, 2);
    assert.equal(host.entries[0].route_type, 'http', 'http entries first');
    const rows = routeRows(host.id);
    for (const r of rows) {
      assert.equal(r.target_kind, 'gateway');
      assert.equal(r.target_peer_id, gw1);
      assert.equal(r.target_lan_host, '192.168.1.10');
      assert.equal(r.external_enabled, 1, 'inherits zone.default_external_enabled');
    }
    const http = rows.find((r) => r.route_type === 'http');
    assert.equal(http.domain, 'nas.example.com');
    assert.equal(http.https_enabled, 1);
    assert.equal(http.backend_https, 1);
    assert.equal(rows.find((r) => r.route_type === 'l4').domain, null, 'tls none L4 carries no domain');
    assert.equal(syncCount, 1, 'one Caddy sync for the whole host');
  });

  it('creates a host from a template and records it', async () => {
    const host = await hosts.create(zoneId, { subdomain: 'pve', template: 'proxmox', lan_host: '192.168.1.11' });
    assert.equal(host.template, 'proxmox');
    assert.equal(host.entries.length, 1);
    assert.equal(host.entries[0].target_port, 8006);
    assert.equal(host.entries[0].backend_https, 1);
  });

  it('accepts "@" and a pasted fqdn of the zone as subdomain', async () => {
    const apex = await hosts.create(zoneId, { subdomain: '@', lan_host: '192.168.1.12', entries: [{ type: 'http', target_port: 80 }] });
    assert.equal(apex.fqdn, 'example.com');
    const pasted = await hosts.create(zoneId, { subdomain: 'wiki.example.com', lan_host: '192.168.1.13', entries: [{ type: 'http', target_port: 80 }] });
    assert.equal(pasted.subdomain, 'wiki');
  });

  it('rejects duplicate and invalid subdomains', async () => {
    await assert.rejects(hosts.create(zoneId, { subdomain: 'nas', lan_host: '192.168.1.10', entries: [{ type: 'tcp', target_port: 21, listen_port: 2121 }] }),
      (err) => err.statusCode === 409 && err.code === 'HOST_EXISTS');
    await assert.rejects(hosts.create(zoneId, { subdomain: 'bad_label!', lan_host: '192.168.1.10', entries: [{ type: 'http', target_port: 80 }] }),
      (err) => err.statusCode === 400);
  });

  it('requires a zone gateway and a LAN address', async () => {
    const bare = addZone('bare.org');
    await assert.rejects(hosts.create(bare, { subdomain: 'x', lan_host: '192.168.1.5', entries: [{ type: 'http', target_port: 80 }] }),
      (err) => err.code === 'ZONE_NO_GATEWAY');
    await assert.rejects(hosts.create(zoneId, { subdomain: 'nolan', entries: [{ type: 'http', target_port: 80 }] }),
      (err) => err.code === 'LAN_HOST_REQUIRED');
  });

  it('refuses an unverified public zone (domain policy)', async () => {
    const pending = addZone('pending.org', { status: 'pending', peer: gw1 });
    await assert.rejects(hosts.create(pending, { subdomain: 'x', lan_host: '192.168.1.5', entries: [{ type: 'http', target_port: 80 }] }),
      (err) => err.code === 'DOMAIN_UNVERIFIED');
  });

  it('accepts a host in a VERIFIED multi-label zone (example.co.uk)', async () => {
    const couk = addZone('example.co.uk', { peer: gw1 });
    const host = await hosts.create(couk, { subdomain: 'a.b', lan_host: '192.168.1.6', entries: [{ type: 'http', target_port: 80 }] });
    assert.equal(host.fqdn, 'a.b.example.co.uk');
  });

  // ── entries ────────────────────────────────────────────

  it('adds an entry with the host target; port conflict → 409 with suggestion', async () => {
    const host = domainZones.getHost(routeRows(await hostIdOf('nas.example.com'))[0].bundle_id);
    const entry = await hosts.addEntry(host.id, { type: 'udp', target_port: 5353, listen_port: 5353 });
    assert.equal(entry.route_type, 'l4');
    assert.equal(entry.l4_protocol, 'udp');
    assert.equal(entry.bundle_id, host.id);
    assert.equal(entry.target_lan_host, '192.168.1.10');
    assert.equal(entry.external_enabled, 1);
    assert.equal(syncCount, 1);
    await assert.rejects(hosts.addEntry(host.id, { type: 'tcp', target_port: 22, listen_port: 2022 }), (err) => {
      assert.equal(err.statusCode, 409);
      assert.equal(err.code, 'BUNDLE_PORT_CONFLICT');
      assert.equal(err.conflict.port, 2022);
      assert.ok(err.conflict.suggestedPort > 2022);
      return true;
    });
    await assert.rejects(hosts.addEntry(host.id, { type: 'http', target_port: 81 }), (err) => err.code === 'HOST_HAS_HTTP');
  });

  it('rolls back an added entry when the sync fails', async () => {
    const hostId = await hostIdOf('nas.example.com');
    const before = routeRows(hostId).length;
    failNextSync = true;
    await assert.rejects(hosts.addEntry(hostId, { type: 'tcp', target_port: 873, listen_port: 8873 }), /sync boom/);
    assert.equal(routeRows(hostId).length, before);
  });

  // ── update ─────────────────────────────────────────────

  it('renames a host: http + SNI entries follow, one sync', async () => {
    const host = await hosts.create(zoneId, {
      subdomain: 'files', lan_host: '192.168.1.20',
      entries: [{ type: 'http', target_port: 80 }, { type: 'tcp', target_port: 443, listen_port: 8443, tls_mode: 'passthrough' },
        { type: 'tcp', target_port: 22, listen_port: 2222 }],
    });
    syncCount = 0;
    const renamed = await hosts.update(host.id, { subdomain: 'storage' });
    assert.equal(renamed.fqdn, 'storage.example.com');
    const rows = routeRows(host.id);
    assert.equal(rows.find((r) => r.route_type === 'http').domain, 'storage.example.com');
    assert.equal(rows.find((r) => r.l4_tls_mode === 'passthrough').domain, 'storage.example.com');
    assert.equal(rows.find((r) => r.l4_listen_port === '2222').domain, null);
    assert.equal(db.prepare('SELECT domain FROM service_bundles WHERE id = ?').get(host.id).domain, 'storage.example.com');
    assert.equal(syncCount, 1);
    await assert.rejects(hosts.update(host.id, { subdomain: 'nas' }), (err) => err.code === 'HOST_EXISTS');
  });

  it('restores entries and host when a rename sync fails', async () => {
    const hostId = await hostIdOf('storage.example.com');
    failNextSync = true;
    await assert.rejects(hosts.update(hostId, { subdomain: 'broken' }), /sync boom/);
    assert.equal(db.prepare('SELECT subdomain FROM service_bundles WHERE id = ?').get(hostId).subdomain, 'storage');
    assert.equal(routeRows(hostId).find((r) => r.route_type === 'http').domain, 'storage.example.com');
  });

  it('changes the LAN address of every entry; a failed sync restores it', async () => {
    const hostId = await hostIdOf('storage.example.com');
    const host = await hosts.update(hostId, { lan_host: '192.168.1.21' });
    assert.equal(host.lan_host, '192.168.1.21');
    assert.ok(routeRows(hostId).every((r) => r.target_lan_host === '192.168.1.21'));
    failNextSync = true;
    await assert.rejects(hosts.update(hostId, { lan_host: '192.168.1.99' }), /sync boom/);
    assert.ok(routeRows(hostId).every((r) => r.target_lan_host === '192.168.1.21'));
  });

  it('updates the description (card title follows)', async () => {
    const hostId = await hostIdOf('storage.example.com');
    const host = await hosts.update(hostId, { description: 'File server' });
    assert.equal(host.description, 'File server');
    assert.equal(host.name, 'File server');
  });

  // ── toggle / override / remove ────────────────────────

  it('toggles every entry of a host', async () => {
    const hostId = await hostIdOf('storage.example.com');
    let host = await hosts.toggle(hostId, false);
    assert.equal(host.enabled_count, 0);
    assert.equal(host.health, 'disabled');
    host = await hosts.toggle(hostId, true);
    assert.equal(host.enabled_count, host.entry_count);
  });

  it('moves an override host back to the zone gateway', async () => {
    const r = await routes.create({ route_type: 'http', domain: 'mail.example.com', target_kind: 'gateway',
      target_peer_id: gw2, target_lan_host: '192.168.1.30', target_port: 3001, target_lan_port: 3001 });
    const hostId = routes.getById(r.id).bundle_id;
    assert.equal(db.prepare('SELECT gateway_override FROM service_bundles WHERE id = ?').get(hostId).gateway_override, 1,
      'a new host with another target than its zone is flagged');
    syncCount = 0;
    const host = await hosts.clearOverride(hostId);
    assert.equal(host.gateway_override, false);
    const row = routes.getById(r.id);
    assert.equal(row.target_peer_id, gw1);
    assert.equal(row.target_lan_host, '192.168.1.30', 'LAN address kept');
    assert.equal(syncCount, 1);
  });

  it('removes a host with all its entries', async () => {
    const hostId = await hostIdOf('wiki.example.com');
    const ids = routeRows(hostId).map((r) => r.id);
    await hosts.remove(hostId);
    assert.equal(db.prepare('SELECT id FROM service_bundles WHERE id = ?').get(hostId), undefined);
    for (const id of ids) assert.equal(routes.getById(id), undefined);
  });

  // ── every route has a host ─────────────────────────────

  it('routes.create joins the host of its fqdn or creates one in the zone', async () => {
    const a = await routes.create({ route_type: 'http', domain: 'new.example.com', target_kind: 'gateway',
      target_peer_id: gw1, target_lan_host: '192.168.1.40', target_port: 80, target_lan_port: 80 });
    const hostId = routes.getById(a.id).bundle_id;
    const host = db.prepare('SELECT * FROM service_bundles WHERE id = ?').get(hostId);
    assert.equal(host.domain_id, zoneId);
    assert.equal(host.subdomain, 'new');
    assert.equal(host.gateway_override, 0);
    const b = await routes.create({ route_type: 'l4', domain: 'new.example.com', l4_protocol: 'tcp', l4_listen_port: '2240',
      l4_tls_mode: 'none', target_kind: 'gateway', target_peer_id: gw1, target_lan_host: '192.168.1.40', target_port: 22, target_lan_port: 22 });
    assert.equal(routes.getById(b.id).bundle_id, hostId, 'same fqdn → same host');
  });

  it('an L4 route without domain gets its own host without zone', async () => {
    const r = await routes.create({ route_type: 'l4', domain: null, l4_protocol: 'tcp', l4_listen_port: '2250',
      l4_tls_mode: 'none', target_kind: 'gateway', target_peer_id: gw1, target_lan_host: '192.168.1.41', target_port: 22, target_lan_port: 22 });
    const host = db.prepare('SELECT * FROM service_bundles WHERE id = ?').get(routes.getById(r.id).bundle_id);
    assert.equal(host.domain_id, null);
    assert.equal(host.name, 'Port 2250');
  });

  it('a zone without gateway adopts the target of its first host', async () => {
    const z = addZone('fresh.net');
    await routes.create({ route_type: 'http', domain: 'www.fresh.net', target_kind: 'gateway',
      target_peer_id: gw2, target_lan_host: '192.168.1.42', target_port: 80, target_lan_port: 80 });
    const zone = db.prepare('SELECT * FROM domains WHERE id = ?').get(z);
    assert.equal(zone.gateway_kind, 'gateway');
    assert.equal(zone.gateway_peer_id, gw2);
  });

  it('never hosts the L4 route an RDP route creates', async () => {
    const rdp = require('../src/services/rdp');
    const rdpRoute = await rdp.create({
      name: 'rdp-zone', host: '192.168.1.81', port: 3389,
      access_mode: 'gateway', gateway_peer_id: gw1, gateway_listen_port: 5301, credential_mode: 'none',
    });
    assert.ok(rdpRoute.gateway_l4_route_id);
    assert.equal(routes.getById(rdpRoute.gateway_l4_route_id).bundle_id, null);
  });

  it('publishes a routes event with domain_id and host_id', async () => {
    const seen = [];
    const listener = (evt) => { if (evt.type === 'routes') seen.push(evt.payload); };
    eventBus.subscribe(listener);
    try {
      const host = await hosts.create(zoneId, { subdomain: 'evt', lan_host: '192.168.1.50', entries: [{ type: 'http', target_port: 80 }] });
      assert.ok(seen.some((p) => p.domain_id === zoneId && p.host_id === host.id));
      seen.length = 0;
      const route = await routes.toggle(host.entries[0].id);
      assert.ok(route);
      assert.deepEqual(seen, [{ domain_id: zoneId, host_id: host.id }]);
    } finally {
      eventBus.unsubscribe(listener);
    }
  });

  // ── scan to folder ─────────────────────────────────────

  it('sets up scan-to-folder for a printer host with its own sync', async () => {
    const printer = await hosts.create(zoneId, { subdomain: 'drucker', template: 'printer', lan_host: '192.168.1.45' });
    assert.equal(printer.entries.length, 3);
    await assert.rejects(hosts.setupScanToFolder(printer.id, { vip_ip: '10.0.0.5', target: { mode: 'new', nas_ip: '192.168.1.60', nas_gateway_peer_id: gw1 } }),
      (err) => err.statusCode === 400 && /subnet/.test(err.message));
    syncCount = 0;
    const res = await hosts.setupScanToFolder(printer.id, {
      vip_ip: '192.168.1.200', target: { mode: 'new', nas_ip: '192.168.1.60', nas_gateway_peer_id: gw1 },
    });
    assert.ok(res.egress_id);
    assert.ok(res.nas_route_id);
    assert.equal(syncCount, 1);
    const nas = routes.getById(res.nas_route_id);
    assert.equal(nas.external_enabled, 0);
    assert.ok(nas.bundle_id, 'the NAS route got a host');
    const egress = db.prepare('SELECT * FROM egress_routes WHERE id = ?').get(res.egress_id);
    assert.equal(egress.near_peer_id, gw1);
    assert.equal(egress.target_route_id, res.nas_route_id);
  });

  it('rolls back egress + NAS route when the scan-to-folder sync fails', async () => {
    const hostId = await hostIdOf('drucker.example.com');
    const egressBefore = db.prepare('SELECT COUNT(*) c FROM egress_routes').get().c;
    const routesBefore = db.prepare('SELECT COUNT(*) c FROM routes').get().c;
    failNextSync = true;
    await assert.rejects(hosts.setupScanToFolder(hostId, {
      vip_ip: '192.168.1.201', target: { mode: 'new', nas_ip: '192.168.1.61', nas_gateway_peer_id: gw1 },
    }), /sync boom/);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM egress_routes').get().c, egressBefore);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM routes').get().c, routesBefore);
  });

  async function hostIdOf(fqdn) {
    const row = db.prepare("SELECT bundle_id FROM routes WHERE domain = ? AND route_type = 'http'").get(fqdn);
    assert.ok(row, 'fixture route for ' + fqdn);
    return row.bundle_id;
  }
});
