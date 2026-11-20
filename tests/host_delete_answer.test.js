'use strict';

// "Host löschen" (docs/feature-domain-zones.md, "Löschen"): DELETE
// /api/v1/hosts/:id — like DELETE /api/routes/:id the entries go at once and
// the answer waits for the Caddy sync only up to config.caddy.answerBudgetMs;
// later it is 202 { ok, pending } and the sync finishes in the background. A
// failed sync restores every entry (and the host) and says so on the routes
// event, once per entry: { route_id, host_id, sync: 'failed' }.
// POST /api/routes/batch { action: 'delete' } follows the same budget.
//
// Standalone DB; caddyConfig.syncToCaddy is stubbed BEFORE routes loads (it
// captures the reference), so the sync can be slowed down and failed.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

process.env.NODE_ENV = 'test';
process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

describe('host delete: answer budget and a sync that fails afterwards', () => {
  let db, routes, eventBus, config, app, request, logger;
  let syncDelay = 0;
  let failSync = false;
  const events = [];
  const listener = (evt) => { if (evt.type === 'routes') events.push(evt.payload); };
  let port = 6300;
  const makeRoute = () => routes.create({
    route_type: 'l4', l4_protocol: 'tcp', l4_listen_port: String(port++), l4_tls_mode: 'none', target_ip: '10.8.0.81', target_port: 22,
  }, { skipSync: true });
  // A host with two entries.
  const makeHost = async () => {
    const a = await makeRoute();
    const b = await makeRoute();
    const hostId = Number(db.prepare('INSERT INTO service_bundles (name, domain) VALUES (?, ?)').run('nas-' + port, null).lastInsertRowid);
    db.prepare('UPDATE routes SET bundle_id = ? WHERE id IN (?, ?)').run(hostId, a.id, b.id);
    return { hostId, ids: [a.id, b.id] };
  };
  const exists = (id) => !!db.prepare('SELECT 1 FROM routes WHERE id = ?').get(id);
  const hostExists = (id) => !!db.prepare('SELECT 1 FROM service_bundles WHERE id = ?').get(id);
  const until = async (fn, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await new Promise((r) => setTimeout(r, 10)); } return false; };
  const handlers = (router, p, method) => router.stack.find((l) => l.route && l.route.path === p && l.route.methods[method]).route.stack.map((s) => s.handle);

  before(() => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-host-delete-'));
    process.env.GC_DB_PATH = path.join(tmp, 'test.db');
    process.env.GC_DATA_DIR = tmp;
    require('../src/db/migrations').runMigrations();
    const caddy = require('../src/services/caddyConfig');
    caddy.syncToCaddy = async () => {
      if (syncDelay) await new Promise((r) => setTimeout(r, syncDelay));
      if (failSync) throw new Error('Caddy admin API is not reachable — test');
      return true;
    };
    config = require('../config/default');
    db = require('../src/db/connection').getDb();
    routes = require('../src/services/routes');
    eventBus = require('../src/services/eventBus');
    eventBus.subscribe(listener);
    logger = require('../src/utils/logger');
    // The API handlers alone, without the app's auth.
    const express = require('express');
    app = express();
    app.use(express.json());
    app.use((req, res, next) => { req.t = (k) => k; next(); });
    app.delete('/hosts/:id', ...handlers(require('../src/routes/api/domainZones'), '/hosts/:id', 'delete'));
    app.post('/routes/batch', ...handlers(require('../src/routes/api/routes'), '/batch', 'post'));
    request = require('supertest');
  });

  after(() => { eventBus.unsubscribe(listener); });

  it('a sync within the budget: 200, no pending, host and entries gone', async () => {
    syncDelay = 0; failSync = false;
    config.caddy.answerBudgetMs = 1000;
    const h = await makeHost();
    const res = await request(app).delete('/hosts/' + h.hostId);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body, { ok: true });
    assert.equal(hostExists(h.hostId), false);
    h.ids.forEach((id) => assert.equal(exists(id), false));
  });

  it('a slow sync: 202 { pending } at the budget, the entries are already gone, the sync completes', async () => {
    syncDelay = 400; failSync = false;
    config.caddy.answerBudgetMs = 50;
    const h = await makeHost();
    const t0 = Date.now();
    const res = await request(app).delete('/hosts/' + h.hostId);
    assert.equal(res.status, 202, JSON.stringify(res.body));
    assert.deepEqual(res.body, { ok: true, pending: true });
    assert.ok(Date.now() - t0 < 350, 'answered before the sync ended: ' + (Date.now() - t0) + ' ms');
    h.ids.forEach((id) => assert.equal(exists(id), false, 'entries are deleted at once'));
    assert.ok(await until(() => !hostExists(h.hostId)), 'the host goes once the sync is done');
    h.ids.forEach((id) => assert.equal(exists(id), false, 'and the entries stay deleted'));
  });

  it('a slow sync that fails afterwards: every entry comes back, the routes event says sync failed for each', async () => {
    syncDelay = 200; failSync = true;
    config.caddy.answerBudgetMs = 30;
    const errors = [];
    const origError = logger.error.bind(logger);
    logger.error = (obj, msg) => { errors.push(msg); return origError(obj, msg); };
    try {
      const h = await makeHost();
      events.length = 0;
      const res = await request(app).delete('/hosts/' + h.hostId);
      assert.equal(res.status, 202, JSON.stringify(res.body));
      h.ids.forEach((id) => assert.equal(exists(id), false));
      assert.ok(await until(() => h.ids.every(exists)), 'the entries are restored after the failed sync');
      assert.equal(hostExists(h.hostId), true, 'the host is still there');
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM routes WHERE bundle_id = ?').get(h.hostId).n, 2, 'entries back in their host');
      for (const id of h.ids) {
        assert.ok(await until(() => events.some((e) => e.route_id === id && e.sync === 'failed' && e.host_id === h.hostId)), 'routes event with sync failed for ' + id + ': ' + JSON.stringify(events));
      }
      assert.ok(await until(() => errors.some((m) => /Host delete: .*after the answer/.test(m))), 'logged: ' + JSON.stringify(errors));
    } finally { logger.error = origError; }
  });

  it('a sync that fails within the budget: the error answer as before, the entries are back', async () => {
    syncDelay = 0; failSync = true;
    config.caddy.answerBudgetMs = 1000;
    const h = await makeHost();
    const res = await request(app).delete('/hosts/' + h.hostId);
    assert.equal(res.status, 502, JSON.stringify(res.body));
    assert.equal(res.body.ok, false);
    h.ids.forEach((id) => assert.equal(exists(id), true));
    assert.equal(hostExists(h.hostId), true);
  });

  it('budget 0: always waits for the sync (the old behaviour)', async () => {
    syncDelay = 150; failSync = false;
    config.caddy.answerBudgetMs = 0;
    const h = await makeHost();
    const t0 = Date.now();
    const res = await request(app).delete('/hosts/' + h.hostId);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(Date.now() - t0 >= 140, 'waited for the sync');
  });

  it('an unknown host: 404, no 202', async () => {
    config.caddy.answerBudgetMs = 50;
    const res = await request(app).delete('/hosts/999999');
    assert.equal(res.status, 404);
    assert.equal(res.body.ok, false);
  });

  it('batch delete: 200 within the budget, 202 { pending } after it, a later failure restores the rows', async () => {
    syncDelay = 0; failSync = false;
    config.caddy.answerBudgetMs = 1000;
    const a = await makeRoute();
    let res = await request(app).post('/routes/batch').send({ action: 'delete', ids: [a.id] });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body, { ok: true, affected: 1 });

    syncDelay = 200; failSync = true;
    config.caddy.answerBudgetMs = 30;
    const b = await makeRoute();
    const c = await makeRoute();
    events.length = 0;
    res = await request(app).post('/routes/batch').send({ action: 'delete', ids: [b.id, c.id] });
    assert.equal(res.status, 202, JSON.stringify(res.body));
    assert.deepEqual(res.body, { ok: true, pending: true, affected: 2 });
    assert.equal(exists(b.id), false);
    assert.ok(await until(() => exists(b.id) && exists(c.id)), 'rows restored');
    assert.ok(await until(() => [b.id, c.id].every((id) => events.some((e) => e.route_id === id && e.sync === 'failed'))), JSON.stringify(events));
  });

  it('batch delete of unknown ids: 404 as before, no 202', async () => {
    config.caddy.answerBudgetMs = 50;
    const res = await request(app).post('/routes/batch').send({ action: 'delete', ids: [999998] });
    assert.equal(res.status, 404, JSON.stringify(res.body));
  });
});
