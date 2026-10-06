'use strict';
// Portal redesign "variant A" (tabs): layout invariants of the template, the
// stylesheet and the script.
const fs = require('fs');
const crypto = require('crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const { setup, teardown } = require('./helpers/setup');
const config = require('../config/default');

let app;
beforeEach(async () => { await setup(); require('../src/services/license')._overrideForTest({ pihole_integration: true }); app = require('../src/app').createApp(); });
afterEach(teardown);

async function portalHtml() {
  const db = require('../src/db/connection').getDb();
  db.prepare("INSERT INTO peers (name, public_key, allowed_ips, enabled, peer_type) VALUES ('Layout', 'lk', '10.8.7.7/32', 1, 'regular')").run();
  const res = await supertest(app).get('/portal').set('Host', `home.${config.dns.domain}`).set('X-GC-Portal-Peer-IP', '10.8.7.7').expect(200);
  return res.text;
}

test('status strip with the device ids', async () => {
  const h = await portalHtml();
  assert.match(h, /class="pt-strip"[^>]*data-area="device"/);
  for (const id of ['pt-strip-state', 'pt-strip-device', 'pt-strip-ip', 'pt-strip-hs']) assert.ok(h.includes('id="' + id + '"'), id);
});

test('tab order: Start, Dienste, … — every tab owns a panel', async () => {
  const h = await portalHtml();
  const order = [...h.matchAll(/data-tab="([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(order.slice(0, 2), ['start', 'dienste']);
  for (const t of order) assert.ok(h.includes(`id="panel-${t}"`), t);
  assert.ok(h.includes('aria-controls="panel-start"') && h.includes('role="tabpanel"'));
});

test('portal.css: max width 1320, horizontal tab scroll, dark + light', async () => {
  const res = await supertest(app).get('/css/portal.css').expect(200);
  assert.ok(res.text.includes('max-width: 1320px'));
  assert.match(res.text, /\.pt-tablist \{[^}]*overflow-x: auto/);
  assert.ok(res.text.includes('[data-theme="dark"]') && res.text.includes('[data-theme="light"]'));
});

test('Pi-hole donut and scope ids', async () => {
  const h = await portalHtml();
  for (const id of ['pt-pi-donut', 'pt-pi-pct', 'pt-pi-total', 'pt-pi-blocked', 'pt-pi-allowed', 'pt-pi-seg']) assert.ok(h.includes('id="' + id + '"'), id);
});

test('smart home tiles are buttons with aria-pressed, the AC power is a switch', () => {
  const js = fs.readFileSync('public/js/portal.js', 'utf8');
  assert.ok(js.includes("class: 'pt-shtile-main', 'aria-pressed'"));
  assert.ok(js.includes("role: 'switch', 'aria-checked'"));
  const css = fs.readFileSync('public/css/portal.css', 'utf8');
  assert.ok(css.includes('.pt-shtile') && css.includes('.pt-switch') && css.includes('.pt-sensor-list'));
});

test('services render as tiles (start) and cards (tab)', () => {
  const css = fs.readFileSync('public/css/portal.css', 'utf8');
  assert.ok(css.includes('.pt-tiles') && css.includes('.pt-svc-grid') && css.includes('.pt-badge'));
});
