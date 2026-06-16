'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');

process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

describe('service bundles', () => {
  let bundles, routesService, db, gwPeerId;
  let failNextSync = false;

  before(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-bundle-'));
    process.env.GC_DB_PATH = path.join(tmp, 'test.db');
    process.env.GC_DATA_DIR = tmp;
    ['../config/default', '../src/db/connection', '../src/db/migrations',
     '../src/services/serviceBundle', '../src/services/routes', '../src/services/gateways',
     '../src/services/license', '../src/services/caddyConfig', '../src/services/rdp',
    ].forEach(p => { try { delete require.cache[require.resolve(p)]; } catch (_) {} });
    require('../src/db/migrations').runMigrations();

    // Stub syncToCaddy BEFORE requiring routes/serviceBundle (they capture
    // the reference at module load). failNextSync injects a one-shot error.
    const caddy = require('../src/services/caddyConfig');
    caddy.syncToCaddy = async () => {
      if (failNextSync) { failNextSync = false; throw new Error('sync boom'); }
      return true;
    };

    routesService = require('../src/services/routes');
    bundles = require('../src/services/serviceBundle');
    db = require('../src/db/connection').getDb();

    const license = require('../src/services/license');
    license._overrideForTest && license._overrideForTest({
      gateway_peers: 10, gateway_tcp_routing: true, rdp_via_gateway: true,
      http_routes: 100, l4_routes: 100,
    });

    const gateways = require('../src/services/gateways');
    const gw = await gateways.createGateway({ name: 'gw-bundle', apiPort: 9876 });
    gwPeerId = gw.peer.id;
  });

  // ── create ─────────────────────────────────────────────

  it('creates an http+l4 bundle against a gateway target', async () => {
    const bundle = await bundles.createBundle({
      name: 'NAS Hauptserver',
      domain: 'SSH.Example.com',
      target: { target_kind: 'gateway', target_peer_id: gwPeerId, target_lan_host: '192.168.2.1' },
      http: { target_port: 80 },
      l4: [{ l4_protocol: 'tcp', l4_listen_port: 2022, target_port: 22 }],
    });

    assert.ok(bundle.id);
    assert.equal(bundle.domain, 'ssh.example.com', 'domain is normalised lowercase');
    assert.equal(bundle.routes.length, 2);

    const httpMember = bundle.routes.find((r) => r.route_type !== 'l4');
    const l4Member = bundle.routes.find((r) => r.route_type === 'l4');
    assert.equal(httpMember.domain, 'ssh.example.com');
    assert.equal(httpMember.bundle_id, bundle.id);
    assert.equal(httpMember.target_lan_host, '192.168.2.1');
    assert.equal(httpMember.target_lan_port, 80);

    assert.equal(l4Member.domain, null, 'no-TLS L4 member keeps domain NULL (label lives on bundle)');
    assert.equal(l4Member.bundle_id, bundle.id);
    assert.equal(l4Member.l4_listen_port, '2022');
    assert.equal(l4Member.target_lan_port, 22);
    assert.equal(l4Member.l4_tls_mode, 'none');
  });

  it('creates an l4-only bundle without domain (tls none)', async () => {
    const bundle = await bundles.createBundle({
      name: 'Nur SSH',
      target: { target_kind: 'peer', target_ip: '10.8.0.50' },
      l4: [{ l4_protocol: 'tcp', l4_listen_port: 2222, target_port: 22 }],
    });
    assert.equal(bundle.domain, null);
    assert.equal(bundle.routes.length, 1);
    assert.equal(bundle.routes[0].target_ip, '10.8.0.50');
  });

  it('creates an http-only bundle', async () => {
    const bundle = await bundles.createBundle({
      name: 'Nur Web',
      domain: 'web-only.example.com',
      target: { target_kind: 'peer', target_ip: '10.8.0.51' },
      http: { target_port: 8080 },
    });
    assert.equal(bundle.routes.length, 1);
    assert.equal(bundle.routes[0].route_type, 'http');
  });

  // ── validation ─────────────────────────────────────────

  it('rejects a bundle without any exposure', async () => {
    await assert.rejects(
      () => bundles.createBundle({
        name: 'leer', domain: 'leer.example.com',
        target: { target_kind: 'peer', target_ip: '10.8.0.52' },
      }),
      /at least one exposure/
    );
  });

  it('requires a domain when an http exposure is present', async () => {
    await assert.rejects(
      () => bundles.createBundle({
        name: 'no-domain',
        target: { target_kind: 'peer', target_ip: '10.8.0.53' },
        http: { target_port: 80 },
      }),
      /Domain is required/
    );
  });

  it('requires a domain for TLS-SNI l4 exposures', async () => {
    await assert.rejects(
      () => bundles.createBundle({
        name: 'sni-no-domain',
        target: { target_kind: 'peer', target_ip: '10.8.0.54' },
        l4: [{ l4_protocol: 'tcp', l4_listen_port: 8443, target_port: 443, l4_tls_mode: 'passthrough' }],
      }),
      /Domain is required/
    );
  });

  it('rejects blocked listen ports', async () => {
    await assert.rejects(
      () => bundles.createBundle({
        name: 'blocked',
        target: { target_kind: 'peer', target_ip: '10.8.0.55' },
        l4: [{ l4_protocol: 'tcp', l4_listen_port: 443, target_port: 443 }],
      }),
      /reserved/
    );
  });

  it('rejects duplicate listen ports inside one payload', async () => {
    await assert.rejects(
      () => bundles.createBundle({
        name: 'dup-port',
        target: { target_kind: 'peer', target_ip: '10.8.0.56' },
        l4: [
          { l4_protocol: 'tcp', l4_listen_port: 3300, target_port: 22 },
          { l4_protocol: 'tcp', l4_listen_port: 3300, target_port: 23 },
        ],
      }),
      /Duplicate listen port/
    );
  });

  it('409s with a suggested port when a listen port collides with an existing route', async () => {
    await bundles.createBundle({
      name: 'erster',
      target: { target_kind: 'peer', target_ip: '10.8.0.57' },
      l4: [{ l4_protocol: 'tcp', l4_listen_port: 4500, target_port: 22 }],
    });
    try {
      await bundles.createBundle({
        name: 'zweiter',
        target: { target_kind: 'peer', target_ip: '10.8.0.58' },
        l4: [{ l4_protocol: 'tcp', l4_listen_port: 4500, target_port: 22 }],
      });
      assert.fail('expected conflict');
    } catch (err) {
      assert.equal(err.statusCode, 409);
      assert.equal(err.code, 'BUNDLE_PORT_CONFLICT');
      assert.equal(err.conflict.port, 4500);
      assert.ok(err.conflict.conflictRouteId);
      assert.ok(err.conflict.suggestedPort > 4500, 'suggests a higher free port');
    }
  });

  // ── failure compensation ───────────────────────────────

  it('cleans up everything when a member create fails mid-way', async () => {
    const bundleCountBefore = db.prepare('SELECT COUNT(*) c FROM service_bundles').get().c;
    const routeCountBefore = db.prepare('SELECT COUNT(*) c FROM routes').get().c;
    await assert.rejects(
      () => bundles.createBundle({
        name: 'kaputt',
        domain: 'kaputt.example.com',
        // peer_id 99999 passes normalizeInput but routes.create throws
        target: { target_kind: 'peer', peer_id: 99999 },
        http: { target_port: 80 },
        l4: [{ l4_protocol: 'tcp', l4_listen_port: 4600, target_port: 22 }],
      }),
      /peer not found/i
    );
    assert.equal(db.prepare('SELECT COUNT(*) c FROM service_bundles').get().c, bundleCountBefore);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM routes').get().c, routeCountBefore);
  });

  it('rolls back all members and the bundle when the Caddy sync fails', async () => {
    const bundleCountBefore = db.prepare('SELECT COUNT(*) c FROM service_bundles').get().c;
    const routeCountBefore = db.prepare('SELECT COUNT(*) c FROM routes').get().c;
    failNextSync = true;
    await assert.rejects(
      () => bundles.createBundle({
        name: 'sync-fail',
        domain: 'sync-fail.example.com',
        target: { target_kind: 'peer', target_ip: '10.8.0.59' },
        http: { target_port: 80 },
        l4: [{ l4_protocol: 'tcp', l4_listen_port: 4700, target_port: 22 }],
      }),
      /sync boom/
    );
    assert.equal(db.prepare('SELECT COUNT(*) c FROM service_bundles').get().c, bundleCountBefore);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM routes').get().c, routeCountBefore);
  });

  // ── lockstep operations ────────────────────────────────

  it('toggles all members in lockstep (idempotent hard-set)', async () => {
    const bundle = await bundles.createBundle({
      name: 'toggle-test',
      domain: 'toggle.example.com',
      target: { target_kind: 'peer', target_ip: '10.8.0.60' },
      http: { target_port: 80 },
      l4: [{ l4_protocol: 'tcp', l4_listen_port: 4800, target_port: 22 }],
    });

    const off = await bundles.toggleBundle(bundle.id, false);
    assert.ok(off.routes.every((r) => r.enabled === 0), 'all members disabled');

    // Hard-set, not flip: disabling again keeps everything disabled
    const offAgain = await bundles.toggleBundle(bundle.id, false);
    assert.ok(offAgain.routes.every((r) => r.enabled === 0));

    const on = await bundles.toggleBundle(bundle.id, true);
    assert.ok(on.routes.every((r) => r.enabled === 1), 'all members enabled');
  });

  it('single-member toggle leaves the rest of the bundle untouched', async () => {
    const bundle = await bundles.createBundle({
      name: 'single-toggle',
      domain: 'single-toggle.example.com',
      target: { target_kind: 'peer', target_ip: '10.8.0.61' },
      http: { target_port: 80 },
      l4: [{ l4_protocol: 'tcp', l4_listen_port: 4900, target_port: 22 }],
    });
    const l4Member = bundle.routes.find((r) => r.route_type === 'l4');
    await routesService.toggle(l4Member.id);

    const after = bundles.getBundle(bundle.id);
    assert.ok(after, 'bundle survives');
    assert.equal(after.routes.find((r) => r.route_type === 'l4').enabled, 0);
    assert.equal(after.routes.find((r) => r.route_type !== 'l4').enabled, 1);
  });

  it('removeBundle deletes routes and the bundle row', async () => {
    const bundle = await bundles.createBundle({
      name: 'delete-all',
      domain: 'delete-all.example.com',
      target: { target_kind: 'peer', target_ip: '10.8.0.62' },
      http: { target_port: 80 },
      l4: [{ l4_protocol: 'tcp', l4_listen_port: 5000, target_port: 22 }],
    });
    const ids = bundle.routes.map((r) => r.id);
    await bundles.removeBundle(bundle.id);
    assert.equal(bundles.getBundle(bundle.id), null);
    for (const rid of ids) {
      assert.equal(db.prepare('SELECT id FROM routes WHERE id = ?').get(rid), undefined);
    }
  });

  it('removeBundle with deleteRoutes=false only ungroups', async () => {
    const bundle = await bundles.createBundle({
      name: 'ungroup',
      domain: 'ungroup.example.com',
      target: { target_kind: 'peer', target_ip: '10.8.0.63' },
      http: { target_port: 80 },
    });
    const routeId = bundle.routes[0].id;
    await bundles.removeBundle(bundle.id, { deleteRoutes: false });
    assert.equal(bundles.getBundle(bundle.id), null);
    const route = db.prepare('SELECT * FROM routes WHERE id = ?').get(routeId);
    assert.ok(route, 'route lives on');
    assert.equal(route.bundle_id, null);
  });

  it('garbage-collects the bundle when its last member is deleted individually', async () => {
    const bundle = await bundles.createBundle({
      name: 'gc-test',
      domain: 'gc-test.example.com',
      target: { target_kind: 'peer', target_ip: '10.8.0.64' },
      http: { target_port: 80 },
    });
    await routesService.remove(bundle.routes[0].id);
    assert.equal(bundles.getBundle(bundle.id), null, 'empty bundle is cleaned up');
  });

  // ── grouping existing routes ───────────────────────────

  it('groups existing routes into a bundle (no Caddy sync needed)', async () => {
    const a = await routesService.create({ domain: 'group-a.example.com', target_ip: '10.8.0.65', target_port: 80 });
    const b = await routesService.create({
      route_type: 'l4', l4_protocol: 'tcp', l4_listen_port: '5100', l4_tls_mode: 'none',
      target_ip: '10.8.0.65', target_port: 22,
    });
    const bundle = bundles.groupExisting({ name: 'Gruppiert', route_ids: [a.id, b.id] });
    assert.equal(bundle.routes.length, 2);
    assert.equal(bundle.domain, 'group-a.example.com', 'domain derived from http member');
  });

  it('rejects grouping an already-bundled route', async () => {
    const existing = bundles.listBundles().find((b) => b.route_count > 0);
    const memberId = bundles.getBundle(existing.id).routes[0].id;
    assert.throws(
      () => bundles.groupExisting({ name: 'doppelt', route_ids: [memberId] }),
      /already part of a service/
    );
  });

  it('rejects grouping more than one http route', async () => {
    const a = await routesService.create({ domain: 'two-http-a.example.com', target_ip: '10.8.0.66', target_port: 80 });
    const b = await routesService.create({ domain: 'two-http-b.example.com', target_ip: '10.8.0.66', target_port: 81 });
    assert.throws(
      () => bundles.groupExisting({ name: 'zwei-http', route_ids: [a.id, b.id] }),
      /at most one HTTP route/
    );
  });

  it('rejects grouping an RDP-linked L4 route', async () => {
    const rdp = require('../src/services/rdp');
    const rdpRoute = await rdp.create({
      name: 'rdp-bundle-guard', host: '192.168.1.80', port: 3389,
      access_mode: 'gateway', gateway_peer_id: gwPeerId,
      gateway_listen_port: 5200, credential_mode: 'none',
    });
    assert.throws(
      () => bundles.groupExisting({ name: 'rdp-grab', route_ids: [rdpRoute.gateway_l4_route_id] }),
      /RDP-linked/
    );
  });

  // ── shared-domain rules (duplicate-check loosening) ────

  it('allows an L4-SNI route to share the domain of an HTTP route', async () => {
    await routesService.create({ domain: 'shared.example.com', target_ip: '10.8.0.67', target_port: 80 });
    const sni = await routesService.create({
      route_type: 'l4', domain: 'shared.example.com',
      l4_protocol: 'tcp', l4_listen_port: '8443', l4_tls_mode: 'passthrough',
      target_ip: '10.8.0.67', target_port: 443,
    });
    assert.equal(sni.domain, 'shared.example.com');
  });

  it('still rejects a second HTTP route on the same domain', async () => {
    await assert.rejects(
      () => routesService.create({ domain: 'shared.example.com', target_ip: '10.8.0.68', target_port: 81 }),
      /already exists/
    );
  });

  it('rejects two SNI routes for the same domain on the same listener', async () => {
    await assert.rejects(
      () => routesService.create({
        route_type: 'l4', domain: 'shared.example.com',
        l4_protocol: 'tcp', l4_listen_port: '8443', l4_tls_mode: 'passthrough',
        target_ip: '10.8.0.69', target_port: 443,
      }),
      /ambiguous SNI/
    );
  });

  it('allows the same SNI domain on a different listener port', async () => {
    const r = await routesService.create({
      route_type: 'l4', domain: 'shared.example.com',
      l4_protocol: 'tcp', l4_listen_port: '8444', l4_tls_mode: 'passthrough',
      target_ip: '10.8.0.70', target_port: 443,
    });
    assert.equal(r.l4_listen_port, '8444');
  });

  // ── DNS rebuild ────────────────────────────────────────

  describe('createBundle DNS rebuild', () => {
    let dnsMod;
    let rebuildCount = 0;
    let originalRebuild;

    before(() => {
      dnsMod = require('../src/services/dns');
      originalRebuild = dnsMod.rebuildNow;
      dnsMod.rebuildNow = () => { rebuildCount++; };
    });

    after(() => { dnsMod.rebuildNow = originalRebuild; });

    it('createBundle() triggers exactly one DNS rebuild after a successful sync', async () => {
      rebuildCount = 0;
      await bundles.createBundle({
        name: 'dns-rebuild-bundle',
        domain: 'dns-rebuild.example.com',
        target: { target_kind: 'peer', target_ip: '10.8.0.99' },
        http: { target_port: 80 },
        l4: [{ l4_protocol: 'tcp', l4_listen_port: 9901, target_port: 22 }],
      });
      assert.equal(rebuildCount, 1, 'createBundle should trigger exactly one DNS rebuild');
    });
  });
});
