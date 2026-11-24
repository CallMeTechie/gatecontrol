'use strict';

// The built-in Remote Desktops is gone (docs/feature-remote-access.md "Remote Desktops removed"): no menu entry,
// no page, no admin API, no core answers for the old app API — only the plugin „Fernzugriff“. Here WITHOUT the
// plugin: the apps get the answer of a server without the feature, old links lead to the plugin's catalogue page,
// and the old rows stay (also through a backup and its restore) for the plugin to take over.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const { setup, teardown } = require('./helpers/setup');

let app, agent, db, token;
const UNAVAILABLE = { ok: false, error: 'Remote Desktop feature not available', code: 'remote_plugin_required', plugin: 'gatecontrol-remote' };

before(async () => {
  ({ app, agent } = await setup());
  db = require('../src/db/connection').getDb();
  db.prepare("INSERT INTO rdp_routes (id, name, host, port, protocol, enabled) VALUES (41, 'Altbestand-PC', '10.8.0.41', 3389, 'rdp', 1)").run();
  token = require('../src/services/tokens').create({ name: 'rdp-removed-app', scopes: ['full-access'] }, '127.0.0.1').rawToken;
});

after(() => teardown());

const app2 = () => ({
  get: (p) => supertest(app).get(p).set('X-API-Token', token),
  post: (p) => supertest(app).post(p).set('X-API-Token', token),
  patch: (p) => supertest(app).patch(p).set('X-API-Token', token),
  del: (p) => supertest(app).delete(p).set('X-API-Token', token),
});

describe('the old app API without the plugin', () => {
  it('every endpoint of /api/v1/client/rdp answers 403 remote_plugin_required, also for an existing old row', async () => {
    const a = app2();
    for (const req of [a.get('/api/v1/client/rdp'), a.get('/api/v1/client/rdp/41/status'), a.get('/api/v1/client/rdp/41/connect'),
      a.post('/api/v1/client/rdp/41/browser-session'), a.post('/api/v1/client/rdp/41/session'),
      a.patch('/api/v1/client/rdp/41/session'), a.del('/api/v1/client/rdp/41/session')]) {
      const r = await req.expect(403);
      assert.deepEqual(r.body, UNAVAILABLE);
    }
  });
  it('the four calls of the Windows app: 403 for an app token; the rest of /api/v1/rdp is gone (410)', async () => {
    const a = app2();
    for (const req of [a.get('/api/v1/rdp/status'), a.post('/api/v1/rdp/41/wol'), a.get('/api/v1/rdp/41/status'), a.get('/api/v1/rdp/41/wol/status')]) {
      assert.deepEqual((await req.expect(403)).body, UNAVAILABLE);
    }
    for (const req of [a.post('/api/v1/rdp/41/sessions/disconnect-all'), a.get('/api/v1/rdp/pubkey'), a.get('/api/v1/rdp/41/credentials')]) {
      assert.equal((await req.expect(410)).body.code, 'moved_to_plugin');
    }
    for (const p of ['/api/v1/rdp', '/api/v1/rdp/status', '/api/v1/rdp/41', '/api/v1/rdp/history']) {
      const r = await agent.get(p).expect(410);
      assert.deepEqual(r.body, { ok: false, code: 'moved_to_plugin', plugin: 'gatecontrol-remote' });
    }
  });
});

describe('the page and the menu', () => {
  it('/rdp and /rdp/:id/session lead to the plugin in the catalogue (Settings → Plugins without it)', async () => {
    const legacy = require('../src/services/plugins/legacy');
    const want = legacy.movedPage('gatecontrol-remote');
    assert.match(want, /^\/settings\/plugins(\/catalog\/gatecontrol-remote)?$/);
    assert.equal((await agent.get('/rdp').expect(302)).headers.location, want);
    assert.equal((await agent.get('/rdp/41/session').expect(302)).headers.location, want);
  });
  it('no menu entry, no template, no page scripts', async () => {
    const html = (await agent.get('/dashboard').expect(200)).text;
    assert.doesNotMatch(html, /href="\/rdp"/);
    const fs = require('node:fs');
    const path = require('node:path');
    for (const f of ['templates/aurora/pages/rdp.njk', 'public/js/rdp.js', 'public/js/rdp-history.js', 'public/js/rdp-cred-omission.js', 'public/js/rdp-form-logic.js']) {
      assert.equal(fs.existsSync(path.join(__dirname, '..', f)), false, f);
    }
    // the session page and its player stay: the plugin's sessions use them
    for (const f of ['templates/aurora/pages/rdp-session.njk', 'public/js/rdp-player.js']) {
      assert.equal(fs.existsSync(path.join(__dirname, '..', f)), true, f);
    }
  });
  it('the dashboard offers the plugin; the data is kept until then', async () => {
    const legacy = require('../src/services/plugins/legacy');
    const mv = legacy.pendingMoves().find((m) => m.pluginId === 'gatecontrol-remote');
    assert.ok(mv && !mv.installed, 'the install notice');
    assert.deepEqual(mv.counts, { routes: 1, sessions: 0, maintenance: 0 });
    const html = (await agent.get('/dashboard').expect(200)).text;
    assert.match(html, /data-builtin-moved="gatecontrol-remote"/);
    assert.doesNotMatch(html, /data-builtin-pending=/);
  });
});

describe('the old stock in backups', () => {
  it('a backup carries the old rows, its restore puts them back and marks the restore for the take-over', async () => {
    const backup = require('../src/services/backup');
    const settings = require('../src/services/settings');
    const b = JSON.parse(JSON.stringify(await backup.createBackup()));
    assert.ok(b.data.rdp_routes.some((r) => r.name === 'Altbestand-PC'));
    db.prepare('DELETE FROM rdp_routes').run();
    settings.set('plugins.legacy_restored.remote', '');
    await backup.restoreBackup(b);
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM rdp_routes WHERE name = 'Altbestand-PC'").get().c, 1);
    assert.ok(Date.parse(settings.get('plugins.legacy_restored.remote')) > Date.now() - 60000, 'restore marked');
  });
});
