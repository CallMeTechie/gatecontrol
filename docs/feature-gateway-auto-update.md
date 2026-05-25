# Gateway Auto-Update (admin-triggered)

Roadmap #2b. Lets an admin force a home gateway to pull the latest image and recreate
itself from the web UI — no SSH — using the project's `update.sh` pattern over the existing
server→companion push channel. No Watchtower, no `docker.sock` in the container.

## How it works

```
[Admin] "Update auf X" on the /gateways detail view
   │ POST /api/v1/gateways/:id/update    (session + CSRF; Community feature gateway_fleet)
   ▼
[Server] generate request_id (uuid); record gateway_meta.{update_request_id,
         update_requested_at(server clock), update_target_version}; activity-log the actor;
         notifySelfUpdate(peerId, {request_id, target_version})
   │ POST http://<peer-ip>:<api_port>/api/self-update   (X-Gateway-Token over the tunnel)
   ▼
[Companion] writes /state/pending-update {request_id, target_version, …}; 200 {queued:true}
   │   (dedupes a repeated request_id; 60s post-success cooldown; 500 if /state not writable)
   ▼   host systemd .path (Linux) or DSM Task Scheduler (Synology) sees the flag
[Host] deploy/update.sh: flock → consume flag → docker compose pull → up -d --force-recreate
       (detached) → health-gate → on failure: digest-pinned rollback override → write
       /state/last-pull {request_id, pulled_at, image_digest, ok}
   ▼   next heartbeat
[Companion] telemetry relays image_digest, last_pull_at, last_pull_ok, last_pull_request_id,
            state_dir_writable, pending_update
   ▼
[Server] _deriveUpdateState matches last_pull_request_id === update_request_id (skew-proof)
   ▼
[Detail view] lifecycle banner (updating/done/failed/unknown) + image digest + "letztes Pull vor X"
```

## Update lifecycle (server-tracked, request_id-matched)

Completion is decided by **string equality on `request_id`**, never by comparing the host clock
(`last_pull_at`) against the server clock (`update_requested_at`) — that would be unsound across
unsynchronized clocks (e.g. a Synology without NTP). Timestamps are used only for display and the
server-clock-only timeout.

- **idle** — no request outstanding.
- **updating** — request set, no matching `last_pull_request_id` yet, within `UPDATE_TIMEOUT_MS`
  (default 15 min). Button disabled.
- **done** — matching request_id + `last_pull_ok===true` + reported `gateway_version` satisfies the
  target (the reported version must always parse — an `unknown` build is never "done"). Columns cleared.
- **failed / rolled-back** — matching request_id + `last_pull_ok===false` or version not satisfied.
- **unknown (sticky)** — no match past the timeout. Identifiers are NOT cleared, so a late matching
  heartbeat still reconciles to done/failed; the UI offers a "Verwerfen" affordance.

Because the companion cannot phone home a failure on a broken image (no tunnel → no heartbeat), the
**server owns the lifecycle**: the timeout makes that case observable as "unknown" rather than a
silent spinner.

## The `/state` volume

The companion mounts `/config` read-only (config is server-pushed; the companion must not mutate
it). The flag + last-pull marker are runtime-writable, so they live in a separate
`./gateway-state:/state` (rw) bind mount — writable even though the container runs `read_only: true`
(read_only locks only the rootfs). Path overridable via `GATEWAY_STATE_DIR` (default `/state`).

## Rollback

Compose pins `:latest`; after `pull`, `:latest` is the new (possibly broken) image. So `update.sh`
captures the previous image's `RepoDigests[0]` before pulling and, on health failure, writes a
`docker-compose.rollback.yml` override pinning `image: <repo>@sha256:<old>` and recreates with it.
The override persists (so `restart:` doesn't re-pull `:latest`) until the next successful update
removes it. If the previous image has no repo digest (locally built), rollback is skipped and the
server resolves the request to "unknown".

## Security

- No `docker.sock` anywhere. The companion can only write a flag file in `/state`; `update.sh`
  only ever pulls + recreates the known compose service — the flag content is advisory, never executed.
- The companion route sits behind the same timing-safe `X-Gateway-Token` auth as `/api/wol`.
- Anti-DoS: the companion ignores a repeat `request_id` and any request within 60s of a successful
  pull (recreate-loop guard); a fresh `request_id` always queues.
- Server endpoint: session + CSRF + `gateway_fleet` feature gate. The actor audit is server-side
  (`activity.log('gateway_update_requested')`).
- Trust root: GHCR image integrity + the compose tag; the server verifies the reported version
  advanced. (Pinning the target by digest is a future hardening.)

## Migration / rollout (sequenced)

The feature only works once the gateway side is in place, and the server UI button is gated on the
gateway reporting `state_dir_writable`, so a half-migrated gateway simply shows a disabled button.

1. Ship the companion image (gateway repo) with the `selfUpdate` route + telemetry.
2. On each gateway host: add the `./gateway-state:/state` mount and recreate the container
   **detached with auto-rollback** (on a Synology the SSH session traverses this gateway).
3. Install the host trigger (Linux systemd `.path`+`.service`, or a Synology DSM Task Scheduler
   entry polling every 1–2 min) and **dry-run verify** (write a known flag → confirm it was consumed
   and `last-pull` was written). See the gateway repo's `docs/auto-update.md`.
4. Deploy the server. The "Update" button auto-enables once a gateway's heartbeat reports
   `state_dir_writable`.

## Files

**Server (`gatecontrol`):** `src/db/migrationList.js` (migration v44), `src/services/gateways.js`
(`notifySelfUpdate`, `markUpdateRequested`, `_clearUpdateTracking`, `_deriveUpdateState`,
`_normalizeTargetVersion`), `src/routes/api/gateways.js` (`POST /:id/update` + `update_state` in the
list), `public/js/gateways.js` (button + banner + image/last-pull rows), `src/i18n/{en,de}.json` +
both `layout.njk` GC.t whitelists.

**Companion (`gatecontrol-gateway`):** `src/config.js` (`stateDir`), `src/api/routes/selfUpdate.js`,
`src/bootstrap.js` (registration), `src/health/telemetry.js` (relay), `deploy/update.sh`,
`deploy/systemd/*`, `docker-compose.example.yml` (`/state`), `docs/auto-update.md`.

## Out of scope / future

Scheduled/automatic updates (this is admin-triggered only); per-gateway update channels
(stable/beta/pinned); "update all" batch; target digest-pinning.
