# Request Mirroring Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add request mirroring to HTTP routes — duplicate requests asynchronously to configurable mirror targets via a custom Caddy Go module.

**Architecture:** A new Caddy HTTP handler module (`caddy-mirror`) buffers the request body and fires goroutines to each mirror target, then immediately passes the request to the next handler. The module is built into the custom Caddy binary via xcaddy. GateControl's Node.js layer handles DB storage, API, and UI.

**Tech Stack:** Go (Caddy module), Node.js/Express (API), SQLite (DB), Nunjucks (templates), Vanilla JS (frontend)

**Spec:** `docs/superpowers/specs/2026-03-23-request-mirroring-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `caddy-plugins/mirror/go.mod` | CREATE | Go module definition |
| `caddy-plugins/mirror/mirror.go` | CREATE | Caddy HTTP handler — buffer body, sync.Pool, fan-out goroutines |
| `caddy-plugins/mirror/mirror_test.go` | CREATE | Go unit tests — mock HTTP server, verify mirrored requests |
| `Dockerfile` | MODIFY (line 3-5) | Add mirror module to xcaddy build, COPY plugin source |
| `src/db/migrations.js` | MODIFY (line 444) | Migration 26: `mirror_enabled`, `mirror_targets` columns |
| `src/services/routes.js` | MODIFY (lines 204-214, 340-344) | Mirror handler in both handler chains |
| `src/routes/api/routes.js` | MODIFY (lines 205-247, 268-311) | Accept mirror fields in create/update |
| `public/js/routes.js` | MODIFY | Mirror toggle + target editor in edit modal, badge in list |
| `templates/default/pages/routes.njk` | MODIFY | Mirror UI section in route form |
| `src/i18n/en.json` | MODIFY | English mirror keys |
| `src/i18n/de.json` | MODIFY | German mirror keys |
| `scripts/api-test.sh` | MODIFY | Mirror API tests |

---

## Chunk 1: Caddy Go Module

### Task 1: Create Go module scaffold

**Files:**
- Create: `caddy-plugins/mirror/go.mod`
- Create: `caddy-plugins/mirror/mirror.go`

- [ ] **Step 1: Create go.mod**

```
caddy-plugins/mirror/go.mod
```

```go
module github.com/custom/caddy-mirror

go 1.22

require (
	github.com/caddyserver/caddy/v2 v2.9.1
	go.uber.org/zap v1.27.0
)
```

Run: `cd /root/gatecontrol && mkdir -p caddy-plugins/mirror`

- [ ] **Step 2: Write mirror.go**

```
caddy-plugins/mirror/mirror.go
```

The module must:
- Register as `http.handlers.mirror`
- Accept config: `Targets []MirrorTarget` where `MirrorTarget` has `Dial string`
- In `ServeHTTP`: read body (max 10MB), for each target spawn goroutine that sends HTTP request copy with 10s timeout, then call `next.ServeHTTP(w, r)` immediately
- Skip WebSocket requests (`Connection: Upgrade` header)
- Log errors at WARN level, never affect client response

```go
package mirror

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/caddyserver/caddy/v2"
	"github.com/caddyserver/caddy/v2/modules/caddyhttp"
	"go.uber.org/zap"
)

func init() {
	caddy.RegisterModule(Mirror{})
}

var bufPool = sync.Pool{
	New: func() any { return new(bytes.Buffer) },
}

// Mirror implements an HTTP handler that mirrors requests to secondary targets.
type Mirror struct {
	Targets      []MirrorTarget `json:"targets,omitempty"`
	MaxBodyBytes int64          `json:"max_body_bytes,omitempty"`
	logger       *zap.Logger
	client       *http.Client
}

// MirrorTarget is one mirror destination.
type MirrorTarget struct {
	Dial string `json:"dial,omitempty"`
}

func (Mirror) CaddyModule() caddy.ModuleInfo {
	return caddy.ModuleInfo{
		ID:  "http.handlers.mirror",
		New: func() caddy.Module { return new(Mirror) },
	}
}

func (m *Mirror) Provision(ctx caddy.Context) error {
	m.logger = ctx.Logger()
	if m.MaxBodyBytes <= 0 {
		m.MaxBodyBytes = 10 << 20 // 10 MB
	}
	m.client = &http.Client{Timeout: 10 * time.Second}
	return nil
}

func (m *Mirror) Validate() error {
	return nil
}

func (m Mirror) ServeHTTP(w http.ResponseWriter, r *http.Request, next caddyhttp.Handler) error {
	// Skip WebSocket upgrades (Connection header may contain multiple values)
	if strings.Contains(strings.ToLower(r.Header.Get("Connection")), "upgrade") {
		return next.ServeHTTP(w, r)
	}

	// Buffer body using sync.Pool
	var bodyBytes []byte
	if r.Body != nil && r.ContentLength != 0 {
		buf := bufPool.Get().(*bytes.Buffer)
		buf.Reset()
		_, err := io.Copy(buf, io.LimitReader(r.Body, m.MaxBodyBytes+1))
		if err != nil {
			m.logger.Warn("failed to read request body for mirroring", zap.Error(err))
			r.Body = io.NopCloser(buf)
			m.fireTargets(r, nil)
			bufPool.Put(buf)
			return next.ServeHTTP(w, r)
		}
		if int64(buf.Len()) > m.MaxBodyBytes {
			m.logger.Info("request body exceeds mirror max size, mirroring without body",
				zap.Int64("size", int64(buf.Len())),
				zap.Int64("max", m.MaxBodyBytes))
			r.Body = io.NopCloser(bytes.NewReader(buf.Bytes()))
			m.fireTargets(r, nil)
			bufPool.Put(buf)
			return next.ServeHTTP(w, r)
		}
		bodyBytes = make([]byte, buf.Len())
		copy(bodyBytes, buf.Bytes())
		r.Body = io.NopCloser(bytes.NewReader(bodyBytes))
		bufPool.Put(buf)
	}

	m.fireTargets(r, bodyBytes)
	return next.ServeHTTP(w, r)
}

func (m *Mirror) fireTargets(r *http.Request, body []byte) {
	for _, t := range m.Targets {
		target := t // capture
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()

			url := "http://" + target.Dial + r.RequestURI

			var bodyReader io.Reader
			if body != nil {
				bodyReader = bytes.NewReader(body)
			}

			req, err := http.NewRequestWithContext(ctx, r.Method, url, bodyReader)
			if err != nil {
				m.logger.Warn("mirror: failed to create request", zap.String("target", target.Dial), zap.Error(err))
				return
			}
			for k, vv := range r.Header {
				for _, v := range vv {
					req.Header.Add(k, v)
				}
			}
			req.Host = r.Host

			resp, err := m.client.Do(req)
			if err != nil {
				m.logger.Warn("mirror: request failed", zap.String("target", target.Dial), zap.Error(err))
				return
			}
			io.Copy(io.Discard, resp.Body)
			resp.Body.Close()
		}()
	}
}

// Interface guards
var (
	_ caddy.Module                = (*Mirror)(nil)
	_ caddy.Provisioner           = (*Mirror)(nil)
	_ caddy.Validator             = (*Mirror)(nil)
	_ caddyhttp.MiddlewareHandler = (*Mirror)(nil)
)
```

- [ ] **Step 3: Write mirror_test.go**

```
caddy-plugins/mirror/mirror_test.go
```

```go
package mirror

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/caddyserver/caddy/v2/modules/caddyhttp"
	"go.uber.org/zap"
)

func TestMirrorForwardsToTargets(t *testing.T) {
	var received atomic.Int32
	mirrorSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		received.Add(1)
		body, _ := io.ReadAll(r.Body)
		if string(body) != "hello" {
			t.Errorf("expected body 'hello', got '%s'", body)
		}
		w.WriteHeader(200)
	}))
	defer mirrorSrv.Close()

	addr := strings.TrimPrefix(mirrorSrv.URL, "http://")
	m := &Mirror{
		Targets:      []MirrorTarget{{Dial: addr}},
		MaxBodyBytes: 10 << 20,
		logger:       zap.NewNop(),
		client:       &http.Client{Timeout: 5 * time.Second},
	}

	req := httptest.NewRequest("POST", "/test", strings.NewReader("hello"))
	req.Header.Set("Content-Type", "text/plain")
	w := httptest.NewRecorder()

	next := caddyhttp.HandlerFunc(func(w http.ResponseWriter, r *http.Request) error {
		w.WriteHeader(200)
		return nil
	})

	err := m.ServeHTTP(w, req, next)
	if err != nil {
		t.Fatal(err)
	}
	if w.Code != 200 {
		t.Errorf("expected 200, got %d", w.Code)
	}

	// Wait for goroutine
	time.Sleep(100 * time.Millisecond)
	if received.Load() != 1 {
		t.Errorf("expected 1 mirror request, got %d", received.Load())
	}
}

func TestMirrorSkipsWebSocket(t *testing.T) {
	var received atomic.Int32
	mirrorSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		received.Add(1)
		w.WriteHeader(200)
	}))
	defer mirrorSrv.Close()

	addr := strings.TrimPrefix(mirrorSrv.URL, "http://")
	m := &Mirror{
		Targets:      []MirrorTarget{{Dial: addr}},
		MaxBodyBytes: 10 << 20,
		logger:       zap.NewNop(),
		client:       &http.Client{Timeout: 5 * time.Second},
	}

	req := httptest.NewRequest("GET", "/ws", nil)
	req.Header.Set("Connection", "Upgrade")
	req.Header.Set("Upgrade", "websocket")
	w := httptest.NewRecorder()

	next := caddyhttp.HandlerFunc(func(w http.ResponseWriter, r *http.Request) error {
		w.WriteHeader(200)
		return nil
	})

	m.ServeHTTP(w, req, next)
	time.Sleep(100 * time.Millisecond)
	if received.Load() != 0 {
		t.Errorf("expected 0 mirror requests for WebSocket, got %d", received.Load())
	}
}
```

- [ ] **Step 4: Commit Go module**

```bash
git add caddy-plugins/
git commit -m "feat: caddy-mirror Go module — async request mirroring handler with tests"
```

### Task 2: Update Dockerfile

**Files:**
- Modify: `Dockerfile` (lines 1-5)

- [ ] **Step 1: Add COPY and --with for mirror plugin**

Current Dockerfile lines 1-5:
```dockerfile
# Stage 1: Caddy with L4 plugin
FROM caddy:2-builder AS caddy-builder
RUN xcaddy build \
    --with github.com/mholt/caddy-l4 \
    --with github.com/mholt/caddy-ratelimit
```

Change to:
```dockerfile
# Stage 1: Caddy with L4 + ratelimit + mirror plugins
FROM caddy:2-builder AS caddy-builder
COPY caddy-plugins/mirror /tmp/caddy-mirror
RUN cd /tmp/caddy-mirror && go mod tidy && cd / && \
    xcaddy build \
    --with github.com/mholt/caddy-l4 \
    --with github.com/mholt/caddy-ratelimit \
    --with github.com/custom/caddy-mirror=/tmp/caddy-mirror
```

- [ ] **Step 2: Commit Dockerfile**

```bash
git add Dockerfile
git commit -m "build: add caddy-mirror plugin to Dockerfile xcaddy build"
```

---

## Chunk 2: Database + Backend

### Task 3: Add Migration 26

**Files:**
- Modify: `src/db/migrations.js` (insert before closing `];` at line 444)

- [ ] **Step 1: Add migration 26 to the migrations array**

Insert before the closing `];` at line 444:

```javascript
  {
    version: 26,
    name: 'add_mirror_columns',
    sql: `
      ALTER TABLE routes ADD COLUMN mirror_enabled INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE routes ADD COLUMN mirror_targets TEXT;
    `,
    detect: (db) => hasColumn(db, 'routes', 'mirror_enabled'),
  },
```

- [ ] **Step 2: Commit migration**

```bash
git add src/db/migrations.js
git commit -m "db: migration 26 — mirror_enabled + mirror_targets columns"
```

### Task 4: Add mirror handler to Caddy config generation

**Files:**
- Modify: `src/services/routes.js` (two locations: ~line 204 and ~line 341)

- [ ] **Step 1: Parse mirror_targets after custom headers parsing (after line 101)**

Add after the `customHeaders` parsing block (after line 101):

```javascript
    // Parse mirror targets
    let mirrorTargets = null;
    if (route.mirror_enabled && route.mirror_targets) {
      try { mirrorTargets = JSON.parse(route.mirror_targets); } catch {}
    }
```

- [ ] **Step 2: Insert mirror handler in standard routeHandlers (after rate limit, before compress — after line 204)**

Add after the rate limit block (line 204) and BEFORE the compress block (line 207):

```javascript
    // Request mirroring — must come before compress so targets get uncompressed requests
    if (mirrorTargets && Array.isArray(mirrorTargets) && mirrorTargets.length > 0) {
      routeHandlers.push({
        handler: 'mirror',
        targets: mirrorTargets.map(t => ({ dial: `${t.ip}:${t.port}` })),
      });
    }
```

- [ ] **Step 3: Insert mirror handler in authHandlers chain (after rate limit, before compress — after line 340)**

In the `authHandlers` block (around line 340), add after the rate limit push and BEFORE the compress check:

```javascript
      if (mirrorTargets && Array.isArray(mirrorTargets) && mirrorTargets.length > 0) {
        authHandlers.push({
          handler: 'mirror',
          targets: mirrorTargets.map(t => ({ dial: `${t.ip}:${t.port}` })),
        });
      }
```

- [ ] **Step 4: Commit config generation changes**

```bash
git add src/services/routes.js
git commit -m "feat: mirror handler in Caddy config generation (both handler chains)"
```

### Task 5: Add mirror fields to route API

**Files:**
- Modify: `src/routes/api/routes.js` (create ~line 207, update ~line 270)

- [ ] **Step 1: Add mirror_enabled and mirror_targets to destructured fields in create handler (~line 207)**

Add `mirror_enabled, mirror_targets` to the destructured `req.body` in the POST handler. Then pass them to `routes.create()`.

- [ ] **Step 2: Add mirror_enabled and mirror_targets to destructured fields in update handler (~line 270)**

Add `mirror_enabled, mirror_targets` to the destructured `req.body` in the PUT handler. Then pass them to `routes.update()`.

- [ ] **Step 3: Add server-side validation for mirror targets**

In both create and update handlers, after the existing field validation block, add:

```javascript
    // Validate mirror targets
    if (mirror_enabled && mirror_targets) {
      if (!Array.isArray(mirror_targets) || mirror_targets.length === 0) {
        return res.status(400).json({ ok: false, error: 'Mirror targets must be a non-empty array' });
      }
      if (mirror_targets.length > 5) {
        return res.status(400).json({ ok: false, error: req.t('routes.mirror_max') || 'Maximum 5 mirror targets' });
      }
      for (const t of mirror_targets) {
        const ipErr = validateIp(t.ip);
        if (ipErr) return res.status(400).json({ ok: false, error: 'Mirror target: ' + ipErr });
        const pErr = validatePort(t.port);
        if (pErr) return res.status(400).json({ ok: false, error: 'Mirror target: ' + pErr });
      }
      if (route_type === 'l4') {
        return res.status(400).json({ ok: false, error: 'Mirror is not available for L4 routes' });
      }
    }
```

- [ ] **Step 4: Commit API changes**

```bash
git add src/routes/api/routes.js
git commit -m "feat: accept mirror_enabled + mirror_targets in route API"
```

### Task 6: Add mirror fields to route service create/update

**Files:**
- Modify: `src/services/routes.js` (create ~line 614, update ~line 822)

- [ ] **Step 1: Serialize mirror_targets in create() (after line 616)**

Add after the `backendsJson` serialization:

```javascript
  // Validate and serialize mirror_targets
  const mirrorTargetsJson = data.mirror_targets
    ? (typeof data.mirror_targets === 'string' ? data.mirror_targets : JSON.stringify(data.mirror_targets))
    : null;
```

- [ ] **Step 2: Add mirror columns to INSERT INTO routes (line 618-628)**

Add `mirror_enabled, mirror_targets` to the column list and values in the INSERT statement. Values:

```javascript
    data.mirror_enabled ? 1 : 0,
    mirrorTargetsJson,
```

- [ ] **Step 3: Serialize mirror_targets in update() (after line 825)**

Add after the `updateBackends` serialization:

```javascript
  // Serialize mirror_targets for update
  const updateMirrorTargets = data.mirror_targets !== undefined
    ? (data.mirror_targets ? (typeof data.mirror_targets === 'string' ? data.mirror_targets : JSON.stringify(data.mirror_targets)) : null)
    : route.mirror_targets;
```

- [ ] **Step 4: Add mirror columns to UPDATE SET (after line 868)**

Add to the UPDATE statement:

```sql
      mirror_enabled = COALESCE(?, mirror_enabled),
      mirror_targets = ?,
```

And corresponding `.run()` values:

```javascript
    data.mirror_enabled !== undefined ? (data.mirror_enabled ? 1 : 0) : null,
    updateMirrorTargets,
```

- [ ] **Step 5: Add activity log for mirror changes**

In the update function, after the existing `route_updated` activity log (~line 965), add specific mirror logging when mirror settings change:

```javascript
  if (data.mirror_enabled !== undefined || data.mirror_targets !== undefined) {
    activity.log('route_mirror_changed', `Mirror config changed for "${route.domain}"`, {
      source: 'admin',
      severity: 'info',
      details: { routeId: id, mirror_enabled: data.mirror_enabled },
    });
  }
```

- [ ] **Step 6: Commit service changes**

```bash
git add src/services/routes.js
git commit -m "feat: mirror_enabled + mirror_targets in route create/update service"
```

---

## Chunk 3: Frontend + i18n

### Task 7: Add i18n keys

**Files:**
- Modify: `src/i18n/en.json`
- Modify: `src/i18n/de.json`

- [ ] **Step 1: Add English mirror keys**

Add to `en.json` near the existing route keys:

```json
  "routes.mirror": "Request Mirroring",
  "routes.mirror_desc": "Duplicate requests to secondary backends for testing",
  "routes.mirror_target_ip": "Target IP",
  "routes.mirror_target_port": "Target Port",
  "routes.mirror_add_target": "Add Target",
  "routes.mirror_badge": "Mirror: {{count}} targets",
  "routes.mirror_max": "Maximum 5 mirror targets",
  "routes.mirror_conflict": "Mirror target cannot be the same as the primary backend",
```

- [ ] **Step 2: Add German mirror keys**

Add to `de.json` near the existing route keys:

```json
  "routes.mirror": "Request Mirroring",
  "routes.mirror_desc": "Requests an sekundäre Backends duplizieren zum Testen",
  "routes.mirror_target_ip": "Ziel-IP",
  "routes.mirror_target_port": "Ziel-Port",
  "routes.mirror_add_target": "Ziel hinzufügen",
  "routes.mirror_badge": "Mirror: {{count}} Ziele",
  "routes.mirror_max": "Maximal 5 Mirror-Ziele",
  "routes.mirror_conflict": "Mirror-Ziel darf nicht dem primären Backend entsprechen",
```

- [ ] **Step 3: Commit i18n**

```bash
git add src/i18n/
git commit -m "i18n: mirror translation keys (EN + DE)"
```

### Task 8: Add mirror badge to route list

**Files:**
- Modify: `public/js/routes.js` (around lines 90-155, where other badges are built)

- [ ] **Step 1: Add mirrorTag variable after existing badges (~after line 145)**

Add after `headersTag` (around line 145), following the exact same pattern:

```javascript
      let mirrorTag = '';
      if (r.mirror_enabled && r.route_type !== 'l4') {
        try {
          var mt = typeof r.mirror_targets === 'string' ? JSON.parse(r.mirror_targets) : r.mirror_targets;
          if (Array.isArray(mt) && mt.length > 0) {
            mirrorTag = '<span class="tag tag-blue" style="margin-left:4px"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M16 3h5v5"/><path d="M21 3l-7 7"/><path d="M8 21H3v-5"/><path d="M3 21l7-7"/></svg> ' + (GC.t['routes.mirror_badge'] || 'Mirror: {{count}} targets').replace('{{count}}', mt.length) + '</span>';
          }
        } catch (_) {}
      }
```

- [ ] **Step 2: Add mirrorTag to the tag output string (~line 212)**

Add `${mirrorTag}` to the template literal that outputs all tags, after `${headersTag}`:

```javascript
${statusTag}${monitorTag}${cbTag}${aclTag}${ipFilterTag}${rateLimitTag}${retryTag}${backendsTag}${stickyTag}${httpsTag}${backendHttpsTag}${compressTag}${authTag}${routeAuthTags}${headersTag}${mirrorTag}${l4Tags}
```

- [ ] **Step 3: Commit badge**

```bash
git add public/js/routes.js
git commit -m "feat: mirror badge on route cards"
```

### Task 9: Add mirror toggle + target editor in route create form

**Files:**
- Modify: `templates/default/pages/routes.njk` (inside `#http-fields`, after circuit breaker section ~line 338)

- [ ] **Step 1: Add mirror toggle and target editor HTML**

Add after the circuit breaker fields section (after line 338), before the submit button:

```html
        <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:var(--bg-base);border:1px solid var(--border);border-radius:var(--radius-sm);margin-bottom:14px">
          <div>
            <div style="font-size:13px;font-weight:600">{{ t('routes.mirror') }}</div>
            <div style="font-size:11px;color:var(--text-2);margin-top:2px">{{ t('routes.mirror_desc') }}</div>
          </div>
          <div class="toggle" id="create-route-mirror"></div>
        </div>
        <div id="create-mirror-fields" style="display:none;margin-bottom:14px">
          <div id="create-mirror-targets-list" style="display:flex;flex-direction:column;gap:6px;margin-bottom:8px"></div>
          <button type="button" class="btn btn-ghost" id="create-mirror-add-target" style="font-size:12px">+ {{ t('routes.mirror_add_target') }}</button>
          <div id="create-mirror-max-hint" style="display:none;font-size:11px;color:var(--text-3);margin-top:4px">{{ t('routes.mirror_max') }}</div>
        </div>
```

- [ ] **Step 2: Commit template**

```bash
git add templates/default/pages/routes.njk
git commit -m "feat: mirror toggle + target editor in route create form"
```

### Task 10: Add mirror JS logic in routes.js

**Files:**
- Modify: `public/js/routes.js`

This is the largest frontend change. Add mirror target editor logic following the exact same pattern as the backends editor.

- [ ] **Step 1: Add mirror toggle handler for create form**

In the create form initialization section, add toggle handler for `#create-route-mirror` that shows/hides `#create-mirror-fields`. Follow the same pattern as `#create-route-rate-limit`.

- [ ] **Step 2: Add mirror targets list management for create form**

Add `createMirrorTargets` array and `renderCreateMirrorTargets()` function following the backends editor pattern. Each target row: IP input + Port input + delete button.

- [ ] **Step 3: Add mirror fields to create form submission**

In the route create POST payload, add:
```javascript
mirror_enabled: document.getElementById('create-route-mirror')?.classList.contains('on') ? 1 : 0,
mirror_targets: createMirrorTargets.length > 0 ? createMirrorTargets : null,
```

- [ ] **Step 4: Add mirror fields to edit modal load**

In the edit modal population section (~line 807), add:
```javascript
    // Mirror
    var mirrorToggle = document.getElementById('edit-route-mirror');
    if (mirrorToggle) {
      mirrorToggle.classList.toggle('on', !!route.mirror_enabled);
      mirrorToggle.setAttribute('aria-checked', route.mirror_enabled ? 'true' : 'false');
    }
    editMirrorTargets.length = 0;
    if (route.mirror_targets) {
      var parsedMt = typeof route.mirror_targets === 'string' ? JSON.parse(route.mirror_targets) : route.mirror_targets;
      if (Array.isArray(parsedMt)) parsedMt.forEach(t => editMirrorTargets.push(t));
    }
    renderEditMirrorTargets();
```

- [ ] **Step 5: Add mirror targets list management for edit modal**

Add `editMirrorTargets` array and `renderEditMirrorTargets()` function. Same pattern as backends editor but for mirror targets.

- [ ] **Step 6: Add mirror fields to edit form submission**

In the route update PUT payload, add:
```javascript
mirror_enabled: document.getElementById('edit-route-mirror')?.classList.contains('on') ? 1 : 0,
mirror_targets: editMirrorTargets.length > 0 ? editMirrorTargets : null,
```

- [ ] **Step 7: Add mirror toggle + target editor HTML in edit modal**

Add mirror section to `templates/default/partials/modals/route-edit.njk`, after circuit breaker section, same HTML pattern as create form but with `edit-` prefixed IDs.

- [ ] **Step 8: Add validation — no mirror target matches primary upstream**

In both create and update submission, before sending, check:
```javascript
var primaryIp = /* peer IP or target_ip */;
var primaryPort = /* target_port */;
var conflict = mirrorTargets.some(t => t.ip === primaryIp && String(t.port) === String(primaryPort));
if (conflict) { alert(GC.t['routes.mirror_conflict'] || 'Mirror target cannot match primary backend'); return; }
```

Add i18n key: `routes.mirror_conflict` → "Mirror target cannot be the same as the primary backend" / "Mirror-Ziel darf nicht dem primären Backend entsprechen"

- [ ] **Step 9: Commit frontend JS**

```bash
git add public/js/routes.js templates/
git commit -m "feat: mirror target editor in route create/edit modal"
```

---

## Chunk 4: Testing + Finalize

### Task 11: Add API tests

**Files:**
- Modify: `scripts/api-test.sh`

- [ ] **Step 1: Add mirror API tests**

Add a new test section after existing route tests:

```bash
# ─── Mirror ───────────────────────────────────────────────
echo "── Mirror tests"

# Enable mirror on existing route
MIRROR_RES=$(curl -s -X PUT "$BASE/api/v1/routes/$ROUTE_ID" \
  -H "Content-Type: application/json" \
  -H "Cookie: $COOKIE" \
  -H "X-CSRF-Token: $CSRF" \
  -d '{"mirror_enabled": true, "mirror_targets": [{"ip": "10.8.0.99", "port": 9999}]}')
assert_json_ok "$MIRROR_RES" "Enable mirror"

# Verify mirror fields returned
MIRROR_GET=$(curl -s "$BASE/api/v1/routes/$ROUTE_ID" -H "Cookie: $COOKIE")
assert_contains "$MIRROR_GET" "mirror_enabled" "Mirror fields in GET"

# Add multiple targets (up to 5)
MIRROR_MULTI=$(curl -s -X PUT "$BASE/api/v1/routes/$ROUTE_ID" \
  -H "Content-Type: application/json" \
  -H "Cookie: $COOKIE" \
  -H "X-CSRF-Token: $CSRF" \
  -d '{"mirror_targets": [{"ip":"10.8.0.99","port":9999},{"ip":"10.8.0.98","port":8888}]}')
assert_json_ok "$MIRROR_MULTI" "Multiple mirror targets"

# Disable mirror
MIRROR_OFF=$(curl -s -X PUT "$BASE/api/v1/routes/$ROUTE_ID" \
  -H "Content-Type: application/json" \
  -H "Cookie: $COOKIE" \
  -H "X-CSRF-Token: $CSRF" \
  -d '{"mirror_enabled": false, "mirror_targets": null}')
assert_json_ok "$MIRROR_OFF" "Disable mirror"
```

- [ ] **Step 2: Commit tests**

```bash
git add scripts/api-test.sh
git commit -m "test: mirror API tests in api-test.sh"
```

### Task 12: Build, deploy, push

- [ ] **Step 1: Build Docker image**

```bash
cd /root/gatecontrol && docker build -t gatecontrol . 2>&1 | tail -5
```

Expected: Build succeeds (Go module compiles, xcaddy includes mirror plugin)

- [ ] **Step 2: Save image + restart container**

```bash
docker save gatecontrol:latest | gzip > gatecontrol-image.tar.gz
docker stop gatecontrol && docker rm gatecontrol && docker compose up -d
```

- [ ] **Step 3: Verify container health**

```bash
sleep 10 && docker ps --filter "name=gatecontrol" --format "{{.Status}}"
```

Expected: `Up X seconds (healthy)`

- [ ] **Step 4: Push all commits**

```bash
git push
```

### Task 13: Update improvement list

- [ ] **Step 1: Mark #20 as completed in memory**

Update `/root/.claude/projects/-root/memory/project_improvements.md`:
Change `- [ ] 20.` to `- [x] 20.`

- [ ] **Step 2: Commit memory update**

Not needed — memory files are not git-tracked.
