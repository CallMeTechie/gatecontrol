'use strict';

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');

process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

describe('rdp gateway access-mode — auto-linked L4 route', () => {
  let rdp, routesService, db, gwPeerId;

  before(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-rdp-gw-'));
    process.env.GC_DB_PATH = path.join(tmp, 'test.db');
    process.env.GC_DATA_DIR = tmp;
    ['../config/default', '../src/db/connection', '../src/db/migrations',
     '../src/services/rdp', '../src/services/routes', '../src/services/gateways',
     '../src/services/license', '../src/services/caddyConfig',
    ].forEach(p => { try { delete require.cache[require.resolve(p)]; } catch (_) {} });
    require('../src/db/migrations').runMigrations();

    // Stub syncToCaddy — no actual Caddy running during tests.
    const caddy = require('../src/services/caddyConfig');
    caddy.syncToCaddy = async () => true;

    rdp = require('../src/services/rdp');
    routesService = require('../src/services/routes');
    db = require('../src/db/connection').getDb();

    const license = require('../src/services/license');
    license._overrideForTest && license._overrideForTest({
      gateway_peers: 10, gateway_tcp_routing: true, rdp_via_gateway: true,
      http_routes: 100, l4_routes: 100,
    });

    const gateways = require('../src/services/gateways');
    const gw = await gateways.createGateway({ name: 'gw-test', apiPort: 9876 });
    gwPeerId = gw.peer.id;
  });

  it('creates an RDP route with access_mode=gateway and links a new L4 route', async () => {
    const rdpRoute = await rdp.create({
      name: 'rdp-dsm', host: '192.168.1.50', port: 3389,
      access_mode: 'gateway',
      gateway_peer_id: gwPeerId,
      gateway_listen_port: 3390,
      credential_mode: 'none',
    });
    assert.equal(rdpRoute.access_mode, 'gateway');
    assert.ok(rdpRoute.gateway_l4_route_id, 'linked L4 route id must be set');

    const l4 = db.prepare('SELECT * FROM routes WHERE id = ?').get(rdpRoute.gateway_l4_route_id);
    assert.ok(l4, 'linked L4 route row must exist');
    assert.equal(l4.route_type, 'l4');
    assert.equal(l4.target_kind, 'gateway');
    assert.equal(l4.target_peer_id, gwPeerId);
    assert.equal(l4.target_lan_host, '192.168.1.50');
    assert.equal(l4.target_lan_port, 3389);
    assert.equal(l4.l4_listen_port, '3390');
    assert.equal(l4.l4_protocol, 'tcp');
  });

  it('removes the linked L4 route when the RDP route is deleted', async () => {
    const r = await rdp.create({
      name: 'rdp-cascade', host: '192.168.1.51', port: 3389,
      access_mode: 'gateway', gateway_peer_id: gwPeerId,
      credential_mode: 'none',
    });
    const l4Id = r.gateway_l4_route_id;
    assert.ok(l4Id);
    await rdp.remove(r.id);
    const l4After = db.prepare('SELECT id FROM routes WHERE id = ?').get(l4Id);
    assert.equal(l4After, undefined, 'L4 route should be gone after RDP cascade-delete');
  });

  it('switching access_mode away from gateway cleans up the linked L4 row', async () => {
    const r = await rdp.create({
      name: 'rdp-switch', host: '192.168.1.52', port: 3389,
      access_mode: 'gateway', gateway_peer_id: gwPeerId,
      credential_mode: 'none',
    });
    const l4IdBefore = r.gateway_l4_route_id;
    assert.ok(l4IdBefore);

    await rdp.update(r.id, { access_mode: 'internal' });
    const rdpAfter = db.prepare('SELECT gateway_l4_route_id FROM rdp_routes WHERE id = ?').get(r.id);
    assert.equal(rdpAfter.gateway_l4_route_id, null, 'link pointer must be cleared');
    const l4After = db.prepare('SELECT id FROM routes WHERE id = ?').get(l4IdBefore);
    assert.equal(l4After, undefined, 'old L4 route should be removed');
  });

  it('rejects access_mode=gateway without a gateway_peer_id', async () => {
    await assert.rejects(
      () => rdp.create({
        name: 'rdp-broken', host: '192.168.1.53', port: 3389,
        access_mode: 'gateway',
        credential_mode: 'none',
      }),
      /gateway peer is required/i
    );
  });

  it('toggling the RDP route propagates the enabled flag to the linked L4 row', async () => {
    const r = await rdp.create({
      name: 'rdp-toggle', host: '192.168.1.54', port: 3389,
      access_mode: 'gateway', gateway_peer_id: gwPeerId,
      credential_mode: 'none',
    });
    const l4Id = r.gateway_l4_route_id;
    assert.ok(l4Id);

    await rdp.toggle(r.id);  // disables
    const l4Disabled = db.prepare('SELECT enabled FROM routes WHERE id = ?').get(l4Id);
    assert.equal(l4Disabled.enabled, 0, 'linked L4 should be disabled when RDP is disabled');

    await rdp.toggle(r.id);  // re-enables
    const l4Enabled = db.prepare('SELECT enabled FROM routes WHERE id = ?').get(l4Id);
    assert.equal(l4Enabled.enabled, 1);
  });
});
