# Gateway Auto-Update (admin-triggered, Option A) — Design

**Date:** 2026-05-25
**Status:** Approved (design) — v3 after two devil's-advocate rounds → pending spec review → plan
**Roadmap:** #2b (decomposed from #2 Gateway Fleet Dashboard)
**Repos:** server (`/root/gatecontrol`) + gateway companion (`/root/gatecontrol-gateway`)
**Tier:** Community (part of `gateway_fleet`)

## Goal

Let an admin force a gateway to pull a target version and recreate itself from the GateControl
web UI — no SSH — using the project's `update.sh` pattern and the existing server→companion push
channel, **with a server-tracked, clock-skew-proof update lifecycle so the admin can actually see
whether it worked**. No Watchtower, no `docker.sock` in the container.

## Approach (decided)

**Option A — flag-file + host automation.** The companion cannot restart its own container, so
the host does it. Server pushes a self-update request (carrying a **`request_id` + target
version**) to the companion over the tunnel; the companion writes a flag file into a **writable
`/state` volume**; a host trigger (systemd `.path` on Linux, DSM Task Scheduler on Synology) runs
`update.sh`, which pulls + recreates detached, health-checks, **rolls back to a digest-pinned old
image on failure**, and records the result (echoing the `request_id`).

Rejected: `docker.sock` in the companion; Watchtower. (See parked-feature notes.)

## Correctness keystones (from two DA rounds)

1. **Completion is matched by `request_id`, never by comparing clocks.** The server issues a
   `request_id` (uuid) per click; it flows request→flag→`update.sh`→`last-pull`→telemetry→server,
   which matches on **string equality**. `last_pull_at`/`update_requested_at` (different machines'
   clocks) are used **only** for the human "letztes Pull vor X" display and the server-clock-only
   timeout — never for completion. This is skew-proof and kills the stale-marker false-"done".
2. **Rollback must defeat `:latest`.** Compose pins `:latest`; after `pull`, `:latest` = the new
   (broken) image. Rollback writes a **digest-pinned override** (`image: …@sha256:<OLD>`), not a
   throwaway tag. Capture `RepoDigests[0]` before pull; if absent (locally-built) → fail loud.
3. **The companion cannot self-report failure on a broken image** → the **server owns the
   lifecycle** and a **timeout** (sticky, reconcilable) decides "unknown", not the dead companion.
4. **Cooldown guards loops, not admin intent.** A new `request_id` always queues; cooldown only
   suppresses a *repeat of the same* `request_id`. `skipped:'cooldown'` ⇒ server `queued:false`
   (does not enter "updating").
5. **`update.sh` is new logic** (the server's has no rollback/lock/health gate) — tested on DSM
   incl. the failure path.
6. **Half-migrated gateways are detectable** via telemetry `state_dir_writable`; the button is
   only enabled when migrated.

## Data flow

```
[Admin] "Auf neueste Version (X) aktualisieren"  (enabled only if state_dir_writable;
        disabled while update_state ∈ {updating}; X = server-normalized concrete version)
   │ POST /api/v1/gateways/:id/update   (session + CSRF; feature gateway_fleet)
   ▼
[Server] rid = uuid();  set gateway_meta.update_request_id=rid,
         update_requested_at=now(server clock), update_target_version=X;
         activity.log('gateway_update_requested', actor=session user)
         gateways.notifySelfUpdate(peerId, { request_id: rid, target_version: X })
   │ POST http://<peer_ip>:<api_port>/api/self-update   (X-Gateway-Token; 5s; best-effort)
   │     body { request_id: rid, target_version: X }
   ▼
[Companion] POST /api/self-update:
   - /state not writable → 500 {error:'state_unavailable'}
   - last-pull.request_id === rid (already handled) OR (last-pull.ok && pulled_at <60s ago) →
     200 {ok:true, skipped:'cooldown'}        // only repeats / post-success loops
   - else write /state/pending-update {request_id:rid, target_version:X, requested_at,
     triggered_via:'server-push'}  → 200 {ok:true, queued:true}
   ▼  (systemd .path watches the file / DSM task polls it every 1–2 min)
[Host] update.sh  (non-blocking flock on $COMPOSE_DIR/.update.lock):
   - CID=$(docker compose ps -q gateway | head -1)
   - OLD_DIGEST=$(docker inspect --format '{{index .RepoDigests 0}}' "$CID")   # repo@sha256
   - read RID+target from /state/pending-update; rm -f the flag now (consume-on-lock)
   - docker compose pull
   - docker compose up -d --force-recreate gateway        # detached; survives tunnel teardown
   - health wait: re-resolve CID (head -1, retry on empty/double); poll .State.Health.Status,
     treat `starting` as not-failed through the image start-period (60s, inherited from Dockerfile,
     NOT in compose); hard ceiling ~300s
   - healthy → ok=true; else rollback: write docker-compose.rollback.yml {image: <repo>@sha256:OLD},
     `up -d -f docker-compose.yml -f docker-compose.rollback.yml --force-recreate gateway`; ok=false
     (leave override in place so restart: doesn't re-pull :latest; next success removes it)
   - write /state/last-pull {request_id:RID, pulled_at, image_digest:<running>, version, ok}
   ▼  (next heartbeat from the new / rolled-back container)
[Companion] telemetry relays: image_digest, last_pull_at, last_pull_ok, last_pull_request_id,
            plus state_dir_writable + pending_update(bool)
   ▼
[Server] persists telemetry; derives update_state by request_id match (below)
   ▼
[Detail view] lifecycle banner + running digest + "letztes Pull vor <Xh>"
```

## Update lifecycle (server-tracked, request_id-matched)

`gateway_meta` gains: `update_request_id` (text, nullable), `update_requested_at` (epoch ms,
server clock), `update_target_version` (text). `_deriveUpdateState(row, telemetry)`:

- **idle** — `update_request_id` null.
- **updating** — `update_request_id` set; telemetry `last_pull_request_id !== update_request_id`;
  `now - update_requested_at ≤ UPDATE_TIMEOUT_MS`. UI: "Update läuft (vor Xm angestoßen)", button disabled.
- **done** — `last_pull_request_id === update_request_id` **and** `last_pull_ok === true` **and**
  reported `gateway_version` satisfies target (see classifier). Server clears the three columns.
  UI: "Aktualisiert auf <v>".
- **failed / rolled-back** — `last_pull_request_id === update_request_id` and (`last_pull_ok ===
  false` **or** version not satisfied/unverifiable). Clear columns. UI: "Update fehlgeschlagen —
  auf <v> zurückgerollt".
- **unknown (sticky)** — no matching `last_pull_request_id` and `now - update_requested_at >
  UPDATE_TIMEOUT_MS`. **Do not clear identifiers** — a late matching heartbeat still reconciles to
  done/failed. UI: "Status unbekannt — Gateway prüfen" + a "Verwerfen" affordance that clears.

`UPDATE_TIMEOUT_MS` configurable, default **15 min** (cold pull on residential uplink + 5-min
health ceiling + DSM poll). Timeout uses the **server clock only** (`update_requested_at`).

**Version classifier** (`gateway_version` vs `update_target_version`): use `compareVersions`
(src/utils/version.js). `update_target_version` is **normalized server-side at request time** to a
concrete parseable version (resolve "latest" → the concrete release the button showed). Treat
"satisfied" as `compareVersions(reported, target) >= 0` **only when both parse to numeric tuples**;
if `reported` is `unknown`/null/unparseable, classify **failed** (not done) — never let an
unverifiable build show green. (With request_id as the gate, version is a secondary assertion.)

## Why a separate `/state` volume

`docker-compose.example.yml` mounts `./config:/config:ro` (config is server-pushed; companion must
not mutate it). Flag + last-pull marker are runtime-writable → new **`./gateway-state:/state` (rw)**.
Path overridable via `GATEWAY_STATE_DIR` (default `/state`), mirroring `GATEWAY_ENV_PATH`.

## Components

### Server (`/root/gatecontrol`)

**`src/services/gateways.js`**
- `notifySelfUpdate(peerId, { request_id, target_version })` — mirrors `notifyWol` (gateways.js:378);
  `POST /api/self-update` with `X-Gateway-Token`, JSON body, 5s, best-effort; returns
  `{ok, queued, skipped?}` (propagates companion `skipped:'cooldown'`).
- `markUpdateRequested(peerId, requestId, targetVersion)`; `_deriveUpdateState(row, telemetry)`
  + clear-on-terminal. Migration adds the three `gateway_meta` columns. `_normalizeTargetVersion`.

**`src/routes/api/gateways.js`**
- `POST /:id/update` — session+CSRF; 404 unknown/non-gateway; 403 `gateway_fleet` off; **409
  not-migrated** if telemetry lacks `state_dir_writable`. Generate `request_id`, normalize target,
  `markUpdateRequested`, `notifySelfUpdate`. If companion returns `skipped:'cooldown'` →
  **do not** mark requested; respond `{ok:true, queued:false, reason:'cooldown'}`. Else
  `{ok:true, queued:true}`. Activity-log actor.
- `GET '/'` adds derived `update_state` + `update_target_version` per gateway (clears terminal cols).

**`public/js/gateways.js`**
- Detail "Update" → button (`data-act="update"`); shown only when telemetry `state_dir_writable`;
  disabled while `update_state==='updating'`. Click → `confirm()` → `POST …/update` with
  `X-CSRF-Token`; toast per `queued` vs `cooldown`. Header renders the `update_state` banner
  (updating/done/failed/unknown). "Versionen & System" adds `image_digest` (short) +
  `last_pull_at` ("letztes Pull vor <ago>"/"nie"). Secondary GitHub "Release-Notes" link stays.

**`src/i18n/{en,de}.json` + both `layout.njk` GC.t** — flat keys: `gateways.update_confirm`,
`gateways.update_requested`, `gateways.update_running`, `gateways.update_done`,
`gateways.update_failed`, `gateways.update_unknown`, `gateways.update_dismiss`,
`gateways.update_cooldown`, `gateways.update_not_migrated`, `gateways.release_notes`,
`gateways.lbl_image_digest`, `gateways.lbl_last_pull`, `gateways.last_pull_never`. (de+en.)

### Gateway companion (`/root/gatecontrol-gateway`)

**`src/api/routes/selfUpdate.js`** (new, mirrors `configChanged.js`) — parse `{request_id,
target_version}`; `/state` not writable → 500 `state_unavailable`; if existing `/state/last-pull`
has `request_id === incoming` (already handled) **or** (`last_pull.ok && pulled_at <60s`) → 200
`{ok:true, skipped:'cooldown'}`; else write `/state/pending-update` {request_id, target_version,
requested_at, triggered_via} mode 0o600 → 200 `{ok:true, queued:true}`. Registered in
`bootstrap.js` mergeRouter with `stateDir` (auth via `/api` mount). Add `GATEWAY_STATE_DIR`
(default `/state`) to `src/config.js`.

**`src/health/telemetry.js`** — `collectTelemetry()` adds: `image_digest`, `last_pull_at`,
`last_pull_ok`, `last_pull_request_id` (all from `/state/last-pull`, errors→null);
`state_dir_writable` (fs.access W_OK on stateDir); `pending_update` (flag file exists).

**`deploy/update.sh`** (new — **new logic**):
- `COMPOSE_DIR` from script dir (env-overridable); require `docker-compose.yml`.
- Non-blocking `flock $COMPOSE_DIR/.update.lock` (persistent path) — exit if held.
- `CID=$(docker compose ps -q gateway | head -1)`;
  `OLD_DIGEST=$(docker inspect --format '{{index .RepoDigests 0}}' "$CID")`; empty → log + skip rollback capability (fail loud later).
- Read `request_id`+`target` from flag; `rm -f` flag immediately (consume-on-lock).
- `docker compose pull`; `docker compose up -d --force-recreate gateway`.
- Health wait: re-resolve CID (`head -1`, retry empty/double); poll `.State.Health.Status`; allow
  `starting` through start-period; ceiling 300s.
- unhealthy/timeout → write `docker-compose.rollback.yml` (`image: <repo>@sha256:OLD_DIGEST`),
  `up -d -f docker-compose.yml -f docker-compose.rollback.yml --force-recreate gateway`; ok=false.
  (Override persists; a later successful update removes it.)
- Write `/state/last-pull` {request_id, pulled_at, image_digest:<running RepoDigest>, version, ok}.

**`deploy/systemd/`** — `…-update.service` (oneshot→update.sh) + `…-update.path`
(`PathExists=/state/pending-update` — re-arms after update.sh removes the flag, edge-triggering
on the next creation).

**`docker-compose.example.yml`** — add `- ./gateway-state:/state` (rw) + comment.

**`docs/auto-update.md`** — Linux systemd; Synology DSM Task Scheduler (poll 1–2 min); poll
latency; lockfile; **dry-run verify (write known flag → confirm consumed + last-pull written)**;
rollback-path test note.

## Security

- No `docker.sock`. Companion only writes a flag; content is **advisory, never executed**.
- New route behind timing-safe `X-Gateway-Token` (same as `/api/wol`).
- Anti-DoS: cooldown on repeat `request_id` / post-success <60s (does not block a fresh request).
- Server endpoint: session + CSRF + `gateway_fleet`; actor audit server-side (`activity.log`).
- Trust root: GHCR image integrity + compose tag; server verifies the *reported version*. (Target
  digest-pinning = future hardening.)

## Error handling / edge cases

- Companion unreachable → `notifySelfUpdate` `{ok:false}`; columns still set → resolves via
  timeout. `/state` unmounted → 500 + button hidden (no `state_dir_writable`).
- New image broken → digest-pinned rollback; if even that fails → server timeout → "unknown".
- "Already current" no-op → pull "up to date", recreate same version, `ok:true`, version satisfied
  → **done** (with honest "bereits aktuell" wording when version unchanged).
- Post-failure retry → new `request_id` → not cooled down → queues normally.
- `last-pull` missing/corrupt → telemetry nulls → detail "—"/"nie"; lifecycle stays updating→timeout.
- Slow pull > timeout → sticky "unknown", reconciled by late matching heartbeat (not hard-cleared).

## Testing

**Server** (node:test, `NODE_ENV=test`, 40% c8):
- `notifySelfUpdate`: stub `http.request`; path `/api/self-update`, `X-Gateway-Token`, body
  `{request_id,target_version}`, timeout; error→`{ok:false}`; propagates `skipped`.
- `POST /:id/update`: 200 queued, 200 `queued:false` on cooldown (no cols set), 404, 403
  `gateway_fleet`, 409 not-migrated, CSRF.
- `_deriveUpdateState`: idle/updating/done/failed/unknown via synthetic cols + telemetry
  (`last_pull_request_id`, `last_pull_ok`, `gateway_version`); **clock-skew case** (host `pulled_at`
  far past/future must NOT affect state — only request_id match does); unknown-version → failed;
  stale non-matching last_pull → stays updating, not done.
- `_normalizeTargetVersion`; i18n parity.

**Companion**:
- `selfUpdate`: writes flag (temp stateDir)→200 queued; non-writable→500; repeat request_id→
  `skipped`; post-success <60s→`skipped`; new request_id after failure→queues; requires token.
- `collectTelemetry`: reads `/state/last-pull` fields incl. `last_pull_request_id`; missing→null;
  `state_dir_writable`; `pending_update`.

**Host** `update.sh`: manual DSM verification incl. **rollback/failure path** (verify the override
actually pins the old digest and the container comes back); shellcheck if available.

## Deployment — sequenced rollout

1. Ship companion image (gateway CI → GHCR) with selfUpdate route + telemetry.
2. nas3 compose migration: add `./gateway-state:/state`; recreate **detached + auto-rollback**
   (SSH traverses this gateway).
3. Install host trigger (DSM task) + **dry-run verify** (known flag consumed, last-pull written).
4. Ship server image; deploy /opt/gatecontrol. Button auto-enables on `state_dir_writable` heartbeat.

## Out of scope / future hardening

- Scheduled/automatic updates (admin-triggered only); per-gateway channels; "update all" batch.
- **Target digest-pinning** (server resolves target version → GHCR digest; host pulls + verifies by
  digest before recreate). Stronger supply-chain guarantee; deferred — v3 verifies reported version.
