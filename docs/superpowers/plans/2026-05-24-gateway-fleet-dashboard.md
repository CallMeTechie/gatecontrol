# Gateway Fleet Dashboard (2a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A top-level **Gateways** page showing each gateway's heartbeat telemetry as cards with a version-drift badge, a detail drilldown, and an on-demand fresh-health re-check.

**Architecture:** Reuse the existing `GET /api/v1/gateways` telemetry; add a cached GitHub-release lookup for drift, a numeric version-compare util, and a `refreshHealth` that pulls the gateway's own `/api/status` over the tunnel (merging onto stored health and feeding the existing health state machine). UI is a Nunjucks shell populated by a vanilla-JS client (safe DOM, no innerHTML) that reads i18n + CSRF from `window.GC` and listens to Feature #1's `gc:gateway` SSE events.

**Tech Stack:** Node 20, Express 4, better-sqlite3, Nunjucks, vanilla `fetch`/`EventSource`, `node --test`. Spec: `docs/superpowers/specs/2026-05-24-gateway-fleet-dashboard-design.md`.

**Branch:** `feat/gateway-fleet-dashboard` (off `master`). The "Update" action is **out of scope** (sub-project 2b). Local commits; push/PR at the end.

> **Verified facts (plan-review round 1 folded in):** i18n locale files are **flat dot-keys**, loader does `locale[key]` (no nesting). The client reads translations from `window.GC.t['...']` and CSRF from `window.GC.csrfToken` (set in `layout.njk`). Sidebar nav lives in `templates/{default,pro}/partials/sidebar.njk` (+ `bottomnav.njk` mobile), not `layout.njk`. API `status` comes from `gateways.getHealthStatus` (in-memory state machine: `online`/`offline`/`unknown`); `recordProbeResult(peerId, healthy)` feeds that same machine. The gateway's `/api/status` returns `overall_healthy` + `route_reachability` (confirmed against the gateway repo + live data).

---

## File Structure

**New**
- `src/utils/version.js` — `compareVersions(a,b)` numeric semver compare.
- `src/services/gatewayRelease.js` — cached, non-blocking latest-gateway-version lookup.
- `templates/default/pages/gateways.njk`, `templates/pro/pages/gateways.njk` — page shell.
- `public/js/gateways.js` — render cards (safe DOM), drift badge, drilldown, probe, live refresh.
- `tests/version.test.js`, `tests/gatewayRelease.test.js`, `tests/api_gateways_fleet.test.js`.
- `docs/feature-gateway-fleet.md`.

**Modified**
- `src/routes/api/gateways.js` — `latest_version` + per-gateway `update_available` in list; `POST /:id/probe`.
- `src/services/gateways.js` — `refreshHealth(peerId)` + `_mergeHealth` (feeds `recordProbeResult`).
- `src/routes/index.js` — `/gateways` in the protected `pages` array.
- `templates/{default,pro}/partials/sidebar.njk` + `templates/{default,pro}/partials/bottomnav.njk` — nav link.
- `templates/{default,pro}/layout.njk` — add the `gateways.*` keys to the `window.GC.t` block.
- `src/i18n/en.json`, `src/i18n/de.json` — **flat** `nav.gateways` + `gateways.*` keys.
- `src/services/license.js` — `gateway_fleet: true` in `COMMUNITY_FALLBACK`.

---

## Task 1: Version compare util

**Files:** Create `src/utils/version.js`, `tests/version.test.js`.

- [ ] **Step 1: Write the failing test**

```js
// tests/version.test.js
'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { compareVersions } = require('../src/utils/version');

describe('compareVersions', () => {
  it('orders numerically, not lexically', () => {
    assert.equal(compareVersions('1.10.0', '1.9.0'), 1);
    assert.equal(compareVersions('1.9.2', '1.9.10'), -1);
  });
  it('treats equal/missing-segment versions as 0', () => {
    assert.equal(compareVersions('1.9.2', '1.9.2'), 0);
    assert.equal(compareVersions('1.9', '1.9.0'), 0);
  });
  it('strips a leading v and any -suffix', () => {
    assert.equal(compareVersions('v1.9.3', '1.9.2'), 1);
    assert.equal(compareVersions('1.10.0-rc1', '1.9.0'), 1);
  });
  it('returns 0 (no badge) on unparseable input', () => {
    assert.equal(compareVersions('abc', '1.9.0'), 0);
    assert.equal(compareVersions(null, '1.9.0'), 0);
  });
});
```

- [ ] **Step 2: Run — expect FAIL.** `node --test --test-force-exit tests/version.test.js`

- [ ] **Step 3: Implement**

```js
// src/utils/version.js
'use strict';

// Numeric semver compare. Strips a leading "v" and any "-prerelease" suffix.
// Returns 1 if a>b, -1 if a<b, 0 if equal OR either side is unparseable
// (callers treat 0 as "no drift badge").
function compareVersions(a, b) {
  const parse = (v) => String(v == null ? '' : v).trim().replace(/^v/i, '').split('-')[0].split('.');
  const pa = parse(a), pb = parse(b);
  for (let i = 0; i < 3; i++) {
    const x = parseInt(pa[i] ?? '0', 10);
    const y = parseInt(pb[i] ?? '0', 10);
    if (Number.isNaN(x) || Number.isNaN(y)) return 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

module.exports = { compareVersions };
```

- [ ] **Step 4: Run — expect PASS** (4 tests).
- [ ] **Step 5: Commit**
```bash
git add src/utils/version.js tests/version.test.js
git commit -m "feat(gateways): numeric version-compare util"
```

---

## Task 2: Latest-version service (cached, non-blocking)

**Files:** Create `src/services/gatewayRelease.js`, `tests/gatewayRelease.test.js`.

- [ ] **Step 1: Write the failing test**

```js
// tests/gatewayRelease.test.js
'use strict';
process.env.NODE_ENV = 'test';
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
function fresh() { delete require.cache[require.resolve('../src/services/gatewayRelease')]; return require('../src/services/gatewayRelease'); }

describe('gatewayRelease', () => {
  let svc;
  beforeEach(() => { svc = fresh(); });
  it('returns null on a cold cache without blocking or firing a real request', () => {
    const t0 = Date.now();
    assert.equal(svc.getLatestVersion(), null);
    assert.ok(Date.now() - t0 < 100);
  });
  it('normalises a tag (strips leading v)', () => {
    assert.equal(svc._normalizeTag('v1.9.3'), '1.9.3');
    assert.equal(svc._normalizeTag('1.9.3'), '1.9.3');
    assert.equal(svc._normalizeTag(null), null);
  });
  it('serves a set cache value', () => { svc._setCache('1.9.3'); assert.equal(svc.getLatestVersion(), '1.9.3'); });
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement** (mirrors `src/routes/api/client/update.js`; `NODE_ENV=test` short-circuits the real fetch so unit tests stay hermetic)

```js
// src/services/gatewayRelease.js
'use strict';
const https = require('node:https');
const logger = require('../utils/logger');

const REPO = process.env.GC_GATEWAY_REPO || 'CallMeTechie/gatecontrol-gateway';
const TOKEN = process.env.GC_CLIENT_GITHUB_TOKEN || '';
const CACHE_TTL = 60 * 60 * 1000;
const MAX_BODY = 200 * 1024;

let cache = { version: null, fetchedAt: 0 };
let inFlight = false;

function _normalizeTag(tag) { return tag ? String(tag).trim().replace(/^v/i, '') : null; }

function _fetchLatest() {
  if (inFlight || process.env.NODE_ENV === 'test') return; // never fire a real request in tests
  inFlight = true;
  const headers = { 'User-Agent': 'GateControl', Accept: 'application/vnd.github+json' };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  const req = https.get(`https://api.github.com/repos/${REPO}/releases/latest`, { headers, timeout: 5000 }, (res) => {
    if (res.statusCode !== 200) { res.resume(); inFlight = false; logger.warn({ status: res.statusCode }, 'gateway release fetch non-200'); return; }
    let body = '';
    res.on('data', (c) => { body += c; if (body.length > MAX_BODY) req.destroy(); });
    res.on('end', () => {
      inFlight = false;
      try { const v = _normalizeTag(JSON.parse(body).tag_name); if (v) cache = { version: v, fetchedAt: Date.now() }; }
      catch (err) { logger.warn({ err: err.message }, 'gateway release parse failed'); }
    });
  });
  req.on('error', (err) => { inFlight = false; logger.warn({ err: err.message }, 'gateway release fetch failed'); });
  req.on('timeout', () => { req.destroy(); inFlight = false; });
}

// Immediate: cached/last-known version (or null); triggers a background refresh
// when stale. NEVER blocks the caller on a live fetch.
function getLatestVersion() {
  if (Date.now() - cache.fetchedAt > CACHE_TTL) _fetchLatest();
  return cache.version;
}

module.exports = { getLatestVersion, _normalizeTag, _fetchLatest, _setCache: (v) => { cache = { version: v, fetchedAt: Date.now() }; } };
```

- [ ] **Step 4: Run — expect PASS** (3 tests).
- [ ] **Step 5: Commit**
```bash
git add src/services/gatewayRelease.js tests/gatewayRelease.test.js
git commit -m "feat(gateways): cached non-blocking latest-version lookup"
```

---

## Task 3: refreshHealth + gateways API

**Files:** Modify `src/services/gateways.js`, `src/routes/api/gateways.js`; Test `tests/api_gateways_fleet.test.js`.

- [ ] **Step 1: Write the failing test** (service-level — no HTTP auth needed; a local mock plays the gateway)

```js
// tests/api_gateways_fleet.test.js
'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path'); const fs = require('node:fs'); const os = require('node:os');
const http = require('node:http'); const crypto = require('node:crypto');
process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
process.env.NODE_ENV = 'test';

describe('gateways fleet service', () => {
  let gateways, db, mock, mockPort, peerId;
  before(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-fleet-'));
    process.env.GC_DB_PATH = path.join(tmp, 'test.db'); process.env.GC_DATA_DIR = tmp;
    ['../config/default','../src/db/connection','../src/db/migrations','../src/services/gateways','../src/services/license','../src/services/gatewayRelease']
      .forEach(p => { try { delete require.cache[require.resolve(p)]; } catch (_) {} });
    require('../src/db/migrations').runMigrations();
    require('../src/services/license')._overrideForTest?.({ gateway_peers: 10, gateway_fleet: true });
    gateways = require('../src/services/gateways');
    db = require('../src/db/connection').getDb();
    // mock gateway: GET /api/status → fresh self-check (no telemetry — heartbeat-only)
    mock = http.createServer((req, res) => {
      if (req.url === '/api/status') { res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ overall_healthy: false, route_reachability: [{ route_id: 1, reachable: false }] })); }
      else { res.writeHead(404); res.end(); }
    });
    await new Promise(r => mock.listen(0, '127.0.0.1', r));
    mockPort = mock.address().port;
    const gw = await gateways.createGateway({ name: 'fleet-gw', apiPort: mockPort });
    peerId = gw.peer.id;
    // point the gateway at the local mock + seed a stored last_health WITH telemetry on an older version
    db.prepare('UPDATE peers SET allowed_ips = ? WHERE id = ?').run('127.0.0.1/32', peerId);
    db.prepare('UPDATE gateway_meta SET last_health = ? WHERE peer_id = ?')
      .run(JSON.stringify({ overall_healthy: true, telemetry: { gateway_version: '1.8.0' }, hostname: 'gw1' }), peerId);
  });
  after(() => { mock && mock.close(); });

  it('_mergeHealth applies fresh self-check but keeps telemetry/hostname', () => {
    const merged = gateways._mergeHealth(
      { overall_healthy: true, telemetry: { gateway_version: '1.8.0' }, hostname: 'gw1' },
      { overall_healthy: false, route_reachability: [{ route_id: 1, reachable: false }] });
    assert.equal(merged.overall_healthy, false);
    assert.deepEqual(merged.telemetry, { gateway_version: '1.8.0' });
    assert.equal(merged.hostname, 'gw1');
    assert.equal(merged.route_reachability.length, 1);
  });
  it('returns null for a non-gateway peer id', async () => { assert.equal(await gateways.refreshHealth(999999), null); });
  it('on success merges fresh health, keeps telemetry, feeds the state machine', async () => {
    const r = await gateways.refreshHealth(peerId);
    assert.equal(r.reachable, true);
    const lh = JSON.parse(db.prepare('SELECT last_health FROM gateway_meta WHERE peer_id = ?').get(peerId).last_health);
    assert.equal(lh.overall_healthy, false);                      // fresh applied
    assert.equal(lh.telemetry.gateway_version, '1.8.0');          // telemetry preserved
    assert.notEqual(gateways.getHealthStatus(peerId), 'offline'); // recordProbeResult(true) fed the SM
  });
  it('on connect failure marks the gateway offline via the state machine', async () => {
    db.prepare('UPDATE gateway_meta SET api_port = 1 WHERE peer_id = ?').run(peerId); // port 1 → ECONNREFUSED
    const r = await gateways.refreshHealth(peerId);
    assert.equal(r.reachable, false);
    assert.equal(gateways.getHealthStatus(peerId), 'offline');
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (`gateways._mergeHealth` not a function).
Run: `NODE_ENV=test node --test --test-force-exit tests/api_gateways_fleet.test.js`

- [ ] **Step 3a: Add to `src/services/gateways.js`** (near `notifyConfigChanged`; `http`/`decrypt`/`_peerIp`/`getDb`/`recordProbeResult` are all in this file):

```js
// Self-check fields the gateway's GET /api/status returns. NOT telemetry/
// hostname/config_hash — those are heartbeat-only and MUST be preserved.
const SELF_CHECK_FIELDS = ['http_proxy_healthy', 'api_healthy', 'tcp_listeners', 'wg_handshake_age_s', 'dns_resolve_ok', 'route_reachability', 'overall_healthy'];

function _mergeHealth(stored, fresh) {
  const merged = { ...(stored && typeof stored === 'object' ? stored : {}) };
  if (fresh && typeof fresh === 'object') for (const k of SELF_CHECK_FIELDS) if (k in fresh) merged[k] = fresh[k];
  return merged;
}

// On-demand fresh health: call the gateway's own /api/status over the tunnel,
// merge onto stored last_health (preserving telemetry/hostname/config_hash),
// persist, and feed the SAME state machine getHealthStatus reads via
// recordProbeResult so the displayed status reflects the probe.
async function refreshHealth(peerId) {
  const db = getDb();
  const row = db.prepare(`
    SELECT p.allowed_ips, p.peer_type, gm.api_port, gm.push_token_encrypted, gm.last_health
    FROM gateway_meta gm JOIN peers p ON p.id = gm.peer_id WHERE gm.peer_id = ?
  `).get(peerId);
  if (!row || row.peer_type !== 'gateway') return null;

  const pushToken = decrypt(row.push_token_encrypted);
  const ip = _peerIp(row.allowed_ips);
  const fresh = await new Promise((resolve) => {
    let body = '';
    const req = http.request({ host: ip, port: row.api_port, path: '/api/status', method: 'GET', timeout: 5000,
      headers: { 'X-Gateway-Token': pushToken } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return resolve(null); }
      res.on('data', (c) => { body += c; if (body.length > 65536) req.destroy(); });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });

  if (!fresh) {
    recordProbeResult(peerId, false); // feed the state machine getHealthStatus reads
    return { reachable: false };
  }
  let stored = {};
  try { stored = row.last_health ? JSON.parse(row.last_health) : {}; } catch { stored = {}; }
  const merged = _mergeHealth(stored, fresh);
  db.prepare('UPDATE gateway_meta SET last_health = ?, last_seen_at = ? WHERE peer_id = ?')
    .run(JSON.stringify(merged), Date.now(), peerId);
  recordProbeResult(peerId, true);
  return { reachable: true };
}
```

Add `_mergeHealth, refreshHealth` to `module.exports`. (Note: `recordProbeResult` is defined at line ~553 — `refreshHealth` may be defined above it; in CommonJS hoisting of `function` declarations makes the call valid regardless of order.)

- [ ] **Step 3b: Edit `src/routes/api/gateways.js`** — replace the final `res.json({ ok: true, gateways });` in `GET '/'` with:

```js
    const latestVersion = require('../../services/gatewayRelease').getLatestVersion();
    const { compareVersions } = require('../../utils/version');
    for (const g of gateways) {
      const cur = g.health && g.health.telemetry ? g.health.telemetry.gateway_version : null;
      g.update_available = !!(latestVersion && cur && compareVersions(latestVersion, cur) > 0);
    }
    res.json({ ok: true, gateways, latest_version: latestVersion });
```

And add before `module.exports = router;`:

```js
// On-demand fresh-health re-check (session-authed; the /api/v1 CSRF middleware
// guards this POST for session callers — the UI sends GC.csrfToken; token-auth
// is exempt). The Update action is NOT here (sub-project 2b).
router.post('/:id/probe', async (req, res) => {
  const peerId = parseInt(req.params.id, 10);
  const result = await require('../../services/gateways').refreshHealth(peerId);
  if (result === null) return res.status(404).json({ ok: false, error: 'not a gateway' });
  res.json({ ok: true, reachable: result.reachable });
});
```

- [ ] **Step 3c: Extend the existing authed list test.** In `tests/gateway_api_list.test.js` (which already wires authentication), after seeding a gateway whose `last_health.telemetry.gateway_version` is older than a `gatewayRelease._setCache(...)` value, assert the `GET /api/v1/gateways` response contains `latest_version` and the gateway's `update_available === true`. Reuse that file's existing auth setup verbatim.

- [ ] **Step 4: Run — expect PASS.** `NODE_ENV=test node --test --test-force-exit tests/api_gateways_fleet.test.js`, then full suite (only the pre-existing `wg` env test may fail).

- [ ] **Step 5: Commit**
```bash
git add src/services/gateways.js src/routes/api/gateways.js tests/api_gateways_fleet.test.js tests/gateway_api_list.test.js
git commit -m "feat(gateways): drift fields on list + refreshHealth probe (feeds state machine)"
```

---

## Task 4: Page, nav, i18n, client

**Files:** Create `templates/{default,pro}/pages/gateways.njk`, `public/js/gateways.js`; Modify `src/routes/index.js`, `templates/{default,pro}/partials/sidebar.njk`, `templates/{default,pro}/partials/bottomnav.njk`, `templates/{default,pro}/layout.njk`, `src/i18n/{en,de}.json`, `src/services/license.js`.

- [ ] **Step 1: Page route** — in `src/routes/index.js` `pages` array (after `gateway-pools`):
```js
    { path: '/gateways', template: 'gateways', titleKey: 'nav.gateways' },
```

- [ ] **Step 2: Licence flag** — in `src/services/license.js` `COMMUNITY_FALLBACK`:
```js
  gateway_fleet: true,
```
(Community feature → registered in `COMMUNITY_FALLBACK` only; no API guard / template-lock, consistent with `traffic_history`/`backup_restore` which are also Community and unguarded. Per spec §6.)

- [ ] **Step 3: i18n — FLAT keys** (the loader does `locale[key]`, no nesting). Add to `src/i18n/en.json` and `src/i18n/de.json` as flat keys (alongside the existing `"nav.dashboard"`, `"gateway_pools.title"` style). EN:
```json
"nav.gateways": "Gateways",
"gateways.title": "Gateways",
"gateways.subtitle": "Fleet overview from heartbeat telemetry",
"gateways.online": "Online",
"gateways.offline": "Offline",
"gateways.degraded": "Degraded",
"gateways.pending": "Pending",
"gateways.update_available": "Update available",
"gateways.version_check_unavailable": "Latest-version check unavailable",
"gateways.routes": "Routes",
"gateways.version": "Version",
"gateways.kpi_total": "Gateways",
"gateways.kpi_update": "Update"
```
DE (same keys): `"nav.gateways":"Gateways"`, `"gateways.title":"Gateways"`, `"gateways.subtitle":"Flotten-Übersicht aus Heartbeat-Telemetrie"`, `"gateways.online":"Online"`, `"gateways.offline":"Offline"`, `"gateways.degraded":"Degradiert"`, `"gateways.pending":"Ausstehend"`, `"gateways.update_available":"Update verfügbar"`, `"gateways.version_check_unavailable":"Versions-Check nicht verfügbar"`, `"gateways.routes":"Routen"`, `"gateways.version":"Version"`, `"gateways.kpi_total":"Gateways"`, `"gateways.kpi_update":"Update"`.

- [ ] **Step 4: Expose the keys to the client** — in `templates/default/layout.njk` and `templates/pro/layout.njk`, inside the existing `window.GC = { ... t: { ... } }` block, add the `gateways.*` keys the client uses. **Use the EXACT existing entry syntax `'<key>': {{ t('<key>') | dump | safe }},`** (the `| dump | safe` filter JSON-serialises the value — required so a translation containing an apostrophe doesn't break the JS; do NOT wrap in surrounding string quotes). Mirror the existing `gateway_pools.*` entries:
```js
      'gateways.online': {{ t('gateways.online') | dump | safe }},
      'gateways.offline': {{ t('gateways.offline') | dump | safe }},
      'gateways.degraded': {{ t('gateways.degraded') | dump | safe }},
      'gateways.pending': {{ t('gateways.pending') | dump | safe }},
      'gateways.version': {{ t('gateways.version') | dump | safe }},
      'gateways.routes': {{ t('gateways.routes') | dump | safe }},
      'gateways.kpi_total': {{ t('gateways.kpi_total') | dump | safe }},
      'gateways.kpi_update': {{ t('gateways.kpi_update') | dump | safe }},
```

- [ ] **Step 5: Sidebar + bottom nav** — in `templates/{default,pro}/partials/sidebar.njk` add a link mirroring the existing items (NO `license.features` wrap — it's Community):
```html
  <a href="/gateways" class="nav-item {{ 'active' if activeNav == 'gateways' }}">{{ t('nav.gateways') }}</a>
```
(match the exact inner markup/icon of a neighbouring `nav-item`). Add the equivalent entry to `templates/{default,pro}/partials/bottomnav.njk` if gateways should appear in mobile nav (mirror an existing mobile entry).

- [ ] **Step 6: Page shell** — `templates/default/pages/gateways.njk` (+ `pro` copy; read `peers.njk` for the exact extends/block pattern, which uses `{% extends theme + "/layout.njk" %}`):
```html
{% extends theme + "/layout.njk" %}
{% block content %}
<div class="page-h"><div><h1>{{ t('gateways.title') }}</h1><p class="page-sub">{{ t('gateways.subtitle') }}</p></div></div>
<div id="fleet-kpis" class="kpis"></div>
<div id="version-warning" class="note" hidden>{{ t('gateways.version_check_unavailable') }}</div>
<div id="fleet-grid" class="grid"></div>
<div id="gw-modal" class="modal" hidden><div class="modal-body" id="gw-modal-body"></div></div>
{% endblock %}
{% block scripts %}<script src="/js/gateways.js?v={{ appVersion }}"></script>{% endblock %}
```

- [ ] **Step 7: Client** — `public/js/gateways.js`. **Safe DOM only (no innerHTML)**; reads i18n from `GC.t` and CSRF from `GC.csrfToken`; renders the spec §3 card fields (version+drift, CPU/RAM/disk bars, WG-handshake, routes, last-seen):
```js
(function () {
  'use strict';
  var GCt = (window.GC && GC.t) || {};
  var csrf = (window.GC && GC.csrfToken) || '';
  function T(k, d) { return GCt[k] || d; }
  var grid = document.getElementById('fleet-grid');
  var kpis = document.getElementById('fleet-kpis');
  var warn = document.getElementById('version-warning');
  var modal = document.getElementById('gw-modal');
  var modalBody = document.getElementById('gw-modal-body');
  var last = [], latest = '';

  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = String(text); return n; }
  function bar(pct, warnLvl) { var b = el('div', 'bar'); var i = el('span', warnLvl ? 'fill ' + warnLvl : 'fill'); i.style.width = Math.max(0, Math.min(100, pct)) + '%'; b.appendChild(i); return b; }
  function pct(used, total) { return total > 0 ? Math.round((used / total) * 100) : 0; }
  function status(g) {
    if (g.status === 'offline') return 'offline';
    if (!g.health || g.status === 'unknown') return 'pending';
    if (g.health.overall_healthy === false) return 'degraded';
    return 'online';
  }
  function ago(ms) { if (!ms) return '—'; var s = Math.round((Date.now() - ms) / 1000); return s < 60 ? s + 's' : Math.round(s / 60) + 'm'; }

  function metricRow(parent, label, value, p, warnLvl) {
    var m = el('div', 'metric'); m.appendChild(el('span', null, label)); m.appendChild(el('span', null, value)); parent.appendChild(m);
    parent.appendChild(bar(p, warnLvl));
  }
  function card(g) {
    var t = (g.health && g.health.telemetry) || {};
    var routes = (g.health && g.health.route_reachability) || [];
    var up = routes.filter(function (r) { return r.reachable; }).length;
    var st = status(g);
    var wrap = el('div', 'gw'); wrap.dataset.id = g.peer_id;
    var top = el('div', 'top');
    var tb = el('div'); tb.appendChild(el('h3', null, g.name)); tb.appendChild(el('div', 'host', (g.hostname || '') + ' · ' + (g.ip || '')));
    top.appendChild(tb); top.appendChild(el('span', 'pill ' + st, T('gateways.' + st, st))); wrap.appendChild(top);
    var body = el('div', 'body');
    var verKv = el('div', 'kv'); verKv.appendChild(el('div', 'k', T('gateways.version', 'Version')));
    var verV = el('div', 'v', (t.gateway_version || '—') + ' '); if (g.update_available) verV.appendChild(el('span', 'badge drift', '↑ ' + latest));
    verKv.appendChild(verV); body.appendChild(verKv);
    var cores = (t.cpu_cores || 1); var load1 = (t.cpu_load_avg && t.cpu_load_avg[0]) || 0;
    metricRow(body, 'CPU', load1.toFixed(2), pct(load1, cores), pct(load1, cores) > 90 ? 'bad' : null);
    if (t.mem_total) metricRow(body, 'RAM', Math.round(t.mem_used / 1e9 * 10) / 10 + '/' + Math.round(t.mem_total / 1e9) + ' GB', pct(t.mem_used, t.mem_total), null);
    if (t.disk && t.disk.total) metricRow(body, 'Disk', pct(t.disk.used, t.disk.total) + '%', pct(t.disk.used, t.disk.total), pct(t.disk.used, t.disk.total) > 85 ? 'bad' : (pct(t.disk.used, t.disk.total) > 70 ? 'warn' : null));
    var rt = el('div', 'kv'); rt.appendChild(el('div', 'k', T('gateways.routes', 'Routes'))); rt.appendChild(el('div', 'v', up + ' / ' + routes.length)); body.appendChild(rt);
    wrap.appendChild(body);
    var foot = el('div', 'foot');
    foot.appendChild(el('span', null, 'WG ' + (g.health && g.health.wg_handshake_age_s != null ? g.health.wg_handshake_age_s + 's' : '—') + ' · ' + ago(g.last_seen_at)));
    var btn = el('button', 'btn ghost recheck', '↻'); btn.dataset.id = g.peer_id; foot.appendChild(btn);
    wrap.appendChild(foot);
    return wrap;
  }
  function kpi(cls, n, label) { var k = el('div', 'kpi' + (cls ? ' ' + cls : '')); k.appendChild(el('div', 'n', n)); k.appendChild(el('div', 'l', label)); return k; }
  function render(data) {
    last = data.gateways || []; latest = data.latest_version || ''; warn.hidden = !!data.latest_version;
    var on = 0, off = 0, deg = 0, upd = 0;
    last.forEach(function (g) { var s = status(g); if (s === 'online') on++; else if (s === 'offline') off++; else if (s === 'degraded') deg++; if (g.update_available) upd++; });
    kpis.replaceChildren(
      kpi('', last.length, T('gateways.kpi_total', 'Gateways')),
      kpi('ok', on, T('gateways.online', 'Online')),
      kpi('warn', deg, T('gateways.degraded', 'Degraded')),   // §4: 5 KPIs incl. degraded
      kpi('bad', off, T('gateways.offline', 'Offline')),
      kpi('warn', upd, T('gateways.kpi_update', 'Update')));
    grid.replaceChildren.apply(grid, last.map(card));
  }
  function load() { fetch('/api/v1/gateways', { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(render).catch(function () {}); }
  grid.addEventListener('click', function (e) {
    var rc = e.target.closest('.recheck'); if (rc) { e.stopPropagation(); probe(rc.dataset.id); return; }
    var c = e.target.closest('.gw'); if (!c) return;
    var g = last.find(function (x) { return String(x.peer_id) === c.dataset.id; });
    if (g) { modalBody.replaceChildren(el('pre', null, JSON.stringify(g.health, null, 2))); modal.hidden = false; }
  });
  modal.addEventListener('click', function () { modal.hidden = true; });
  function probe(id) { fetch('/api/v1/gateways/' + encodeURIComponent(id) + '/probe', { method: 'POST', credentials: 'same-origin', headers: { 'X-CSRF-Token': csrf } }).then(function () { load(); }).catch(function () {}); }
  var deb = null; function refresh() { clearTimeout(deb); deb = setTimeout(load, 1000); }
  document.addEventListener('gc:gateway', refresh);
  document.addEventListener('gc:reconnected', refresh);
  setInterval(load, 30000);
  load();
})();
```

- [ ] **Step 8: Verify** — `node --check public/js/gateways.js`; `NODE_ENV=test node --test --test-force-exit tests/`; manually load `/gateways` in both EN and DE, confirm cards + drift badge + drilldown + re-check + translated labels (no raw keys, no German "Routen" in EN).

- [ ] **Step 9: Commit**
```bash
git add src/routes/index.js src/services/license.js src/i18n/en.json src/i18n/de.json \
        templates/default/layout.njk templates/pro/layout.njk \
        templates/default/partials/sidebar.njk templates/pro/partials/sidebar.njk \
        templates/default/partials/bottomnav.njk templates/pro/partials/bottomnav.njk \
        templates/default/pages/gateways.njk templates/pro/pages/gateways.njk public/js/gateways.js
git commit -m "feat(gateways): fleet page, nav, i18n, client (cards/drilldown/probe/live)"
```

---

## Task 5: Docs + verify + push

- [ ] **Step 1:** Write `docs/feature-gateway-fleet.md` — what it shows; drift source + `compareVersions`; re-check (`/api/status` merge keeping telemetry, feeds `recordProbeResult`); status model (SM `online/offline/unknown` + client `degraded`/`pending`); live tie-in to #1; `gateway_fleet` flag; Update action = 2b. Force-add (`git add -f`).
- [ ] **Step 2:** Full suite — `NODE_ENV=test node --test --test-force-exit tests/` (only the pre-existing `wg` env test fails).
- [ ] **Step 3:** Lint is CI-gated; CI runs `npx eslint -c .eslintrc.security.json "src/**/*.js" "public/**/*.js" --no-eslintrc`. Client uses no innerHTML/eval/child_process/fs.
- [ ] **Step 4:** Commit docs, push branch, open PR to `master`.
```bash
git add -f docs/feature-gateway-fleet.md && git commit -m "docs: gateway fleet feature doc"
git push -u origin feat/gateway-fleet-dashboard
```

---

## Self-Review

**Spec coverage:** §2 drift (Task 1 compare + Task 2 release non-blocking + Task 3 server-side `update_available`/`latest_version`); §3 cards incl. CPU/RAM/disk/WG/routes/last-seen + drilldown + re-check (Task 4 `card()` + Task 3 `refreshHealth` merge/bounded); §4 status = SM + client `degraded`/`pending` overlay, `refreshHealth`→`recordProbeResult` (Task 3 + Task 4 `status()`); §5 live debounce (Task 4); §6 auth/CSRF via `GC.csrfToken` + `gateway_fleet` flag (Task 3 + Task 4); §7 null→`#version-warning` + warn log (Task 2 + Task 4); §11/§12 DA fixes — `_mergeHealth` keeps telemetry, non-blocking + test-hermetic latest, bounded body, compare edges (Tasks 1–3 tests). All covered.

**Plan-review-1 fixes applied:** flat i18n + `GC.t` exposure (Step 3/4); nav in `partials/sidebar.njk`+`bottomnav.njk` not layout (Step 5); CSRF from `GC.csrfToken` (Step 7); no hardcoded user-facing strings — all via `T()`/`t()` (Step 7); `refreshHealth` feeds `recordProbeResult` so status isn't stale (Task 3); card fields completed (Task 4); `gatewayRelease` hermetic in tests (Task 2); authed list assertion via `gateway_api_list.test.js` (Task 3c); script tag without nonce, `?v=appVersion` like peers (Step 6).

**Placeholder scan:** "read the file first" notes (neighbouring `nav-item` markup, `bottomnav` entry, the `GC.t` block location, `gateway_api_list.test.js` auth setup) each name an exact existing reference to copy. All new logic files have complete code. No innerHTML.

**Type/name consistency:** `compareVersions`, `getLatestVersion`/`_setCache`/`_normalizeTag`, `refreshHealth`/`_mergeHealth`/`recordProbeResult`/`getHealthStatus` consistent across tasks+tests; response fields `latest_version`+`update_available` consistent Task 3↔4; i18n keys `gateways.*` consistent across en/de json ↔ `GC.t` ↔ client `T()`; `gc:gateway`/`gc:reconnected` match Feature #1.
