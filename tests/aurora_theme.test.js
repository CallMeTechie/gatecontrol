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

  it('toggle-group has All/HTTP/L4/RDP buttons with data-value attributes', async () => {
    selectAurora();
    const res = await agent.get('/routes').expect(200);
    assert.match(res.text, /data-value=""/, 'All toggle-btn (data-value="") present');
    assert.match(res.text, /data-value="http"/, 'HTTP toggle-btn present');
    assert.match(res.text, /data-value="l4"/, 'L4 toggle-btn present');
    assert.match(res.text, /data-value="rdp"/, 'RDP toggle-btn present');
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
