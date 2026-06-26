'use strict';
const crypto = require('crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown, getAgent, getCsrf } = require('./helpers/setup');

let portalCfg, settings, agent, csrf;

before(async () => {
  const ctx = await setup();
  agent = ctx.agent;
  csrf = ctx.csrfToken;
  settings = require('../src/services/settings');
  portalCfg = require('../src/services/portalConfig');
});
after(teardown);

// ── Part A: unit tests ─────────────────────────────────────────────────────

test('defaults: enabled, all widgets on', () => {
  const c = portalCfg();
  assert.equal(c.enabled, true);
  assert.deepEqual(c.widgets, { device: true, traffic: true, services: true, pihole: true });
});

test('a disabled widget is reflected', () => {
  settings.set('portal.widget.traffic', '0');
  assert.equal(portalCfg().widgets.traffic, false);
});

test('master off is reflected', () => {
  settings.set('portal.enabled', '0');
  assert.equal(portalCfg().enabled, false);
});

// ── Part B: supertest round-trip ───────────────────────────────────────────

test('PUT /api/settings/portal then GET reflects the change', async () => {
  const put = await agent
    .put('/api/v1/settings/portal')
    .set('X-CSRF-Token', csrf)
    .send({ enabled: true, widgets: { device: true, traffic: true, services: false } })
    .expect(200);
  assert.equal(put.body.ok, true);

  const get = await agent.get('/api/v1/settings/portal').expect(200);
  assert.equal(get.body.ok, true);
  assert.equal(get.body.data.widgets.services, false);
  assert.equal(portalCfg().widgets.services, false);
});
