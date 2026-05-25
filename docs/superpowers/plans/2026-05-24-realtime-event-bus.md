# Real-time Event Bus (SSE) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Push live gateway / peer / activity / monitor updates to the admin UI over a single Server-Sent-Events stream, replacing pure polling.

**Architecture:** An in-process `EventEmitter` singleton (`eventBus`) that services publish to at their existing state-change sites. One authed SSE endpoint subscribes and streams framed events; a resilient browser client re-dispatches them as `gc:*` DOM events and reconnects with bounded backoff. Polling stays as a safety net (no load-reduction claim in v1).

**Tech Stack:** Node 20, Express 4, `node --test`, better-sqlite3, Nunjucks, vanilla browser `EventSource`. Spec: `docs/superpowers/specs/2026-05-24-realtime-event-bus-design.md`.

**Branch:** `feat/realtime-event-bus` (already created off `master`). Commits stay local until the final push/PR step.

> **Review note (2 parallel reviews folded in):** the circuit-breaker event is emitted from `monitor.js` (where `checkAndUpdate` is called and `route.domain` is in scope), NOT from `circuitBreaker.js` (whose function is `checkAndUpdate`, not `recordResult`). Page refresh functions are IIFE-private — `gc:*` listeners go INSIDE each page's IIFE. The feature is registered in `COMMUNITY_FALLBACK`. The login page does not extend the authed layout, so the global `events.js` include never runs unauthenticated (no login-loop); CSP `script-src 'self'` already allows it.

---

## File Structure

**New**
- `src/services/eventBus.js` — singleton pub/sub with per-subscriber filter + isolation.
- `src/routes/api/events.js` — SSE request handler (headers, framing, keepalive, drain/close backpressure, teardown). Exported for unit testing with mocks.
- `public/js/events.js` — browser client: connect, re-dispatch as `gc:*`, bounded-backoff reconnect, exact-401 logout probe.
- `tests/eventBus.test.js`, `tests/api_events.test.js`.
- `docs/feature-realtime-events.md`.

**Modified**
- `src/routes/api/index.js` — add tiny authed `/ping` probe endpoint.
- `src/routes/index.js` — mount `GET /api/v1/events` before the `/api/v1` apiLimiter mount.
- `src/services/activity.js`, `peerStatus.js`, `gatewayHealth.js` — one `eventBus.publish(...)` each at the existing change site.
- `src/services/monitor.js` — **two** publishes: route-status change (`if (statusChanged)` block) and circuit-breaker change (`if (cbResult && cbResult.statusChanged)` block). The circuit event lives here, not in `circuitBreaker.js`.
- `src/services/license.js` — register `realtime_events: true` in `COMMUNITY_FALLBACK`.
- `templates/default/layout.njk`, `templates/pro/layout.njk` — include `events.js`.
- `public/js/logs.js`, `dashboard.js`, `peers.js`, `routes.js` — add `gc:*` listeners INSIDE each file's existing IIFE, calling its existing refresh function. (`gatewayPools.js` is **excluded**: it's server-rendered with no client refresh fn; the dashboard already reflects gateway state live.)

---

## Task 1: Event bus service

**Files:** Create `src/services/eventBus.js`; Test `tests/eventBus.test.js`.

- [ ] **Step 1: Write the failing test**

```js
// tests/eventBus.test.js
'use strict';
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

function freshBus() {
  delete require.cache[require.resolve('../src/services/eventBus')];
  return require('../src/services/eventBus');
}

describe('eventBus', () => {
  let bus;
  beforeEach(() => { bus = freshBus(); });

  it('delivers published events to subscribers', () => {
    const got = [];
    bus.subscribe((evt) => got.push(evt));
    bus.publish('peer', { peerId: 1 });
    assert.equal(got.length, 1);
    assert.equal(got[0].type, 'peer');
    assert.deepEqual(got[0].payload, { peerId: 1 });
    assert.equal(typeof got[0].ts, 'number');
  });

  it('applies a per-subscriber filter predicate', () => {
    const got = [];
    bus.subscribe((evt) => got.push(evt.type), (type) => type === 'gateway');
    bus.publish('peer', {});
    bus.publish('gateway', {});
    assert.deepEqual(got, ['gateway']);
  });

  it('isolates a throwing subscriber from the others', () => {
    const got = [];
    bus.subscribe(() => { throw new Error('boom'); });
    bus.subscribe((evt) => got.push(evt.type));
    bus.publish('activity', {});
    assert.deepEqual(got, ['activity']);
  });

  it('is a no-op with zero subscribers and supports unsubscribe', () => {
    assert.equal(bus.subscriberCount(), 0);
    const fn = () => {};
    bus.subscribe(fn);
    assert.equal(bus.subscriberCount(), 1);
    bus.unsubscribe(fn);
    assert.equal(bus.subscriberCount(), 0);
    assert.doesNotThrow(() => bus.publish('peer', {}));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-force-exit tests/eventBus.test.js`
Expected: FAIL — `Cannot find module '../src/services/eventBus'`.

- [ ] **Step 3: Write minimal implementation**

```js
// src/services/eventBus.js
'use strict';

const EventEmitter = require('node:events');
const logger = require('../utils/logger');

const CHANNEL = 'event';
const emitter = new EventEmitter();
emitter.setMaxListeners(100);

const wrappers = new Map(); // public listener -> internal wrapper

function publish(type, payload) {
  if (emitter.listenerCount(CHANNEL) === 0) return;
  emitter.emit(CHANNEL, { type, payload, ts: Date.now() });
}

function subscribe(listener, filter) {
  const wrapper = (evt) => {
    try {
      if (filter && !filter(evt.type, evt.payload)) return;
      listener(evt);
    } catch (err) {
      logger.warn({ err: err.message, type: evt.type }, 'event bus subscriber threw');
    }
  };
  wrappers.set(listener, wrapper);
  emitter.on(CHANNEL, wrapper);
}

function unsubscribe(listener) {
  const wrapper = wrappers.get(listener);
  if (wrapper) { emitter.off(CHANNEL, wrapper); wrappers.delete(listener); }
}

function subscriberCount() { return emitter.listenerCount(CHANNEL); }

module.exports = { publish, subscribe, unsubscribe, subscriberCount };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --test-force-exit tests/eventBus.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/eventBus.js tests/eventBus.test.js
git commit -m "feat(events): in-process event bus with per-subscriber filter"
```

---

## Task 2: SSE endpoint + auth probe + feature flag + mount

**Files:** Create `src/routes/api/events.js`; Modify `src/routes/api/index.js`, `src/routes/index.js`, `src/services/license.js`; Test `tests/api_events.test.js`.

- [ ] **Step 1: Write the failing test** (raw http client + handler-level mocks — NOT supertest, which buffers and hangs on a stream)

```js
// tests/api_events.test.js
'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');

process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

describe('SSE /api/v1/events', () => {
  let server, baseUrl;

  before(() => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-sse-'));
    process.env.GC_DB_PATH = path.join(tmp, 'test.db');
    process.env.GC_DATA_DIR = tmp;
    ['../config/default', '../src/db/connection', '../src/db/migrations', '../src/app']
      .forEach(p => { try { delete require.cache[require.resolve(p)]; } catch (_) {} });
    require('../src/db/migrations').runMigrations();
    const { createApp } = require('../src/app');
    server = createApp().listen(0);
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => server && server.close());

  it('returns 401 without a session', async () => {
    const status = await new Promise((resolve) => {
      const req = http.get(`${baseUrl}/api/v1/events`, (r) => { r.resume(); resolve(r.statusCode); });
      req.on('error', () => resolve(0));
    });
    assert.equal(status, 401);
  });

  it('streams a published event to a subscribed handler and unsubscribes on close', () => {
    delete require.cache[require.resolve('../src/services/eventBus')];
    const bus = require('../src/services/eventBus');
    delete require.cache[require.resolve('../src/routes/api/events')];
    const sseHandler = require('../src/routes/api/events');

    const writes = [];
    const handlers = {};
    const res = {
      writeHead() {}, flushHeaders() {},
      write(chunk) { writes.push(chunk); return true; },
      end() { this.ended = true; },
      once() {},
    };
    const req = { on(ev, fn) { handlers[ev] = fn; } };

    assert.equal(bus.subscriberCount(), 0);
    sseHandler(req, res);
    assert.equal(bus.subscriberCount(), 1);

    bus.publish('gateway', { peerId: 7, alive: false });
    const framed = writes.join('');
    assert.match(framed, /event: gateway/);
    assert.match(framed, /data: \{"peerId":7,"alive":false\}/);

    handlers.close();               // simulate client disconnect
    assert.equal(bus.subscriberCount(), 0);
  });

  it('pauses writing under backpressure (write returns false)', () => {
    delete require.cache[require.resolve('../src/services/eventBus')];
    const bus = require('../src/services/eventBus');
    delete require.cache[require.resolve('../src/routes/api/events')];
    const sseHandler = require('../src/routes/api/events');

    let writeCount = 0;
    const res = {
      writeHead() {}, flushHeaders() {}, end() {},
      write() { writeCount++; return false; }, // always congested
      once() {}, // never drains
    };
    const req = { on() {} };
    sseHandler(req, res);
    bus.publish('peer', { peerId: 1 });
    bus.publish('peer', { peerId: 2 });
    // first publish writes once and goes "lagging"; second is suppressed
    assert.equal(writeCount, 1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-force-exit tests/api_events.test.js`
Expected: FAIL — `Cannot find module '../src/routes/api/events'` and the 401 test fails (no route yet).

- [ ] **Step 3a: Create the SSE handler** (note the keepalive respects the `lagging` pause)

```js
// src/routes/api/events.js
'use strict';

const eventBus = require('../../services/eventBus');

const KEEPALIVE_MS = 25000;
const DRAIN_TIMEOUT_MS = 30000;

function sseHandler(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  let lagging = false;
  let drainTimer = null;

  function cleanup() {
    eventBus.unsubscribe(listener);
    clearInterval(keepalive);
    if (drainTimer) { clearTimeout(drainTimer); drainTimer = null; }
  }

  function send(evt) {
    if (lagging) return; // paused awaiting 'drain'
    const ok = res.write(`event: ${evt.type}\ndata: ${JSON.stringify(evt.payload)}\n\n`);
    if (ok === false) {
      lagging = true;
      drainTimer = setTimeout(() => { cleanup(); res.end(); }, DRAIN_TIMEOUT_MS);
      res.once('drain', () => {
        lagging = false;
        if (drainTimer) { clearTimeout(drainTimer); drainTimer = null; }
      });
    }
  }

  // v1: pass-all filter — the per-connection authz hook for future scoped views
  const listener = (evt) => send(evt);
  eventBus.subscribe(listener, () => true);

  // keepalive must also respect backpressure, else it defeats the pause
  const keepalive = setInterval(() => { if (lagging) return; res.write(': ping\n\n'); }, KEEPALIVE_MS);

  req.on('close', cleanup);
}

module.exports = sseHandler;
```

- [ ] **Step 3b: Add the auth probe endpoint** in `src/routes/api/index.js` (after line 18, before the sub-router mounts)

```js
// Lightweight authed probe — the SSE client fetches this after repeated
// reconnect failures: 200 = session alive, 401 = expired (client logs out).
router.get('/ping', (req, res) => res.json({ ok: true }));
```

- [ ] **Step 3c: Mount the SSE route** in `src/routes/index.js` immediately before the `/api/v1` mount (currently line 256), so it bypasses `apiLimiter` (a long-lived GET must not sit behind a per-window limiter) but keeps `requireAuth`:

```js
// ─── Real-time event stream (SSE) — session-authed, bypasses apiLimiter ──
router.get('/api/v1/events', requireAuth, require('./api/events'));

// ─── API routes ────────────────────────────────────
router.use('/api/v1', requireAuth, apiLimiter, require('./api'));
```

- [ ] **Step 3d: Register the feature** in `src/services/license.js` — add to the flat `COMMUNITY_FALLBACK` flag map (~line 15):

```js
  realtime_events: true,
```

Community feature, available in all modes (spec §5) — flag defaults `true`, no Pro/API guard. Satisfies the project convention of registering every new feature in `COMMUNITY_FALLBACK`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test --test-force-exit tests/api_events.test.js`
Expected: PASS (3 tests). (`requireAuth` returns 401 for `/api/`-prefixed paths without a session — verified in `src/middleware/auth.js`.)

- [ ] **Step 5: Commit**

```bash
git add src/routes/api/events.js src/routes/api/index.js src/routes/index.js src/services/license.js tests/api_events.test.js
git commit -m "feat(events): SSE endpoint, auth probe, drain/close backpressure, feature flag"
```

---

## Task 3: Wire the four emit sites

Add `const eventBus = require('./eventBus');` to the top requires of each modified service file. (`monitor.js` gets two publishes; `circuitBreaker.js` is NOT modified.)

- [ ] **Step 1: Write a spy test for the activity emit** — append to `tests/eventBus.test.js`, mirroring the tmp-DB setup from `tests/api_events.test.js` (`runMigrations()` first, cache-bust `../config/default`/`../src/db/connection`/`../src/db/migrations`). Subscribe a collector to a freshly-required `eventBus`, call `require('../src/services/activity').log('test_event', 'hi', { severity: 'info' })`, and assert exactly one event with `type === 'activity'` and `payload.eventType === 'test_event'`.

- [ ] **Step 2: `src/services/activity.js`** — capture the insert id and publish after the INSERT inside `log()`. Replace the existing un-assigned `db.prepare(...).run(...)` with:

```js
  const info = db.prepare(`
    INSERT INTO activity_log (event_type, message, details, source, ip_address, severity)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(eventType, message, details ? JSON.stringify(details) : null, source, sanitizeIp(ipAddress), severity);

  eventBus.publish('activity', {
    id: info.lastInsertRowid, eventType, message, severity,
    createdAt: new Date().toISOString(),
  });
```

(`better-sqlite3` `.run()` returns `{ changes, lastInsertRowid }`. `createdAt` is a hint; the client reconciles the exact value via refetch.)

- [ ] **Step 3: `src/services/peerStatus.js`** — add a single publish INSIDE the existing `if (wasOnline !== undefined && wasOnline !== wgPeer.isOnline) { ... }` block (after the `activity.log(...)`/`logger.info(...)` lines, before the block closes ~line 52). Reuse the existing guard — do NOT add a second `if`:

```js
        eventBus.publish('peer', { peerId: peer.id, name: peer.name, connected: wgPeer.isOnline });
```

- [ ] **Step 4: `src/services/gatewayHealth.js`** — in `evaluatePeer`, just before `return { transition };` (~line 132). `updated.alive` is in scope; `name` is not (only in `_onTransition`), so the payload is `{ peerId, alive, transition }` (matches the spec §3 row):

```js
  if (transition) {
    eventBus.publish('gateway', { peerId, alive: updated.alive === 1, transition });
  }
  return { transition };
```

- [ ] **Step 5: `src/services/monitor.js` (route-status event)** — inside `checkRoute`, in the existing `if (statusChanged) { ... }` block, right after the `activity.log(...)` call (~line 182). `newStatus`/`route.domain` are in scope:

```js
    eventBus.publish('monitor', { routeId: route.id, domain: route.domain, status: newStatus });
```

- [ ] **Step 6: `src/services/monitor.js` (circuit-breaker event)** — `circuitBreaker` exposes `checkAndUpdate(routeId, isHealthy)` (NOT `recordResult`), and `monitor.checkRoute` already calls it at ~line 220. Add the publish inside the existing `if (cbResult && cbResult.statusChanged) {` block (~line 222), right after `const cbStatus = cbResult.newStatus;`:

```js
    eventBus.publish('monitor', { routeId: route.id, domain: route.domain, circuit: cbStatus });
```

Do **not** edit `circuitBreaker.js` — emitting there would lose `route.domain` and fire on internal `open→half-open` timeout transitions (`checkTimeouts`) the UI should not surface.

- [ ] **Step 7: Run the full suite** (existing tests need `NODE_ENV=test`; the new event tests self-provide secrets)

Run: `NODE_ENV=test node --test --test-force-exit tests/`
Expected: PASS (existing suite + new event tests). Fix any regression before continuing.

- [ ] **Step 8: Commit**

```bash
git add src/services/activity.js src/services/peerStatus.js src/services/gatewayHealth.js src/services/monitor.js tests/eventBus.test.js
git commit -m "feat(events): publish gateway/peer/activity/monitor events at change sites"
```

---

## Task 4: Browser client + page wiring

**Files:** Create `public/js/events.js`; Modify `templates/{default,pro}/layout.njk` and the page scripts.

- [ ] **Step 1: Create the client core**

```js
// public/js/events.js
(function () {
  'use strict';
  var BACKOFF = [1000, 2000, 5000, 15000];
  var PROBE_AFTER = 3;
  var failures = 0, es = null, stopped = false;

  function backoff() {
    return BACKOFF[Math.min(failures, BACKOFF.length - 1)] + Math.floor(Math.random() * 1000);
  }
  function dispatch(type, payload) {
    document.dispatchEvent(new CustomEvent('gc:' + type, { detail: payload }));
  }
  function connect() {
    if (stopped || !window.EventSource) return;
    es = new EventSource('/api/v1/events');
    ['gateway', 'peer', 'activity', 'monitor'].forEach(function (t) {
      es.addEventListener(t, function (e) {
        try { dispatch(t, JSON.parse(e.data)); } catch (_) {}
      });
    });
    es.onopen = function () {
      failures = 0;
      document.dispatchEvent(new CustomEvent('gc:reconnected')); // pages refetch state
    };
    es.onerror = function () {
      es.close();
      failures++;
      if (failures >= PROBE_AFTER) {
        fetch('/api/v1/ping', { credentials: 'same-origin' })
          .then(function (r) {
            if (r.status === 401) { stopped = true; window.location = '/login'; return; } // ONLY 401 = logout
            setTimeout(connect, backoff()); // 429/5xx/network = transient
          })
          .catch(function () { setTimeout(connect, backoff()); });
      } else {
        setTimeout(connect, backoff());
      }
    };
  }
  connect();
})();
```

- [ ] **Step 2: Include it in both layouts** — in `templates/default/layout.njk` (~line 115) and `templates/pro/layout.njk` (~line 117), immediately after the existing `<script src="/js/app.js"></script>`:

```html
<script src="/js/events.js"></script>
```

Plain external `src` matches the existing `app.js` include; CSP `script-src 'self'` allows it, `connect-src 'self'` covers the EventSource. The login/guest pages are standalone templates (they do not `extends` this layout), so `events.js` never runs unauthenticated — no login-loop.

- [ ] **Step 3: Wire each page's existing refresh function to `gc:*` — INSIDE that page's IIFE** (the refresh fns are IIFE-private; a listener added elsewhere throws `ReferenceError`). Read each file first to confirm the name; verified names:

  - `public/js/logs.js` → `loadLogs(1)` — on `gc:activity` and `gc:reconnected`.
  - `public/js/dashboard.js` → `refreshAll()` — on `gc:gateway`, `gc:peer`, `gc:monitor`, `gc:reconnected`.
  - `public/js/peers.js` → `loadPeers()` (+ `loadGroups()` / `loadGateways()` as relevant) — on `gc:peer`, `gc:gateway`, `gc:reconnected`.
  - `public/js/routes.js` → `loadRoutes()` — on `gc:monitor`, `gc:reconnected`.
  - (Gateway-Pools page is server-rendered with no client refresh fn — out of scope for v1; gateway state shows live on the dashboard.)

  Pattern (added inside the IIFE, after the refresh fn is defined) — e.g. for `logs.js`:

```js
  document.addEventListener('gc:activity', function () { loadLogs(1); });
  document.addEventListener('gc:reconnected', function () { loadLogs(1); });
```

  No new rendering logic — reuse exactly what polling already calls.

- [ ] **Step 4: Manual verification** (client JS has no unit test — out of c8 scope). With a valid admin session cookie `$C` (from devtools):

```bash
curl -N -H "Cookie: gc.sid=$C" https://domaincaster.com/api/v1/events
```

Trigger a change (toggle a peer / restart a gateway). Expected: framed `event: …` lines arrive **incrementally**, not batched — confirms Caddy isn't buffering (spec §7).

- [ ] **Step 5: Commit**

```bash
git add public/js/events.js templates/default/layout.njk templates/pro/layout.njk \
        public/js/logs.js public/js/dashboard.js public/js/peers.js public/js/routes.js
git commit -m "feat(events): resilient SSE client + wire page refreshers to gc:* events"
```

---

## Task 5: Docs, verification, push

- [ ] **Step 1: Write `docs/feature-realtime-events.md`** — short feature doc: what it does, the `gc:*` DOM-event contract, `/api/v1/events`, reconnect/logout behaviour, the "polling retained, no load reduction in v1" note, and the `COMMUNITY_FALLBACK` flag. Force-add: `git add -f docs/feature-realtime-events.md`.

- [ ] **Step 2: Full test suite green** (set `NODE_ENV=test` so the existing suite's secret-gen works; node's built-in runner, no extra deps)

Run: `NODE_ENV=test node --test --test-force-exit tests/`
Expected: PASS, no regressions. (One env-only test needs the `wg` CLI — green in CI.)

- [ ] **Step 3: Lint — CI is the canonical gate.** Per the project workflow (`feedback_no_local_tests`), tests/lint run in CI, not locally. ESLint is NOT installed as a local dep, so do **not** invent `npm run lint`. CI (`test.yml`) lints with `npx eslint -c .eslintrc.security.json "src/**/*.js" "public/**/*.js" --no-eslintrc` — note this lints `public/js/events.js` too (it uses no eval/child_process/fs, so it passes the security ruleset). The push in Step 4 triggers this.

- [ ] **Step 4: Commit docs + push branch / open PR**

```bash
git add -f docs/feature-realtime-events.md
git commit -m "docs: real-time events feature doc"
git push -u origin feat/realtime-event-bus
```

Then open a PR to `master` (merge → `release.yml` builds & releases). Deploy is a separate, explicit step.

---

## Self-Review

**Spec coverage:** §2.1 bus → Task 1; §2.2 endpoint + drain/close backpressure (keepalive respects `lagging`) → Task 2; §2.3 client + reconnect/exact-401 probe → Task 4 Step 1; §3 taxonomy / emit sites → Task 3 (gateway `{peerId,alive,transition}`, peer `{peerId,name,connected}`, activity inline, monitor status + circuit — both in `monitor.js`); §5 auth + probe + `COMMUNITY_FALLBACK` registration → Task 2 (Steps 3b/3c/3d) + Task 4; §6 drain/close + inline activity → Task 2 + Task 3; §7 verified + manual curl → Task 4 Step 4; §9 raw-client tests + c8 scope → Task 2; §11 pollers retained → no poller removed (Task 3 only adds publishes, Task 4 only adds listeners); §4 reconnect refetch → Task 4 (`gc:reconnected`). All covered.

**Placeholder scan:** Task 3 Step 1 (activity spy test) and Task 4 Step 3 (per-page IIFE wiring) carry execution notes with exact function names and the precise pattern, not "TBD" — the only thing read at execution time is each file's confirmed-existing refresh fn. All core files (bus, endpoint, client) have complete code.

**Type/name consistency:** `publish/subscribe/unsubscribe/subscriberCount` consistent (Tasks 1–3); event types `gateway|peer|activity|monitor` consistent across endpoint, client, emit sites; client dispatches `gc:<type>` + `gc:reconnected`, consumed verbatim in Task 4 Step 3; probe path `/api/v1/ping` consistent (Task 2 Step 3b ↔ Task 4 Step 1); circuit event emitted via `circuitBreaker.checkAndUpdate`'s result inside `monitor.js` (real function name), `circuitBreaker.js` untouched.
