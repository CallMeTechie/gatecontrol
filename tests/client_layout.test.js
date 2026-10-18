'use strict';

// Order of the apps' Start / Familie tabs shared by the account
// (docs/feature-client-layout.md, services/clientLayout.js):
//   * GET/PUT /api/v1/client/layout — scope device / user (default) / global,
//     editable, validation (≤ 100 entries, 1–120 [A-Za-z0-9:_./@-], duplicates
//     removed), 409 device_scope, 403 forbidden / no_user, layout: null resets
//   * control event `layout` on the push stream: the person's other devices
//     (scope user), every device (scope global or a scope change)
//   * admin setting client_layout_scope: GET/PUT /api/v1/settings/client-layout
//     (session only, audited), the card on the settings page (DE + EN)
//   * migration 104 (client_layouts), a person's layout goes with the account

const crypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const supertest = require('supertest');
const { setup, teardown, getCsrf } = require('./helpers/setup');
const H = require('./helpers/notify');

const URL = '/api/v1/client/layout';
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const LAYOUT = {
  start: ['tile:vpn', 'widget:gatecontrol-klima/room:3@2', 'card:info', 'card:traffic'],
  startHidden: ['tile:services'],
  familie: ['card:shopping', 'card:tasks'],
  familieHidden: [],
};

let app, agent, server, port, stream, clientLayout, tokens;
let anna, annaPhone, annaTab, ben, benPhone, boss, bossPhone;

const get = (dev) => supertest(app).get(URL).set('X-API-Token', dev.raw);
const put = (dev, body) => supertest(app).put(URL).set('X-API-Token', dev.raw).send(body);
const setScope = (scope) => agent.put('/api/v1/settings/client-layout').set('X-CSRF-Token', getCsrf()).send({ scope });

/** Open push streams for the devices and wait for their hello. */
async function openAll(devs) {
  const out = new Map();
  for (const d of devs) {
    const s = await H.openStream(port, d.raw);
    assert.equal(s.status, 200);
    await s.waitFor((e) => e.event === 'hello');
    out.set(d, s);
  }
  return out;
}
let markSeq = 0;
/** Everything written before this call has arrived (a marker goes down every stream). */
async function settle(streams) {
  markSeq += 1;
  const n = markSeq;
  for (const d of streams.keys()) stream.send(d.tokenId, 'marker', { n });
  for (const s of streams.values()) await s.waitFor((e) => e.event === 'marker' && e.data.n === n);
}
const layoutEvents = (s) => s.events.filter((e) => e.event === 'control' && e.data.type === 'layout').map((e) => e.data);
const closeAll = (streams) => { for (const s of streams.values()) s.close(); };

before(async () => {
  ({ app, agent } = await setup());
  server = app.listen(0);
  port = server.address().port;
  stream = require('../src/services/notify/stream');
  clientLayout = require('../src/services/clientLayout');
  tokens = require('../src/services/tokens');
  anna = H.makeUser('lay-anna');
  ben = H.makeUser('lay-ben');
  boss = H.makeUser('lay-boss', { role: 'admin' });
  annaPhone = H.makeDevice(anna, { name: 'lay-anna-phone' });
  annaTab = H.makeDevice(anna, { name: 'lay-anna-tab' });
  benPhone = H.makeDevice(ben, { name: 'lay-ben-phone' });
  bossPhone = H.makeDevice(boss, { name: 'lay-boss-phone' });
});
after(() => { stream._resetForTest(); server.close(); teardown(); });
beforeEach(async () => {
  stream._resetForTest();
  H.db().prepare('DELETE FROM client_layouts').run();
  H.db().prepare("DELETE FROM settings WHERE key = 'client_layout_scope'").run();
});

describe('migration 104', () => {
  it('client_layouts exists; a person\'s row goes with the account', async () => {
    assert.equal(H.db().prepare('SELECT name FROM migration_history WHERE version = 104').get().name, 'client_layouts');
    const gone = H.makeUser('lay-gone');
    const dev = H.makeDevice(gone, { name: 'lay-gone-phone' });
    await put(dev, { layout: LAYOUT }).expect(200);
    assert.equal(H.db().prepare('SELECT COUNT(*) AS n FROM client_layouts WHERE user_id = ?').get(gone).n, 1);
    H.db().prepare('DELETE FROM api_tokens WHERE user_id = ?').run(gone);
    H.db().prepare('DELETE FROM peers WHERE user_id = ?').run(gone);
    H.db().prepare('DELETE FROM users WHERE id = ?').run(gone);
    assert.equal(H.db().prepare('SELECT COUNT(*) AS n FROM client_layouts WHERE user_id = ?').get(gone).n, 0);
  });
});

describe('scope user (default): one layout per account', () => {
  it('GET before anything is stored: layout null, editable', async () => {
    const r = await get(annaPhone).expect(200);
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.deepEqual(r.body, { ok: true, scope: 'user', editable: true, layout: null, updatedAt: null });
  });

  it('PUT stores it for the account — the person\'s other devices get it, nobody else', async () => {
    const r = await put(annaPhone, { layout: LAYOUT }).expect(200);
    assert.equal(r.body.ok, true);
    assert.match(r.body.updatedAt, ISO_RE);
    assert.deepEqual((await get(annaTab).expect(200)).body, { ok: true, scope: 'user', editable: true, layout: LAYOUT, updatedAt: r.body.updatedAt });
    assert.equal((await get(benPhone).expect(200)).body.layout, null);
    // saving again replaces it
    const next = { ...LAYOUT, start: ['card:info'] };
    const r2 = await put(annaTab, { layout: next }).expect(200);
    assert.ok(r2.body.updatedAt >= r.body.updatedAt);
    assert.deepEqual((await get(annaPhone)).body.layout, next);
  });

  it('validation: missing lists → [], unknown keys ignored, duplicates removed (first stays)', async () => {
    await put(annaPhone, { layout: { start: ['a', 'b', 'a', 'c', 'b'], future: { x: 1 } } }).expect(200);
    assert.deepEqual((await get(annaPhone)).body.layout, { start: ['a', 'b', 'c'], startHidden: [], familie: [], familieHidden: [] });
    const max = Array.from({ length: 100 }, (_, i) => `tile:${i}`);
    await put(annaPhone, { layout: { familie: max, start: ['x'.repeat(120), 'A-z_0.9:/@'] } }).expect(200);
    assert.equal((await get(annaPhone)).body.layout.familie.length, 100);
  });

  it('400 invalid_layout: not an object, a list no array or > 100 entries, a bad entry; nothing stored', async () => {
    await put(annaPhone, { layout: LAYOUT }).expect(200);
    const before = (await get(annaPhone)).body;
    for (const body of [{}, { layout: 'x' }, { layout: [] }, { layout: 7 }, { layout: { start: 'tile:vpn' } }, { layout: { start: { a: 1 } } },
      { layout: { start: Array.from({ length: 101 }, (_, i) => `t${i}`) } }, { layout: { start: [''] } }, { layout: { start: ['x'.repeat(121)] } },
      { layout: { startHidden: ['bad id'] } }, { layout: { familie: ['<script>'] } }, { layout: { familieHidden: [7] } }, { layout: { start: [null] } },
      { layout: { start: ['ä'] } }]) {
      const r = await put(annaPhone, body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.deepEqual(r.body, { ok: false, error: 'invalid_layout' });
    }
    assert.deepEqual((await get(annaPhone)).body, before);
  });

  it('layout: null removes the stored layout (back to the apps\' default order)', async () => {
    await put(annaPhone, { layout: LAYOUT }).expect(200);
    assert.deepEqual((await put(annaPhone, { layout: null }).expect(200)).body, { ok: true, updatedAt: null });
    assert.deepEqual((await get(annaTab)).body, { ok: true, scope: 'user', editable: true, layout: null, updatedAt: null });
  });

  it('a stored layout is cleaned again when read (never trusted blindly)', async () => {
    H.db().prepare("INSERT INTO client_layouts (key, user_id, layout, updated_at) VALUES (?, ?, ?, '2026-10-18T10:00:00.000Z')")
      .run(`user:${anna}`, anna, JSON.stringify({ start: ['bad id'] }));
    assert.deepEqual((await get(annaPhone)).body, { ok: true, scope: 'user', editable: true, layout: null, updatedAt: null });
  });

  it('control event `layout` to the person\'s other open streams — not the saving device, not other people', async () => {
    const s = await openAll([annaPhone, annaTab, benPhone]);
    try {
      const r = await put(annaPhone, { layout: LAYOUT }).expect(200);
      await settle(s);
      assert.deepEqual(layoutEvents(s.get(annaTab)), [{ type: 'layout', scope: 'user', updated_at: r.body.updatedAt }]);
      assert.equal(s.get(annaTab).events.find((e) => e.event === 'control').id, undefined, 'no SSE id');
      assert.deepEqual(layoutEvents(s.get(annaPhone)), []);
      assert.deepEqual(layoutEvents(s.get(benPhone)), []);
      // a refused save sends nothing
      await put(annaTab, { layout: 'x' }).expect(400);
      await settle(s);
      assert.equal(layoutEvents(s.get(annaPhone)).length, 0);
    } finally { closeAll(s); }
  });
});

describe('scope global: one layout for everybody, administrators change it', () => {
  it('everybody reads it; editable for administrators only; PUT by others → 403 forbidden', async () => {
    await setScope('global').expect(200);
    assert.deepEqual((await get(annaPhone).expect(200)).body, { ok: true, scope: 'global', editable: false, layout: null, updatedAt: null });
    assert.deepEqual((await put(annaPhone, { layout: LAYOUT })).body, { ok: false, error: 'forbidden' });
    assert.equal((await put(annaPhone, { layout: null })).status, 403);
    const r = await put(bossPhone, { layout: LAYOUT }).expect(200);
    assert.deepEqual((await get(benPhone)).body, { ok: true, scope: 'global', editable: false, layout: LAYOUT, updatedAt: r.body.updatedAt });
    assert.equal((await get(bossPhone)).body.editable, true);
    // the per-person layouts stay stored, but are not used while global applies
    await setScope('user').expect(200);
    assert.equal((await get(benPhone)).body.layout, null);
  });

  it('a save by an administrator reaches every open stream but the saving one', async () => {
    await setScope('global').expect(200);
    const s = await openAll([annaPhone, benPhone, bossPhone]);
    try {
      const r = await put(bossPhone, { layout: LAYOUT }).expect(200);
      await settle(s);
      for (const d of [annaPhone, benPhone]) assert.deepEqual(layoutEvents(s.get(d)), [{ type: 'layout', scope: 'global', updated_at: r.body.updatedAt }]);
      assert.deepEqual(layoutEvents(s.get(bossPhone)), []);
    } finally { closeAll(s); }
  });
});

describe('scope device: the apps keep their own order', () => {
  it('GET: layout null, editable; PUT → 409 device_scope, nothing stored', async () => {
    await setScope('device').expect(200);
    assert.deepEqual((await get(annaPhone).expect(200)).body, { ok: true, scope: 'device', editable: true, layout: null, updatedAt: null });
    assert.deepEqual((await put(annaPhone, { layout: LAYOUT }).expect(409)).body, { ok: false, error: 'device_scope' });
    assert.equal(H.db().prepare('SELECT COUNT(*) AS n FROM client_layouts').get().n, 0);
  });
});

describe('who may call it', () => {
  it('a token without an owner → 403 no_user; no token → 403 token_required; a disabled owner → 403', async () => {
    const loose = tokens.create({ name: 'lay-loose', scopes: ['client'] }, '127.0.0.1').rawToken;
    assert.deepEqual((await supertest(app).get(URL).set('X-API-Token', loose).expect(403)).body, { ok: false, error: 'no_user' });
    assert.equal((await supertest(app).put(URL).set('X-API-Token', loose).send({ layout: LAYOUT }).expect(403)).body.error, 'no_user');
    assert.equal((await agent.get(URL).expect(403)).body.error, 'token_required');
    const disabled = H.makeUser('lay-off', { enabled: 0 });
    const offDev = H.makeDevice(disabled, { name: 'lay-off-phone' });
    assert.equal((await get(offDev)).status, 403);
  });
});

describe('admin setting client_layout_scope', () => {
  it('GET/PUT /api/v1/settings/client-layout: validated, audited; a change reaches every open stream', async () => {
    assert.deepEqual((await agent.get('/api/v1/settings/client-layout').expect(200)).body, { ok: true, data: { scope: 'user', scopes: ['device', 'user', 'global'] } });
    for (const scope of ['', 'team', null, 7]) await setScope(scope).expect(400);
    const s = await openAll([annaPhone, benPhone]);
    try {
      assert.deepEqual((await setScope('global').expect(200)).body, { ok: true, data: { scope: 'global', scopes: ['device', 'user', 'global'] } });
      await settle(s);
      for (const d of [annaPhone, benPhone]) assert.deepEqual(layoutEvents(s.get(d)), [{ type: 'layout', scope: 'global', updated_at: null }]);
      // unchanged → no event, no log entry
      const logs = () => H.db().prepare("SELECT COUNT(*) AS n FROM activity_log WHERE event_type = 'client_layout_scope_updated'").get().n;
      const n = logs();
      await setScope('global').expect(200);
      await settle(s);
      assert.equal(layoutEvents(s.get(annaPhone)).length, 1);
      assert.equal(logs(), n);
    } finally { closeAll(s); }
    const log = H.db().prepare("SELECT message, details FROM activity_log WHERE event_type = 'client_layout_scope_updated' ORDER BY id DESC LIMIT 1").get();
    assert.equal(log.message, 'Client layout scope changed to "global"');
    assert.deepEqual(JSON.parse(log.details), { from: 'user', to: 'global' });
    assert.equal(clientLayout.getScope(), 'global');
    // an unknown stored value falls back to the default
    H.db().prepare("UPDATE settings SET value = 'nope' WHERE key = 'client_layout_scope'").run();
    assert.equal(clientLayout.getScope(), 'user');
  });

  it('session only: an API token is refused', async () => {
    const raw = tokens.create({ name: 'lay-settings', scopes: ['full-access'] }, '127.0.0.1').rawToken;
    await supertest(app).put('/api/v1/settings/client-layout').set('X-API-Token', raw).send({ scope: 'device' }).expect(403);
    assert.equal(clientLayout.getScope(), 'user');
  });

  it('the settings page shows it in Client-Richtlinien (DE + EN)', async () => {
    const page = await agent.get('/settings').expect(200);
    assert.ok(page.text.includes('id="card-client-layout"'));
    assert.ok(page.text.includes('data-st-field="cl-scope"'));
    for (const v of ['device', 'user', 'global']) assert.ok(page.text.includes(`data-value="${v}"`), v);
    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'settings.js'), 'utf8');
    assert.ok(js.includes("'/api/v1/settings/client-layout'"));
    const read = (lang) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'i18n', `${lang}.json`), 'utf8'));
    for (const lang of ['de', 'en']) {
      for (const k of ['st.cl.title', 'st.cl.desc', 'st.cl.scope', 'st.cl.scope_device', 'st.cl.scope_user', 'st.cl.scope_global', 'st.cl.scope_hint', 'error.client_layout.invalid_scope']) {
        assert.ok(read(lang)[k], `${lang} ${k}`);
      }
    }
    assert.equal(read('de')['st.cl.scope_user'], 'Pro Benutzer');
    assert.equal(read('en')['st.cl.scope_global'], 'For everyone');
  });
});
