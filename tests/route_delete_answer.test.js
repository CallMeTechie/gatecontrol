'use strict';

// Deleting a route (docs/feature-domain-zones.md, "Löschen"): the row goes at
// once, the answer waits for the Caddy sync only up to
// config.caddy.answerBudgetMs — later it is 202 { ok, pending } and the sync
// finishes in the background. A failed sync restores the row (as before) and
// says so on the routes event: { route_id, sync: 'failed' }.
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

describe('route delete: answer budget and a sync that fails afterwards', () => {
  let db, routes, eventBus, config, app, request, logger;
  let syncDelay = 0;
  let failSync = false;
  const events = [];
  const listener = (evt) => { if (evt.type === 'routes') events.push(evt.payload); };
  let port = 6100;
  const makeRoute = () => routes.create({
    route_type: 'l4', l4_protocol: 'tcp', l4_listen_port: String(port++), l4_tls_mode: 'none', target_ip: '10.8.0.80', target_port: 22,
  }, { skipSync: true });
  const exists = (id) => !!db.prepare('SELECT 1 FROM routes WHERE id = ?').get(id);
  const until = async (fn, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await new Promise((r) => setTimeout(r, 10)); } return false; };

  before(() => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-route-delete-'));
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
    // The API handler alone, without the app's auth: DELETE /:id of routes.js.
    const express = require('express');
    app = express();
    app.use((req, res, next) => { req.t = (k) => k; next(); });
    const router = require('../src/routes/api/routes');
    const layer = router.stack.find((l) => l.route && l.route.path === '/:id' && l.route.methods.delete);
    app.delete('/routes/:id', ...layer.route.stack.map((s) => s.handle));
    request = require('supertest');
  });

  after(() => { eventBus.unsubscribe(listener); });

  it('a sync within the budget: 200, no pending', async () => {
    syncDelay = 0; failSync = false;
    config.caddy.answerBudgetMs = 1000;
    const r = await makeRoute();
    const res = await request(app).delete('/routes/' + r.id);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body, { ok: true });
    assert.equal(exists(r.id), false);
  });

  it('a slow sync: 202 { pending } at the budget, the row is already gone, the sync completes', async () => {
    syncDelay = 400; failSync = false;
    config.caddy.answerBudgetMs = 50;
    const r = await makeRoute();
    const t0 = Date.now();
    const res = await request(app).delete('/routes/' + r.id);
    assert.equal(res.status, 202, JSON.stringify(res.body));
    assert.deepEqual(res.body, { ok: true, pending: true });
    assert.ok(Date.now() - t0 < 350, 'answered before the sync ended: ' + (Date.now() - t0) + ' ms');
    assert.equal(exists(r.id), false, 'the row is deleted at once');
    await new Promise((r2) => setTimeout(r2, 500));
    assert.equal(exists(r.id), false, 'and stays deleted after the sync');
  });

  it('a slow sync that fails afterwards: the row comes back, the routes event says sync failed', async () => {
    syncDelay = 200; failSync = true;
    config.caddy.answerBudgetMs = 30;
    const errors = [];
    const origError = logger.error.bind(logger);
    logger.error = (obj, msg) => { errors.push(msg); return origError(obj, msg); };
    try {
      const r = await makeRoute();
      events.length = 0;
      const res = await request(app).delete('/routes/' + r.id);
      assert.equal(res.status, 202, JSON.stringify(res.body));
      assert.equal(exists(r.id), false);
      assert.ok(await until(() => exists(r.id)), 'the row is restored after the failed sync');
      assert.ok(await until(() => events.some((e) => e.route_id === r.id && e.sync === 'failed')), 'routes event with sync failed: ' + JSON.stringify(events));
      assert.ok(await until(() => errors.some((m) => /after the answer/.test(m))), 'logged: ' + JSON.stringify(errors));
    } finally { logger.error = origError; }
  });

  it('a sync that fails within the budget: the error answer as before, the row is back', async () => {
    syncDelay = 0; failSync = true;
    config.caddy.answerBudgetMs = 1000;
    const r = await makeRoute();
    const res = await request(app).delete('/routes/' + r.id);
    assert.equal(res.status, 502, JSON.stringify(res.body));
    assert.equal(res.body.ok, false);
    assert.equal(exists(r.id), true);
  });

  it('budget 0: always waits for the sync (the old behaviour)', async () => {
    syncDelay = 150; failSync = false;
    config.caddy.answerBudgetMs = 0;
    const r = await makeRoute();
    const t0 = Date.now();
    const res = await request(app).delete('/routes/' + r.id);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(Date.now() - t0 >= 140, 'waited for the sync');
  });

  it('an unknown route: 404-style error, no 202', async () => {
    config.caddy.answerBudgetMs = 50;
    const res = await request(app).delete('/routes/999999');
    assert.notEqual(res.status, 202);
    assert.equal(res.body.ok, false);
  });
});
