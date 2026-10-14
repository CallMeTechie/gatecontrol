'use strict';

// Kiosk devices (docs/feature-kiosk-devices.md): wall tablets that stay
// signed in to the portal as one user for 90 days (rolling).
//   * plugin permission permissions.kiosk + gc.kiosk.allow/list
//   * eligibility (plugin marks the user; never admins or disabled accounts;
//     loss of eligibility stops the device at the next request)
//   * pairing (one-time code, 10 minutes, hashed, ≤ 3 open, rate limit,
//     global lock), cookie flags, rolling expiry
//   * the kiosk allow-list, revocation, "Abmelden", clean-up, activity log

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const { helloPackage, HELLO } = require('./helpers/plugins');
const { setup, teardown, getCsrf } = require('./helpers/setup');
const config = require('../config/default');

const HOME = `home.${config.dns.domain}`;
const PLUGINS = '/api/v1/plugins';
const helloManifest = JSON.parse(fs.readFileSync(path.join(HELLO, 'plugin.json'), 'utf8'));

let app, agent, csrf, runtime, plugins, kiosk, kioskSession, adminId;
const db = () => require('../src/db/connection').getDb();

async function install(buf) {
  const r = await agent.post(PLUGINS + '/inspect').set('X-CSRF-Token', csrf).set('Content-Type', 'application/octet-stream').send(buf).expect(200);
  assert.equal(r.body.canInstall, true, JSON.stringify(r.body.checks));
  await agent.post(PLUGINS + '/install').set('X-CSRF-Token', csrf).send({ token: r.body.token, accept: true }).expect(200);
}

function kioskOverrides() {
  return { id: 'hello-kiosk', name: { de: 'Hallo Kiosk', en: 'Hello kiosk' }, permissions: { ...helloManifest.permissions, kiosk: true } };
}

let userSeq = 0;
function makeUser(prefix, { role = 'user', enabled = 1 } = {}) {
  userSeq += 1;
  const name = `${prefix}-${userSeq}`;
  return Number(db().prepare('INSERT INTO users (username, password_hash, role, display_name, enabled) VALUES (?, ?, ?, ?, ?)')
    .run(name, '!', role, `${prefix} ${userSeq}`, enabled).lastInsertRowid);
}

/** gc.kiosk.allow / list through the example plugin's API (as the administrator). */
function pluginKiosk(body, pluginId = 'hello-kiosk') {
  const req = body ? agent.post(`${PLUGINS}/${pluginId}/api/kiosk`).set('X-CSRF-Token', csrf).send(body) : agent.get(`${PLUGINS}/${pluginId}/api/kiosk`);
  return req;
}
async function allowUser(userId) {
  const r = await pluginKiosk({ userId, allowed: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
}

function createCode(userId, name = 'Küche') {
  return agent.post(`/api/v1/users/${userId}/kiosk/pair`).set('X-CSRF-Token', csrf).send({ name });
}

let ipSeq = 0;
/** A browser on the portal host with its own address (rate limits are per address). */
function tablet({ host = HOME, proto = null } = {}) {
  ipSeq += 1;
  const ip = `198.51.100.${ipSeq}`;
  const a = supertest.agent(app);
  const prep = (r) => {
    r.set('Host', host).set('X-Forwarded-For', ip);
    if (proto) r.set('X-Forwarded-Proto', proto);
    return r;
  };
  return {
    a, ip,
    get: (p) => prep(a.get(p)),
    post: (p) => prep(a.post(p)),
    put: (p) => prep(a.put(p)),
    del: (p) => prep(a.delete(p)),
  };
}

function formCsrf(html) {
  const m = html.match(/name="_csrf" value="([^"]*)"/);
  return m ? m[1] : '';
}
function ctxOf(html) {
  const m = html.match(/id="portal-ctx"[^>]*>([^<]*)</);
  return m ? JSON.parse(m[1]) : null;
}
function setCookies(res) { return [].concat(res.headers['set-cookie'] || []); }
function cookieLines(res, name) { return setCookies(res).filter((c) => c.startsWith(name + '=')); }

/** Pair `t` with a fresh code for `userId`; returns the redemption response. */
async function pair(t, userId, name = 'Küche') {
  const c = await createCode(userId, name);
  assert.equal(c.status, 201, JSON.stringify(c.body));
  const page = await t.get('/portal/kiosk?code=' + encodeURIComponent(c.body.code)).expect(200);
  assert.ok(page.text.includes(`value="${c.body.code}"`), 'code prefilled from ?code=');
  const res = await t.post('/portal/kiosk').type('form').send({ code: c.body.code, _csrf: formCsrf(page.text) });
  return { res, code: c.body.code };
}

async function portalCtx(t) {
  const res = await t.get('/portal').expect(200);
  return ctxOf(res.text);
}

function deviceOf(userId) {
  return db().prepare('SELECT * FROM kiosk_devices WHERE user_id = ? ORDER BY id DESC').get(userId);
}

before(async () => {
  ({ app, agent } = await setup());
  csrf = getCsrf();
  runtime = require('../src/services/plugins/runtime');
  plugins = require('../src/services/plugins');
  kiosk = require('../src/services/kiosk');
  kioskSession = require('../src/middleware/kioskSession');
  adminId = db().prepare("SELECT id FROM users WHERE username = 'admin'").get().id;
  await install(helloPackage());
  await install(helloPackage({ overrides: kioskOverrides() }));
  assert.equal(await runtime.waitRunning('hello'), true);
  assert.equal(await runtime.waitRunning('hello-kiosk'), true);
});
after(async () => { await plugins.stop(); teardown(); });

// ─── Plugin permission and host API ──────────────────────────────────────

describe('permissions.kiosk and gc.kiosk', () => {
  it('plugin.json: permissions.kiosk is a boolean, shown in the permission summary', async () => {
    const manifest = require('../src/services/plugins/manifest');
    const base = JSON.parse(JSON.stringify(helloManifest));
    assert.equal(manifest.validate(base).manifest.permissions.kiosk, false);
    base.permissions.kiosk = true;
    assert.equal(manifest.validate(base).manifest.permissions.kiosk, true);
    base.permissions.kiosk = 'yes';
    const bad = manifest.validate(base);
    assert.equal(bad.ok, false);
    assert.ok(bad.errors.includes('permissions.kiosk: invalid'));
    const list = (await agent.get(PLUGINS).expect(200)).body;
    const items = list.plugins || list.items || [];
    const hk = items.find((p) => p.id === 'hello-kiosk');
    if (hk && hk.permissions) assert.equal(hk.permissions.kiosk, true);
  });

  it('the consent dialog lists the kiosk permission', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'plugins-ui.js'), 'utf8');
    assert.ok(src.includes("t('plugins.perm.kiosk')"));
    for (const lang of ['de', 'en']) {
      const s = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'i18n', `${lang}.json`), 'utf8'));
      assert.ok(s['plugins.perm.kiosk_on'], lang);
    }
  });

  it('a plugin without the permission gets ERR_KIOSK_DENIED', async () => {
    const u = makeUser('nokperm');
    const r = await pluginKiosk({ userId: u, allowed: true }, 'hello');
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'ERR_KIOSK_DENIED');
    const l = await pluginKiosk(null, 'hello');
    assert.equal(l.body.code, 'ERR_KIOSK_DENIED');
  });

  it('allow / list / disallow; admins, disabled and unknown users are ERR_INVALID', async () => {
    const u = makeUser('wall');
    let r = await pluginKiosk({ userId: u, allowed: true });
    assert.equal(r.status, 200);
    assert.ok(r.body.users.includes(u));
    assert.equal(kiosk.isEligible(u), true);
    r = await pluginKiosk({ userId: u, allowed: false });
    assert.ok(!r.body.users.includes(u));
    assert.equal(kiosk.isEligible(u), false);

    const admin2 = makeUser('adm', { role: 'admin' });
    r = await pluginKiosk({ userId: admin2, allowed: true });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'ERR_INVALID');
    r = await pluginKiosk({ userId: adminId, allowed: true });
    assert.equal(r.body.code, 'ERR_INVALID');
    const off = makeUser('off', { enabled: 0 });
    r = await pluginKiosk({ userId: off, allowed: true });
    assert.equal(r.body.code, 'ERR_INVALID');
    r = await pluginKiosk({ userId: 999999, allowed: true });
    assert.equal(r.body.code, 'ERR_INVALID');
    r = await pluginKiosk({ userId: u, allowed: 'yes' });
    assert.equal(r.body.code, 'ERR_INVALID');
    assert.equal(db().prepare('SELECT COUNT(*) AS c FROM plugin_kiosk_users WHERE user_id IN (?, ?, ?)').get(admin2, adminId, off).c, 0);
  });

  it('an allowed user who becomes admin is not eligible', () => {
    const u = makeUser('promo');
    db().prepare("INSERT INTO plugin_kiosk_users (plugin_id, user_id, created_at) VALUES ('hello-kiosk', ?, ?)").run(u, Date.now());
    kiosk.invalidate();
    assert.equal(kiosk.isEligible(u), true);
    db().prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(u);
    assert.deepEqual(kiosk.eligibility(u), { eligible: false, reason: 'admin', plugins: [] });
  });
});

// ─── Admin API: pairing codes ────────────────────────────────────────────

describe('pairing codes (admin API)', () => {
  let u;
  before(async () => { u = makeUser('codes'); await allowUser(u); });

  it('GET /kiosk tells whether the user is eligible and by which plugin', async () => {
    const r = await agent.get(`/api/v1/users/${u}/kiosk`).expect(200);
    assert.equal(r.body.eligible, true);
    assert.equal(r.body.plugins.length, 1);
    assert.ok(['Hallo Kiosk', 'Hello kiosk'].includes(r.body.plugins[0]), r.body.plugins[0]);
    assert.deepEqual(r.body.devices, []);
    const other = makeUser('plain');
    const r2 = await agent.get(`/api/v1/users/${other}/kiosk`).expect(200);
    assert.equal(r2.body.eligible, false);
    assert.equal(r2.body.reason, 'no_plugin');
    const r3 = await agent.get(`/api/v1/users/${adminId}/kiosk`).expect(200);
    assert.equal(r3.body.reason, 'admin');
  });

  it('creates a code (alphabet without 0/O/1/I/L, 4-4), a QR code and the portal URL; only a hash is stored; it is logged', async () => {
    const before = db().prepare('SELECT COUNT(*) AS c FROM kiosk_pair_codes WHERE user_id = ?').get(u).c;
    const r = await createCode(u, 'Flur').expect(201);
    assert.equal(r.body.ok, true);
    const code = r.body.code;
    assert.equal(code.length, 9);
    assert.equal(code[4], '-');
    for (const ch of code.replace('-', '')) assert.ok(kiosk.CODE_ALPHABET.includes(ch), ch);
    for (const ch of '0O1IL') assert.ok(!kiosk.CODE_ALPHABET.includes(ch), ch);
    assert.ok(r.body.url.startsWith(`https://${HOME}/portal/kiosk?code=`), r.body.url);
    assert.ok(r.body.url.endsWith(encodeURIComponent(code)));
    assert.ok(String(r.body.qr).startsWith('data:image/png;base64,'));
    assert.ok(r.body.expiresAt - Date.now() <= 10 * 60 * 1000 && r.body.expiresAt - Date.now() > 9 * 60 * 1000);
    assert.equal(r.headers['cache-control'], 'no-store');
    const rows = db().prepare('SELECT * FROM kiosk_pair_codes WHERE user_id = ?').all(u);
    assert.equal(rows.length, before + 1);
    const raw = code.replace('-', '');
    for (const row of rows) {
      assert.ok(!JSON.stringify(row).includes(raw), 'code stored in plain text');
      assert.equal(row.code_hash.length, 64);
    }
    assert.ok(rows.some((row) => row.code_hash === kiosk.hashCode(raw)));
    const log = db().prepare("SELECT * FROM activity_log WHERE event_type = 'kiosk_code_created' ORDER BY id DESC").get();
    assert.ok(log.message.includes('Flur'));
    assert.ok(!JSON.stringify(log).includes(raw));
  });

  it('at most 3 open codes per user', async () => {
    const v = makeUser('three');
    await allowUser(v);
    for (let i = 0; i < 3; i++) await createCode(v).expect(201);
    const r = await createCode(v);
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'TOO_MANY_CODES');
    // an expired one frees its slot
    db().prepare('UPDATE kiosk_pair_codes SET expires_at = ? WHERE user_id = ? AND rowid = (SELECT MIN(rowid) FROM kiosk_pair_codes WHERE user_id = ?)').run(Date.now() - 1, v, v);
    await createCode(v).expect(201);
  });

  it('refuses users that are not eligible: no plugin, administrators, disabled accounts; a name is required', async () => {
    const plain = makeUser('noplugin');
    let r = await createCode(plain);
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'NOT_ELIGIBLE');
    r = await createCode(adminId);
    assert.equal(r.status, 403);
    const dis = makeUser('dis');
    await allowUser(dis);
    db().prepare('UPDATE users SET enabled = 0 WHERE id = ?').run(dis);
    r = await createCode(dis);
    assert.equal(r.status, 403);
    r = await createCode(u, '   ');
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'INVALID_NAME');
    r = await createCode(u, 'x'.repeat(61));
    assert.equal(r.status, 400);
    await agent.post('/api/v1/users/999999/kiosk/pair').set('X-CSRF-Token', csrf).send({ name: 'x' }).expect(404);
  });

  it('needs the admin session and its CSRF token', async () => {
    await agent.post(`/api/v1/users/${u}/kiosk/pair`).send({ name: 'x' }).expect(403);
    await supertest(app).post(`/api/v1/users/${u}/kiosk/pair`).send({ name: 'x' }).expect(401);
    await supertest(app).get(`/api/v1/users/${u}/kiosk`).expect(401);
  });
});

// ─── Pairing on the tablet ───────────────────────────────────────────────

describe('pairing on the tablet', () => {
  let u;
  before(async () => { u = makeUser('pairer'); await allowUser(u); });

  it('a code pairs once: cookie flags, hashed token, redirect to /portal, kiosk viewer', async () => {
    const t = tablet();
    const { res, code } = await pair(t, u, 'Küche');
    assert.equal(res.status, 303);
    assert.equal(res.headers.location, '/portal');
    const lines = cookieLines(res, 'gc_kiosk');
    assert.equal(lines.length, 2, setCookies(res).join(' | '));
    const paths = lines.map((l) => (l.split(';').map((p) => p.trim()).find((p) => p.startsWith('Path=')) || '')).sort();
    assert.deepEqual(paths, ['Path=/api/v1/portal', 'Path=/portal']);
    for (const l of lines) {
      assert.ok(l.includes('HttpOnly'), l);
      assert.ok(l.includes('SameSite=Lax'), l);
      assert.ok(l.includes('Max-Age=7776000'), l);
      assert.ok(!l.includes('Secure'), 'no Secure flag over plain http');
      assert.ok(!/;\s*Domain=/i.test(l), 'host-only cookie');
    }
    const hint = cookieLines(res, 'gc_kiosk_hint');
    assert.equal(hint.length, 1);
    assert.ok(hint[0].startsWith('gc_kiosk_hint=1;'));
    assert.ok(hint[0].includes('Path=/;'));
    const token = decodeURIComponent(lines[0].split(';')[0].slice('gc_kiosk='.length));
    assert.equal(token.length, 43);
    const dev = deviceOf(u);
    assert.equal(dev.name, 'Küche');
    assert.equal(dev.token_hash, crypto.createHash('sha256').update(token).digest('hex'));
    assert.equal(db().prepare('SELECT COUNT(*) AS c FROM kiosk_devices WHERE token_hash = ?').get(token).c, 0);
    assert.equal(dev.created_by, adminId);
    assert.ok(dev.expires_at - Date.now() > 89 * 86400000);
    assert.equal(dev.last_ip, t.ip);

    const ctx = await portalCtx(t);
    assert.equal(ctx.kiosk, true);
    assert.equal(ctx.loggedIn, true);
    assert.equal(ctx.tabs.devices, false, 'no device management on a kiosk');
    assert.equal(ctx.tabs.notify, false);
    const page = await t.get('/portal').expect(200);
    assert.ok(page.text.includes('id="pt-kiosk-logout"'));
    assert.ok(page.text.includes('Kiosk-Gerät „Küche“') || page.text.includes('Kiosk device “Küche”'));
    assert.ok(!page.text.includes('id="pt-account"'), 'no link to the account page');

    // single use: the same code on another tablet fails
    const t2 = tablet();
    const p2 = await t2.get('/portal/kiosk').expect(200);
    const again = await t2.post('/portal/kiosk').type('form').send({ code, _csrf: formCsrf(p2.text) });
    assert.equal(again.status, 400);
    assert.equal(cookieLines(again, 'gc_kiosk').length, 0);
    assert.equal(db().prepare('SELECT COUNT(*) AS c FROM kiosk_pair_codes WHERE code_hash = ?').get(kiosk.hashCode(code.replace('-', ''))).c, 0);

    const log = db().prepare("SELECT * FROM activity_log WHERE event_type = 'kiosk_paired' ORDER BY id DESC").get();
    assert.ok(log.message.includes('Küche'));
    const det = JSON.parse(log.details);
    assert.equal(det.userId, u);
    assert.equal(det.device, 'Küche');
    assert.ok(!JSON.stringify(log).includes(token));
    assert.ok(!JSON.stringify(log).includes(code.replace('-', '')));
  });

  it('typing is forgiving (lower case, spaces, no dash); a wrong or expired code gets the generic error', async () => {
    const c = await createCode(u, 'Bad').expect(201);
    const t = tablet();
    const page = await t.get('/portal/kiosk').expect(200);
    const wrong = await t.post('/portal/kiosk').type('form').send({ code: 'AAAA-AAAA', _csrf: formCsrf(page.text) });
    assert.equal(wrong.status, 400);
    assert.ok(wrong.text.includes('id="pt-kiosk-error"'));
    db().prepare('UPDATE kiosk_pair_codes SET expires_at = ? WHERE code_hash = ?').run(Date.now() - 1, kiosk.hashCode(c.body.code.replace('-', '')));
    const p2 = await t.get('/portal/kiosk').expect(200);
    const expired = await t.post('/portal/kiosk').type('form').send({ code: c.body.code, _csrf: formCsrf(p2.text) });
    assert.equal(expired.status, 400);
    assert.equal(expired.text.match(/id="pt-kiosk-error"[^>]*>([^<]*)</)[1], wrong.text.match(/id="pt-kiosk-error"[^>]*>([^<]*)</)[1]);
    const c2 = await createCode(u, 'Lower').expect(201);
    const p3 = await t.get('/portal/kiosk').expect(200);
    const typed = ' ' + c2.body.code.replace('-', ' ').toLowerCase() + ' ';
    const ok = await t.post('/portal/kiosk').type('form').send({ code: typed, _csrf: formCsrf(p3.text) });
    assert.equal(ok.status, 303);
  });

  it('a user who lost eligibility after the code was made cannot pair', async () => {
    const v = makeUser('lost');
    await allowUser(v);
    const c = await createCode(v).expect(201);
    await pluginKiosk({ userId: v, allowed: false }).expect(200);
    const t = tablet();
    const page = await t.get('/portal/kiosk').expect(200);
    const res = await t.post('/portal/kiosk').type('form').send({ code: c.body.code, _csrf: formCsrf(page.text) });
    assert.equal(res.status, 400);
    assert.equal(deviceOf(v), undefined);
  });

  it('needs the CSRF token of the page and the portal host', async () => {
    const c = await createCode(u).expect(201);
    const t = tablet();
    await t.get('/portal/kiosk').expect(200);
    const res = await t.post('/portal/kiosk').type('form').send({ code: c.body.code });
    assert.equal(res.status, 403);
    const other = tablet({ host: 'gc.example.org' });
    await other.get('/portal/kiosk').expect(404);
  });

  it('?next= stays inside the portal', async () => {
    const t = tablet();
    const c = await createCode(u).expect(201);
    const page = await t.get('/portal/kiosk?next=' + encodeURIComponent('/portal#zuhause')).expect(200);
    const res = await t.post('/portal/kiosk').type('form').send({ code: c.body.code, next: '/portal#zuhause', _csrf: formCsrf(page.text) });
    assert.equal(res.headers.location, '/portal#zuhause');
    const t2 = tablet();
    const c2 = await createCode(u).expect(201);
    const p2 = await t2.get('/portal/kiosk').expect(200);
    const evil = await t2.post('/portal/kiosk').type('form').send({ code: c2.body.code, next: '//evil.example/x', _csrf: formCsrf(p2.text) });
    assert.equal(evil.headers.location, '/portal');
  });

  it('Secure flag over https', async () => {
    const t = tablet({ proto: 'https' });
    const { res } = await pair(t, u, 'Https');
    assert.equal(res.status, 303);
    for (const l of cookieLines(res, 'gc_kiosk')) assert.ok(l.includes('Secure'), l);
  });

  it('pairing again from a kiosk device replaces (revokes) the old pairing', async () => {
    const t = tablet();
    await pair(t, u, 'Erst');
    const first = deviceOf(u);
    const { res } = await pair(t, u, 'Zweit');
    assert.equal(res.status, 303);
    const old = kiosk.getDevice(first.id);
    assert.ok(old.revoked_at);
    assert.equal(old.end_reason, 'replaced');
    assert.equal(deviceOf(u).name, 'Zweit');
  });
});

describe('pairing rate limits', () => {
  it('10 attempts per 15 minutes and address', async () => {
    const t = tablet();
    const page = await t.get('/portal/kiosk').expect(200);
    const tok = formCsrf(page.text);
    for (let i = 0; i < 10; i++) {
      const r = await t.post('/portal/kiosk').type('form').send({ code: 'ZZZZ-ZZZZ', _csrf: tok });
      assert.equal(r.status, 400, `attempt ${i + 1}`);
    }
    const r = await t.post('/portal/kiosk').type('form').send({ code: 'ZZZZ-ZZZZ', _csrf: tok });
    assert.equal(r.status, 429);
    kiosk.resetFailures();
  });

  it('50 wrong codes from anywhere lock pairing for 5 minutes (even a valid code)', async () => {
    kiosk.resetFailures();
    const u = makeUser('locked');
    await allowUser(u);
    const c = await createCode(u).expect(201);
    for (let i = 0; i < kiosk.FAIL_LIMIT; i++) assert.equal(kiosk.redeem('YYYY-YYYY', {}).ok, false);
    assert.equal(kiosk.pairingLocked(), true);
    const t = tablet();
    const page = await t.get('/portal/kiosk').expect(200);
    const r = await t.post('/portal/kiosk').type('form').send({ code: c.body.code, _csrf: formCsrf(page.text) });
    assert.equal(r.status, 429);
    assert.equal(deviceOf(u), undefined);
    assert.ok(db().prepare("SELECT 1 FROM activity_log WHERE event_type = 'kiosk_pairing_locked'").get());
    kiosk.resetFailures();
    const p2 = await t.get('/portal/kiosk').expect(200);
    const ok = await t.post('/portal/kiosk').type('form').send({ code: c.body.code, _csrf: formCsrf(p2.text) });
    assert.equal(ok.status, 303, 'the code survives the lock');
  });
});

// ─── The kiosk session ───────────────────────────────────────────────────

describe('kiosk session: allow-list', () => {
  let u, t, ctx;
  before(async () => {
    u = makeUser('allow');
    await allowUser(u);
    t = tablet();
    await pair(t, u, 'Wand');
    ctx = await portalCtx(t);
    assert.equal(ctx.kiosk, true);
  });

  it('kioskAllowed: exactly the listed paths', () => {
    const ok = [
      ['GET', '/portal'], ['GET', '/portal/'], ['GET', '/portal/plugins/familie/frame'], ['POST', '/portal/kiosk/logout'],
      ['GET', '/portal/kiosk'], ['POST', '/portal/kiosk'],
      ['GET', '/api/v1/portal/device'], ['GET', '/api/v1/portal/services'], ['GET', '/api/v1/portal/pihole/household'],
      ['GET', '/api/v1/portal/plugins/start'], ['GET', '/api/v1/portal/plugins/search'],
      ['POST', '/api/v1/portal/plugins/familie/api/wall/toggle'], ['DELETE', '/api/v1/portal/plugins/familie/api/x'],
    ];
    const no = [
      ['GET', '/portal/who'], ['POST', '/portal/who'], ['POST', '/portal/switch'], ['POST', '/portal/anonymous'], ['POST', '/portal/identify'],
      ['GET', '/api/v1/portal/me'], ['GET', '/api/v1/portal/me/devices'], ['DELETE', '/api/v1/portal/me/devices/3'],
      ['POST', '/api/v1/portal/me/enrollment'], ['GET', '/api/v1/portal/me/notify/prefs'], ['PUT', '/api/v1/portal/me/notify/prefs'],
      ['POST', '/api/v1/portal/device'], ['GET', '/api/v1/portal/plugins/familie/frame'], ['GET', '/portal/plugins/Familie/frame'],
      ['GET', '/api/v1/portal/plugins/../me/devices'], ['GET', '/api/v1/portal/plugins/x/api/../../me'], ['GET', '/portal//who'],
      ['GET', '/api/v1/portal/anything-new'], ['GET', '/portal/new-page'], ['GET', '/portal/kiosk/logout'],
    ];
    for (const [m, p] of ok) assert.equal(kioskSession.kioskAllowed(m, p), true, `${m} ${p}`);
    for (const [m, p] of no) assert.equal(kioskSession.kioskAllowed(m, p), false, `${m} ${p}`);
  });

  it('portal widget data is readable', async () => {
    const r = await t.get('/api/v1/portal/services');
    assert.notEqual(r.status, 403);
    const s = await t.get('/api/v1/portal/plugins/start').expect(200);
    assert.equal(s.body.ok, true);
  });

  it('device and token management, notification settings and the picker are refused', async () => {
    for (const p of ['/api/v1/portal/me', '/api/v1/portal/me/devices', '/api/v1/portal/me/notify/prefs', '/api/v1/portal/me/notify/inbox']) {
      const r = await t.get(p);
      assert.equal(r.status, 403, p);
      assert.equal(r.body.code, 'kiosk_forbidden', p);
    }
    const enr = await t.post('/api/v1/portal/me/enrollment').set('X-CSRF-Token', ctx.csrf).send({});
    assert.equal(enr.status, 403);
    assert.equal(enr.body.code, 'kiosk_forbidden');
    const del = await t.del('/api/v1/portal/me/devices/1').set('X-CSRF-Token', ctx.csrf);
    assert.equal(del.status, 403);
    const who = await t.get('/portal/who');
    assert.equal(who.status, 302);
    assert.equal(who.headers.location, '/portal');
    const anon = await t.post('/portal/anonymous').type('form').send({ _csrf: ctx.csrf });
    assert.equal(anon.status, 303);
    assert.equal(anon.headers.location, '/portal');
    // still a kiosk afterwards (nothing happened)
    assert.equal((await portalCtx(t)).kiosk, true);
  });

  it('the admin UI and API, the account pages and the web logout are out of reach', async () => {
    await t.get('/api/v1/users').expect(401);
    await t.get('/api/v1/me').expect(401);
    const dash = await t.get('/dashboard');
    assert.equal(dash.status, 302);
    assert.ok(dash.headers.location.startsWith('/login'));
    const prof = await t.get('/profile');
    assert.equal(prof.status, 302);
    await t.post(`/api/v1/users/${u}/kiosk/pair`).set('X-CSRF-Token', ctx.csrf).send({ name: 'x' }).expect(401);
    await t.post('/api/v1/client/portal-link').send({}).expect(401);
    await t.post('/logout').type('form').send({ _csrf: ctx.csrf }).expect((r) => assert.ok([302, 401, 403].includes(r.status), String(r.status)));
    assert.equal((await portalCtx(t)).kiosk, true);
  });

  it('plugins see user.kiosk = true and loggedIn; writes need the CSRF token like any signed-in viewer', async () => {
    const r = await t.post('/api/v1/portal/plugins/hello-kiosk/api/ping').set('X-CSRF-Token', ctx.csrf).send({ a: 1 }).expect(200);
    assert.equal(r.body.user.id, u);
    assert.equal(r.body.user.kiosk, true);
    assert.equal(r.body.user.loggedIn, true);
    assert.equal(r.body.user.portal, true);
    await t.post('/api/v1/portal/plugins/hello-kiosk/api/ping').send({ a: 1 }).expect(403);
    const g = await t.get('/api/v1/portal/plugins/hello-kiosk/api/ping').expect(200);
    assert.equal(g.body.user.kiosk, true);
    const f = await t.get('/portal/plugins/hello-kiosk/frame').expect(200);
    assert.ok(f.text.includes('id="hello"'));
  });

  it('a normal portal viewer has no kiosk flag', async () => {
    const r = await agent.get('/api/v1/portal/plugins/hello-kiosk/api/ping').set('Host', HOME).expect(200);
    assert.equal(r.body.user.kiosk, undefined);
    assert.equal(r.body.user.loggedIn, true);
  });

  it('the cookie means nothing on another host', async () => {
    const c = t.a.jar.getCookie('gc_kiosk', { domain: '127.0.0.1', path: '/portal', secure: false, script: false });
    assert.ok(c, 'cookie in the jar');
    const other = supertest(app).get('/portal').set('Host', 'gc.example.org').set('Cookie', `gc_kiosk=${c.value}`);
    const r = await other.expect(200);
    assert.equal(ctxOf(r.text).kiosk, false);
  });
});

describe('kiosk session: rolling expiry', () => {
  it('rolls at most once per hour: new expiry, last seen, cookie re-issued', async () => {
    const u = makeUser('roll');
    await allowUser(u);
    const t = tablet();
    await pair(t, u, 'Roll');
    const dev = deviceOf(u);
    // within the hour: nothing changes, no cookie
    const r1 = await t.get('/portal').expect(200);
    assert.equal(cookieLines(r1, 'gc_kiosk').length, 0);
    assert.equal(deviceOf(u).expires_at, dev.expires_at);
    // two hours later, nearly expired
    const old = Date.now() - 2 * 60 * 60 * 1000;
    db().prepare('UPDATE kiosk_devices SET last_seen_at = ?, expires_at = ?, last_ip = NULL WHERE id = ?').run(old, Date.now() + 60000, dev.id);
    const r2 = await t.get('/api/v1/portal/plugins/start').expect(200);
    const lines = cookieLines(r2, 'gc_kiosk');
    assert.equal(lines.length, 2);
    for (const l of lines) assert.ok(l.includes('Max-Age=7776000'));
    const now = deviceOf(u);
    assert.ok(now.expires_at > Date.now() + 89 * 86400000);
    assert.ok(now.last_seen_at > old);
    assert.equal(now.last_ip, t.ip);
  });

  it('an expired device is refused and its cookie removed', async () => {
    const u = makeUser('exp');
    await allowUser(u);
    const t = tablet();
    await pair(t, u, 'Exp');
    db().prepare('UPDATE kiosk_devices SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, deviceOf(u).id);
    const r = await t.get('/portal').expect(200);
    assert.equal(ctxOf(r.text).kiosk, false);
    assert.equal(ctxOf(r.text).loggedIn, false);
    const cleared = cookieLines(r, 'gc_kiosk');
    assert.equal(cleared.length, 2);
    for (const l of cleared) assert.ok(l.includes('Expires=Thu, 01 Jan 1970'), l);
  });

  it('the bare portal address leads to /portal?kiosk=1 once (hint cookie)', async () => {
    const u = makeUser('hint');
    await allowUser(u);
    const t = tablet();
    await pair(t, u, 'Hint');
    // a request where only the hint arrives (the browser was on "/")
    const r = await supertest(app).get('/portal').set('Host', HOME).set('Cookie', 'gc_kiosk_hint=1');
    assert.equal(r.status, 302);
    assert.equal(r.headers.location, '/portal?kiosk=1');
    const r2 = await supertest(app).get('/portal?kiosk=1').set('Host', HOME).set('Cookie', 'gc_kiosk_hint=1');
    assert.equal(r2.status, 200, 'no loop when the cookie is really gone');
    assert.ok(cookieLines(r2, 'gc_kiosk_hint').some((l) => l.includes('Expires=Thu, 01 Jan 1970')));
  });
});

describe('kiosk session: eligibility loss and revocation', () => {
  async function paired(prefix) {
    const u = makeUser(prefix);
    await allowUser(u);
    const t = tablet();
    await pair(t, u, prefix);
    assert.equal((await portalCtx(t)).kiosk, true);
    return { u, t };
  }

  it('the plugin disallows the user → the device stops at the next request, and works again when allowed', async () => {
    const { u, t } = await paired('disallow');
    await pluginKiosk({ userId: u, allowed: false }).expect(200);
    const r = await t.get('/portal').expect(200);
    const ctx = ctxOf(r.text);
    assert.equal(ctx.kiosk, false);
    assert.equal(ctx.loggedIn, false);
    assert.ok(r.text.includes('id="pt-note"'), 'paused note');
    await t.get('/api/v1/portal/plugins/hello-kiosk/api/ping').expect(403);
    assert.equal(deviceOf(u).revoked_at, null, 'paused, not revoked');
    await allowUser(u);
    assert.equal((await portalCtx(t)).kiosk, true);
  });

  it('the plugin is disabled → no kiosk; enabled again → kiosk', async () => {
    const { t } = await paired('plugoff');
    await agent.post(`${PLUGINS}/hello-kiosk/disable`).set('X-CSRF-Token', csrf).send({}).expect(200);
    try {
      assert.equal((await portalCtx(t)).kiosk, false);
    } finally {
      await agent.post(`${PLUGINS}/hello-kiosk/enable`).set('X-CSRF-Token', csrf).send({}).expect(200);
      assert.equal(await runtime.waitRunning('hello-kiosk'), true);
    }
    assert.equal((await portalCtx(t)).kiosk, true);
  });

  it('the user is disabled or promoted to administrator → no kiosk', async () => {
    const a = await paired('disabled');
    db().prepare('UPDATE users SET enabled = 0 WHERE id = ?').run(a.u);
    assert.equal((await portalCtx(a.t)).kiosk, false);
    const b = await paired('promoted');
    db().prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(b.u);
    const ctx = await portalCtx(b.t);
    assert.equal(ctx.kiosk, false);
    assert.equal(ctx.loggedIn, false);
    await b.t.get('/api/v1/users').expect(401);
  });

  it('the user is deleted → the device is gone and the cookie removed', async () => {
    const { u, t } = await paired('deleted');
    await agent.delete(`/api/v1/users/${u}`).set('X-CSRF-Token', csrf).expect(200);
    assert.equal(deviceOf(u), undefined);
    const r = await t.get('/portal').expect(200);
    assert.equal(ctxOf(r.text).kiosk, false);
    assert.equal(cookieLines(r, 'gc_kiosk').length, 2);
  });

  it('the administrator revokes the device (list → DELETE) → logged out at once', async () => {
    const { u, t } = await paired('revoked');
    const list = await agent.get(`/api/v1/users/${u}/kiosk`).expect(200);
    assert.equal(list.body.devices.length, 1);
    const d = list.body.devices[0];
    assert.equal(d.name, 'revoked');
    for (const k of ['created_at', 'last_seen_at', 'last_ip', 'expires_at']) assert.ok(d[k] != null, k);
    assert.equal(d.token_hash, undefined);
    const other = makeUser('stranger');
    await agent.delete(`/api/v1/users/${other}/kiosk/${d.id}`).set('X-CSRF-Token', csrf).expect(404);
    await agent.delete(`/api/v1/users/${u}/kiosk/${d.id}`).set('X-CSRF-Token', csrf).expect(200);
    await agent.delete(`/api/v1/users/${u}/kiosk/${d.id}`).set('X-CSRF-Token', csrf).expect(404);
    assert.equal(kiosk.getDevice(d.id).end_reason, 'revoked');
    const r = await t.get('/portal').expect(200);
    assert.equal(ctxOf(r.text).kiosk, false);
    assert.equal(cookieLines(r, 'gc_kiosk').length, 2);
    assert.deepEqual((await agent.get(`/api/v1/users/${u}/kiosk`).expect(200)).body.devices, []);
    const log = db().prepare("SELECT * FROM activity_log WHERE event_type = 'kiosk_revoked' ORDER BY id DESC").get();
    assert.equal(JSON.parse(log.details).deviceId, d.id);
  });

  it('"Abmelden" on the tablet revokes the device', async () => {
    const { u, t } = await paired('logout');
    const ctx = await portalCtx(t);
    await t.post('/portal/kiosk/logout').type('form').send({}).expect(403);
    const r = await t.post('/portal/kiosk/logout').type('form').send({ _csrf: ctx.csrf });
    assert.equal(r.status, 303);
    assert.equal(r.headers.location, '/portal');
    assert.equal(cookieLines(r, 'gc_kiosk').length, 2);
    assert.equal(deviceOf(u).end_reason, 'logout');
    const after = await portalCtx(t);
    assert.equal(after.kiosk, false);
    assert.equal(after.loggedIn, false);
  });
});

describe('clean-up', () => {
  it('logs expired devices once, deletes old ones after 30 days and expired codes at once', () => {
    const u = makeUser('clean');
    const now = Date.now();
    const ins = db().prepare(`INSERT INTO kiosk_devices (user_id, name, token_hash, created_at, expires_at, revoked_at, end_reason)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
    const fresh = Number(ins.run(u, 'abgelaufen', crypto.randomBytes(32).toString('hex'), now - 100 * 86400000, now - 1000, null, null).lastInsertRowid);
    const old = Number(ins.run(u, 'alt', crypto.randomBytes(32).toString('hex'), now - 200 * 86400000, now - 40 * 86400000, now - 31 * 86400000, 'revoked').lastInsertRowid);
    const recent = Number(ins.run(u, 'neu-widerrufen', crypto.randomBytes(32).toString('hex'), now - 10 * 86400000, now + 80 * 86400000, now - 5 * 86400000, 'revoked').lastInsertRowid);
    db().prepare('INSERT INTO kiosk_pair_codes (code_hash, user_id, name, created_at, expires_at) VALUES (?, ?, ?, ?, ?)').run('h-expired', u, 'x', now - 20 * 60000, now - 10 * 60000);
    const r = kiosk.cleanup();
    assert.ok(r.expired >= 1);
    assert.equal(kiosk.getDevice(fresh).end_reason, 'expired');
    assert.equal(kiosk.getDevice(old), null);
    assert.ok(kiosk.getDevice(recent));
    assert.equal(db().prepare("SELECT COUNT(*) AS c FROM kiosk_pair_codes WHERE code_hash = 'h-expired'").get().c, 0);
    const logs = db().prepare("SELECT * FROM activity_log WHERE event_type = 'kiosk_expired'").all()
      .filter((l) => JSON.parse(l.details).deviceId === fresh);
    assert.equal(logs.length, 1);
    kiosk.cleanup();
    assert.equal(db().prepare("SELECT * FROM activity_log WHERE event_type = 'kiosk_expired'").all()
      .filter((l) => JSON.parse(l.details).deviceId === fresh).length, 1, 'logged once');
  });
});

describe('profile page', () => {
  it('the user profile carries the kiosk dialog and its strings', async () => {
    const u = makeUser('page');
    const r = await agent.get(`/users/${u}`).expect(200);
    assert.ok(r.text.includes('id="us-dlg-kiosk"'));
    assert.ok(r.text.includes('up.kiosk.pair'));
    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'users.js'), 'utf8');
    assert.ok(js.includes("'/kiosk/pair'"));
  });
});
