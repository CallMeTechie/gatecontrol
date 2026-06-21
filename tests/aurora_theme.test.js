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

// ── Task 4: Gateways ID-contract (theme-branched-JS pilot) ───────────────────
describe('aurora theme — gateways ID contract (Task 4 pilot)', () => {
  it('renders all static container IDs on /gateways under aurora', async () => {
    selectAurora();
    const res = await agent.get('/gateways').expect(200);
    // Static template IDs (gateways.njk)
    assert.match(res.text, /id="fleet-view"/, '#fleet-view present');
    assert.match(res.text, /id="fleet-kpis"/, '#fleet-kpis present');
    assert.match(res.text, /id="version-warning"/, '#version-warning present');
    assert.match(res.text, /id="fleet-grid"/, '#fleet-grid present');
    assert.match(res.text, /id="gw-detail-view"/, '#gw-detail-view present');
    // Modal overlay IDs
    assert.match(res.text, /id="gw-discovery-modal-overlay"/, '#gw-discovery-modal-overlay present');
    assert.match(res.text, /id="gw-setup-modal-overlay"/, '#gw-setup-modal-overlay present');
    assert.match(res.text, /id="gw-discovery-modal-body"/, '#gw-discovery-modal-body present');
    assert.match(res.text, /id="gw-setup-modal-body"/, '#gw-setup-modal-body present');
    assert.match(res.text, /id="gw-discovery-modal-title"/, '#gw-discovery-modal-title present');
    assert.match(res.text, /id="gw-setup-modal-title"/, '#gw-setup-modal-title present');
    // Aurora shell: the page must use the .app layout (isAurora() signal)
    assert.match(res.text, /class="app"/, 'aurora .app shell used (isAurora() signal)');
  });

  it('aurora.css carries the gateway Strang-A fixes', () => {
    const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'aurora.css'), 'utf8');
    // .gw-relnotes styled (not bare <a>)
    assert.match(css, /\.gw-relnotes/, '.gw-relnotes rule present in aurora.css');
    // .unit-grid and .resbar present (fleet card signature components)
    assert.match(css, /\.unit-grid/, '.unit-grid present in aurora.css');
    assert.match(css, /\.resbar/, '.resbar present in aurora.css');
  });

  it('gateways.js contains isAurora() detector and aurora sibling functions', () => {
    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'gateways.js'), 'utf8');
    assert.match(js, /function isAurora\(\)/, 'isAurora() present in gateways.js');
    assert.match(js, /function auroraCard\(/, 'auroraCard() present in gateways.js');
    assert.match(js, /function auroraRenderDetail\(/, 'auroraRenderDetail() present in gateways.js');
    // One-line guard at entry points
    assert.match(js, /if \(isAurora\(\)\) return auroraCard/, 'card() has isAurora guard');
    assert.match(js, /if \(isAurora\(\)\) return auroraRenderDetail/, 'renderDetail() has isAurora guard');
  });
});

// ── Task P2-1: Dashboard ID-contract (Aurora mockup fidelity) ─────────────────
describe('aurora theme — dashboard layout (Task P2-1)', () => {
  it('renders /dashboard with Aurora grid structure and .kpi/.card-title elements', async () => {
    selectAurora();
    const res = await agent.get('/dashboard').expect(200);
    // Aurora shell
    assert.match(res.text, /class="app"/, 'aurora .app shell present');
    // Grid layout
    assert.match(res.text, /class="grid"/, '.grid container present');
    assert.match(res.text, /class="card kpi span3"/, '.kpi.span3 KPI cards present');
    assert.match(res.text, /class="card-title"/, '.card-title present');
  });

  it('renders all static contract IDs on /dashboard under aurora', async () => {
    selectAurora();
    const res = await agent.get('/dashboard').expect(200);
    // KPI IDs
    assert.match(res.text, /id="stat-peers"/, '#stat-peers present');
    assert.match(res.text, /id="stat-routes"/, '#stat-routes present');
    assert.match(res.text, /id="stat-traffic"/, '#stat-traffic present');
    assert.match(res.text, /id="stat-gateways"/, '#stat-gateways present');
    assert.match(res.text, /id="stat-latency"/, '#stat-latency present');
    assert.match(res.text, /id="stat-monitoring"/, '#stat-monitoring present');
    assert.match(res.text, /id="stat-monitoring-sub"/, '#stat-monitoring-sub present');
    // Chart
    assert.match(res.text, /id="traffic-chart"/, '#traffic-chart present');
    assert.match(res.text, /id="t-total"/, '#t-total present');
    assert.match(res.text, /id="t-avg"/, '#t-avg present');
    assert.match(res.text, /id="t-peak"/, '#t-peak present');
    // Activity feed
    assert.match(res.text, /id="activity-feed"/, '#activity-feed present');
    // System resources
    assert.match(res.text, /id="cpu-pct"/, '#cpu-pct present');
    assert.match(res.text, /id="cpu-info"/, '#cpu-info present');
    assert.match(res.text, /id="cpu-bar"/, '#cpu-bar present');
    assert.match(res.text, /id="ram-pct"/, '#ram-pct present');
    assert.match(res.text, /id="ram-info"/, '#ram-info present');
    assert.match(res.text, /id="ram-bar"/, '#ram-bar present');
    assert.match(res.text, /id="uptime-value"/, '#uptime-value present');
    assert.match(res.text, /id="uptime-boot"/, '#uptime-boot present');
    // Auto-update modal IDs
    assert.match(res.text, /id="au-status"/, '#au-status present');
    assert.match(res.text, /id="au-setup-modal-overlay"/, '#au-setup-modal-overlay present');
    assert.match(res.text, /id="au-setup-title"/, '#au-setup-title present');
    assert.match(res.text, /id="au-setup-body"/, '#au-setup-body present');
  });

  it('renders Aurora toggle-group instead of .tabs for traffic period selector', async () => {
    selectAurora();
    const res = await agent.get('/dashboard').expect(200);
    assert.match(res.text, /class="toggle-group"/, '.toggle-group present');
    assert.match(res.text, /data-r="24h"/, 'toggle-btn with data-r="24h" present');
    // Should NOT have the old .tabs .tab[data-period] pattern in Aurora
    assert.doesNotMatch(res.text, /class="tab active" data-period=/, 'old .tabs pattern absent in Aurora');
  });

  it('sidebar has route-count-badge on the routes nav item under aurora', async () => {
    selectAurora();
    const res = await agent.get('/dashboard').expect(200);
    assert.match(res.text, /id="route-count-badge"/, '#route-count-badge present in aurora sidebar');
  });

  it('dashboard.js contains isAurora() detector and aurora sibling functions', () => {
    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'dashboard.js'), 'utf8');
    assert.match(js, /function isAurora\(\)/, 'isAurora() present in dashboard.js');
    assert.match(js, /function auroraRefreshStats\(/, 'auroraRefreshStats() present');
    assert.match(js, /function auroraRenderChart\(/, 'auroraRenderChart() present');
    assert.match(js, /function auroraRefreshDonut\(/, 'auroraRefreshDonut() present');
    assert.match(js, /function auroraRefreshActivity\(/, 'auroraRefreshActivity() present');
    // Guards at entry points
    assert.match(js, /if \(isAurora\(\)\) return auroraRefreshStats/, 'refreshStats() has isAurora guard');
    assert.match(js, /if \(isAurora\(\)\) return auroraRefreshActivity/, 'refreshActivity() has isAurora guard');
    assert.match(js, /if \(isAurora\(\)\) return auroraRefreshChart/, 'refreshChart() has isAurora guard');
  });

  it('Pi-hole donut card is absent when pihole_integration is not licensed (feature gate works)', async () => {
    selectAurora();
    // Default test setup does NOT enable pihole_integration — card must be absent (no card = correct reflow)
    const res = await agent.get('/dashboard').expect(200);
    assert.doesNotMatch(res.text, /id="pihole-donut-card"/, '#pihole-donut-card absent when not licensed');
    assert.doesNotMatch(res.text, /id="dash-donut"/, '#dash-donut absent when not licensed');
    // But the rest of the grid must still be present
    assert.match(res.text, /id="traffic-chart"/, '#traffic-chart present even without pihole');
  });
});

// ── Task P2-2: Pi-hole ID-contract (Aurora mockup fidelity) ──────────────────
describe('aurora theme — pihole layout (Task P2-2)', () => {
  it('renders /pihole under aurora (200, aurora shell)', async () => {
    selectAurora();
    const res = await agent.get('/pihole').expect(200);
    assert.match(res.text, /class="app"/, 'aurora .app shell present');
    assert.match(res.text, /\/css\/aurora\.css/, 'loads aurora.css');
  });

  it('renders Aurora grid structure and signature classes on /pihole', async () => {
    selectAurora();
    const res = await agent.get('/pihole').expect(200);
    assert.match(res.text, /class="grid"/, '.grid container present');
    assert.match(res.text, /class="card span5"/, '.card.span5 present');
    assert.match(res.text, /class="card span7"/, '.card.span7 present');
    assert.match(res.text, /class="card-title"/, '.card-title present');
    assert.match(res.text, /class="donut"/, '.donut SVG present');
    assert.match(res.text, /class="pi-wrap"/, '.pi-wrap present');
    assert.match(res.text, /class="toplist"/, '.toplist present');
  });

  it('renders all phase0 contract IDs on /pihole under aurora', async () => {
    selectAurora();
    const res = await agent.get('/pihole').expect(200);
    // Stat IDs
    assert.match(res.text, /id="ph-stat-queries"/, '#ph-stat-queries present');
    assert.match(res.text, /id="ph-stat-blocked"/, '#ph-stat-blocked present');
    assert.match(res.text, /id="ph-stat-blocked-pct"/, '#ph-stat-blocked-pct present');
    assert.match(res.text, /id="ph-stat-gravity"/, '#ph-stat-gravity present');
    assert.match(res.text, /id="ph-stat-clients"/, '#ph-stat-clients present');
    // Donut
    assert.match(res.text, /id="pi-donut"/, '#pi-donut present');
    // Chart
    assert.match(res.text, /id="ph-chart-svg"/, '#ph-chart-svg present');
    // Toplists
    assert.match(res.text, /id="ph-top-domains-tbody"/, '#ph-top-domains-tbody present');
    assert.match(res.text, /id="ph-top-clients-tbody"/, '#ph-top-clients-tbody present');
    assert.match(res.text, /id="ph-client-col-peer"/, '#ph-client-col-peer present');
    // Query types
    assert.match(res.text, /id="ph-query-types-list"/, '#ph-query-types-list present');
    // Attribution / status
    assert.match(res.text, /id="ph-attribution-warn"/, '#ph-attribution-warn present');
    assert.match(res.text, /id="ph-blocking-badge"/, '#ph-blocking-badge present');
    assert.match(res.text, /id="ph-status-badge"/, '#ph-status-badge present');
    // Health
    assert.match(res.text, /id="ph-health-status"/, '#ph-health-status present');
    assert.match(res.text, /id="ph-health-sync"/, '#ph-health-sync present');
    assert.match(res.text, /id="ph-health-instances"/, '#ph-health-instances present');
    // Controls
    assert.match(res.text, /id="btn-pihole-reload"/, '#btn-pihole-reload present');
    assert.match(res.text, /id="btn-ph-pause-30s"/, '#btn-ph-pause-30s present');
    assert.match(res.text, /id="btn-ph-pause-5m"/, '#btn-ph-pause-5m present');
    assert.match(res.text, /id="btn-ph-pause-30m"/, '#btn-ph-pause-30m present');
    assert.match(res.text, /id="btn-ph-enable"/, '#btn-ph-enable present');
  });

  it('toplist uses <ul> tag for ph-top-domains-tbody and ph-top-clients-tbody in aurora', async () => {
    selectAurora();
    const res = await agent.get('/pihole').expect(200);
    assert.match(res.text, /<ul id="ph-top-domains-tbody"/, 'ph-top-domains-tbody is a <ul> in Aurora');
    assert.match(res.text, /<ul id="ph-top-clients-tbody"/, 'ph-top-clients-tbody is a <ul> in Aurora');
  });

  it('pihole.js contains isAurora() detector and aurora sibling functions', () => {
    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'pihole.js'), 'utf8');
    assert.match(js, /function isAurora\(\)/, 'isAurora() present in pihole.js');
    assert.match(js, /function auroraRenderSummary\(/, 'auroraRenderSummary() present');
    assert.match(js, /function auroraRenderTopDomains\(/, 'auroraRenderTopDomains() present');
    assert.match(js, /function auroraRenderTopClients\(/, 'auroraRenderTopClients() present');
    // Guards at entry points
    assert.match(js, /if \(isAurora\(\)\) return auroraRenderSummary/, 'renderSummary() has isAurora guard');
    assert.match(js, /if \(isAurora\(\)\) return auroraRenderTopDomains/, 'renderTopDomains() has isAurora guard');
    assert.match(js, /if \(isAurora\(\)\) return auroraRenderTopClients/, 'renderTopClients() has isAurora guard');
  });
});
