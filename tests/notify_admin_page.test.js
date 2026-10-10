'use strict';

// Notification centre, admin page (docs/feature-notification-center.md,
// "Portal und Admin-Oberfläche"): /notifications renders for admins only,
// carries its i18n island and the licence flag, the sidebar lists it under
// System, Settings → Benachrichtigungen links there instead of the old event
// matrix, the notify.* strings are complete in DE and EN (one block, right
// before support_bundles.*), and the pure helpers of public/js/notifications.js
// do what the page relies on. The admin API itself belongs to the backend PR;
// the browser scenario (tests/e2e/scenarios/09-notifications.js) serves it
// through route mocking.

const crypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const argon2 = require('argon2');
const supertest = require('supertest');
const { setup, teardown, getAgent } = require('./helpers/setup');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const de = require('../src/i18n/de.json');
const en = require('../src/i18n/en.json');
const N = require('../public/js/notifications.js');

let app, agent, db, license;
before(async () => {
  ({ app } = await setup());
  agent = getAgent();
  db = require('../src/db/connection').getDb();
  license = require('../src/services/license');
});
after(() => teardown());

async function loginAs(username, role) {
  const hash = await argon2.hash('Plain!Pass1234', require('../src/utils/argon2Options'));
  db.prepare('INSERT INTO users (username, password_hash, role, self_service_enabled) VALUES (?, ?, ?, ?)').run(username, hash, role, role === 'user' ? 1 : 0);
  const a = supertest.agent(app);
  const page = await a.get('/login').expect(200);
  const csrf = page.text.match(/name="_csrf"\s+value="([^"]+)"/)[1];
  await a.post('/login').type('form').send({ username, password: 'Plain!Pass1234', _csrf: csrf }).expect(302);
  return a;
}
function island(html, id) {
  const m = new RegExp(`<script type="application/json" id="${id}"[^>]*>([\\s\\S]*?)</script>`).exec(html);
  assert.ok(m, `#${id} island present`);
  return { raw: m[1], data: JSON.parse(m[1]) };
}

describe('/notifications: route and roles', () => {
  it('renders for an admin with tabs, panels, script and the strings island', async () => {
    const res = await agent.get('/notifications').expect(200);
    assert.match(res.text, /id="nc-page"/);
    for (const tab of N.TABS) {
      assert.match(res.text, new RegExp(`id="nc-tab-${tab}"[^>]*role="tab"|role="tab"[^>]*id="nc-tab-${tab}"`), tab + ' tab');
      assert.match(res.text, new RegExp(`id="nc-panel-${tab}" role="tabpanel" aria-labelledby="nc-tab-${tab}"`), tab + ' panel');
    }
    assert.match(res.text, /<script src="\/js\/notifications\.js\?v=/);
    const i18n = island(res.text, 'nc-i18n');
    assert.doesNotMatch(i18n.raw, /</, 'no raw < inside the island');
    assert.ok(Object.keys(i18n.data).every((k) => k.startsWith('notify.') || k.startsWith('common.')));
    assert.ok([de['notify.tab.rules'], en['notify.tab.rules']].includes(i18n.data['notify.tab.rules']));
    assert.match(res.text, /<a href="\/notifications" class="nav-item active">/, 'sidebar entry active');
    assert.match(res.text, /<title>(Benachrichtigungen|Notifications) — /);
  });

  it('the licence flag (email_alerts) reaches the page and locks the composer without it', async () => {
    let res = await agent.get('/notifications').expect(200);
    assert.equal(island(res.text, 'nc-ctx').data.pro, true);
    assert.match(res.text, /data-pro="1"/);
    assert.doesNotMatch(res.text, /<fieldset class="nc-fieldset" id="nc-send-fields" disabled>/);
    license._overrideForTest({ email_alerts: false });
    try {
      res = await agent.get('/notifications').expect(200);
      assert.equal(island(res.text, 'nc-ctx').data.pro, false);
      assert.match(res.text, /<fieldset class="nc-fieldset" id="nc-send-fields" disabled>/);
      assert.match(res.text, /data-license-hint="email_alerts"/);
    } finally {
      license._overrideForTest({ email_alerts: true });
    }
  });

  it('a member is sent to /profile, a guest to the login', async () => {
    const a = await loginAs('notify-page-member', 'user');
    const page = await a.get('/notifications');
    assert.equal(page.status, 302);
    assert.equal(page.headers.location, '/profile');
    const guest = await supertest(app).get('/notifications');
    assert.equal(guest.status, 302);
    assert.match(guest.headers.location, /\/login/);
  });

  it('the sidebar lists Benachrichtigungen first in System', async () => {
    const res = await agent.get('/dashboard').expect(200);
    const nav = res.text.slice(res.text.indexOf('<nav class="sidebar"'), res.text.indexOf('</nav>', res.text.indexOf('<nav class="sidebar"')));
    const system = nav.slice(nav.indexOf(`>${de['nav.system']}</div>`));
    const hrefs = Array.from(system.matchAll(/<a href="([^"]+)" class="nav-item/g)).map((m) => m[1]);
    assert.deepEqual(hrefs, ['/notifications', '/logs', '/settings']);
    assert.match(nav, /<span class="nav-badge amber" id="nc-nav-badge" hidden><\/span>/);
  });
});

describe('Settings → Benachrichtigungen', () => {
  it('links to the notification centre instead of the event matrix; recipient, checks and webhooks stay', async () => {
    const res = await agent.get('/settings').expect(200);
    const at = res.text.indexOf('<section class="st-section" data-section="benachrichtigungen"');
    assert.ok(at > 0);
    const sec = res.text.slice(at, res.text.indexOf('<section class="st-section" data-section="webhooks"', at));
    assert.match(sec, /<a class="st-btn st-btn-primary" href="\/notifications#rules" id="st-notify-link">/);
    assert.doesNotMatch(sec, /st-matrix|st-al-events/, 'the matrix is gone');
    assert.match(sec, /id="st-al-email"/, 'recipient stays');
    assert.match(sec, /id="st-al-backup"/, 'monitoring checks stay');
    assert.match(res.text, /id="st-wh-list"/, 'webhooks section stays');
    assert.match(res.text, /id="st-catalogue"/, 'the catalogue still feeds the webhook dialog');
  });

  it('settings.js no longer builds the matrix nor sends events from there', () => {
    const js = read('public/js/settings.js');
    assert.doesNotMatch(js, /st-matrix-body|al-events|renderHookCounts/);
    assert.match(js, /const ALERT_MAP = \{ email: 'al-email', backup_reminder_days:/);
  });
});

describe('i18n: notify.* strings', () => {
  const keysOf = (loc) => Object.keys(loc).filter((k) => k.startsWith('notify.'));

  it('DE and EN carry the same notify.* keys with the same placeholders', () => {
    assert.deepEqual(keysOf(de), keysOf(en));
    assert.ok(keysOf(de).length > 250);
    const ph = (s) => (String(s).match(/\{\{\s*\w+\s*\}\}/g) || []).sort().join();
    for (const k of keysOf(de)) {
      assert.ok(String(de[k]).trim() && String(en[k]).trim(), k + ' not empty');
      assert.equal(ph(de[k]), ph(en[k]), k + ' placeholders');
    }
    assert.equal(de['nav.notifications'], 'Benachrichtigungen');
    assert.equal(en['nav.notifications'], 'Notifications');
  });

  it('one block directly before the first support_bundles.* key, in both files', () => {
    for (const [name, loc] of [['de', de], ['en', en]]) {
      const keys = Object.keys(loc);
      const first = keys.findIndex((k) => k.startsWith('support_bundles.'));
      const block = keys.filter((k) => k.startsWith('notify.') || k === 'nav.notifications');
      const start = keys.indexOf(block[0]);
      assert.deepEqual(keys.slice(start, start + block.length), block, name + ': contiguous');
      assert.equal(start + block.length, first, name + ': right before support_bundles.*');
    }
  });

  it('every key the template asks for exists', () => {
    const njk = read('templates/aurora/pages/notifications.njk');
    const used = new Set();
    for (const m of njk.matchAll(/t\('((?:notify|nav|common)\.[a-z0-9_.]+)'\)/g)) used.add(m[1]);
    for (const m of njk.matchAll(/'(notify\.[a-z0-9_.]+[a-z0-9_])'/g)) used.add(m[1]);
    for (const tg of ['all', 'users', 'groups', 'devices']) used.add('notify.send.target.' + tg);
    for (const f of N.FILTERS) used.add('notify.hist.f.' + f);
    for (const p of N.PRIORITIES) used.add('notify.prio.' + p);
    for (const g of N.GROUPS) used.add('notify.group.' + g);
    for (const k of used) {
      assert.ok(k in de, 'de: ' + k);
      assert.ok(k in en, 'en: ' + k);
    }
  });

  it('dynamic keys of the script exist (tabs, sources, states, priorities)', () => {
    const want = [];
    N.TABS.forEach((t) => want.push('notify.sub.' + t, 'notify.tab.' + t));
    N.SOURCES.concat(['manual']).forEach((s) => want.push('notify.source.' + s));
    N.DEVICE_STATES.forEach((s) => want.push('notify.dev.state.' + s));
    N.PRIORITIES.forEach((p) => want.push('notify.prio_hint.' + p));
    ['off', 'silent', 'normal'].forEach((r) => want.push('notify.ed.recovery_' + r));
    ['users', 'groups', 'devices'].forEach((t) => want.push('notify.send.pick_' + t));
    ['d', 'h', 'min'].forEach((u) => want.push('notify.time.' + u + '_one', 'notify.time.' + u + '_other'));
    ['direct', 'tunnel'].forEach((v) => want.push('notify.dev.via.' + v));
    for (const k of want) assert.ok(k in de && k in en, k);
  });
});

describe('notifications.js: static checks', () => {
  const js = read('public/js/notifications.js');
  const code = js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');

  it('builds the DOM without innerHTML and talks only to /api/v1/notify', () => {
    assert.doesNotMatch(code, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    const urls = Array.from(code.matchAll(/request\('(?:GET|POST|PUT)', '([^']+)'/g)).map((m) => m[1]);
    assert.ok(urls.length > 5);
    assert.ok(urls.every((u) => u.startsWith('/api/v1/notify/')), urls.join(' '));
  });

  it('listens to gc:push_presence, gc:notify and gc:reconnected; events.js forwards both types', () => {
    for (const ev of ['gc:push_presence', 'gc:notify', 'gc:reconnected']) assert.ok(js.includes(`'${ev}'`), ev);
    const list = read('public/js/events.js').match(/\[([^\]]*'routes'[^\]]*)\]\.forEach/);
    assert.ok(list && /'push_presence'/.test(list[1]) && /'notify'/.test(list[1]));
  });

  it('the styles live in §10 of app.css', () => {
    const css = read('public/css/app.css');
    const at = css.indexOf('\n * §10 Notification centre (nc-)');
    assert.ok(at > 0);
    for (const sel of ['.nc-kpis', '.nc-split', '.nc-aside', '.nc-table-wrap', '.nc-phone', '.nc-state', '.nav-badge.amber']) {
      assert.ok(css.indexOf(sel, at) > at, sel);
    }
    assert.match(css.slice(at), /@media \(max-width:1100px\)\{\s*\.nc-split\{flex-direction:column/);
  });
});

describe('notifications.js: pure helpers', () => {
  it('parseHash / hashFor', () => {
    assert.deepEqual(N.parseHash(''), { tab: 'overview', id: '' });
    assert.deepEqual(N.parseHash('#rules'), { tab: 'rules', id: '' });
    assert.deepEqual(N.parseHash('#rules/plugin%3Ax%3Ay'), { tab: 'rules', id: 'plugin:x:y' });
    assert.deepEqual(N.parseHash('#history/107'), { tab: 'history', id: '107' });
    assert.deepEqual(N.parseHash('#devices/5'), { tab: 'devices', id: '' });
    assert.deepEqual(N.parseHash('#nope'), { tab: 'overview', id: '' });
    assert.equal(N.hashFor('overview'), '');
    assert.equal(N.hashFor('rules', 'plugin:x'), '#rules/plugin%3Ax');
    assert.equal(N.hashFor('history', 9), '#history/9');
  });

  it('normRule + ruleDiff: only changed fields, recipients compared as sets', () => {
    const r = N.normRule({ event_id: 'gateway_offline', group: 'peers', label: 'Gateway offline', priority: 'critical',
      recipients: { admins: 1, users: [3, 1], groups: [] }, ch_app: 1, ch_email: true, ch_webhook: 0, email_fallback_s: 600, enabled: 1 });
    assert.equal(r.ch_app, true);
    assert.equal(r.ch_webhook, false);
    assert.equal(r.recovery, 'off');
    const d = N.copyRule(r);
    assert.deepEqual(N.ruleDiff(r, d), {});
    d.recipients.users = [1, 3];
    assert.deepEqual(N.ruleDiff(r, d), {}, 'order of ids does not matter');
    d.priority = 'high';
    d.recipients.groups.push(7);
    d.bundle_s = 900;
    assert.deepEqual(N.ruleDiff(r, d), { priority: 'high', recipients: { admins: true, owner: false, subscribers: false, users: [1, 3], groups: [7] }, bundle_s: 900 });
    assert.deepEqual(r.recipients.groups, [], 'copyRule does not share arrays');
    assert.equal(N.normRule({ event_id: 'x', priority: 'bogus', group: 'bogus' }).priority, 'normal');
  });

  it('ruleMatches / groupRules / ruleLocked', () => {
    const rules = [
      N.normRule({ event_id: 'cert_expiring', group: 'routes', label: 'Zertifikat läuft ab' }),
      N.normRule({ event_id: 'login_failed', group: 'security', label: 'Fehlgeschlagene Logins' }),
      N.normRule({ event_id: 'plugin:skoda:charging', group: 'plugins', label: 'Laden abgeschlossen', plugin_id: 'skoda' }),
    ];
    assert.equal(N.ruleMatches(rules[0], 'zertifikat lauft', ''), true, 'diacritics folded');
    assert.equal(N.ruleMatches(rules[0], 'cert', 'security'), false);
    assert.deepEqual(N.groupRules(rules).map((g) => g.group), ['security', 'routes', 'plugins']);
    assert.equal(N.ruleLocked(rules[2], false), true);
    assert.equal(N.ruleLocked(rules[2], true), false);
    assert.equal(N.ruleLocked(rules[1], false), false);
  });

  it('recipientParts names users and groups, unknown ids keep a #id', () => {
    const parts = N.recipientParts({ admins: true, owner: true, users: [3, 99], groups: [7] }, [{ id: 3, name: 'Sabine' }], [{ id: 7, name: 'IT' }]);
    assert.deepEqual(parts, [
      { kind: 'admins' }, { kind: 'owner' },
      { kind: 'user', id: 3, name: 'Sabine' }, { kind: 'user', id: 99, name: '#99' },
      { kind: 'group', id: 7, name: 'IT' },
    ]);
    assert.equal(N.hasRecipient({}), false);
    assert.equal(N.hasRecipient({ subscribers: true }), true);
  });

  it('statusOf / histStatusOf', () => {
    assert.equal(N.statusOf({ silent: true, total: 3, delivered: 3 }).key, 'notify.status.silent');
    assert.deepEqual(N.statusOf({ total: 2, delivered: 2, read: 2 }), { key: 'notify.status.read', params: { read: 2, total: 2 }, tone: 'good' });
    assert.equal(N.statusOf({ total: 5, delivered: 4, read: 1 }).tone, 'warn');
    assert.equal(N.statusOf({ total: 0 }).key, null);
    assert.deepEqual(N.histStatusOf({ total: 5, delivered: 4, status: 'waiting' }), { key: 'notify.hist.status_waiting', params: { delivered: 4, total: 5, n: 1 }, tone: 'warn' });
    assert.equal(N.histStatusOf({ total: 5, delivered: 3, status: 'partial' }).tone, 'crit');
    assert.equal(N.histStatusOf({ total: 3, delivered: 3, read: 3, status: 'ok' }).key, 'notify.status.read');
    assert.equal(N.histStatusOf({ total: 3, delivered: 3, read: 1 }).key, 'notify.hist.status_ok');
    assert.equal(N.histStatusOf({ total: 3, delivered: 1 }).key, 'notify.hist.status_waiting', 'no status: open deliveries wait');
  });

  it('durationOf / spanOf / choicesWith / latencyNumber', () => {
    assert.deepEqual(N.durationOf(12000), { key: 'notify.dur.s', params: { n: 12 } });
    assert.deepEqual(N.durationOf(134 * 60000), { key: 'notify.dur.h_min', params: { h: 2, m: 14 } });
    assert.deepEqual(N.durationOf(6 * 3600000), { key: 'notify.dur.h', params: { n: 6 } });
    assert.deepEqual(N.durationOf(50 * 3600000), { key: 'notify.dur.d', plural: true, params: { count: 2 } });
    assert.equal(N.spanOf(0), null);
    assert.deepEqual(N.spanOf(600), { key: 'notify.time.min', plural: true, params: { count: 10 } });
    assert.deepEqual(N.spanOf(7200), { key: 'notify.time.h', plural: true, params: { count: 2 } });
    assert.deepEqual(N.spanOf(45), { key: 'notify.time.s', params: { n: 45 } });
    assert.deepEqual(N.choicesWith([0, 60, 120], 90), [0, 60, 90, 120]);
    assert.deepEqual(N.choicesWith([0, 60], 60), [0, 60]);
    assert.equal(N.latencyNumber(400, 'de'), '0,4');
    assert.equal(N.latencyNumber(400, 'en'), '0.4');
    assert.equal(N.latencyNumber(12500, 'en'), '13');
  });

  it('reachOf counts devices now / later per target; groups are resolved by the server', () => {
    const devs = [
      { token_id: 1, state: 'connected', user: { id: 1 } }, { token_id: 2, state: 'restricted', user: { id: 1 } },
      { token_id: 3, state: 'offline', user: { id: 3 } }, { token_id: 4, state: 'unsupported', user: { id: 3 } },
    ];
    assert.deepEqual(N.reachOf(devs, { type: 'all', ids: [] }), { known: true, now: 2, later: 1, total: 3 });
    assert.deepEqual(N.reachOf(devs, { type: 'users', ids: [3] }), { known: true, now: 0, later: 1, total: 1 });
    assert.deepEqual(N.reachOf(devs, { type: 'devices', ids: ['1', 4] }), { known: true, now: 1, later: 0, total: 1 });
    assert.equal(N.reachOf(devs, { type: 'groups', ids: [7] }).known, false);
  });

  it('ttlChoices offers tonight 23:00 only when it is at least 30 min away', () => {
    const at = (h, m) => { const d = new Date(2026, 9, 10, h, m, 0, 0); return d; };
    const evening = N.ttlChoices(at(17, 30));
    assert.equal(evening[0].kind, 'tonight');
    assert.equal(evening[0].ttl, 5.5 * 3600);
    assert.deepEqual(evening.slice(1).map((c) => c.ttl), N.TTL_CHOICES);
    assert.equal(N.ttlChoices(at(22, 40))[0].kind, 'span');
  });

  it('sendBody trims and caps, all-target sends no ids', () => {
    const b = N.sendBody({ type: 'all', ids: [1] }, { title: '  Hi  ', body: 'x'.repeat(1200), priority: 'urgent', ttl_s: 0 });
    assert.deepEqual(b.target, { type: 'all', ids: [] });
    assert.equal(b.title, 'Hi');
    assert.equal(b.body.length, 1000);
    assert.equal(b.priority, 'normal');
    assert.equal(b.ttl_s, 86400);
    assert.deepEqual(N.sendBody({ type: 'users', ids: [3, 3, { id: 1 }] }, { title: 't' }).target, { type: 'users', ids: [3, 1] });
  });

  it('historyQuery / sourceKind / settings helpers', () => {
    assert.equal(N.historyQuery({}), '?filter=all&days=7&limit=50');
    assert.equal(N.historyQuery({ filter: 'important', days: 30, before: 101 }), '?filter=important&days=30&limit=50&before=101');
    assert.equal(N.historyQuery({ filter: 'x', days: 9 }), '?filter=all&days=7&limit=50');
    assert.deepEqual(N.sourceKind('security'), { key: 'notify.source.security' });
    assert.deepEqual(N.sourceKind('manual'), { key: 'notify.source.manual' });
    assert.deepEqual(N.sourceKind('plugin:gatecontrol-skoda'), { plugin: 'gatecontrol-skoda' });
    assert.deepEqual(N.sourceKind('WAF'), { text: 'WAF' });
    const s = N.normSettings({ enabled: 1, allow_direct: false, retention_h: '72', max_queue: 200 });
    assert.equal(s.enabled, true);
    assert.equal(s.retention_h, 72);
    assert.equal(s.history_days, null);
    assert.deepEqual(N.settingsDiff(s, Object.assign({}, s, { retention_h: 48, enabled: false })), { enabled: false, retention_h: 48 });
    assert.equal(N.rangeError('25', 5, 300), null);
    assert.deepEqual(N.rangeError('1', 5, 300), { min: 5, max: 300 });
    assert.deepEqual(N.rangeError('2.5', 0, 9), { min: 0, max: 9 });
    assert.deepEqual(N.rangeError('', 0, 9), { min: 0, max: 9 });
  });
});
