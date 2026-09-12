'use strict';

// domainZones.reconcile() (boot) + resolveZone() + the domainBoot hook.

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

process.env.NODE_ENV = 'test';
process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

describe('domain zones: resolveZone + boot reconcile', () => {
  let db, domainZones, logger;
  const warnings = [];
  const ids = {};

  const rawRoute = (domain, extra = {}) => {
    const cols = { domain, target_ip: '10.0.0.2', target_port: 80, route_type: 'http', enabled: 1, ...extra };
    const keys = Object.keys(cols);
    return db.prepare(`INSERT INTO routes (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`)
      .run(...keys.map((k) => cols[k])).lastInsertRowid;
  };
  const bundleOf = (routeId) => db.prepare('SELECT sb.* FROM service_bundles sb JOIN routes r ON r.bundle_id = sb.id WHERE r.id = ?').get(routeId);
  const snapshot = () => JSON.stringify([
    db.prepare('SELECT * FROM service_bundles ORDER BY id').all(),
    db.prepare('SELECT id, bundle_id FROM routes ORDER BY id').all(),
    db.prepare('SELECT id, domain, status, gateway_kind, gateway_peer_id, gateway_pool_id, default_external_enabled FROM domains ORDER BY id').all(),
  ]);

  before(() => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-zones-rec-'));
    process.env.GC_DB_PATH = path.join(tmp, 'test.db');
    process.env.GC_DATA_DIR = tmp;
    require('../src/db/migrations').runMigrations();
    require('../src/services/caddyConfig').syncToCaddy = async () => true;
    db = require('../src/db/connection').getDb();
    domainZones = require('../src/services/domainZones');
    logger = require('../src/utils/logger');
    const origWarn = logger.warn.bind(logger);
    logger.warn = (obj, msg) => { warnings.push({ obj, msg }); return origWarn(obj, msg); };

    const dom = db.prepare("INSERT INTO domains (domain, status) VALUES (?, 'verified')");
    ids.ex = dom.run('example.com').lastInsertRowid;
    ids.lab = dom.run('lab.example.com').lastInsertRowid;
    ids.couk = dom.run('example.co.uk').lastInsertRowid;

    // Host-less routes as a pre-zones install (or a raw import) leaves them.
    ids.nas = rawRoute('nas.example.com', { external_enabled: 1 });
    ids.nasSsh = rawRoute(null, { route_type: 'l4', l4_protocol: 'tcp', l4_listen_port: '2022', l4_tls_mode: 'none', target_port: 22 });
    ids.lab1 = rawRoute('x.lab.example.com');
    ids.newzone = rawRoute('shop.newzone.org');
    ids.internal = rawRoute('nas.gc.internal');
    // RDP-owned L4 that ended up in a host.
    ids.rdp = rawRoute(null, { route_type: 'l4', l4_protocol: 'tcp', l4_listen_port: '3390', l4_tls_mode: 'none', target_port: 3389 });
    ids.rdpHost = db.prepare("INSERT INTO service_bundles (name) VALUES ('stray')").run().lastInsertRowid;
    db.prepare('UPDATE routes SET bundle_id = ? WHERE id = ?').run(ids.rdpHost, ids.rdp);
    db.prepare("INSERT INTO rdp_routes (name, host, gateway_l4_route_id) VALUES ('rdp', '192.168.1.9', ?)").run(ids.rdp);
    // Two legacy hosts claiming the same (zone, subdomain).
    ids.dupA = db.prepare("INSERT INTO service_bundles (name, domain, domain_id, subdomain) VALUES ('A', 'dup.example.com', ?, 'dup')").run(ids.ex).lastInsertRowid;
    ids.dupB = db.prepare("INSERT INTO service_bundles (name, domain, domain_id, subdomain) VALUES ('B', 'dup.example.com', ?, 'dup')").run(ids.ex).lastInsertRowid;
    rawRoute('dup.example.com', { bundle_id: ids.dupA });
    rawRoute(null, { bundle_id: ids.dupB, route_type: 'l4', l4_protocol: 'tcp', l4_listen_port: '2099', l4_tls_mode: 'none' });
    // A host whose zone row was deleted.
    ids.gone = db.prepare("INSERT INTO service_bundles (name, domain, domain_id, subdomain) VALUES ('Gone', 'app.example.com', 99999, 'app')").run().lastInsertRowid;
    rawRoute('app.example.com', { bundle_id: ids.gone });
  });

  it('resolveZone picks the longest suffix and derives the subdomain', () => {
    assert.deepEqual(domainZones.resolveZone('a.x.lab.example.com'), { domain_id: ids.lab, domain: 'lab.example.com', subdomain: 'a.x' });
    assert.deepEqual(domainZones.resolveZone('Example.com.'), { domain_id: ids.ex, domain: 'example.com', subdomain: '@' });
    assert.deepEqual(domainZones.resolveZone('a.b.example.co.uk'), { domain_id: ids.couk, domain: 'example.co.uk', subdomain: 'a.b' });
    assert.equal(domainZones.resolveZone('notexample.com'), null, 'no partial-label match');
    assert.equal(domainZones.resolveZone(''), null);
  });

  it('reconciles hosts, zones and gateways', () => {
    const summary = domainZones.reconcile();
    assert.ok(summary.hostsAssigned >= 5);

    const nas = bundleOf(ids.nas);
    assert.equal(nas.domain_id, ids.ex);
    assert.equal(nas.subdomain, 'nas');
    const ssh = bundleOf(ids.nasSsh);
    assert.equal(ssh.domain_id, null, 'L4 without domain → own host without zone');
    assert.equal(bundleOf(ids.lab1).domain_id, ids.lab);

    const seeded = db.prepare("SELECT * FROM domains WHERE domain = 'newzone.org'").get();
    assert.ok(seeded, 'missing public base is seeded');
    assert.equal(seeded.status, 'pending');
    assert.equal(bundleOf(ids.newzone).domain_id, seeded.id);
    assert.equal(bundleOf(ids.newzone).subdomain, 'shop');

    assert.equal(bundleOf(ids.internal).domain_id, null, 'non-public TLD: no zone seeded');
    assert.equal(db.prepare("SELECT id FROM domains WHERE domain LIKE '%internal'").get(), undefined);

    assert.equal(db.prepare('SELECT bundle_id FROM routes WHERE id = ?').get(ids.rdp).bundle_id, null, 'RDP L4 detached');
    assert.equal(db.prepare('SELECT id FROM service_bundles WHERE id = ?').get(ids.rdpHost), undefined, 'emptied host dropped');

    const gone = db.prepare('SELECT * FROM service_bundles WHERE id = ?').get(ids.gone);
    assert.equal(gone.domain_id, ids.ex, 'dangling zone link re-resolved');
    assert.equal(gone.subdomain, 'app');

    const ex = db.prepare('SELECT * FROM domains WHERE id = ?').get(ids.ex);
    assert.equal(ex.gateway_kind, 'peer', 'zone without gateway gets the majority target');
  });

  it('logs (domain, subdomain) duplicates with their host ids', () => {
    const w = warnings.find((x) => /Duplicate host/.test(x.msg));
    assert.ok(w, 'duplicate warning logged');
    assert.deepEqual(w.obj.hostIds.sort((a, b) => a - b), [ids.dupA, ids.dupB]);
  });

  it('is idempotent', () => {
    const before = snapshot();
    const summary = domainZones.reconcile();
    assert.equal(snapshot(), before);
    assert.equal(summary.hostsAssigned, 0);
    assert.equal(summary.seeded, 0);
  });

  it('domainBoot runs the reconcile and survives it throwing', async () => {
    const orphan = rawRoute('late.example.com');
    const domainBoot = require('../src/services/domainBoot');
    const verifyEach = async () => ({ status: 'verified', resolvedIp: '1.2.3.4', expectedIp: '1.2.3.4', error: null });
    await domainBoot.runDomainSeedAndVerify({ verifyEach });
    assert.ok(bundleOf(orphan), 'boot pass gave the new route a host');

    const orig = domainZones.reconcile;
    domainZones.reconcile = () => { throw new Error('reconcile boom'); };
    try {
      const res = await domainBoot.runDomainSeedAndVerify({ verifyEach });
      assert.ok(res && typeof res.seeded === 'number', 'boot pass still completes');
    } finally {
      domainZones.reconcile = orig;
    }
  });
});
