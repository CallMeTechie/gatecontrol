# Real-time Events (SSE) — Iteration 1

Live admin-UI updates over a single Server-Sent-Events stream, replacing pure polling for gateway, peer, activity and monitor changes.

## How it works

```
service state-change → eventBus.publish(type, payload)
                          → GET /api/v1/events (SSE, session-authed)
                          → public/js/events.js  → document CustomEvent  gc:<type>
                          → each page's existing refresh function
```

- **`src/services/eventBus.js`** — in-process singleton (`publish`, `subscribe(listener, filter?)`, `unsubscribe`, `subscriberCount`). Subscriber errors are isolated; `publish` is a no-op with zero subscribers. The optional `filter` predicate is the per-connection authorization hook (pass-all today; reserved for scoped views).
- **`GET /api/v1/events`** — `text/event-stream`, guarded by `requireAuth` (session). Mounted in `src/routes/index.js` **before** the `/api/v1` `apiLimiter` mount so the long-lived stream isn't rate-limited. Backpressure is **drain-or-close** (pause on `res.write()===false`, resume on `'drain'`, close after 30 s if stuck) — never a silent drop. A 25 s `: ping` keepalive (skipped while paused) survives proxy idle timeouts.
- **`GET /api/v1/ping`** — cheap authed probe the client uses to distinguish session-expiry from transient errors.

## Event types

| `gc:` event | source | payload |
|---|---|---|
| `gc:gateway` | `gatewayHealth.evaluatePeer` | `{ peerId, alive, transition }` |
| `gc:peer` | `peerStatus` online/offline transition | `{ peerId, name, connected }` |
| `gc:activity` | `activity.log` (every row) | `{ id, eventType, message, severity, createdAt }` |
| `gc:monitor` | `monitor.checkRoute` route-status / circuit | `{ routeId, domain, status }` or `{ routeId, domain, circuit }` |
| `gc:reconnected` | client, on (re)connect | — (pages refetch state) |

Payloads are small refresh-triggers: the client dispatches a `gc:*` DOM event and each page calls its existing refresh function (`loadLogs`, `refreshAll`, `loadPeers`, `loadRoutes`). No new rendering logic.

## Client behaviour (`public/js/events.js`)

- Bounded exponential backoff with jitter (1→2→5→15 s cap); does **not** rely on the browser's infinite native retry.
- After 3 consecutive failures it probes `/api/v1/ping`: **only an exact `401`** means the session expired → redirect to `/login` and stop. `429`/`5xx`/network are transient → keep retrying. This prevents both a 401 reconnect storm and a false logout.
- On (re)connect the page refetches its current state (`gc:reconnected`), reconciling anything missed while disconnected. No server-side replay buffer.
- Loaded globally via `templates/{default,pro}/layout.njk`. The login page is a standalone template (doesn't extend the layout), so the client never runs unauthenticated.

## Scope & licence

- **Iteration 1 is an enhancement, not a load-reduction.** Existing pollers (peer 30 s, monitor, traffic 60 s, dashboard/logs intervals) are **retained** as a safety net — the UI stays correct if the stream drops.
- Community feature, available in all licence modes (`COMMUNITY_FALLBACK.realtime_events = true` in `src/services/license.js`); no Pro gate.
- **Out of scope (future):** client (Windows/Android) push, external fan-out (ntfy/Discord/webhooks), event replay, per-user scoped event filtering.

## Verification

- Unit/integration: `tests/eventBus.test.js`, `tests/api_events.test.js` (raw `http` client — not supertest, which would hang on a stream).
- Manual end-to-end (confirms Caddy isn't buffering): with a valid admin cookie,
  `curl -N -H "Cookie: gc.sid=<sid>" https://<host>/api/v1/events`, then trigger a change and watch framed `event:` lines arrive incrementally.

_Design + plan: `docs/superpowers/specs/2026-05-24-realtime-event-bus-design.md`, `docs/superpowers/plans/2026-05-24-realtime-event-bus.md`._
