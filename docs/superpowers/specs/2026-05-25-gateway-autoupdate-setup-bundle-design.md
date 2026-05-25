# Gateway Auto-Update Setup Bundle — Design

**Date:** 2026-05-25
**Status:** Approved (design) — pending spec review → plan → implementation
**Builds on:** #2b (gateway auto-update). Server-only feature.
**Repo:** server (`/root/gatecontrol`)
**Tier:** Community (part of `gateway_fleet`)

## Goal

Make the per-gateway-host auto-update setup **self-service** from the gateway detail view: a
guide plus tailored downloads (a one-shot setup **script** and a **ZIP** of all files), with a
clear note that the auto-update button only works once this one-time host setup is done. Removes
the manual hand-holding we did for nas3.

## Why

The "Update" button is gated on the gateway reporting `state_dir_writable=true`, which requires a
host-side setup: add a writable `/state` volume, run an image with the self-update route
(≥1.10.0), drop `update.sh` next to the compose file, and install a periodic trigger (Synology DSM
Task Scheduler or Linux systemd `.path`). Today an admin has to be walked through it. This feature
ships that setup as a download from the UI.

## User experience (gateway detail view)

A new card **"Auto-Update einrichten"** (Set up auto-update) in the detail view:
- **Status line:** "✓ Eingerichtet" when telemetry `state_dir_writable === true`, else
  "⚠ Noch nicht eingerichtet".
- **Note (prominent when not set up):** "Der automatische Update-Button funktioniert erst, wenn
  dieses einmalige Host-Setup durchgeführt ist."
- **Two download buttons:** "⬇ Setup-Script" and "⬇ ZIP (alle Dateien)".
- **Collapsible step-by-step guide** with two host types: **Synology (DSM)** and **Linux (systemd)**.
- When `state_dir_writable === true`, the card renders collapsed/secondary ("bereits eingerichtet").

The downloads are anchor links to the two GET endpoints (browser downloads via
`Content-Disposition: attachment`). No client JS beyond rendering the card + links.

## Server

Two read endpoints under the existing `/api/v1/gateways` router (session-authed via `requireAuth`
on `/api/v1`; **no CSRF** needed — they're GET; `gateway_fleet` feature-gated; 404 for unknown/
non-gateway peer):

- `GET /:id/setup-script` → `text/plain; charset=utf-8`,
  `Content-Disposition: attachment; filename="gatecontrol-gateway-setup-<slug>.sh"`. Body = the
  tailored setup script (below).
- `GET /:id/setup-bundle.zip` → `application/zip`,
  `Content-Disposition: attachment; filename="gatecontrol-gateway-setup-<slug>.zip"`. Body = a
  ZIP (store-only) containing: `setup.sh` (same as the script endpoint), `update.sh`,
  `systemd/gatecontrol-gateway-update.service`, `systemd/gatecontrol-gateway-update.path`,
  `docker-compose.state-snippet.yml`, `README.md`.

`<slug>` = the gateway peer name sanitized to `[a-z0-9._-]` (fallback `gateway-<id>`).

### Tailoring (substituted server-side per gateway)

The endpoints render template files with these values:
- `GATEWAY_NAME` = peer name (for comments / filenames; sanitized).
- `GATEWAY_IMAGE` = `ghcr.io/${GC_GATEWAY_REPO||'CallMeTechie/gatecontrol-gateway'}:latest`.
- `DEFAULT_COMPOSE_DIR` = `/volume1/docker/gatecontrol-gateway` (Synology default; the script
  auto-detects the real dir, this is only a fallback / shown in the guide).
- `SERVICE` = `gateway` (default compose service name).

All substituted values are inserted only into **comments, defaults, and documented variables** —
never used to build executable shell from untrusted input. The peer name is additionally shell-
escaped where it appears in the script.

### Template source files (committed in the server repo)

`update.sh`, the two systemd units, and the compose snippet are **copies** of the gateway repo's
`deploy/` files, vendored into the server repo as setup templates (e.g.
`src/services/gatewaySetup/templates/`). They are the source of truth the server serves. (A short
header comment in each notes it mirrors `gatecontrol-gateway/deploy/`.)

### The setup script (the heart — near zero-config)

`setup.sh` is POSIX `sh`, must run as **root** (re-execs via `sudo` if not root, or aborts with a
hint). Steps:
1. **Auto-detect** the gateway container by image (match `ghcr.io/…/gatecontrol-gateway` in
   `docker ps`); from it read `com.docker.compose.project.working_dir` → `COMPOSE_DIR` and
   `com.docker.compose.service` → `SERVICE`. Override: `setup.sh [COMPOSE_DIR] [SERVICE]` args.
   Abort with a clear message if no gateway container is found.
2. **Add the `/state` mount** to `$COMPOSE_DIR/docker-compose.yml` (idempotent `awk` insert after
   the `…/config:/config:ro` line) + `mkdir -p $COMPOSE_DIR/gateway-state`. Backs up the compose.
3. **Write `update.sh`** into `$COMPOSE_DIR` (embedded in setup.sh; chmod +x).
4. **Pull + recreate detached, health-gated, auto-rollback** to the previous image on failure
   (the proven `migrate.sh` logic — survives SSH being routed through the gateway). Writes a
   result the admin can read.
5. **Detect host type + wire the trigger:**
   - **Synology** (`/etc/synoinfo.conf` exists or `synoschedtask` present): cannot create the DSM
     task non-interactively → print the **exact** DSM Task Scheduler fields + command
     (`PATH=/usr/local/bin:$PATH GATEWAY_STATE_DIR=$COMPOSE_DIR/gateway-state $COMPOSE_DIR/update.sh`,
     user root, every 1 min).
   - **Linux with systemd** (`systemctl` present): install the `.service` + `.path` units (paths
     substituted for `$COMPOSE_DIR`), `daemon-reload`, `enable --now …​.path`. Done automatically.
6. Print a summary (detected dir, version pulled, trigger status / next manual step).

### ZIP writer (in-repo, no new dependency)

New util `src/utils/zip.js`: `createZip([{name, data}]) → Buffer`, **store-only** (compression
method 0) with correct CRC-32, local file headers, and a central directory. ~80 lines, first-party
code (chosen over `jszip` to avoid a supply-chain dependency, per our hardening posture). Covered
by tests that verify a produced archive is valid (entries, CRC, sizes) and extractable.

## Security

- Endpoints are GET, session-authed, `gateway_fleet`-gated; they only **emit text/zip**, no host
  action server-side.
- The setup script runs on the **admin's host** (not the server). Substituted values (peer name)
  go only into comments/filenames and are sanitized/escaped — no shell injection from data.
- `setup.sh`/`update.sh` only ever pull + recreate the known gateway image; no `docker.sock` in any
  container (consistent with #2b Option A).
- The ZIP is built in memory from fixed template files + tailored text; no path traversal (entry
  names are constant).

## Error handling / edge cases

- Unknown / non-gateway / disabled peer → 404.
- `gateway_fleet` off → 403.
- Peer name with odd chars → slug fallback `gateway-<id>` for the filename; escaped in script body.
- Gateway already set up (`state_dir_writable`) → downloads still work (re-runnable; the script's
  compose edit + mkdir are idempotent), UI just shows the card collapsed.
- Setup script run on a host where auto-detect finds no gateway container → aborts with guidance to
  pass `COMPOSE_DIR` explicitly.

## Testing

**Server** (node:test, `NODE_ENV=test`, 40% c8):
- `src/utils/zip.js`: build a zip of 2–3 known files; assert local-header + central-dir structure,
  CRC-32 matches a reference, stored sizes correct; the archive round-trips (parse entries back +
  byte-compare contents).
- `gatewaySetup` service: substitution fills `GATEWAY_NAME`/`GATEWAY_IMAGE`/paths; the bundle file
  list is complete; slug sanitization (weird name → safe filename).
- Endpoints: `GET /:id/setup-script` 200 + `text/plain` + attachment header + body contains the
  tailored values; `GET /:id/setup-bundle.zip` 200 + `application/zip` + non-empty valid zip; 404
  unknown; 403 `gateway_fleet` off. (Mirror `tests/gateway_api_list.test.js` harness: login + agent.)
- `setup.sh` template: `bash -n` clean (spawn `bash -n` on the rendered script in a test); shellcheck
  in CI if available.
- i18n parity for the new keys.

## i18n

New flat keys (de+en) + both `layout.njk` GC.t whitelists:
`gateways.setup_title`, `gateways.setup_note`, `gateways.setup_done`, `gateways.setup_pending`,
`gateways.setup_download_script`, `gateways.setup_download_zip`, `gateways.setup_guide`,
`gateways.setup_synology`, `gateways.setup_linux`, plus the short step strings (or the steps live in
the served README and the UI links to the downloads with a brief inline summary — keep UI strings
minimal, full guide in README.md).

## Out of scope / future

- Creating the DSM task automatically (needs root/GUI on the NAS — out of reach; we print the steps).
- A one-click "set up from the server over SSH" (server orchestrating the host) — rejected; keeps
  the server out of host credentials, consistent with #2b.
- Windows gateway hosts.

## File structure (server repo)

- `src/utils/zip.js` (new) — store-only zip writer.
- `src/services/gatewaySetup.js` (new) — render tailored script + bundle file set from templates.
- `src/services/gatewaySetup/templates/` (new) — `setup.sh`, `update.sh`, `systemd/*.service`,
  `systemd/*.path`, `docker-compose.state-snippet.yml`, `README.md`.
- `src/routes/api/gateways.js` (modify) — two GET endpoints.
- `public/js/gateways.js` (modify) — the "Auto-Update einrichten" card in the detail view.
- `src/i18n/{en,de}.json` + `templates/{default,pro}/layout.njk` (modify) — i18n + GC.t.
- `docs/feature-gateway-autoupdate-setup-bundle.md` (new) — writeup.
- Tests: `tests/zip.test.js`, `tests/gateway_setup_bundle.test.js`.
