'use strict';

// Portal redesign: one-time login link of the apps (POST /api/v1/client/portal-link
// + GET /auto), device-owner recognition (default on, kill switch), shared
// devices with "Wer bist du?" + portal PIN (lockout, admin reset), anonymous
// mode, /me → portal, portal-only sessions never reaching the admin UI,
// device_usage on the access (admin only) and templates without raw keys.

const crypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const { describe, it, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const argon2 = require('argon2');
const { setup, teardown } = require('./helpers/setup');
const { withoutScripts } = require('./helpers/html');
const config = require('../config/default');

const HOME = `home.${config.dns.domain}`;
const PW = 'Plain!Pass1234';
let app, agent, csrf;
before(async () => { ({ app, agent, csrfToken: csrf } = await setup()); });
after(() => teardown());

const db = () => require('../src/db/connection').getDb();
const tokens = () => require('../src/services/tokens');
const settings = () => require('../src/services/settings');

let ipSeq = 10;
async function makeUser(username, { role = 'user', selfService = false, displayName = null, pin = null } = {}) {
  const hash = role === 'admin' || selfService ? await argon2.hash(PW, require('../src/utils/argon2Options')) : '!';
  const id = Number(db().prepare('INSERT INTO users (username, password_hash, role, self_service_enabled, display_name) VALUES (?, ?, ?, ?, ?)')
    .run(username, hash, role, selfService ? 1 : 0, displayName).lastInsertRowid);
  if (pin) await require('../src/services/portalPin').setPin(id, pin);
  return id;
}
function device(name, owner, { scopes = ['client'], usage = 'single', users = [] } = {}) {
  const ip = `10.8.1.${ipSeq++}`;
  const peerId = Number(db().prepare("INSERT INTO peers (name, public_key, allowed_ips, enabled, peer_type, user_id) VALUES (?, ?, ?, 1, 'regular', ?)")
    .run(name, crypto.randomBytes(16).toString('base64'), ip + '/32', owner).lastInsertRowid);
  const t = tokens().create({ name, scopes, userId: owner, peerId }, '127.0.0.1');
  if (usage !== 'single' || users.length) require('../src/services/portalDevices').setUsage(t.token.id, { usage, userIds: users });
  return { ip, peerId, tokenId: t.token.id, raw: t.rawToken };
}
function portalAgent(ip) {
  const a = supertest.agent(app);
  return {
    a,
    get: (p) => a.get(p).set('Host', HOME).set('X-GC-Portal-Peer-IP', ip),
    post: (p) => a.post(p).set('Host', HOME).set('X-GC-Portal-Peer-IP', ip),
    del: (p) => a.delete(p).set('Host', HOME).set('X-GC-Portal-Peer-IP', ip),
  };
}
function link(dev, headers = {}) {
  const req = supertest(app).post('/api/v1/client/portal-link').set('Authorization', `Bearer ${dev.raw}`);
  for (const [k, v] of Object.entries(headers)) req.set(k, v);
  return req.send({});
}
function ticketOf(url) { return new URL(url).searchParams.get('t'); }
function ctxOf(html) { return JSON.parse(html.match(/id="portal-ctx"[^>]*>([^<]*)</)[1]); }
async function loginAs(username, password = PW) {
  const a = supertest.agent(app);
  const page = await a.get('/login').expect(200);
  const c = page.text.match(/name="_csrf"\s+value="([^"]+)"/)[1];
  const res = await a.post('/login').type('form').send({ username, password, _csrf: c }).expect(302);
  return { a, location: res.headers.location };
}

// ─── POST /api/v1/client/portal-link ─────────────────────────────────

describe('portal-link (client API)', () => {
  let anna, dev;
  before(async () => { anna = await makeUser('pl-anna', { displayName: 'Anna Link' }); dev = device('pl-phone', anna); });

  it('returns the fixed contract and stores only the hash', async () => {
    const res = await link(dev).expect(200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.expiresIn, 60);
    assert.ok(res.body.url.startsWith(`https://${HOME}/auto?t=`), res.body.url);
    assert.match(ticketOf(res.body.url), /^[A-Za-z0-9_-]{43}$/);
    assert.equal(res.headers['cache-control'], 'no-store');
    const t = ticketOf(res.body.url);
    const row = db().prepare('SELECT * FROM portal_tickets WHERE ticket_hash = ?').get(crypto.createHash('sha256').update(t).digest('hex'));
    assert.ok(row);
    assert.equal(row.peer_id, dev.peerId);
    assert.equal(row.user_id, anna);
    assert.equal(row.token_id, dev.tokenId);
    assert.equal(db().prepare('SELECT COUNT(*) AS c FROM portal_tickets WHERE ticket_hash = ?').get(t).c, 0);
    assert.ok(row.expires_at - Date.now() <= 60000 && row.expires_at - Date.now() > 50000);
  });

  it('needs a token with the client scope (a browser session is refused)', async () => {
    const other = device('pl-noclient', anna, { scopes: ['peers'] });
    const res = await link(other);
    assert.equal(res.status, 403);
    const sess = await agent.post('/api/v1/client/portal-link').set('X-CSRF-Token', csrf).send({});
    assert.equal(sess.status, 403);
    await supertest(app).post('/api/v1/client/portal-link').send({}).expect(401);
  });

  it('answers 404 portal_disabled when the portal is off', async () => {
    settings().set('portal.enabled', '0');
    try {
      const res = await link(dev).expect(404);
      assert.deepEqual(res.body, { ok: false, error: 'portal_disabled' });
    } finally { settings().set('portal.enabled', '1'); }
  });

  it('enforces the machine binding', async () => {
    const m = mock.method(tokens(), 'machineBindingState', () => ({ licensed: true, mode: 'global' }));
    try {
      const fp = 'a'.repeat(64);
      tokens().bindMachineFingerprint(dev.tokenId, fp);
      await link(dev).expect(403);
      await link(dev, { 'X-Machine-Fingerprint': 'b'.repeat(64) }).expect(403);
      await link(dev, { 'X-Machine-Fingerprint': fp }).expect(200);
    } finally {
      m.mock.restore();
      tokens().resetMachineBinding(dev.tokenId);
    }
  });

  it('a token without a peer gets 409 not_registered', async () => {
    const raw = tokens().create({ name: 'loose', scopes: ['client'], userId: anna }, '127.0.0.1').rawToken;
    const res = await supertest(app).post('/api/v1/client/portal-link').set('Authorization', `Bearer ${raw}`).send({}).expect(409);
    assert.equal(res.body.error, 'not_registered');
  });
});

// ─── GET /auto ───────────────────────────────────────────────────────

describe('automatic login with the link', () => {
  let anna, dev;
  before(async () => { anna = await makeUser('auto-anna', { displayName: 'Anna Auto' }); dev = device('auto-phone', anna); });

  it('single-person device: signs the owner in (portal-only session) and drops the ticket from the URL', async () => {
    const t = ticketOf((await link(dev)).body.url);
    const p = portalAgent(dev.ip);
    const res = await p.get('/auto?t=' + t).expect(302);
    assert.equal(res.headers.location, '/portal');
    assert.equal(res.headers['referrer-policy'], 'no-referrer');
    assert.ok(res.headers['set-cookie']);
    const page = await p.get('/portal').expect(200);
    assert.ok(page.text.includes('data-via="link"'));
    assert.ok(withoutScripts(page.text).includes('Anna Auto'));
    assert.equal(ctxOf(page.text).loggedIn, true);
    assert.equal(ctxOf(page.text).tabs.devices, true);
    // The stored session is portal-only: no userId.
    const s = db().prepare("SELECT data FROM sessions WHERE json_extract(data, '$.portalUserId') = ?").get(anna);
    const data = JSON.parse(s.data);
    assert.equal(data.portalOnly, true);
    assert.equal(data.userId, undefined);
    // Own devices work for the portal session.
    const devs = await p.get('/api/v1/portal/me/devices').expect(200);
    assert.deepEqual(devs.body.devices.map((d) => d.id), [dev.tokenId]);
  });

  it('a ticket works once', async () => {
    const t = ticketOf((await link(dev)).body.url);
    await portalAgent(dev.ip).get('/auto?t=' + t).expect(302);
    const p = portalAgent(dev.ip);
    await p.get('/auto?t=' + t).expect(302);
    const page = await p.get('/portal').expect(200);
    assert.ok(page.text.includes('data-viewer="anonymous"'));
    assert.ok(page.text.includes('id="pt-note"'));
    assert.equal(ctxOf(page.text).loggedIn, false);
  });

  it('an expired ticket shows the anonymous portal', async () => {
    const t = ticketOf((await link(dev)).body.url);
    db().prepare('UPDATE portal_tickets SET expires_at = ? WHERE ticket_hash = ?').run(Date.now() - 1000, crypto.createHash('sha256').update(t).digest('hex'));
    const p = portalAgent(dev.ip);
    await p.get('/auto?t=' + t).expect(302);
    const page = await p.get('/portal').expect(200);
    assert.ok(page.text.includes('data-viewer="anonymous"'));
  });

  it('a ticket from another device is refused (and spent)', async () => {
    const other = device('auto-other', anna);
    const t = ticketOf((await link(dev)).body.url);
    const p = portalAgent(other.ip);
    await p.get('/auto?t=' + t).expect(302);
    const page = await p.get('/portal').expect(200);
    assert.ok(page.text.includes('data-viewer="anonymous"'));
    assert.ok(!db().prepare("SELECT 1 FROM sessions WHERE json_extract(data, '$.portalUserId') = ? AND json_extract(data, '$.portalPeerId') = ?").get(anna, other.peerId));
    const again = portalAgent(dev.ip);
    await again.get('/auto?t=' + t).expect(302);
    assert.ok((await again.get('/portal')).text.includes('data-viewer="anonymous"'));
  });

  it('a garbage ticket never 500s', async () => {
    for (const t of ['', 'x', 'A'.repeat(43), '../../etc', '%00']) {
      const res = await portalAgent(dev.ip).get('/auto?t=' + encodeURIComponent(t));
      assert.equal(res.status, 302);
      assert.equal(res.headers.location, '/portal');
    }
  });

  it('multi-person device: the link leads to the picker, nobody is signed in', async () => {
    const tom = await makeUser('auto-tom', { displayName: 'Tom Auto' });
    const shared = device('auto-shared', anna, { usage: 'multi', users: [tom] });
    const t = ticketOf((await link(shared)).body.url);
    const p = portalAgent(shared.ip);
    const res = await p.get('/auto?t=' + t).expect(302);
    assert.equal(res.headers.location, '/portal/who');
    const page = await p.get('/portal').expect(302);
    assert.equal(page.headers.location, '/portal/who');
  });

  it('next: the app deep-links into a portal tab, strictly validated', async () => {
    const pt = require('../src/services/portalTickets');
    const nd = device('auto-next', anna);
    // accepted forms → normalised
    for (const [raw, want] of [['/portal', '/portal'], ['/portal/', '/portal'], ['/portal#mitteilungen', '/portal#mitteilungen'],
      ['/#geraete', '/portal#geraete'], ['/portal#plg-skoda', '/portal#plg-skoda'], ['/portal#benachrichtigungen', '/portal#benachrichtigungen']]) {
      assert.equal(pt.portalNext(raw), want, raw);
    }
    // everything else is ignored
    for (const raw of ['', '/', '//evil.example', '/\\evil.example', 'https://evil.example/portal', '/portal#unknown', '/portal#Geraete',
      '/portal?x=1', '/portal/who', '/login', 'portal#start', '/portal#plg-', `/portal#${'a'.repeat(120)}`, '/portal#start#x', ' /portal', null, 42]) {
      assert.equal(pt.portalNext(raw), null, String(raw));
    }
    // portal-link: body `next` (or `path`) ends up in the URL, a bad one is dropped
    let r = await supertest(app).post('/api/v1/client/portal-link').set('Authorization', `Bearer ${nd.raw}`).send({ next: '/portal#mitteilungen' }).expect(200);
    const u = new URL(r.body.url);
    assert.equal(u.searchParams.get('next'), '/portal#mitteilungen');
    assert.match(u.searchParams.get('t'), /^[A-Za-z0-9_-]{43}$/);
    r = await supertest(app).post('/api/v1/client/portal-link').set('Authorization', `Bearer ${nd.raw}`).send({ path: '/#geraete' }).expect(200);
    assert.equal(new URL(r.body.url).searchParams.get('next'), '/portal#geraete');
    r = await supertest(app).post('/api/v1/client/portal-link').set('Authorization', `Bearer ${nd.raw}`).send({ next: '//evil.example' }).expect(200);
    assert.equal(new URL(r.body.url).searchParams.get('next'), null);
    // /auto: signs in and lands on the tab
    const p = portalAgent(nd.ip);
    let res = await p.get('/auto?t=' + ticketOf((await link(nd)).body.url) + '&next=' + encodeURIComponent('/portal#mitteilungen')).expect(302);
    assert.equal(res.headers.location, '/portal#mitteilungen');
    assert.equal(ctxOf((await p.get('/portal')).text).loggedIn, true);
    // a bad target never leaves the portal
    for (const bad of ['//evil.example', 'https://evil.example', '/\\evil.example', '/login']) {
      res = await portalAgent(nd.ip).get('/auto?t=' + ticketOf((await link(nd)).body.url) + '&next=' + encodeURIComponent(bad)).expect(302);
      assert.equal(res.headers.location, '/portal', bad);
    }
    // an invalid ticket ignores the target (anonymous portal with the note)
    res = await portalAgent(nd.ip).get('/auto?t=x&next=' + encodeURIComponent('/portal#geraete')).expect(302);
    assert.equal(res.headers.location, '/portal');
  });

  it('the portal session cannot reach admin pages or admin APIs (even of an admin)', async () => {
    const boss = await makeUser('auto-boss', { role: 'admin', displayName: 'Boss' });
    const bdev = device('boss-phone', boss);
    const p = portalAgent(bdev.ip);
    await p.get('/auto?t=' + ticketOf((await link(bdev)).body.url)).expect(302);
    assert.equal(ctxOf((await p.get('/portal')).text).loggedIn, true);
    for (const path of ['/api/v1/users', '/api/v1/tokens', '/api/v1/settings/portal', '/api/v1/me', '/api/v1/profile/2fa']) {
      const r = await p.get(path);
      assert.ok(r.status === 401 || r.status === 403, `${path}: ${r.status}`);
    }
    for (const path of ['/dashboard', '/users', '/settings', '/profile']) {
      const r = await p.get(path);
      assert.equal(r.status, 302, path);
      assert.equal(r.headers.location, '/login', path);
    }
  });
});

// ─── Device trust by VPN address ─────────────────────────────────────

describe('owner recognition by VPN address', () => {
  let anna, dev, shared;
  before(async () => {
    anna = await makeUser('trust-anna', { displayName: 'Anna Trust' });
    dev = device('trust-phone', anna);
    shared = device('trust-shared', anna, { usage: 'multi' });
  });

  it('is on by default (migration 90) and shows the owner read-only', async () => {
    assert.equal(settings().get('portal.trust_owner_mapping', '0'), '1');
    const page = await portalAgent(dev.ip).get('/portal').expect(200);
    assert.ok(page.text.includes('data-via="device"'));
    assert.equal(ctxOf(page.text).loggedIn, false);
    await portalAgent(dev.ip).get('/api/v1/portal/me/devices').expect(401);
  });

  it('the kill switch turns it off (and the link no longer signs in)', async () => {
    settings().set('portal.trust_owner_mapping', '0');
    try {
      const page = await portalAgent(dev.ip).get('/portal').expect(200);
      assert.ok(!page.text.includes('data-viewer="person"'));
      const p = portalAgent(dev.ip);
      await p.get('/auto?t=' + ticketOf((await link(dev)).body.url)).expect(302);
      assert.equal(ctxOf((await p.get('/portal')).text).loggedIn, false);
    } finally { settings().set('portal.trust_owner_mapping', '1'); }
  });

  it('a shared device never uses it', async () => {
    const res = await portalAgent(shared.ip).get('/portal').expect(302);
    assert.equal(res.headers.location, '/portal/who');
    const midea = await portalAgent(shared.ip).get('/api/v1/portal/pihole/owner').expect(200);
    assert.notEqual(midea.body.reason, undefined);
  });

  it('the migration keeps an explicit "off"', () => {
    const { migrations } = require('../src/db/migrationList');
    const m = migrations.find((x) => x.version === 90);
    assert.match(m.sql, /INSERT OR IGNORE INTO settings \(key, value\) VALUES \('portal\.trust_owner_mapping', '1'\)/);
  });
});

// ─── Shared device: picker + PIN ─────────────────────────────────────

describe('"Wer bist du?" with the portal PIN', () => {
  let owner, anna, tom, outsider, shared;
  before(async () => {
    owner = await makeUser('who-owner', { displayName: 'Marc Owner', pin: '2468' });
    anna = await makeUser('who-anna', { displayName: 'Anna Picker', pin: '1234' });
    tom = await makeUser('who-tom', { displayName: 'Tom Nopin' });
    outsider = await makeUser('who-out', { displayName: 'Otto Outside', pin: '9999' });
    shared = device('who-pc', owner, { usage: 'multi', users: [anna, tom] });
  });

  async function pickerCsrf(p) {
    const page = await p.get('/portal/who').expect(200);
    return { page, c: page.text.match(/name="_csrf"\s+value="([^"]+)"/)[1] };
  }

  it('lists only the allowed people, first names only', async () => {
    const { page } = await pickerCsrf(portalAgent(shared.ip));
    const html = withoutScripts(page.text);
    for (const n of ['Marc', 'Anna', 'Tom']) assert.ok(html.includes(`<b class="pt-person-name">${n}</b>`), n);
    assert.ok(!html.includes('Otto'));
    assert.ok(!html.includes('Picker') && !html.includes('who-anna'), 'no full name / username');
    assert.ok(html.includes('value="' + anna + '"'));
  });

  it('a correct PIN signs the person in; a person not on the list is refused', async () => {
    const p = portalAgent(shared.ip);
    const { c } = await pickerCsrf(p);
    const bad = await p.post('/portal/who').type('form').send({ _csrf: c, user: String(outsider), pin: '9999' }).expect(400);
    assert.ok(bad.text.includes('pt-who-error'));
    const ok = await p.post('/portal/who').type('form').send({ _csrf: c, user: String(anna), pin: '1234', remember: '1' }).expect(302);
    assert.equal(ok.headers.location, '/portal');
    assert.match(String(ok.headers['set-cookie']), /Expires=/);
    const page = await p.get('/portal').expect(200);
    assert.ok(page.text.includes('data-via="pin"'));
    assert.ok(page.text.includes('id="pt-switch"'));
    assert.equal(ctxOf(page.text).loggedIn, true);
  });

  it('the deep link of the app follows the PIN on a shared device', async () => {
    const t = ticketOf((await link(shared)).body.url);
    const p = portalAgent(shared.ip);
    const res = await p.get('/auto?t=' + t + '&next=' + encodeURIComponent('/portal#benachrichtigungen')).expect(302);
    assert.equal(res.headers.location, '/portal/who');
    const { c } = await pickerCsrf(p);
    const ok = await p.post('/portal/who').type('form').send({ _csrf: c, user: String(anna), pin: '1234' }).expect(302);
    assert.equal(ok.headers.location, '/portal#benachrichtigungen');
  });

  it('without "stay signed in" the cookie is a browser-session cookie', async () => {
    const p = portalAgent(shared.ip);
    const { c } = await pickerCsrf(p);
    const ok = await p.post('/portal/who').type('form').send({ _csrf: c, user: String(owner), pin: '2468' }).expect(302);
    assert.doesNotMatch(String(ok.headers['set-cookie']), /Expires=/);
  });

  it('needs the CSRF token', async () => {
    const p = portalAgent(shared.ip);
    await pickerCsrf(p);
    const res = await p.post('/portal/who').type('form').send({ user: String(anna), pin: '1234' });
    assert.equal(res.status, 403);
  });

  it('a person without a PIN cannot be picked', async () => {
    const p = portalAgent(shared.ip);
    const { c } = await pickerCsrf(p);
    const res = await p.post('/portal/who').type('form').send({ _csrf: c, user: String(tom), pin: '1234' }).expect(400);
    assert.ok(res.text.includes('Tom'));
  });

  it('5 wrong PINs lock that person on that device for 15 minutes', async () => {
    const p = portalAgent(shared.ip);
    const { c } = await pickerCsrf(p);
    for (let i = 0; i < 4; i++) await p.post('/portal/who').type('form').send({ _csrf: c, user: String(anna), pin: '0000' }).expect(400);
    const locked = await p.post('/portal/who').type('form').send({ _csrf: c, user: String(anna), pin: '0000' }).expect(429);
    assert.ok(withoutScripts(locked.text).includes('15'));
    // The right PIN does not help while locked …
    await p.post('/portal/who').type('form').send({ _csrf: c, user: String(anna), pin: '1234' }).expect(429);
    // … other people on the device are not affected …
    await p.post('/portal/who').type('form').send({ _csrf: c, user: String(owner), pin: '2468' }).expect(302);
    // … and the same person on another device neither.
    const pin = require('../src/services/portalPin');
    assert.equal((await pin.verify(anna, shared.peerId + 999, '1234')).ok, true);
    const row = db().prepare('SELECT locked_until FROM portal_pin_failures WHERE user_id = ? AND peer_id = ?').get(anna, shared.peerId);
    assert.ok(row.locked_until - Date.now() > 14 * 60000);
    assert.ok(db().prepare("SELECT 1 FROM activity_log WHERE event_type = 'portal_pin_locked'").get());
  });

  it('anonymous mode: only the services for everyone', async () => {
    db().prepare("INSERT INTO routes (domain, target_ip, target_port, route_type, enabled, description) VALUES ('all.portal.test', '10.0.0.5', 80, 'http', 1, 'For all')").run();
    db().prepare("INSERT INTO routes (domain, target_ip, target_port, route_type, enabled, description, user_ids) VALUES ('anna.portal.test', '10.0.0.6', 80, 'http', 1, 'Anna only', ?)").run(JSON.stringify([anna]));
    const p = portalAgent(shared.ip);
    const { c } = await pickerCsrf(p);
    await p.post('/portal/anonymous').type('form').send({ _csrf: c }).expect(302);
    const page = await p.get('/portal').expect(200);
    assert.ok(page.text.includes('data-viewer="anonymous"'));
    const svc = await p.get('/api/v1/portal/services').expect(200);
    const hosts = svc.body.data.map((s) => s.domain);
    assert.ok(hosts.includes('all.portal.test'));
    assert.ok(!hosts.includes('anna.portal.test'));
    await p.get('/api/v1/portal/me/devices').expect(401);
    // Anna (picked) sees her own share.
    const q = portalAgent(shared.ip);
    const { c: c2 } = await pickerCsrf(q);
    await q.post('/portal/who').type('form').send({ _csrf: c2, user: String(owner), pin: '2468' }).expect(302);
    const own = (await q.get('/api/v1/portal/services').expect(200)).body.data.map((s) => s.domain);
    assert.ok(!own.includes('anna.portal.test'));
  });

  it('"Person wechseln" ends the portal session and returns to the picker', async () => {
    const p = portalAgent(shared.ip);
    const { c } = await pickerCsrf(p);
    await p.post('/portal/who').type('form').send({ _csrf: c, user: String(owner), pin: '2468' }).expect(302);
    const page = await p.get('/portal').expect(200);
    const c2 = page.text.match(/action="\/portal\/switch">\s*<input type="hidden" name="_csrf" value="([^"]+)"/)[1];
    const res = await p.post('/portal/switch').type('form').send({ _csrf: c2 }).expect(302);
    assert.equal(res.headers.location, '/portal/who');
    assert.equal((await p.get('/portal')).status, 302);
  });

  it('a person removed from the device loses the portal session', async () => {
    const kim = await makeUser('who-kim', { displayName: 'Kim Gone', pin: '4321' });
    const dev2 = device('who-pc2', owner, { usage: 'multi', users: [kim] });
    const p = portalAgent(dev2.ip);
    const { c } = await pickerCsrf(p);
    await p.post('/portal/who').type('form').send({ _csrf: c, user: String(kim), pin: '4321' }).expect(302);
    assert.equal(ctxOf((await p.get('/portal')).text).loggedIn, true);
    require('../src/services/portalDevices').setUsage(dev2.tokenId, { usage: 'multi', userIds: [] });
    assert.equal((await p.get('/portal')).status, 302);
  });
});

// ─── PIN: own setting, admin reset, invitation ───────────────────────

describe('portal PIN management', () => {
  let mid, m, mCsrf;
  before(async () => {
    mid = await makeUser('pin-member', { selfService: true, displayName: 'Pia Pin' });
    ({ a: m } = await loginAs('pin-member'));
    mCsrf = (await m.get('/profile').expect(200)).text.match(/csrfToken:\s*'([^']+)'/)[1];
  });

  it('the member sets the own PIN with the password (4–6 digits)', async () => {
    assert.equal((await m.get('/api/v1/profile/portal-pin').expect(200)).body.data.has_pin, false);
    await m.put('/api/v1/profile/portal-pin').set('X-CSRF-Token', mCsrf).send({ pin: '12', password: PW }).expect(400);
    await m.put('/api/v1/profile/portal-pin').set('X-CSRF-Token', mCsrf).send({ pin: '1234567', password: PW }).expect(400);
    await m.put('/api/v1/profile/portal-pin').set('X-CSRF-Token', mCsrf).send({ pin: '12a4', password: PW }).expect(400);
    await m.put('/api/v1/profile/portal-pin').set('X-CSRF-Token', mCsrf).send({ pin: '1234', password: 'wrong' }).expect(400);
    await m.put('/api/v1/profile/portal-pin').set('X-CSRF-Token', mCsrf).send({ pin: '483920', password: PW }).expect(200);
    const row = db().prepare('SELECT portal_pin_hash FROM users WHERE id = ?').get(mid);
    assert.match(row.portal_pin_hash, /^\$argon2/);
    assert.equal((await m.get('/api/v1/profile/portal-pin')).body.data.has_pin, true);
    assert.equal((await require('../src/services/portalPin').verify(mid, 1, '483920')).ok, true);
  });

  it('the user API exposes only has_portal_pin, never the hash', async () => {
    const res = await agent.get(`/api/v1/users/${mid}`).expect(200);
    assert.equal(res.body.user.has_portal_pin, true);
    assert.ok(!res.text.includes('portal_pin_hash') && !res.text.includes('$argon2'));
  });

  it('the admin resets it ("PIN zurücksetzen"); members cannot', async () => {
    await m.delete(`/api/v1/users/${mid}/portal-pin`).set('X-CSRF-Token', mCsrf).expect(403);
    const res = await agent.delete(`/api/v1/users/${mid}/portal-pin`).set('X-CSRF-Token', csrf).expect(200);
    assert.equal(res.body.user.has_portal_pin, false);
    assert.equal(db().prepare('SELECT portal_pin_hash FROM users WHERE id = ?').get(mid).portal_pin_hash, null);
    assert.ok(db().prepare("SELECT 1 FROM activity_log WHERE event_type = 'portal_pin_reset'").get());
  });

  it('the member removes the own PIN with the password', async () => {
    await m.put('/api/v1/profile/portal-pin').set('X-CSRF-Token', mCsrf).send({ pin: '1357', password: PW }).expect(200);
    await m.post('/api/v1/profile/portal-pin/remove').set('X-CSRF-Token', mCsrf).send({ password: 'nope' }).expect(400);
    await m.post('/api/v1/profile/portal-pin/remove').set('X-CSRF-Token', mCsrf).send({ password: PW }).expect(200);
    assert.equal((await m.get('/api/v1/profile/portal-pin')).body.data.has_pin, false);
  });

  it('the invitation can set the PIN (optional step)', async () => {
    const id = await makeUser('pin-invitee', { displayName: 'Ivo Invite' });
    const inv = await agent.post(`/api/v1/users/${id}/invite`).set('X-CSRF-Token', csrf).send({}).expect(201);
    const path = inv.body.link.replace(/^https?:\/\/[^/]+/, '');
    const a = supertest.agent(app);
    const page = await a.get(path).expect(200);
    assert.ok(page.text.includes('id="invite-pin"'));
    const c = page.text.match(/name="_csrf"\s+value="([^"]+)"/)[1];
    const mismatch = await a.post(path).type('form').send({ _csrf: c, password: 'Invite!Pass123', password_confirm: 'Invite!Pass123', pin: '1111', pin_confirm: '2222' }).expect(200);
    assert.ok(mismatch.text.includes('login-error'));
    await a.post(path).type('form').send({ _csrf: c, password: 'Invite!Pass123', password_confirm: 'Invite!Pass123', pin: '2580', pin_confirm: '2580' }).expect(302);
    assert.equal((await require('../src/services/portalPin').verify(id, 1, '2580')).ok, true);
  });
});

// ─── "Wer nutzt dieses Gerät?" on the access ─────────────────────────

describe('device_usage (PATCH /api/v1/tokens/:id)', () => {
  let owner, anna, dev;
  before(async () => {
    owner = await makeUser('du-owner', { displayName: 'Dora Owner' });
    anna = await makeUser('du-anna', { displayName: 'Anna Usage', selfService: true });
    dev = device('du-pc', owner);
  });

  it('the admin switches to "Mehrere Personen" with a list of people', async () => {
    const res = await agent.patch(`/api/v1/tokens/${dev.tokenId}`).set('X-CSRF-Token', csrf)
      .send({ device_usage: 'multi', device_users: [anna, owner] }).expect(200);
    assert.equal(res.body.token.device_usage, 'multi');
    assert.deepEqual(res.body.token.device_users, [anna]);
    const info = require('../src/services/portalDevices').usageForPeer(dev.peerId);
    assert.equal(info.mode, 'multi');
    assert.deepEqual(info.allowedUserIds.sort(), [owner, anna].sort());
    const list = await agent.get(`/api/v1/users/${owner}`).expect(200);
    assert.equal(list.body.tokens.find((t) => t.id === dev.tokenId).device_usage, 'multi');
  });

  it('validates the values and writes nothing on an error', async () => {
    await agent.patch(`/api/v1/tokens/${dev.tokenId}`).set('X-CSRF-Token', csrf).send({ device_usage: 'everyone' }).expect(400);
    await agent.patch(`/api/v1/tokens/${dev.tokenId}`).set('X-CSRF-Token', csrf).send({ device_users: 'x' }).expect(400);
    await agent.patch(`/api/v1/tokens/${dev.tokenId}`).set('X-CSRF-Token', csrf).send({ name: 'renamed', device_users: [999999] }).expect(404);
    assert.equal(tokens().getById(dev.tokenId).name, 'du-pc');
  });

  it('members and tokens cannot change it', async () => {
    const { a } = await loginAs('du-anna');
    const c = (await a.get('/profile').expect(200)).text.match(/csrfToken:\s*'([^']+)'/)[1];
    await a.patch(`/api/v1/tokens/${dev.tokenId}`).set('X-CSRF-Token', c).send({ device_usage: 'single' }).expect(403);
    const full = tokens().create({ name: 'full', scopes: ['full-access'] }, '127.0.0.1').rawToken;
    await supertest(app).patch(`/api/v1/tokens/${dev.tokenId}`).set('Authorization', `Bearer ${full}`).send({ device_usage: 'single' }).expect(403);
    assert.equal(tokens().getById(dev.tokenId).device_usage, 'multi');
  });

  it('back to "Nur der Besitzer"', async () => {
    await agent.patch(`/api/v1/tokens/${dev.tokenId}`).set('X-CSRF-Token', csrf).send({ device_usage: 'single' }).expect(200);
    assert.equal(require('../src/services/portalDevices').usageForPeer(dev.peerId).mode, 'single');
  });
});

// ─── /me and the member navigation ───────────────────────────────────

describe('/me moved into the portal', () => {
  it('redirects to the portal, or to /profile when the portal is off', async () => {
    const res = await agent.get('/me').expect(302);
    assert.equal(res.headers.location, `https://${HOME}`);
    settings().set('portal.enabled', '0');
    try {
      assert.equal((await agent.get('/me').expect(302)).headers.location, '/profile');
    } finally { settings().set('portal.enabled', '1'); }
  });

  it('members land on /profile; their navigation is Portal + Konto & Sicherheit', async () => {
    await makeUser('nav-m2', { selfService: true });
    const { a, location } = await loginAs('nav-m2');
    assert.equal(location, '/profile');
    const html = withoutScripts((await a.get('/profile').expect(200)).text);
    const nav = html.slice(html.indexOf('id="sidebar"'), html.indexOf('</nav>', html.indexOf('id="sidebar"')));
    assert.ok(nav.includes(`href="https://${HOME}"`));
    assert.ok(nav.includes('href="/profile"'));
    assert.ok(!nav.includes('href="/me"'));
    assert.equal((await a.get('/users')).headers.location, '/profile');
  });
});

// ─── Templates ───────────────────────────────────────────────────────

describe('portal templates', () => {
  const RAW = /\b(?:portal|us|profile|invite)\.[a-z_]+(?:\.[a-z_]+)*\b/g;
  let anna, dev, shared;
  before(async () => {
    anna = await makeUser('tpl-anna', { displayName: 'Anna Template', pin: '1234' });
    dev = device('tpl-phone', anna);
    shared = device('tpl-pc', anna, { usage: 'multi' });
  });
  for (const lang of ['de', 'en']) {
    it(`portal, picker and anonymous view render without raw keys (${lang})`, async () => {
      const p = portalAgent(dev.ip);
      await p.get('/auto?t=' + ticketOf((await link(dev)).body.url)).set('Accept-Language', lang).expect(302);
      const pages = [await p.get('/portal').set('Accept-Language', lang).expect(200),
        await portalAgent(shared.ip).get('/portal/who').set('Accept-Language', lang).expect(200),
        await supertest(app).get('/portal').set('Accept-Language', lang).expect(200)];
      for (const page of pages) {
        const raw = withoutScripts(page.text).replace(/\/(?:css|js)\/portal[\w-]*\.(?:css|js)/g, '').match(RAW);
        assert.equal(raw, null, String(raw));
      }
      // The string island carries every portal.* key the script uses.
      const island = JSON.parse(pages[0].text.match(/id="portal-i18n"[^>]*>([^<]*)</)[1]);
      assert.ok(island['portal.devices.lock_title'] && island['portal.devices.enroll_failed']);
    });
  }

  it('the tab bar is a tablist with URL-addressable tabs', async () => {
    const p = portalAgent(dev.ip);
    await p.get('/auto?t=' + ticketOf((await link(dev)).body.url)).expect(302);
    const html = (await p.get('/portal').expect(200)).text;
    assert.ok(html.includes('role="tablist"'));
    for (const id of ['start', 'dienste', 'netzwerk', 'geraete']) {
      assert.ok(html.includes(`href="#${id}"`), id);
      assert.ok(html.includes(`id="panel-${id}"`), id);
    }
    // Unlicensed / empty areas are not rendered at all.
    assert.ok(!html.includes('id="panel-fahrzeug"'));
    assert.ok(!html.includes('id="panel-zuhause"'));
  });

  it('portal.js builds the DOM without innerHTML', () => {
    const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'public/js/portal.js'), 'utf8');
    assert.ok(!/\.innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(src));
  });

  it('de and en carry the same portal.* keys', () => {
    const de = require('../src/i18n/de.json');
    const en = require('../src/i18n/en.json');
    const pick = (o) => Object.keys(o).filter((k) => /^(portal|profile\.pin|us\.usage|invite\.pin)/.test(k)).sort();
    assert.deepEqual(pick(de), pick(en));
  });
});
