# Gateway Auto-Update (admin-triggered, Option A) — Design

**Date:** 2026-05-25
**Status:** Approved (design) — refined v2 after devil's-advocate → pending spec review → plan → implementation
**Roadmap:** #2b (decomposed from #2 Gateway Fleet Dashboard)
**Repos:** server (`/root/gatecontrol`) + gateway companion (`/root/gatecontrol-gateway`)
**Tier:** Community (part of `gateway_fleet`)

## Goal

Let an admin force a gateway to pull a target version and recreate itself from the GateControl
web UI — no SSH — using the project's `update.sh` pattern and the existing server→companion push
channel, **with a server-tracked update lifecycle so the admin can actually see whether it
worked**. No Watchtower, no `docker.sock` in the container.

## Approach (decided)

**Option A — flag-file + host automation.** The companion cannot restart its own container, so
the host does it. Server pushes a self-update request (carrying the **target version**) to the
companion over the tunnel; the companion writes a flag file into a **writable `/state` volume**;
a host trigger (systemd `.path` on Linux, DSM Task Scheduler on Synology) runs `update.sh`, which
pulls + recreates detached, health-checks, **rolls back on failure**, and records the result.

Rejected: `docker.sock` in the companion (root-equivalent host access from a tunnel-reachable
container; the self-recreate still needs a detached helper = `update.sh`). Rejected earlier:
Watchtower (unmaintained; user declined).

## Key correctness principles (from devil's-advocate review)

1. **The companion cannot self-report failure on a broken image** (no tunnel → no heartbeat).
   Therefore the **server owns the update lifecycle**: it records the request + target, and a
   **timeout** decides "done / rolled-back / unknown" by observing subsequent heartbeats — it
   does not trust the companion to phone home a failure.
2. **There must be a single source of truth for the target.** The request carries
   `target_version`; the server verifies the *reported* `gateway_version` advanced to (≥) it.
   The button copy is honest about pulling the newest published version.
3. **`update.sh` is new logic, not a copy.** The server's `/opt/gatecontrol/update.sh` has **no
   rollback, no lockfile, no real health gate** — this script adds all three and must be tested
   on a DSM box including the *failure* path.
4. **Half-migrated gateways must be detectable.** The companion reports `state_dir_writable`; the
   UI only enables the button when the gateway is migrated (mount + host task present).

## Data flow

```
[Admin] "Auf neueste Version (X) aktualisieren" on /gateways detail view (only enabled if
        gateway reports state_dir_writable; disabled while an update is in-flight)
   │ POST /api/v1/gateways/:id/update   (session + CSRF; feature gateway_fleet)
   ▼
[Server] record gateway_meta.update_requested_at=now, update_target_version=X;
         activity.log('gateway_update_requested', actor=session user)
         gateways.notifySelfUpdate(peerId, { target_version: X })
   │ POST http://<peer_ip>:<api_port>/api/self-update   (X-Gateway-Token; 5s; best-effort)
   │     body { target_version: X }
   ▼
[Companion] POST /api/self-update:
   - if /state not writable → 500 {error:'state_unavailable'}
   - if a managed pull happened < 60s ago (anti recreate-loop) → 200 {ok:true, skipped:'cooldown'}
   - else write /state/pending-update {target_version, requested_at, triggered_via:'server-push'}
   - respond {ok:true}
   ▼  (systemd .path watches the file / DSM task polls it every 1–2 min)
[Host] update.sh  (flock on persistent host path; consume-flag-on-lock semantics):
   - resolve container: CID=$(docker compose ps -q gateway)
   - OLD_DIGEST=$(docker inspect --format '{{.Image}}' "$CID")
   - read target from /state/pending-update; remove the flag NOW (capture intent; late triggers
     create a fresh flag for the next cycle rather than being clobbered)
   - docker compose pull
   - docker compose up -d --force-recreate gateway   (detached; survives tunnel/SSH teardown)
   - wait for health: poll .State.Health.Status, honoring start-period (60s) + interval (60s),
     hard ceiling ~5 min
   - on healthy → ok=true; on unhealthy/timeout → roll back: re-pin OLD_DIGEST and up -d, ok=false
   - write /state/last-pull {pulled_at, image_digest, version, target_version, ok}
   ▼  (next heartbeat from the new/rolled-back container)
[Companion] collectTelemetry() reads /state/last-pull → image_digest, last_pull_at, last_pull_ok,
            and reports state_dir_writable + pending_update(bool)
   ▼
[Server] heartbeat persists telemetry; derives update status (below)
   ▼
[Detail view] shows lifecycle state + running digest + "letztes Pull vor <Xh>"
```

## Update lifecycle (server-tracked state) — addresses DA #1, #4

`gateway_meta` gains two columns: `update_requested_at` (epoch ms, nullable) and
`update_target_version` (text, nullable). The list/detail API derives a transient
`update_state` per gateway (no new persistence beyond the two columns):

- **idle** — `update_requested_at` null.
- **requested/updating** — `update_requested_at` set, and *not yet* satisfied: the gateway has
  not reported a `last_pull_at` newer than `update_requested_at`. UI: "Update läuft (angestoßen
  vor Xm)", button disabled.
- **done** — telemetry shows `last_pull_at > update_requested_at` **and** `last_pull_ok === true`
  **and** reported `gateway_version` ≥ `update_target_version`. Server clears the two columns.
  UI: brief "Aktualisiert auf <v>".
- **rolled-back / failed** — `last_pull_at > update_requested_at` with `last_pull_ok === false`
  **or** version did not advance. UI: "Update fehlgeschlagen — auf <v> zurückgerollt". Clear cols.
- **timeout/unknown** — `now - update_requested_at` > `UPDATE_TIMEOUT_MS` (default 10 min:
  DSM poll + pull + health wait + margin) with no satisfying heartbeat. UI: "Status unbekannt —
  Gateway prüfen". Clear cols (so the button re-enables).

This makes the broken-image case (companion never comes back) **observable as a timeout**, not a
silent spinner, without trusting the companion to self-report failure.

## Why a separate `/state` volume

`docker-compose.example.yml` mounts `./config:/config:ro` (read-only by design — config is
server-pushed; companion must not mutate it). Flag + last-pull marker are runtime-writable, so a
**new `./gateway-state:/state` (rw)** mount holds them. `/config` stays read-only. Path overridable
via `GATEWAY_STATE_DIR` (default `/state`), mirroring `GATEWAY_ENV_PATH`.

## Components

### Server (`/root/gatecontrol`)

**`src/services/gateways.js`**
- `notifySelfUpdate(peerId, { target_version })` — mirrors `notifyWol` (gateways.js:378): resolve
  `push_token_encrypted` + `_peerIp` + `api_port`; `http.request` `POST /api/self-update` with
  `X-Gateway-Token`, JSON body `{ target_version }`, 5s timeout, best-effort; returns `{ok, skipped?}`.
- `markUpdateRequested(peerId, targetVersion)` / `_deriveUpdateState(gatewayRow, health)` helper +
  clearing logic on terminal states. Migration adds the two `gateway_meta` columns.

**`src/routes/api/gateways.js`**
- `POST /:id/update` — session+CSRF, peer exists + enabled gateway (else 404), `gateway_fleet`
  feature (else 403). Reject if gateway telemetry lacks `state_dir_writable` (409 "not migrated").
  `markUpdateRequested` then `notifySelfUpdate`. Returns `{ok, queued}`. Activity-log actor.
- `GET '/'` already returns health+telemetry; add derived `update_state` + `update_target_version`
  per gateway.

**`public/js/gateways.js`**
- Detail "Update"-element → button (`data-act="update"`, `data-id`); shown only when telemetry
  `state_dir_writable`; disabled while `update_state` ∈ {requested,updating}. Click → `confirm()` →
  `POST /api/v1/gateways/:id/update` with `X-CSRF-Token`; toast "Update angefordert (kann einige
  Minuten dauern)". Secondary "Release-Notes" link to GitHub stays.
- "Versionen & System" gains `image_digest` (short) + `last_pull_at` ("letztes Pull vor <ago>" /
  "nie"). Header area renders the `update_state` banner when not idle.

**`src/i18n/{en,de}.json` + both `layout.njk` GC.t whitelists** — new flat keys:
`gateways.update_confirm`, `gateways.update_requested`, `gateways.update_running`,
`gateways.update_done`, `gateways.update_failed`, `gateways.update_unknown`,
`gateways.update_not_migrated`, `gateways.release_notes`, `gateways.lbl_image_digest`,
`gateways.lbl_last_pull`, `gateways.last_pull_never`. (de+en, wired through `window.GC.t`.)

### Gateway companion (`/root/gatecontrol-gateway`)

**`src/api/routes/selfUpdate.js`** (new, mirrors `configChanged.js`) — parse `target_version`
(string, optional); if `stateDir` not writable → 500 `state_unavailable`; if `/state/last-pull`
`pulled_at` < 60s ago → 200 `{ok:true, skipped:'cooldown'}` (anti recreate-loop, DA #6); else
`fs.writeFile('/state/pending-update', {target_version, requested_at, triggered_via:'server-push'})`
mode 0o600 → 200 `{ok:true}`. Registered in `bootstrap.js` mergeRouter with `stateDir`
(auth applied by `/api` mount). Add `GATEWAY_STATE_DIR` (default `/state`) to `src/config.js`.

**`src/health/telemetry.js`** — `collectTelemetry()` gains: `image_digest`, `last_pull_at`,
`last_pull_ok` (from `/state/last-pull`, errors→null), `state_dir_writable` (probe `/state` write
access once at startup or via `fs.access`), `pending_update` (bool: flag file exists).

**`deploy/update.sh`** (new — **new logic, not a copy**; DA #3, #5):
- `COMPOSE_DIR` from script dir (env-overridable); require `docker-compose.yml`.
- `flock` on a **persistent host path** (e.g. `$COMPOSE_DIR/.update.lock`), non-blocking — exit if held.
- `CID=$(docker compose ps -q gateway)`; `OLD_DIGEST=$(docker inspect --format '{{.Image}}' "$CID")`.
- Read `/state/pending-update`; `rm -f` it immediately after reading (consume-on-lock).
- `docker compose pull`.
- `docker compose up -d --force-recreate gateway` (detached).
- Health wait: poll `.State.Health.Status` until `healthy`, allowing `starting` through the
  60s start-period; hard ceiling ~300s.
- On `unhealthy`/timeout → rollback: `docker tag "$OLD_DIGEST" <image>:rollback` (or pin old
  digest in an override) + `up -d --force-recreate`; `ok=false`.
- Write `/state/last-pull` `{pulled_at, image_digest:<new running digest>, version, target_version, ok}`.
- Exit 0. (Idempotent; second activation while running is serialized by flock.)

**`deploy/systemd/`** (new) — `gatecontrol-gateway-update.service` (oneshot → update.sh) +
`gatecontrol-gateway-update.path` (`PathChanged=/state/pending-update`). Linux: near-instant.

**`docker-compose.example.yml`** — add `- ./gateway-state:/state` (rw) + comment.

**`docs/auto-update.md`** (new) — host setup: (a) Linux systemd `.path`+`.service`; (b) Synology
DSM Task Scheduler (user script every 1–2 min runs update.sh). Documents poll latency, the
lockfile, **and a dry-run verification** (write a known flag, confirm update.sh consumed it).

## Security — addresses DA #6

- No `docker.sock` anywhere. Companion only writes a flag in `/state`; flag content is **advisory
  metadata, never executed** by `update.sh`.
- New companion route behind the same timing-safe `X-Gateway-Token` auth as `/api/wol`.
- Anti-DoS: companion ignores a new flag within 60s of the last managed pull (recreate-loop guard).
- Server endpoint: session + CSRF + `gateway_fleet`; actor audit is server-side
  (`activity.log`), **not** the companion flag's `triggered_via` (which is constant `server-push`).
- **Trust root:** auto-update security reduces to GHCR image integrity + the compose tag. The
  honest button pulls the newest published version; the server verifies the *reported version
  advanced*. (Digest-pinning the target is listed under future hardening.)

## Error handling / edge cases

- Companion unreachable on push → `notifySelfUpdate` returns `{ok:false}`; endpoint 200
  `{queued:false}`; UI "Gateway nicht erreichbar"; `update_requested_at` still set → resolves via
  timeout if nothing happens.
- `/state` not mounted → companion 500 `state_unavailable`; button is hidden anyway (no
  `state_dir_writable`).
- New image broken → `update.sh` rolls back; even if it can't, server marks **timeout/unknown**.
- `/state/last-pull` missing/corrupt → telemetry nulls; detail shows "—"/"nie".
- Double-click / concurrent → idempotent flag; `flock` serializes; consume-on-lock avoids lost
  triggers; button disabled while in-flight.

## Testing

**Server** (node:test, `NODE_ENV=test`, hold 40% c8):
- `notifySelfUpdate`: stub `http.request`; assert path `/api/self-update`, `X-Gateway-Token`,
  decrypted token, JSON `{target_version}`, timeout; error → `{ok:false}`.
- `POST /:id/update`: 200 happy (stub notify + telemetry has `state_dir_writable`), 404 unknown/
  non-gateway, 403 `gateway_fleet` off, 409 not-migrated, CSRF enforced.
- `_deriveUpdateState`: idle/updating/done/failed/timeout from synthetic
  `update_requested_at` + telemetry (`last_pull_at`, `last_pull_ok`, `gateway_version`).
- i18n parity (en/de).

**Companion** (existing runner):
- `selfUpdate`: writes flag to temp `stateDir` → 200; non-writable → 500; cooldown skip → 200
  `{skipped}`; requires `X-Gateway-Token`.
- `collectTelemetry`: reads `/state/last-pull` (present→fields; missing→null); `state_dir_writable`
  true/false; `pending_update` reflects flag presence.

**Host** `update.sh`: documented manual verification on a DSM box, **including the rollback/failure
path**; CI shellcheck if present.

## Deployment — sequenced rollout (addresses DA #7)

1. Ship companion image (gateway repo CI → GHCR) containing `selfUpdate` route + telemetry.
2. **nas3 gateway compose migration:** add `./gateway-state:/state`; recreate **detached with
   auto-rollback** (reuse the existing nas3 procedure — SSH traverses this gateway).
3. Install the host trigger on nas3 (DSM task), then **dry-run verify**: write a known
   `pending-update` flag, confirm `update.sh` consumed it + wrote `last-pull`.
4. Ship server image (server CI), deploy to /opt/gatecontrol. The button auto-enables once the
   gateway's heartbeat reports `state_dir_writable`.

## Out of scope / future hardening

- Scheduled/automatic updates (this is **admin-triggered** only).
- Per-gateway channels (stable/beta/pinned tag).
- "Update all" batch action (single gateway per click).
- **Digest-pinning the target** (server resolves the target version → GHCR digest, host pulls by
  digest, verifies before recreate). Stronger supply-chain guarantee; deferred — current design
  verifies the *reported version advanced* instead.
