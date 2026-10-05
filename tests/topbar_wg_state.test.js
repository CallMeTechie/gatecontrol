'use strict';
// Topbar WireGuard pill: text and colour must change together (it used to keep
// saying "Tunnel aktiv" in red), and pages other than the dashboard refresh it.
const crypto = require('crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path');
const { setup, teardown, getAgent } = require('./helpers/setup');

beforeEach(async () => { await setup(); });
afterEach(teardown);

test('the pill carries both labels so the script can switch the text', async () => {
  const res = await getAgent().get('/settings').expect(200);
  const m = res.text.match(/<div class="topbar-status" id="wg-status"[^>]*>/);
  assert.ok(m, 'wg-status pill rendered for admins');
  assert.match(m[0], /data-on="[^"]+"/);
  assert.match(m[0], /data-off="[^"]+"/);
  assert.match(m[0], /role="status"/);
});

test('app.js switches text with the inactive class and polls off the dashboard', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  assert.ok(js.includes('window.GC.setWgState = function'));
  assert.ok(js.includes("el.classList.toggle('inactive', !on)"));
  assert.ok(js.includes('el.dataset.off'));
  assert.ok(js.includes("fetch('/api/v1/wg/status'"));
  const dash = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'dashboard.js'), 'utf8');
  assert.ok(dash.includes('GC.setWgState(d.wireguard.running)'));
  assert.ok(!dash.includes("wg.classList.toggle('inactive'"), 'dashboard must not flip the colour alone');
});

test('the inactive pill and its dot are red in the Aurora theme', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'app.css'), 'utf8');
  assert.ok(css.includes('.topbar-status.inactive{color:var(--red)'));
  assert.ok(css.includes('.topbar-status.inactive .pulse-dot{background:var(--red)'));
});
