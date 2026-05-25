# Gateway Auto-Update Setup Bundle

Self-service host setup for the gateway auto-update feature (#2b), surfaced in the gateway detail
view. Removes the manual hand-holding previously needed to make the "Update" button work on a
gateway host.

## What it does

The auto-update "Update" button is gated on a gateway reporting `state_dir_writable=true`, which
requires a one-time host setup (writable `/state` volume + image ≥1.10.0 + `update.sh` + a periodic
trigger). This feature ships that setup as **tailored downloads** from the gateway detail view.

### Detail-view card "Auto-Update einrichten"
- **Status:** "✓ Eingerichtet" when the gateway reports `state_dir_writable`, else "⚠ Noch nicht
  eingerichtet".
- **Note** (shown when not set up): the automatic Update button only works after this one-time setup.
- **Two downloads:** a tailored **setup script** and a **ZIP** with all files.
- **Collapsible guide** (Synology DSM + Linux systemd) — full steps are in the bundle's README.

### Downloads (server endpoints, session + `gateway_fleet`, GET)
- `GET /api/v1/gateways/:id/setup-script` → tailored `setup.sh` (text/plain attachment).
- `GET /api/v1/gateways/:id/setup-bundle.zip` → store-only ZIP: `setup.sh`, `update.sh`, the two
  systemd units, `docker-compose.state-snippet.yml`, `README.md`.

Both are tailored per gateway (name, image ref, default Synology paths) and 404→403-gated like the
existing `POST /:id/update`. The filename uses a sanitized slug (`[a-z0-9._-]`, fallback
`gateway-<id>`) — the only value placed in the `Content-Disposition` header.

### The setup script (near zero-config)
`setup.sh` runs as root on the gateway host and:
1. detects the Docker Compose binary (v2 plugin or `docker-compose`),
2. **auto-detects** the gateway container (case-insensitive `gatecontrol-gateway` image substring;
   aborts on 0 or >1 with an explicit-args hint) → its compose dir + service from the container's
   compose labels (overridable via `setup.sh [COMPOSE_DIR] [SERVICE]`),
3. adds `./gateway-state:/state` to that service's `volumes:` (service-block-aware, idempotent;
   verifies `docker compose config` still parses, restores the backup on failure),
4. writes `update.sh` next to the compose file,
5. **skips the recreate** if already on a ≥1.10.0 image with the mount + healthy; otherwise
   recreates **detached + health-gated + auto-rollback** (survives SSH being routed through the
   gateway) and warns the operator their SSH may drop,
6. wires the trigger: **Synology** → prints the exact DSM Task Scheduler command; **Linux** →
   installs + enables the systemd `.path`/`.service` units.

## Implementation

- `src/utils/zip.js` — first-party store-only ZIP writer (own CRC-32; no dependency, per the
  supply-chain hardening posture). Validated by `tests/zip.test.js` (reference CRC constants +
  structure) and `unzip -t` in CI.
- `src/services/gatewaySetup/templates/` — `setup.sh` (orchestrator with `{{…}}` placeholders),
  vendored byte-identical `update.sh` + systemd units (from `gatecontrol-gateway` at the tag in
  `VENDORED.md`), `docker-compose.state-snippet.yml`, `README.md`.
- `src/services/gatewaySetup.js` — renders the tailored script/bundle. All `{{…}}` substitutions
  use the function form of `String.replace` so `$`-sequences in a name or in the embedded
  `update.sh` are inserted literally (avoids the `$&`/`$$` replacement footgun). The gateway name
  is single-quote-escaped (`'` → `'\''`, CR/LF stripped).
- `src/routes/api/gateways.js` — the two GET endpoints.
- `public/js/gateways.js` + `public/css/{app,pro}.css` — the detail-view card.
- `src/i18n/{en,de}.json` + both `layout.njk` — i18n + `GC.t`.
- `scripts/check-vendored-templates.js` + `.github/workflows/test.yml` — CI drift check (byte-diff
  vendored templates against the gateway repo at the pinned tag) + zip validity (`unzip -t`).

## Vendoring / drift policy

`update.sh` and the systemd units are byte-identical copies of the gateway repo's `deploy/` files
at the tag recorded in `templates/VENDORED.md`. The CI drift check fetches the upstream files at
that tag and byte-compares — a mismatch fails the build, so the bundle can't silently ship a stale
`update.sh`. Bump the tag + re-vendor when the gateway repo's `deploy/` changes.

## Security

- GET, session-authed, `gateway_fleet`-gated; the server only emits text/zip — no host action
  server-side. The setup script runs on the admin's host.
- No `docker.sock` in any container (consistent with #2b Option A); the script only pulls + recreates
  the known gateway image and rolls back to the prior digest on failure.
- No secrets embedded; the name is slugged (filename) and shell-escaped (script body).

## Out of scope

Creating the DSM task automatically (needs root/GUI on the NAS — we print the steps);
server-orchestrated setup over SSH; Windows gateway hosts.
