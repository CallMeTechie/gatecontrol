'use strict';

// Start tiles in the apps (docs/plugins.md "Portal" → "Start tiles",
// src/services/plugins/clientTiles.js, src/routes/api/client/tiles.js): the
// portalTiles hook of plugins with `permissions.portal`, asked for the device
// token's owner exactly like for the portal (portalVisible, sections, 1.5 s
// per plugin, ≤ 8 tiles, sanitised), with a stable key per tile.

const crypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const supertest = require('supertest');
const { helloPackage, HELLO } = require('./helpers/plugins');
const { setup, teardown, getCsrf } = require('./helpers/setup');
const H = require('./helpers/notify');

let app, agent, csrf, runtime, plugins, portal, clientTiles, anna, annaDev, annaEn, adminId, other;
const API = '/api/v1/plugins';
const LIST = '/api/v1/client/tiles';
const KEY_RE = /^[a-z0-9-]+\/[A-Za-z0-9._~-]*\/[A-Za-z0-9._~-]*$/;
const helloManifest = JSON.parse(fs.readFileSync(path.join(HELLO, 'plugin.json'), 'utf8'));

// "hello-sec": no tab of its own, sections in "Zuhause" and "Fahrzeug"; "hello-np": no portal permission
function sectionOverrides() {
  const ui = JSON.parse(JSON.stringify(helloManifest.ui));
  ui.portal = { sections: [{ id: 'garden', tab: 'home', title: { de: 'Garten', en: 'Garden' }, order: 30 }, { id: 'garage', tab: 'car', title: 'Garage' }] };
  return { id: 'hello-sec', name: { de: 'Hallo Abschnitt', en: 'Hello section' }, ui };
}
function noPortalOverrides() {
  const permissions = JSON.parse(JSON.stringify(helloManifest.permissions));
  delete permissions.portal;
  const ui = JSON.parse(JSON.stringify(helloManifest.ui));
  delete ui.portal;
  return { id: 'hello-np', name: 'Ohne Portal', permissions, ui };
}

async function install(buf) {
  const r = await agent.post(API + '/inspect').set('X-CSRF-Token', csrf).set('Content-Type', 'application/octet-stream').send(buf).expect(200);
  assert.equal(r.body.canInstall, true, JSON.stringify(r.body.checks));
  await agent.post(API + '/install').set('X-CSRF-Token', csrf).send({ token: r.body.token, accept: true }).expect(200);
}
const kv = (id, key, value) => agent.post(`${API}/${id}/api/kv`).set('X-CSRF-Token', csrf).send({ key, value }).expect(200);
const list = (dev, q = {}) => supertest(app).get(LIST).query(q).set('X-API-Token', dev.raw);

const SEC_TILES = [
  { section: 'garden', title: 'Restmüll', value: 'morgen', icon: 'M4 4h16' },
  { section: 'garage', title: 'Akku', value: 81, unit: '%', state: 'good' },
  { title: 'Akku', value: 1 }, // same title, no section → another key
  { section: 'nope', title: 'Unsichtbar' }, // a section the plugin does not have
];

before(async () => {
  ({ app, agent } = await setup());
  csrf = getCsrf();
  runtime = require('../src/services/plugins/runtime');
  plugins = require('../src/services/plugins');
  portal = require('../src/services/plugins/portal');
  clientTiles = require('../src/services/plugins/clientTiles');
  adminId = H.db().prepare("SELECT id FROM users WHERE username = 'admin'").get().id;
  anna = H.makeUser('ct-anna', { language: 'de' });
  other = H.makeUser('ct-other', { language: 'de' });
  annaDev = H.makeDevice(anna, { name: 'ct-anna-phone' });
  annaEn = H.makeDevice(H.makeUser('ct-en', { language: 'en' }), { name: 'ct-en-phone' });
  await install(helloPackage());
  await install(helloPackage({ overrides: sectionOverrides() }));
  await install(helloPackage({ overrides: noPortalOverrides() }));
  for (const id of ['hello', 'hello-sec', 'hello-np']) assert.equal(await runtime.waitRunning(id), true, id);
  await kv('hello-sec', 'portal-tiles', SEC_TILES);
  await kv('hello-np', 'portal-tiles', [{ title: 'Nicht erlaubt' }]);
});
after(async () => { await plugins.stop(); teardown(); });

describe('GET /api/v1/client/tiles', () => {
  it('declarative tiles of every plugin the viewer sees in the portal, sanitised and capped', async () => {
    await kv('hello', 'portal-tiles', [
      { title: 'Ladestand', value: 81, unit: '%', state: 'good', icon: 'M4 12h16' },
      { title: '$app' },
      { title: 'Heizung', value: 'an', state: 'dim', icon: '<script>alert(1)</script>' },
      { title: 'A\u0000B\u0007C', value: 'V'.repeat(100), unit: 'U'.repeat(30) },
      { title: 'T'.repeat(100), icon: 'M' + '1 '.repeat(999) },
      { title: '' },
      { title: 'Ladestand', value: 'dup' }, // same section + title: dropped
      null,
      'x',
      { title: 'neunte' }, { title: 'zehnte' }, // beyond 8 per plugin
    ]);
    const r = await list(annaDev).expect(200);
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.equal(r.body.ok, true);
    const mine = r.body.tiles.filter((t) => t.plugin === 'hello');
    const by = (title) => mine.find((t) => t.title === title);
    assert.deepEqual(by('Ladestand'), { key: 'hello//Ladestand', plugin: 'hello', pluginName: 'Hallo Welt', section: null, title: 'Ladestand', value: '81', unit: '%', state: 'good', icon: 'M4 12h16', items: [] });
    assert.ok(by(`v${anna} true/true/true de`), 'the token owner as portal viewer, logged in, from the app');
    assert.deepEqual([by('Heizung').state, by('Heizung').icon], [null, null]);
    const ctl = by('A B C');
    assert.deepEqual([ctl.value.length, ctl.unit.length], [40, 12]);
    const long = by('T'.repeat(60));
    assert.equal(long.icon.length, 1999, 'icons up to 2000 path characters');
    assert.equal(mine.filter((t) => t.title === 'Ladestand').length, 1, 'duplicate keys dropped');
    assert.ok(!by('neunte') && !by('zehnte') && !by(''), 'at most 8 per plugin, empty titles dropped');
    assert.deepEqual(mine.map((t) => t.title).length, 5);
    for (const t of r.body.tiles) {
      assert.deepEqual(Object.keys(t), ['key', 'plugin', 'pluginName', 'section', 'title', 'value', 'unit', 'state', 'icon', 'items']);
      assert.match(t.key, KEY_RE);
    }

    const sec = r.body.tiles.filter((t) => t.plugin === 'hello-sec');
    assert.deepEqual(sec.map((t) => [t.section, t.title, t.pluginName]), [['garden', 'Restmüll', 'Hallo Abschnitt'], ['garage', 'Akku', 'Hallo Abschnitt'], [null, 'Akku', 'Hallo Abschnitt']]);
    assert.ok(!r.body.tiles.some((t) => t.title === 'Unsichtbar'), 'a tile naming an unknown section is dropped');
    assert.ok(!r.body.tiles.some((t) => t.plugin === 'hello-np'), 'a plugin without permissions.portal is never asked');
  });

  it('keys: "<plugin>/<section>/<title>", URL-safe, deterministic, distinct', async () => {
    const a = (await list(annaDev).expect(200)).body.tiles.filter((t) => t.plugin === 'hello-sec');
    const b = (await list(annaDev).expect(200)).body.tiles.filter((t) => t.plugin === 'hello-sec');
    assert.deepEqual(a.map((t) => t.key), b.map((t) => t.key), 'the same keys on every call');
    assert.match(a[0].key, /^hello-sec\/garden\/Restmull~[0-9a-f]{10}$/);
    assert.equal(a[1].key, 'hello-sec/garage/Akku');
    assert.equal(a[2].key, 'hello-sec//Akku');
    assert.equal(new Set(a.map((t) => t.key)).size, a.length);

    const { tileKey, KEY_MAX } = clientTiles;
    assert.equal(tileKey('hello', null, 'Akku'), 'hello//Akku');
    assert.notEqual(tileKey('p', '', 'Restmüll'), tileKey('p', '', 'Restmull'), 'a lossy form never meets the plain one');
    assert.notEqual(tileKey('p', '', 'Müll'), tileKey('p', '', 'Mull~x'));
    assert.notEqual(tileKey('p', '', 'a b'), tileKey('p', '', 'a-b'));
    assert.match(tileKey('p', '', '🚗 / ?#&%'), /^p\/\/~[0-9a-f]{10}$/);
    const long = tileKey('x'.repeat(64), 's'.repeat(40), 'Sehr langer Titel '.repeat(10));
    assert.ok(long.length <= KEY_MAX && KEY_MAX <= 200, String(long.length));
    assert.match(long, KEY_RE);
    assert.equal(long, tileKey('x'.repeat(64), 's'.repeat(40), 'Sehr langer Titel '.repeat(10)));
    assert.notEqual(tileKey('p', '', 'T'.repeat(60)), tileKey('p', '', 'T'.repeat(59)), 'cut titles stay distinct');
  });

  it('only what the portal would show this viewer (portalVisible per tab and section)', async () => {
    await kv('hello', 'portal-tiles', [{ title: 'Ladestand' }]);
    await kv('hello', 'portal-viewers', [other]);
    await kv('hello-sec', 'section-viewers', [other]);
    try {
      const r = await list(annaDev).expect(200);
      assert.deepEqual(r.body.tiles, [], 'tab and sections hidden for this viewer → no tiles');
      const dev = H.makeDevice(other, { name: 'ct-other-phone' });
      const o = await list(dev).expect(200);
      assert.deepEqual(o.body.tiles.map((t) => t.key).sort(), ['hello-sec//Akku', 'hello-sec/garage/Akku', o.body.tiles.find((t) => t.section === 'garden').key, 'hello//Ladestand'].sort());
    } finally {
      await kv('hello', 'portal-viewers', null);
      await kv('hello-sec', 'section-viewers', null);
    }
  });

  it('language: ?lang, else the owner\'s setting', async () => {
    await kv('hello', 'portal-tiles', [{ title: '$app' }]);
    const tile = (r) => r.body.tiles.find((t) => t.plugin === 'hello');
    const en = await list(annaEn).expect(200);
    assert.equal(tile(en).pluginName, 'Hello World');
    assert.match(tile(en).title, / en$/);
    assert.match(tile(await list(annaEn, { lang: 'de' }).expect(200)).title, / de$/);
    assert.match(tile(await list(annaDev, { lang: ['en', 'de'] }).expect(200)).title, / de$/, 'an array is not a language');
    assert.match(tile(await list(annaDev).set('Accept-Language', 'en').expect(200)).title, / de$/, 'the owner\'s setting wins over the header');
  });

  it('a slow, throwing or garbage-answering plugin only loses its own tiles', async () => {
    await kv('hello', 'portal-tiles', [{ title: 'A' }]);
    try {
      for (const mode of ['slow', 'throw', 'garbage']) {
        await kv('hello', 'portal-mode', mode);
        const t0 = Date.now();
        const r = await list(annaDev).expect(200);
        assert.ok(Date.now() - t0 < 4500, `${mode}: answered after the timeout, not after the plugin`);
        assert.deepEqual([...new Set(r.body.tiles.map((t) => t.plugin))], ['hello-sec'], mode);
      }
    } finally {
      await kv('hello', 'portal-mode', null);
    }
  });

  it('a disabled plugin is not asked', async () => {
    await agent.post(`${API}/hello-sec/disable`).set('X-CSRF-Token', csrf).expect(200);
    try {
      const r = await list(annaDev).expect(200);
      assert.ok(!r.body.tiles.some((t) => t.plugin === 'hello-sec'));
      assert.ok(r.body.tiles.some((t) => t.plugin === 'hello'));
    } finally {
      await agent.post(`${API}/hello-sec/enable`).set('X-CSRF-Token', csrf).expect(200);
      assert.equal(await runtime.waitRunning('hello-sec'), true);
    }
  });

  it('the portal\'s own Start tiles are unchanged (no section key, icons ≤ 600)', async () => {
    await kv('hello', 'portal-tiles', [{ title: 'Groß', icon: 'M' + '1 '.repeat(400) }, { title: 'Klein', icon: 'M4 4h16' }]);
    const t = await portal.tiles({ id: anna, name: 'ct-anna', role: 'user', portal: true, loggedIn: true }, 'de');
    const mine = t.filter((x) => x.plugin === 'hello');
    assert.deepEqual(mine.map((x) => [x.title, x.icon, 'section' in x]), [['Groß', null, false], ['Klein', 'M4 4h16', false]]);
    assert.deepEqual(Object.keys(mine[1]).sort(), ['anchor', 'area', 'goto', 'icon', 'plugin', 'state', 'title', 'unit', 'value']);
    const app = (await list(annaDev).expect(200)).body.tiles.find((x) => x.title === 'Groß');
    assert.equal(app.icon.length, 801);
  });
});

describe('tile items (apps only)', () => {
  const LOCK = 'M6 10V7a6 6 0 0 1 12 0v3';
  const ITEMS = [
    { label: 'Ladestand', icon: 'M4 4h16', value: 81, unit: '%', state: 'good' },
    { label: 'Reichweite', icon: 'M2 2h4', value: 312, unit: 'km' },
    { label: 'Verriegelt', icon: LOCK, state: 'good' },
  ];
  const SANITISED = [
    { label: 'Ladestand', value: 81, unit: '%', icon: 'M4 4h16', state: 'good' },
    { label: 'Reichweite', value: 312, unit: 'km', icon: 'M2 2h4', state: null },
    { label: 'Verriegelt', value: null, unit: null, icon: LOCK, state: 'good' },
  ];

  it('sanitizeItems: the rules of a widget reading without an id; invalid items dropped, ≤ 4, always a list', () => {
    const { sanitizeItems } = clientTiles;
    assert.deepEqual(sanitizeItems(ITEMS), SANITISED);
    assert.deepEqual(sanitizeItems([{ label: 'Abholung', value: 'morgen', id: 'x', extra: 1 }]), [{ label: 'Abholung', value: 'morgen', unit: null, icon: null, state: null }], 'no id, unknown keys dropped');
    const it0 = sanitizeItems([{ label: 'L\u0000' + 'l'.repeat(40), value: 'V'.repeat(30), unit: 'U'.repeat(20), icon: 'M' + '1 '.repeat(999), state: 'crit' }])[0];
    assert.deepEqual([it0.label.length, it0.label.slice(0, 3), it0.value.length, it0.unit.length, it0.icon.length, it0.state], [20, 'L l', 16, 8, 1999, 'crit']);
    for (const bad of [
      null, 'x', 42, [], {}, { label: '' }, { value: 1 }, { label: 'A' }, { label: 'A', value: NaN }, { label: 'A', value: '' }, { label: 'A', icon: '<svg>' }, { label: 'A', value: true }, { label: ['A'], value: 1 },
    ]) assert.deepEqual(sanitizeItems([bad, { label: 'ok', value: 1 }]).map((x) => x.label), ['ok'], JSON.stringify(bad));
    assert.equal(sanitizeItems([{ label: 'A', value: 1, state: 'neutral' }])[0].state, null);
    const six = Array.from({ length: 6 }, (_, i) => ({ label: 'I' + i, value: i }));
    assert.deepEqual(sanitizeItems(six).map((x) => x.label), ['I0', 'I1', 'I2', 'I3']);
    assert.deepEqual(sanitizeItems([null, null, ...six]).length, 4);
    for (const v of [undefined, null, 'x', 42, {}, { 0: ITEMS[0] }]) assert.deepEqual(sanitizeItems(v), [], JSON.stringify(v));
    assert.equal(clientTiles.MAX_ITEMS, 4);
  });

  it('GET /api/v1/client/tiles: items on every tile ([] without); the portal ignores them', async () => {
    await kv('hello', 'portal-tiles', [
      { title: 'Familienauto', value: '81 % · 312 km', icon: 'M4 4h16', items: [...ITEMS, { label: 'kaputt' }, { label: 'Fünfte', value: 5 }, { label: 'Sechste', value: 6 }] },
      { title: 'Ohne', value: 1 },
      { title: 'Müll', items: 'x' },
    ]);
    const r = await list(annaDev).expect(200);
    const by = (title) => r.body.tiles.find((t) => t.plugin === 'hello' && t.title === title);
    assert.deepEqual(by('Familienauto').items, [...SANITISED, { label: 'Fünfte', value: 5, unit: null, icon: null, state: null }], 'invalid one dropped, then the first 4 valid');
    assert.equal(by('Familienauto').value, '81 % · 312 km', 'value stays');
    assert.deepEqual(by('Ohne').items, []);
    assert.deepEqual(by('Müll').items, []);
    for (const t of r.body.tiles) assert.ok(Array.isArray(t.items), t.key);

    const p = await portal.tiles({ id: anna, name: 'ct-anna', role: 'user', portal: true, loggedIn: true }, 'de');
    const car = p.find((x) => x.plugin === 'hello' && x.title === 'Familienauto');
    assert.equal(car.value, '81 % · 312 km');
    assert.ok(!('items' in car), 'the portal\'s answer has no items');
    assert.deepEqual(Object.keys(car).sort(), ['anchor', 'area', 'goto', 'icon', 'plugin', 'state', 'title', 'unit', 'value']);
  });
});

describe('auth', () => {
  it('401 without a token, 403 for a session and for tokens without the client scope', async () => {
    await supertest(app).get(LIST).expect(401);
    assert.equal((await agent.get(LIST).expect(403)).body.error, 'token_required');
    const peersOnly = H.makeDevice(anna, { name: 'ct-peers', scopes: ['peers'] });
    await list(peersOnly).expect(403);
    const ro = H.makeDevice(adminId, { name: 'ct-ro', scopes: ['read-only'] });
    assert.equal((await list(ro).expect(403)).body.error, 'scope_required');
  });

  it('full-access tokens work like client tokens', async () => {
    await kv('hello', 'portal-tiles', [{ title: '$app' }]);
    const dev = H.makeDevice(adminId, { name: 'ct-full', scopes: ['full-access'] });
    const r = await list(dev).expect(200);
    assert.ok(r.body.tiles.some((t) => t.plugin === 'hello' && t.title.startsWith(`v${adminId} `)));
  });

  it('a token without an owner: no tiles (a disabled owner: none either)', async () => {
    const dev = H.makeDevice(null, { name: 'ct-noowner', app: false });
    assert.deepEqual((await list(dev).expect(200)).body, { ok: true, tiles: [] });
    const off = H.makeUser('ct-off', { enabled: 0 });
    const r = await list(H.makeDevice(off, { name: 'ct-off-phone' }));
    assert.ok(r.status === 403 || (r.status === 200 && r.body.tiles.length === 0), `${r.status} ${JSON.stringify(r.body)}`);
  });
});
