'use strict';

// Notification center in the portal (docs/feature-notification-center.md
// "Portal"): the bell and the two pages (#mitteilungen, #benachrichtigungen)
// exist only for a signed-in person while push is on; the portal API under
// /api/v1/portal/me/notify works with the portal session; portal.js uses
// only strings that exist in both languages.

const crypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const fs = require('node:fs');
const path = require('node:path');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const { setup, teardown } = require('./helpers/setup');
const H = require('./helpers/notify');
const config = require('../config/default');

const HOME = `home.${config.dns.domain}`;
let app, anna, phone, adminId;

before(async () => {
  ({ app } = await setup());
  adminId = H.db().prepare("SELECT id FROM users WHERE username = 'admin'").get().id;
  anna = H.makeUser('pn-anna', { language: 'de' });
  phone = H.makeDevice(anna, { name: 'pn-phone' });
});
after(() => { require('../src/services/notify/stream')._resetForTest(); teardown(); });

function portalAgent(ip) {
  const a = supertest.agent(app);
  return {
    get: (p) => a.get(p).set('Host', HOME).set('X-GC-Portal-Peer-IP', ip),
    post: (p) => a.post(p).set('Host', HOME).set('X-GC-Portal-Peer-IP', ip),
    put: (p) => a.put(p).set('Host', HOME).set('X-GC-Portal-Peer-IP', ip),
  };
}
async function signedIn(dev) {
  const r = await supertest(app).post('/api/v1/client/portal-link').set('Authorization', `Bearer ${dev.raw}`).send({}).expect(200);
  const p = portalAgent(dev.ip);
  await p.get('/auto?t=' + new URL(r.body.url).searchParams.get('t')).expect(302);
  const page = await p.get('/portal').expect(200);
  const ctx = JSON.parse(page.text.match(/id="portal-ctx"[^>]*>([^<]*)</)[1]);
  return { p, html: page.text, ctx };
}

describe('portal page', () => {
  it('signed in + push on: bell, inbox and settings pages (not in the tab bar)', async () => {
    const { html, ctx } = await signedIn(phone);
    assert.equal(ctx.tabs.notify, true);
    assert.match(html, /id="pt-bell" href="#mitteilungen" data-goto="mitteilungen"/);
    assert.ok(html.includes('id="pt-bell-count"'));
    for (const id of ['mitteilungen', 'benachrichtigungen']) {
      assert.match(html, new RegExp(`id="panel-${id}" role="region"[^>]*data-panel="${id}" data-extra hidden`), id);
      assert.ok(!html.includes(`data-tab="${id}"`), `${id} is no tab`);
    }
    for (const id of ['pt-inbox', 'pt-inbox-readall', 'pt-np-topics', 'pt-np-devices', 'pt-np-from', 'pt-np-to', 'pt-np-quiet-on', 'pt-np-critical', 'pt-np-recent', 'pt-devices-notify']) {
      assert.ok(html.includes(`id="${id}"`), id);
    }
    // switches are real checkboxes with role=switch
    assert.equal((html.match(/type="checkbox" role="switch"/g) || []).length, 2);
  });

  it('nothing of it for an anonymous viewer or with push switched off', async () => {
    const anon = await supertest(app).get('/portal').set('Host', HOME).expect(200);
    assert.ok(!anon.text.includes('id="pt-bell"') && !anon.text.includes('panel-mitteilungen'));
    require('../src/services/settings').set('notify.enabled', '0');
    try {
      const { html, ctx } = await signedIn(phone);
      assert.equal(ctx.tabs.notify, false);
      assert.ok(!html.includes('id="pt-bell"') && !html.includes('panel-benachrichtigungen') && !html.includes('pt-devices-notify'));
    } finally { require('../src/services/settings').set('notify.enabled', '1'); }
  });
});

describe('portal API (/api/v1/portal/me/notify)', () => {
  it('prefs, inbox, read and a per-device test with the portal session (CSRF)', async () => {
    H.clearNotifications();
    const n = require('../src/services/notify/hub').sendManual({ userId: adminId, target: { type: 'users', ids: [anna] }, title: 'Hallo Anna', body: '', priority: 'normal', ttlS: null });
    const { p, ctx } = await signedIn(phone);
    const prefs = (await p.get('/api/v1/portal/me/notify/prefs').expect(200)).body;
    assert.ok(prefs.devices.some((d) => d.token_id === phone.tokenId));
    const inbox = (await p.get('/api/v1/portal/me/notify/inbox?limit=5').expect(200)).body;
    assert.deepEqual(inbox.items.map((i) => i.id), [n.id]);
    assert.equal(inbox.unread, 1);
    await p.post('/api/v1/portal/me/notify/read').send({ ids: [n.id] }).expect(403); // CSRF
    await p.post('/api/v1/portal/me/notify/read').set('X-CSRF-Token', ctx.csrf).send({ ids: [n.id] }).expect(200);
    assert.equal((await p.get('/api/v1/portal/me/notify/inbox?limit=5').expect(200)).body.unread, 0);
    const t = await p.post('/api/v1/portal/me/notify/test').set('X-CSRF-Token', ctx.csrf).send({ token_id: phone.tokenId }).expect(200);
    assert.deepEqual(t.body, { ok: true, devices: 1 });
    const r = await p.put('/api/v1/portal/me/notify/prefs').set('X-CSRF-Token', ctx.csrf)
      .send({ quiet_from: '22:30', quiet_to: '06:45', tz: 'Europe/Berlin' }).expect(200);
    assert.equal(r.body.quiet_from, '22:30');
    // … and the device sees the same quiet hours
    const dev = await supertest(app).get('/api/v1/client/push/prefs').set('X-API-Token', phone.raw).expect(200);
    assert.deepEqual(dev.body.quiet, { from: '22:30', to: '06:45', tz: 'Europe/Berlin', critical_bypass: true });
  });
});

describe('portal.js and its strings', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public/js/portal.js'), 'utf8');
  const de = require('../src/i18n/de.json');
  const en = require('../src/i18n/en.json');

  it('every literal portal.* key exists in DE and EN', () => {
    const keys = [...new Set([...src.matchAll(/T\('(portal\.[a-z0-9_.]+[a-z0-9_])'(?! \+)/g)].map((m) => m[1]))];
    assert.ok(keys.length > 50);
    for (const k of keys) assert.ok(de[k] && en[k], k);
  });

  it('the dynamic notify keys exist (topics, device states, priorities, plurals)', () => {
    for (const t of ['security', 'devices', 'services', 'system', 'admin_notice', 'plugin']) assert.ok(de[`portal.notify.topic_desc.${t}`] && en[`portal.notify.topic_desc.${t}`], t);
    for (const s of ['connected', 'restricted', 'offline', 'unsupported']) assert.ok(de[`portal.notify.state.${s}`] && en[`portal.notify.state.${s}`], s);
    for (const s of ['critical', 'high']) assert.ok(de[`portal.notify.prio.${s}`] && en[`portal.notify.prio.${s}`], s);
    for (const s of ['one', 'other']) assert.ok(de[`portal.notify.queued_${s}`] && en[`portal.notify.queued_${s}`], s);
  });

  it('no function is declared twice in the script scope (a second declaration silently wins)', () => {
    const names = [...src.matchAll(/^ {2}function ([A-Za-z0-9_]+)/gm)].map((m) => m[1]);
    const dup = names.filter((n, i) => names.indexOf(n) !== i);
    assert.deepEqual(dup, []);
  });

  it('polls the inbox (no admin stream), only while visible', () => {
    assert.ok(src.includes("var NOTIFY_API = '/api/v1/portal/me/notify'"));
    assert.ok(!src.includes('/api/v1/events') && !src.includes('EventSource'));
    assert.match(src, /setInterval\(function \(\) \{ if \(!doc\.hidden\) poll\(\); \}, POLL_MS\)/);
  });
});
