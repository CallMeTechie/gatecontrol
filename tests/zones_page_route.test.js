'use strict';

// /routes always renders the domain-zones page (aurora/pages/zones.njk),
// with the route-page locals. The legacy list, its /routes/legacy path and
// the PUT /api/v1/zones/ui-mode switch are gone.

const crypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown, getAgent, getCsrf } = require('./helpers/setup');

let agent, csrf, db;
// Stored personal themes from before the Aurora-only release must not matter.
const STORED = ['default', 'pro', 'aurora'];

before(async () => {
  await setup();
  agent = getAgent();
  csrf = getCsrf();
  db = require('../src/db/connection').getDb();
});
after(teardown);

const useTheme = (theme) => db.prepare('UPDATE users SET theme = ? WHERE username = ?').run(theme, 'admin');

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

test('/routes renders zones.njk with activeNav routes and the route-page locals', async () => {
  const cap = captureRender();
  try {
    for (const stored of STORED) {
      useTheme(stored);
      await agent.get('/routes').expect(200);
      const last = cap.seen.at(-1);
      assert.equal(last.view, 'aurora/pages/zones.njk', `users.theme=${stored}`);
      assert.equal(last.locals.activeNav, 'routes');
      assert.ok(Array.isArray(last.locals.gatewayPools));
      assert.ok(Array.isArray(last.locals.l4BlockedPorts));
    }
  } finally {
    cap.restore();
    useTheme('aurora');
  }
});

test('/routes serves the zones page without legacy markup or scripts', async () => {
  try {
    for (const theme of STORED) {
      useTheme(theme);
      const res = await agent.get('/routes').expect(200);
      assert.match(res.text, /id="zn-zones"/, `${theme}: zones container`);
      assert.match(res.text, /id="zn-add-domain"/, `${theme}: add-domain button`);
      assert.doesNotMatch(res.text, /id="routes-list"|id="btn-add-route"|id="zn-legacy-link"|\/routes\/legacy/, `${theme}: no legacy page`);
      assert.doesNotMatch(res.text, /\/js\/routes\.js|\/js\/printerPresetForm\.js/, `${theme}: no legacy scripts`);
    }
  } finally {
    useTheme('aurora');
  }
});

test('the legacy page, its scripts and the page switch API are gone', async () => {
  await agent.get('/routes/legacy').expect(404);
  await agent.get('/js/routes.js').expect(404);
  await agent.get('/js/printerPresetForm.js').expect(404);
  const res = await agent.put('/api/v1/zones/ui-mode').set('X-CSRF-Token', csrf).send({ mode: 'legacy' });
  assert.equal(res.status, 404);
});
