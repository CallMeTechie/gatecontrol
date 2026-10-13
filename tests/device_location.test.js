'use strict';

// Location sharing on tap (docs/feature-device-location.md):
// /api/v1/client/location (status, report, delete) — token + client scope,
// device required, admin allow per user, validation, keep the newest 20,
// retention purge, user deletion; admin API for the profile / device page
// (devices, detail, delete, allow switch) and the two pages (admin only,
// map tiles allowed in the CSP of the device page only).

const crypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const { setup, teardown, getCsrf } = require('./helpers/setup');
const H = require('./helpers/notify');

const PATH = '/api/v1/client/location';
const FIX = { lat: 51.3397123, lng: 12.3731456, accuracy: 12.34, altitude: 113.2, provider: 'fused' };

let app; let agent; let anna; let adminId;

before(async () => {
  ({ app, agent } = await setup());
  anna = H.makeUser('loc-anna');
  adminId = H.db().prepare("SELECT id FROM users WHERE username = 'admin'").get().id;
});
after(() => teardown());

function report(dev, body) {
  return supertest(app).post(PATH).set('X-API-Token', dev.raw).set('X-Client-Platform', 'android').send(body);
}

describe('client API', () => {
  it('401 without a token, 403 for a session and without the client scope', async () => {
    await supertest(app).get(PATH).expect(401);
    const s = await agent.get(PATH).expect(403);
    assert.equal(s.body.error, 'token_required');
    const ro = H.makeDevice(adminId, { name: 'loc-ro', scopes: ['read-only'] });
    const r = await supertest(app).get(PATH).set('X-API-Token', ro.raw).expect(403);
    assert.equal(r.body.error, 'scope_required');
  });

  it('a token without a device gets no_peer', async () => {
    const t = require('../src/services/tokens').create({ name: 'loc-nopeer', scopes: ['client'], userId: anna }, '127.0.0.1');
    const r = await supertest(app).get(PATH).set('X-API-Token', t.rawToken).expect(403);
    assert.equal(r.body.error, 'no_peer');
  });

  it('status: allowed by default, nothing stored, no-store', async () => {
    const dev = H.makeDevice(anna, { name: 'loc-status' });
    const r = await supertest(app).get(PATH).set('X-API-Token', dev.raw).expect(200);
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.deepEqual(r.body, { ok: true, allowed: true, last: null, keep: 20, retention_days: 30 });
  });

  it('stores a report (rounded), shows it as last, logs without coordinates', async () => {
    const dev = H.makeDevice(anna, { name: 'loc-store' });
    const now = Date.now();
    const r = await report(dev, { ...FIX, captured_at: now - 5000 }).expect(200);
    assert.equal(r.body.ok, true);
    assert.ok(r.body.at >= now);
    const row = H.db().prepare('SELECT * FROM device_locations WHERE peer_id = ?').get(dev.peerId);
    assert.equal(row.lat, 51.3397123);
    assert.equal(row.accuracy, 12.3);
    assert.equal(row.provider, 'fused');
    assert.equal(row.captured_at, now - 5000);
    assert.equal(row.user_id, anna);
    assert.equal(row.token_id, dev.tokenId);
    assert.equal(row.via, 'direct');
    const s = await supertest(app).get(PATH).set('X-API-Token', dev.raw).expect(200);
    assert.equal(s.body.last.lat, 51.3397123);
    assert.equal(s.body.last.accuracy, 12.3);
    const log = H.db().prepare("SELECT * FROM activity_log WHERE event_type = 'client_location_shared' ORDER BY id DESC LIMIT 1").get();
    assert.ok(log);
    assert.doesNotMatch(log.message + log.details, /51\.33|12\.37/);
    assert.equal(JSON.parse(log.details).peerId, dev.peerId);
  });

  it('a device clock far off becomes server time; an unknown provider is dropped', async () => {
    const dev = H.makeDevice(anna, { name: 'loc-clock' });
    const before0 = Date.now();
    await report(dev, { ...FIX, provider: 'GPS!', captured_at: before0 - 3 * 3600 * 1000 }).expect(200);
    const row = H.db().prepare('SELECT * FROM device_locations WHERE peer_id = ?').get(dev.peerId);
    assert.ok(row.captured_at >= before0);
    assert.equal(row.provider, null);
  });

  it('rejects broken coordinates', async () => {
    const dev = H.makeDevice(anna, { name: 'loc-bad' });
    for (const [body, err] of [
      [{ lng: 1 }, 'invalid_lat'],
      [{ lat: 91, lng: 1 }, 'invalid_lat'],
      [{ lat: '51', lng: 1 }, 'invalid_lat'],
      [{ lat: 1, lng: -181 }, 'invalid_lng'],
      [{ lat: 1, lng: 1, accuracy: -1 }, 'invalid_accuracy'],
      [{ lat: 1, lng: 1, altitude: 1e9 }, 'invalid_altitude'],
    ]) {
      const r = await report(dev, body).expect(400);
      assert.equal(r.body.error, err);
    }
    assert.equal(H.db().prepare('SELECT COUNT(*) AS c FROM device_locations WHERE peer_id = ?').get(dev.peerId).c, 0);
  });

  it('keeps only the newest 20 per device', () => {
    const loc = require('../src/services/deviceLocations');
    const dev = H.makeDevice(anna, { name: 'loc-keep' });
    const t0 = Date.now() - 100000;
    for (let i = 0; i < 25; i += 1) {
      loc.record({ peerId: dev.peerId, tokenId: dev.tokenId, userId: anna, value: { lat: i, lng: i, accuracy: null, altitude: null, provider: null, capturedAt: t0 + i }, via: 'direct', now: t0 + i * 1000 });
    }
    const hist = loc.history(dev.peerId);
    assert.equal(hist.length, 20);
    assert.equal(hist[0].lat, 24);
    assert.equal(hist[19].lat, 5);
  });

  it('not allowed for the user → 403, status says so, delete still works', async () => {
    const bert = H.makeUser('loc-bert');
    const dev = H.makeDevice(bert, { name: 'loc-denied' });
    await report(dev, FIX).expect(200);
    H.db().prepare('UPDATE users SET location_sharing = 0 WHERE id = ?').run(bert);
    const r = await report(dev, FIX).expect(403);
    assert.equal(r.body.error, 'location_not_allowed');
    const s = await supertest(app).get(PATH).set('X-API-Token', dev.raw).expect(200);
    assert.equal(s.body.allowed, false);
    const d = await supertest(app).delete(PATH).set('X-API-Token', dev.raw).expect(200);
    assert.deepEqual(d.body, { ok: true, deleted: 1 });
    assert.equal(H.db().prepare('SELECT COUNT(*) AS c FROM device_locations WHERE peer_id = ?').get(dev.peerId).c, 0);
  });

  it('a disabled user may not share', async () => {
    const cleo = H.makeUser('loc-cleo');
    const dev = H.makeDevice(cleo, { name: 'loc-off' });
    H.db().prepare('UPDATE users SET enabled = 0 WHERE id = ?').run(cleo);
    // The token middleware already refuses disabled accounts.
    const r = await report(dev, FIX);
    assert.equal(r.status, 403);
    assert.equal(H.db().prepare('SELECT COUNT(*) AS c FROM device_locations WHERE peer_id = ?').get(dev.peerId).c, 0);
  });

  it('retention purge and user deletion remove positions', () => {
    const loc = require('../src/services/deviceLocations');
    const dora = H.makeUser('loc-dora');
    const dev = H.makeDevice(dora, { name: 'loc-purge' });
    const old = Date.now() - 31 * 86400000;
    loc.record({ peerId: dev.peerId, userId: dora, value: { lat: 1, lng: 1, accuracy: null, altitude: null, provider: null, capturedAt: old }, via: 'direct', now: old });
    loc.record({ peerId: dev.peerId, userId: dora, value: { lat: 2, lng: 2, accuracy: null, altitude: null, provider: null, capturedAt: Date.now() }, via: 'direct' });
    assert.equal(loc.history(dev.peerId).length, 1, 'history hides expired rows');
    assert.equal(loc.purgeExpired(), 1);
    require('../src/services/users').remove(dora);
    assert.equal(H.db().prepare('SELECT COUNT(*) AS c FROM device_locations WHERE peer_id = ?').get(dev.peerId).c, 0);
  });
});

describe('admin API and pages', () => {
  let erik; let phone; let router;
  before(async () => {
    erik = H.makeUser('loc-erik');
    phone = H.makeDevice(erik, { name: 'loc-phone' });
    // A peer without an app (router config) owned by erik.
    router = Number(H.db().prepare("INSERT INTO peers (name, public_key, allowed_ips, enabled, peer_type, user_id) VALUES ('loc-router', ?, '10.8.0.240/32', 1, 'regular', ?)")
      .run(crypto.randomBytes(16).toString('base64'), erik).lastInsertRowid);
    await report(phone, FIX).expect(200);
  });

  it('lists devices with the last location', async () => {
    const r = await agent.get(`/api/v1/users/${erik}/devices`).expect(200);
    assert.equal(r.body.location.allowed, true);
    const p = r.body.devices.find((d) => d.peer && d.peer.id === phone.peerId);
    assert.equal(p.app, true);
    assert.equal(p.location.lat, FIX.lat);
    const rt = r.body.devices.find((d) => d.peer && d.peer.id === router);
    assert.equal(rt.app, false);
    assert.equal(rt.location, null);
  });

  it('device detail with history; foreign devices are 404', async () => {
    const r = await agent.get(`/api/v1/users/${erik}/devices/${phone.peerId}`).expect(200);
    assert.equal(r.body.device.locations.length, 1);
    assert.equal(r.body.device.token.id, phone.tokenId);
    assert.equal(r.body.user.id, erik);
    await agent.get(`/api/v1/users/${anna}/devices/${phone.peerId}`).expect(404);
    await agent.get(`/api/v1/users/${erik}/devices/999999`).expect(404);
  });

  it('allow switch: validation, effect on the app, activity', async () => {
    await agent.put(`/api/v1/users/${erik}/location-sharing`).set('X-CSRF-Token', getCsrf()).send({ enabled: 'no' }).expect(400);
    const r = await agent.put(`/api/v1/users/${erik}/location-sharing`).set('X-CSRF-Token', getCsrf()).send({ enabled: false }).expect(200);
    assert.equal(r.body.user.location_sharing, 0);
    await report(phone, FIX).expect(403);
    await agent.put(`/api/v1/users/${erik}/location-sharing`).set('X-CSRF-Token', getCsrf()).send({ enabled: true }).expect(200);
    await report(phone, FIX).expect(200);
    assert.ok(H.db().prepare("SELECT 1 FROM activity_log WHERE event_type = 'user_location_sharing_changed'").get());
  });

  it('admin deletes the locations of a device', async () => {
    const r = await agent.delete(`/api/v1/users/${erik}/devices/${phone.peerId}/locations`).set('X-CSRF-Token', getCsrf()).expect(200);
    assert.ok(r.body.deleted >= 1);
    assert.equal(H.db().prepare('SELECT COUNT(*) AS c FROM device_locations WHERE peer_id = ?').get(phone.peerId).c, 0);
    await agent.delete(`/api/v1/users/${anna}/devices/${phone.peerId}/locations`).set('X-CSRF-Token', getCsrf()).expect(404);
  });

  it('a token cannot use the admin endpoints', async () => {
    const full = H.makeDevice(adminId, { name: 'loc-full', scopes: ['full-access'] });
    const r = await supertest(app).get(`/api/v1/users/${erik}/devices`).set('X-API-Token', full.raw);
    assert.ok(r.status === 401 || r.status === 403);
  });

  it('profile page renders with its island and script', async () => {
    const r = await agent.get(`/users/${erik}`).expect(200);
    assert.match(r.text, /id="up-page"/);
    assert.match(r.text, /id="up-i18n"/);
    assert.match(r.text, /\/js\/user-profile\.js/);
    assert.doesNotMatch(r.text, /tile\.openstreetmap\.org/);
    assert.doesNotMatch(r.headers['content-security-policy'], /openstreetmap/);
  });

  it('device page allows OSM tiles in img-src only there', async () => {
    const r = await agent.get(`/users/${erik}/devices/${phone.peerId}`).expect(200);
    assert.match(r.text, /id="ud-page"/);
    assert.match(r.text, /\/vendor\/leaflet\/leaflet\.js/);
    const csp = r.headers['content-security-policy'];
    assert.match(csp, /img-src [^;]*https:\/\/tile\.openstreetmap\.org/);
    assert.doesNotMatch(csp, /script-src [^;]*openstreetmap/);
    assert.doesNotMatch(csp, /connect-src [^;]*openstreetmap/);
  });

  it('unknown user / foreign device redirect', async () => {
    await agent.get('/users/999999').expect(302).expect('Location', '/users');
    await agent.get(`/users/${anna}/devices/${phone.peerId}`).expect(302).expect('Location', `/users/${anna}`);
    await agent.get('/users/abc').expect(302);
  });
});
