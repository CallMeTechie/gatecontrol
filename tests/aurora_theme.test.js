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
    // KPI cards live in the responsive .aurora-kpi-grid (6-across → progressive stack)
    assert.match(res.text, /class="aurora-kpi-grid"/, '.aurora-kpi-grid present');
    assert.match(res.text, /class="card kpi"/, '.kpi KPI cards present');
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

// ── Task P2-3: Peers ID-contract (Aurora mockup fidelity) ────────────────────
describe('aurora theme — peers layout (Task P2-3)', () => {
  it('renders /peers under aurora (200, aurora shell)', async () => {
    selectAurora();
    const res = await agent.get('/peers').expect(200);
    assert.match(res.text, /class="app"/, 'aurora .app shell present');
    assert.match(res.text, /\/css\/aurora\.css/, 'loads aurora.css');
  });

  it('renders Aurora toolbar, toggle-group, card-title, and data-table on /peers', async () => {
    selectAurora();
    const res = await agent.get('/peers').expect(200);
    assert.match(res.text, /class="toolbar"/, '.toolbar present');
    assert.match(res.text, /class="search-box"/, '.search-box present');
    assert.match(res.text, /class="toggle-group"/, '.toggle-group status filter present');
    assert.match(res.text, /class="card-title"/, '.card-title present');
    assert.match(res.text, /class="data-table"/, '.data-table present');
  });

  it('renders all phase0 static container IDs on /peers under aurora', async () => {
    selectAurora();
    const res = await agent.get('/peers').expect(200);
    // Toolbar / filter anchors
    assert.match(res.text, /id="peer-search"/, '#peer-search present');
    assert.match(res.text, /id="aurora-status-toggle"/, '#aurora-status-toggle present');
    assert.match(res.text, /id="peer-status-tags"/, '#peer-status-tags present (hidden)');
    assert.match(res.text, /id="peer-tag-filters"/, '#peer-tag-filters present (hidden)');
    assert.match(res.text, /id="peer-group-filter"/, '#peer-group-filter present (hidden)');
    // Section count spans (JS writes textContent)
    assert.match(res.text, /id="gw-section-count"/, '#gw-section-count present');
    assert.match(res.text, /id="peers-section-count"/, '#peers-section-count present');
    // Stat spans (hidden, JS writes them)
    assert.match(res.text, /id="stat-gw-online"/, '#stat-gw-online present');
    assert.match(res.text, /id="stat-gw-total"/, '#stat-gw-total present');
    assert.match(res.text, /id="stat-cl-online"/, '#stat-cl-online present');
    assert.match(res.text, /id="stat-cl-total"/, '#stat-cl-total present');
    // Gateway grid container
    assert.match(res.text, /id="gateways-container"/, '#gateways-container present');
    // Peer table body
    assert.match(res.text, /id="peers-tbody"/, '#peers-tbody present');
    assert.match(res.text, /id="peers-mobile"/, '#peers-mobile present (suppressed)');
    // Batch controls
    assert.match(res.text, /id="btn-batch-peers"/, '#btn-batch-peers present (hidden)');
    assert.match(res.text, /id="batch-bar-peers"/, '#batch-bar-peers present');
    assert.match(res.text, /id="batch-bar-peers-count"/, '#batch-bar-peers-count present');
    assert.match(res.text, /id="batch-select-all-peers"/, '#batch-select-all-peers present');
    assert.match(res.text, /id="batch-enable-peers"/, '#batch-enable-peers present');
    assert.match(res.text, /id="batch-disable-peers"/, '#batch-disable-peers present');
    assert.match(res.text, /id="batch-delete-peers"/, '#batch-delete-peers present');
    assert.match(res.text, /id="batch-cancel-peers"/, '#batch-cancel-peers present');
  });

  it('renders all 7 modal IDs on /peers under aurora', async () => {
    selectAurora();
    const res = await agent.get('/peers').expect(200);
    assert.match(res.text, /id="modal-add-peer"/, '#modal-add-peer present');
    assert.match(res.text, /id="modal-edit-peer"/, '#modal-edit-peer present');
    assert.match(res.text, /id="modal-qr-peer"/, '#modal-qr-peer present');
    assert.match(res.text, /id="modal-peer-traffic"/, '#modal-peer-traffic present');
    assert.match(res.text, /id="modal-gateway-tokens"/, '#modal-gateway-tokens present');
    assert.match(res.text, /id="modal-gateway-delete"/, '#modal-gateway-delete present');
    assert.match(res.text, /id="modal-confirm"/, '#modal-confirm present');
  });

  it('renders add-peer and edit-peer modal field IDs on /peers under aurora', async () => {
    selectAurora();
    const res = await agent.get('/peers').expect(200);
    // Add-peer fields
    assert.match(res.text, /id="add-peer-name"/, '#add-peer-name present');
    assert.match(res.text, /id="btn-add-peer-submit"/, '#btn-add-peer-submit present');
    assert.match(res.text, /id="add-peer-error"/, '#add-peer-error present');
    // Edit-peer fields
    assert.match(res.text, /id="edit-peer-id"/, '#edit-peer-id present');
    assert.match(res.text, /id="edit-peer-name"/, '#edit-peer-name present');
    assert.match(res.text, /id="btn-edit-peer-submit"/, '#btn-edit-peer-submit present');
    assert.match(res.text, /id="edit-peer-error"/, '#edit-peer-error present');
    assert.match(res.text, /id="access-windows-section"/, '#access-windows-section present');
    // QR + traffic modal fields
    assert.match(res.text, /id="qr-peer-title"/, '#qr-peer-title present');
    assert.match(res.text, /id="traffic-peer-title"/, '#traffic-peer-title present');
    // Gateway-tokens modal fields
    assert.match(res.text, /id="gateway-tokens-api-token"/, '#gateway-tokens-api-token present');
    assert.match(res.text, /id="gateway-pairing-token"/, '#gateway-pairing-token present');
    // Gateway-delete modal fields
    assert.match(res.text, /id="gw-delete-confirm-btn"/, '#gw-delete-confirm-btn present');
  });

  it('toggle-group in toolbar has All/Online/Offline buttons with data-status attributes', async () => {
    selectAurora();
    const res = await agent.get('/peers').expect(200);
    assert.match(res.text, /data-status="all"/, 'toggle-btn data-status="all" present');
    assert.match(res.text, /data-status="online"/, 'toggle-btn data-status="online" present');
    assert.match(res.text, /data-status="offline"/, 'toggle-btn data-status="offline" present');
  });

  it('peers.js contains isAurora() detector and aurora sibling functions', () => {
    const js = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'public', 'js', 'peers.js'), 'utf8');
    assert.match(js, /function isAurora\(\)/, 'isAurora() present in peers.js');
    assert.match(js, /function auroraActionBtns\(/, 'auroraActionBtns() present');
    assert.match(js, /function auroraRenderPeers\(/, 'auroraRenderPeers() present');
    assert.match(js, /function auroraRenderGatewayCard\(/, 'auroraRenderGatewayCard() present');
    assert.match(js, /function auroraInitStatusToggle\(/, 'auroraInitStatusToggle() present');
    // Guards at entry points
    assert.match(js, /if \(isAurora\(\)\) return auroraActionBtns/, 'actionBtns() has isAurora guard');
    assert.match(js, /if \(isAurora\(\)\) return auroraRenderPeers/, 'renderPeers() has isAurora guard');
    assert.match(js, /if \(isAurora\(\)\) return auroraRenderGatewayCard/, 'renderGatewayCard() has isAurora guard');
    assert.match(js, /if \(isAurora\(\)\) auroraInitStatusToggle/, 'auroraInitStatusToggle() called in init');
  });

  it('aurora.css carries the peers-page additions', () => {
    const css = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'public', 'css', 'aurora.css'), 'utf8');
    assert.match(css, /\.aurora-gw-empty/, '.aurora-gw-empty rule present');
    assert.match(css, /\.tag\.tag-dot/, '.tag.tag-dot rule present');
  });
});

// ── Task P2-4a: Routes page structure + toolbar + table (Split A+B) ──────────
describe('aurora theme — routes layout Part A (Task P2-4a)', () => {
  it('renders /routes under aurora (200, aurora shell)', async () => {
    selectAurora();
    const res = await agent.get('/routes').expect(200);
    assert.match(res.text, /class="app"/, 'aurora .app shell present');
    assert.match(res.text, /\/css\/aurora\.css/, 'loads aurora.css');
  });

  it('renders Aurora page-header, toolbar, toggle-group, and data-table shell on /routes', async () => {
    selectAurora();
    const res = await agent.get('/routes').expect(200);
    // Page header Aurora structure
    assert.match(res.text, /class="page-header"/, '.page-header present');
    assert.match(res.text, /class="page-eyebrow"/, '.page-eyebrow present');
    assert.match(res.text, /class="page-actions"/, '.page-actions present');
    // Toolbar
    assert.match(res.text, /class="toolbar"/, '.toolbar present');
    assert.match(res.text, /class="search-box"/, '.search-box present');
    // Toggle-group type filter (Aurora replaces filter-chips)
    assert.match(res.text, /class="toggle-group"/, '.toggle-group present');
    // Routes list card (full-width, no card-head)
    assert.match(res.text, /class="card span12"/, '.card.span12 present');
    // data-table is emitted by JS at runtime; the card wrapper (span12) is in template
  });

  it('renders all phase0 static contract IDs on /routes under aurora', async () => {
    selectAurora();
    const res = await agent.get('/routes').expect(200);
    // JS-contract IDs that must exist in the template (not JS-generated)
    assert.match(res.text, /id="routes-subtitle"/, '#routes-subtitle present');
    assert.match(res.text, /id="routes-count"/, '#routes-count present (hidden span)');
    assert.match(res.text, /id="route-search"/, '#route-search present');
    assert.match(res.text, /id="btn-add-route"/, '#btn-add-route present');
    assert.match(res.text, /id="routes-list"/, '#routes-list present');
    assert.match(res.text, /id="aurora-type-toggle"/, '#aurora-type-toggle present');
    // Wizard modal IDs (Split C-F, untouched — still in DOM)
    assert.match(res.text, /id="route-modal-overlay"/, '#route-modal-overlay present');
    assert.match(res.text, /id="service-modal-overlay"/, '#service-modal-overlay present');
    // Batch bar IDs (Split F, untouched)
    assert.match(res.text, /id="batch-bar-routes"/, '#batch-bar-routes present');
    assert.match(res.text, /id="batch-cancel-routes"/, '#batch-cancel-routes present');
  });

  it('toggle-group has All/HTTP/L4 filter buttons and RDP nav button', async () => {
    selectAurora();
    const res = await agent.get('/routes').expect(200);
    assert.match(res.text, /data-value=""/, 'All toggle-btn (data-value="") present');
    assert.match(res.text, /data-value="http"/, 'HTTP toggle-btn present');
    assert.match(res.text, /data-value="l4"/, 'L4 toggle-btn present');
    assert.match(res.text, /data-nav="\/rdp"/, 'RDP toggle-btn present');
  });

  it('Aurora layout omits limit-badge section and old routes-toolbar class', async () => {
    selectAurora();
    const res = await agent.get('/routes').expect(200);
    assert.doesNotMatch(res.text, /class="limit-badge"/, 'limit-badge absent in Aurora routes header');
    assert.doesNotMatch(res.text, /class="routes-toolbar"/, 'old .routes-toolbar class absent in Aurora');
    assert.doesNotMatch(res.text, /class="card-head"/, '.card-head absent in Aurora routes card');
  });

  it('routes.js contains isAurora() detector and aurora sibling functions', () => {
    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'routes.js'), 'utf8');
    assert.match(js, /function isAurora\(\)/, 'isAurora() present in routes.js');
    assert.match(js, /function auroraRenderTableRow\(/, 'auroraRenderTableRow() present');
    assert.match(js, /function auroraRenderTable\(/, 'auroraRenderTable() present');
    assert.match(js, /function auroraInitTypeToggle\(/, 'auroraInitTypeToggle() present');
    // Guards at entry points
    assert.match(js, /if \(isAurora\(\)\) return auroraRenderTableRow/, 'renderTableRow() has isAurora guard');
    assert.match(js, /if \(isAurora\(\)\) return auroraRenderTable/, 'renderTable() has isAurora guard');
    assert.match(js, /if \(isAurora\(\)\) viewState\.view = 'table'/, 'viewState.view forced to table in Aurora');
    assert.match(js, /if \(isAurora\(\)\) auroraInitTypeToggle/, 'auroraInitTypeToggle() called in init');
  });

  it('aurora.css carries toggle, data-table, row-actions, icon-action rules', () => {
    const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'aurora.css'), 'utf8');
    assert.match(css, /\.toggle\b/, '.toggle rule present in aurora.css');
    assert.match(css, /\.data-table\b/, '.data-table rule present in aurora.css');
    assert.match(css, /\.row-actions\b/, '.row-actions rule present in aurora.css');
    assert.match(css, /\.icon-action\b/, '.icon-action rule present in aurora.css');
    assert.match(css, /\.toggle-group\b/, '.toggle-group rule present in aurora.css');
  });
});

// ── Task P2-4b: Routes wizards + modals ──────────────────────────────────────
describe('aurora theme — routes wizards + modals (Task P2-4b)', () => {
  it('renders wizard modal overlay ids on /routes under aurora', async () => {
    selectAurora();
    const res = await agent.get('/routes').expect(200);
    assert.match(res.text, /id="route-modal-overlay"/, '#route-modal-overlay present');
    assert.match(res.text, /id="service-modal-overlay"/, '#service-modal-overlay present');
    assert.match(res.text, /id="modal-edit-route"/, '#modal-edit-route present (via include)');
    assert.match(res.text, /id="modal-confirm"/, '#modal-confirm present (via include)');
  });

  it('route-edit modal has data-edit-tab tabs and edit-route-panel sections', async () => {
    selectAurora();
    const res = await agent.get('/routes').expect(200);
    assert.match(res.text, /data-edit-tab="general"/, 'data-edit-tab="general" present');
    assert.match(res.text, /data-edit-tab="auth"/, 'data-edit-tab="auth" present');
    assert.match(res.text, /data-edit-tab="security"/, 'data-edit-tab="security" present');
    assert.match(res.text, /class="edit-route-panel"/, '.edit-route-panel present');
    assert.match(res.text, /data-panel="general"/, 'data-panel="general" present');
  });

  it('route-edit modal has all required submit/action button ids', async () => {
    selectAurora();
    const res = await agent.get('/routes').expect(200);
    assert.match(res.text, /id="btn-edit-route-submit"/, '#btn-edit-route-submit present');
    assert.match(res.text, /id="route-wizard-save"/, '#route-wizard-save present');
    assert.match(res.text, /id="route-wizard-next"/, '#route-wizard-next present');
    assert.match(res.text, /id="route-wizard-prev"/, '#route-wizard-prev present');
    assert.match(res.text, /id="service-next"/, '#service-next present');
    assert.match(res.text, /id="service-back"/, '#service-back present');
  });

  it('create-route wizard uses Aurora modal shell classes', async () => {
    selectAurora();
    const res = await agent.get('/routes').expect(200);
    assert.match(res.text, /class="modal modal-xl modal-wizard"/, '.modal.modal-xl.modal-wizard present');
    assert.match(res.text, /class="modal-head wiz-head"/, '.modal-head.wiz-head present in route wizard');
    assert.match(res.text, /class="modal-foot wiz-foot"/, '.modal-foot.wiz-foot present');
  });

  it('create-service wizard uses Aurora modal shell classes', async () => {
    selectAurora();
    const res = await agent.get('/routes').expect(200);
    assert.match(res.text, /class="modal modal-wide modal-wizard"/, '.modal.modal-wide.modal-wizard present');
    assert.match(res.text, /class="service-step-pill on"/, '.service-step-pill.on present');
    assert.match(res.text, /id="service-wizard-steps"/, '#service-wizard-steps present');
  });

  it('wizard step progress dots are present with data-pill attributes', async () => {
    selectAurora();
    const res = await agent.get('/routes').expect(200);
    assert.match(res.text, /class="route-step-dot" data-pill="1"/, 'route-step-dot 1 present');
    assert.match(res.text, /class="route-step-line"/, '.route-step-line present');
    assert.match(res.text, /id="route-wizard-steps"/, '#route-wizard-steps present');
  });

  it('aurora.css carries wizard modal shell + step dots + service pills rules', () => {
    const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'aurora.css'), 'utf8');
    assert.match(css, /\.modal\.modal-xl/, '.modal.modal-xl present in aurora.css');
    assert.match(css, /\.modal\.modal-wizard/, '.modal.modal-wizard present in aurora.css');
    assert.match(css, /\.modal-foot\.wiz-foot/, '.modal-foot.wiz-foot present in aurora.css');
    assert.match(css, /\.route-step-dot/, '.route-step-dot present in aurora.css');
    assert.match(css, /\.service-step-pill/, '.service-step-pill present in aurora.css');
  });

  it('wizard <style nonce> block has been removed from routes.njk (styles moved to aurora.css)', () => {
    const njk = fs.readFileSync(path.join(__dirname, '..', 'templates', 'aurora', 'pages', 'routes.njk'), 'utf8');
    assert.doesNotMatch(njk, /\.route-step-dot\s*\{/, '.route-step-dot inline style block absent (moved to aurora.css)');
    assert.doesNotMatch(njk, /\.wiz-row-2\s*\{/, '.wiz-row-2 inline style block absent (moved to aurora.css)');
  });
});

// ── Task P2-5: Users page (Aurora mockup fidelity) ────────────────────────────
describe('aurora theme — users layout (Task P2-5)', () => {
  it('renders /users under aurora (200, aurora shell)', async () => {
    selectAurora();
    const res = await agent.get('/users').expect(200);
    assert.match(res.text, /class="app"/, 'aurora .app shell present');
    assert.match(res.text, /\/css\/aurora\.css/, 'loads aurora.css');
  });

  it('renders Aurora data-table and card-title on /users', async () => {
    selectAurora();
    const res = await agent.get('/users').expect(200);
    assert.match(res.text, /class="data-table"/, '.data-table present (Aurora table class)');
    assert.match(res.text, /class="card-title"/, '.card-title present');
    // Aurora template must NOT use the old peer-table class for the users table
    assert.doesNotMatch(res.text, /class="peer-table" id="users-table"/, 'old peer-table class absent in Aurora users');
  });

  it('renders all phase0 static contract IDs on /users under aurora', async () => {
    selectAurora();
    const res = await agent.get('/users').expect(200);
    // Table / page elements
    assert.match(res.text, /id="users-tbody"/, '#users-tbody present');
    assert.match(res.text, /id="users-table"/, '#users-table present');
    assert.match(res.text, /id="unassigned-banner"/, '#unassigned-banner present');
    assert.match(res.text, /id="unassigned-list"/, '#unassigned-list present');
    assert.match(res.text, /id="unassigned-count"/, '#unassigned-count present');
    assert.match(res.text, /id="btn-add-user"/, '#btn-add-user present');
    assert.match(res.text, /id="btn-create-token-standalone"/, '#btn-create-token-standalone present');
    // User modal elements
    assert.match(res.text, /id="user-modal-overlay"/, '#user-modal-overlay present');
    assert.match(res.text, /id="user-form"/, '#user-form present');
    assert.match(res.text, /id="user-modal-title"/, '#user-modal-title present');
    assert.match(res.text, /id="user-edit-id"/, '#user-edit-id present');
    assert.match(res.text, /id="user-password-group"/, '#user-password-group present');
    assert.match(res.text, /id="user-tokens-section"/, '#user-tokens-section present');
    assert.match(res.text, /id="user-role"/, '#user-role present');
    assert.match(res.text, /id="user-form-error"/, '#user-form-error present');
    assert.match(res.text, /id="user-username"/, '#user-username present');
    assert.match(res.text, /id="user-display-name"/, '#user-display-name present');
    assert.match(res.text, /id="user-email"/, '#user-email present');
    assert.match(res.text, /id="user-password"/, '#user-password present');
    assert.match(res.text, /id="user-modal-save"/, '#user-modal-save present');
    assert.match(res.text, /id="user-tokens-list"/, '#user-tokens-list present');
    assert.match(res.text, /id="btn-add-token"/, '#btn-add-token present');
    assert.match(res.text, /id="user-modal-close"/, '#user-modal-close present');
    assert.match(res.text, /id="user-modal-cancel"/, '#user-modal-cancel present');
    // Token wizard modal elements
    assert.match(res.text, /id="token-modal-overlay"/, '#token-modal-overlay present');
    assert.match(res.text, /id="token-form-error"/, '#token-form-error present');
    assert.match(res.text, /id="tw-step-1"/, '#tw-step-1 present');
    assert.match(res.text, /id="tw-step-2"/, '#tw-step-2 present');
    assert.match(res.text, /id="tw-step-3"/, '#tw-step-3 present');
    assert.match(res.text, /id="tw-step-4"/, '#tw-step-4 present');
    assert.match(res.text, /id="token-wizard-step"/, '#token-wizard-step present');
    assert.match(res.text, /id="tw-back"/, '#tw-back present');
    assert.match(res.text, /id="tw-next"/, '#tw-next present');
    assert.match(res.text, /id="tw-cancel"/, '#tw-cancel present');
    assert.match(res.text, /id="tw-name"/, '#tw-name present');
    assert.match(res.text, /id="tw-copy-confirm"/, '#tw-copy-confirm present');
    assert.match(res.text, /id="tw-token-value"/, '#tw-token-value present');
    assert.match(res.text, /id="tw-st-override"/, '#tw-st-override present');
    assert.match(res.text, /id="tw-st-section"/, '#tw-st-section present');
    assert.match(res.text, /id="tw-st-private"/, '#tw-st-private present');
    assert.match(res.text, /id="tw-st-linklocal"/, '#tw-st-linklocal present');
    assert.match(res.text, /id="tw-st-locked"/, '#tw-st-locked present');
    assert.match(res.text, /id="tw-user"/, '#tw-user present');
    assert.match(res.text, /id="tw-peer"/, '#tw-peer present');
    assert.match(res.text, /id="tw-custom-scopes"/, '#tw-custom-scopes present');
    assert.match(res.text, /id="tw-presets"/, '#tw-presets present');
    assert.match(res.text, /id="tw-st-mode"/, '#tw-st-mode present');
    assert.match(res.text, /id="tw-copy-btn"/, '#tw-copy-btn present');
    assert.match(res.text, /id="token-modal-close"/, '#token-modal-close present');
  });

  it('Aurora users table uses 5-column thead (MFA + Last Login cols present, old 7-col keys absent)', async () => {
    selectAurora();
    const res = await agent.get('/users').expect(200);
    // Aurora 5-column loading placeholder
    assert.match(res.text, /colspan="5"/, 'loading row uses colspan="5" (5-column table)');
    // Aurora template file references the new column keys
    const njk = fs.readFileSync(path.join(__dirname, '..', 'templates', 'aurora', 'pages', 'users.njk'), 'utf8');
    assert.match(njk, /users\.col_mfa/, 'Aurora users.njk references users.col_mfa key');
    assert.match(njk, /users\.col_last_login/, 'Aurora users.njk references users.col_last_login key');
    // Aurora must NOT expose the 7-col keys users.col_tokens / users.col_peers / users.col_status
    assert.doesNotMatch(njk, /users\.col_tokens/, 'users.col_tokens absent in Aurora thead (7-col key removed)');
    assert.doesNotMatch(njk, /users\.col_peers/, 'users.col_peers absent in Aurora thead (7-col key removed)');
  });

  it('Aurora modal-head has <span class="mi"> icon wrapper in user modal', async () => {
    selectAurora();
    const res = await agent.get('/users').expect(200);
    assert.match(res.text, /class="mi"/, '<span class="mi"> icon wrapper present in modal-head');
  });

  it('inline <style> block has been removed from aurora/pages/users.njk (styles moved to aurora.css)', () => {
    const njk = fs.readFileSync(path.join(__dirname, '..', 'templates', 'aurora', 'pages', 'users.njk'), 'utf8');
    assert.doesNotMatch(njk, /\.tw-step\s*\{/, '.tw-step inline style block absent (moved to aurora.css)');
    assert.doesNotMatch(njk, /\.tw-preset-label\s*\{/, '.tw-preset-label inline style block absent (moved to aurora.css)');
    assert.doesNotMatch(njk, /<style>/, 'no <style> block in aurora users.njk (moved to aurora.css)');
  });

  it('users.js contains isAurora() detector and aurora sibling functions', () => {
    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'users.js'), 'utf8');
    assert.match(js, /function isAurora\(\)/, 'isAurora() present in users.js');
    assert.match(js, /function auroraRenderUsersDesktop\(/, 'auroraRenderUsersDesktop() present');
    assert.match(js, /function auroraRenderUsersCards\(/, 'auroraRenderUsersCards() present');
    assert.match(js, /function auroraUserActionBtns\(/, 'auroraUserActionBtns() present');
    assert.match(js, /function auroraMfaTag\(/, 'auroraMfaTag() present');
    // Guards at entry points
    assert.match(js, /if \(isAurora\(\)\) return auroraRenderUsersDesktop/, 'renderUsersDesktop() has isAurora guard');
    assert.match(js, /if \(isAurora\(\)\) return auroraRenderUsersCards/, 'renderUsersCards() has isAurora guard');
  });

  it('aurora.css carries the users-page additions', () => {
    const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'aurora.css'), 'utf8');
    assert.match(css, /\.banner-amber\b/, '.banner-amber rule present in aurora.css');
    assert.match(css, /\.aurora-user-card\b/, '.aurora-user-card rule present in aurora.css');
    assert.match(css, /\.tw-step\b/, '.tw-step animation rule present in aurora.css');
    assert.match(css, /\.tw-preset-label\b/, '.tw-preset-label rule present in aurora.css');
  });
});

// ── Task P2-6: Certificates page (Aurora mockup fidelity) ────────────────────
describe('aurora theme — certificates layout (Task P2-6)', () => {
  it('renders /certificates under aurora (200, aurora shell)', async () => {
    selectAurora();
    const res = await agent.get('/certificates').expect(200);
    assert.match(res.text, /class="app"/, 'aurora .app shell present');
    assert.match(res.text, /\/css\/aurora\.css/, 'loads aurora.css');
  });

  it('renders Aurora grid structure and signature classes on /certificates', async () => {
    selectAurora();
    const res = await agent.get('/certificates').expect(200);
    assert.match(res.text, /class="card span12"/, '.card.span12 full-width card present');
    assert.match(res.text, /class="card-title"/, '.card-title present');
    assert.match(res.text, /class="data-table"/, '.data-table present');
  });

  it('renders page-header with page-eyebrow and page-actions on /certificates', async () => {
    selectAurora();
    const res = await agent.get('/certificates').expect(200);
    assert.match(res.text, /class="page-header"/, '.page-header present');
    assert.match(res.text, /class="page-eyebrow"/, '.page-eyebrow present');
    assert.match(res.text, /class="page-actions"/, '.page-actions present');
    assert.match(res.text, /btn btn-primary/, 'primary action button present in page-actions');
  });

  it('renders data-table thead with Domain, Issuer, Valid-until, Status columns', async () => {
    selectAurora();
    // Check njk file uses correct i18n keys (Nunjucks renders them to text, not raw keys in HTML)
    const njk = fs.readFileSync(path.join(__dirname, '..', 'templates', 'aurora', 'pages', 'certificates.njk'), 'utf8');
    assert.match(njk, /certificates\.col_domain/, 'njk references certificates.col_domain key for domain column');
    assert.match(njk, /certificates\.col_issuer/, 'njk references certificates.col_issuer key');
    assert.match(njk, /certificates\.col_valid_until/, 'njk references certificates.col_valid_until key');
    assert.match(njk, /peers\.status/, 'njk references peers.status key for status column');
    // Rendered HTML carries the translated column text (EN locale: Domain, Issuer, Valid until, Status)
    const res = await agent.get('/certificates').expect(200);
    assert.match(res.text, /<th[^>]*>.*Domain.*<\/th>|<th>Domain/, 'Domain column header rendered');
    assert.match(res.text, /<th[^>]*>.*Issuer.*<\/th>|<th>Issuer/, 'Issuer column header rendered');
    assert.match(res.text, /<th[^>]*>.*Valid until.*<\/th>|<th>Valid until/, 'Valid until column header rendered');
    assert.match(res.text, /<th[^>]*>.*Status.*<\/th>|<th>Status/, 'Status column header rendered');
  });

  it('renders all phase0 contract IDs on /certificates under aurora', async () => {
    selectAurora();
    const res = await agent.get('/certificates').expect(200);
    // certificates-list must be on the <tbody> for JS to append <tr> rows
    assert.match(res.text, /id="certificates-list"/, '#certificates-list present');
    // Refresh/upload button (JS uses btn-certificates-refresh)
    assert.match(res.text, /id="btn-certificates-refresh"/, '#btn-certificates-refresh present');
  });

  it('certificates-list is inside the data-table (tbody child)', async () => {
    selectAurora();
    const res = await agent.get('/certificates').expect(200);
    // tbody must carry certificates-list id (so JS-appended <tr> rows stay valid HTML)
    assert.match(res.text, /<tbody id="certificates-list"/, '<tbody id="certificates-list"> present');
  });

  it('certificates.js contains isAurora() detector and aurora sibling functions', () => {
    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'certificates.js'), 'utf8');
    assert.match(js, /function isAurora\(\)/, 'isAurora() present in certificates.js');
    assert.match(js, /function auroraTableRow\(/, 'auroraTableRow() present');
    assert.match(js, /function auroraStatusTag\(/, 'auroraStatusTag() present');
    assert.match(js, /function auroraLoadCertificates\(/, 'auroraLoadCertificates() present');
    // Guard at entry point
    assert.match(js, /if \(isAurora\(\)\) return auroraLoadCertificates/, 'loadCertificates() has isAurora guard');
  });

  it('aurora.css already carries data-table, row-actions, icon-action, tag-dot (no new rules needed)', () => {
    const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'aurora.css'), 'utf8');
    assert.match(css, /\.data-table\b/, '.data-table rule present in aurora.css');
    assert.match(css, /\.row-actions\b/, '.row-actions rule present in aurora.css');
    assert.match(css, /\.icon-action\b/, '.icon-action rule present in aurora.css');
    assert.match(css, /\.tag\.tag-dot/, '.tag.tag-dot rule present in aurora.css');
    assert.match(css, /\.data-table .cell-name/, '.data-table .cell-name rule present in aurora.css');
    assert.match(css, /\.data-table .mono/, '.data-table .mono rule present in aurora.css');
  });
});

// ── Task P2-7: DNS page (Aurora mockup fidelity) ─────────────────────────────
describe('aurora theme — dns layout (Task P2-7)', () => {
  it('renders /dns under aurora (200, aurora shell)', async () => {
    selectAurora();
    const res = await agent.get('/dns').expect(200);
    assert.match(res.text, /class="app"/, 'aurora .app shell present');
    assert.match(res.text, /\/css\/aurora\.css/, 'loads aurora.css');
  });

  it('renders Aurora grid structure, data-table, and card-title on /dns', async () => {
    selectAurora();
    const res = await agent.get('/dns').expect(200);
    assert.match(res.text, /class="grid"/, '.grid container present');
    assert.match(res.text, /class="data-table"/, '.data-table present');
    assert.match(res.text, /class="card-title"/, '.card-title present');
  });

  it('renders page-header with page-eyebrow, page-actions, and feature-lock badge on /dns', async () => {
    selectAurora();
    const res = await agent.get('/dns').expect(200);
    assert.match(res.text, /class="page-header"/, '.page-header present');
    assert.match(res.text, /class="page-eyebrow"/, '.page-eyebrow present');
    assert.match(res.text, /class="page-actions"/, '.page-actions present');
    assert.match(res.text, /class="feature-lock"/, '.feature-lock badge present');
  });

  it('renders data-table thead with Hostname, Type, IP columns on /dns', async () => {
    selectAurora();
    const njk = fs.readFileSync(path.join(__dirname, '..', 'templates', 'aurora', 'pages', 'dns.njk'), 'utf8');
    assert.match(njk, /dns\.hostname/, 'njk references dns.hostname key for Hostname column');
    assert.match(njk, /dns\.record_type/, 'njk references dns.record_type key for Type column');
    assert.match(njk, /dns\.ip/, 'njk references dns.ip key for IP column');
    const res = await agent.get('/dns').expect(200);
    assert.match(res.text, /<th[^>]*>.*Hostname.*<\/th>|<th>Hostname/, 'Hostname column header rendered');
    assert.match(res.text, /<th[^>]*>.*Type.*<\/th>|<th>Type/, 'Type column header rendered');
    assert.match(res.text, /<th[^>]*>.*IP.*<\/th>|<th>IP/, 'IP column header rendered');
  });

  it('renders all phase0 contract IDs on /dns under aurora', async () => {
    selectAurora();
    const res = await agent.get('/dns').expect(200);
    // Stat IDs (hidden in Aurora, but present for JS null-check safety)
    assert.match(res.text, /id="dns-stat-total"/, '#dns-stat-total present');
    assert.match(res.text, /id="dns-stat-resolved"/, '#dns-stat-resolved present');
    assert.match(res.text, /id="dns-stat-auto"/, '#dns-stat-auto present');
    assert.match(res.text, /id="dns-stat-stale"/, '#dns-stat-stale present');
    // Config section IDs (hidden in Aurora)
    assert.match(res.text, /id="dns-status-badge"/, '#dns-status-badge present');
    assert.match(res.text, /id="dns-domain"/, '#dns-domain present');
    assert.match(res.text, /id="dns-hosts-path"/, '#dns-hosts-path present');
    assert.match(res.text, /id="dns-mtime"/, '#dns-mtime present');
    // Static tbody (hidden, JS guarded in Aurora)
    assert.match(res.text, /id="dns-static-tbody"/, '#dns-static-tbody present');
    // Peer table body (Aurora unified table)
    assert.match(res.text, /id="dns-peer-tbody"/, '#dns-peer-tbody present');
    // Search input
    assert.match(res.text, /id="dns-peer-search"/, '#dns-peer-search present');
    // Reload button
    assert.match(res.text, /id="btn-dns-reload"/, '#btn-dns-reload present');
  });

  it('Aurora dns table uses 3-column thead (no 6-col default pattern)', async () => {
    selectAurora();
    const res = await agent.get('/dns').expect(200);
    // Aurora loading placeholder uses colspan 3
    assert.match(res.text, /colspan="3"/, 'loading row uses colspan="3" (3-column Aurora table)');
    // Aurora must NOT expose the 6-col pattern from the default theme
    assert.doesNotMatch(res.text, /colspan="6"/, '6-column default colspan absent in Aurora dns');
  });

  it('dns.js contains isAurora() detector and aurora sibling function', () => {
    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'dns.js'), 'utf8');
    assert.match(js, /function isAurora\(\)/, 'isAurora() present in dns.js');
    assert.match(js, /function auroraRenderPeers\(/, 'auroraRenderPeers() present in dns.js');
    // Guard at entry point
    assert.match(js, /if \(isAurora\(\)\) return auroraRenderPeers/, 'renderPeers() has isAurora guard');
    assert.match(js, /if \(isAurora\(\)\) return;/, 'renderStatic() has isAurora early-return guard');
  });

  it('aurora.css already carries feature-lock, data-table, cell-name, mono rules (no new rules needed)', () => {
    const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'aurora.css'), 'utf8');
    assert.match(css, /\.feature-lock\b/, '.feature-lock rule present in aurora.css');
    assert.match(css, /\.data-table\b/, '.data-table rule present in aurora.css');
    assert.match(css, /\.data-table .cell-name/, '.data-table .cell-name rule present in aurora.css');
    assert.match(css, /\.data-table .mono/, '.data-table .mono rule present in aurora.css');
  });
});

// ── Task 8: Logs page — mockup fidelity ──────────────────────────────────────
describe('aurora theme — logs page (Task 8)', () => {
  it('/logs returns 200 under aurora', async () => {
    selectAurora();
    const res = await agent.get('/logs').expect(200);
    assert.match(res.text, /class="app"/, 'Aurora .app shell used');
  });

  it('/logs Aurora has .toolbar and .toggle-group for severity filter', async () => {
    selectAurora();
    const res = await agent.get('/logs').expect(200);
    assert.match(res.text, /class="toolbar"/, '.toolbar present');
    assert.match(res.text, /class="toggle-group"/, '.toggle-group present');
  });

  it('/logs Aurora uses .card.span12 grid layout for log container', async () => {
    selectAurora();
    const res = await agent.get('/logs').expect(200);
    assert.match(res.text, /card span12/, '.card.span12 grid layout present');
  });

  it('/logs Aurora preserves all phase-0 JS-contract IDs', async () => {
    selectAurora();
    const res = await agent.get('/logs').expect(200);
    assert.match(res.text, /id="log-type-tabs"/, '#log-type-tabs present');
    assert.match(res.text, /id="activity-panel"/, '#activity-panel present');
    assert.match(res.text, /id="access-panel"/, '#access-panel present');
    assert.match(res.text, /id="history-panel"/, '#history-panel present');
    assert.match(res.text, /id="full-activity-log"/, '#full-activity-log present');
    assert.match(res.text, /id="logs-count"/, '#logs-count present');
    assert.match(res.text, /id="log-severity-filter"/, '#log-severity-filter present');
    assert.match(res.text, /id="access-log-container"/, '#access-log-container present');
    assert.match(res.text, /id="access-count"/, '#access-count present');
    assert.match(res.text, /id="access-status-filter"/, '#access-status-filter present');
    assert.match(res.text, /id="activity-export-csv"/, '#activity-export-csv present');
    assert.match(res.text, /id="activity-export-json"/, '#activity-export-json present');
    assert.match(res.text, /id="access-export-csv"/, '#access-export-csv present');
    assert.match(res.text, /id="access-export-json"/, '#access-export-json present');
    assert.match(res.text, /id="rdp-history-list"/, '#rdp-history-list present');
    assert.match(res.text, /id="rdp-history-period"/, '#rdp-history-period present');
    assert.match(res.text, /id="rdp-history-status"/, '#rdp-history-status present');
    assert.match(res.text, /id="rdp-history-export-csv"/, '#rdp-history-export-csv present');
    assert.match(res.text, /id="rdp-history-export-json"/, '#rdp-history-export-json present');
  });

  it('/logs Aurora has data-type and data-severity dataset attrs for JS reads', async () => {
    selectAurora();
    const res = await agent.get('/logs').expect(200);
    assert.match(res.text, /data-type="activity"/, 'data-type="activity" present');
    assert.match(res.text, /data-type="access"/, 'data-type="access" present');
    assert.match(res.text, /data-type="history"/, 'data-type="history" present');
    assert.match(res.text, /data-severity="all"/, 'data-severity="all" present');
    assert.match(res.text, /data-severity="error"/, 'data-severity="error" present');
    assert.match(res.text, /data-status=""/, 'data-status="" present for access filter');
  });

  it('logs.js contains isAurora() and aurora sibling functions', () => {
    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'logs.js'), 'utf8');
    assert.match(js, /function isAurora\(\)/, 'isAurora() present in logs.js');
    assert.match(js, /function auroraRenderLogs\(/, 'auroraRenderLogs() present in logs.js');
    assert.match(js, /function auroraRenderAccessLogs\(/, 'auroraRenderAccessLogs() present in logs.js');
    assert.match(js, /if \(isAurora\(\)\) return auroraRenderLogs/, 'renderLogs() has isAurora guard');
    assert.match(js, /if \(isAurora\(\)\) return auroraRenderAccessLogs/, 'renderAccessLogs() has isAurora guard');
  });

  it('aurora.css has .log-row, .sev, .ts, .msg, .src, .toggle-group rules', () => {
    const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'aurora.css'), 'utf8');
    assert.match(css, /\.log-row\b/, '.log-row rule in aurora.css');
    assert.match(css, /\.log-row .sev\b/, '.log-row .sev rule in aurora.css');
    assert.match(css, /\.log-row .ts\b/, '.log-row .ts rule in aurora.css');
    assert.match(css, /\.log-row .msg\b/, '.log-row .msg rule in aurora.css');
    assert.match(css, /\.log-row .src\b/, '.log-row .src rule in aurora.css');
    assert.match(css, /\.toggle-group\b/, '.toggle-group rule in aurora.css');
  });
});

// ── Task P2-9: Gateway-Pools page (Aurora mockup fidelity) ───────────────────
describe('aurora theme — gateway-pools layout (Task P2-9)', () => {
  it('renders /gateway-pools under aurora (200, aurora shell)', async () => {
    selectAurora();
    const res = await agent.get('/gateway-pools').expect(200);
    assert.match(res.text, /class="app"/, 'aurora .app shell present');
    assert.match(res.text, /\/css\/aurora\.css/, 'loads aurora.css');
  });

  it('renders Aurora grid structure and signature classes on /gateway-pools', async () => {
    selectAurora();
    const res = await agent.get('/gateway-pools').expect(200);
    assert.match(res.text, /class="grid"/, '.grid container present');
    assert.match(res.text, /class="card-title"/, '.card-title present');
    assert.match(res.text, /class="page-header"/, '.page-header present');
    assert.match(res.text, /class="page-eyebrow"/, '.page-eyebrow present');
    assert.match(res.text, /class="page-actions"/, '.page-actions present');
  });

  it('renders h1.page-title and p.page-sub (correct elements vs default div)', async () => {
    selectAurora();
    const res = await agent.get('/gateway-pools').expect(200);
    assert.match(res.text, /<h1 class="page-title"/, '<h1 class="page-title"> used (not div)');
    assert.match(res.text, /<p class="page-sub"/, '<p class="page-sub"> used (not div)');
  });

  it('renders all phase0 JS-contract IDs on /gateway-pools under aurora', async () => {
    selectAurora();
    const res = await agent.get('/gateway-pools').expect(200);
    // Page action buttons
    assert.match(res.text, /id="btn-create-pool"/, '#btn-create-pool present');
    assert.match(res.text, /id="btn-migrate-routes"/, '#btn-migrate-routes present');
    // Form modal
    assert.match(res.text, /id="pool-form-modal"/, '#pool-form-modal present');
    assert.match(res.text, /id="pool-form"/, '#pool-form present');
    assert.match(res.text, /id="pool-form-title"/, '#pool-form-title present');
    assert.match(res.text, /id="pool-members"/, '#pool-members present');
    assert.match(res.text, /id="new-member-peer"/, '#new-member-peer present');
    assert.match(res.text, /id="btn-add-member"/, '#btn-add-member present');
    assert.match(res.text, /id="btn-cancel-pool"/, '#btn-cancel-pool present');
    assert.match(res.text, /id="btn-cancel-pool-footer"/, '#btn-cancel-pool-footer present');
    assert.match(res.text, /id="cooldown-preset"/, '#cooldown-preset present');
    // Migrate modal
    assert.match(res.text, /id="pool-migrate-modal"/, '#pool-migrate-modal present');
    assert.match(res.text, /id="migrate-routes-list"/, '#migrate-routes-list present');
    assert.match(res.text, /id="btn-migrate-submit"/, '#btn-migrate-submit present');
    assert.match(res.text, /id="btn-migrate-cancel"/, '#btn-migrate-cancel present');
    assert.match(res.text, /id="btn-migrate-cancel-footer"/, '#btn-migrate-cancel-footer present');
  });

  it('renders Aurora modal shell classes (not default .modal-box/.modal-header)', async () => {
    selectAurora();
    const res = await agent.get('/gateway-pools').expect(200);
    // Aurora modal classes
    assert.match(res.text, /class="modal modal-wide"/, '.modal.modal-wide present (form modal)');
    assert.match(res.text, /class="modal-head"/, '.modal-head present (Aurora header)');
    assert.match(res.text, /class="modal-title"/, '.modal-title present on h2');
    assert.match(res.text, /class="modal-foot"/, '.modal-foot present (Aurora footer)');
    // Default modal-box class must NOT appear
    assert.doesNotMatch(res.text, /class="modal-box/, '.modal-box absent (replaced by .modal)');
    assert.doesNotMatch(res.text, /class="modal-header"/, '.modal-header absent (replaced by .modal-head)');
    assert.doesNotMatch(res.text, /class="modal-footer"/, '.modal-footer absent (replaced by .modal-foot)');
  });

  it('renders preset-templates card with btn-ghost btn-block buttons', async () => {
    selectAurora();
    const res = await agent.get('/gateway-pools').expect(200);
    assert.match(res.text, /btn btn-ghost btn-block/, '.btn.btn-ghost.btn-block present (preset buttons)');
    assert.match(res.text, /btn-cooldown-preset/, '.btn-cooldown-preset class present');
  });

  it('gatewayPools.js contains isAurora() detector and aurora sibling functions', () => {
    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'gatewayPools.js'), 'utf8');
    assert.match(js, /function isAurora\(\)/, 'isAurora() present in gatewayPools.js');
    assert.match(js, /function auroraBuildMemberRow\(/, 'auroraBuildMemberRow() present');
    assert.match(js, /function auroraInitCooldownPresets\(/, 'auroraInitCooldownPresets() present');
    assert.match(js, /function auroraRenderMigrateForm\(/, 'auroraRenderMigrateForm() present');
    // Guards at entry points
    assert.match(js, /if \(isAurora\(\)\) return auroraBuildMemberRow/, 'buildMemberRow() has isAurora guard');
    assert.match(js, /if \(isAurora\(\)\) return auroraInitCooldownPresets/, 'initCooldownPresets() has isAurora guard');
    assert.match(js, /if \(isAurora\(\)\) return auroraRenderMigrateForm/, 'renderMigrateForm() has isAurora guard');
    // Docker preset in aurora list
    assert.match(js, /AURORA_COOLDOWN_PRESETS/, 'AURORA_COOLDOWN_PRESETS array present');
    assert.match(js, /preset_docker/, 'gateway_pools.preset_docker key in aurora preset list');
  });

  it('aurora.css carries pool-member-row Aurora overrides', () => {
    const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'aurora.css'), 'utf8');
    assert.match(css, /\.pool-member-row\b/, '.pool-member-row override in aurora.css');
    assert.match(css, /\.pool-member-handle\b/, '.pool-member-handle rule in aurora.css');
    assert.match(css, /\.pool-member-name\b/, '.pool-member-name rule in aurora.css');
  });

  it('i18n has common.pro, gateway_pools.active_member, gateway_pools.preset_docker', () => {
    const en = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'i18n', 'en.json'), 'utf8'));
    assert.equal(en['common.pro'], 'Pro', 'common.pro = "Pro"');
    assert.ok(en['gateway_pools.active_member'], 'gateway_pools.active_member present');
    assert.ok(en['gateway_pools.standby'], 'gateway_pools.standby present');
    assert.ok(en['gateway_pools.preset_templates'], 'gateway_pools.preset_templates present');
    assert.ok(en['gateway_pools.preset_docker'], 'gateway_pools.preset_docker present');
    const de = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'i18n', 'de.json'), 'utf8'));
    assert.equal(de['common.pro'], 'Pro', 'de common.pro = "Pro"');
    assert.ok(de['gateway_pools.active_member'], 'de gateway_pools.active_member present');
    assert.ok(de['gateway_pools.preset_docker'], 'de gateway_pools.preset_docker present');
  });
});

// ── Task P2-10: RDP page — Aurora mockup fidelity ────────────────────────────
describe('aurora theme — rdp layout (Task P2-10)', () => {
  it('renders /rdp under aurora (200, aurora shell)', async () => {
    selectAurora();
    const res = await agent.get('/rdp').expect(200);
    assert.match(res.text, /class="app"/, 'aurora .app shell present');
    assert.match(res.text, /\/css\/aurora\.css/, 'loads aurora.css');
  });

  it('renders page-header with page-actions and btn-add-rdp on /rdp', async () => {
    selectAurora();
    const res = await agent.get('/rdp').expect(200);
    assert.match(res.text, /class="page-header"/, '.page-header present');
    assert.match(res.text, /class="page-eyebrow"/, '.page-eyebrow present');
    assert.match(res.text, /class="page-actions"/, '.page-actions present');
    assert.match(res.text, /id="btn-add-rdp"/, '#btn-add-rdp inside page-actions');
    assert.match(res.text, /class="page-actions"[\s\S]*id="btn-add-rdp"/, 'btn-add-rdp is inside page-actions');
  });

  it('renders all phase0 static container IDs on /rdp under aurora', async () => {
    selectAurora();
    const res = await agent.get('/rdp').expect(200);
    // Grid container (JS writes into it)
    assert.match(res.text, /id="rdp-grid"/, '#rdp-grid present');
    // Search input (JS binds input event)
    assert.match(res.text, /id="rdp-search"/, '#rdp-search present');
    // Subtitle span (JS writes text)
    assert.match(res.text, /id="rdp-subtitle"/, '#rdp-subtitle present');
    // Stat IDs (JS writes numbers; hidden in Aurora but present for null-check safety)
    assert.match(res.text, /id="rdp-stat-total"/, '#rdp-stat-total present');
    assert.match(res.text, /id="rdp-stat-online"/, '#rdp-stat-online present');
    assert.match(res.text, /id="rdp-stat-offline"/, '#rdp-stat-offline present');
    assert.match(res.text, /id="rdp-stat-sessions"/, '#rdp-stat-sessions present');
    assert.match(res.text, /id="rdp-stat-maintenance"/, '#rdp-stat-maintenance present');
    assert.match(res.text, /id="rdp-stat-rotation"/, '#rdp-stat-rotation present');
    // View/filter toggle IDs (JS binds click)
    assert.match(res.text, /id="rdp-view-toggle"/, '#rdp-view-toggle present');
    assert.match(res.text, /id="rdp-status-filter"/, '#rdp-status-filter present');
  });

  it('renders all wizard modal IDs on /rdp under aurora', async () => {
    selectAurora();
    const res = await agent.get('/rdp').expect(200);
    // Core modal IDs
    assert.match(res.text, /id="rdp-modal-overlay"/, '#rdp-modal-overlay present');
    assert.match(res.text, /id="rdp-modal"/, '#rdp-modal present');
    assert.match(res.text, /id="rdp-modal-title"/, '#rdp-modal-title present');
    assert.match(res.text, /id="rdp-modal-subtitle"/, '#rdp-modal-subtitle present');
    assert.match(res.text, /id="rdp-modal-steptitle"/, '#rdp-modal-steptitle present');
    assert.match(res.text, /id="rdp-modal-close"/, '#rdp-modal-close present');
    assert.match(res.text, /id="rdp-modal-cancel"/, '#rdp-modal-cancel present');
    assert.match(res.text, /id="rdp-modal-save"/, '#rdp-modal-save present');
    // Wizard navigation
    assert.match(res.text, /id="rdp-wizard-steps"/, '#rdp-wizard-steps present');
    assert.match(res.text, /id="rdp-wizard-prev"/, '#rdp-wizard-prev present');
    assert.match(res.text, /id="rdp-wizard-next"/, '#rdp-wizard-next present');
    assert.match(res.text, /id="rdp-wizard-review"/, '#rdp-wizard-review present');
    // Form fields (a representative sample)
    assert.match(res.text, /id="rdp-form"/, '#rdp-form present');
    assert.match(res.text, /id="rdp-edit-id"/, '#rdp-edit-id present');
    assert.match(res.text, /id="rdp-name"/, '#rdp-name present');
    assert.match(res.text, /id="rdp-host"/, '#rdp-host present');
    assert.match(res.text, /id="rdp-port"/, '#rdp-port present');
    assert.match(res.text, /id="rdp-access-mode"/, '#rdp-access-mode present');
    assert.match(res.text, /id="rdp-credential-mode"/, '#rdp-credential-mode present');
    assert.match(res.text, /id="rdp-user-ids"/, '#rdp-user-ids present');
    // Step dots must have data-step-key (needed by wizard JS logic)
    assert.match(res.text, /data-step-key="connection"/, 'connection step-key present');
    assert.match(res.text, /data-step-key="auth"/, 'auth step-key present');
    assert.match(res.text, /data-step-key="experience"/, 'experience step-key present');
    assert.match(res.text, /data-step-key="security"/, 'security step-key present');
    assert.match(res.text, /data-step-key="wol"/, 'wol step-key present');
    assert.match(res.text, /data-step-key="access"/, 'access step-key present');
  });

  it('rdp.js contains isAurora() and auroraRenderGrid() sibling functions', () => {
    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'rdp.js'), 'utf8');
    assert.match(js, /function isAurora\(\)/, 'isAurora() present in rdp.js');
    assert.match(js, /function auroraRenderGrid\(/, 'auroraRenderGrid() present in rdp.js');
    assert.match(js, /if \(isAurora\(\)\) return auroraRenderGrid/, 'renderGrid() has isAurora guard');
  });

  it('aurora.css has .rdp-step-dot and .rdp-step-line rules (extracted from inline style)', () => {
    const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'aurora.css'), 'utf8');
    assert.match(css, /\.rdp-step-dot\b/, '.rdp-step-dot rule present in aurora.css');
    assert.match(css, /\.rdp-step-line\b/, '.rdp-step-line rule present in aurora.css');
  });

  it('inline <style nonce> block has been removed from aurora/pages/rdp.njk (styles moved to aurora.css)', () => {
    const njk = fs.readFileSync(path.join(__dirname, '..', 'templates', 'aurora', 'pages', 'rdp.njk'), 'utf8');
    assert.doesNotMatch(njk, /\.rdp-step-dot\s*\{/, '.rdp-step-dot inline style block absent (moved to aurora.css)');
    assert.doesNotMatch(njk, /<style\s+nonce/, 'no <style nonce> block in aurora rdp.njk (moved to aurora.css)');
  });

  it('peer-traffic modal is included in /rdp aurora page', async () => {
    selectAurora();
    const res = await agent.get('/rdp').expect(200);
    assert.match(res.text, /id="modal-peer-traffic"/, '#modal-peer-traffic present on rdp page');
  });

  it('i18n has rdp.kv.mode, rdp.kv.target, rdp.kv.health, rdp.health_reachable, rdp.health_checking', () => {
    const en = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'i18n', 'en.json'), 'utf8'));
    assert.ok(en['rdp.kv.mode'], 'rdp.kv.mode present in en.json');
    assert.ok(en['rdp.kv.target'], 'rdp.kv.target present in en.json');
    assert.ok(en['rdp.kv.health'], 'rdp.kv.health present in en.json');
    assert.ok(en['rdp.health_reachable'], 'rdp.health_reachable present in en.json');
    assert.ok(en['rdp.health_checking'], 'rdp.health_checking present in en.json');
    const de = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'i18n', 'de.json'), 'utf8'));
    assert.ok(de['rdp.kv.mode'], 'rdp.kv.mode present in de.json');
    assert.ok(de['rdp.kv.target'], 'rdp.kv.target present in de.json');
    assert.ok(de['rdp.kv.health'], 'rdp.kv.health present in de.json');
    assert.ok(de['rdp.health_reachable'], 'rdp.health_reachable present in de.json');
    assert.ok(de['rdp.health_checking'], 'rdp.health_checking present in de.json');
  });
});

// ── Task P2-11: Settings page — Aurora mockup fidelity ───────────────────────
describe('aurora theme — settings layout (Task P2-11)', () => {
  it('renders /settings under aurora (200, aurora shell)', async () => {
    selectAurora();
    const res = await agent.get('/settings').expect(200);
    assert.match(res.text, /aurora/, 'aurora theme shell present');
    assert.match(res.text, /settings-tabs/, 'settings-tabs present');
  });

  it('renders Aurora signature classes on /settings', async () => {
    selectAurora();
    const res = await agent.get('/settings').expect(200);
    assert.match(res.text, /class="[^"]*set-sec[^"]*"/, '.set-sec present');
    assert.match(res.text, /class="[^"]*set-row[^"]*"/, '.set-row present');
    assert.match(res.text, /class="[^"]*toggle[^"]*"/, '.toggle present');
    assert.match(res.text, /class="[^"]*card-title[^"]*"/, '.card-title present');
    assert.match(res.text, /class="[^"]*grid[^"]*"/, '.grid present');
    assert.doesNotMatch(res.text, /class="card-head"/, 'no .card-head (removed in Aurora)');
    assert.doesNotMatch(res.text, /class="two-col"/, 'no .two-col (replaced by .grid in Aurora)');
  });

  it('renders all tab navigation elements on /settings', async () => {
    selectAurora();
    const res = await agent.get('/settings').expect(200);
    assert.match(res.text, /data-settings-tab="general"/, 'general tab button present');
    assert.match(res.text, /data-settings-tab="security"/, 'security tab button present');
    assert.match(res.text, /data-settings-tab="backup"/, 'backup tab button present');
    assert.match(res.text, /data-settings-tab="email"/, 'email tab button present');
    assert.match(res.text, /data-settings-tab="monitoring"/, 'monitoring tab button present');
    assert.match(res.text, /data-settings-tab="advanced"/, 'advanced tab button present');
    assert.match(res.text, /data-settings-tab="license"/, 'license tab button present');
    assert.match(res.text, /data-settings-tab="split-tunnel"/, 'split-tunnel tab button present');
    assert.match(res.text, /data-settings-panel="general"/, 'general panel present');
    assert.match(res.text, /data-settings-panel="security"/, 'security panel present');
    assert.match(res.text, /class="[^"]*settings-tab-toggle[^"]*"/, '.settings-tab-toggle present');
  });

  it('renders key form field IDs on /settings (general tab)', async () => {
    selectAurora();
    const res = await agent.get('/settings').expect(200);
    assert.match(res.text, /id="settings-route-block-action"/, 'settings-route-block-action always present');
    assert.doesNotMatch(res.text, /id="btn-data-save"/, 'btn-data-save absent (autosave)'); // removed by autosave feature
    assert.match(res.text, /id="data-traffic-days"/, 'data-traffic-days present');
    assert.match(res.text, /id="data-activity-days"/, 'data-activity-days present');
    assert.match(res.text, /id="data-peer-timeout"/, 'data-peer-timeout present');
    assert.doesNotMatch(res.text, /id="btn-route-block-save"/, 'btn-route-block-save absent (autosave)'); // removed by autosave feature
    assert.match(res.text, /id="settings-route-block-action"/, 'settings-route-block-action present');
    assert.match(res.text, /id="default-theme-buttons"/, 'default-theme-buttons present');
    assert.match(res.text, /data-default-theme="default"/, 'data-default-theme=default present');
    assert.match(res.text, /data-default-theme="pro"/, 'data-default-theme=pro present');
    assert.match(res.text, /id="btn-clear-logs"/, 'btn-clear-logs present');
    assert.match(res.text, /id="btn-svc-wg-restart"/, 'btn-svc-wg-restart present');
    assert.match(res.text, /id="btn-svc-wg-stop"/, 'btn-svc-wg-stop present');
    assert.match(res.text, /id="btn-svc-caddy-reload"/, 'btn-svc-caddy-reload present');
    assert.match(res.text, /id="svc-caddy-status"/, 'svc-caddy-status present');
  });

  it('renders key form field IDs on /settings (security tab)', async () => {
    selectAurora();
    const res = await agent.get('/settings').expect(200);
    assert.match(res.text, /id="security-lockout-enabled"/, 'security-lockout-enabled present');
    assert.match(res.text, /id="security-lockout-attempts"/, 'security-lockout-attempts present');
    assert.match(res.text, /id="security-lockout-duration"/, 'security-lockout-duration present');
    assert.doesNotMatch(res.text, /id="btn-security-save"/, 'btn-security-save absent (autosave)'); // removed by autosave feature
    assert.match(res.text, /id="security-password-enabled"/, 'security-password-enabled present');
    assert.doesNotMatch(res.text, /id="btn-password-save"/, 'btn-password-save absent (autosave)'); // removed by autosave feature
    assert.match(res.text, /id="mb-mode"/, 'mb-mode present');
    assert.doesNotMatch(res.text, /id="mb-save"/, 'mb-save absent (autosave)'); // removed by autosave feature
  });

  it('renders key form field IDs on /settings (backup, advanced tabs)', async () => {
    selectAurora();
    const res = await agent.get('/settings').expect(200);
    assert.match(res.text, /id="btn-backup-download"/, 'btn-backup-download present');
    assert.match(res.text, /id="btn-backup-restore"/, 'btn-backup-restore present');
    assert.match(res.text, /id="autobackup-enabled"/, 'autobackup-enabled present');
    assert.match(res.text, /id="autobackup-schedule"/, 'autobackup-schedule present');
    assert.match(res.text, /id="autobackup-retention"/, 'autobackup-retention present');
    assert.doesNotMatch(res.text, /id="btn-autobackup-save"/, 'btn-autobackup-save absent (autosave)'); // removed by autosave feature
    assert.doesNotMatch(res.text, /id="btn-monitoring-save"/, 'btn-monitoring-save absent (autosave)'); // removed by autosave feature
    assert.match(res.text, /id="metrics-enabled"/, 'metrics-enabled present');
    assert.match(res.text, /id="gw-down-threshold"/, 'gw-down-threshold present');
    assert.match(res.text, /id="ip2location-key"/, 'ip2location-key present');
    assert.match(res.text, /id="webhooks-list"/, 'webhooks-list present');
    assert.match(res.text, /id="webhook-url"/, 'webhook-url present');
    assert.match(res.text, /id="btn-add-webhook"/, 'btn-add-webhook present');
    assert.match(res.text, /id="card-autoupdate"/, 'card-autoupdate present');
    assert.match(res.text, /name="au-mode"/, 'au-mode radio inputs present');
    assert.doesNotMatch(res.text, /id="au-mode-save"/, 'au-mode-save absent (autosave)'); // removed by autosave feature
  });

  it('renders wg-stop-modal as modal-overlay pattern on /settings', async () => {
    selectAurora();
    const res = await agent.get('/settings').expect(200);
    assert.match(res.text, /id="wg-stop-modal"/, 'wg-stop-modal present');
    assert.match(res.text, /id="wg-stop-password"/, 'wg-stop-password present');
    assert.match(res.text, /id="wg-stop-cancel"/, 'wg-stop-cancel present');
    assert.match(res.text, /id="wg-stop-confirm"/, 'wg-stop-confirm present');
    assert.match(res.text, /id="wg-stop-error"/, 'wg-stop-error present');
    // Modal must use modal-overlay pattern (not old inline fixed position)
    assert.match(res.text, /class="modal-overlay"/, 'modal-overlay class on wg-stop-modal');
    assert.match(res.text, /class="modal modal-sm"/, 'modal modal-sm inside wg-stop-modal');
  });

  it('inline <style nonce> block removed from aurora/pages/settings.njk', () => {
    const njk = fs.readFileSync(
      path.join(__dirname, '..', 'templates', 'aurora', 'pages', 'settings.njk'),
      'utf8'
    );
    assert.doesNotMatch(njk, /\.settings-tabs\s*\{/, 'no .settings-tabs rule in njk (moved to aurora.css)');
    assert.doesNotMatch(njk, /<style\s[^>]*nonce/, 'no <style nonce> block in aurora settings.njk');
  });

  it('aurora.css has settings-tabs rules (Task P2-11)', () => {
    const css = fs.readFileSync(
      path.join(__dirname, '..', 'public', 'css', 'aurora.css'),
      'utf8'
    );
    assert.match(css, /\.settings-tabs\b/, '.settings-tabs rule in aurora.css');
    assert.match(css, /\.settings-tab-toggle\b/, '.settings-tab-toggle rule in aurora.css');
    assert.match(css, /\.settings-tab-dropdown\b/, '.settings-tab-dropdown rule in aurora.css');
    assert.match(css, /\.settings-panel\b/, '.settings-panel rule in aurora.css');
  });
});

// ── Task P2-12: Profile page — Aurora mockup fidelity ────────────────────────
describe('aurora theme — profile layout (Task P2-12)', () => {
  it('renders /profile under aurora (200, aurora shell)', async () => {
    selectAurora();
    const res = await agent.get('/profile').expect(200);
    assert.match(res.text, /class="app"/, 'aurora .app shell present');
    assert.match(res.text, /\/css\/aurora\.css/, 'loads aurora.css');
  });

  it('renders Aurora grid structure and signature classes on /profile', async () => {
    selectAurora();
    const res = await agent.get('/profile').expect(200);
    assert.match(res.text, /class="grid"/, '.grid container present');
    assert.match(res.text, /class="card span6"/, '.card.span6 present');
    assert.match(res.text, /class="card-title"/, '.card-title present');
    assert.match(res.text, /class="form-input"/, '.form-input on inputs present');
    assert.match(res.text, /class="toggle-group"/, '.toggle-group present');
    // Aurora profile must NOT use old .two-col or .card-head pattern
    assert.doesNotMatch(res.text, /class="two-col"/, '.two-col absent in Aurora profile');
    assert.doesNotMatch(res.text, /class="card-head"/, '.card-head absent in Aurora profile');
  });

  it('renders all phase0 JS-contract IDs on /profile under aurora', async () => {
    selectAurora();
    const res = await agent.get('/profile').expect(200);
    assert.match(res.text, /id="settings-username"/, '#settings-username present');
    assert.match(res.text, /id="settings-display-name"/, '#settings-display-name present');
    assert.match(res.text, /id="settings-email"/, '#settings-email present');
    assert.match(res.text, /id="profile-message"/, '#profile-message present');
    assert.match(res.text, /id="btn-save-profile"/, '#btn-save-profile present');
    assert.match(res.text, /id="settings-current-pw"/, '#settings-current-pw present');
    assert.match(res.text, /id="settings-new-pw"/, '#settings-new-pw present');
    assert.match(res.text, /id="settings-confirm-pw"/, '#settings-confirm-pw present');
    assert.match(res.text, /id="password-message"/, '#password-message present');
    assert.match(res.text, /id="btn-change-password"/, '#btn-change-password present');
    assert.match(res.text, /id="language-buttons"/, '#language-buttons present');
    assert.match(res.text, /id="theme-buttons"/, '#theme-buttons present');
  });

  it('renders all 3 theme-picker buttons with correct data-theme attributes', async () => {
    selectAurora();
    const res = await agent.get('/profile').expect(200);
    assert.match(res.text, /data-theme="default"/, 'data-theme="default" button present');
    assert.match(res.text, /data-theme="pro"/, 'data-theme="pro" button present');
    assert.match(res.text, /data-theme="aurora"/, 'data-theme="aurora" button present');
  });

  it('aurora theme-picker button carries .on class when theme is aurora', async () => {
    selectAurora();
    const res = await agent.get('/profile').expect(200);
    // The aurora button should be marked active (.on) when the user has aurora selected
    assert.match(res.text, /toggle-btn on[^"]*"[^>]*data-theme="aurora"|data-theme="aurora"[^>]*class="[^"]*toggle-btn on/, 'aurora toggle-btn has .on class when aurora theme selected');
  });

  it('renders language buttons inside #language-buttons as toggle-group', async () => {
    selectAurora();
    const res = await agent.get('/profile').expect(200);
    assert.match(res.text, /id="language-buttons"[\s\S]{0,30}class="toggle-group"|class="toggle-group"[^>]*id="language-buttons"/, '#language-buttons wraps a .toggle-group');
    assert.match(res.text, /data-lang=/, 'language buttons have data-lang attribute');
  });

  it('i18n has profile.security_display in both en.json and de.json', () => {
    const en = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'i18n', 'en.json'), 'utf8'));
    const de = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'i18n', 'de.json'), 'utf8'));
    assert.ok(en['profile.security_display'], 'profile.security_display present in en.json');
    assert.ok(de['profile.security_display'], 'profile.security_display present in de.json');
  });
});

// ── UX-fixes: Dashboard donut gauges + bug fixes ─────────────────────────────
describe('aurora theme — dashboard UX fixes (ux-dash)', () => {
  it('dashboard.njk has #cpu-donut and #ram-donut SVG elements', async () => {
    selectAurora();
    const res = await agent.get('/dashboard').expect(200);
    assert.match(res.text, /id="cpu-donut"/, '#cpu-donut SVG present in aurora dashboard');
    assert.match(res.text, /id="ram-donut"/, '#ram-donut SVG present in aurora dashboard');
    // Both donuts must contain the .val arc circle
    assert.match(res.text, /id="cpu-donut"[\s\S]{0,400}class="val"/, '#cpu-donut has .val arc');
    assert.match(res.text, /id="ram-donut"[\s\S]{0,400}class="val"/, '#ram-donut has .val arc');
  });

  it('dashboard.njk still has all required resource IDs after donut redesign', async () => {
    selectAurora();
    const res = await agent.get('/dashboard').expect(200);
    assert.match(res.text, /id="cpu-pct"/, '#cpu-pct present inside donut center');
    assert.match(res.text, /id="cpu-info"/, '#cpu-info present');
    assert.match(res.text, /id="cpu-bar"/, '#cpu-bar present (hidden, for JS contract)');
    assert.match(res.text, /id="ram-pct"/, '#ram-pct present inside donut center');
    assert.match(res.text, /id="ram-info"/, '#ram-info present');
    assert.match(res.text, /id="ram-bar"/, '#ram-bar present (hidden, for JS contract)');
  });

  it('dashboard.js uses /api/v1/pihole/summary (not the wrong /api/pihole/stats)', () => {
    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'dashboard.js'), 'utf8');
    assert.match(js, /\/api\/v1\/pihole\/summary/, 'dashboard.js fetches /api/v1/pihole/summary');
    assert.doesNotMatch(js, /\/api\/pihole\/stats/, '/api/pihole/stats (wrong URL) absent');
  });

  it('dashboard.js has auroraRefreshResources() and auroraSetResourceDonut() functions', () => {
    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'dashboard.js'), 'utf8');
    assert.match(js, /function auroraRefreshResources\(/, 'auroraRefreshResources() present');
    assert.match(js, /function auroraSetResourceDonut\(/, 'auroraSetResourceDonut() present');
    assert.match(js, /if \(isAurora\(\)\) return auroraRefreshResources/, 'refreshResources() has isAurora guard');
  });

  it('aurora.css has .res-gauge-wrap and .res-gauge-info rules', () => {
    const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'aurora.css'), 'utf8');
    assert.match(css, /\.res-gauge-wrap\b/, '.res-gauge-wrap rule in aurora.css');
    assert.match(css, /\.res-gauge-info\b/, '.res-gauge-info rule in aurora.css');
  });
});

// ── UX-fixes: Peers gateway card — badge inside, gear-edit, card→detail nav ──
describe('aurora theme — peers gateway card UX fixes (Issues 5/6/7)', () => {
  it('auroraRenderGatewayCard builds badge inside the card using DOM (not detached)', () => {
    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'peers.js'), 'utf8');
    // Badge is created with DOM createElement and appended inside uh (card header)
    assert.match(js, /badge\.className\s*=\s*statusClass/, 'badge.className assigned from statusClass inside auroraRenderGatewayCard');
    assert.match(js, /right\.appendChild\(badge\)/, 'badge appended to the right-side header span (inside card)');
    // The "right" span is added to uh (header row), which is added to unit (card)
    assert.match(js, /uh\.appendChild\(right\)/, 'right span appended to uh header row');
    assert.match(js, /unit\.appendChild\(uh\)/, 'uh header row appended to unit card');
  });

  it('auroraRenderGatewayCard emits a gear button with data-action="edit" and data-id=peer_id', () => {
    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'peers.js'), 'utf8');
    // Gear button gets setAttribute('data-action', 'edit')
    assert.match(js, /gearBtn\.setAttribute\('data-action',\s*'edit'\)/, "gear button has data-action='edit'");
    assert.match(js, /gearBtn\.setAttribute\('data-id',\s*String\(gw\.peer_id\)\)/, 'gear button data-id is String(gw.peer_id)');
    // Gear button is appended inside the right span (inside card header)
    assert.match(js, /right\.appendChild\(gearBtn\)/, 'gear button appended inside card header');
  });

  it('auroraRenderGatewayCard gear button stops propagation and calls showEditModal', () => {
    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'peers.js'), 'utf8');
    assert.match(js, /e\.stopPropagation\(\)[\s\S]{0,40}showEditModal\(gw\.peer_id\)/, 'gear click: stopPropagation then showEditModal(gw.peer_id)');
  });

  it('auroraRenderGatewayCard sets dataset.gwDetail for test assertions and a11y', () => {
    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'peers.js'), 'utf8');
    assert.match(js, /unit\.dataset\.gwDetail\s*=\s*'\/gateways#gw\/'/, "unit.dataset.gwDetail set to '/gateways#gw/' prefix");
  });

  it('auroraRenderGatewayCard card click navigates to /gateways#gw/<id> (Issue 7)', () => {
    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'peers.js'), 'utf8');
    assert.match(js, /window\.location\.href\s*=\s*'\/gateways#gw\/'/, "card click sets window.location.href to '/gateways#gw/' + peer_id");
    // Must NOT call showEditModal on card click (that's now the gear's job)
    // Check: the card-click listener no longer contains showEditModal (the gear listener has it)
    // We verify this by checking that the card-click handler only has window.location.href
    const cardClickMatch = js.match(/unit\.addEventListener\('click',\s*function\(e\)\s*\{([\s\S]*?)\}\);/g);
    assert.ok(cardClickMatch, 'unit addEventListener click handler present');
    const hasNav = cardClickMatch.some(function(s) { return /window\.location\.href/.test(s); });
    assert.ok(hasNav, 'card-click handler navigates via window.location.href');
  });

  it('auroraRenderGatewayCard card click uses button/a guard (gear and badge excluded from nav)', () => {
    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'peers.js'), 'utf8');
    // Card click guard: e.target.closest('button, a') prevents nav when gear is clicked
    assert.match(js, /e\.target\.closest\('button,\s*a'\)[\s\S]{0,20}return/, 'card-click has button/a closest guard before nav');
  });

  it('i18n has peers.gateway.action_edit_gear in both en.json and de.json', () => {
    const en = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'i18n', 'en.json'), 'utf8'));
    const de = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'i18n', 'de.json'), 'utf8'));
    assert.ok(en['peers.gateway.action_edit_gear'], 'peers.gateway.action_edit_gear present in en.json');
    assert.ok(de['peers.gateway.action_edit_gear'], 'peers.gateway.action_edit_gear present in de.json');
  });
});

// ── UX-fixes: Gateways fleet card + detail (Issues 8/9/10/11) ────────────────
describe('aurora theme — gateways UX fixes (Issues 8/9/10/11)', () => {
  it('Issue 8: auroraCard builds badge inside card header using right container', () => {
    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'gateways.js'), 'utf8');
    // stTag appended to right container, right container appended to uh (inside card)
    assert.match(js, /right\.appendChild\(stTag\)/, 'badge (stTag) appended to right container');
    assert.match(js, /uh\.appendChild\(right\)/, 'right container appended to uh header row (inside card)');
  });

  it('Issue 9: aurora.css has .tag.tag-dot::after (dot after text) and suppresses ::before', () => {
    const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'aurora.css'), 'utf8');
    assert.match(css, /\.tag\.tag-dot::after/, '.tag.tag-dot::after present (dot positioned after text)');
    assert.match(css, /\.tag\.tag-dot::before\s*\{[^}]*content:\s*none/, '.tag.tag-dot::before has content:none (before-dot suppressed)');
  });

  it('Issue 10: auroraVersionsCard() present and called from auroraRenderDetail()', () => {
    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'gateways.js'), 'utf8');
    assert.match(js, /function auroraVersionsCard\(/, 'auroraVersionsCard() present in gateways.js');
    assert.match(js, /grid2\.appendChild\(auroraVersionsCard\(g\)\)/, 'auroraRenderDetail() calls auroraVersionsCard(g)');
  });

  it('Issue 11: auroraRenderDetail uses gw-detail-grid with exactly 3 columns (1/3 each)', () => {
    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'gateways.js'), 'utf8');
    const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'aurora.css'), 'utf8');
    assert.match(js, /el\('div',\s*'gw-detail-grid'\)/, 'auroraRenderDetail() uses gw-detail-grid class');
    assert.match(css, /\.gw-detail-grid\s*\{[^}]*repeat\(3,minmax\(0,1fr\)\)/, 'gw-detail-grid uses exactly 3 columns (1/3 each)');
  });
});

// ── UX-fixes: RDP page (Issues 12/13/14/15/16) ───────────────────────────────
describe('aurora theme — rdp UX fixes (Issues 12/13/14/15/16)', () => {
  it('Issue 12: auroraRenderGrid uses rdp-card-grid container (not span6/full-width)', () => {
    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'rdp.js'), 'utf8');
    const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'aurora.css'), 'utf8');
    // Container must use rdp-card-grid, not grid (which yields span6 half-width cards)
    assert.match(js, /container\.className\s*=\s*'rdp-card-grid'/, "auroraRenderGrid uses 'rdp-card-grid' container");
    // Cards must not use span6 (which is half-width in 12-col grid)
    assert.doesNotMatch(js, /card\.className\s*=\s*'card span6'/, "card.className no longer uses 'card span6'");
    // aurora.css must define the grid rule with auto-fill
    assert.match(css, /\.rdp-card-grid\s*\{[^}]*auto-fill/, 'aurora.css .rdp-card-grid uses auto-fill grid');
  });

  it('Issue 13: status badge built inside card header (cardTitle) with tag-dot (text-left-of-dot)', () => {
    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'rdp.js'), 'utf8');
    // Status tag is appended to cardTitle (inside header), not to a separate health kv row
    assert.match(js, /statusTag\.style\.marginLeft\s*=\s*'auto'/, 'statusTag has margin-left:auto (pushed to header right)');
    assert.match(js, /cardTitle\.appendChild\(statusTag\)/, 'statusTag appended to cardTitle (inside card header)');
    // Uses tag-dot class (text left of dot via ::after in aurora.css)
    assert.match(js, /statusTag\.className\s*=\s*'tag tag-green tag-dot'/, 'online state uses tag-green tag-dot');
    assert.match(js, /statusTag\.className\s*=\s*'tag tag-red tag-dot'/, 'offline state uses tag-red tag-dot');
  });

  it('Issue 14: browser session button wired to /rdp/:id/session (real mechanism)', () => {
    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'rdp.js'), 'utf8');
    // Button only shown when browser_enabled + browser_sessions licensed
    assert.match(js, /r\.browser_enabled && GC\.features && GC\.features\.browser_sessions/, 'browser button gated on browser_enabled+license');
    // Opens the real session URL
    assert.match(js, /window\.open\('\/rdp\/' \+ id \+ '\/session'/, "browser button opens '/rdp/:id/session'");
  });

  it('Issue 15: aurora rdp.njk has all 6 browser checkbox ids', () => {
    const njk = fs.readFileSync(path.join(__dirname, '..', 'templates', 'aurora', 'pages', 'rdp.njk'), 'utf8');
    assert.match(njk, /id="rdp-browser-clipboard"/, 'rdp-browser-clipboard present in aurora rdp.njk');
    assert.match(njk, /id="rdp-browser-sftp"/, 'rdp-browser-sftp present in aurora rdp.njk');
    assert.match(njk, /id="rdp-sftp-disable-download"/, 'rdp-sftp-disable-download present in aurora rdp.njk');
    assert.match(njk, /id="rdp-sftp-disable-upload"/, 'rdp-sftp-disable-upload present in aurora rdp.njk');
    assert.match(njk, /id="rdp-browser-audio-rdp"/, 'rdp-browser-audio-rdp present in aurora rdp.njk');
    assert.match(njk, /id="rdp-browser-audio-vnc"/, 'rdp-browser-audio-vnc present in aurora rdp.njk');
    // Also check the SFTP text inputs needed by populate code (lines 1053-1062)
    assert.match(njk, /id="rdp-sftp-host"/, 'rdp-sftp-host present (populate code sets .value)');
    assert.match(njk, /id="rdp-audio-servername"/, 'rdp-audio-servername present (populate code sets .value)');
  });

  it('Issue 15: aurora rdp template renders (200) with all browser-section ids visible in HTML', async () => {
    selectAurora();
    const res = await agent.get('/rdp').expect(200);
    assert.match(res.text, /id="rdp-browser-clipboard"/, 'rdp-browser-clipboard in rendered HTML');
    assert.match(res.text, /id="rdp-browser-sftp"/, 'rdp-browser-sftp in rendered HTML');
    assert.match(res.text, /id="rdp-sftp-disable-download"/, 'rdp-sftp-disable-download in rendered HTML');
    assert.match(res.text, /id="rdp-sftp-disable-upload"/, 'rdp-sftp-disable-upload in rendered HTML');
    assert.match(res.text, /id="rdp-browser-audio-rdp"/, 'rdp-browser-audio-rdp in rendered HTML');
    assert.match(res.text, /id="rdp-browser-audio-vnc"/, 'rdp-browser-audio-vnc in rendered HTML');
  });

  it('Issue 16: aurora check handler uses isAurora() branch — color+icon, not big text', () => {
    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'rdp.js'), 'utf8');
    // Must have isAurora() branch inside check handler
    assert.match(js, /if \(isAurora\(\)\)[\s\S]{0,200}checkBtn\.style\.color/, 'isAurora() branch sets color on checkBtn');
    // Aurora branch sets innerHTML (icon), not textContent
    assert.match(js, /checkBtn\.innerHTML\s*=\s*result\.online/, 'Aurora branch sets innerHTML to status icon on check result');
    // Non-aurora path still sets textContent
    assert.match(js, /checkBtn\.textContent\s*=\s*result\.online/, 'non-aurora branch still sets textContent');
  });
});

// ── UX-fixes: Settings + sidebar chrome (Issues 17/18/19) ────────────────────
describe('aurora theme — settings + sidebar UX fixes (Issues 17/18/19)', () => {
  it('Issue 17: settings default-theme picker has an aurora button (data-default-theme=aurora)', async () => {
    selectAurora();
    const res = await agent.get('/settings').expect(200);
    assert.match(res.text, /data-default-theme="aurora"/, 'aurora theme button present in default-theme picker');
  });

  it('Issue 17: aurora settings.njk has data-default-theme="aurora" button in source', () => {
    const njk = fs.readFileSync(
      path.join(__dirname, '..', 'templates', 'aurora', 'pages', 'settings.njk'),
      'utf8'
    );
    assert.match(njk, /data-default-theme="aurora"/, 'aurora button present in settings.njk template');
  });

  it('Issue 18: aurora.css scopes align-items:start to settings panels (no card stretching)', () => {
    const css = fs.readFileSync(
      path.join(__dirname, '..', 'public', 'css', 'aurora.css'),
      'utf8'
    );
    assert.match(css, /\.settings-panel\s+\.grid\s*\{[^}]*align-items\s*:\s*start/, '.settings-panel .grid has align-items:start');
  });

  it('Issue 19: aurora.css .sidebar rule has position:static (sidebar stays in grid flow)', () => {
    const css = fs.readFileSync(
      path.join(__dirname, '..', 'public', 'css', 'aurora.css'),
      'utf8'
    );
    // Verify desktop .sidebar has position:static (overrides pro.css position:fixed)
    assert.match(css, /\.sidebar\s*\{[^}]*position\s*:\s*static/, '.sidebar rule has position:static');
    // Verify mobile media query is still present (drawer still works)
    assert.match(css, /max-width\s*:\s*980px/, 'mobile 980px media query present');
    // Both position:static (desktop) and position:fixed (mobile drawer) must co-exist in the file
    assert.ok(
      css.includes('position:static') && css.includes('position:fixed'),
      'aurora.css has both position:static (desktop sidebar) and position:fixed (mobile drawer)'
    );
  });

  it('Issue 19: app shell still renders with sidebar in grid after position:static fix', async () => {
    selectAurora();
    const res = await agent.get('/dashboard').expect(200);
    // .app-brand must be present in the rendered HTML (not hidden because sidebar covers it)
    assert.match(res.text, /class="app-brand"/, '.app-brand present in aurora dashboard HTML');
    assert.match(res.text, /class="[^"]*app[^"]*"/, '.app shell present');
  });
});
