# Design Spec — Real-time Event Bus (SSE), Iteration 1

- **Date:** 2026-05-24
- **Status:** Approved design → ready for implementation plan
- **Feature:** Roadmap #1. Live web-UI updates via Server-Sent Events.
- **Repo:** gatecontrol (server) only.
- **Tier:** Community (available in all licence modes).

## 1. Overview

Today the admin UI learns about state changes by polling. This feature adds a
single server-side **event bus** plus a **Server-Sent Events** stream so the UI
updates live. Iteration 1 is server-only and covers four event categories:
gateway status/health, peer status, the activity feed, and monitor /
circuit-breaker state.

**Goals**
- Replace polling on Dashboard, Peers, Gateway-Pools and Logs with push.
- Zero new infrastructure; fits the single-process Express + SQLite model.
- Emitting an event must never block or break the emitting service.

**Non-goals (future iterations)**
- Client (Windows/Android) push — roadmap #1 phase 2.
- External fan-out to ntfy/Discord/webhooks — roadmap #7.
- Event replay / `Last-Event-ID` history — see §4.
- Multi-instance / shared bus — not applicable (single process, single SQLite).

## 2. Architecture

Three units, each independently testable:

### 2.1 `src/services/eventBus.js`
A thin singleton over Node's `EventEmitter`.
- `publish(type, payload)` — emits on a single internal channel `'event'` with
  `{ type, payload, ts }`. Fire-and-forget. Wrapped so a throwing/ slow
  subscriber cannot affect the caller (each listener invoked in its own
  try/catch). No-op cost when there are no subscribers.
- `subscribe(fn)` / `unsubscribe(fn)` — register/remove a listener.
- `subscriberCount()` — for tests / diagnostics.
- `setMaxListeners` raised (admin sessions are few but >10 possible).

### 2.2 `src/routes/api/events.js` — `GET /api/v1/events`
- Guarded by `requireAuth` (session or token; the UI uses the session cookie).
- Streaming response headers: `Content-Type: text/event-stream`,
  `Cache-Control: no-cache`, `Connection: keep-alive`,
  `X-Accel-Buffering: no`; then `res.flushHeaders()`.
- Subscribes to the bus; each event is written as
  `event: <type>\ndata: <json>\n\n`.
- **Keepalive:** writes a `: ping\n\n` comment every 25 s (interval cleared on
  close) to survive idle timeouts on the Caddy hop.
- **Teardown:** on `req.on('close')` → unsubscribe + clear keepalive interval.
- Mounted so it bypasses the standard `apiLimiter` (a long-lived connection
  must not consume the per-window request budget); auth still applies.

### 2.3 `public/js/events.js`
- Opens `new EventSource('/api/v1/events')`.
- `addEventListener('<type>', …)` for `gateway`, `peer`, `activity`, `monitor`.
- Each handler updates the relevant DOM widget directly where cheap (e.g.
  append an activity row, flip a gateway badge) or calls the page's existing
  refresh function for that widget.
- On `open` (initial + every auto-reconnect) the page does a one-shot refetch
  of its data so no state is lost across reconnects (see §4).
- Degrades gracefully: if `EventSource` is unavailable or the stream errors
  repeatedly, the existing polling remains the fallback (kept, not removed, in
  iteration 1).

## 3. Event taxonomy

| type | emitted from | payload (small) |
|------|--------------|-----------------|
| `gateway` | `gatewayHealth.js` on state transition | `{ peerId, name, status, alive }` |
| `peer` | `peerStatus.js` on poll diff | `{ peerId, name, connected, handshakeAge }` |
| `activity` | `activity.js` on new log row | `{ id, eventType, message, severity, createdAt }` |
| `monitor` | `monitor.js` result change | `{ routeId, domain, status }` |
| `monitor` | `circuitBreaker.js` open/close | `{ routeId, circuit }` |

Payloads carry just enough to update a widget; the client refetches detail if
it needs more. Each emit call sits at the **existing** state-change site — no
new polling loop is introduced.

## 4. Reconnect strategy (YAGNI)

No server-side replay buffer and no `Last-Event-ID` handling in iteration 1.
`EventSource` reconnects automatically; the client's `open` handler refetches
the current page state, which reconciles any events missed during a
disconnect. This keeps the server stateless per connection.

## 5. Auth & licence

- **Auth:** `requireAuth`. Only authenticated sessions receive the stream.
  `GET` ⇒ no CSRF concern.
- **Licence:** Community feature, available in every mode. Registered in the
  feature schema with `COMMUNITY_FALLBACK = enabled`; no Pro guard. (Client
  push and external fan-out in later iterations may be Pro-gated.)

## 6. Error handling & resources

- `publish` is a no-op when `subscriberCount() === 0`.
- A subscriber that throws is caught and logged (pino `warn`); other
  subscribers and the emitting service are unaffected.
- SSE write failure (client vanished) → unsubscribe + clear keepalive + end.
- Connections are tracked only implicitly via bus subscribers; no global cap
  needed (admin sessions are few). `EventEmitter` max-listeners raised to avoid
  spurious warnings.

## 7. Caddy / proxy considerations

The admin UI is served through the server's own Caddy. Caddy auto-flushes
`text/event-stream` responses; the `X-Accel-Buffering: no` header and the 25 s
keepalive comment further guard against buffering / idle resets. No Caddy
config change required.

## 8. Files

**New**
- `src/services/eventBus.js`
- `src/routes/api/events.js`
- `public/js/events.js`
- `tests/eventBus.test.js`
- `tests/api_events.test.js`
- `docs/feature-realtime-events.md`

**Modified**
- `src/services/gatewayHealth.js`, `peerStatus.js`, `activity.js`,
  `monitor.js`, `circuitBreaker.js` — add one `eventBus.publish(...)` at the
  existing state-change site each.
- `src/routes/api/index.js` — mount `/events` (outside the `apiLimiter`).
- Page templates for Dashboard, Peers, Gateway-Pools, Logs — include
  `events.js`.
- `ROADMAP.md` — committed in the same change set.

## 9. Testing

- `tests/eventBus.test.js` — publish/subscribe, listener isolation (one
  throwing listener doesn't stop others), no-op with zero subscribers,
  unsubscribe.
- `tests/api_events.test.js` (supertest) — `401` without session; with a
  session, a `publish()` after connect arrives in the stream framed as
  `event: <type>` + `data:`; `req` close unsubscribes.
- Holds the CI 40 %-line coverage gate; new code is exercised by the above.

## 10. Documentation

`docs/feature-realtime-events.md` per the project convention (markdown doc on
completion).

## 11. Out of scope (tracked for later)

- Client push subscription (Windows/Android) — roadmap #1, phase 2.
- External notification fan-out — roadmap #7.
- Event persistence / replay.
