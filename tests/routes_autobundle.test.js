'use strict';

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

describe('routes auto-bundle promotion', () => {
  let routesService, db;

  before(() => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-autobundle-'));
    process.env.GC_DB_PATH = path.join(tmp, 'test.db');
    process.env.GC_DATA_DIR = tmp;
    ['../config/default', '../src/db/connection', '../src/db/migrations',
     '../src/services/serviceBundle', '../src/services/routes',
     '../src/services/caddyConfig', '../src/services/rdp', '../src/services/license',
    ].forEach((p) => { try { delete require.cache[require.resolve(p)]; } catch (_) {} });
    require('../src/db/migrations').runMigrations();

    const caddy = require('../src/services/caddyConfig');
    caddy.syncToCaddy = async () => true;

    routesService = require('../src/services/routes');
    db = require('../src/db/connection').getDb();

    const license = require('../src/services/license');
    license._overrideForTest && license._overrideForTest({ http_routes: 100, l4_routes: 100 });
  });

  const http = (domain) => routesService.create({
    route_type: 'http', domain, target_ip: '192.168.1.50', target_port: 8080,
  });
  const l4 = (domain, port) => routesService.create({
    route_type: 'l4', domain, l4_protocol: 'tcp', l4_listen_port: String(port),
    target_ip: '192.168.1.50', target_port: 22, l4_tls_mode: 'none',
  });

  it('does NOT bundle a lone route on a domain', async () => {
    const r = await http('solo.example.com');
    assert.equal(r.bundle_id, null);
  });

  it('auto-bundles the 2nd route sharing a domain (http + l4)', async () => {
    const r1 = await http('phoscon.example.com');
    const r2 = await l4('phoscon.example.com', 2222);
    const a = routesService.getById(r1.id);
    const b = routesService.getById(r2.id);
    assert.ok(a.bundle_id, 'http route joined a bundle');
    assert.equal(a.bundle_id, b.bundle_id, 'both routes share one bundle');
    const bundle = db.prepare('SELECT name, domain FROM service_bundles WHERE id = ?').get(a.bundle_id);
    assert.equal(bundle.name, 'phoscon.example.com');
    assert.equal(bundle.domain, 'phoscon.example.com');
  });

  it('keeps the bundle alive when the http route is deleted (1-member service persists)', async () => {
    const r1 = await http('keep.example.com');
    const r2 = await l4('keep.example.com', 2223);
    const bundleId = routesService.getById(r1.id).bundle_id;
    await routesService.remove(r1.id);
    const surviving = routesService.getById(r2.id);
    assert.equal(surviving.bundle_id, bundleId, 'l4 still in the bundle');
    const bundle = db.prepare('SELECT id FROM service_bundles WHERE id = ?').get(bundleId);
    assert.ok(bundle, 'bundle row still exists with one member');
  });

  it('dissolves the bundle only when the last member is removed', async () => {
    const r1 = await http('gone.example.com');
    const r2 = await l4('gone.example.com', 2224);
    const bundleId = routesService.getById(r1.id).bundle_id;
    await routesService.remove(r1.id);
    await routesService.remove(r2.id);
    const bundle = db.prepare('SELECT id FROM service_bundles WHERE id = ?').get(bundleId);
    assert.equal(bundle, undefined, 'empty bundle cleaned up');
  });

  it('joins routes into a bundle when update() moves one onto a shared domain', async () => {
    const a = await http('join.example.com');
    const b = await l4('other.example.com', 2230); // different domain → unbundled
    assert.equal(routesService.getById(b.id).bundle_id, null);
    await routesService.update(b.id, { domain: 'join.example.com' });
    const aa = routesService.getById(a.id);
    const bb = routesService.getById(b.id);
    assert.ok(bb.bundle_id, 'moved route joined a bundle');
    assert.equal(aa.bundle_id, bb.bundle_id, 'both share one bundle');
  });

  it('adds a 3rd route on a domain to the EXISTING bundle (no 2nd bundle)', async () => {
    const r1 = await http('trio.example.com');
    const r2 = await l4('trio.example.com', 2240); // 2nd route → forms the bundle (groupExisting)
    const bundleId = routesService.getById(r1.id).bundle_id;
    assert.ok(bundleId);
    const r3 = await l4('trio.example.com', 2241); // 3rd route → MUST hit addRoutesToBundle
    assert.equal(routesService.getById(r3.id).bundle_id, bundleId, '3rd route joined the existing bundle');
    const count = db.prepare("SELECT COUNT(*) c FROM service_bundles WHERE domain = 'trio.example.com'").get().c;
    assert.equal(count, 1, 'still exactly one bundle for the domain');
  });

  it('does NOT auto-bundle an RDP-linked l4 sharing a domain', async () => {
    // Seed the l4 WITHOUT promotion (skipSync), mark it RDP-linked, THEN add the
    // http — so promotion runs while the l4 is already RDP-owned and excluded.
    const x = await routesService.create({
      route_type: 'l4', domain: 'rdp.example.com', l4_protocol: 'tcp',
      l4_listen_port: '3389', target_ip: '192.168.1.50', target_port: 3389, l4_tls_mode: 'none',
    }, { skipSync: true });
    db.prepare('INSERT INTO rdp_routes (name, host, gateway_l4_route_id) VALUES (?, ?, ?)')
      .run('rdp-test', 'localhost', x.id);
    const h = await http('rdp.example.com'); // create triggers promotion on this domain
    assert.equal(routesService.getById(x.id).bundle_id, null, 'rdp-linked l4 stays unbundled');
    assert.equal(routesService.getById(h.id).bundle_id, null, 'only non-rdp route is the http → no bundle');
  });
});
