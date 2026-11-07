'use strict';

// Gateway-Standorte (docs/feature-gateway-locations.md): migration 141, the
// API /api/v1/gateway-locations (list, create, edit, delete — the gateways of
// a deleted location stay, without one), PUT /api/v1/gateways/:id/location
// (with the pool partner, all or nothing), the location in GET
// /api/v1/gateways and in the assistant's status, POST /api/v1/peers with
// location_id, the activity log, admin only, and the backup (export and
// restore by name).

const crypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown, getCsrf } = require('./helpers/setup');

let agent, app, csrf, db, license;
const send = (method, url, body) => agent[method](url).set('X-CSRF-Token', csrf).send(body || {});

async function gateway(name) {
  const r = await send('post', '/api/v1/peers', { name, is_gateway: true, platform: 'linux' }).expect(201);
  return r.body.peer.id;
}
function events(type) {
  return db.prepare('SELECT event_type, message, details FROM activity_log WHERE event_type = ? ORDER BY id').all(type);
}

before(async () => {
  ({ agent, app } = await setup());
  csrf = getCsrf();
  db = require('../src/db/connection').getDb();
  license = require('../src/services/license');
  license._overrideForTest({ gateway_peers: 20 });
});
after(() => teardown());

describe('migration 141', () => {
  it('creates gateway_locations and gateway_meta.location_id (ON DELETE SET NULL)', () => {
    const cols = db.prepare('PRAGMA table_info(gateway_locations)').all().map((c) => c.name);
    assert.deepEqual(cols, ['id', 'name', 'street', 'postal_code', 'city', 'country', 'created_at', 'updated_at']);
    assert.ok(db.prepare('PRAGMA table_info(gateway_meta)').all().some((c) => c.name === 'location_id'));
    const fk = db.prepare('PRAGMA foreign_key_list(gateway_meta)').all().find((f) => f.from === 'location_id');
    assert.equal(fk.table, 'gateway_locations');
    assert.equal(fk.on_delete, 'SET NULL');
    const m = require('../src/db/migrationList').migrations.find((x) => x.name === 'gateway_locations');
    assert.equal(m.version, 141);
    assert.equal(m.detect(db), true);
  });
});

describe('locations: create, list, edit, delete', () => {
  let home, office, gwA, gwB;
  it('POST creates a location with an optional address (trimmed, country upper case)', async () => {
    const r = await send('post', '/api/v1/gateway-locations', { name: '  Zuhause ', street: 'Musterweg  12', postal_code: '10115', city: 'Berlin', country: 'de' }).expect(201);
    home = r.body.location;
    assert.equal(home.name, 'Zuhause');
    assert.equal(home.street, 'Musterweg 12');
    assert.equal(home.country, 'DE');
    assert.equal(home.gateway_count, 0);
    const o = await send('post', '/api/v1/gateway-locations', { name: 'Büro' }).expect(201);
    office = o.body.location;
    assert.equal(office.city, null);
    assert.equal(office.country, null);
  });
  it('checks the fields: name required, lengths, postcode, country', async () => {
    let r = await send('post', '/api/v1/gateway-locations', { name: '   ' }).expect(400);
    assert.equal(r.body.code, 'invalid');
    assert.ok(r.body.fields.name);
    r = await send('post', '/api/v1/gateway-locations', { name: 'x'.repeat(81) }).expect(400);
    assert.ok(r.body.fields.name);
    r = await send('post', '/api/v1/gateway-locations', { name: 'A', postal_code: '<b>' }).expect(400);
    assert.ok(r.body.fields.postal_code);
    r = await send('post', '/api/v1/gateway-locations', { name: 'A', country: 'Germany' }).expect(400);
    assert.ok(r.body.fields.country);
    r = await send('post', '/api/v1/gateway-locations', { name: 'A', city: 'c'.repeat(81) }).expect(400);
    assert.ok(r.body.fields.city);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM gateway_locations WHERE name = 'A'").get().n, 0);
  });
  it('a name is unique without regard to case (umlauts too) → 409', async () => {
    let r = await send('post', '/api/v1/gateway-locations', { name: 'zuhause' }).expect(409);
    assert.equal(r.body.code, 'name_taken');
    r = await send('post', '/api/v1/gateway-locations', { name: 'BÜRO' }).expect(409);
    assert.equal(r.body.code, 'name_taken');
    await send('put', '/api/v1/gateway-locations/' + office.id, { name: 'ZUHAUSE' }).expect(409);
  });
  it('PUT replaces all fields (a missing one is cleared); unknown id → 404', async () => {
    const r = await send('put', '/api/v1/gateway-locations/' + office.id, { name: 'Büro Hamburg', city: 'Hamburg', country: 'DE' }).expect(200);
    assert.equal(r.body.location.name, 'Büro Hamburg');
    assert.equal(r.body.location.city, 'Hamburg');
    const r2 = await send('put', '/api/v1/gateway-locations/' + office.id, { name: 'Büro', city: 'Hamburg' }).expect(200);
    assert.equal(r2.body.location.country, null);
    await send('put', '/api/v1/gateway-locations/99999', { name: 'X' }).expect(404);
    await send('delete', '/api/v1/gateway-locations/99999').expect(404);
  });
  it('POST /api/v1/peers takes location_id (an unknown one → 400, nothing created)', async () => {
    const r = await send('post', '/api/v1/peers', { name: 'gw-zuhause', is_gateway: true, platform: 'rpi', location_id: home.id }).expect(201);
    gwA = r.body.peer.id;
    assert.equal(db.prepare('SELECT location_id FROM gateway_meta WHERE peer_id = ?').get(gwA).location_id, home.id);
    // the peer group is not touched by the location
    assert.equal(db.prepare('SELECT group_id FROM peers WHERE id = ?').get(gwA).group_id, null);
    await send('post', '/api/v1/peers', { name: 'gw-bad-loc', is_gateway: true, location_id: 99999 }).expect(400);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM peers WHERE name = 'gw-bad-loc'").get().n, 0);
    gwB = await gateway('gw-keller');
    assert.equal(db.prepare('SELECT location_id FROM gateway_meta WHERE peer_id = ?').get(gwB).location_id, null);
  });
  it('GET lists by name with the gateways; GET /api/v1/gateways carries the location', async () => {
    const r = await agent.get('/api/v1/gateway-locations').expect(200);
    assert.deepEqual(r.body.locations.map((l) => l.name), ['Büro', 'Zuhause']);
    const z = r.body.locations.find((l) => l.id === home.id);
    assert.equal(z.gateway_count, 1);
    assert.deepEqual(z.gateways, [{ peer_id: gwA, name: 'gw-zuhause' }]);
    const g = await agent.get('/api/v1/gateways').expect(200);
    const a = g.body.gateways.find((x) => x.peer_id === gwA);
    const b = g.body.gateways.find((x) => x.peer_id === gwB);
    assert.deepEqual(a.location, { id: home.id, name: 'Zuhause', city: 'Berlin', country: 'DE' });
    assert.equal(b.location, null);
    const st = await agent.get(`/api/v1/gateways/${gwA}/setup-status`).expect(200);
    assert.equal(st.body.gateway.location_id, home.id);
  });
  it('PUT /api/v1/gateways/:id/location sets it, with `also` for the pool partner; null clears', async () => {
    let r = await send('put', `/api/v1/gateways/${gwB}/location`, { location_id: office.id, also: [gwA] }).expect(200);
    assert.deepEqual(r.body.changed.map((c) => c.peer_id).sort(), [gwA, gwB].sort());
    assert.equal(db.prepare('SELECT location_id FROM gateway_meta WHERE peer_id = ?').get(gwA).location_id, office.id);
    // nothing changes → nothing logged
    const before = events('gateway_location_changed').length;
    r = await send('put', `/api/v1/gateways/${gwB}/location`, { location_id: office.id }).expect(200);
    assert.deepEqual(r.body.changed, []);
    assert.equal(events('gateway_location_changed').length, before);
    r = await send('put', `/api/v1/gateways/${gwA}/location`, { location_id: null }).expect(200);
    assert.equal(r.body.changed[0].to, null);
    assert.equal(db.prepare('SELECT location_id FROM gateway_meta WHERE peer_id = ?').get(gwA).location_id, null);
    const ev = events('gateway_location_changed');
    assert.match(ev[ev.length - 1].message, /Location of gateway "gw-zuhause" removed/);
  });
  it('all or nothing: an unknown gateway or location changes nothing', async () => {
    await send('put', `/api/v1/gateways/${gwA}/location`, { location_id: home.id, also: [99999] }).expect(404);
    assert.equal(db.prepare('SELECT location_id FROM gateway_meta WHERE peer_id = ?').get(gwA).location_id, null);
    await send('put', `/api/v1/gateways/${gwA}/location`, { location_id: 99999 }).expect(404);
    // a peer that is no gateway
    const plain = db.prepare("INSERT INTO peers (name, public_key, allowed_ips, enabled) VALUES ('laptop-x', 'k', '10.8.0.90/32', 1)").run().lastInsertRowid;
    await send('put', `/api/v1/gateways/${plain}/location`, { location_id: home.id }).expect(404);
  });
  it('DELETE keeps the gateways, without a location', async () => {
    const r = await send('delete', '/api/v1/gateway-locations/' + office.id).expect(200);
    assert.deepEqual(r.body.released.map((g) => g.peer_id), [gwB]);
    assert.equal(db.prepare('SELECT location_id FROM gateway_meta WHERE peer_id = ?').get(gwB).location_id, null);
    assert.ok(db.prepare('SELECT 1 FROM peers WHERE id = ?').get(gwB));
    const ev = events('gateway_location_deleted');
    assert.match(ev[ev.length - 1].message, /Gateway location "Büro" deleted \(1 gateway\(s\) now without a location\)/);
  });
  it('the activity log has created / updated (renamed) / deleted / changed', () => {
    assert.ok(events('gateway_location_created').some((e) => /"Zuhause" created/.test(e.message)));
    assert.ok(events('gateway_location_updated').some((e) => /"Büro" renamed to "Büro Hamburg"/.test(e.message)));
    assert.ok(events('gateway_location_changed').some((e) => /set to "Büro"/.test(e.message)));
    assert.equal(require('../src/services/activityCategories').categoryOf('gateway_location_created'), 'peer');
  });
  it('a gateway deleted with its peer leaves the location alone', async () => {
    await send('put', `/api/v1/gateways/${gwB}/location`, { location_id: home.id }).expect(200);
    db.prepare('DELETE FROM peers WHERE id = ?').run(gwB);
    const r = await agent.get('/api/v1/gateway-locations').expect(200);
    assert.equal(r.body.locations.find((l) => l.id === home.id).gateway_count, 0);
  });
});

describe('admin only', () => {
  it('without a session → 401; CSRF is required', async () => {
    const anon = require('supertest').agent(app);
    const r = await anon.get('/api/v1/gateway-locations');
    assert.ok(r.status === 401 || r.status === 302 || r.status === 403, String(r.status));
    await agent.post('/api/v1/gateway-locations').send({ name: 'Ohne CSRF' }).expect(403);
  });
  it('API token: scope gateway / full-access allowed, others not', () => {
    const tokens = require('../src/services/tokens');
    assert.equal(tokens.checkScope(['gateway'], '/api/v1/gateway-locations', 'POST'), true);
    assert.equal(tokens.checkScope(['full-access'], '/api/v1/gateway-locations', 'DELETE'), true);
    assert.equal(tokens.checkScope(['peers'], '/api/v1/gateway-locations', 'GET'), false);
  });
});

describe('backup', () => {
  it('exports the locations and the gateways\' location by name; restore re-links them', async () => {
    const backup = require('../src/services/backup');
    require('../src/services/peers').rewriteWgConfig = async () => {};
    require('../src/services/routes').syncToCaddy = async () => {};
    const loc = (await send('post', '/api/v1/gateway-locations', { name: 'Eltern', city: 'Kiel', country: 'DE' }).expect(201)).body.location;
    const gw = await gateway('gw-eltern');
    await send('put', `/api/v1/gateways/${gw}/location`, { location_id: loc.id }).expect(200);
    const data = await backup.createBackup();
    const el = data.data.gateway_locations.find((l) => l.name === 'Eltern');
    assert.deepEqual({ city: el.city, country: el.country }, { city: 'Kiel', country: 'DE' });
    const gm = data.data.gateway_meta.find((m) => m.peer_name === 'gw-eltern');
    assert.equal(gm.location_name, 'Eltern');
    assert.equal('location_id' in gm, false);
    // wipe the locations, then restore
    db.prepare('UPDATE gateway_meta SET location_id = NULL').run();
    db.prepare('DELETE FROM gateway_locations').run();
    await backup.restoreBackup(data);
    const back = db.prepare("SELECT l.name FROM gateway_meta gm JOIN peers p ON p.id = gm.peer_id JOIN gateway_locations l ON l.id = gm.location_id WHERE p.name = 'gw-eltern'").get();
    assert.equal(back && back.name, 'Eltern');
    assert.ok(db.prepare("SELECT 1 FROM gateway_locations WHERE name = 'Zuhause'").get());
  });
});
