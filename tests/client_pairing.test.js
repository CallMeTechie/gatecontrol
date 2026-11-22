'use strict';

// Pairing of GateControl TV with a signed-in phone, from anywhere
// (services/clientPairing.js, routes/api/client/pair.js, POST /api/v1/me/pair/approve):
// start → approve (phone token or browser session) → poll → setup code → POST /api/v1/client/enroll;
// the QR id alone is worth nothing, single use, 10 minutes, lockouts, permission, audit log,
// and the TV shows as a TV client.

const crypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const { setup, teardown } = require('./helpers/setup');

let app, agent, csrf;
before(async () => { ({ app, agent, csrfToken: csrf } = await setup()); });
after(() => teardown());

const db = () => require('../src/db/connection').getDb();
const pairing = () => require('../src/services/clientPairing');
const tokens = () => require('../src/services/tokens');

function makeUser(username, { selfEnroll = 1, enabled = 1 } = {}) {
  return Number(db().prepare("INSERT INTO users (username, password_hash, role, enabled, self_service_enabled, self_enroll_enabled) VALUES (?, '!', 'user', ?, 0, ?)")
    .run(username, enabled, selfEnroll).lastInsertRowid);
}
function phoneToken(userId, scopes = ['client']) {
  return tokens().create({ name: `Phone ${userId}`, scopes, userId }, '127.0.0.1').rawToken;
}
const start = (body = {}) => supertest(app).post('/api/v1/client/pair/start').send({ name: 'Fire TV', platform: 'android-tv', clientVersion: '1.0.0', ...body });
const poll = (body) => supertest(app).post('/api/v1/client/pair/poll').send(body);
const approve = (token, body) => supertest(app).post('/api/v1/client/pair/approve').set('Authorization', `Bearer ${token}`).send(body);
const events = (type) => db().prepare('SELECT message, details FROM activity_log WHERE event_type = ? ORDER BY id').all(type);
const nextPoll = (id) => { const p = pairing()._pairings.get(id); if (p) p.lastPollAt = 0; };

beforeEach(() => pairing()._resetForTest());

describe('POST /api/v1/client/pair/start', () => {
  it('answers without a token: id, poll secret, display code, 10 minutes, the QR link without secrets', async () => {
    const r = await start().expect(201);
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.match(r.body.pairingId, /^[A-Za-z0-9_-]{22}$/);
    assert.match(r.body.pollSecret, /^[A-Za-z0-9_-]{43}$/);
    assert.match(r.body.code, /^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
    assert.equal(r.body.interval, 5);
    const left = r.body.expiresAt - Date.now();
    assert.ok(left > 9 * 60 * 1000 && left <= 10 * 60 * 1000);
    assert.match(r.body.link, /^gatecontrol:\/\/tv-pair\?url=https%3A%2F%2F[^&]+&id=[A-Za-z0-9_-]{22}$/);
    assert.ok(r.body.link.endsWith(`id=${r.body.pairingId}`));
    assert.ok(!r.body.link.includes(r.body.code.replace('-', '')) && !r.body.link.includes(r.body.pollSecret));
    // only hashes are kept
    const kept = JSON.stringify([...pairing()._pairings.values()]);
    assert.ok(!kept.includes(r.body.pollSecret) && !kept.includes(r.body.code.replace('-', '')));
    // anyone may start: not in the activity log (that gets the approval)
    assert.equal(events('client_pair_started').length, 0);
  });
});

describe('pairing end to end', () => {
  it('phone approves with the code, the TV polls once, redeems the setup code and is a TV client', async () => {
    const owner = makeUser('pair-owner');
    const tok = phoneToken(owner);
    const s = (await start().expect(201)).body;
    // pending
    const p1 = await poll({ pairingId: s.pairingId, pollSecret: s.pollSecret }).expect(200);
    assert.deepEqual({ status: p1.body.status, interval: p1.body.interval }, { status: 'pending', interval: 5 });
    // too fast
    const fast = await poll({ pairingId: s.pairingId, pollSecret: s.pollSecret }).expect(429);
    assert.equal(fast.body.error, 'slow_down');
    // approve: QR id + typed code (lower case, without dash), own name
    const a = await approve(tok, { pairingId: s.pairingId, code: s.code.replace('-', '').toLowerCase(), name: 'Wohnzimmer TV' }).expect(200);
    assert.deepEqual(a.body, { ok: true, name: 'Wohnzimmer TV', platform: 'android-tv', clientVersion: '1.0.0' });
    // the same code again: spent
    assert.equal((await approve(tok, { code: s.code })).body.error, 'invalid_code');
    nextPoll(s.pairingId);
    const p2 = await poll({ pairingId: s.pairingId, pollSecret: s.pollSecret }).expect(200);
    assert.equal(p2.body.status, 'approved');
    assert.equal(p2.body.name, 'Wohnzimmer TV');
    assert.match(p2.body.code, /^[A-F0-9]{4}(-[A-F0-9]{4}){3}$/);
    // once only
    nextPoll(s.pairingId);
    assert.equal((await poll({ pairingId: s.pairingId, pollSecret: s.pollSecret }).expect(400)).body.error, 'invalid_or_expired');
    // the setup code belongs to the approving account, app scopes only
    const row = db().prepare('SELECT user_id, peer_id, scopes FROM client_enrollment_codes WHERE code_hash = ?').get(crypto.createHash('sha256').update(p2.body.code).digest('hex'));
    assert.equal(row.user_id, owner);
    assert.equal(row.peer_id, null);
    assert.ok(!JSON.parse(row.scopes).includes('full-access'));
    // the TV redeems it like every app
    const e = await supertest(app).post('/api/v1/client/enroll')
      .send({ code: p2.body.code, hostname: 'Wohnzimmer-TV', platform: 'android-tv', clientVersion: '1.0.0' }).expect(200);
    const peer = db().prepare('SELECT name, description, tags, user_id FROM peers WHERE id = ?').get(e.body.peerId);
    assert.equal(peer.user_id, owner);
    assert.match(peer.description, /^TV Client \(android-tv, v1\.0\.0\)$/);
    assert.equal(peer.tags, 'tv-client');
    // audit trail
    assert.equal(events('client_pair_approved').length, 1);
    assert.match(events('client_pair_approved')[0].message, /approved the TV "Wohnzimmer TV"/);
    assert.equal(events('client_pair_completed').length, 1);
    // never the code or the secret in the log
    const all = JSON.stringify(db().prepare("SELECT message, details FROM activity_log WHERE event_type LIKE 'client_pair_%'").all());
    assert.ok(!all.includes(s.pollSecret) && !all.includes(s.code) && !all.includes(s.pairingId));
  });

  it('the code alone (typed in the portal) is enough; the QR id alone is not', async () => {
    const owner = makeUser('pair-codeonly');
    const tok = phoneToken(owner);
    const s = (await start().expect(201)).body;
    assert.equal((await approve(tok, { pairingId: s.pairingId }).expect(400)).body.error, 'invalid_code');
    assert.equal((await approve(tok, { pairingId: s.pairingId, code: 'AAAA-AAAA' })).body.error, 'invalid_code');
    // a wrong secret is the same answer as an unknown id
    const bad = await poll({ pairingId: s.pairingId, pollSecret: crypto.randomBytes(32).toString('base64url') }).expect(400);
    assert.equal(bad.body.error, 'invalid_or_expired');
    await approve(tok, { code: s.code }).expect(200);
  });

  it('browser session: POST /api/v1/me/pair/approve (CSRF), no name → the TV\'s own', async () => {
    const s = (await start({ name: 'Fire TV Kueche' }).expect(201)).body;
    await agent.post('/api/v1/me/pair/approve').send({ code: s.code }).expect(403);
    const r = await agent.post('/api/v1/me/pair/approve').set('X-CSRF-Token', csrf).send({ code: s.code }).expect(200);
    assert.equal(r.body.name, 'Fire TV Kueche');
    assert.match(events('client_pair_approved').pop().details, /"via":"web"/);
    // the phone route does not take a session
    const s2 = (await start().expect(201)).body;
    const t = await agent.post('/api/v1/client/pair/approve').set('X-CSRF-Token', csrf).send({ code: s2.code }).expect(403);
    assert.equal(t.body.error, 'token_required');
  });
});

describe('who may approve', () => {
  it('not without a token, not without the permission, not for a disabled account, not with a token of no account', async () => {
    const s = (await start().expect(201)).body;
    await supertest(app).post('/api/v1/client/pair/approve').send({ code: s.code }).expect(401);
    const noPerm = makeUser('pair-noperm', { selfEnroll: 0 });
    assert.equal((await approve(phoneToken(noPerm), { code: s.code }).expect(403)).body.error, 'enroll_not_allowed');
    const orphan = tokens().create({ name: 'script', scopes: ['client'] }, '127.0.0.1').rawToken;
    assert.equal((await approve(orphan, { code: s.code }).expect(403)).body.error, 'enroll_not_allowed');
    // a token without the client scope never reaches the route
    const other = makeUser('pair-logs');
    await approve(phoneToken(other, ['logs']), { code: s.code }).expect(403);
    const off = makeUser('pair-off');
    const offTok = phoneToken(off);
    db().prepare('UPDATE users SET enabled = 0 WHERE id = ?').run(off);
    await approve(offTok, { code: s.code }).expect(403);
    // still pending
    assert.equal(pairing()._pairings.get(s.pairingId).status, 'pending');
  });

  it('the account is checked again when the TV collects the code', async () => {
    const owner = makeUser('pair-later-off');
    const s = (await start().expect(201)).body;
    await approve(phoneToken(owner), { code: s.code }).expect(200);
    db().prepare('UPDATE users SET self_enroll_enabled = 0 WHERE id = ?').run(owner);
    const r = await poll({ pairingId: s.pairingId, pollSecret: s.pollSecret }).expect(403);
    assert.equal(r.body.error, 'enroll_not_allowed');
  });
});

describe('limits', () => {
  it('a pairing is locked after 5 wrong codes with its id; the TV starts over', async () => {
    const owner = makeUser('pair-wrong');
    const tok = phoneToken(owner);
    const s = (await start().expect(201)).body;
    for (let i = 0; i < 5; i++) await approve(tok, { pairingId: s.pairingId, code: 'ZZZZ-ZZZZ' }).expect(400);
    assert.equal((await approve(tok, { pairingId: s.pairingId, code: s.code }).expect(400)).body.error, 'invalid_code');
    assert.equal((await poll({ pairingId: s.pairingId, pollSecret: s.pollSecret }).expect(400)).body.error, 'invalid_or_expired');
    assert.equal(events('client_pair_locked').length >= 1, true);
  });

  it('an account is locked after 10 wrong codes (Retry-After), a right code before resets the count', () => {
    const P = pairing();
    const user = { id: 990001, username: 'lock-test', enabled: 1, role: 'admin' };
    const now = Date.now();
    for (let i = 0; i < 9; i++) assert.throws(() => P.approve(user, { code: 'ZZZZ-ZZZZ' }, null, now), { code: 'invalid_code' });
    const ok = P.start({}, null, now);
    P.approve(user, { code: ok.code }, null, now);
    for (let i = 0; i < 10; i++) assert.throws(() => P.approve(user, { code: 'ZZZZ-ZZZZ' }, null, now), { code: 'invalid_code' });
    const s = P.start({}, null, now);
    assert.throws(() => P.approve(user, { code: s.code }, null, now), (e) => e.code === 'locked' && e.retryAfter === 15 * 60);
    // after the lock time it works again (with a new pairing: the old one ran out meanwhile)
    const later = now + P.USER_LOCK_MS + 1000;
    const s2 = P.start({}, null, later);
    assert.equal(P.approve(user, { code: s2.code }, null, later).name, 'TV');
  });

  it('expires after 10 minutes, unapproved or approved', () => {
    const P = pairing();
    const user = { id: 990002, username: 'expiry-test', enabled: 1, role: 'admin' };
    const now = Date.now();
    const a = P.start({}, null, now);
    assert.throws(() => P.approve(user, { code: a.code }, null, now + P.TTL_MS + 1), { code: 'invalid_code' });
    const b = P.start({}, null, now);
    P.approve(user, { code: b.code }, null, now + 1000);
    assert.throws(() => P.poll({ pairingId: b.pairingId, pollSecret: b.pollSecret }, null, now + P.TTL_MS + 1), { code: 'invalid_or_expired' });
  });

  it('codes: no confusable characters, typed forms accepted', () => {
    const P = pairing();
    assert.ok(!/[01IOL]/.test(P.ALPHABET));
    assert.equal(P.normalizeCode('abcd efgh'), 'ABCDEFGH');
    assert.equal(P.normalizeCode('ABCD-EFGH'), 'ABCDEFGH');
    assert.equal(P.normalizeCode('ABCD-EFG0'), null);
    assert.equal(P.normalizeCode('ABC'), null);
    assert.equal(P.normalizeCode(42), null);
  });

  it('malformed polls are invalid, never a 500', async () => {
    for (const body of [{}, { pairingId: 'x', pollSecret: 'y' }, { pairingId: ['a'], pollSecret: {} }]) {
      assert.equal((await poll(body).expect(400)).body.error, 'invalid_or_expired');
    }
  });
});

describe('GateControl TV as a client of its own', () => {
  it('the version report keeps product and platform android-tv; it compares with the Android release', async () => {
    const cu = require('../src/services/clientUpdates');
    const peer = await require('../src/services/peers').create({ name: 'tv-version' });
    assert.equal(cu.recordClientVersion(peer.id, { version: '1.90.0', platform: 'android-tv' }), true);
    const row = db().prepare('SELECT client_product, client_platform, client_version FROM peers WHERE id = ?').get(peer.id);
    assert.deepEqual({ ...row }, { client_product: 'android-tv', client_platform: 'android-tv', client_version: '1.90.0' });
    assert.ok(cu.PRODUCTS.includes('android-tv'));
    assert.equal(cu.releaseProductOf('android-tv'), 'android');
    assert.equal(cu.releaseProductOf('pro'), 'pro');
    const overview = cu.getOverview();
    assert.ok(overview.products.some((p) => p.product === 'android-tv' && p.total >= 1));
  });

  it('labels: TV Client for the peer, an Android device for plugins and the push stream', () => {
    const enr = require('../src/services/clientEnrollment');
    assert.equal(enr._clientLabel('android-tv', '1.2.3'), 'TV Client (android-tv, v1.2.3)');
    assert.equal(enr._clientLabel('android', '1.2.3'), 'Android Client (android, v1.2.3)');
    assert.equal(require('../src/routes/api/client/helpers').clientLabel('android-tv'), 'TV Client');
    assert.equal(require('../src/services/plugins/devices').platformOf('android-tv'), 'android');
  });
});
