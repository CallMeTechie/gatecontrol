'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setup, teardown } = require('./helpers/setup');
const { getDb } = require('../src/db/connection');

let agent;

function selectAurora() {
  getDb().prepare("UPDATE users SET theme = 'aurora' WHERE username = 'admin'").run();
}

before(async () => {
  const ctx = await setup();
  agent = ctx.agent;
});

after(() => teardown());

// Core pages that are always available with the test license override.
// dns/pihole are feature-gated (not unlocked in setup) → verified manually.
const PAGES = [
  '/dashboard', '/peers', '/routes', '/gateways', '/gateway-pools',
  '/rdp', '/certificates', '/users', '/logs', '/settings', '/profile',
];

describe('aurora theme — every page renders', () => {
  for (const url of PAGES) {
    it(`renders ${url} under aurora (200, loads both stylesheets)`, async () => {
      selectAurora(); // idempotent per-test; no cross-test ordering assumptions
      const res = await agent.get(url).expect(200);
      assert.match(res.text, /\/css\/pro\.css/, 'loads pro.css base layer');
      assert.match(res.text, /\/css\/aurora\.css/, 'loads aurora.css override');
      assert.match(res.text, /data-theme=/, 'sets data-theme on <html>');
      assert.match(res.text, /class="app"/, 'uses the aurora .app shell');
      assert.match(res.text, /id="theme-btn"/, 'topbar has the mode toggle');
    });
  }
});

describe('aurora theme — dark/light wiring', () => {
  it('ships the pre-paint key + OS fallback', async () => {
    selectAurora();
    const res = await agent.get('/dashboard').expect(200);
    assert.match(res.text, /gc-theme-mode/, 'pre-paint reads gc-theme-mode');
    assert.match(res.text, /prefers-color-scheme/, 'falls back to OS preference');
  });
});

describe('aurora theme — profile picker', () => {
  it('offers Aurora as a selectable option', async () => {
    getDb().prepare("UPDATE users SET theme = 'default' WHERE username = 'admin'").run();
    const res = await agent.get('/profile').expect(200);
    assert.match(res.text, /data-theme="aurora"/, 'profile picker has an Aurora button');
  });
});

describe('aurora theme — mobile sidebar scrim contract', () => {
  it('renders #sidebar-overlay so app.js can bind the scrim and tap-to-close', async () => {
    selectAurora();
    const res = await agent.get('/dashboard').expect(200);
    assert.match(res.text, /id="sidebar-overlay"/, 'layout emits #sidebar-overlay that app.js getElementById depends on');
  });
});

describe('aurora theme — A-global color leak regression (Task 3)', () => {
  it('aurora.css has overrides for btn-primary:hover, btn-danger:hover, pool-mode-failover, and non-circular --blue-bd', () => {
    const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'aurora.css'), 'utf8');
    assert.match(css, /\.btn-primary:hover\s*\{[^}]*box-shadow/, 'btn-primary:hover has a box-shadow override in aurora.css');
    assert.match(css, /\.btn-danger:hover/, 'btn-danger:hover has an Aurora override in aurora.css');
    assert.match(css, /\.pool-mode-failover/, 'pool-mode-failover has an Aurora override in aurora.css');
    assert.match(css, /--blue-bd:\s*(?!var\(--blue-bd\))/, '--blue-bd is no longer self-referential in aurora.css');
  });
});
