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
// dns is feature-gated (not unlocked in setup) → verified manually.
const PAGES = [
  '/dashboard', '/peers', '/routes', '/gateways',
  '/rdp', '/certificates', '/users', '/groups', '/directory', '/logs', '/settings', '/profile',
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

    it(`${url}: the title is shown once — the topbar's h1, no in-page title block`, async () => {
      selectAurora();
      const res = await agent.get(url).expect(200);
      assert.deepEqual(res.text.match(/<h1\b[^>]*>/g), ['<h1 class="page-crumb">'], 'exactly one h1: the topbar title');
      assert.doesNotMatch(res.text, /class="page-(title|sub)"|class="st-title"|class="pg-ph-title"/, 'no title / subtitle on the page');
      // (an eyebrow may still label a dialog, e.g. "Rollen vergleichen" on /users)
      assert.doesNotMatch(res.text, /class="page-header[^"]*">\s*<div[^>]*>\s*<div class="page-eyebrow"/, 'no eyebrow in the page header');
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
  it('app.css has overrides for btn-primary:hover, btn-danger:hover, the pool mode buttons, and non-circular --blue-bd', () => {
    const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'app.css'), 'utf8');
    assert.match(css, /\.btn-primary:hover\s*\{[^}]*box-shadow/, 'btn-primary:hover has a box-shadow override in app.css');
    assert.match(css, /\.btn-danger:hover/, 'btn-danger:hover has an Aurora override in app.css');
    assert.match(css, /\.gwp-seg-b\[aria-pressed="true"\]\{[^}]*var\(--teal\)/, 'the pool mode buttons use the Aurora teal token');
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
    assert.match(js, /function deviceCard\(/, 'deviceCard() present');
  });
});

// ── Dashboard redesign (2026-10): ID contract of dashboard.njk / dashboard.js ──
describe('aurora theme — dashboard layout (redesign)', () => {
  it('renders /dashboard with the db- structure: header, five tiles, cards', async () => {
    selectAurora();
    const res = await agent.get('/dashboard').expect(200);
    assert.match(res.text, /class="app"/, 'aurora .app shell present');
    assert.match(res.text, /class="db-page"/, '.db-page present');
    assert.match(res.text, /<h2 class="db-title" id="db-headline">/, 'status headline is an h2 (the h1 is the topbar title)');
    assert.deepEqual(res.text.match(/<h1\b[^>]*>/g), ['<h1 class="page-crumb">'], 'exactly one h1: the topbar title');
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

// ── Task P2-3: Peers ID-contract (Aurora mockup fidelity) ────────────────────
describe('aurora theme — peers layout (docs/feature-peers-page.md)', () => {
  it('renders /peers under aurora (200, aurora shell)', async () => {
    selectAurora();
    const res = await agent.get('/peers').expect(200);
    assert.match(res.text, /class="app"/, 'aurora .app shell present');
    assert.match(res.text, /\/css\/app\.css/, 'loads app.css');
  });

  it('toolbar: search, status, view switch, group/device/sort, "Weitere Filter"; no gateway card', async () => {
    selectAurora();
    const res = await agent.get('/peers').expect(200);
    for (const id of ['peer-search', 'pl-status', 'pl-view', 'pl-group', 'pl-device', 'pl-sort', 'pl-more-btn', 'pl-more', 'pl-active', 'pl-attn', 'pl-results', 'pl-summary', 'pl-groups-link']) {
      assert.match(res.text, new RegExp(`id="${id}"`), `#${id} present`);
    }
    for (const s of ['all', 'online', 'offline', 'disabled']) assert.match(res.text, new RegExp(`data-status="${s}"`), `status ${s}`);
    assert.match(res.text, /data-view="cards" aria-pressed="true"/, 'cards by default');
    assert.match(res.text, /data-view="list"/, 'list view');
    assert.match(res.text, /class="toolbar rt-toolbar pl-toolbar"/, 'zones-style toolbar');
    assert.doesNotMatch(res.text, /id="gateways-container"|gw-section-count|stat-gw-online/, 'no gateway section any more');
    assert.match(res.text, /<script type="application\/json" id="pl-i18n" data-prefixes="pl\. peer_groups\. common\. vn\."/, 'strings island');
  });

  it('bulk bar: enable, disable, group, owner, tag, delete, clear', async () => {
    selectAurora();
    const res = await agent.get('/peers').expect(200);
    assert.match(res.text, /class="sh-bulkbar pl-bulk" id="pl-bulkbar"[^>]* hidden/, 'hidden until something is selected');
    for (const a of ['enable', 'disable', 'group', 'owner', 'tag', 'delete', 'clear']) assert.match(res.text, new RegExp(`data-bulk="${a}"`), a);
  });

  it('the device modals; no gateway modals', async () => {
    selectAurora();
    const res = await agent.get('/peers').expect(200);
    for (const id of ['modal-add-peer', 'modal-edit-peer', 'modal-qr-peer', 'modal-peer-traffic', 'modal-confirm', 'add-peer-name', 'btn-add-peer-submit',
      'add-peer-error', 'edit-peer-id', 'edit-peer-name', 'edit-peer-error', 'access-windows-section', 'qr-peer-title', 'traffic-peer-title']) {
      assert.match(res.text, new RegExp(`id="${id}"`), `#${id} present`);
    }
    assert.doesNotMatch(res.text, /id="modal-gateway-tokens"|id="modal-gateway-delete"|id="add-peer-gateway-moved"|id="edit-peer-gateway-info"/);
  });

  it('peers.js: clients only, DOM built without innerHTML, view remembered', () => {
    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'peers.js'), 'utf8');
    const code = js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
    assert.match(js, /api\.get\('\/api\/peers\?type=client'\)/, 'loads clients only');
    assert.match(js, /var VIEW_KEY = 'gc-peers-view';/, 'view key');
    assert.doesNotMatch(code, /innerHTML|outerHTML|insertAdjacentHTML/, 'no HTML strings');
    assert.doesNotMatch(js, /renderGatewayCard|loadGateways|\/api\/gateways/, 'no gateway code left');
    assert.doesNotMatch(js, /isAurora/, 'no theme branch');
  });

  it('app.css carries the peers-page section (pl-)', () => {
    const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'app.css'), 'utf8');
    assert.match(css, /§14 Peers \/ Clients \(pl-\)/, 'section header');
    for (const sel of ['.pl-card', '.pl-table', '.pl-pop', '.pl-fbtn', '.pl-att', '.tag.tag-dot']) assert.ok(css.includes(sel), sel);
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
    assert.doesNotMatch(res.text, /class="page-(eyebrow|title|sub)"/, 'no in-page title block — the title is the topbar\'s');
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

  // The dialogs (partials/users-dialogs.njk) are on the list and on the profile.
  const DIALOG_IDS = [
    'us-dlg-roles', 'us-dlg-create', 'us-dlg-wizard', 'us-dlg-edit', 'us-dlg-profile', 'us-dlg-password', 'us-dlg-role', 'us-dlg-delete', 'us-dlg-invite', 'us-dlg-orphans',
    'us-wz-steps', 'us-wz-next', 'us-wz-back', 'us-wz-presets', 'us-wz-scopes', 'us-wz-peer', 'us-wz-binding-sw', 'us-wz-classic', 'us-wz-code-value',
    'us-ed-rights', 'us-ed-facts', 'us-del-confirm', 'us-del-ok', 'us-i18n', 'us-ctx',
  ];

  it('renders the redesigned users page contract (list, dialogs; no side panel)', async () => {
    selectAurora();
    const res = await agent.get('/users').expect(200);
    const ids = [
      // page, role cards, owner-less banner, list
      'us-page', 'us-btn-roles', 'us-btn-add', 'us-orphans', 'us-orphans-assign', 'us-search', 'us-filters', 'us-table', 'us-tbody', 'us-cards',
    ].concat(DIALOG_IDS);
    for (const id of ids) assert.match(res.text, new RegExp(`id="${id}"`), `#${id} present`);
    // the old modal/wizard and the side panel are gone (editing lives on /users/:id)
    for (const gone of ['user-modal-overlay', 'token-modal-overlay', 'tw-step-1', 'unassigned-banner', 'us-detail', 'us-tabs', 'us-panel-overview']) {
      assert.doesNotMatch(res.text, new RegExp(`id="${gone}"`), `#${gone} absent`);
    }
    assert.match(res.text, /class="mi danger"/, 'delete dialog keeps the modal-head icon wrapper');
  });

  it('renders the user profile contract (header actions, five tabs, dialogs)', async () => {
    selectAurora();
    const { getDb } = require('../src/db/connection');
    const id = getDb().prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get().id;
    const res = await agent.get(`/users/${id}?tab=security`).expect(200);
    const ids = [
      'up-page', 'up-name', 'up-head-chips', 'up-edit', 'up-add-device', 'up-toggle', 'up-more', 'up-menu',
      'up-act-password', 'up-act-role', 'up-act-invite', 'up-act-delete',
      'us-tabs', 'us-tab-overview', 'us-tab-access', 'us-tab-see', 'us-tab-security', 'us-tab-activity',
      'us-panel-overview', 'us-panel-access', 'us-panel-see', 'us-panel-security', 'us-panel-activity',
    ].concat(DIALOG_IDS);
    for (const i of ids) assert.match(res.text, new RegExp(`id="${i}"`), `#${i} present`);
    assert.match(res.text, /role="tablist"/);
    // ?tab= picks the tab server-side; the others stay hidden
    assert.match(res.text, /id="us-tab-security"[^>]*aria-selected="true"/);
    assert.match(res.text, /id="us-tab-overview"[^>]*aria-selected="false"/);
    assert.match(res.text, /id="us-panel-overview"[^>]*hidden/);
    assert.doesNotMatch(res.text, /id="us-panel-security"[^>]*hidden/);
    assert.match(res.text, /\/js\/users\.js/);
    assert.doesNotMatch(res.text, /\/js\/user-(profile|device)\.js/);
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
    for (const sel of ['.us-layout', '.us-tab', '.us-steps', '.us-mx', '.us-usage-mode', '.up-menu', '.up-panel-card']) assert.ok(css.includes(sel + '{') || css.includes(sel + ' '), sel);
    assert.doesNotMatch(css, /\.us-detail\b/, 'the side panel styles are gone');
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

  it('renders page-header with page-actions (no in-page title) on /certificates', async () => {
    selectAurora();
    const res = await agent.get('/certificates').expect(200);
    assert.match(res.text, /class="page-header"/, '.page-header present');
    assert.doesNotMatch(res.text, /class="page-(eyebrow|title|sub)"/, 'no in-page title block — the title is the topbar\'s');
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

// ── The page "Interner DNS" is gone (the name stands with the device, the
// zone and the state of the names live in Einstellungen › VPN & Netzwerk) ────
describe('aurora theme — the former dns page', () => {
  it('/dns leads to the settings', async () => {
    selectAurora();
    const res = await agent.get('/dns').expect(302);
    assert.equal(res.headers.location, '/settings/netzwerk#card-vpn-names');
  });

  it('its template and script are gone', () => {
    assert.equal(fs.existsSync(path.join(__dirname, '..', 'templates', 'aurora', 'pages', 'dns.njk')), false);
    assert.equal(fs.existsSync(path.join(__dirname, '..', 'public', 'js', 'dns.js')), false);
  });

  it('app.css still carries feature-lock, data-table, cell-name, mono rules', () => {
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

  // The page was redesigned (Logs & Monitoring, FEATURES.md): the old
  // activity/access/history panels became tabs of public/js/logs.js; the
  // RDP history keeps its own ids (rdp-history.js). Details: logs_hub.test.js.
  it('/logs Aurora renders the Logs & Monitoring shell', async () => {
    selectAurora();
    const res = await agent.get('/logs').expect(200);
    for (const id of ['lg-page', 'lg-tabs', 'lg-kpis', 'lg-hist', 'lg-filters', 'lg-rows', 'lg-panel-problems', 'lg-panel-access',
      'lg-panel-sessions', 'lg-panel-saved', 'lg-export-open']) {
      assert.ok(res.text.includes(`id="${id}"`), `#${id} present`);
    }
    assert.match(res.text, /class="tabs lg-tabs" role="tablist"/, 'tabs as a tablist');
  });

  it('/logs Aurora keeps the RDP history contract ids', async () => {
    selectAurora();
    const res = await agent.get('/logs').expect(200);
    for (const id of ['rdp-history-list', 'rdp-history-period', 'rdp-history-status', 'rdp-history-export-csv', 'rdp-history-export-json']) {
      assert.ok(res.text.includes(`id="${id}"`), `#${id} present`);
    }
  });

  it('logs.js has no theme branch and builds the DOM without innerHTML', () => {
    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'logs.js'), 'utf8');
    assert.doesNotMatch(js, /isAurora/, 'no theme branch left in logs.js (Aurora is the only theme)');
    assert.match(js, /function rowNode\(/, 'rowNode() present');
    assert.match(js, /function loadAccess\(/, 'loadAccess() present');
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

// ── Gateway pools: no page of their own any more, they live on /gateways ─────
describe('aurora theme — gateway pools on the gateways page', () => {
  it('/gateway-pools leads to /gateways (old links keep working)', async () => {
    selectAurora();
    const res = await agent.get('/gateway-pools').expect(302);
    assert.equal(res.headers.location, '/gateways');
  });

  it('/gateways carries the pool view, "Pool anlegen" and the licence flags', async () => {
    selectAurora();
    const res = await agent.get('/gateways').expect(200);
    assert.match(res.text, /id="gw-pool-view" hidden/, '#gw-pool-view present');
    assert.match(res.text, /id="btn-add-pool"/, '#btn-add-pool present');
    assert.match(res.text, /id="fleet-view" data-pools="(on|off)" data-pools-lb="(on|off)"/, 'licence flags on #fleet-view');
    assert.doesNotMatch(res.text, /href="\/gateway-pools"/, 'no link to the former page');
  });

  it('gateway-pools-ui.js renders the pool page and dialogs without a theme branch or innerHTML', () => {
    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'gateway-pools-ui.js'), 'utf8');
    assert.doesNotMatch(js, /isAurora/);
    for (const fn of ['renderPool', 'poolDialog', 'openMigrate', 'dissolveDialog', 'membersCard']) assert.match(js, new RegExp('function ' + fn + '\\('), fn);
    assert.doesNotMatch(js.replace(/^\s*\/\/.*$/gm, ''), /innerHTML|outerHTML|insertAdjacentHTML/);
  });

  it('app.css carries the pool group, member list and menu rules (Aurora tokens)', () => {
    const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'app.css'), 'utf8');
    for (const sel of ['.gwp-group{', '.gwp-mem{', '.gw-menu{', '.gwp-seg-b{', '.gwp-hint{', '.gwo-top{']) assert.ok(css.includes(sel), sel);
    assert.doesNotMatch(css, /\.pool-member-row|\.pool-mode-badge/, 'the former page\'s rules are gone');
  });

  it('i18n keeps common.pro and the gateway_pools.* strings of the migration dialog', () => {
    const en = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'i18n', 'en.json'), 'utf8'));
    const de = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'i18n', 'de.json'), 'utf8'));
    for (const l of [en, de]) {
      assert.equal(l['common.pro'], 'Pro');
      for (const k of ['gateway_pools.migrate_routes', 'gateway_pools.migrate_mode_relocate', 'gateway_pools.lb_policy_round_robin']) assert.ok(l[k], k);
    }
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
    assert.doesNotMatch(res.text, /class="page-(eyebrow|title|sub)"/, 'no in-page title block — the title is the topbar\'s');
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
    assert.match(res.text, /id="rdp-access-picker"/, '#rdp-access-picker present ("Wer darf zugreifen?")');
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

// ── Task P2-11: Settings page — one pattern after the plugin area ────────────
describe('aurora theme — settings layout (menu with addresses, one page pattern, one save model)', () => {
  const SECTIONS = ['domains', 'netzwerk', 'daten', 'anmeldung', 'geraete', 'gruppen', 'richtlinien', 'splittunnel',
    'clientupdates', 'email', 'benachrichtigungen', 'webhooks', 'monitoring', 'geoip', 'portal', 'ki', 'backup', 'updates', 'lizenz', 'gefahr'];

  it('renders /settings under aurora: shell, the menu like the plugin area, search in the menu, save bar', async () => {
    selectAurora();
    const res = await agent.get('/settings').expect(200);
    assert.match(res.text, /\/css\/app\.css/, 'the single stylesheet is linked');
    assert.match(res.text, /<div class="app">[\s\S]*class="app-brand"/, 'aurora theme shell present');
    assert.match(res.text, /<div class="pgx stx" id="st-page" data-section="start"/, 'the plugin area building blocks, the start page');
    assert.match(res.text, /<nav class="pgx-side stx-side" id="st-nav" aria-label="[^"]+">\s*<label class="stx-search">/, 'menu with the search on top');
    assert.match(res.text, /<input type="search" id="st-search" aria-label="[^"]+"/, 'labelled search');
    assert.match(res.text, /<a class="pgx-sl stx-sl stx-sl-start" href="\/settings" data-section="start" aria-current="page">/, '"Übersicht" is current');
    assert.doesNotMatch(res.text, /id="st-select"|class="st-nav-item"/, 'no select, no buttons as menu entries');
    assert.match(res.text, /id="st-savebar" role="region"/, 'save bar region');
    assert.doesNotMatch(res.text, /settings-tabs|data-settings-tab|data-settings-panel/, 'no old tab markup');
  });

  it('every section: a menu link with its own address and a page head with title and status line', async () => {
    selectAurora();
    const res = await agent.get('/settings').expect(200);
    for (const s of SECTIONS) {
      assert.match(res.text, new RegExp(`<a class="pgx-sl stx-sl" href="/settings/${s}" data-section="${s}"`), `menu ${s}`);
      assert.match(res.text, new RegExp(`<section class="st-section"\\s*data-section="${s}" aria-labelledby="st-h-${s}"`), `section ${s}`);
      assert.match(res.text, new RegExp(`<h2 class="pgx-h1" id="st-h-${s}" tabindex="-1">`), `title ${s}`);
      assert.match(res.text, new RegExp(`<p class="pgx-sub stx-status" id="st-status-${s}">`), `status line ${s}`);
    }
    assert.match(res.text, /<a class="pgx-sl stx-sl" href="\/settings\/plugins" data-section="plugins" data-ext="1"/, 'Plugins leads to the plugin area');
  });

  it('a card action sits in the card head, never in a foot; no dashed add buttons', async () => {
    selectAurora();
    const res = await agent.get('/settings').expect(200);
    assert.doesNotMatch(res.text, /st-card-foot|st-btn-dashed|class="st-card"/);
    assert.match(res.text, /<div class="stx-cha">\s*<button type="button" class="pgx-btn pgx-btn-sm" id="st-off-add"/, 'add target: card head');
    assert.match(res.text, /<div class="pgx-ph-a">\s*<button type="button" class="pgx-btn" id="st-smtp-test">/, 'test mail: page action');
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
    for (const id of ['st-wh-modal', 'st-ot-modal', 'st-wgstop-modal', 'ai-prov-modal', 'ai-log-modal']) {
      assert.match(res.text, new RegExp(`<div class="modal-overlay st-modal" id="${id}" style="display:none">`), id);
    }
    assert.match(res.text, /id="st-wgstop-pw"[^>]*autocomplete="current-password"/);
  });

  it('no inline <style> block in settings.njk; the controls in §2, the layout next to the plugin area (pgx-)', () => {
    const njk = fs.readFileSync(path.join(__dirname, '..', 'templates', 'aurora', 'pages', 'settings.njk'), 'utf8');
    assert.doesNotMatch(njk, /<style/, 'no <style> block');
    const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'app.css'), 'utf8');
    const aurora = css.slice(css.indexOf('\n * §2 '), css.indexOf('\n * §3 '));
    for (const sel of ['.st-switch', '.st-seg', '.st-savebar', '.st-matrix', '.st-typecard']) {
      assert.ok(aurora.includes(sel), sel + ' in §2');
    }
    for (const sel of ['.stx .st-btn,.pgx-btn{', '.stx .st-pill,.pgx-pill{', '.stx .st-switch,.cpf-sw,.pgx-sw{', '.stx .st-seg,.cpf-seg,.pgx-seg{']) {
      assert.ok(css.includes(sel), sel + ': one rule for both areas');
    }
    assert.match(css, /\.stx \.st-row-ctl\{flex:0 1 380px; width:380px/, 'the control column');
    assert.match(css, /@media \(max-width:900px\)\{\s*\.stx \.stx-wrap/, 'the phone layout from 900 px');
    assert.doesNotMatch(css, /\.st-page\{|\.st-nav-item\{|\.st-layout\{/, 'the old settings layout is gone');
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
describe('aurora theme — gateway management on /gateways (moved from the Peers page)', () => {
  it('the gateways page loads gateway-manage.js with its strings and the "disabled gateways" anchor', async () => {
    selectAurora();
    const res = await agent.get('/gateways').expect(200);
    assert.match(res.text, /<script src="\/js\/gateway-manage\.js\?v=[^"]+"><\/script>\s*<script src="\/js\/gateways\.js/, 'before gateways.js');
    assert.match(res.text, /<div id="gw-disabled" hidden><\/div>/);
    const island = res.text.match(/<script type="application\/json" id="gwm-i18n"[^>]*>([^<]*)<\/script>/);
    assert.ok(island, 'strings island');
    const strings = JSON.parse(island[1]);
    for (const k of ['gwm.rename', 'gwm.reconnect', 'gwm.renew', 'gwm.renew_confirm', 'gwm.renew_server', 'gwm.renew_code', 'gwm.proxy_port', 'gwm.disable', 'gwm.delete', 'gateway_delete_title']) assert.ok(strings[k] && strings[k] !== k, k);
  });

  it('gateways.js adds the entries to "Mehr" and hands gm-* actions to gateway-manage.js', () => {
    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'gateways.js'), 'utf8');
    assert.match(js, /window\.GCGatewayManage\.menuItems\(g, item, menu\)/);
    assert.match(js, /closest\('\[data-act\^="gm-"\]'\)/);
    const gm = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'gateway-manage.js'), 'utf8');
    for (const a of ['gm-rename', 'gm-renew', 'gm-reconnect', 'gm-proxy', 'gm-disable', 'gm-enable', 'gm-delete']) assert.ok(gm.includes(`'${a}'`), a);
    assert.match(gm, /\/delete-impact/, 'the routes of the gateway before deleting');
    assert.match(gm, /\/api\/v1\/peers\?type=gateway/, 'disabled gateways listed');
    assert.doesNotMatch(gm.replace(/\/\/[^\n]*/g, ''), /innerHTML/);
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

  it('Issue 10 (redesign): "Gerät & Software" — deviceCard() in the overview, technical rows in <details>', () => {
    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'gateways.js'), 'utf8');
    assert.match(js, /function deviceCard\(/, 'deviceCard() present in gateways.js');
    assert.match(js, /two\.appendChild\(deviceCard\(g\)\)/, 'the overview shows deviceCard(g)');
    assert.match(js, /el\('details', 'gwo-tech'\)/, 'technical rows in <details>');
  });

  it('Issue 11 (redesign): the overview starts with Zustand · Pool · Funktionen in an auto-fit grid', () => {
    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'gateways.js'), 'utf8');
    const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'app.css'), 'utf8');
    const ov = js.slice(js.indexOf('function overview('), js.indexOf('function netExtras('));
    assert.ok(ov.indexOf('stateCard(g)') < ov.indexOf('P.poolCard(g)') && ov.indexOf('P.poolCard(g)') < ov.indexOf('summaryCard(g)'), 'Zustand, Pool, Funktionen');
    assert.ok(ov.indexOf('summaryCard(g)') < ov.indexOf('deviceCard(g)'), 'the features card is no longer above the gateway info — it is one of the top three, the info follows');
    assert.match(css, /\.gwo-top\{display:grid; grid-template-columns:repeat\(auto-fit,minmax\(min\(340px,100%\),1fr\)\)/);
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
