# Design Spec — Real-time Event Bus (SSE), Iteration 1

- **Date:** 2026-05-24
- **Status:** Approved design, sharpened after design review → ready for implementation plan
- **Feature:** Roadmap #1. Live web-UI updates via Server-Sent Events.
- **Repo:** gatecontrol (server) only.
- **Tier:** Community (available in all licence modes).
- **Revisions:** v1 initial design · v2 hardened against design-review concerns 1–6 (see §12).

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
pollers stay as a safety net (see §11). v1 does not claim to reduce server load.

**Non-goals (future iterations)**
- Client (Windows/Android) push — roadmap #1 phase 2.
- External fan-out to ntfy/Discord/webhooks — roadmap #7.
- Event replay / `Last-Event-ID` history — see §4.
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
  per-connection filter predicate** `(type, payload) => boolean`. Defaults to
  pass-all. *(Concern 4: the authorization hook exists from day one; it passes
  everything today because the UI is not per-user filtered, but scoped views /
  share-links can plug a real predicate in later without redesign.)*
- `unsubscribe(listener)` · `subscriberCount()`.
- `setMaxListeners` raised (admin sessions are few but may exceed 10).

### 2.2 `src/routes/api/events.js` — `GET /api/v1/events`
- Guarded by `requireAuth` (session cookie; returns 401 for unauthenticated
  API requests — relevant to §5).
- Headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache`,
  `Connection: keep-alive`, `X-Accel-Buffering: no`; then `res.flushHeaders()`.
- Subscribes to the bus with a filter predicate (pass-all in v1). Each event is
  written as `event: <type>\ndata: <json>\n\n`.
- **Backpressure (Concern 3):** check the return value of `res.write()`. When
  it returns `false` the client is consuming slower than we produce; mark the
  connection "lagging" and **drop** subsequent events for it (optionally close
  after a grace period) rather than buffering unboundedly in Node memory.
- **Keepalive:** `: ping\n\n` comment every 25 s (interval cleared on close).
- **Teardown:** on `req.on('close')` → unsubscribe + clear keepalive.
- Mounted so it bypasses `apiLimiter` (a long-lived connection must not consume
  the per-window request budget); `requireAuth` still applies.

### 2.3 `public/js/events.js` — resilient client
- A small reconnect controller around `EventSource` (does **not** rely on the
  browser's infinite 3 s auto-retry — see Concern 1):
  - On `error`/close: reconnect with **bounded exponential backoff + jitter**
    (e.g. 1s → 2s → 5s → 15s cap), counting consecutive failures.
  - After K consecutive failures, probe a tiny authed endpoint
    (`GET /api/v1/ping`, expects 200). **If it returns 401 → the session has
    expired: stop reconnecting, redirect to `/login`.** Otherwise keep retrying
    with backoff and rely on polling in the meantime.
  - On `open`: reset the failure counter **and** do a one-shot refetch of the
    page's current state, reconciling anything missed while disconnected.
- `addEventListener('<type>', …)` for `gateway`, `peer`, `activity`, `monitor`
  updates the relevant widget directly (cheap cases) or calls the page's
  existing refresh function.
- Degrades gracefully: if `EventSource` is unavailable, the existing polling
  remains (see §11).

## 3. Event taxonomy

| type | emitted from | payload (small) |
|------|--------------|-----------------|
| `gateway` | `gatewayHealth.js` on state transition | `{ peerId, name, status, alive }` |
| `peer` | `peerStatus.js` on its existing online/offline transition (`previousState` diff already exists) | `{ peerId, name, connected, handshakeAge }` |
| `activity` | `activity.js` on new log row (throttled — see §6) | `{ id, eventType, message, severity, createdAt }` |
| `monitor` | `monitor.js` result change | `{ routeId, domain, status }` |
| `monitor` | `circuitBreaker.js` open/close | `{ routeId, circuit }` |

`monitor` events carry `status` *or* `circuit` depending on source; the client
updates whichever field is present. Each emit sits at an **existing**
state-change site — no new polling loop is introduced. (`peerStatus.js` and
`gatewayHealth.js` already detect transitions; verified during review.)

## 4. Reconnect strategy (YAGNI on replay)

No server-side replay buffer and no `Last-Event-ID` handling in v1. Reconnect
uses bounded backoff (not the native infinite 3 s loop, §2.3); the `open`
handler refetches current page state, reconciling missed events. The server
stays stateless per connection.

## 5. Auth, session expiry & licence

- **Auth:** `requireAuth` (session). `GET` ⇒ no CSRF concern.
- **Session expiry (Concern 1):** the stream is authed at connect only; an open
  stream is not re-checked, but the next reconnect after expiry gets a 401.
  Native `EventSource` cannot read the status code, so the client uses the
  authed-probe approach in §2.3 to distinguish "session expired" (→ redirect to
  login, stop) from a transient network error (→ backoff retry). This prevents
  an endless 401 reconnect storm.
- **Licence:** Community feature, available in every mode. Registered in the
  feature schema with `COMMUNITY_FALLBACK = enabled`; no Pro guard.

## 6. Error handling & resources

- `publish` is a no-op when `subscriberCount() === 0`.
- A subscriber that throws is caught and logged (pino `warn`); other
  subscribers and the emitting service are unaffected.
- **Slow client (Concern 3):** handled via the `res.write()` backpressure check
  in §2.3 — lagging clients are dropped, not buffered.
- **Activity volume (Concern 3/6):** the activity live-tail is **throttled /
  coalesced** — bursts (bulk ops, bot-blocker 403 aggregation, boot reconcile)
  emit at most one "new activity" signal per short window; the client refetches
  the tail rather than receiving every row. Prevents stream floods.
- SSE write failure (client vanished) → unsubscribe + clear keepalive + end.
- `EventEmitter` max-listeners raised to avoid spurious warnings.

## 7. Proxy & runtime — verified (Concern 2)

Verified against the live system, not assumed:
- **Caddy:** the admin-UI route is `domaincaster.com → reverse_proxy
  127.0.0.1:3000` with **no** `flush_interval` / `response_buffers` overrides.
  Caddy auto-flushes responses with `Content-Type: text/event-stream`, so **no
  Caddy config change is required** as long as the endpoint sets that header
  (it does). `X-Accel-Buffering: no` is belt-and-suspenders.
- **Node v20.20.2 timeouts:** `requestTimeout` (300 s) measures *receipt of the
  request* — for a GET it completes immediately, so it does **not** kill the
  long-lived response; `headersTimeout` (60 s) and `keepAliveTimeout` (5 s)
  apply before/between requests only; `server.timeout = 0` ⇒ no inactivity
  kill. Long-lived SSE is safe; the 25 s keepalive guards intermediary idle
  timeouts.
- **Final impl check:** a manual `curl -N` through Caddy to the endpoint to
  confirm events arrive incrementally (not batched) before sign-off.

## 8. Files

**New:** `src/services/eventBus.js`, `src/routes/api/events.js`,
`public/js/events.js`, `tests/eventBus.test.js`, `tests/api_events.test.js`,
`docs/feature-realtime-events.md`.

**Modified:** the five emit sites (`gatewayHealth.js`, `peerStatus.js`,
`activity.js`, `monitor.js`, `circuitBreaker.js`) — one `eventBus.publish(...)`
each at the existing change site (+ throttle for activity); `src/routes/api/index.js`
(mount `/events` outside `apiLimiter`); page templates for Dashboard, Peers,
Gateway-Pools, Logs (include `events.js`); `ROADMAP.md`.

## 9. Testing (Concern 5)

- `tests/eventBus.test.js` — publish/subscribe, **filter predicate** (a
  subscriber with a filter only receives matching events), listener isolation
  (one throwing listener doesn't stop others), no-op with zero subscribers,
  unsubscribe.
- `tests/api_events.test.js` — uses a **raw `http.get` client with manual
  teardown** (read first framed event → assert `event:`/`data:` → `destroy()`),
  **not** supertest, which buffers the whole response and would hang on a
  never-ending stream. Asserts: 401 without session; event arrives after
  `publish()`; `req` close unsubscribes (subscriberCount drops).
- `c8` coverage is scoped to `src/`; `public/js/events.js` is not executed in
  `node --test` and does not affect the line-coverage gate (confirm the c8
  include/exclude config).

## 10. Documentation

`docs/feature-realtime-events.md` on completion (project convention).

## 11. Polling cutover (Concern 6)

v1 is **SSE-as-enhancement with polling retained as a safety net**: the
existing pollers (peer 30 s, monitor, traffic 60 s) keep running so the UI is
correct even if the stream is down. This means **no load reduction in v1** — an
explicit, accepted trade-off for low risk. A later iteration may relax polling
intervals when the stream is healthy. The implementation must not remove any
existing poller.

## 12. Risk mitigations from design review (traceability)

| # | Concern | Addressed in |
|---|---------|--------------|
| 1 | Reconnect storm on session expiry | §2.3, §5 (authed probe → redirect/stop) |
| 2 | Caddy/Node streaming unverified | §7 (verified; no Caddy change) |
| 3 | Slow-client backpressure / memory | §2.3, §6 (`res.write()` check, activity throttle) |
| 4 | No per-session authz hook | §2.1 (`subscribe(listener, filter?)`) |
| 5 | supertest hangs on SSE | §9 (raw client + teardown) |
| 6 | Polling cutover ambiguity | §11 (enhancement; pollers retained) |

## 13. Out of scope (tracked for later)

- Client push subscription (Windows/Android) — roadmap #1, phase 2.
- External notification fan-out — roadmap #7.
- Event persistence / replay.
