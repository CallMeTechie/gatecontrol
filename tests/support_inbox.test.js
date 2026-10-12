'use strict';

// Support bundle inbox (docs/feature-support-bundle.md "Admin-Oberfläche"):
//   - migration 94 (viewed_at, viewed_by, user_id)
//   - GET /api/v1/support-bundles: admin session only, filter + pagination
//   - GET /api/v1/peers/:id/support-bundles/:bid: viewer JSON, marks viewed,
//     redacts once more on read, size cap, 404s
//   - notification center: "Support-Paket empfangen" with facts on upload
//   - peer list counts (session only), /support-bundles page, sidebar badge
//   - support-inbox.js / support-bundles.js: no innerHTML, pure helpers
//   - i18n: the new keys exist in DE and EN with the same placeholders

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const argon2 = require('argon2');
const supertest = require('supertest');
const { setup, teardown, getAgent, getCsrf } = require('./helpers/setup');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const de = require('../src/i18n/de.json');
const en = require('../src/i18n/en.json');
const S = require('../public/js/support-inbox.js');

let app;
let db;
let tokens;
let svc;
let config;

const SECRET_PRIV = 'yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=';
const SECRET_TOKEN = 'gc_' + 'f00dbabe1234'.repeat(4);

function seedPeer(name, type = 'regular') {
  return Number(db.prepare("INSERT INTO peers (name, public_key, allowed_ips, enabled, peer_type) VALUES (?, ?, '10.8.0.31/32', 1, ?)")
    .run(name, `PUB_${name}_${crypto.randomBytes(4).toString('hex')}=`, type).lastInsertRowid);
}
function tokenFor(peerId, userId = null) {
  return tokens.create({ name: `sbi-${crypto.randomBytes(4).toString('hex')}`, scopes: ['client'], peerId, userId }, '127.0.0.1').rawToken;
}
function bundle(extra = {}) {
  return {
    schema: 1,
    createdAt: new Date().toISOString(),
    client: { product: 'android', version: '1.17.0', platform: 'android', os: 'Android 15', arch: 'arm64-v8a', locale: 'de-DE' },
    tunnel: { connected: true },
    settings: { server: { url: 'https://gate.example.com' } },
    logs: { lines: ['I GateControl: ok', 'E GateControl: boom'], totalLines: 2, truncated: false },
    ...extra,
  };
}
function upload(token, peerId, body = bundle()) {
  return supertest(app).post(`/api/v1/client/support-bundle?peerId=${peerId}`)
    .set('X-API-Token', token)
    .set('Content-Type', 'application/gzip')
    .send(zlib.gzipSync(Buffer.from(JSON.stringify(body))));
}
async function loginAs(username, role) {
  const hash = await argon2.hash('Plain!Pass1234', require('../src/utils/argon2Options'));
  db.prepare('INSERT INTO users (username, password_hash, role, self_service_enabled) VALUES (?, ?, ?, ?)').run(username, hash, role, role === 'user' ? 1 : 0);
  const a = supertest.agent(app);
  const page = await a.get('/login').expect(200);
  const csrf = page.text.match(/name="_csrf"\s+value="([^"]+)"/)[1];
  await a.post('/login').type('form').send({ username, password: 'Plain!Pass1234', _csrf: csrf }).expect(302);
  return a;
}
function adminId() {
  return db.prepare("SELECT id FROM users WHERE username = 'admin'").get().id;
}

before(async () => {
  const ctx = await setup();
  app = ctx.app;
  db = require('../src/db/connection').getDb();
  tokens = require('../src/services/tokens');
  svc = require('../src/services/supportBundles');
  config = require('../config/default');
});
after(() => teardown());
beforeEach(() => {
  config.supportBundles.perHour = 100;
  config.supportBundles.keepPerPeer = 10;
  config.supportBundles.maxViewBytes = 8 * 1024 * 1024;
});

describe('migration 94', () => {
  it('is recorded and adds viewed_at, viewed_by and user_id', () => {
    const row = db.prepare('SELECT name FROM migration_history WHERE version = 94').get();
    assert.equal(row && row.name, 'support_bundles_viewed');
    const cols = db.prepare('PRAGMA table_info(support_bundles)').all().map((c) => c.name);
    for (const c of ['viewed_at', 'viewed_by', 'user_id']) assert.ok(cols.includes(c), c);
    const m = require('../src/db/migrationList').migrations.find((x) => x.version === 94);
    assert.equal(m.detect(db), true);
  });
});

describe('GET /api/v1/support-bundles (inbox)', () => {
  it('lists every device newest first with names, filters by device and status, pages', async () => {
    const userId = db.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES (?, 'Anna Inbox', 'x', 'user')")
      .run(`anna-${crypto.randomBytes(3).toString('hex')}`).lastInsertRowid;
    const a = seedPeer('sbi-list-a');
    const b = seedPeer('sbi-list-b');
    const tA = tokenFor(a, Number(userId));
    const tB = tokenFor(b);
    const up1 = await upload(tA, a);
    const up2 = await upload(tB, b, bundle({ reason: 'admin_request' }));
    const up3 = await upload(tA, a);
    for (const r of [up1, up2, up3]) assert.equal(r.status, 201, JSON.stringify(r.body));

    const all = await getAgent().get('/api/v1/support-bundles?limit=200').expect(200);
    assert.equal(all.body.ok, true);
    const ids = all.body.bundles.map((x) => x.id);
    assert.ok(ids.indexOf(up3.body.bundle.id) < ids.indexOf(up1.body.bundle.id), 'newest first');
    const one = all.body.bundles.find((x) => x.id === up1.body.bundle.id);
    assert.equal(one.peer_name, 'sbi-list-a');
    assert.equal(one.user_name, 'Anna Inbox', 'the sender (token user)');
    assert.equal(one.client_product, 'android');
    assert.equal(one.is_new, true);
    assert.equal(one.file_name, undefined, 'no file names leave the server');
    assert.ok(all.body.unviewed >= 3);
    assert.ok(all.body.peers.some((p) => p.id === a && p.count === 2 && p.unviewed === 2));

    const onlyA = await getAgent().get(`/api/v1/support-bundles?peerId=${a}`).expect(200);
    assert.deepEqual(onlyA.body.bundles.map((x) => x.id), [up3.body.bundle.id, up1.body.bundle.id]);
    assert.equal(onlyA.body.total, 2);

    const page1 = await getAgent().get(`/api/v1/support-bundles?peerId=${a}&limit=1`).expect(200);
    const page2 = await getAgent().get(`/api/v1/support-bundles?peerId=${a}&limit=1&offset=1`).expect(200);
    assert.deepEqual([page1.body.bundles[0].id, page2.body.bundles[0].id], [up3.body.bundle.id, up1.body.bundle.id]);
    assert.equal(page2.body.total, 2);
    assert.equal(page2.body.offset, 1);

    await getAgent().get(`/api/v1/peers/${a}/support-bundles/${up1.body.bundle.id}`).expect(200);
    const fresh = await getAgent().get(`/api/v1/support-bundles?peerId=${a}&status=new`).expect(200);
    assert.deepEqual(fresh.body.bundles.map((x) => x.id), [up3.body.bundle.id]);
    const seen = await getAgent().get(`/api/v1/support-bundles?peerId=${a}&status=viewed`).expect(200);
    assert.deepEqual(seen.body.bundles.map((x) => x.id), [up1.body.bundle.id]);
    const me = db.prepare("SELECT username, display_name FROM users WHERE username = 'admin'").get();
    assert.equal(seen.body.bundles[0].viewed_by_name, me.display_name || me.username);
  });

  it('400 for invalid filters', async () => {
    for (const q of ['status=bogus', 'limit=0', 'limit=500', 'offset=-1', 'peerId=abc', 'peerId=0']) {
      const r = await getAgent().get('/api/v1/support-bundles?' + q);
      assert.equal(r.status, 400, q);
    }
  });

  it('admin session only: API tokens (even full access) and members are refused', async () => {
    const full = tokens.create({ name: `sbi-full-${crypto.randomBytes(3).toString('hex')}`, scopes: ['full-access'] }, '127.0.0.1').rawToken;
    assert.equal((await supertest(app).get('/api/v1/support-bundles').set('X-API-Token', full)).status, 403);
    const peerId = seedPeer('sbi-tok');
    const up = await upload(tokenFor(peerId), peerId);
    assert.equal((await supertest(app).get(`/api/v1/peers/${peerId}/support-bundles/${up.body.bundle.id}`).set('X-API-Token', full)).status, 403);
    assert.equal((await supertest(app).get('/api/v1/support-bundles')).status, 401);
    const member = await loginAs(`sbi-member-${crypto.randomBytes(3).toString('hex')}`, 'user');
    assert.equal((await member.get('/api/v1/support-bundles')).status, 403);
    assert.equal((await member.get(`/api/v1/peers/${peerId}/support-bundles/${up.body.bundle.id}`)).status, 403);
    assert.equal(svc.getById(peerId, up.body.bundle.id).is_new, true, 'refused reads do not mark it viewed');
  });
});

describe('GET /api/v1/peers/:id/support-bundles/:bundleId (viewer)', () => {
  it('returns the parsed bundle and marks it viewed once (activity support_bundle_viewed)', async () => {
    const peerId = seedPeer('sbi-view');
    const up = await upload(tokenFor(peerId), peerId);
    const id = up.body.bundle.id;
    const r = await getAgent().get(`/api/v1/peers/${peerId}/support-bundles/${id}`).expect(200);
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.equal(r.body.bundle.id, id);
    assert.equal(r.body.bundle.peer_name, 'sbi-view');
    assert.equal(r.body.bundle.is_new, false);
    assert.equal(r.body.data.client.version, '1.17.0');
    assert.deepEqual(r.body.data.logs.lines, ['I GateControl: ok', 'E GateControl: boom']);

    const row = db.prepare('SELECT viewed_at, viewed_by FROM support_bundles WHERE id = ?').get(id);
    assert.ok(row.viewed_at);
    assert.equal(row.viewed_by, adminId());
    await getAgent().get(`/api/v1/peers/${peerId}/support-bundles/${id}`).expect(200);
    const views = db.prepare("SELECT COUNT(*) AS n FROM activity_log WHERE event_type = 'support_bundle_viewed' AND details LIKE ?").get(`%"bundleId":${id}%`).n;
    assert.equal(views, 1, 'logged on the first view only');
    assert.equal(db.prepare('SELECT viewed_at FROM support_bundles WHERE id = ?').get(id).viewed_at, row.viewed_at, 'first view kept');
    assert.equal(svc.list(peerId)[0].is_new, false, 'the per-peer list shows it as viewed');
  });

  it('redacts a secret that slipped into the stored file once more on read', async () => {
    const peerId = seedPeer('sbi-redact');
    const up = await upload(tokenFor(peerId), peerId);
    const id = up.body.bundle.id;
    const row = db.prepare('SELECT file_name FROM support_bundles WHERE id = ?').get(id);
    const file = path.join(config.supportBundles.dir, String(peerId), row.file_name);
    // An older server / a rule gap left secrets on disk:
    const leaked = bundle({
      settings: { server: { url: 'https://gate.example.com', apiKey: SECRET_TOKEN } },
      wireguardConfig: `[Interface]\nPrivateKey = ${SECRET_PRIV}\nAddress = 10.8.0.31/32`,
      logs: { lines: [`GET /x X-API-Token: ${SECRET_TOKEN}`] },
    });
    fs.writeFileSync(file, zlib.gzipSync(Buffer.from(JSON.stringify(leaked))));
    const r = await getAgent().get(`/api/v1/peers/${peerId}/support-bundles/${id}`).expect(200);
    const text = JSON.stringify(r.body);
    assert.ok(!text.includes(SECRET_TOKEN), 'token redacted');
    assert.ok(!text.includes(SECRET_PRIV), 'private key redacted');
    assert.equal(r.body.data.settings.server.apiKey, '[REDACTED]');
    assert.match(r.body.data.wireguardConfig, /PrivateKey = \[REDACTED\]/);
    assert.match(r.body.data.wireguardConfig, /Address = 10\.8\.0\.31\/32/);
  });

  it('413 above the viewer size cap (download still works), 404s', async () => {
    const peerId = seedPeer('sbi-big');
    const up = await upload(tokenFor(peerId), peerId, bundle({ logs: { lines: Array.from({ length: 400 }, (_, i) => `line ${i} ${'x'.repeat(40)}`) } }));
    const id = up.body.bundle.id;
    config.supportBundles.maxViewBytes = 2048;
    const big = await getAgent().get(`/api/v1/peers/${peerId}/support-bundles/${id}`);
    assert.equal(big.status, 413);
    assert.equal(big.body.code, 'too_large');
    assert.equal(svc.getById(peerId, id).is_new, true, 'not marked viewed');
    assert.equal((await getAgent().get(`/api/v1/peers/${peerId}/support-bundles/${id}/download`)).status, 200);
    config.supportBundles.maxViewBytes = 8 * 1024 * 1024;

    const other = seedPeer('sbi-other');
    assert.equal((await getAgent().get(`/api/v1/peers/${other}/support-bundles/${id}`)).status, 404, 'other peer');
    assert.equal((await getAgent().get(`/api/v1/peers/${peerId}/support-bundles/99999999`)).status, 404, 'unknown bundle');
    assert.equal((await getAgent().get(`/api/v1/peers/${peerId}/support-bundles/abc`)).status, 404, 'bad id');
    assert.equal((await getAgent().get(`/api/v1/peers/9876543/support-bundles/${id}`)).status, 404, 'unknown peer');
    // file gone → 404, row stays listed
    const row = db.prepare('SELECT file_name FROM support_bundles WHERE id = ?').get(id);
    fs.unlinkSync(path.join(config.supportBundles.dir, String(peerId), row.file_name));
    assert.equal((await getAgent().get(`/api/v1/peers/${peerId}/support-bundles/${id}`)).status, 404, 'file missing');
  });

  it('the existing endpoints keep their shape (list carries is_new / viewed_at)', async () => {
    const peerId = seedPeer('sbi-compat');
    const up = await upload(tokenFor(peerId), peerId);
    const list = await getAgent().get(`/api/v1/peers/${peerId}/support-bundles`).expect(200);
    assert.equal(list.body.bundles[0].id, up.body.bundle.id);
    assert.equal(list.body.bundles[0].is_new, true);
    assert.equal(list.body.bundles[0].viewed_at, null);
    assert.equal(list.body.requestedAt, null);
    const del = await getAgent().delete(`/api/v1/peers/${peerId}/support-bundles/${up.body.bundle.id}`).set('X-CSRF-Token', getCsrf());
    assert.equal(del.status, 200);
  });
});

describe('notification center: Support-Paket empfangen', () => {
  it('is a system catalogue row, on for admins via the app, e-mail off by default', () => {
    const N = require('../src/services/notifications');
    const sys = N.CATALOGUE.find((g) => g.id === 'system');
    assert.ok(sys.events.some((e) => e.id === 'support_bundle' && e.types.includes('support_bundle_uploaded')));
    const rules = require('../src/services/notify/rules');
    assert.deepEqual(rules.eventForType('support_bundle_uploaded'), { eventId: 'support_bundle', group: 'system', topic: 'system' });
    const rule = rules.get('support_bundle');
    assert.equal(rule.enabled, true);
    assert.equal(rule.ch_app, true);
    assert.equal(rule.ch_email, false);
    assert.equal(rule.recipients.admins, true);
    assert.equal(rule.priority, 'normal');
  });

  it('an upload emits it with device title, client / reason / size facts', async () => {
    const peerId = seedPeer('sbi-notify-phone');
    const up = await upload(tokenFor(peerId), peerId, bundle({ reason: 'user' }));
    assert.equal(up.status, 201);
    const n = db.prepare("SELECT * FROM notifications WHERE event_id = 'support_bundle' ORDER BY id DESC LIMIT 1").get();
    assert.ok(n, 'notification stored');
    assert.equal(n.event_type, 'support_bundle_uploaded');
    assert.equal(n.topic, 'system');
    const text = require('../src/services/notify/text');
    const lang = text.serverLang();
    assert.equal(n.title, text.t(lang, 'push.named.support_bundle_uploaded', { name: 'sbi-notify-phone' }));
    assert.equal(n.body, text.t(lang, 'push.body.support_bundle_uploaded'));
    const data = JSON.parse(n.data);
    assert.equal(data.route, 'inbox');
    const facts = Object.fromEntries(data.facts.map((f) => [f.label, f.value]));
    assert.equal(facts[text.t(lang, 'push.fact.client')], 'Android 1.17.0');
    assert.equal(facts[text.t(lang, 'push.fact.reason')], text.t(lang, 'push.fact.reason_user'));
    assert.match(facts[text.t(lang, 'push.fact.size')], /^\d+(\.\d)? (B|KB|MB)$/);
  });

  it('an answered admin request says "auf Anfrage"; a disabled rule sends nothing', async () => {
    const rules = require('../src/services/notify/rules');
    const text = require('../src/services/notify/text');
    const lang = text.serverLang();
    const peerId = seedPeer('sbi-notify-req');
    svc.requestBundle(peerId);
    await upload(tokenFor(peerId), peerId);
    let n = db.prepare("SELECT * FROM notifications WHERE event_id = 'support_bundle' ORDER BY id DESC LIMIT 1").get();
    const facts = JSON.parse(n.data).facts;
    assert.ok(facts.some((f) => f.value === text.t(lang, 'push.fact.reason_admin_request')));

    rules.update('support_bundle', { enabled: false });
    try {
      const before = n.id;
      await upload(tokenFor(peerId), peerId);
      n = db.prepare("SELECT * FROM notifications WHERE event_id = 'support_bundle' ORDER BY id DESC LIMIT 1").get();
      assert.equal(n.id, before);
    } finally {
      rules.update('support_bundle', { enabled: true });
    }
  });
});

describe('peer list and pages', () => {
  it('GET /api/v1/peers carries support counts for the admin session only', async () => {
    const peerId = seedPeer('sbi-peerlist');
    const up = await upload(tokenFor(peerId), peerId);
    await upload(tokenFor(peerId), peerId);
    await getAgent().get(`/api/v1/peers/${peerId}/support-bundles/${up.body.bundle.id}`).expect(200);
    const res = await getAgent().get('/api/v1/peers').expect(200);
    const p = res.body.peers.find((x) => x.id === peerId);
    assert.equal(p.support_bundles_total, 2);
    assert.equal(p.support_bundles_unviewed, 1);
    const ro = tokens.create({ name: `sbi-ro-${crypto.randomBytes(3).toString('hex')}`, scopes: ['read-only'] }, '127.0.0.1').rawToken;
    const viaToken = await supertest(app).get('/api/v1/peers').set('X-API-Token', ro);
    if (viaToken.status === 200) {
      const q = viaToken.body.peers.find((x) => x.id === peerId);
      assert.equal(q.support_bundles_total, undefined);
    }
  });

  it('/support-bundles renders for admins with island, script and the sidebar badge; members are sent away', async () => {
    const res = await getAgent().get('/support-bundles').expect(200);
    assert.match(res.text, /id="sb-page"/);
    assert.match(res.text, /<script src="\/js\/support-inbox\.js\?v=/);
    // The island by plain string positions (no HTML parsing by regex).
    const open = 'id="sb-i18n" data-prefixes="support_bundles. common."';
    const at = res.text.indexOf(open);
    assert.ok(at > 0, 'island');
    const start = res.text.indexOf('>', at) + 1;
    const raw = res.text.slice(start, res.text.indexOf('</' + 'script>', start));
    assert.ok(!raw.includes('<'), 'no raw < inside the island');
    const island = JSON.parse(raw);
    assert.ok(Object.keys(island).every((k) => k.startsWith('support_bundles.') || k.startsWith('common.')));
    assert.ok([de['support_bundles.empty_title'], en['support_bundles.empty_title']].includes(island['support_bundles.empty_title']));
    assert.match(res.text, /<a href="\/support-bundles" class="nav-item active">/);
    const unviewed = svc.unviewedCount();
    assert.ok(unviewed > 0);
    assert.match(res.text, new RegExp(`id="sb-nav-badge"[^>]*>${unviewed}</span>`));
    assert.match(res.text, /<title>(Support-Pakete|Support bundles) — /);

    const member = await loginAs(`sbi-page-member-${crypto.randomBytes(3).toString('hex')}`, 'user');
    const r = await member.get('/support-bundles');
    assert.equal(r.status, 302);
    assert.match(r.headers.location, /\/profile/);
  });

  it('the peer edit modal links to the viewer and shows a count; the peer list has its badge', () => {
    const modal = read('templates/aurora/partials/modals/peer-edit.njk');
    assert.match(modal, /id="edit-peer-support-count"/);
    const js = read('public/js/support-bundles.js');
    assert.ok(js.includes("'/support-bundles#view/'"));
    assert.ok(read('public/js/peers.js').includes('getSupportBadge(p)'));
  });
});

describe('page scripts: static checks', () => {
  const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
  for (const f of ['public/js/support-inbox.js', 'public/js/support-bundles.js']) {
    it(`${f} builds the DOM without innerHTML`, () => {
      assert.doesNotMatch(strip(read(f)), /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    });
  }
  it('support-inbox.js only talks to the support bundle APIs', () => {
    const code = strip(read('public/js/support-inbox.js'));
    const urls = Array.from(code.matchAll(/'(\/api\/[^']*)'/g)).map((m) => m[1]);
    assert.ok(urls.length >= 2);
    assert.ok(urls.every((u) => u === '/api/v1/support-bundles' || u.startsWith('/api/v1/support-bundles?') || u === '/api/v1/peers/'), urls.join(' '));
  });
  it('the styles live in §11 of app.css', () => {
    const css = read('public/css/app.css');
    const at = css.indexOf('\n * §11 Support bundles (sb-)');
    assert.ok(at > 0);
    for (const sel of ['.sb-page', '.sb-viewer', '.sb-log', '.sb-lv-error', '.sb-peer-badge', '.sb-summary', '.sb-modal-table']) {
      assert.ok(css.indexOf(sel, at) > at, sel);
    }
  });
});

describe('support-inbox.js: pure helpers', () => {
  it('routes and filters', () => {
    assert.deepEqual(S.parseRoute('#view/12/345'), { peerId: 12, bundleId: 345 });
    assert.equal(S.parseRoute('#view/x/1'), null);
    assert.equal(S.parseRoute(''), null);
    assert.equal(S.viewHash(3, 9), '#view/3/9');
    assert.deepEqual(S.parseSearch('?peer=7&status=new'), { peerId: 7, status: 'new' });
    assert.deepEqual(S.parseSearch('?peer=abc&status=evil'), { peerId: null, status: '' });
    assert.equal(S.searchFor({ peerId: 7, status: 'viewed' }), '?peer=7&status=viewed');
    assert.equal(S.searchFor({}), '');
    assert.equal(S.listQuery({ peerId: 4, status: 'new', offset: 50 }), '?limit=50&offset=50&peerId=4&status=new');
  });

  it('client label and time', () => {
    assert.equal(S.clientLabel({ client_product: 'android', client_version: '1.17.0' }), 'Android 1.17.0');
    assert.equal(S.clientLabel({ client_product: 'pro', client_version: null }), 'Pro');
    assert.equal(S.clientLabel({ client_product: 'weird', client_version: '2' }), '2');
    assert.equal(S.parseTime('2026-10-12 10:14:00').toISOString(), '2026-10-12T10:14:00.000Z');
    assert.equal(S.parseTime('nonsense'), null);
  });

  it('log levels from logcat, bracket, key=value and plain formats', () => {
    assert.equal(S.logLevel('10-12 11:58:02.114  4211  4290 E GateControl: boom'), 'error');
    assert.equal(S.logLevel('10-12 11:58:02.114  4211  4290 W GateControl: slow'), 'warn');
    assert.equal(S.logLevel('E/GateControl( 123): boom'), 'error');
    assert.equal(S.logLevel('[warn] adapter not found'), 'warn');
    assert.equal(S.logLevel('2026-10-12T10:00:00Z INFO started'), 'info');
    assert.equal(S.logLevel('time=1 level=debug msg=x'), 'debug');
    assert.equal(S.logLevel('[info] no errors found'), 'info', 'the level token wins over words in the text');
    assert.equal(S.logLevel('just text'), '');
  });

  it('normLogs accepts every shape, filterLines + splitHits', () => {
    const n = S.normLogs({ lines: ['[error] a', '[info] b', { level: 'warn', message: 'c', time: 't' }], totalLines: 900, truncated: true });
    assert.equal(n.lines.length, 3);
    assert.equal(n.total, 900);
    assert.equal(n.truncated, true);
    assert.deepEqual(n.lines.map((l) => l.level), ['error', 'info', 'warn']);
    assert.equal(S.normLogs('x\ny\n').lines.length, 2);
    assert.equal(S.normLogs(['a']).truncated, false);
    assert.equal(S.normLogs(null).lines.length, 0);
    assert.deepEqual(S.filterLines(n.lines, '', 'warn').map((l) => l.text), ['t [warn] c']);
    assert.deepEqual(S.filterLines(n.lines, 'B', '').map((l) => l.text), ['[info] b']);
    assert.deepEqual(S.splitHits('aXbx', 'x'), [{ text: 'a', hit: false }, { text: 'X', hit: true }, { text: 'b', hit: false }, { text: 'x', hit: true }]);
  });

  it('flatten and otherKeys', () => {
    assert.deepEqual(S.flatten({ a: { b: 1, c: [1, 2] }, d: 'x' }), [['a.b', 1], ['a.c', [1, 2]], ['d', 'x']]);
    assert.deepEqual(S.otherKeys({ schema: 1, client: {}, battery: {}, logs: [] }), ['battery']);
  });
});

describe('i18n', () => {
  const NEW = /^(support_bundles\.|push\.(type|named|body)\.support_bundle_uploaded$|push\.fact\.(client|reason|reason_user|reason_admin_request|size)$|st\.event\.support_bundle$|nav\.support_bundles$)/;
  it('DE and EN carry the same support keys in the same order with the same placeholders', () => {
    const dk = Object.keys(de).filter((k) => NEW.test(k));
    const ek = Object.keys(en).filter((k) => NEW.test(k));
    assert.deepEqual(dk, ek);
    assert.ok(dk.length > 80);
    const ph = (s) => (String(s).match(/\{\{\s*\w+\s*\}\}/g) || []).sort().join();
    for (const k of dk) {
      assert.equal(ph(de[k]), ph(en[k]), k);
      assert.ok(de[k].trim() && en[k].trim(), k);
    }
  });
  it('the support_bundles.* keys stay one block', () => {
    for (const [name, loc] of [['de', de], ['en', en]]) {
      const keys = Object.keys(loc);
      const first = keys.findIndex((k) => k.startsWith('support_bundles.'));
      let i = first;
      while (i < keys.length && keys[i].startsWith('support_bundles.')) i++;
      assert.ok(!keys.slice(i).some((k) => k.startsWith('support_bundles.')), name);
    }
  });
});
