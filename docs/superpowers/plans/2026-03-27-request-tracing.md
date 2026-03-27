# Request Tracing (caddy-trace) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-route request tracing via caddy-trace plugin with a Debug tab in the edit-route modal.

**Architecture:** caddy-trace plugin logs request/response details per route (filtered by tag) to a dedicated trace log file. A new API endpoint reads and parses the log. The UI shows a live-updating Debug tab in the edit modal with auto-refresh polling.

**Tech Stack:** caddy-trace (Caddy plugin), Express.js API, Nunjucks templates, vanilla JS

**Spec:** `docs/superpowers/specs/2026-03-27-request-tracing-design.md`

---

### Task 1: Add caddy-trace plugin to Dockerfile

**Files:**
- Modify: `Dockerfile:5-9`

- [ ] **Step 1: Add caddy-trace to xcaddy build**

In `Dockerfile`, add `--with github.com/greenpau/caddy-trace` to the xcaddy build command:

```dockerfile
RUN cd /tmp/caddy-mirror && go mod tidy && cd / && \
    xcaddy build \
    --output /usr/bin/caddy \
    --with github.com/mholt/caddy-l4 \
    --with github.com/mholt/caddy-ratelimit \
    --with github.com/ueffel/caddy-brotli \
    --with github.com/greenpau/caddy-trace \
    --with github.com/custom/caddy-mirror=/tmp/caddy-mirror
```

- [ ] **Step 2: Build and verify module is loaded**

Run: `docker compose build --no-cache 2>&1 | tail -5`
Then: `docker compose up -d && sleep 5 && docker exec gatecontrol caddy list-modules 2>&1 | grep trace`
Expected: `http.handlers.trace`

- [ ] **Step 3: Commit**

```bash
git add Dockerfile
git commit -m "feat: add caddy-trace plugin to Caddy build"
```

---

### Task 2: Database migration

**Files:**
- Modify: `src/db/migrations.js` (after line 452, append new migration)

- [ ] **Step 1: Add migration version 27**

After the last migration entry (version 26, line 452), add:

```javascript
{
  version: 27,
  name: 'add_debug_enabled',
  sql: 'ALTER TABLE routes ADD COLUMN debug_enabled INTEGER DEFAULT 0;',
  detect: (db) => hasColumn(db, 'routes', 'debug_enabled'),
},
```

- [ ] **Step 2: Restart container and verify migration runs**

Run: `docker compose down && docker compose up -d && sleep 5 && docker logs gatecontrol 2>&1 | grep -i "migration\|debug_enabled"`
Expected: Migration 27 applied successfully.

- [ ] **Step 3: Commit**

```bash
git add src/db/migrations.js
git commit -m "feat: add debug_enabled column (migration 27)"
```

---

### Task 3: License feature key

**Files:**
- Modify: `src/services/license.js:15-39` (COMMUNITY_FALLBACK)

- [ ] **Step 1: Add request_debugging to COMMUNITY_FALLBACK**

After `webhooks: false,` (line 38), add `request_debugging: false,`:

```javascript
  webhooks: false,
  request_debugging: false,
};
```

- [ ] **Step 2: Commit**

```bash
git add src/services/license.js
git commit -m "feat: add request_debugging license feature key"
```

---

### Task 4: i18n keys

**Files:**
- Modify: `src/i18n/en.json`
- Modify: `src/i18n/de.json`

- [ ] **Step 1: Add English keys**

Add the following keys to `en.json` (in alphabetical position among existing keys):

```json
"debug.title": "Request Tracing",
"debug.toggle_desc": "Log detailed request/response information for debugging",
"debug.tab": "Debug",
"debug.no_entries": "No trace entries yet. Send a request to this route to see results.",
"debug.auto_refresh": "Auto-refresh",
"debug.clear": "Clear",
"debug.badge": "Debug",
"debug.method": "Method",
"debug.status": "Status",
"debug.latency": "Latency",
"debug.remote_ip": "Remote IP",
```

- [ ] **Step 2: Add German keys**

Add to `de.json`:

```json
"debug.title": "Request-Tracing",
"debug.toggle_desc": "Detaillierte Request/Response-Informationen für Debugging loggen",
"debug.tab": "Debug",
"debug.no_entries": "Noch keine Trace-Einträge. Sende einen Request an diese Route.",
"debug.auto_refresh": "Auto-Aktualisierung",
"debug.clear": "Leeren",
"debug.badge": "Debug",
"debug.method": "Methode",
"debug.status": "Status",
"debug.latency": "Latenz",
"debug.remote_ip": "Remote-IP",
```

- [ ] **Step 3: Commit**

```bash
git add src/i18n/en.json src/i18n/de.json
git commit -m "feat: add i18n keys for request tracing (EN + DE)"
```

---

### Task 5: Route service — trace handler + trace logger in Caddy config

**Files:**
- Modify: `src/services/routes.js`

- [ ] **Step 1: Add trace handler to routeHandlers (non-auth routes)**

In `buildCaddyConfig`, after `routeHandlers` is initialized (around line 226) and before the first handler push, add the trace handler insertion. Insert **before** the custom headers block (line 229):

```javascript
// Request tracing — must be first handler to capture full lifecycle
if (route.debug_enabled) {
  routeHandlers.push({
    handler: 'trace',
    tag: `route-${route.id}`,
    response_debug: true,
  });
}
```

Note: Even though we push (not unshift), this runs before other handlers because it's the first push. All subsequent features push after it.

- [ ] **Step 2: Add trace handler to authHandlers (auth-protected routes)**

In the auth route handler chain (around line 375, inside the `if (route.route_auth_enabled)` block), add trace as the first handler pushed to `authHandlers`, before the forward_auth subrequest handler:

```javascript
// Request tracing for auth routes
if (route.debug_enabled) {
  authHandlers.unshift({
    handler: 'trace',
    tag: `route-${route.id}`,
    response_debug: true,
  });
}
```

- [ ] **Step 3: Add trace logger to Caddy logging config**

In the `logging.logs` section of `buildCaddyConfig` (around line 433-446), conditionally add a trace logger if any route has debug enabled:

```javascript
// Check if any route has debug enabled
const hasDebugRoutes = routes.some(r => r.debug_enabled);

// Build logging config
const loggingConfig = {
  logs: {
    access: {
      writer: {
        output: 'file',
        filename: '/data/caddy/access.log',
        roll_size_mb: 10,
        roll_keep: 3,
      },
      encoder: { format: 'json' },
      include: ['http.log.access'],
    },
  },
};

if (hasDebugRoutes) {
  loggingConfig.logs.trace = {
    writer: {
      output: 'file',
      filename: '/data/caddy/trace.log',
      roll_size_mb: 5,
      roll_keep: 2,
    },
    encoder: { format: 'json' },
    level: 'DEBUG',
    include: ['http.handlers.trace'],
  };
}
```

Replace the existing hardcoded `logging:` block with this dynamic version.

- [ ] **Step 4: Add debug_enabled to CREATE function**

In the `create` function, add `debug_enabled` to:
1. The destructuring of `data` parameter (alongside `mirror_enabled`)
2. The INSERT column list
3. The VALUES placeholder list
4. The values array (as `data.debug_enabled ? 1 : 0`)

Follow the exact same pattern as `mirror_enabled`.

- [ ] **Step 5: Add debug_enabled to UPDATE function**

In the `update` function, add `debug_enabled` to:
1. The SET clause: `debug_enabled = COALESCE(?, debug_enabled),`
2. The values array: `data.debug_enabled !== undefined ? (data.debug_enabled ? 1 : 0) : null,`

Follow the exact same pattern as other toggle fields.

- [ ] **Step 6: Commit**

```bash
git add src/services/routes.js
git commit -m "feat: integrate caddy-trace handler and logging in route service"
```

---

### Task 6: API routes — feature guard + trace endpoint

**Files:**
- Modify: `src/routes/api/routes.js`

- [ ] **Step 1: Add requireFeatureField guard to POST**

After the existing `requireFeatureField` calls (around line 223), add:

```javascript
requireFeatureField('debug_enabled', 'request_debugging'),
```

- [ ] **Step 2: Add requireFeatureField guard to PUT**

After the existing `requireFeatureField` calls in the PUT middleware chain (around line 332), add:

```javascript
requireFeatureField('debug_enabled', 'request_debugging'),
```

- [ ] **Step 3: Add debug_enabled to POST destructuring**

In the POST handler destructuring (around line 236), add `debug_enabled` after `mirror_targets`:

```javascript
  mirror_enabled, mirror_targets, debug_enabled } = req.body;
```

- [ ] **Step 4: Add debug_enabled to routes.create() call**

In the `routes.create()` call (around line 305), add `debug_enabled` after `mirror_targets`:

```javascript
  mirror_enabled, mirror_targets,
  debug_enabled,
});
```

- [ ] **Step 5: Add debug_enabled to PUT destructuring**

In the PUT handler destructuring (around line 345), add `debug_enabled` after `mirror_targets`:

```javascript
  mirror_enabled, mirror_targets, debug_enabled } = req.body;
```

- [ ] **Step 6: Add debug_enabled to routes.update() call**

Pass `debug_enabled` to `routes.update()` alongside the other fields.

- [ ] **Step 7: Add GET /:id/trace endpoint**

Add a new endpoint after the existing route endpoints. This reads and parses `/data/caddy/trace.log`:

```javascript
// GET /routes/:id/trace — read trace log entries for a route
router.get('/:id/trace', asyncHandler(async (req, res) => {
  const routeId = req.params.id;
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const since = parseFloat(req.query.since) || 0;
  const logPath = '/data/caddy/trace.log';

  const entries = [];
  try {
    const fs = require('fs');
    if (!fs.existsSync(logPath)) {
      return res.json({ ok: true, data: { entries: [] } });
    }
    const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean);

    for (let i = lines.length - 1; i >= 0 && entries.length < limit; i--) {
      try {
        const parsed = JSON.parse(lines[i]);
        if (parsed.tag !== `route-${routeId}`) continue;
        const ts = parsed.ts || 0;
        if (since > 0 && ts <= since) continue;
        entries.push({
          timestamp: new Date(ts * 1000).toISOString(),
          ts,
          method: parsed.request_method || parsed.method || '',
          uri: parsed.request_uri || parsed.uri || '',
          status: parsed.status || 0,
          latency_ms: parsed.latency ? Math.round(parsed.latency * 1000) : 0,
          remote_ip: parsed.remote_addr || parsed.remote_ip || '',
          host: parsed.request_host || parsed.host || '',
          user_agent: parsed.user_agent || '',
        });
      } catch { /* skip unparseable lines */ }
    }
  } catch { /* log file not readable */ }

  res.json({ ok: true, data: { entries } });
}));
```

**Important:** The field names in the parsed JSON (`request_method`, `request_uri`, `remote_addr`, etc.) must be verified against actual caddy-trace output during testing. The implementation above covers the most likely field names based on the plugin's Zap logger output. Adjust field mappings if caddy-trace uses different names.

- [ ] **Step 8: Commit**

```bash
git add src/routes/api/routes.js
git commit -m "feat: add debug_enabled API guards and trace log endpoint"
```

---

### Task 7: Backup/Restore — add debug_enabled + fix mirror gap

**Files:**
- Modify: `src/services/backup.js`

- [ ] **Step 1: Add missing mirror fields + debug_enabled to export**

In the export map (around line 88, after `circuit_breaker_timeout`), add:

```javascript
  mirror_enabled: r.mirror_enabled || 0,
  mirror_targets: r.mirror_targets || null,
  debug_enabled: r.debug_enabled || 0,
```

- [ ] **Step 2: Add fields to restore INSERT**

In the `insertRoute` prepared statement (around line 313-325), add `mirror_enabled`, `mirror_targets`, and `debug_enabled` to both the column list and VALUES placeholders. Add corresponding values in the `.run()` call:

```javascript
r.mirror_enabled ? 1 : 0,
r.mirror_targets || null,
r.debug_enabled ? 1 : 0,
```

- [ ] **Step 3: Commit**

```bash
git add src/services/backup.js
git commit -m "fix: add mirror + debug fields to backup/restore"
```

---

### Task 8: Create-Route template — debug toggle

**Files:**
- Modify: `templates/default/pages/routes.njk` (after mirror section, before save button)

- [ ] **Step 1: Add debug toggle after mirror section**

After the mirror `{% endif %}` (around line 448) and before the save button (line 449), add:

```nunjucks
        {% if license.features.request_debugging %}
        <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:var(--bg-base);border:1px solid var(--border);border-radius:var(--radius-sm);margin-bottom:14px">
          <div>
            <div style="font-size:13px;font-weight:600">{{ t('debug.title') }}</div>
            <div style="font-size:11px;color:var(--text-2);margin-top:2px">{{ t('debug.toggle_desc') }}</div>
          </div>
          <div class="toggle" id="create-route-debug"></div>
        </div>
        {% else %}
        <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:var(--bg-base);border:1px solid var(--border);border-radius:var(--radius-sm);margin-bottom:14px" class="feature-locked" title="{{ t('license.requires_pro') }}">
          <div>
            <div style="font-size:13px;font-weight:600">{{ t('debug.title') }} <span class="lock-icon"></span></div>
            <div style="font-size:11px;color:var(--text-2);margin-top:2px">{{ t('debug.toggle_desc') }}</div>
          </div>
          <div class="toggle" id="create-route-debug"></div>
        </div>
        {% endif %}
```

- [ ] **Step 2: Commit**

```bash
git add templates/default/pages/routes.njk
git commit -m "feat: add debug toggle to create-route card"
```

---

### Task 9: Edit-Route modal — Debug tab

**Files:**
- Modify: `templates/default/partials/modals/route-edit.njk`

- [ ] **Step 1: Add Debug tab button**

In the tabs section (around line 16, after the branding tab button), add:

```html
<button class="tab" data-edit-tab="debug">{{ t('debug.tab') }}</button>
```

- [ ] **Step 2: Add Debug tab panel**

After the closing `</div>` of the branding panel and before the modal footer, add the debug panel:

```nunjucks
      {# ═══ TAB: Debug ═══════════════════════════════ #}
      <div class="edit-route-panel" data-panel="debug" style="display:none">
        {% if license.features.request_debugging %}
        <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:var(--bg-base);border:1px solid var(--border);border-radius:var(--radius-sm);margin-bottom:14px">
          <div>
            <div style="font-size:13px;font-weight:600">{{ t('debug.title') }}</div>
            <div style="font-size:11px;color:var(--text-2);margin-top:2px">{{ t('debug.toggle_desc') }}</div>
          </div>
          <div class="toggle" id="edit-route-debug"></div>
        </div>
        <div id="edit-debug-container" style="display:none">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
            <div style="font-size:11px;color:var(--text-3);font-family:var(--font-mono)">{{ t('debug.auto_refresh') }}</div>
            <button type="button" class="btn btn-ghost" id="edit-debug-clear" style="font-size:11px;padding:4px 8px">{{ t('debug.clear') }}</button>
          </div>
          <div id="edit-debug-log" style="max-height:400px;overflow-y:auto;background:var(--bg-base);border:1px solid var(--border);border-radius:var(--radius-sm);padding:8px;font-family:var(--font-mono);font-size:11px">
            <div id="edit-debug-empty" style="color:var(--text-3);text-align:center;padding:20px 0">{{ t('debug.no_entries') }}</div>
          </div>
        </div>
        {% else %}
        <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:var(--bg-base);border:1px solid var(--border);border-radius:var(--radius-sm);margin-bottom:14px" class="feature-locked" title="{{ t('license.requires_pro') }}">
          <div>
            <div style="font-size:13px;font-weight:600">{{ t('debug.title') }} <span class="lock-icon"></span></div>
            <div style="font-size:11px;color:var(--text-2);margin-top:2px">{{ t('debug.toggle_desc') }}</div>
          </div>
          <div class="toggle" id="edit-route-debug"></div>
        </div>
        {% endif %}
      </div>
```

- [ ] **Step 3: Commit**

```bash
git add templates/default/partials/modals/route-edit.njk
git commit -m "feat: add Debug tab to edit-route modal"
```

---

### Task 10: JavaScript — toggle logic, badge, polling, trace rendering

**Files:**
- Modify: `public/js/routes.js`

- [ ] **Step 1: Add debug badge to route list rendering**

After the circuit breaker badge block (around line 135), add:

```javascript
let debugTag = '';
if (r.debug_enabled && r.route_type !== 'l4') {
  debugTag = '<span class="tag tag-orange" style="margin-left:4px">' + escapeHtml(GC.t['debug.badge'] || 'Debug') + '</span>';
}
```

Then include `debugTag` in the tags output alongside the other badges.

- [ ] **Step 2: Add debug toggle state to create form submission**

After the `createCb` line (around line 307), add:

```javascript
const createDebug = document.getElementById('create-route-debug')?.classList.contains('on') || false;
```

Then add `debug_enabled: createDebug,` to the create payload object.

- [ ] **Step 3: Add debug toggle state to edit form submission**

In the edit form submission handler, read the toggle state:

```javascript
const debugEnabled = document.getElementById('edit-route-debug')?.classList.contains('on') || false;
```

Add `debug_enabled: debugEnabled,` to the edit payload.

- [ ] **Step 4: Populate debug toggle in edit modal**

In the `openEditModal` function (where other toggles are populated), add:

```javascript
// Debug toggle
var debugToggle = document.getElementById('edit-route-debug');
var debugContainer = document.getElementById('edit-debug-container');
if (debugToggle) {
  if (route.debug_enabled) debugToggle.classList.add('on'); else debugToggle.classList.remove('on');
  debugToggle.setAttribute('aria-checked', route.debug_enabled ? 'true' : 'false');
  if (debugContainer) debugContainer.style.display = route.debug_enabled ? '' : 'none';
}
```

- [ ] **Step 5: Add debug toggle click listener (create form)**

```javascript
var createDebugToggle = document.getElementById('create-route-debug');
if (createDebugToggle) createDebugToggle.classList.remove('on');
```

- [ ] **Step 6: Add debug toggle click listener (edit form) with container show/hide**

```javascript
var editDebugToggle = document.getElementById('edit-route-debug');
var editDebugContainer = document.getElementById('edit-debug-container');
if (editDebugToggle && editDebugContainer) {
  editDebugToggle.addEventListener('click', function() {
    setTimeout(function() {
      editDebugContainer.style.display = editDebugToggle.classList.contains('on') ? '' : 'none';
    }, 0);
  });
}
```

- [ ] **Step 7: Implement trace log polling and rendering**

Add a polling system for the Debug tab. Use safe DOM construction methods — build each trace entry using `document.createElement` and `textContent` (not innerHTML) to prevent XSS:

```javascript
var traceInterval = null;
var lastTraceTs = 0;

function startTracePolling(routeId) {
  stopTracePolling();
  lastTraceTs = 0;
  fetchTraceEntries(routeId);
  traceInterval = setInterval(function() { fetchTraceEntries(routeId); }, 3000);
}

function stopTracePolling() {
  if (traceInterval) { clearInterval(traceInterval); traceInterval = null; }
}

function fetchTraceEntries(routeId) {
  var url = '/api/v1/routes/' + routeId + '/trace?limit=50';
  if (lastTraceTs > 0) url += '&since=' + lastTraceTs;
  window.api.get(url).then(function(res) {
    if (res.ok && res.data && res.data.entries) {
      renderTraceEntries(res.data.entries);
    }
  }).catch(function() {});
}

function renderTraceEntries(entries) {
  var log = document.getElementById('edit-debug-log');
  var empty = document.getElementById('edit-debug-empty');
  if (!log) return;
  if (entries.length === 0 && !log.querySelector('.trace-entry')) return;
  if (empty) empty.style.display = entries.length > 0 || log.querySelector('.trace-entry') ? 'none' : '';

  entries.forEach(function(e) {
    if (e.ts > lastTraceTs) lastTraceTs = e.ts;
    var statusColor = e.status >= 500 ? 'var(--red, #f87171)' : e.status >= 400 ? 'var(--yellow, #facc15)' : 'var(--green, #4ade80)';

    var div = document.createElement('div');
    div.className = 'trace-entry';
    div.style.cssText = 'display:flex;gap:8px;padding:4px 0;border-bottom:1px solid var(--border);align-items:center;font-size:11px';

    var tsSpan = document.createElement('span');
    tsSpan.style.cssText = 'color:var(--text-3);min-width:70px';
    tsSpan.textContent = (e.timestamp.split('T')[1] || '').split('.')[0] || '';

    var methodSpan = document.createElement('span');
    methodSpan.style.cssText = 'font-weight:600;min-width:40px';
    methodSpan.textContent = e.method;

    var uriSpan = document.createElement('span');
    uriSpan.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    uriSpan.textContent = e.uri;

    var statusSpan = document.createElement('span');
    statusSpan.style.cssText = 'color:' + statusColor + ';font-weight:600;min-width:30px';
    statusSpan.textContent = e.status;

    var latencySpan = document.createElement('span');
    latencySpan.style.cssText = 'color:var(--text-3);min-width:50px';
    latencySpan.textContent = (e.latency_ms || 0) + 'ms';

    var ipSpan = document.createElement('span');
    ipSpan.style.cssText = 'color:var(--text-3);min-width:80px';
    ipSpan.textContent = e.remote_ip;

    div.appendChild(tsSpan);
    div.appendChild(methodSpan);
    div.appendChild(uriSpan);
    div.appendChild(statusSpan);
    div.appendChild(latencySpan);
    div.appendChild(ipSpan);

    log.insertBefore(div, log.firstChild);
  });
}

// Clear button
var debugClear = document.getElementById('edit-debug-clear');
if (debugClear) {
  debugClear.addEventListener('click', function() {
    var log = document.getElementById('edit-debug-log');
    if (log) {
      log.querySelectorAll('.trace-entry').forEach(function(el) { el.remove(); });
      var empty = document.getElementById('edit-debug-empty');
      if (empty) empty.style.display = '';
    }
    lastTraceTs = 0;
  });
}
```

- [ ] **Step 8: Start/stop polling when Debug tab is shown/hidden**

Hook into the edit modal tab switching to start polling when the debug tab is active, and stop when switching away or closing the modal. In the existing tab switch logic, add:

```javascript
// When debug tab is activated:
if (tabName === 'debug' && currentEditRouteId) {
  startTracePolling(currentEditRouteId);
} else {
  stopTracePolling();
}
```

Also stop polling when the modal is closed (in the existing modal close handler):

```javascript
stopTracePolling();
```

- [ ] **Step 9: Hide Debug tab for L4 routes**

In the edit modal opening logic, hide the Debug tab button for L4 routes:

```javascript
var debugTab = document.querySelector('[data-edit-tab="debug"]');
if (debugTab) debugTab.style.display = (route.route_type === 'l4') ? 'none' : '';
```

- [ ] **Step 10: Commit**

```bash
git add public/js/routes.js
git commit -m "feat: add debug toggle, badge, and trace log polling UI"
```

---

### Task 11: Build, deploy, and verify

- [ ] **Step 1: Build container**

Run: `docker compose build --no-cache 2>&1 | tail -5`
Expected: Build succeeds.

- [ ] **Step 2: Deploy container**

Run: `docker compose down && docker compose up -d`

- [ ] **Step 3: Verify caddy-trace module loaded**

Run: `docker exec gatecontrol caddy list-modules 2>&1 | grep trace`
Expected: `http.handlers.trace`

- [ ] **Step 4: Verify migration applied**

Run: `docker logs gatecontrol 2>&1 | grep -i "migration\|debug"`

- [ ] **Step 5: Export image**

Run: `docker save gatecontrol:latest | gzip > gatecontrol-image.tar.gz`

- [ ] **Step 6: Test in browser**

1. Open Routes page — verify debug toggle appears in "Neue Route anlegen" card
2. Enable debug on an existing route via edit modal → Debug tab
3. Send a request to the route
4. Verify trace entries appear in the Debug tab with auto-refresh
5. Verify orange "Debug" badge appears in route list
6. Verify Debug tab is hidden for L4 routes

- [ ] **Step 7: Verify trace log file**

Run: `docker exec gatecontrol ls -la /data/caddy/trace.log`
Expected: File exists with trace entries.

Run: `docker exec gatecontrol cat /data/caddy/trace.log | head -3`
Expected: JSON lines with `tag` field matching `route-{id}`.

**Important:** Check the actual field names in the trace log output. If they differ from the expected names (`request_method`, `request_uri`, etc.), update the field mappings in `src/routes/api/routes.js` GET /:id/trace endpoint accordingly.

- [ ] **Step 8: Commit and push**

```bash
git add -A
git commit -m "feat: request tracing (caddy-trace) integration complete"
git push
```
