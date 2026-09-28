'use strict';

// One-scan Android app setup: admin issues a setup code (POST
// /api/v1/enrollment), the app redeems it (POST /api/v1/client/enroll) and
// receives a token bound to the peer plus the WireGuard config.

const nodeCrypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || nodeCrypto.randomBytes(32).toString('hex');

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const { setup, teardown } = require('./helpers/setup');

let agent, csrf, app, peers, tokens, users, enrollment, db;

before(async () => {
  const ctx = await setup();
  agent = ctx.agent;
  csrf = ctx.csrfToken;
  app = ctx.app;
  peers = require('../src/services/peers');
  tokens = require('../src/services/tokens');
  users = require('../src/services/users');
  enrollment = require('../src/services/clientEnrollment');
  db = require('../src/db/connection').getDb();
});
after(() => teardown());

// The app has no session and no token — redeem runs against the bare app.
const redeem = (body, headers = {}) => supertest(app)
  .post('/api/v1/client/enroll')
  .set(headers)
  .send({ hostname: 'Pixel 9', platform: 'android', clientVersion: '1.10.0', ...body });

const issue = (body) => agent.post('/api/v1/enrollment').set('X-CSRF-Token', csrf).send(body);

describe('client enrollment — admin issues a code', () => {
  it('returns code, deep link and QR for a peer; stores only the hash', async () => {
    const peer = await peers.create({ name: 'enroll-issue' });
    const res = await issue({ peerId: peer.id });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.match(res.body.code, /^[A-F0-9]{4}(-[A-F0-9]{4}){3}$/);
    assert.match(res.body.link, /^gatecontrol:\/\/enroll\?url=https%3A%2F%2F.+&code=[A-F0-9-]{19}$/);
    assert.match(res.body.qr, /^data:image\/png;base64,/);
    assert.ok(res.body.expiresAt > Date.now());
    assert.ok(res.body.scopes.includes('client'));

    const rows = db.prepare('SELECT code_hash FROM client_enrollment_codes WHERE peer_id = ?').all(peer.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].code_hash, nodeCrypto.createHash('sha256').update(res.body.code).digest('hex'));
  });

  it('is not reachable with an API token', async () => {
    const t = tokens.create({ name: 'full', scopes: ['full-access'] }, '127.0.0.1');
    const res = await supertest(app).post('/api/v1/enrollment')
      .set('X-API-Token', t.rawToken).send({ peerId: 1 });
    assert.equal(res.status, 403);
  });

  it('rejects gateway peers and requests without a target', async () => {
    assert.equal((await issue({})).status, 400);
    assert.equal((await issue({ peerId: 999999 })).status, 404);
  });

  it('never grants admin scopes, even when asked', () => {
    const scopes = enrollment.resolveScopes(['full-access', 'peers', 'client:rdp'], null);
    assert.deepEqual(scopes.sort(), ['client', 'client:rdp']);
  });

  it('caps scopes by the owner role', async () => {
    const u = await users.create({ username: 'enroll-user', role: 'user', password: 'Secret123!x' });
    const scopes = enrollment.resolveScopes(undefined, u.id);
    assert.ok(scopes.includes('client:rdp'));
    assert.ok(!scopes.includes('pihole'), 'role user may not get pihole');
  });
});

describe('client enrollment — app redeems the code', () => {
  it('returns a token bound to the peer that works on peer-scoped endpoints', async () => {
    const peer = await peers.create({ name: 'enroll-redeem' });
    const { code } = enrollment.createCode({ peerId: peer.id });

    const res = await redeem({ code });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.peerId, peer.id);
    assert.match(res.body.token, /^gc_/);
    assert.match(res.body.config, /\[Interface\]/);
    assert.equal(res.body.hash, nodeCrypto.createHash('sha256').update(res.body.config).digest('hex'));

    const row = tokens.authenticate(res.body.token);
    assert.equal(row.peer_id, peer.id);

    // Peer-scoped call works right away — the gap the manual token left open.
    const info = await supertest(app).get(`/api/v1/client/peer-info?peerId=${peer.id}`)
      .set('X-API-Token', res.body.token);
    assert.equal(info.status, 200);
    assert.equal(info.body.peer.id, peer.id);
  });

  it('accepts a hand-typed code (lower case, no dashes)', async () => {
    const peer = await peers.create({ name: 'enroll-typed' });
    const { code } = enrollment.createCode({ peerId: peer.id });
    const typed = code.replace(/-/g, '').toLowerCase();
    const res = await redeem({ code: ` ${typed} ` });
    assert.equal(res.status, 200, JSON.stringify(res.body));
  });

  it('a code works once', async () => {
    const peer = await peers.create({ name: 'enroll-once' });
    const { code } = enrollment.createCode({ peerId: peer.id });
    assert.equal((await redeem({ code })).status, 200);
    const again = await redeem({ code });
    assert.equal(again.status, 400);
    assert.equal(again.body.error, 'invalid_or_expired');
  });

  it('an expired or regenerated code is rejected', async () => {
    const peer = await peers.create({ name: 'enroll-expired' });
    const first = enrollment.createCode({ peerId: peer.id });
    const second = enrollment.createCode({ peerId: peer.id });
    assert.equal((await redeem({ code: first.code })).status, 400, 'regenerate revokes the old code');

    db.prepare('UPDATE client_enrollment_codes SET expires_at = ? WHERE peer_id = ?').run(Date.now() - 1, peer.id);
    assert.equal((await redeem({ code: second.code })).status, 400);
  });

  it('re-enrolling a peer revokes the previous app token but keeps manual tokens', async () => {
    const peer = await peers.create({ name: 'enroll-reenroll' });
    const manual = tokens.create({ name: 'manual', scopes: ['client'], peerId: peer.id }, '127.0.0.1');

    const first = await redeem({ code: enrollment.createCode({ peerId: peer.id }).code });
    const second = await redeem({ code: enrollment.createCode({ peerId: peer.id }).code });
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);

    assert.equal(tokens.authenticate(first.body.token), null, 'old app token revoked');
    assert.ok(tokens.authenticate(second.body.token), 'new app token valid');
    assert.ok(tokens.authenticate(manual.rawToken), 'manual token untouched');
  });

  it('a user-level code creates a new peer owned by the user', async () => {
    const u = await users.create({ username: 'enroll-owner', role: 'user', password: 'Secret123!x' });
    const { code } = enrollment.createCode({ userId: u.id });
    const res = await redeem({ code, hostname: 'Galaxy S25' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const peer = peers.getById(res.body.peerId);
    assert.equal(peer.user_id, u.id);
    assert.equal(peer.name, 'Galaxy_S25');
    assert.equal(tokens.authenticate(res.body.token).user_id, u.id);
  });

  it('a failed redeem hands the code back and leaves no token behind', async () => {
    const u = await users.create({ username: 'enroll-disabled', role: 'user', password: 'Secret123!x' });
    const peer = await peers.create({ name: 'enroll-disabled-peer', userId: u.id });
    const { code } = enrollment.createCode({ peerId: peer.id });
    users.toggle(u.id);

    const res = await redeem({ code });
    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'user_disabled');
    assert.equal(db.prepare('SELECT COUNT(*) c FROM api_tokens WHERE peer_id = ?').get(peer.id).c, 0);

    users.toggle(u.id);
    assert.equal((await redeem({ code })).status, 200, 'code is still usable');
  });

  it('rejects garbage without touching the database', async () => {
    const res = await redeem({ code: 'not-a-code' });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'invalid_or_expired');
  });
});

describe('client enrollment — token codes (wizard, scripts, Windows)', () => {
  const issueToken = (body) => issue({ kind: 'token', ...body });

  it('a token code carries any scope, including full-access, and mints on redeem', async () => {
    const res = await issueToken({ name: 'Home Assistant', scopes: ['full-access'], userId: 1 });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.deepEqual(res.body.scopes, ['full-access']);
    assert.match(res.body.link, /^gatecontrol:\/\/enroll\?/);

    const before = db.prepare("SELECT COUNT(*) c FROM api_tokens WHERE name = 'Home Assistant'").get().c;
    assert.equal(before, 0, 'nothing is minted before redeem');

    const red = await supertest(app).post('/api/v1/client/enroll').send({ code: res.body.code });
    assert.equal(red.status, 200, JSON.stringify(red.body));
    assert.equal(red.body.kind, 'token');
    assert.equal(red.body.peerId, null);
    assert.equal(red.body.config, null);
    const row = tokens.authenticate(red.body.token);
    assert.deepEqual(row.scopes, ['full-access']);
    assert.equal(row.name, 'Home Assistant');
    assert.equal(row.user_id, 1);
    // A script can use it right away.
    const peersRes = await supertest(app).get('/api/v1/peers').set('X-API-Token', red.body.token);
    assert.equal(peersRes.status, 200);
  });

  it('keeps expiry, peer binding and split-tunnel preset of the wizard', async () => {
    const peer = await peers.create({ name: 'enroll-token-peer' });
    const expires = new Date(Date.now() + 30 * 86400000).toISOString();
    const res = await issueToken({
      name: 'Laptop', scopes: ['client', 'client:rdp'], userId: 1, peer_id: peer.id,
      expires_at: expires, split_tunnel_override: { mode: 'exclude', networks: [{ cidr: '192.168.0.0/16', label: 'LAN' }], locked: true },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const red = await supertest(app).post('/api/v1/client/enroll').send({ code: res.body.code });
    assert.equal(red.status, 200, JSON.stringify(red.body));
    assert.equal(red.body.peerId, peer.id);
    assert.match(red.body.config, /\[Interface\]/);
    const row = tokens.getById(tokens.authenticate(red.body.token).id);
    assert.equal(row.peer_id, peer.id);
    assert.equal(new Date(row.expires_at).toISOString(), expires);
    assert.equal(JSON.parse(row.split_tunnel_override).mode, 'exclude');
  });

  it('a Windows client registers with an unbound token after redeeming', async () => {
    const res = await issueToken({ name: 'Desktop', scopes: ['client'], userId: 1 });
    const red = await supertest(app).post('/api/v1/client/enroll').send({ code: res.body.code });
    const reg = await supertest(app).post('/api/v1/client/register')
      .set('X-API-Token', red.body.token).set('X-Client-Platform', 'windows')
      .send({ hostname: 'DESKTOP-42', platform: 'win32 10.0', clientVersion: '1.21.0' });
    assert.equal(reg.status, 201, JSON.stringify(reg.body));
    assert.equal(tokens.authenticate(red.body.token).peer_id, reg.body.peerId);
  });

  it('role user cannot receive admin scopes through a code', async () => {
    const u = await users.create({ username: 'enroll-token-user', role: 'user', password: 'Secret123!x' });
    const res = await issueToken({ name: 'x', scopes: ['full-access'], userId: u.id });
    assert.equal(res.status, 400);
  });

  it('validates name, scopes, expiry and split-tunnel preset', async () => {
    assert.equal((await issueToken({ scopes: ['client'], userId: 1 })).status, 400);
    assert.equal((await issueToken({ name: 'x', scopes: ['nope'], userId: 1 })).status, 400);
    assert.equal((await issueToken({ name: 'x', scopes: ['client'], userId: 1, expires_at: '2000-01-01T00:00:00Z' })).status, 400);
    assert.equal((await issueToken({ name: 'x', scopes: ['client'], userId: 1, split_tunnel_override: { mode: 'bogus' } })).status, 400);
  });

  it('redeeming a token code does not revoke app tokens of a peer', async () => {
    const peer = await peers.create({ name: 'enroll-token-mixed' });
    const app1 = await redeem({ code: enrollment.createCode({ peerId: peer.id }).code });
    const res = await issueToken({ name: 'script-on-peer', scopes: ['client'], userId: 1, peer_id: peer.id });
    await supertest(app).post('/api/v1/client/enroll').send({ code: res.body.code });
    assert.ok(tokens.authenticate(app1.body.token), 'app token survives');
  });
});
