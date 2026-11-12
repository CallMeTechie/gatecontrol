'use strict';

// The Pi-hole integration is gone (replaced by the DNS protection):
//   - services/piholeRemoval.js purge(): the stored settings (with the
//     instances' passwords) and the token scopes are deleted; an installation
//     that had Pi-hole set up gets one activity entry and a dashboard notice
//   - migration 147 runs it; the server runs it again at every start
//   - the notice: only for administrators, with a link to the plugin, closed
//     for everybody by POST /api/v1/system/notices/pihole-removed/dismiss
//   - outside: /api/v1/pihole/* → 410, permissions.pihole(Control) false,
//     the page /pihole → dashboard, the retired licence key is ignored
// dnsmasq: tests/pihole_removal_dnsmasq.test.js.

const crypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const supertest = require('supertest');
const { setup, teardown, getAgent, getCsrf } = require('./helpers/setup');

let app, agent, csrf, db, removal;
before(async () => {
  ({ app } = await setup());
  agent = getAgent();
  csrf = getCsrf();
  db = require('../src/db/connection').getDb();
  removal = require('../src/services/piholeRemoval');
});
after(() => teardown());

const setting = (key) => { const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key); return r ? r.value : null; };
const put = (key, value) => db.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
const entries = () => db.prepare('SELECT message, severity, source FROM activity_log WHERE event_type = ?').all(removal.EVENT);
const CONFIG = JSON.stringify({
  enabled: true, manage_dns_chain: true, sync_interval_sec: 30,
  instances: [{ id: 'a', label: 'Pi Keller', url: 'http://10.8.0.2:8080', app_password: 'enc:v1:0011223344', dns_ip: '10.8.0.2', dns_port: 5335 }],
});

function oldInstallation(config = CONFIG) {
  if (config) put('pihole_config', config);
  put('pihole_blocking_desired', JSON.stringify({ enabled: false, timer_ends_at: null }));
  put('portal.widget.pihole', '1');
}

describe('purge(): what an installation with Pi-hole still carries', () => {
  it('a fresh database: nothing to do, no entry, no notice', () => {
    assert.deepEqual(removal.purge(db), { configured: false, settings: 0, tokens: 0 });
    assert.equal(setting(removal.NOTICE_KEY), null);
    assert.deepEqual(entries(), []);
    assert.equal(removal.notice(), null);
    assert.equal(db.prepare("SELECT 1 AS x FROM migration_history WHERE name = 'pihole_integration_removed'").get().x, 1, 'migration 147 ran');
  });

  it('Pi-hole was set up: settings and credentials deleted, scopes taken out, one entry, the notice pending', () => {
    oldInstallation();
    const tokens = require('../src/services/tokens');
    const ins = db.prepare("INSERT INTO api_tokens (name, token_hash, scopes) VALUES (?, ?, ?)");
    const a = ins.run('App: phone', 'h-a', JSON.stringify(['client', 'client:services', 'pihole', 'pihole:control'])).lastInsertRowid;
    const b = ins.run('stats script', 'h-b', JSON.stringify(['pihole'])).lastInsertRowid;
    const c = ins.run('untouched', 'h-c', JSON.stringify(['read-only'])).lastInsertRowid;
    db.prepare('INSERT INTO client_enrollment_codes (code_hash, scopes, expires_at) VALUES (?, ?, ?)').run('code-1', JSON.stringify(['client', 'pihole']), Date.now() + 60000);

    assert.deepEqual(removal.purge(db), { configured: true, settings: 3, tokens: 3 });
    for (const key of removal.SETTINGS) assert.equal(setting(key), null, key);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM settings WHERE value LIKE '%enc:v1:0011223344%'").get().n, 0, 'no credential left in the settings');
    const scopes = (id) => JSON.parse(db.prepare('SELECT scopes FROM api_tokens WHERE id = ?').get(id).scopes);
    assert.deepEqual(scopes(a), ['client', 'client:services']);
    assert.deepEqual(scopes(b), [], 'a token that only had Pi-hole rights can do nothing any more');
    assert.deepEqual(scopes(c), ['read-only']);
    assert.equal(db.prepare("SELECT scopes FROM client_enrollment_codes WHERE code_hash = 'code-1'").get().scopes, '["client"]');
    assert.equal(tokens.checkScope(scopes(b), '/api/v1/dashboard/stats', 'GET'), false);

    assert.equal(setting(removal.NOTICE_KEY), '1');
    const log = entries();
    assert.equal(log.length, 1);
    assert.equal(log[0].severity, 'warning');
    assert.match(log[0].message, /^The Pi-hole integration was removed/);

    // again (the next start of the server): nothing more happens
    assert.deepEqual(removal.purge(db), { configured: false, settings: 0, tokens: 0 });
    assert.equal(entries().length, 1, 'the entry is written once');
    db.prepare("DELETE FROM api_tokens WHERE token_hash IN ('h-a', 'h-b', 'h-c')").run();
    db.prepare("DELETE FROM client_enrollment_codes WHERE code_hash = 'code-1'").run();
  });

  it('rows of an installation that never set Pi-hole up are deleted without a notice', () => {
    removal.dismiss();
    db.prepare('DELETE FROM activity_log WHERE event_type = ?').run(removal.EVENT);
    oldInstallation(JSON.stringify({ enabled: false, manage_dns_chain: true, instances: [] }));
    assert.deepEqual(removal.purge(db), { configured: false, settings: 3, tokens: 0 });
    assert.equal(setting('pihole_config'), null);
    assert.equal(setting(removal.NOTICE_KEY), null);
    assert.deepEqual(entries(), []);
    // only the portal switch was ever stored
    put('portal.widget.pihole', '0');
    assert.deepEqual(removal.purge(db), { configured: false, settings: 1, tokens: 0 });
    assert.deepEqual(entries(), []);
  });

  it('what counts as "set up": switched on, or an instance entered — an unreadable row too', () => {
    assert.equal(removal.wasConfigured(null), false);
    assert.equal(removal.wasConfigured('{"enabled":false,"instances":[]}'), false);
    assert.equal(removal.wasConfigured('{"enabled":true,"instances":[]}'), true);
    assert.equal(removal.wasConfigured('{"enabled":false,"instances":[{"id":"a"}]}'), true);
    assert.equal(removal.wasConfigured('{broken'), true);
  });

  it('the server start runs it (a restored backup from before the removal), and never throws', () => {
    oldInstallation();
    const r = removal.atStart();
    assert.equal(r.configured, true);
    assert.equal(setting('pihole_config'), null);
    assert.equal(setting(removal.NOTICE_KEY), '1');
    const server = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
    assert.ok(server.indexOf("require('./services/piholeRemoval').atStart()") > server.indexOf('runMigrations()'), 'after the migrations');
    assert.match(server, /chain\.refresh\(\); chain\.start\(\);/, 'and the DNS chain is refreshed at every start');
    const backup = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'backup.js'), 'utf8');
    assert.match(backup, /require\('\.\/piholeRemoval'\)\.purge\(db\)/, 'a restore does not bring the credentials back');
  });
});

describe('the dashboard notice', () => {
  it('administrators see it with a link to the plugin catalogue; closing it is for everybody and for good', async () => {
    assert.deepEqual(removal.notice(), { installed: false, href: '/settings/plugins/catalog/gatecontrol-dns' });
    const page = await agent.get('/dashboard').expect(200);
    assert.match(page.text, /id="db-pihole-removed"/);
    assert.match(page.text, /Die Pi-hole-Anbindung wurde entfernt|The Pi-hole integration was removed/);
    assert.match(page.text, /<a href="\/settings\/plugins\/catalog\/gatecontrol-dns" class="db-btn db-btn-primary">/);
    assert.match(page.text, /id="db-pihole-removed-dismiss"/);

    await supertest(app).post('/api/v1/system/notices/pihole-removed/dismiss').expect((r) => assert.ok([401, 403].includes(r.status)));
    assert.equal(setting(removal.NOTICE_KEY), '1', 'not without a session');
    await agent.post('/api/v1/system/notices/pihole-removed/dismiss').set('X-CSRF-Token', csrf).send({}).expect(200);
    assert.equal(setting(removal.NOTICE_KEY), null);
    assert.equal(removal.notice(), null);
    assert.doesNotMatch((await agent.get('/dashboard').expect(200)).text, /id="db-pihole-removed"/);
    // the next start does not bring it back
    removal.atStart();
    assert.equal(removal.notice(), null);
  });

  it('an installation that never had Pi-hole never sees it; the script handles the button', () => {
    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'dashboard.js'), 'utf8');
    assert.match(js, /\/api\/v1\/system\/notices\/pihole-removed\/dismiss/);
    for (const lang of ['de', 'en']) {
      const s = require(`../src/i18n/${lang}.json`);
      for (const k of ['title', 'text', 'open_plugin', 'open_catalog', 'dismiss', 'dismiss_failed']) assert.ok(s['dashboard.pihole_removed.' + k], `${lang}: ${k}`);
      const left = Object.keys(s).filter((k) => /pihole/i.test(k) && !k.startsWith('dashboard.pihole_removed.'));
      assert.deepEqual(left, [], `${lang}: no other Pi-hole string is left`);
    }
  });
});

describe('to the outside', () => {
  it('the old API: 410 with a code, for a session and for an API token; the settings API is gone', async () => {
    for (const url of ['/api/v1/pihole/summary', '/api/v1/pihole/history', '/api/v1/pihole/top-domains', '/api/v1/pihole/top-clients', '/api/v1/pihole/query-types', '/api/v1/pihole/health']) {
      const r = await agent.get(url).expect(410);
      assert.deepEqual({ ok: r.body.ok, code: r.body.code }, { ok: false, code: 'pihole_removed' }, url);
    }
    assert.equal((await agent.post('/api/v1/pihole/blocking').set('X-CSRF-Token', csrf).send({ enabled: false }).expect(410)).body.code, 'pihole_removed');
    await agent.get('/api/v1/settings/pihole').expect(404);
    for (const url of ['/api/v1/portal/pihole', '/api/v1/portal/pihole/owner', '/api/v1/portal/pihole/household']) {
      assert.equal((await agent.get(url)).status, 404, url);
    }
  });

  it('the apps: permissions.pihole and piholeControl stay in the answer and are false, whatever the token says', async () => {
    require('../src/services/license')._overrideForTest({ api_tokens: true });
    const tokens = require('../src/services/tokens');
    const raw = tokens.create({ name: 'old app', scopes: ['full-access'] }, '127.0.0.1').rawToken;
    const r = await supertest(app).get('/api/v1/client/permissions').set('X-API-Token', raw).expect(200);
    assert.equal(r.body.permissions.pihole, false);
    assert.equal(r.body.permissions.piholeControl, false);
    assert.equal((await supertest(app).get('/api/v1/pihole/summary').set('X-API-Token', raw).expect(410)).body.code, 'pihole_removed');
    assert.throws(() => tokens.create({ name: 'x', scopes: ['client', 'pihole'] }, '127.0.0.1'), /Scope no longer exists: pihole/);
    assert.ok(!tokens.VALID_SCOPES.includes('pihole') && !tokens.VALID_SCOPES.includes('pihole:control'));
  });

  it('the pages: /pihole leads to the dashboard, the navigation and the settings have no Pi-hole entry', async () => {
    assert.equal((await agent.get('/pihole').expect(302)).headers.location, '/dashboard');
    assert.equal((await agent.get('/settings/pihole').expect(302)).headers.location, '/settings');
    const dash = (await agent.get('/dashboard').expect(200)).text;
    assert.doesNotMatch(dash, /href="\/pihole"|id="db-sec-pihole"/);
    const st = (await agent.get('/settings/portal').expect(200)).text;
    assert.doesNotMatch(st, /data-section="pihole"|id="st-ph-|id="st-w-pihole"/);
  });

  it('licences issued with pihole_integration stay valid: the retired key is simply not taken over', () => {
    const license = require('../src/services/license');
    try {
      license._applyLicenseForTest({ plan: 'pro', features: { pihole_integration: true, webhooks: true, vpn_peers: 50 } });
      assert.equal(license.getPlan(), 'pro');
      assert.equal(license.hasFeature('webhooks'), true);
      assert.equal(license.hasFeature('pihole_integration'), false);
      assert.ok(!('pihole_integration' in license.getFeatures()));
      assert.ok(!('pihole_integration' in license.featureSources()));
      assert.ok(!('pihole_integration' in license.lockedFeatures()));
      assert.ok(!('pihole_integration' in license.COMMUNITY_FALLBACK));
    } finally {
      license._applyLicenseForTest(null);
    }
  });
});
