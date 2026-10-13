'use strict';

// "Routen nativ öffnen": the apps open a route from GET /api/v1/client/services
// with POST /api/v1/client/services/:id/open; with route_auth.app_login on
// ("Anmeldung aus den GateControl-Apps erlauben") the answer is a one-time
// URL /route-auth/app/<ticket> on the route's own domain that sets the
// route-auth session cookie without the login page.

const crypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const { describe, it, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const supertest = require('supertest');
const { setup, teardown } = require('./helpers/setup');

let app, agent, csrf;
before(async () => { ({ app, agent, csrfToken: csrf } = await setup()); });
after(() => teardown());

const db = () => require('../src/db/connection').getDb();
const tokens = () => require('../src/services/tokens');
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');

let seq = 1;
function makeUser(username) {
  return Number(db().prepare("INSERT INTO users (username, password_hash, role) VALUES (?, '!', 'user')").run(username).lastInsertRowid);
}
function device(owner, { scopes = ['client', 'client:services'] } = {}) {
  const n = seq++;
  const peerId = Number(db().prepare("INSERT INTO peers (name, public_key, allowed_ips, enabled, peer_type, user_id) VALUES (?, ?, ?, 1, 'regular', ?)")
    .run(`arl-dev-${n}`, crypto.randomBytes(16).toString('base64'), `10.8.7.${n}/32`, owner).lastInsertRowid);
  const t = tokens().create({ name: `arl-dev-${n}`, scopes, userId: owner, peerId }, '127.0.0.1');
  return { peerId, tokenId: t.token.id, raw: t.rawToken };
}
function route(domain, extra = {}) {
  const cols = { domain, target_ip: '10.0.0.9', target_port: 80, enabled: 1, ...extra };
  const keys = Object.keys(cols);
  return Number(db().prepare(`INSERT INTO routes (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`)
    .run(...keys.map((k) => cols[k])).lastInsertRowid);
}
function routeAuth(routeId, { appLogin = false, type = 'email_password', twoFactor = false, maxAge = 3600000 } = {}) {
  db().prepare(`INSERT INTO route_auth (route_id, auth_type, email, two_factor_enabled, two_factor_method, session_max_age, app_login)
    VALUES (?, ?, 'x@example.com', ?, ?, ?, ?)`).run(routeId, type, twoFactor ? 1 : 0, twoFactor ? 'totp' : null, maxAge, appLogin ? 1 : 0);
}
function services(dev) {
  return supertest(app).get('/api/v1/client/services').set('Authorization', `Bearer ${dev.raw}`);
}
function open(dev, id, headers = {}) {
  const req = supertest(app).post(`/api/v1/client/services/${id}/open`).set('Authorization', `Bearer ${dev.raw}`);
  for (const [k, v] of Object.entries(headers)) req.set(k, v);
  return req.send({});
}
function ticketOf(url) { return new URL(url).pathname.split('/').pop(); }
function redeem(ticket, host) {
  return supertest(app).get(`/route-auth/app/${ticket}`).set('Host', host);
}

// ─── Migrations ───────────────────────────────────────────────────────

describe('migrations 95/96', () => {
  it('route_auth.app_login defaults to 0 and route_app_tickets exists', () => {
    const col = db().prepare('PRAGMA table_info(route_auth)').all().find((c) => c.name === 'app_login');
    assert.ok(col);
    assert.equal(col.notnull, 1);
    assert.equal(String(col.dflt_value), '0');
    const cols = db().prepare('PRAGMA table_info(route_app_tickets)').all().map((c) => c.name);
    assert.deepEqual(cols, ['ticket_hash', 'route_id', 'token_id', 'user_id', 'expires_at', 'used_at']);
    const { migrations } = require('../src/db/migrationList');
    assert.ok(migrations.find((m) => m.version === 95).detect(db()));
    assert.ok(migrations.find((m) => m.version === 96).detect(db()));
  });
});

// ─── Admin API + service ──────────────────────────────────────────────

describe('route-auth admin API: app_login', () => {
  it('persists app_login, keeps it when omitted and returns it', async () => {
    const id = route('arl-admin.example.com');
    const post = (body) => agent.post(`/api/v1/routes/${id}/auth`).set('X-CSRF-Token', csrf)
      .send({ auth_type: 'email_password', email: 'a@example.com', password: 'Str0ng!Passw0rd#', ...body });
    let res = await post({ app_login: true }).expect(200);
    assert.equal(res.body.data.app_login, true);
    assert.equal(db().prepare('SELECT app_login FROM route_auth WHERE route_id = ?').get(id).app_login, 1);
    res = await agent.get(`/api/v1/routes/${id}/auth`).expect(200);
    assert.equal(res.body.data.app_login, true);
    // Omitted → unchanged
    await post({}).expect(200);
    assert.equal(db().prepare('SELECT app_login FROM route_auth WHERE route_id = ?').get(id).app_login, 1);
    res = await post({ app_login: false }).expect(200);
    assert.equal(res.body.data.app_login, false);
    assert.equal(db().prepare('SELECT app_login FROM route_auth WHERE route_id = ?').get(id).app_login, 0);
  });

  it('createOrUpdateAuth: new rows default to off, boolean-ish values map to 0/1', async () => {
    const svc = require('../src/services/routeAuth');
    const id = route('arl-svc.example.com');
    let row = await svc.createOrUpdateAuth(id, { auth_type: 'totp' }, '127.0.0.1');
    assert.equal(row.app_login, 0);
    row = await svc.createOrUpdateAuth(id, { app_login: '1' }, '127.0.0.1');
    assert.equal(row.app_login, 1);
    row = await svc.createOrUpdateAuth(id, { app_login: 0 }, '127.0.0.1');
    assert.equal(row.app_login, 0);
    row = await svc.createOrUpdateAuth(id, { app_login: 'on' }, '127.0.0.1');
    assert.equal(row.app_login, 1);
  });
});

// ─── GET /api/v1/client/services ──────────────────────────────────────

describe('services list: status, auth, appLogin', () => {
  let dev, ids;
  before(() => {
    const owner = makeUser('arl-list');
    dev = device(owner);
    ids = {
      plain: route('arl-plain.example.com', { monitoring_enabled: 1, monitoring_status: 'up' }),
      down: route('arl-down.example.com', { monitoring_enabled: 1, monitoring_status: 'down' }),
      unmonitored: route('arl-nomon.example.com', { monitoring_enabled: 0, monitoring_status: 'up' }),
      odd: route('arl-odd.example.com', { monitoring_enabled: 1, monitoring_status: 'unknown' }),
      basic: route('arl-basic.example.com', { basic_auth_enabled: 1, basic_auth_user: 'u' }),
      ra: route('arl-ra.example.com'),
      raApp: route('arl-raapp.example.com'),
    };
    routeAuth(ids.ra);
    routeAuth(ids.raApp, { appLogin: true });
  });

  it('adds the new fields and keeps the old ones', async () => {
    const res = await services(dev);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const by = Object.fromEntries(res.body.services.map((s) => [s.id, s]));
    const s = by[ids.plain];
    for (const k of ['id', 'name', 'domain', 'url', 'hasAuth', 'tls', 'status', 'auth', 'appLogin']) assert.ok(k in s, k);
    assert.equal(s.url, 'https://arl-plain.example.com');
    assert.equal(s.status, 'up');
    assert.equal(s.auth, 'none');
    assert.equal(s.appLogin, false);
    assert.equal(by[ids.down].status, 'down');
    assert.equal(by[ids.unmonitored].status, null);
    assert.equal(by[ids.odd].status, null);
    assert.equal(by[ids.basic].auth, 'basic');
    assert.equal(by[ids.basic].appLogin, false);
    assert.equal(by[ids.ra].auth, 'route');
    assert.equal(by[ids.ra].appLogin, false);
    assert.equal(by[ids.raApp].auth, 'route');
    assert.equal(by[ids.raApp].appLogin, true);
  });
});

// ─── POST /api/v1/client/services/:id/open ────────────────────────────

describe('open endpoint', () => {
  let anna, bob, dev, bobDev, ids;
  before(() => {
    anna = makeUser('arl-anna');
    bob = makeUser('arl-bob');
    dev = device(anna);
    bobDev = device(bob);
    ids = {
      plain: route('arl-open-plain.example.com'),
      ra: route('arl-open-ra.example.com'),
      raApp: route('arl-open-app.example.com'),
      onlyAnna: route('arl-open-anna.example.com', { user_ids: JSON.stringify([anna]) }),
      disabled: route('arl-open-off.example.com', { enabled: 0 }),
      l4: route('arl-open-l4.example.com', { route_type: 'l4' }),
      basicApp: route('arl-open-basic.example.com', { basic_auth_enabled: 1, basic_auth_user: 'u' }),
    };
    routeAuth(ids.ra);
    routeAuth(ids.raApp, { appLogin: true });
    routeAuth(ids.onlyAnna, { appLogin: true });
    routeAuth(ids.basicApp, { appLogin: true });
  });

  it('app_login on: one-time URL on the route domain, only the hash stored', async () => {
    const res = await open(dev, ids.raApp).expect(200);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(res.body.ok, true);
    assert.equal(res.body.autoLogin, true);
    assert.equal(res.body.expiresIn, 60);
    const u = new URL(res.body.url);
    assert.equal(u.protocol, 'https:');
    assert.equal(u.hostname, 'arl-open-app.example.com');
    assert.match(u.pathname, /^\/route-auth\/app\/[A-Za-z0-9_-]{43}$/);
    assert.equal(u.search, '');
    const t = ticketOf(res.body.url);
    assert.match(t, /^[A-Za-z0-9_-]{43}$/);
    const row = db().prepare('SELECT * FROM route_app_tickets WHERE ticket_hash = ?').get(sha(t));
    assert.ok(row);
    assert.equal(row.route_id, ids.raApp);
    assert.equal(row.token_id, dev.tokenId);
    assert.equal(row.user_id, anna);
    assert.equal(row.used_at, null);
    assert.ok(row.expires_at - Date.now() <= 60000 && row.expires_at - Date.now() > 50000);
    assert.equal(db().prepare('SELECT COUNT(*) AS c FROM route_app_tickets WHERE ticket_hash = ?').get(t).c, 0);
  });

  it('app_login off / no auth / basic auth: plain URL, no ticket', async () => {
    const before = db().prepare('SELECT COUNT(*) AS c FROM route_app_tickets').get().c;
    for (const [id, domain] of [[ids.ra, 'arl-open-ra.example.com'], [ids.plain, 'arl-open-plain.example.com'], [ids.basicApp, 'arl-open-basic.example.com']]) {
      const res = await open(dev, id).expect(200);
      assert.deepEqual(res.body, { ok: true, url: `https://${domain}`, autoLogin: false });
    }
    assert.equal(db().prepare('SELECT COUNT(*) AS c FROM route_app_tickets').get().c, before);
  });

  it('invisible, disabled, non-http and unknown routes are 404 not_found', async () => {
    assert.equal((await open(dev, ids.onlyAnna).expect(200)).body.autoLogin, true);
    for (const [d, id] of [[bobDev, ids.onlyAnna], [dev, ids.disabled], [dev, ids.l4], [dev, 999999], [dev, 'abc'], [dev, '0']]) {
      const res = await open(d, id).expect(404);
      assert.deepEqual(res.body, { ok: false, error: 'not_found' });
    }
  });

  it('needs a token with the client scope (a browser session is refused)', async () => {
    const other = device(anna, { scopes: ['peers'] });
    assert.equal((await open(other, ids.raApp)).status, 403);
    // Middleware lets client:services through (path prefix), the handler wants `client` too.
    const servicesOnly = device(anna, { scopes: ['client:services'] });
    const r = await open(servicesOnly, ids.raApp).expect(403);
    assert.deepEqual(r.body, { ok: false, error: 'scope_required' });
    const admin = Number(db().prepare("INSERT INTO users (username, password_hash, role) VALUES ('arl-admin', '!', 'admin')").run().lastInsertRowid);
    const full = device(admin, { scopes: ['full-access'] });
    await open(full, ids.raApp).expect(200);
    const sess = await agent.post(`/api/v1/client/services/${ids.raApp}/open`).set('X-CSRF-Token', csrf).send({});
    assert.equal(sess.status, 403);
    await supertest(app).post(`/api/v1/client/services/${ids.raApp}/open`).send({}).expect(401);
  });

  it('enforces the machine binding', async () => {
    const m = mock.method(tokens(), 'machineBindingState', () => ({ licensed: true, mode: 'global' }));
    const d = device(anna);
    try {
      const fp = 'c'.repeat(64);
      tokens().bindMachineFingerprint(d.tokenId, fp);
      await open(d, ids.raApp).expect(403);
      await open(d, ids.raApp, { 'X-Machine-Fingerprint': 'd'.repeat(64) }).expect(403);
      await open(d, ids.raApp, { 'X-Machine-Fingerprint': fp }).expect(200);
    } finally {
      m.mock.restore();
    }
  });

  it('is rate limited per device', async () => {
    const d = device(anna);
    let last;
    for (let i = 0; i < 31; i++) last = await open(d, ids.plain);
    assert.equal(last.status, 429);
    assert.deepEqual(last.body, { ok: false, error: 'rate_limited' });
  });
});

// ─── Ticket store ─────────────────────────────────────────────────────

describe('route app tickets', () => {
  const tickets = () => require('../src/services/routeAppTickets');
  let routeId;
  before(() => { routeId = route('arl-tickets.example.com'); });

  it('single use', () => {
    const { ticket } = tickets().create({ routeId, tokenId: 7, userId: 3 });
    assert.deepEqual(tickets().consume(ticket), { routeId, tokenId: 7, userId: 3 });
    assert.equal(tickets().consume(ticket), null);
  });

  it('expires', () => {
    const { ticket } = tickets().create({ routeId, tokenId: null, userId: null });
    db().prepare('UPDATE route_app_tickets SET expires_at = ? WHERE ticket_hash = ?').run(Date.now() - 1, sha(ticket));
    assert.equal(tickets().consume(ticket), null);
  });

  it('garbage never matches', () => {
    for (const t of [undefined, null, '', 'x', 'A'.repeat(43), '../../etc', 'A'.repeat(44)]) assert.equal(tickets().consume(t), null);
  });

  it('create removes long-expired rows', () => {
    db().prepare('INSERT INTO route_app_tickets (ticket_hash, route_id, expires_at) VALUES (?, ?, ?)').run('old-hash', routeId, Date.now() - 10 * 60 * 1000);
    tickets().create({ routeId, tokenId: null, userId: null });
    assert.equal(db().prepare("SELECT COUNT(*) AS c FROM route_app_tickets WHERE ticket_hash = 'old-hash'").get().c, 0);
  });
});

// ─── GET /route-auth/app/:ticket ──────────────────────────────────────

describe('redeem', () => {
  const DOMAIN = 'arl-redeem.example.com';
  let owner, dev, routeId;
  before(() => {
    owner = makeUser('arl-redeem');
    dev = device(owner);
    routeId = route(DOMAIN);
    routeAuth(routeId, { appLogin: true, twoFactor: true, maxAge: 7200000 });
  });
  async function issue() {
    const res = await open(dev, routeId).expect(200);
    assert.equal(res.body.autoLogin, true);
    return ticketOf(res.body.url);
  }
  const sessions = () => db().prepare('SELECT * FROM route_auth_sessions WHERE route_id = ?').all(routeId);
  const invalidPage = (res) => {
    assert.equal(res.status, 200);
    assert.ok(!res.headers['set-cookie'] || !res.headers['set-cookie'].join(';').includes('gc.route.sid='));
  };

  it('sets the route session cookie (no second factor) and redirects to /', async () => {
    const t = await issue();
    const res = await redeem(t, DOMAIN).expect(302);
    assert.equal(res.headers.location, '/');
    assert.equal(res.headers['referrer-policy'], 'no-referrer');
    const setCookie = (res.headers['set-cookie'] || []).join(';');
    assert.match(setCookie, /gc\.route\.sid=/);
    assert.ok(!/Domain=/i.test(setCookie), 'cookie must be host-only');
    const sid = /gc\.route\.sid=([^;]+)/.exec(setCookie)[1];
    const s = db().prepare('SELECT * FROM route_auth_sessions WHERE id = ?').get(decodeURIComponent(sid));
    assert.ok(s);
    assert.equal(s.route_id, routeId);
    assert.equal(s.two_factor_pending, 0);
    assert.equal(s.email, `app:user:${owner}`);
    const ttl = new Date(s.expires_at).getTime() - Date.now();
    assert.ok(ttl > 7100000 && ttl <= 7200000, String(ttl));
    // forward_auth accepts the session
    await supertest(app).get('/route-auth/verify').set('X-Route-Domain', DOMAIN).set('Cookie', `gc.route.sid=${sid}`).expect(200);
    // Activity entry with ids only
    const a = db().prepare("SELECT * FROM activity_log WHERE event_type = 'route_app_login' ORDER BY id DESC").get();
    assert.ok(a);
    assert.deepEqual(JSON.parse(a.details), { routeId, tokenId: dev.tokenId, userId: owner });
    assert.ok(!JSON.stringify(a).includes(t));
  });

  it('a ticket works once; the X-Forwarded-Host of Caddy counts', async () => {
    const t = await issue();
    await supertest(app).get(`/route-auth/app/${t}`).set('Host', '127.0.0.1:3000').set('X-Forwarded-Host', DOMAIN).expect(302);
    const n = sessions().length;
    invalidPage(await redeem(t, DOMAIN));
    assert.equal(sessions().length, n);
  });

  it('an expired ticket shows the generic invalid page', async () => {
    const t = await issue();
    db().prepare('UPDATE route_app_tickets SET expires_at = ? WHERE ticket_hash = ?').run(Date.now() - 1000, sha(t));
    const n = sessions().length;
    invalidPage(await redeem(t, DOMAIN));
    assert.equal(sessions().length, n);
  });

  it('rejects another host (and spends the ticket)', async () => {
    const t = await issue();
    const n = sessions().length;
    invalidPage(await redeem(t, 'other.example.com'));
    assert.equal(sessions().length, n);
    invalidPage(await redeem(t, DOMAIN));
    assert.equal(sessions().length, n);
  });

  it('rejects when app login was switched off after issuing', async () => {
    const t = await issue();
    db().prepare('UPDATE route_auth SET app_login = 0 WHERE route_id = ?').run(routeId);
    try {
      const n = sessions().length;
      const res = await redeem(t, DOMAIN);
      invalidPage(res);
      assert.equal(sessions().length, n);
      // Same generic page as an unknown ticket
      const unknown = await redeem('B'.repeat(43), DOMAIN);
      assert.equal(unknown.status, 200);
      const norm = (h) => h.replace(/(value|nonce)="[^"]*"/g, '');
      assert.equal(norm(res.text), norm(unknown.text));
    } finally {
      db().prepare('UPDATE route_auth SET app_login = 1 WHERE route_id = ?').run(routeId);
    }
  });

  it('rejects when the route was disabled, the device revoked or its owner disabled meanwhile', async () => {
    let t = await issue();
    db().prepare('UPDATE routes SET enabled = 0 WHERE id = ?').run(routeId);
    try { invalidPage(await redeem(t, DOMAIN)); } finally { db().prepare('UPDATE routes SET enabled = 1 WHERE id = ?').run(routeId); }
    const d = device(owner);
    const res = await open(d, routeId).expect(200);
    t = ticketOf(res.body.url);
    db().prepare('DELETE FROM api_tokens WHERE id = ?').run(d.tokenId);
    invalidPage(await redeem(t, DOMAIN));
    // Owner disabled after the ticket was issued
    const carl = makeUser('arl-carl');
    const cd = device(carl);
    t = ticketOf((await open(cd, routeId).expect(200)).body.url);
    db().prepare('UPDATE users SET enabled = 0 WHERE id = ?').run(carl);
    invalidPage(await redeem(t, DOMAIN));
  });

  it('garbage tickets never 500', async () => {
    for (const t of ['x', 'A'.repeat(43), '%00', '..%2F..%2Fetc']) {
      const res = await redeem(t, DOMAIN);
      assert.equal(res.status, 200, t);
    }
  });
});

// ─── Caddy, UI, i18n ──────────────────────────────────────────────────

describe('wiring', () => {
  it('Caddy access log redacts /route-auth/app/<ticket>', () => {
    const cfg = require('../src/services/caddyConfig').buildCaddyConfig();
    const ops = cfg.logging.logs.access.encoder.fields['request>uri'].operations;
    const op = ops.find((o) => o.value === '/route-auth/app/REDACTED');
    assert.ok(op);
    const t = crypto.randomBytes(32).toString('base64url');
    assert.equal(`/route-auth/app/${t}`.replace(new RegExp(op.regexp), op.value), '/route-auth/app/REDACTED');
  });

  it('route-auth routes get the /route-auth/* sibling proxy on their own domain', () => {
    const id = route('arl-caddy.example.com');
    routeAuth(id, { appLogin: true });
    const cfg = require('../src/services/caddyConfig').buildCaddyConfig();
    // Walk the structured config: the Caddy route matching exactly this host
    // must contain the /route-auth/* sibling route.
    const nodes = [];
    (function walk(v) {
      if (Array.isArray(v)) { v.forEach(walk); return; }
      if (v && typeof v === 'object') { nodes.push(v); Object.values(v).forEach(walk); }
    })(cfg);
    const matches = (n, pred) => Array.isArray(n.match) && n.match.some((m) => m && pred(m));
    const hostRoutes = nodes.filter((n) => matches(n, (m) => Array.isArray(m.host) && m.host.some((h) => h === 'arl-caddy.example.com')));
    assert.ok(hostRoutes.length > 0, 'route for the domain');
    const hasAuthProxy = hostRoutes.some((hr) => {
      const inner = [];
      (function walk(v) {
        if (Array.isArray(v)) { v.forEach(walk); return; }
        if (v && typeof v === 'object') { inner.push(v); Object.values(v).forEach(walk); }
      })(hr.handle);
      return inner.some((n) => matches(n, (m) => Array.isArray(m.path) && m.path.length === 1 && m.path[0] === '/route-auth/*'));
    });
    assert.ok(hasAuthProxy, '/route-auth/* sibling proxy on the route domain');
  });

  it('route editor has the toggle and both locales the texts', () => {
    const root = path.join(__dirname, '..');
    const tpl = fs.readFileSync(path.join(root, 'templates/aurora/partials/modals/route-edit.njk'), 'utf8');
    assert.match(tpl, /id="edit-ra-app-login"/);
    assert.match(tpl, /t\('route_auth\.app_login'\)/);
    assert.match(tpl, /t\('route_auth\.app_login_hint'\)/);
    const js = fs.readFileSync(path.join(root, 'public/js/entry-editor.js'), 'utf8');
    assert.match(js, /app_login: isOn\('edit-ra-app-login'\)/);
    const de = require('../src/i18n/de.json');
    const en = require('../src/i18n/en.json');
    assert.equal(de['route_auth.app_login'], 'Anmeldung aus den GateControl-Apps erlauben');
    assert.equal(de['route_auth.app_login_hint'], 'Geräte, die diese Route sehen dürfen, öffnen sie in der App ohne Login-Seite (auch ohne zweiten Faktor).');
    assert.ok(en['route_auth.app_login']);
    assert.ok(en['route_auth.app_login_hint']);
  });
});
