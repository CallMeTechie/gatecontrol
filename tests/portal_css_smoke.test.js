'use strict';
const crypto = require('crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const { setup, teardown } = require('./helpers/setup');

let app;
beforeEach(async () => {
  await setup();
  app = require('../src/app').createApp();
});
afterEach(teardown);

test('GET /css/portal.css returns 200', async () => {
  await supertest(app).get('/css/portal.css').expect(200);
});

test('portal.css contains dark and light theme token blocks', async () => {
  const res = await supertest(app).get('/css/portal.css').expect(200);
  assert.ok(res.text.includes('[data-theme="dark"]'), 'missing dark theme block');
  assert.ok(res.text.includes('[data-theme="light"]'), 'missing light theme block');
});

test('portal.css contains the TP2a per-device DNS-protection widget, with the enriched donut widget', async () => {
  const res = await supertest(app).get('/css/portal.css').expect(200);
  // TP2a re-adds the per-device Pi-hole widget (the "DNS-Schutz" card) deliberately.
  assert.ok(res.text.includes('.c-pihole'), 'missing .c-pihole — TP2a per-device DNS widget styles');
  // Task 2 replaces the bar with a block-rate donut.
  assert.ok(res.text.includes('.donut'), 'missing .donut — enriched Pi-hole donut styling');
});

test('portal.css contains JS-state rules (moved from portal.js inline injector for CSP safety)', async () => {
  const res = await supertest(app).get('/css/portal.css').expect(200);
  // Core rules that were previously injected as a <style> element (blocked by CSP)
  assert.ok(res.text.includes('.portal-fallback'), 'missing .portal-fallback rule');
  assert.ok(res.text.includes('gc-shimmer'), 'missing gc-shimmer keyframe animation');
  assert.ok(res.text.includes('.c-services.loading'), 'missing .c-services.loading min-height rule');
  assert.ok(res.text.includes('.portal-error-state'), 'missing .portal-error-state rule');
  assert.ok(res.text.includes('.portal-empty'), 'missing .portal-empty rule');
});

test('portal.js does NOT inject a <style> element (CSP-clean)', async () => {
  // The inline style injector was removed; all state CSS now lives in portal.css.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'js', 'portal.js'), 'utf8'
  );
  assert.ok(!src.includes("createElement('style')"),
    "portal.js must not inject a <style> element — it would be blocked by the page CSP");
});
