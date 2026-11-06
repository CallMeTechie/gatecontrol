'use strict';

// Gateway assistant "Gateway hinzufügen" (docs/feature-gateway-wizard.md):
// creation through the existing POST /api/v1/peers with a platform, the
// gateway list ("wartet auf ersten Start"), the live status of step 4, the
// platform of an older gateway, the Synology package (ZIP content, rotated
// tokens) and "Im Smart Home einbinden" (internal route 127.0.0.1:8090 +
// access target of the Smart Home plugin, idempotent).

const crypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setup, teardown, getCsrf } = require('./helpers/setup');
const { unzip } = require('./helpers/unzip');

let agent, csrf, db, gateways, license;
const post = (url, body) => agent.post(url).set('X-CSRF-Token', csrf).send(body || {});

function binaryParser(res, cb) {
  const chunks = [];
  res.on('data', (c) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
}

before(async () => {
  ({ agent } = await setup());
  csrf = getCsrf();
  db = require('../src/db/connection').getDb();
  gateways = require('../src/services/gateways');
  license = require('../src/services/license');
  license._overrideForTest({ gateway_peers: 20, http_routes: -1, gateway_http_targets: -1 });
});
after(() => teardown());

describe('creation with a platform (existing endpoint)', () => {
  let groupId;
  it('POST /api/v1/peers { is_gateway, platform, group_id } stores both', async () => {
    groupId = Number(db.prepare("INSERT INTO peer_groups (name, color) VALUES ('Zuhause', '#00aa88')").run().lastInsertRowid);
    const r = await post('/api/v1/peers', { name: 'Pi Keller', is_gateway: true, platform: 'rpi', group_id: groupId }).expect(201);
    assert.equal(r.body.peer.peer_type, 'gateway');
    assert.match(r.body.gateway.envContent, /^GC_API_TOKEN=gc_gw_[0-9a-f]{64}$/m);
    const meta = db.prepare('SELECT platform, first_seen_at FROM gateway_meta WHERE peer_id = ?').get(r.body.peer.id);
    assert.deepEqual(meta, { platform: 'rpi', first_seen_at: null });
    assert.equal(db.prepare('SELECT group_id FROM peers WHERE id = ?').get(r.body.peer.id).group_id, groupId);
  });
  it('no platform = NULL (as before); unknown platform / group → 400', async () => {
    const r = await post('/api/v1/peers', { name: 'gw-legacy', is_gateway: true }).expect(201);
    assert.equal(db.prepare('SELECT platform FROM gateway_meta WHERE peer_id = ?').get(r.body.peer.id).platform, null);
    await post('/api/v1/peers', { name: 'gw-bad', is_gateway: true, platform: 'windows' }).expect(400);
    await post('/api/v1/peers', { name: 'gw-bad2', is_gateway: true, platform: 'linux', group_id: 99999 }).expect(400);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM peers WHERE name LIKE 'gw-bad%'").get().n, 0);
  });
  it('licence limit gateway_peers → 403 with the feature, nothing created', async () => {
    const n = db.prepare("SELECT COUNT(*) AS n FROM peers WHERE peer_type='gateway'").get().n;
    license._overrideForTest({ gateway_peers: n });
    const r = await post('/api/v1/peers', { name: 'gw-over', is_gateway: true, platform: 'linux' }).expect(403);
    assert.equal(r.body.feature, 'gateway_peers');
    license._overrideForTest({ gateway_peers: 20 });
  });
  it('without CSRF token → 403', async () => {
    await agent.post('/api/v1/peers').send({ name: 'gw-nocsrf', is_gateway: true, platform: 'rpi' }).expect(403);
  });
});

describe('list + live status', () => {
  let id;
  before(async () => {
    const r = await post('/api/v1/peers', { name: 'NAS Buero', is_gateway: true, platform: 'synology' }).expect(201);
    id = r.body.peer.id;
  });
  it('a gateway that never reported is "never_connected" with platform and created_at', async () => {
    const r = await agent.get('/api/v1/gateways').expect(200);
    const g = r.body.gateways.find((x) => x.peer_id === id);
    assert.equal(g.never_connected, true);
    assert.equal(g.platform, 'synology');
    assert.ok(g.created_at > 0);
  });
  it('setup-status before the first heartbeat: created, not connected', async () => {
    const r = await agent.get(`/api/v1/gateways/${id}/setup-status`).expect(200);
    const s = r.body.gateway;
    assert.equal(s.connected, false);
    assert.equal(s.platform, 'synology');
    assert.equal(s.hardware, null);
    assert.equal(s.hardware_supported, null);
    assert.equal(s.zigbee, null);
    assert.ok(!('envContent' in s) && !JSON.stringify(s).includes('gc_gw_'), 'no secrets');
  });
  it('first heartbeat (old gateway): first_seen_at set once, hardware step skipped', async () => {
    gateways.handleHeartbeat(id, { hostname: 'ds920', telemetry: { gateway_version: '1.16.11' } });
    const first = db.prepare('SELECT first_seen_at FROM gateway_meta WHERE peer_id = ?').get(id).first_seen_at;
    assert.ok(first > 0);
    await new Promise((r) => setTimeout(r, 5));
    gateways.handleHeartbeat(id, { hostname: 'ds920', telemetry: { gateway_version: '1.16.11' } });
    assert.equal(db.prepare('SELECT first_seen_at FROM gateway_meta WHERE peer_id = ?').get(id).first_seen_at, first, 'kept');
    const s = (await agent.get(`/api/v1/gateways/${id}/setup-status`).expect(200)).body.gateway;
    assert.equal(s.connected, true);
    assert.equal(s.first_seen_at, first);
    assert.equal(s.hardware_supported, false);
    assert.equal(s.hostname, 'ds920');
    const g = (await agent.get('/api/v1/gateways').expect(200)).body.gateways.find((x) => x.peer_id === id);
    assert.equal(g.never_connected, false);
  });
  it('Pi with telemetry hardware (1.17.0) and a RaspBee II', async () => {
    const pi = (await post('/api/v1/peers', { name: 'Pi Garten', is_gateway: true, platform: 'rpi' }).expect(201)).body.peer.id;
    gateways.handleHeartbeat(pi, { hostname: 'gc-pi-garten', telemetry: { gateway_version: '1.17.0', hardware: {
      model: 'Raspberry Pi 3 Model B Plus Rev 1.3', arch: 'arm64', cpu_cores: 4, mem_total: 948000000,
      storage: { total: 30e9, free: 22e9 }, platform: 'rpi-image', image_version: '1.17.0',
      radios: [{ kind: 'zigbee', type: 'raspbee2-conbee2', device: '/dev/ttyAMA0', firmware: '0x26780700', detected: true, enabled: true }],
    } } });
    const s = (await agent.get(`/api/v1/gateways/${pi}/setup-status`).expect(200)).body.gateway;
    assert.equal(s.hardware_supported, true);
    assert.equal(s.hardware.model, 'Raspberry Pi 3 Model B Plus Rev 1.3');
    assert.equal(s.hardware.cpu_cores, 4);
    assert.equal(s.hardware.storage_free, 22e9);
    assert.equal(s.zigbee.label, 'RaspBee II');
    assert.equal(s.deconz, null, 'no route yet');
  });
  it('unknown / non-gateway id → 404', async () => {
    await agent.get('/api/v1/gateways/999999/setup-status').expect(404);
  });
});

describe('platform of an older gateway', () => {
  it('PUT /api/v1/gateways/:id/platform validates and stores', async () => {
    const id = (await post('/api/v1/peers', { name: 'gw-old', is_gateway: true }).expect(201)).body.peer.id;
    await agent.put(`/api/v1/gateways/${id}/platform`).set('X-CSRF-Token', csrf).send({ platform: 'bsd' }).expect(400);
    await agent.put(`/api/v1/gateways/${id}/platform`).set('X-CSRF-Token', csrf).send({ platform: 'proxmox' }).expect(200);
    assert.equal(db.prepare('SELECT platform FROM gateway_meta WHERE peer_id = ?').get(id).platform, 'proxmox');
    await agent.put('/api/v1/gateways/999999/platform').set('X-CSRF-Token', csrf).send({ platform: 'rpi' }).expect(404);
  });
});

describe('Synology package', () => {
  it('POST …/setup-bundle → gatecontrol-gateway-nas.zip with fixed names and fresh tokens', async () => {
    const id = (await post('/api/v1/peers', { name: 'NAS Wohnzimmer', is_gateway: true, platform: 'synology' }).expect(201)).body.peer.id;
    const oldHash = db.prepare('SELECT api_token_hash FROM gateway_meta WHERE peer_id = ?').get(id).api_token_hash;
    const r = await post(`/api/v1/gateways/${id}/setup-bundle`).buffer(true).parse(binaryParser).expect(200);
    assert.equal(r.headers['content-type'], 'application/zip');
    assert.match(r.headers['content-disposition'], /filename="gatecontrol-gateway-nas\.zip"/);
    assert.match(r.headers['cache-control'], /no-store/);
    const entries = unzip(r.body);
    assert.deepEqual(entries.map((e) => e.name), ['docker-compose.yml', 'config/', 'config/gateway.env', 'gateway-state/', 'gateway-cache/', 'update.sh']);
    const byName = Object.fromEntries(entries.map((e) => [e.name, e]));
    const compose = byName['docker-compose.yml'].data.toString();
    assert.match(compose, /network_mode: host/);
    assert.match(compose, /\/dev\/net\/tun/);
    assert.match(compose, /\.\/gateway-state:\/state/);
    assert.equal(byName['update.sh'].data.toString(),
      fs.readFileSync(path.join(__dirname, '..', 'src/services/gatewaySetup/templates/update.sh'), 'utf8'));
    assert.equal(byName['update.sh'].mode & 0o777, 0o755);
    const env = byName['config/gateway.env'].data.toString();
    const token = /^GC_API_TOKEN=(gc_gw_[0-9a-f]{64})$/m.exec(env)[1];
    const meta = db.prepare('SELECT api_token_hash FROM gateway_meta WHERE peer_id = ?').get(id);
    assert.notEqual(meta.api_token_hash, oldHash, 'tokens rotated');
    assert.equal(meta.api_token_hash, 'sha256:' + crypto.createHash('sha256').update(token).digest('hex'));
  });
  it('without CSRF → 403; unknown gateway → 404', async () => {
    const id = db.prepare("SELECT peer_id FROM gateway_meta LIMIT 1").get().peer_id;
    await agent.post(`/api/v1/gateways/${id}/setup-bundle`).expect(403);
    await post('/api/v1/gateways/999999/setup-bundle').expect(404);
  });
});

describe('setup-info', () => {
  it('Pi image of the latest release (name with version, size, URL of this repo) or null', async () => {
    const rel = require('../src/services/gatewayRelease');
    rel._setCache('1.17.0', { name: 'gatecontrol-gateway-1.17.0-rpi-arm64.img.xz', size: 672137216,
      url: 'https://github.com/CallMeTechie/gatecontrol-gateway/releases/download/v1.17.0/gatecontrol-gateway-1.17.0-rpi-arm64.img.xz' });
    let r = await agent.get('/api/v1/gateways/setup-info').expect(200);
    assert.equal(r.body.rpi_image.name, 'gatecontrol-gateway-1.17.0-rpi-arm64.img.xz');
    assert.equal(r.body.rpi_image.size, 672137216);
    assert.equal(r.body.imager_repo_url, 'https://github.com/CallMeTechie/gatecontrol-gateway/releases/latest/download/gatecontrol-rpi-imager.json');
    assert.equal(r.body.smarthome.installed, false);
    // a foreign URL is never served
    rel._setCache('1.17.0', { name: 'gatecontrol-gateway-1.17.0-rpi-arm64.img.xz', size: 1, url: 'https://evil.example/gatecontrol-gateway-1.17.0-rpi-arm64.img.xz' });
    r = await agent.get('/api/v1/gateways/setup-info').expect(200);
    assert.equal(r.body.rpi_image, null);
    assert.equal(r.body.releases_url, 'https://github.com/CallMeTechie/gatecontrol-gateway/releases/latest');
  });
  it('picks the Pi image from a GitHub release body', () => {
    const rel = require('../src/services/gatewayRelease');
    const img = rel._rpiImageOf({ assets: [
      { name: 'gatecontrol-rpi-imager.json', size: 900, browser_download_url: 'https://github.com/CallMeTechie/gatecontrol-gateway/releases/download/v1.17.1/gatecontrol-rpi-imager.json' },
      { name: 'gatecontrol-gateway-1.17.1-rpi-arm64.img.xz.sha256', size: 90, browser_download_url: 'https://github.com/CallMeTechie/gatecontrol-gateway/releases/download/v1.17.1/gatecontrol-gateway-1.17.1-rpi-arm64.img.xz.sha256' },
      { name: 'gatecontrol-gateway-1.17.1-rpi-arm64.img.xz', size: 600000000, browser_download_url: 'https://github.com/CallMeTechie/gatecontrol-gateway/releases/download/v1.17.1/gatecontrol-gateway-1.17.1-rpi-arm64.img.xz' },
    ] });
    assert.deepEqual(img, { name: 'gatecontrol-gateway-1.17.1-rpi-arm64.img.xz', size: 600000000,
      url: 'https://github.com/CallMeTechie/gatecontrol-gateway/releases/download/v1.17.1/gatecontrol-gateway-1.17.1-rpi-arm64.img.xz' });
    assert.equal(rel._rpiImageOf({ assets: [] }), null);
  });
});

describe('"Im Smart Home einbinden"', () => {
  let id;
  const registry = () => require('../src/services/plugins/registry');
  const targets = () => require('../src/services/plugins/targets');
  before(async () => {
    id = (await post('/api/v1/peers', { name: 'Pi Zigbee', is_gateway: true, platform: 'rpi' }).expect(201)).body.peer.id;
  });
  it('plugin not installed → 409 plugin_missing, no route created', async () => {
    const r = await post(`/api/v1/gateways/${id}/smarthome`).expect(409);
    assert.equal(r.body.code, 'plugin_missing');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM routes WHERE target_peer_id = ?').get(id).n, 0);
  });
  it('creates the internal route 127.0.0.1:8090 and assigns it to the target "gateway"', async () => {
    registry().upsert({
      manifest: { id: 'gatecontrol-smarthome', name: { de: 'Smart Home', en: 'Smart Home' }, version: '1.6.1', publisher: 'CallMeTechie',
        permissions: { network: { homeTargets: [{ id: 'gateway', label: 'Phoscon/deCONZ-Gateway', protocols: ['http'],
          proto: { http: true, tcp: [], udp: [] }, multiple: true }] } } },
      signature: 'trusted', enabled: true,
    });
    const r = await post(`/api/v1/gateways/${id}/smarthome`, { domain: 'phoscon-zigbee.gc.internal' }).expect(200);
    assert.equal(r.body.route.created, true);
    assert.equal(r.body.target.index, 0);
    assert.equal(r.body.target.assigned_now, true);
    assert.equal(r.body.plugin_url, '/plugins/gatecontrol-smarthome');
    const route = db.prepare('SELECT * FROM routes WHERE id = ?').get(r.body.route.id);
    assert.equal(route.domain, 'phoscon-zigbee.gc.internal');
    assert.equal(route.target_kind, 'gateway');
    assert.equal(route.target_peer_id, id);
    assert.equal(route.target_lan_host, '127.0.0.1');
    assert.equal(route.target_lan_port, 8090);
    assert.equal(route.external_enabled, 0, 'internal only');
    assert.deepEqual(targets().assignments('gatecontrol-smarthome').gateway, [{ kind: 'route', routeId: route.id }]);
    const act = db.prepare("SELECT COUNT(*) AS n FROM activity_log WHERE event_type = 'plugin_target_changed'").get().n;
    assert.ok(act >= 1, 'audit entry');
  });
  it('idempotent: a second click neither creates a route nor a second assignment', async () => {
    const before = db.prepare('SELECT COUNT(*) AS n FROM routes').get().n;
    const r = await post(`/api/v1/gateways/${id}/smarthome`, { domain: 'other.gc.internal' }).expect(200);
    assert.equal(r.body.route.created, false);
    assert.equal(r.body.target.assigned_now, false);
    assert.equal(r.body.target.index, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM routes').get().n, before);
    assert.equal(targets().assignments('gatecontrol-smarthome').gateway.length, 1);
  });
  it('setup-status shows the route, deCONZ reachability (from the heartbeat) and the assignment', async () => {
    const routeId = db.prepare("SELECT id FROM routes WHERE target_peer_id = ? AND target_lan_port = 8090").get(id).id;
    gateways.handleHeartbeat(id, { telemetry: { gateway_version: '1.17.0', hardware: { radios: [{ kind: 'zigbee', type: 'conbee3', device: '/dev/ttyACM0', detected: true, enabled: true }] } },
      route_reachability: [{ route_id: routeId, domain: 'phoscon-zigbee.gc.internal', reachable: true }] });
    const s = (await agent.get(`/api/v1/gateways/${id}/setup-status`).expect(200)).body.gateway;
    assert.equal(s.deconz.route_id, routeId);
    assert.equal(s.deconz.reachable, true);
    assert.equal(s.deconz.url, 'https://phoscon-zigbee.gc.internal/');
    assert.equal(s.zigbee.label, 'ConBee III');
    assert.deepEqual(s.smarthome, { installed: true, target_declared: true, assigned: true, index: 0, plugin_url: '/plugins/gatecontrol-smarthome' });
  });
  it('an existing route of another gateway is a separate assignment; a taken domain → 409', async () => {
    const other = (await post('/api/v1/peers', { name: 'Pi Zwei', is_gateway: true, platform: 'rpi' }).expect(201)).body.peer.id;
    const taken = await post(`/api/v1/gateways/${other}/smarthome`, { domain: 'phoscon-zigbee.gc.internal' }).expect(409);
    assert.equal(taken.body.code, 'domain_taken');
    const bad = await post(`/api/v1/gateways/${other}/smarthome`, { domain: 'not a domain' }).expect(400);
    assert.equal(bad.body.code, 'domain_invalid');
    const r = await post(`/api/v1/gateways/${other}/smarthome`).expect(200);
    assert.match(r.body.route.domain, /^phoscon-pi-zwei\.gc\.internal$/);
    assert.equal(r.body.target.index, 1);
  });
  it('without CSRF → 403', async () => {
    await agent.post(`/api/v1/gateways/${id}/smarthome`).send({}).expect(403);
  });
});

describe('migration 126 gateway_meta_platform', () => {
  it('adds platform + first_seen_at and takes last_seen_at as the first contact of existing gateways', () => {
    const { runMigrations } = require('../src/db/migrations');
    const row = db.prepare("SELECT peer_id FROM gateway_meta LIMIT 1").get();
    db.prepare('UPDATE gateway_meta SET last_seen_at = 1700000000000 WHERE peer_id = ?').run(row.peer_id);
    db.exec('ALTER TABLE gateway_meta DROP COLUMN platform; ALTER TABLE gateway_meta DROP COLUMN first_seen_at;');
    db.prepare('DELETE FROM migration_history WHERE version = 126').run();
    runMigrations();
    const cols = db.prepare('PRAGMA table_info(gateway_meta)').all().map((c) => c.name);
    assert.ok(cols.includes('platform') && cols.includes('first_seen_at'));
    assert.equal(db.prepare('SELECT first_seen_at FROM gateway_meta WHERE peer_id = ?').get(row.peer_id).first_seen_at, 1700000000000);
    assert.equal(db.prepare('SELECT name FROM migration_history WHERE version = 126').get().name, 'gateway_meta_platform');
  });
});
