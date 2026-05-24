# Design Spec — Real-time Event Bus (SSE), Iteration 1

- **Date:** 2026-05-24
- **Status:** Approved design, sharpened over two review rounds → ready for implementation plan
- **Feature:** Roadmap #1. Live web-UI updates via Server-Sent Events.
- **Repo:** gatecontrol (server) only.
- **Tier:** Community (available in all licence modes).
- **Revisions:** v1 initial · v2 hardened vs design-review concerns 1–6 (§12) ·
  v3 second focused review A–C: backpressure → drain/close (not drop), activity
  sent inline (throttle removed), explicit reconnect guarantees.

## 1. Overview

Today the admin UI learns about state changes by polling. This feature adds a
single server-side **event bus** plus a **Server-Sent Events** stream so the UI
updates live. Iteration 1 is server-only and covers four event categories:
gateway status/health, peer status, the activity feed, and monitor /
circuit-breaker state.

**Goals**
- Push live updates to Dashboard, Peers, Gateway-Pools and Logs.
- Zero new infrastructure; fits the single-process Express + SQLite model.
- Emitting an event must never block or break the emitting service.

**Explicit non-goal in v1: load reduction.** SSE is an *enhancement*; existing
pollers stay as a safety net (§11). v1 does not claim to reduce server load.

**Non-goals (future iterations)**
- Client (Windows/Android) push — roadmap #1 phase 2.
- External fan-out to ntfy/Discord/webhooks — roadmap #7.
- Event replay / `Last-Event-ID` history — §4.
- Multi-instance / shared bus — not applicable (single process, single SQLite).

## 2. Architecture

Three units, each independently testable.

### 2.1 `src/services/eventBus.js`
A thin singleton over Node's `EventEmitter`.
- `publish(type, payload)` — fire-and-forget; builds `{ type, payload, ts }`
  and invokes each subscriber in its own try/catch so a throwing/slow
  subscriber cannot affect the caller or other subscribers. No-op when there
  are no subscribers.
- `subscribe(listener, filter?)` — register a listener with an **optional
  per-connection filter predicate** `(type, payload) => boolean`, default
  pass-all. *(Concern 4: the authorization hook exists from day one; passes
  everything today, lets scoped views / share-links plug in a real predicate
  later without redesign.)*
- `unsubscribe(listener)` · `subscriberCount()`.
- `setMaxListeners` raised (admin sessions are few but may exceed 10).

### 2.2 `src/routes/api/events.js` — `GET /api/v1/events`
- Guarded by `requireAuth` (session cookie; returns **401** for unauthenticated
  API requests — relevant to §5 and the client's reconnect logic).
- Headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache`,
  `Connection: keep-alive`, `X-Accel-Buffering: no`; then `res.flushHeaders()`.
- Subscribes to the bus with a filter predicate (pass-all in v1). Each event is
  written as `event: <type>\ndata: <json>\n\n`.
- **Backpressure (Concern 3 / review-A) — drain-or-close, never silent-drop:**
  honour the return value of `res.write()`. On `false`, **stop writing and wait
  for the socket `'drain'` event** before resuming. If `'drain'` does not
  arrive within a timeout (e.g. 30 s — a genuinely stuck client), **close the
  connection.** The client's reconnect controller then fires `open` → state
  refetch → correct state. This bounds Node memory *and* preserves correctness;
  events are never silently dropped (which would leave a connected client
  showing stale data as "live").
- **Keepalive:** `: ping\n\n` comment every 25 s (skipped while paused for backpressure; interval cleared on close).
- **Teardown:** on `req.on('close')` → unsubscribe + clear keepalive + clear
  any drain timer.
- Mounted so it bypasses `apiLimiter` (a long-lived connection must not consume
  the per-window request budget); `requireAuth` still applies.

### 2.3 `public/js/events.js` — resilient client
A small reconnect controller around `EventSource` (does **not** rely on the
browser's infinite 3 s auto-retry — Concern 1):
- On `error`/close: reconnect with **bounded exponential backoff + jitter**
  (e.g. 1s → 2s → 5s → 15s cap), counting consecutive failures. **Retry
  indefinitely at the cap** — never give up except on the auth case below, so
  the UI re-attaches by itself after a long outage.
- After K consecutive failures, probe a **cheap authed GET that returns a real
  `401`** when the session is invalid (add a lightweight `/api/v1/ping` if no
  existing endpoint fits — it must answer `401`, not a redirect or HTML).
  **Only an exact `401` triggers logout** (→ `EventSource.close()` + redirect to
  `/login`, stop). `429` / `5xx` / network errors are **transient** → keep
  backing off. (This prevents both the 401 reconnect storm *and* a false logout
  on a rate-limit or server hiccup.)
- On `open`: reset the failure counter **and** do a one-shot refetch of the
  page's current state, reconciling anything missed while disconnected.
- `addEventListener('<type>', …)` for `gateway`, `peer`, `activity`, `monitor`
  updates the relevant widget directly or calls the page's existing refresh.
- Degrades gracefully: if `EventSource` is unavailable, existing polling remains
  (§11).

## 3. Event taxonomy

| type | emitted from | payload |
|------|--------------|---------|
| `gateway` | `gatewayHealth.js` `evaluatePeer` (fires on any transition) | `{ peerId, alive, transition }` |
| `peer` | `peerStatus.js` on its existing online/offline transition (`previousState` diff already exists) | `{ peerId, name, connected }` |
| `activity` | `activity.js` on new log row — **row sent inline** (review-B) | `{ id, eventType, message, severity, createdAt }` |
| `monitor` | `monitor.js` route-status change | `{ routeId, domain, status }` |
| `monitor` | `monitor.js` circuit change (from `circuitBreaker.checkAndUpdate` result; **not** `circuitBreaker.js`) | `{ routeId, domain, circuit }` |

Payloads are small refresh-triggers — the client re-dispatches them as `gc:*` DOM events that call each page's existing refresh function, so exact fields beyond the identifiers are not consumed directly.

`monitor` events carry `status` *or* `circuit` depending on source; the client
updates whichever field is present. Activity rows are tiny and sent inline (no
throttle, review-B); a burst is absorbed by the drain/close backpressure of
§2.3, not by silent dropping or backdoor polling. Each emit sits at an
**existing** state-change site — no new polling loop is introduced.

## 4. Reconnect strategy (YAGNI on replay)

No server-side replay buffer and no `Last-Event-ID` handling in v1. Reconnect
uses the bounded backoff of §2.3; the `open` handler refetches current page
state, reconciling missed events. The server stays stateless per connection.

## 5. Auth, session expiry & licence

- **Auth:** `requireAuth` (session). `GET` ⇒ no CSRF concern.
- **Session expiry (Concern 1):** the stream is authed at connect only; an open
  stream is not re-checked, but the next reconnect after expiry gets a `401`.
  Native `EventSource` can't read the status, so the client uses the authed
  probe (§2.3) — **only an exact `401`** means "session expired" (→ redirect to
  login, stop); anything else is transient (→ backoff retry). No reconnect
  storm, no false logout.
- **Licence:** Community feature, available in every mode. Registered in the
  feature schema with `COMMUNITY_FALLBACK = enabled`; no Pro guard.

## 6. Error handling & resources

- `publish` is a no-op when `subscriberCount() === 0`.
- A subscriber that throws is caught and logged (pino `warn`); other
  subscribers and the emitting service are unaffected.
- **Slow/stuck client (Concern 3 / review-A):** drain-or-close per §2.3 —
  pause on `write()===false`, resume on `'drain'`, close if stuck past the
  timeout. Memory bounded; no silent drops; correctness preserved via the
  reconnect refetch.
- **Activity volume (review-B):** rows are tiny and sent inline; floods are
  handled by the same drain/close backpressure. No throttle/coalesce in v1
  (YAGNI). If real flooding is later observed, add measured coalescing then.
- SSE write failure (client vanished) → unsubscribe + clear keepalive + end.
- `EventEmitter` max-listeners raised to avoid spurious warnings.

## 7. Proxy & runtime — verified (Concern 2)

Verified against the live system, not assumed:
- **Caddy:** the admin-UI route is `domaincaster.com → reverse_proxy
  127.0.0.1:3000` with **no** `flush_interval` / `response_buffers` overrides.
  Caddy auto-flushes `Content-Type: text/event-stream`, so **no Caddy change is
  required** as long as the endpoint sets that header (it does).
  `X-Accel-Buffering: no` is belt-and-suspenders.
- **Node v20.20.2 timeouts:** `requestTimeout` (300 s) times *receipt of the
  request* — for a GET it completes immediately, so it does **not** kill the
  long-lived response; `headersTimeout` (60 s) / `keepAliveTimeout` (5 s) apply
  before/between requests only; `server.timeout = 0` ⇒ no inactivity kill.
  Long-lived SSE is safe; the 25 s keepalive guards intermediary idle timeouts.
- **Final impl check:** a manual `curl -N` through Caddy to confirm events
  arrive incrementally (not batched) before sign-off.

## 8. Files

**New:** `src/services/eventBus.js`, `src/routes/api/events.js`,
`public/js/events.js`, a lightweight authed `GET /api/v1/ping` if no existing
endpoint returns a clean 401 (review-C), `tests/eventBus.test.js`,
`tests/api_events.test.js`, `docs/feature-realtime-events.md`.

**Modified:** emit sites `gatewayHealth.js`, `peerStatus.js`, `activity.js`,
and `monitor.js` (two publishes: route-status + circuit — `circuitBreaker.js`
stays untouched); `src/routes/api/index.js` (`/ping` probe); `src/routes/index.js`
(mount `/api/v1/events` outside `apiLimiter`); `src/services/license.js`
(`COMMUNITY_FALLBACK` flag); `templates/{default,pro}/layout.njk` (include
`events.js`); the page scripts `public/js/{logs,dashboard,peers,routes,gatewayPools}.js`
(add `gc:*` listeners inside each IIFE); `ROADMAP.md`.

## 9. Testing (Concern 5)

- `tests/eventBus.test.js` — publish/subscribe, **filter predicate** (filtered
  subscriber receives only matching events), listener isolation (one throwing
  listener doesn't stop others), no-op with zero subscribers, unsubscribe.
- `tests/api_events.test.js` — **raw `http.get` client with manual teardown**
  (read first framed event → assert `event:`/`data:` → `destroy()`), **not**
  supertest (which buffers the whole response and would hang on a never-ending
  stream). Asserts: 401 without session; event arrives after `publish()`; `req`
  close unsubscribes (subscriberCount drops). A backpressure unit test (write
  returns false → no further writes until drain / close after timeout) covers
  review-A.
- `c8` coverage is scoped to `src/`; `public/js/events.js` is not executed in
  `node --test` and does not affect the line-coverage gate (confirm c8
  include/exclude).

## 10. Documentation

`docs/feature-realtime-events.md` on completion (project convention).

## 11. Polling cutover (Concern 6)

v1 is **SSE-as-enhancement with polling retained as a safety net**: existing
pollers (peer 30 s, monitor, traffic 60 s) keep running so the UI is correct
even if the stream is down. **No load reduction in v1** — an explicit, accepted
trade-off for low risk. A later iteration may relax intervals when the stream
is healthy. The implementation must not remove any existing poller.

## 12. Risk mitigations from design review (traceability)

| # | Concern | Addressed in |
|---|---------|--------------|
| 1 | Reconnect storm on session expiry | §2.3, §5 (authed probe, exact-401-only) |
| 2 | Caddy/Node streaming unverified | §7 (verified; no Caddy change) |
| 3 | Slow-client backpressure / memory | §2.3, §6 (drain-or-close) |
| 4 | No per-session authz hook | §2.1 (`subscribe(listener, filter?)`) |
| 5 | supertest hangs on SSE | §9 (raw client + teardown) |
| 6 | Polling cutover ambiguity | §11 (enhancement; pollers retained) |
| A | Backpressure silently dropped events → stale UI | §2.3, §6 (drain-or-close, not drop) |
| B | Activity throttle reintroduced polling | §3, §6 (inline rows; no throttle) |
| C | Reconnect controller under-specified | §2.3, §5 (exact-401 logout, retry-forever-at-cap, real-401 probe endpoint) |

## 13. Out of scope (tracked for later)

- Client push subscription (Windows/Android) — roadmap #1, phase 2.
- External notification fan-out — roadmap #7.
- Event persistence / replay.
