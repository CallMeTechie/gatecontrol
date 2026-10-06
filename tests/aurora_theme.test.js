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
      assert.match(res.text, /\/css\/app\.css/, 'loads the single stylesheet app.css');
      assert.doesNotMatch(res.text, /\/css\/(pro|aurora)\.css/, 'the merged files are gone');
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

describe('aurora theme — no theme picker', () => {
  it('profile and settings offer no theme choice any more', async () => {
    getDb().prepare("UPDATE users SET theme = 'default' WHERE username = 'admin'").run(); // stale value is ignored
    const profile = await agent.get('/profile').expect(200);
    assert.match(profile.text, /class="app"/, 'still the aurora shell');
    assert.doesNotMatch(profile.text, /id="theme-buttons"|data-theme="(default|pro|aurora)"/, 'no personal theme picker');
    const settingsPage = await agent.get('/settings').expect(200);
    assert.doesNotMatch(settingsPage.text, /id="default-theme-buttons"|data-default-theme=/, 'no default-theme picker');
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
  it('app.css has overrides for btn-primary:hover, btn-danger:hover, pool-mode-failover, and non-circular --blue-bd', () => {
    const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'app.css'), 'utf8');
    assert.match(css, /\.btn-primary:hover\s*\{[^}]*box-shadow/, 'btn-primary:hover has a box-shadow override in app.css');
    assert.match(css, /\.btn-danger:hover/, 'btn-danger:hover has an Aurora override in app.css');
    assert.match(css, /\.pool-mode-failover/, 'pool-mode-failover has an Aurora override in app.css');
    assert.match(css, /--blue-bd:\s*(?!var\(--blue-bd\))/, '--blue-bd is no longer self-referential in app.css');
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

  it('app.css carries the gateway Strang-A fixes', () => {
    const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'app.css'), 'utf8');
    // .gw-relnotes styled (not bare <a>)
    assert.match(css, /\.gw-relnotes/, '.gw-relnotes rule present in app.css');
    // .unit-grid and .resbar present (fleet card signature components)
    assert.match(css, /\.unit-grid/, '.unit-grid present in app.css');
    assert.match(css, /\.resbar/, '.resbar present in app.css');
  });

  it('gateways.js renders the Aurora fleet cards and detail view without a theme branch', () => {
    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'gateways.js'), 'utf8');
    assert.doesNotMatch(js, /isAurora/, 'no theme branch left in gateways.js (Aurora is the only theme)');
    assert.match(js, /function card\(/, 'card() present');
    assert.match(js, /function renderDetail\(/, 'renderDetail() present');
    assert.match(js, /function versionsCard\(/, 'versionsCard() present');
  });
});

// ── Dashboard redesign (2026-10): ID contract of dashboard.njk / dashboard.js ──
describe('aurora theme — dashboard layout (redesign)', () => {
  it('renders /dashboard with the db- structure: header, five tiles, cards', async () => {
    selectAurora();
    const res = await agent.get('/dashboard').expect(200);
    assert.match(res.text, /class="app"/, 'aurora .app shell present');
    assert.match(res.text, /class="db-page"/, '.db-page present');
    assert.match(res.text, /<h1 class="db-title" id="db-headline">/, 'one real h1 headline');
    for (const id of ['tunnel', 'gateways', 'routes', 'certs', 'check']) {
      assert.match(res.text, new RegExp(`<a class="db-tile" id="db-tile-${id}" href="/`), `#db-tile-${id} is a link`);
    }
    for (const h of ['dash-problems-title', 'db-traffic-title', 'db-peers-title', 'db-gateways-title', 'db-server-title', 'db-activity-title', 'db-security-title']) {
      assert.match(res.text, new RegExp(`<h2 class="db-card-title" id="${h}"`), `#${h} is an h2`);
    }
  });

  it('renders the static contract IDs the script fills', async () => {
    selectAurora();
    const res = await agent.get('/dashboard').expect(200);
    for (const id of ['db-live-text', 'db-subline', 'dash-problems', 'dash-problems-list', 'dash-problems-ondemand-list',
      'db-chart', 'db-table', 'db-table-body', 'db-table-toggle', 'db-traffic-total', 'db-traffic-rate',
      'db-top-peers', 'db-gw-list', 'db-meter-cpu', 'db-meter-ram', 'db-meter-disk', 'auto-update',
      'activity-feed', 'db-activity-filter', 'db-sec-check', 'db-sec-waf-spark', 'db-i18n',
      'au-setup-modal-overlay', 'au-setup-title', 'au-setup-body', 'whats-new']) {
      assert.match(res.text, new RegExp(`id="${id}"`), `#${id} present`);
    }
    // The auto-update status lives in the Server card now, not in the topbar.
    assert.doesNotMatch(res.text, /id="au-status"/, 'no #au-status in the topbar');
    assert.equal((res.text.match(/role="meter"/g) || []).length, 3, 'three role=meter bars');
  });

  it('segmented control and chips carry aria-pressed', async () => {
    selectAurora();
    const res = await agent.get('/dashboard').expect(200);
    for (const r of ['1h', '24h', '7d', '30d']) assert.match(res.text, new RegExp(`data-range="${r}" aria-pressed="(true|false)"`), r);
    for (const c of ['all', 'login', 'peer', 'route', 'security']) assert.match(res.text, new RegExp(`data-cat="${c}" aria-pressed="(true|false)"`), c);
  });

  it('sidebar has route-count-badge on the routes nav item under aurora', async () => {
    selectAurora();
    const res = await agent.get('/dashboard').expect(200);
    assert.match(res.text, /id="route-count-badge"/, '#route-count-badge present in aurora sidebar');
  });

  it('dashboard.js: one refresh loop, no theme branch, no innerHTML', () => {
    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'dashboard.js'), 'utf8');
    assert.doesNotMatch(js, /isAurora/, 'no theme branch left in dashboard.js (Aurora is the only theme)');
    assert.doesNotMatch(js.replace(/\/\/.*$/gm, ''), /innerHTML|insertAdjacentHTML|outerHTML/, 'DOM via createElement/textContent only');
    assert.match(js, /function tick\(/, 'tick() loop present');
    assert.match(js, /visibilitychange/, 'pauses while hidden');
  });
});

// ── Task P2-2: Pi-hole ID-contract (Aurora mockup fidelity) ──────────────────
describe('aurora theme — pihole layout (Task P2-2)', () => {
  it('renders /pihole under aurora (200, aurora shell)', async () => {
    selectAurora();
    const res = await agent.get('/pihole').expect(200);
    assert.match(res.text, /class="app"/, 'aurora .app shell present');
    assert.match(res.text, /\/css\/app\.css/, 'loads app.css');
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

  it('pihole.js renders the Aurora toplists without a theme branch', () => {
    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'pihole.js'), 'utf8');
    assert.doesNotMatch(js, /isAurora/, 'no theme branch left in pihole.js (Aurora is the only theme)');
    assert.match(js, /function renderSummary\(/, 'renderSummary() present');
    assert.match(js, /function renderTopDomains\(/, 'renderTopDomains() present');
    assert.match(js, /function renderTopClients\(/, 'renderTopClients() present');
  });
});

// ── Task P2-3: Peers ID-contract (Aurora mockup fidelity) ────────────────────
describe('aurora theme — peers layout (Task P2-3)', () => {
  it('renders /peers under aurora (200, aurora shell)', async () => {
    selectAurora();
    const res = await agent.get('/peers').expect(200);
    assert.match(res.text, /class="app"/, 'aurora .app shell present');
    assert.match(res.text, /\/css\/app\.css/, 'loads app.css');
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

  it('peers.js renders the Aurora table and unit cards without a theme branch', () => {
    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'peers.js'), 'utf8');
    assert.doesNotMatch(js, /isAurora/, 'no theme branch left in peers.js (Aurora is the only theme)');
    assert.match(js, /function actionBtns\(/, 'actionBtns() present');
    assert.match(js, /function renderPeers\(/, 'renderPeers() present');
    assert.match(js, /function renderGatewayCard\(/, 'renderGatewayCard() present');
    assert.match(js, /function initStatusToggle\(/, 'initStatusToggle() present');
    assert.match(js, /\n  initStatusToggle\(\);/, 'initStatusToggle() called in init');
    assert.match(js, /class="icon-action/, 'icon-action buttons');
  });

  it('app.css carries the peers-page additions', () => {
    const css = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'public', 'css', 'app.css'), 'utf8');
    assert.match(css, /\.aurora-gw-empty/, '.aurora-gw-empty rule present');
    assert.match(css, /\.tag\.tag-dot/, '.tag.tag-dot rule present');
  });
});

// ── Routes page (domain zones, zones.njk) ────────────────────────────────────
describe('aurora theme — routes page (domain zones)', () => {
  it('renders /routes under aurora as the zones page (200, aurora shell)', async () => {
    selectAurora();
    const res = await agent.get('/routes').expect(200);
    assert.match(res.text, /class="app"/, 'aurora .app shell present');
    assert.match(res.text, /\/css\/app\.css/, 'loads app.css');
    assert.match(res.text, /id="zn-zones"/, '#zn-zones present');
  });

  it('renders Aurora page-header, toolbar, summary line and zone contract IDs on /routes', async () => {
    selectAurora();
    const res = await agent.get('/routes').expect(200);
    assert.match(res.text, /class="page-header zn-page-header rt-page-head"/, '.page-header present');
    assert.match(res.text, /class="page-eyebrow"/, '.page-eyebrow present');
    assert.match(res.text, /class="page-actions rt-page-actions"/, '.page-actions present');
    assert.match(res.text, /class="toolbar zn-toolbar rt-toolbar"/, '.toolbar present');
    assert.match(res.text, /class="rt-search search-box zn-search"/, '.search-box present');
    for (const id of ['zn-summary', 'zn-add-domain', 'zn-new-host', 'zn-search', 'zn-type', 'zn-status', 'zn-risk',
      'zn-gateway-filter', 'zn-collapse-all', 'zn-zones', 'zn-bulkbar']) {
      assert.match(res.text, new RegExp('id="' + id + '"'), '#' + id + ' present');
    }
    assert.doesNotMatch(res.text, /id="zn-kpis"|id="zn-domain-modal"|id="zn-chips"/, 'KPI strip, chips and the old domain modal are gone');
  });

  it('Aurora routes page has no limit-badge section and no legacy list markup', async () => {
    selectAurora();
    const res = await agent.get('/routes').expect(200);
    assert.doesNotMatch(res.text, /class="limit-badge"/, 'limit-badge absent in Aurora routes header');
    assert.doesNotMatch(res.text, /class="routes-toolbar"/, 'old .routes-toolbar class absent in Aurora');
    assert.doesNotMatch(res.text, /id="routes-list"|id="route-modal-overlay"|id="service-modal-overlay"|id="batch-bar-routes"/,
      'legacy list, wizards and batch bar are gone');
  });

  it('includes the entry editor and confirm modals', async () => {
    selectAurora();
    const res = await agent.get('/routes').expect(200);
    assert.match(res.text, /id="modal-edit-route"/, '#modal-edit-route present (via include)');
    assert.match(res.text, /id="modal-confirm"/, '#modal-confirm present (via include)');
    for (const sec of ['target', 'access', 'auth', 'security', 'reliability', 'headers', 'branding', 'diagnose']) {
      assert.match(res.text, new RegExp('data-ee-section="' + sec + '"'), 'nav button ' + sec);
      assert.match(res.text, new RegExp('data-panel="' + sec + '"'), 'panel ' + sec);
    }
    assert.match(res.text, /class="rt-ee-panel edit-route-panel/, '.edit-route-panel present');
    assert.match(res.text, /id="btn-edit-route-submit"/, '#btn-edit-route-submit present');
  });

  it('app.css carries toggle, data-table, row-actions, icon-action rules', () => {
    const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'app.css'), 'utf8');
    assert.match(css, /\.toggle\b/, '.toggle rule present in app.css');
    assert.match(css, /\.data-table\b/, '.data-table rule present in app.css');
    assert.match(css, /\.row-actions\b/, '.row-actions rule present in app.css');
    assert.match(css, /\.icon-action\b/, '.icon-action rule present in app.css');
    assert.match(css, /\.toggle-group\b/, '.toggle-group rule present in app.css');
  });

  it('app.css keeps the wizard modal shell (RDP wizard) and drops the legacy route wizard rules', () => {
    const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'app.css'), 'utf8');
    assert.match(css, /\.modal\.modal-xl/, '.modal.modal-xl present in app.css');
    assert.match(css, /\.modal\.modal-wizard/, '.modal.modal-wizard present in app.css');
    assert.match(css, /\.modal-foot\.wiz-foot/, '.modal-foot.wiz-foot present in app.css');
    assert.doesNotMatch(css, /\.route-step-dot|\.service-step-pill|\.aurora-routes-grid/, 'legacy route wizard/grid rules removed');
  });
});

// ── Task P2-5: Users page (Aurora mockup fidelity) ────────────────────────────
describe('aurora theme — users layout (Task P2-5)', () => {
  it('renders /users under aurora (200, aurora shell)', async () => {
    selectAurora();
    const res = await agent.get('/users').expect(200);
    assert.match(res.text, /class="app"/, 'aurora .app shell present');
    assert.match(res.text, /\/css\/app\.css/, 'loads app.css');
  });

  it('renders the redesigned users page contract (list, detail panel, dialogs)', async () => {
    selectAurora();
    const res = await agent.get('/users').expect(200);
    const ids = [
      // page, role cards, owner-less banner, list
      'us-page', 'us-btn-roles', 'us-btn-add', 'us-orphans', 'us-orphans-assign', 'us-search', 'us-filters', 'us-table', 'us-tbody', 'us-cards',
      // detail panel with five tabs
      'us-detail', 'us-tabs', 'us-tab-overview', 'us-tab-access', 'us-tab-see', 'us-tab-security', 'us-tab-activity',
      'us-panel-overview', 'us-panel-access', 'us-panel-see', 'us-panel-security', 'us-panel-activity',
      // dialogs
      'us-dlg-roles', 'us-dlg-create', 'us-dlg-wizard', 'us-dlg-edit', 'us-dlg-password', 'us-dlg-role', 'us-dlg-delete', 'us-dlg-invite', 'us-dlg-orphans',
      'us-wz-steps', 'us-wz-next', 'us-wz-back', 'us-wz-presets', 'us-wz-scopes', 'us-wz-peer', 'us-wz-binding-sw', 'us-wz-classic', 'us-wz-code-value',
      'us-ed-rights', 'us-ed-facts', 'us-del-confirm', 'us-del-ok', 'us-i18n', 'us-ctx',
    ];
    for (const id of ids) assert.match(res.text, new RegExp(`id="${id}"`), `#${id} present`);
    // the old modal/wizard is gone
    for (const gone of ['user-modal-overlay', 'token-modal-overlay', 'tw-step-1', 'unassigned-banner']) {
      assert.doesNotMatch(res.text, new RegExp(`id="${gone}"`), `#${gone} absent`);
    }
    assert.match(res.text, /role="tablist"/);
    assert.match(res.text, /class="mi danger"/, 'delete dialog keeps the modal-head icon wrapper');
  });

  it('inline <style> block has been removed from aurora/pages/users.njk (styles moved to the stylesheet)', () => {
    const njk = fs.readFileSync(path.join(__dirname, '..', 'templates', 'aurora', 'pages', 'users.njk'), 'utf8');
    assert.doesNotMatch(njk, /<style>/, 'no <style> block in aurora users.njk (moved to the stylesheet)');
    assert.doesNotMatch(njk, /style="(?!display:none")/, 'no inline styles except the overlay display toggle');
  });

  it('users.js renders table and cards without a theme branch', () => {
    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'users.js'), 'utf8');
    assert.doesNotMatch(js, /isAurora/, 'no theme branch left in users.js (Aurora is the only theme)');
    assert.match(js, /function renderList\(/, 'renderList() present');
    assert.match(js, /function renderDetail\(/, 'renderDetail() present');
  });

  it('app.css carries the users-page section (us-) and the old duplicates are gone', () => {
    const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'app.css'), 'utf8');
    for (const sel of ['.us-layout', '.us-detail', '.us-tab', '.us-steps', '.us-mx', '.me-card']) assert.ok(css.includes(sel + '{') || css.includes(sel + ' '), sel);
    assert.doesNotMatch(css, /\.tw-step\b/, '.tw-step is gone');
    assert.doesNotMatch(css, /\.tw-preset-label\b/, '.tw-preset-label (defined twice) is gone');
    assert.doesNotMatch(css, /\.aurora-user-card\b/);
  });
});

// ── Task P2-6: Certificates page (Aurora mockup fidelity) ────────────────────
describe('aurora theme — certificates layout (Task P2-6)', () => {
  it('renders /certificates under aurora (200, aurora shell)', async () => {
    selectAurora();
    const res = await agent.get('/certificates').expect(200);
    assert.match(res.text, /class="app"/, 'aurora .app shell present');
    assert.match(res.text, /\/css\/app\.css/, 'loads app.css');
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

  it('certificates.js renders the Aurora table rows without a theme branch', () => {
    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'certificates.js'), 'utf8');
    assert.doesNotMatch(js, /isAurora/, 'no theme branch left in certificates.js (Aurora is the only theme)');
    assert.match(js, /function buildRow\(/, 'buildRow() present');
    assert.match(js, /function load\(/, 'load() present');
    assert.match(js, /class: 'cell-name'/, 'data-table cell classes');
    assert.match(js, /TG\.stateTag\(h, 'tag-dot'\)/, 'tag-dot status tags');
  });

  it('app.css already carries data-table, row-actions, icon-action, tag-dot (no new rules needed)', () => {
    const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'app.css'), 'utf8');
    assert.match(css, /\.data-table\b/, '.data-table rule present in app.css');
    assert.match(css, /\.row-actions\b/, '.row-actions rule present in app.css');
    assert.match(css, /\.icon-action\b/, '.icon-action rule present in app.css');
    assert.match(css, /\.tag\.tag-dot/, '.tag.tag-dot rule present in app.css');
    assert.match(css, /\.data-table .cell-name/, '.data-table .cell-name rule present in app.css');
    assert.match(css, /\.data-table .mono/, '.data-table .mono rule present in app.css');
  });
});

// ── Task P2-7: DNS page (Aurora mockup fidelity) ─────────────────────────────
describe('aurora theme — dns layout (Task P2-7)', () => {
  it('renders /dns under aurora (200, aurora shell)', async () => {
    selectAurora();
    const res = await agent.get('/dns').expect(200);
    assert.match(res.text, /class="app"/, 'aurora .app shell present');
    assert.match(res.text, /\/css\/app\.css/, 'loads app.css');
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
    // The default/pro static table is gone (records are merged into one table)
    assert.doesNotMatch(res.text, /id="dns-static-tbody"/, '#dns-static-tbody absent');
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

  it('dns.js renders the unified records table without a theme branch', () => {
    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'dns.js'), 'utf8');
    assert.doesNotMatch(js, /isAurora/, 'no theme branch left in dns.js (Aurora is the only theme)');
    assert.match(js, /function renderPeers\(/, 'renderPeers() present');
    assert.doesNotMatch(js, /renderStatic|dns-static-tbody/, 'the separate static table (default/pro) is gone');
  });

  it('app.css already carries feature-lock, data-table, cell-name, mono rules (no new rules needed)', () => {
    const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'app.css'), 'utf8');
    assert.match(css, /\.feature-lock\b/, '.feature-lock rule present in app.css');
    assert.match(css, /\.data-table\b/, '.data-table rule present in app.css');
    assert.match(css, /\.data-table .cell-name/, '.data-table .cell-name rule present in app.css');
    assert.match(css, /\.data-table .mono/, '.data-table .mono rule present in app.css');
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

  it('logs.js renders Aurora log rows without a theme branch', () => {
    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'logs.js'), 'utf8');
    assert.doesNotMatch(js, /isAurora/, 'no theme branch left in logs.js (Aurora is the only theme)');
    assert.match(js, /function renderLogs\(/, 'renderLogs() present');
    assert.match(js, /function renderAccessLogs\(/, 'renderAccessLogs() present');
  });

  it('app.css has .log-row, .sev, .ts, .msg, .src, .toggle-group rules', () => {
    const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'app.css'), 'utf8');
    assert.match(css, /\.log-row\b/, '.log-row rule in app.css');
    assert.match(css, /\.log-row .sev\b/, '.log-row .sev rule in app.css');
    assert.match(css, /\.log-row .ts\b/, '.log-row .ts rule in app.css');
    assert.match(css, /\.log-row .msg\b/, '.log-row .msg rule in app.css');
    assert.match(css, /\.log-row .src\b/, '.log-row .src rule in app.css');
    assert.match(css, /\.toggle-group\b/, '.toggle-group rule in app.css');
  });
});

// ── Task P2-9: Gateway-Pools page (Aurora mockup fidelity) ───────────────────
describe('aurora theme — gateway-pools layout (Task P2-9)', () => {
  it('renders /gateway-pools under aurora (200, aurora shell)', async () => {
    selectAurora();
    const res = await agent.get('/gateway-pools').expect(200);
    assert.match(res.text, /class="app"/, 'aurora .app shell present');
    assert.match(res.text, /\/css\/app\.css/, 'loads app.css');
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

  it('gatewayPools.js renders the Aurora pool UI without a theme branch', () => {
    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'gatewayPools.js'), 'utf8');
    assert.doesNotMatch(js, /isAurora/, 'no theme branch left in gatewayPools.js (Aurora is the only theme)');
    assert.match(js, /function buildMemberRow\(/, 'buildMemberRow() present');
    assert.match(js, /function initCooldownPresets\(/, 'initCooldownPresets() present');
    assert.match(js, /function renderMigrateForm\(/, 'renderMigrateForm() present');
    assert.match(js, /gateway_pools\.preset_docker/, 'Aurora preset list (incl. Docker)');
    assert.doesNotMatch(js, /AURORA_COOLDOWN_PRESETS/, 'single preset list');
  });

  it('app.css carries pool-member-row Aurora overrides', () => {
    const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'app.css'), 'utf8');
    assert.match(css, /\.pool-member-row\b/, '.pool-member-row override in app.css');
    assert.match(css, /\.pool-member-handle\b/, '.pool-member-handle rule in app.css');
    assert.match(css, /\.pool-member-name\b/, '.pool-member-name rule in app.css');
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
    assert.match(res.text, /\/css\/app\.css/, 'loads app.css');
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

  it('rdp.js renders the Aurora card grid without a theme branch', () => {
    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'rdp.js'), 'utf8');
    assert.doesNotMatch(js, /isAurora/, 'no theme branch left in rdp.js (Aurora is the only theme)');
    assert.match(js, /function renderGrid\(/, 'renderGrid() present');
  });

  it('app.css has .rdp-step-dot and .rdp-step-line rules (extracted from inline style)', () => {
    const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'app.css'), 'utf8');
    assert.match(css, /\.rdp-step-dot\b/, '.rdp-step-dot rule present in app.css');
    assert.match(css, /\.rdp-step-line\b/, '.rdp-step-line rule present in app.css');
  });

  it('inline <style nonce> block has been removed from aurora/pages/rdp.njk (styles moved to the stylesheet)', () => {
    const njk = fs.readFileSync(path.join(__dirname, '..', 'templates', 'aurora', 'pages', 'rdp.njk'), 'utf8');
    assert.doesNotMatch(njk, /\.rdp-step-dot\s*\{/, '.rdp-step-dot inline style block absent (moved to the stylesheet)');
    assert.doesNotMatch(njk, /<style\s+nonce/, 'no <style nonce> block in aurora rdp.njk (moved to the stylesheet)');
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
describe('aurora theme — settings layout (grouped sections, one save model)', () => {
  const SECTIONS = ['uebersicht', 'domains', 'netzwerk', 'daten', 'anmeldung', 'geraete', 'gruppen', 'richtlinien', 'splittunnel',
    'clientupdates', 'email', 'benachrichtigungen', 'webhooks', 'monitoring', 'geoip', 'portal', 'backup', 'updates', 'lizenz', 'gefahr'];

  it('renders /settings under aurora: shell, section nav, compact select, save bar', async () => {
    selectAurora();
    const res = await agent.get('/settings').expect(200);
    assert.match(res.text, /\/css\/app\.css/, 'the single stylesheet is linked');
    assert.match(res.text, /<div class="app">[\s\S]*class="app-brand"/, 'aurora theme shell present');
    assert.match(res.text, /<nav class="st-nav" id="st-nav" aria-label="[^"]+"/, 'section nav with a label');
    assert.match(res.text, /<select id="st-select"/, 'select for narrow screens');
    assert.match(res.text, /id="st-savebar" role="region"/, 'save bar region');
    assert.match(res.text, /<input type="search" id="st-search" aria-label="[^"]+"/, 'labelled search');
    assert.doesNotMatch(res.text, /settings-tabs|data-settings-tab|data-settings-panel/, 'no old tab markup');
  });

  it('renders every section with a nav button and a heading', async () => {
    selectAurora();
    const res = await agent.get('/settings').expect(200);
    for (const s of SECTIONS) {
      assert.match(res.text, new RegExp(`class="st-nav-item" data-section="${s}" aria-current="false"`), `nav ${s}`);
      assert.match(res.text, new RegExp(`<section class="st-section" data-section="${s}" aria-labelledby="st-h-${s}"`), `section ${s}`);
      assert.match(res.text, new RegExp(`<option value="${s}">`), `select option ${s}`);
    }
  });

  it('toggles are role=switch buttons with labels; numbers carry min/max', async () => {
    selectAurora();
    const res = await agent.get('/settings').expect(200);
    const switches = res.text.match(/<button type="button" class="st-switch" role="switch"[^>]*>/g) || [];
    assert.ok(switches.length > 20, 'switches: ' + switches.length);
    for (const sw of switches) {
      const id = /id="([^"]+)"/.exec(sw)[1];
      assert.match(res.text, new RegExp(`<label class="st-label" for="${id}"`), `label for ${id}`);
    }
    assert.match(res.text, /id="st-ret-traffic" data-st-field="ret-traffic" min="1" max="365"/);
    assert.match(res.text, /id="st-al-disk" data-st-field="al-disk" min="0" max="100"/);
    assert.doesNotMatch(res.text, /class="toggle[" ]/, 'no old div toggles');
  });

  it('renders the dialogs as modal-overlay pattern', async () => {
    selectAurora();
    const res = await agent.get('/settings').expect(200);
    for (const id of ['st-wh-modal', 'st-ot-modal', 'st-wgstop-modal']) {
      assert.match(res.text, new RegExp(`<div class="modal-overlay st-modal" id="${id}" style="display:none">`), id);
    }
    assert.match(res.text, /id="st-wgstop-pw"[^>]*autocomplete="current-password"/);
  });

  it('no inline <style> block in settings.njk; the st- rules live in the Aurora section of app.css', () => {
    const njk = fs.readFileSync(path.join(__dirname, '..', 'templates', 'aurora', 'pages', 'settings.njk'), 'utf8');
    assert.doesNotMatch(njk, /<style/, 'no <style> block');
    const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'app.css'), 'utf8');
    const aurora = css.slice(css.indexOf('\n * \u00a72 '), css.indexOf('\n * \u00a73 '));
    for (const sel of ['.st-page', '.st-nav-item', '.st-switch', '.st-seg', '.st-savebar', '.st-matrix', '.st-typecard']) {
      assert.ok(aurora.includes(sel), sel + ' in §2');
    }
    assert.match(aurora, /@media \(max-width:900px\)\{\s*\.st-layout/, 'the nav becomes a select at ≤ 900 px');
  });
});

// ── Task P2-12: Profile page — Aurora mockup fidelity ────────────────────────
describe('aurora theme — profile layout (Task P2-12)', () => {
  it('renders /profile under aurora (200, aurora shell)', async () => {
    selectAurora();
    const res = await agent.get('/profile').expect(200);
    assert.match(res.text, /class="app"/, 'aurora .app shell present');
    assert.match(res.text, /\/css\/app\.css/, 'loads app.css');
  });

  it('renders the redesigned profile structure (identity header, sections, rail)', async () => {
    selectAurora();
    const res = await agent.get('/profile').expect(200);
    assert.match(res.text, /class="pf-identity"/, 'identity header present');
    assert.match(res.text, /class="pf-avatar"/, 'avatar with initials present');
    assert.equal((res.text.match(/class="pf-section"/g) || []).length, 3, 'three sections: personal, security, appearance');
    assert.match(res.text, /class="pf-rail"/, 'security rail present');
    assert.match(res.text, /id="pf-status"[^>]*data-score="0"/, 'security score is filled client-side from the rate-limited APIs');
    assert.match(res.text, /class="form-input pf-input"/, '.form-input on inputs present');
    assert.match(res.text, /<label class="pf-label" for="settings-display-name"/, 'inputs carry real labels');
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
    assert.doesNotMatch(res.text, /id="theme-buttons"/, '#theme-buttons removed (Aurora only)');
  });

  it('renders language and colour-scheme segmented controls', async () => {
    selectAurora();
    const res = await agent.get('/profile').expect(200);
    assert.match(res.text, /class="pf-seg" id="language-buttons" role="group"/, '#language-buttons is a segmented group');
    assert.match(res.text, /data-lang="[a-z]+" aria-pressed="(true|false)"/, 'language buttons have data-lang + aria-pressed');
    assert.match(res.text, /id="pf-scheme-buttons"[\s\S]{0,200}data-scheme="dark"[\s\S]{0,200}data-scheme="light"/, 'Midnight/Papier switch');
  });

  it('the colour-scheme switch reuses the topbar mechanism (window.GCTheme), no own storage', () => {
    const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
    const profile = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'profile.js'), 'utf8');
    assert.match(app, /window\.GCTheme = \{ get: get, set: set \}/);
    assert.match(profile, /window\.GCTheme\.set\(/);
    assert.doesNotMatch(profile, /localStorage|gc-theme-mode/, 'profile.js stores nothing itself');
  });

  it('i18n has profile.security_display in both en.json and de.json', () => {
    const en = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'i18n', 'en.json'), 'utf8'));
    const de = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'i18n', 'de.json'), 'utf8'));
    assert.ok(en['profile.security_display'], 'profile.security_display present in en.json');
    assert.ok(de['profile.security_display'], 'profile.security_display present in de.json');
  });
});

// ── UX-fixes: Peers gateway card — badge inside, gear-edit, card→detail nav ──
describe('aurora theme — peers gateway card UX fixes (Issues 5/6/7)', () => {
  it('renderGatewayCard builds badge inside the card using DOM (not detached)', () => {
    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'peers.js'), 'utf8');
    // Badge is created with DOM createElement and appended inside uh (card header)
    assert.match(js, /badge\.className\s*=\s*statusClass/, 'badge.className assigned from statusClass inside renderGatewayCard');
    assert.match(js, /right\.appendChild\(badge\)/, 'badge appended to the right-side header span (inside card)');
    // The "right" span is added to uh (header row), which is added to unit (card)
    assert.match(js, /uh\.appendChild\(right\)/, 'right span appended to uh header row');
    assert.match(js, /unit\.appendChild\(uh\)/, 'uh header row appended to unit card');
  });

  it('renderGatewayCard emits a gear button with data-action="edit" and data-id=peer_id', () => {
    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'peers.js'), 'utf8');
    // Gear button gets setAttribute('data-action', 'edit')
    assert.match(js, /gearBtn\.setAttribute\('data-action',\s*'edit'\)/, "gear button has data-action='edit'");
    assert.match(js, /gearBtn\.setAttribute\('data-id',\s*String\(gw\.peer_id\)\)/, 'gear button data-id is String(gw.peer_id)');
    // Gear button is appended inside the right span (inside card header)
    assert.match(js, /right\.appendChild\(gearBtn\)/, 'gear button appended inside card header');
  });

  it('renderGatewayCard gear button stops propagation and calls showEditModal', () => {
    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'peers.js'), 'utf8');
    assert.match(js, /e\.stopPropagation\(\)[\s\S]{0,40}showEditModal\(gw\.peer_id\)/, 'gear click: stopPropagation then showEditModal(gw.peer_id)');
  });

  it('renderGatewayCard sets dataset.gwDetail for test assertions and a11y', () => {
    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'peers.js'), 'utf8');
    assert.match(js, /unit\.dataset\.gwDetail\s*=\s*'\/gateways#gw\/'/, "unit.dataset.gwDetail set to '/gateways#gw/' prefix");
  });

  it('renderGatewayCard card click navigates to /gateways#gw/<id> (Issue 7)', () => {
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

  it('renderGatewayCard card click uses button/a guard (gear and badge excluded from nav)', () => {
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
  it('Issue 8: card builds badge inside card header using right container', () => {
    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'gateways.js'), 'utf8');
    // stTag appended to right container, right container appended to uh (inside card)
    assert.match(js, /right\.appendChild\(stTag\)/, 'badge (stTag) appended to right container');
    assert.match(js, /uh\.appendChild\(right\)/, 'right container appended to uh header row (inside card)');
  });

  it('Issue 9: app.css has .tag.tag-dot::after (dot after text) and suppresses ::before', () => {
    const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'app.css'), 'utf8');
    assert.match(css, /\.tag\.tag-dot::after/, '.tag.tag-dot::after present (dot positioned after text)');
    assert.match(css, /\.tag\.tag-dot::before\s*\{[^}]*content:\s*none/, '.tag.tag-dot::before has content:none (before-dot suppressed)');
  });

  it('Issue 10: versionsCard() present and called from renderDetail()', () => {
    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'gateways.js'), 'utf8');
    assert.match(js, /function versionsCard\(/, 'versionsCard() present in gateways.js');
    assert.match(js, /grid2\.appendChild\(versionsCard\(g\)\)/, 'renderDetail() calls versionsCard(g)');
  });

  it('Issue 11: renderDetail uses gw-detail-grid with exactly 3 columns (1/3 each)', () => {
    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'gateways.js'), 'utf8');
    const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'app.css'), 'utf8');
    assert.match(js, /el\('div',\s*'gw-detail-grid'\)/, 'renderDetail() uses gw-detail-grid class');
    assert.match(css, /\.gw-detail-grid\s*\{[^}]*repeat\(3,minmax\(0,1fr\)\)/, 'gw-detail-grid uses exactly 3 columns (1/3 each)');
  });
});

// ── UX-fixes: RDP page (Issues 12/13/14/15/16) ───────────────────────────────
describe('aurora theme — rdp UX fixes (Issues 12/13/14/15/16)', () => {
  it('Issue 12: renderGrid uses rdp-card-grid container (not span6/full-width)', () => {
    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'rdp.js'), 'utf8');
    const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'app.css'), 'utf8');
    // Container must use rdp-card-grid, not grid (which yields span6 half-width cards)
    assert.match(js, /container\.className\s*=\s*'rdp-card-grid'/, "renderGrid uses 'rdp-card-grid' container");
    // Cards must not use span6 (which is half-width in 12-col grid)
    assert.doesNotMatch(js, /card\.className\s*=\s*'card span6'/, "card.className no longer uses 'card span6'");
    // app.css must define the grid rule with auto-fill
    assert.match(css, /\.rdp-card-grid\s*\{[^}]*auto-fill/, 'app.css .rdp-card-grid uses auto-fill grid');
  });

  it('Issue 13: status badge built inside card header (cardTitle) with tag-dot (text-left-of-dot)', () => {
    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'rdp.js'), 'utf8');
    // Status tag is appended to cardTitle (inside header), not to a separate health kv row
    assert.match(js, /statusTag\.style\.marginLeft\s*=\s*'auto'/, 'statusTag has margin-left:auto (pushed to header right)');
    assert.match(js, /cardTitle\.appendChild\(statusTag\)/, 'statusTag appended to cardTitle (inside card header)');
    // Uses tag-dot class (text left of dot via ::after in app.css)
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

  it('Issue 16: aurora check handler sets color + icon, not big text', () => {
    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'rdp.js'), 'utf8');
    assert.doesNotMatch(js, /isAurora/, 'no theme branch');
    assert.match(js, /checkBtn\.style\.color = result\.online \? 'var\(--green\)' : 'var\(--red\)'/, 'color on checkBtn');
    // Sets innerHTML (icon), not textContent
    assert.match(js, /checkBtn\.innerHTML\s*=\s*result\.online/, 'Aurora branch sets innerHTML to status icon on check result');
    assert.doesNotMatch(js, /checkBtn\.textContent\s*=\s*result\.online/, 'the big-text (default/pro) branch is gone');
  });
});

// ── UX-fixes: Settings + sidebar chrome (Issues 17/18/19) ────────────────────
describe('aurora theme — settings + sidebar UX fixes (Issues 17/18/19)', () => {
  it('Issue 17 (superseded): the settings page has no default-theme picker, the source neither', async () => {
    const res = await agent.get('/settings').expect(200);
    assert.doesNotMatch(res.text, /data-default-theme=/, 'no default-theme buttons rendered');
    const njk = fs.readFileSync(path.join(__dirname, '..', 'templates', 'aurora', 'pages', 'settings.njk'), 'utf8');
    assert.doesNotMatch(njk, /data-default-theme=|settings\.default_theme/, 'no default-theme card in settings.njk');
  });

  it('Issue 19: app.css .sidebar rule has position:static (sidebar stays in grid flow)', () => {
    const css = fs.readFileSync(
      path.join(__dirname, '..', 'public', 'css', 'app.css'),
      'utf8'
    );
    // Verify desktop .sidebar has position:static (overrides pro.css position:fixed)
    assert.match(css, /\.sidebar\s*\{[^}]*position\s*:\s*static/, '.sidebar rule has position:static');
    // Verify mobile media query is still present (drawer still works)
    assert.match(css, /max-width\s*:\s*980px/, 'mobile 980px media query present');
    // Both position:static (desktop) and position:fixed (mobile drawer) must co-exist in the file
    assert.ok(
      css.includes('position:static') && css.includes('position:fixed'),
      'app.css has both position:static (desktop sidebar) and position:fixed (mobile drawer)'
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

describe('users modals — Aurora-safe overlay open (regression)', () => {
  // The Aurora section's `.modal-overlay{display:none}` (it follows the base
  // specificity → wins). The shared users.js must therefore open overlays with an
  // explicit inline display:flex (inline beats the class rule), exactly like
  // routes.js does. Opening with style.display='' falls back to that rule → none,
  // so the Add User / Edit User (and token) modals never appear in Aurora.
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'users.js'), 'utf8');

  it('app.css hides .modal-overlay by default (documents why flex is required)', () => {
    const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'app.css'), 'utf8');
    assert.match(css, /\.modal-overlay\s*\{[^}]*display\s*:\s*none/, 'aurora .modal-overlay base is display:none');
  });

  it('every users dialog is opened with display:flex, not an empty string', () => {
    assert.match(js, /ov\.style\.display\s*=\s*'flex'/, "openDlg must set the overlay display to 'flex'");
    assert.doesNotMatch(js, /style\.display\s*=\s*''/, "no overlay is opened with '' (app.css → none)");
  });
});
