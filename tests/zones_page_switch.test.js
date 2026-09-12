'use strict';

// /routes ↔ /routes/legacy page switching (setting ui_zones_page). The
// zones.njk templates ship in another branch, so the template CHOICE is
// asserted by capturing res.render; the legacy page is rendered for real.

const crypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown, getAgent } = require('./helpers/setup');

let agent, settings, pageRouter;
const THEMES = ['default', 'pro', 'aurora'];

before(async () => {
  await setup();
  agent = getAgent();
  settings = require('../src/services/settings');
  pageRouter = require('../src/routes/index');
});
after(teardown);

function captureRender() {
  const express = require('express');
  const orig = express.response.render;
  const seen = [];
  express.response.render = function render(view, locals) {
    seen.push({ view, locals });
    this.status(200).json({ view });
  };
  return { seen, restore: () => { express.response.render = orig; } };
}

test('the legacy list renders at /routes/legacy and at /routes when switched off', async () => {
  settings.set('ui_zones_page', 'false');
  await agent.get('/routes/legacy').expect(200);
  await agent.get('/routes').expect(200);
});

test('/routes picks zones.njk by setting; /routes/legacy always routes.njk; same locals', async () => {
  const cap = captureRender();
  try {
    for (const t of THEMES) pageRouter.__test.setZonesPageExists(t, true);

    settings.set('ui_zones_page', 'true');
    await agent.get('/routes').expect(200);
    let last = cap.seen.at(-1);
    assert.match(last.view, /\/pages\/zones\.njk$/);
    assert.equal(last.locals.activeNav, 'routes');
    assert.ok(Array.isArray(last.locals.gatewayPools));
    assert.ok(Array.isArray(last.locals.l4BlockedPorts));

    await agent.get('/routes/legacy').expect(200);
    last = cap.seen.at(-1);
    assert.match(last.view, /\/pages\/routes\.njk$/);
    assert.equal(last.locals.activeNav, 'routes');
    assert.ok(Array.isArray(last.locals.gatewayPools));
    assert.ok(Array.isArray(last.locals.l4BlockedPorts));

    settings.set('ui_zones_page', 'false');
    await agent.get('/routes').expect(200);
    assert.match(cap.seen.at(-1).view, /\/pages\/routes\.njk$/);

    // Default (setting absent) is on.
    require('../src/db/connection').getDb().prepare("DELETE FROM settings WHERE key = 'ui_zones_page'").run();
    await agent.get('/routes').expect(200);
    assert.match(cap.seen.at(-1).view, /\/pages\/zones\.njk$/);

    // A theme without pages/zones.njk keeps the legacy list.
    for (const t of THEMES) pageRouter.__test.setZonesPageExists(t, false);
    await agent.get('/routes').expect(200);
    assert.match(cap.seen.at(-1).view, /\/pages\/routes\.njk$/);
  } finally {
    cap.restore();
  }
});
