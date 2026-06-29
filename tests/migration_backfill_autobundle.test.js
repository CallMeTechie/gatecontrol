'use strict';

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

describe('migration v63: backfill loose domain groups into bundles', () => {
  let routesService, db, migrationSql;

  before(() => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-backfill-'));
    process.env.GC_DB_PATH = path.join(tmp, 'test.db');
    process.env.GC_DATA_DIR = tmp;
    ['../config/default', '../src/db/connection', '../src/db/migrations',
     '../src/db/migrationList', '../src/services/serviceBundle', '../src/services/routes',
     '../src/services/caddyConfig', '../src/services/license',
    ].forEach((p) => { try { delete require.cache[require.resolve(p)]; } catch (_) {} });
    require('../src/db/migrations').runMigrations();
    require('../src/services/caddyConfig').syncToCaddy = async () => true;
    routesService = require('../src/services/routes');
    db = require('../src/db/connection').getDb();
    require('../src/services/license')._overrideForTest &&
      require('../src/services/license')._overrideForTest({ http_routes: 100, l4_routes: 100 });
    migrationSql = require('../src/db/migrationList').migrations.find((m) => m.version === 63).sql;
  });

  // Seed with skipSync so auto-promotion (Task 1/2) does NOT run — we want a
  // pre-migration "loose domain group" to exist.
  const seedHttp = (domain) => routesService.create(
    { route_type: 'http', domain, target_ip: '192.168.1.10', target_port: 8080 }, { skipSync: true });
  const seedL4 = (domain, port) => routesService.create(
    { route_type: 'l4', domain, l4_protocol: 'tcp', l4_listen_port: String(port),
      target_ip: '192.168.1.10', target_port: String(port), l4_tls_mode: 'none' }, { skipSync: true });

  it('bundles a >=2-route domain and is idempotent', async () => {
    const a = await seedHttp('legacy.example.com');
    const b = await seedL4('legacy.example.com', 9100);
    const lone = await seedHttp('lonely.example.com'); // 1 route → must stay single

    db.exec(migrationSql);

    const aa = routesService.getById(a.id);
    const bb = routesService.getById(b.id);
    assert.ok(aa.bundle_id, 'legacy http route got a bundle');
    assert.equal(aa.bundle_id, bb.bundle_id, 'both legacy routes share one bundle');
    assert.equal(routesService.getById(lone.id).bundle_id, null, 'lone route untouched');

    const count = db.prepare("SELECT COUNT(*) c FROM service_bundles WHERE domain = 'legacy.example.com'").get().c;
    assert.equal(count, 1, 'exactly one bundle for the domain');

    db.exec(migrationSql); // idempotent: rows now bundled → guard skips them
    const count2 = db.prepare("SELECT COUNT(*) c FROM service_bundles WHERE domain = 'legacy.example.com'").get().c;
    assert.equal(count2, 1, 'second run creates no duplicate bundle');
  });

  it('does not bundle an RDP-linked l4', async () => {
    const h = await seedHttp('rdpdom.example.com');
    const x = await seedL4('rdpdom.example.com', 3390);
    db.prepare('INSERT INTO rdp_routes (name, host, gateway_l4_route_id) VALUES (?, ?, ?)')
      .run('rdp-test', 'localhost', x.id);

    db.exec(migrationSql);

    // only 1 non-RDP route on the domain → no bundle
    assert.equal(routesService.getById(h.id).bundle_id, null);
    assert.equal(routesService.getById(x.id).bundle_id, null);
  });
});
