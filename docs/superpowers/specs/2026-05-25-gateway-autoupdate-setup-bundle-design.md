# Gateway Auto-Update Setup Bundle — Design

**Date:** 2026-05-25
**Status:** Approved (design) — v2 after devil's-advocate → pending spec review → plan
**Builds on:** #2b (gateway auto-update). Server-only feature.
**Repo:** server (`/root/gatecontrol`)
**Tier:** Community (part of `gateway_fleet`)

## Goal

Make the per-gateway-host auto-update setup **self-service** from the gateway detail view: a guide
plus tailored downloads (a one-shot setup **script** and a **ZIP** of all files), with a clear note
that the auto-update button only works once this one-time host setup is done.

## Why

The "Update" button is gated on `state_dir_writable=true`, which requires a host-side setup
(writable `/state` volume, image ≥1.10.0 with the self-update route, `update.sh` next to the
compose file, and a periodic trigger — Synology DSM Task Scheduler or Linux systemd `.path`). This
ships that setup as a download from the UI.

## User experience (gateway detail view)

A new card **"Auto-Update einrichten"** in the detail view:
- **Status:** "✓ Eingerichtet" when telemetry `state_dir_writable === true`, else "⚠ Noch nicht eingerichtet".
- **Note (prominent when not set up):** "Der automatische Update-Button funktioniert erst, wenn dieses einmalige Host-Setup durchgeführt ist."
- **Two download buttons:** "⬇ Setup-Script" and "⬇ ZIP (alle Dateien)" (anchor links to the GET endpoints; browser downloads via `Content-Disposition: attachment`).
- **Collapsible guide** with **Synology (DSM)** and **Linux (systemd)** sections.
- When `state_dir_writable === true`, the card renders collapsed/secondary.

## Server endpoints

Under `/api/v1/gateways` (session-authed via `requireAuth`; **GET → no CSRF**, confirmed by
`src/routes/api/index.js:10-18`; `gateway_fleet`-gated via `license.hasFeature`). Guard order
**matches the existing `POST /:id/update`** (DA2 #4): **404** (unknown/non-gateway/disabled peer)
**then 403** (`gateway_fleet` off). The UI download buttons are gated on the same
`license.features.gateway_fleet` so unlicensed users never click into a 403.

- `GET /:id/setup-script` → `text/plain; charset=utf-8`, `Content-Disposition: attachment; filename="gatecontrol-gateway-setup-<slug>.sh"`. Body = tailored `setup.sh`.
- `GET /:id/setup-bundle.zip` → `application/zip`, attachment `…-<slug>.zip`. Store-only ZIP with: `setup.sh`, `update.sh`, `systemd/gatecontrol-gateway-update.service`, `systemd/gatecontrol-gateway-update.path`, `docker-compose.state-snippet.yml`, `README.md`.

### Slug + name safety (DA #4 — `sanitize()` is trim-only, do NOT use it)

- **`<slug>` (filename):** lowercase → `[^a-z0-9._-]`→`-` → collapse runs of `-`/`.` to one →
  trim leading/trailing `-`/`.` → `slice(0, 64)`; if the result is **empty OR all-punctuation** →
  `gateway-<id>` (so names like `..`, `-rf`, or all-CJK don't yield weird/hidden filenames). This
  is the ONLY value interpolated into the `Content-Disposition` header (quoted) → no CR/LF survives
  the whitelist (prevents header injection). (Note: `PEER_NAME_RE` already forbids quotes/`$`/`;`/
  control chars, so body-escaping is defense-in-depth, not load-bearing — but kept.)
- **Gateway name in the script body:** emitted ONLY as a single-quoted shell var
  `GATEWAY_NAME='<escaped>'` where `<escaped>` = name with CR/LF stripped and `'` → `'\''`. Never
  placed in a free-text comment, never used to build executable shell. (Mirror the existing
  filename-sanitize at `src/routes/api/peers.js:291`, but stricter.)
- ZIP entry names are constant string literals (no name-derived paths) → no path traversal.

### Tailoring (substituted per gateway)

- `GATEWAY_NAME` — single-quoted, escaped (above).
- `GATEWAY_IMAGE` — `ghcr.io/${(GC_GATEWAY_REPO||'CallMeTechie/gatecontrol-gateway').toLowerCase()}:latest`.
  **GHCR normalizes to lowercase**; the deployed ref is `ghcr.io/callmetechie/gatecontrol-gateway`.
  The image-repo path used for container auto-detection is the lowercase **substring**
  `gatecontrol-gateway` (NOT the full tag — DA #1).
- `DEFAULT_COMPOSE_DIR` = `/volume1/docker/gatecontrol-gateway` (Synology default; fallback only).
- `SERVICE` = `gateway` (default; auto-detected on the host).

### Template source files + drift guard (DA #3)

`update.sh`, the two systemd units, and the compose snippet are **vendored copies** of the gateway
repo's `deploy/` files, in `src/services/gatewaySetup/templates/`. To prevent silent drift (DA2 #1):
- Vendored files are **byte-identical to upstream** (no injected header — an injected
  `# vendored-from:` line would make the diff always mismatch). Keep `update.sh`'s upstream shebang
  verbatim (it is `#!/usr/bin/env bash`, NOT sh — vendor it as-is; only our own `setup.sh` is POSIX sh).
- Provenance lives in a **separate manifest** `src/services/gatewaySetup/templates/VENDORED.md`:
  the gateway **release tag** each file was vendored from (the bundle pins to a release tag, not `main`).
- **CI drift check** (gateway repo is public → fetchable without creds): fetch each
  `deploy/<name>` at the manifest's tag and **byte-`diff`** against the vendored copy; **fail on
  mismatch**. No header-stripping needed since the copies are byte-identical.
- `setup.sh` does not duplicate `update.sh`; at bundle-render time the server reads the vendored
  `update.sh` template and embeds its content into the rendered `setup.sh` (single source).

## The setup script (`setup.sh`, POSIX sh, runs as root)

If not root → re-exec via `sudo` (or abort with a hint). Order — **fail before any side effect:**

1. **Detect the compose binary:** prefer `docker compose` (v2), else `docker-compose` (v1), else
   abort "Docker Compose v2 plugin required". Prepend `/usr/local/bin` to PATH (Synology).
2. **Auto-detect the gateway container (DA #1):** scan `docker ps --format '{{.ID}} {{.Image}}'`
   for a **case-insensitive substring `gatecontrol-gateway`**. If **0** matches → abort with the
   override usage. If **>1** → abort, list candidates, require explicit args. Optional override:
   `setup.sh [COMPOSE_DIR] [SERVICE]`.
3. From the matched container's labels: `COMPOSE_DIR` = `com.docker.compose.project.working_dir`,
   `SERVICE` = `com.docker.compose.service` (args override). **Verify** `$COMPOSE_DIR/docker-compose.yml`
   exists AND defines service `$SERVICE` (else abort).
4. **Idempotency check (DA2 #2):** skip the recreate (→ jump to step 8, trigger) ONLY if ALL hold:
   `/state` mount present in the compose AND `gateway-state/` exists AND `update.sh` present AND
   the container healthy **AND the running image version ≥ 1.10.0** (the min with the self-update
   route + `state_dir_writable` telemetry). Read the running version via
   `docker exec <cid> node -p "require('./package.json').version"`. If the mount is present but the
   image is older (or version can't be read), do **not** skip — proceed to recreate (the pull
   brings ≥1.10.0). This prevents the "mount present but old image → `state_dir_writable` false
   forever, script falsely reports done" trap.
5. **Edit the compose (DA #7 + DA2 #3):** back up to `docker-compose.yml.bak-<ts>`. Insert the
   `/state` mount **within the `$SERVICE` block's `volumes:` list only** — not by a global
   `:/config:ro` match (which could land it on a different service or wrong indent). Track the
   current service while scanning; find the `:/config:ro` anchor *inside `$SERVICE`*, copy that
   line's exact leading whitespace for the inserted `- ./gateway-state:/state`; skip if the exact
   mount string already present in that block. `mkdir -p gateway-state`. **Verify on the right
   service:** run `docker compose -f … config` and confirm `/state` is attached to `$SERVICE`
   (parse the rendered config / inspect), not merely "string present somewhere". If the compose
   uses **long-form volume syntax** (no `:/config:ro` anchor) or verification fails → restore the
   backup and abort, pointing at `docker-compose.state-snippet.yml` for a manual edit.
6. **Write `update.sh`** into `$COMPOSE_DIR` (embedded heredoc; chmod +x) — the vendored copy.
7. **Recreate (only if step 5 changed anything), detached + health-gated + auto-rollback:** print
   "⚠ Deine SSH-Verbindung kann abbrechen, falls sie durch diesen Gateway läuft — reconnecte und
   prüfe `<COMPOSE_DIR>/setup-result.txt`" **before** firing. Then run the `migrate.sh`-style
   detached block (pull → `up -d --force-recreate` → wait healthy → rollback to the prior image
   digest on failure → write `setup-result.txt`).
8. **Wire the trigger (host-type detect):**
   - **Synology** (`/etc/synoinfo.conf` or `synoschedtask` present): cannot create the DSM task
     non-interactively → print the **exact** DSM Task Scheduler fields + command
     (`PATH=/usr/local/bin:$PATH GATEWAY_STATE_DIR=$COMPOSE_DIR/gateway-state $COMPOSE_DIR/update.sh`,
     user root, every 1 min).
   - **Linux + systemd** (`systemctl` present): write the `.service`/`.path` units (paths
     substituted for `$COMPOSE_DIR`/`$SERVICE`) to `/etc/systemd/system/`, `daemon-reload`,
     `enable --now …​.path`.
9. Print a summary: detected dir/service, what changed, trigger status / next manual step.

## ZIP writer (in-repo, no dependency — DA #5)

`src/utils/zip.js`: `createZip([{name, data}]) → Buffer`, **store-only** (method 0), GP-bit-flag
`0`, version-needed `20`, **no data descriptors** (sizes known up front), local file headers,
central directory, EOCD. Central-dir `relative offset of local header`, EOCD `cd size`/`cd offset`
byte-exact; DOS date/time = a fixed constant; external attrs `0`; entry names ASCII (constants).
**The writer computes CRC-32 itself** (bitwise/table, little-endian) — so the test's `zlib.crc32`
is a genuinely *independent* oracle (DA2 #5). `data` accepted as `Buffer`; zero-length entries
(CRC `0x00000000`) handled.

## Security

- GET, session-authed, `gateway_fleet`-gated; emit text/zip only; **no host action server-side**.
- Name → slug/escaped (DA #4); the slug is the only header-bound value; script body uses a
  single-quoted var. The setup script runs on the **admin's host**, not the server.
- No `docker.sock` anywhere (consistent with #2b Option A). The script only pulls + recreates the
  known gateway image; rollback pins the prior digest.
- Nothing sensitive is embedded (no tokens/secrets) — only the public image ref + paths.

## Error handling / edge cases

- Unknown/non-gateway/disabled peer → 404; `gateway_fleet` off → 403.
- Hostile peer name → slug fallback + escaped body (DA #4 test).
- Already set up → downloads still work; the script detects it and **skips the recreate** (DA #2).
- No gateway container found / multiple found → script aborts with override guidance (DA #1).
- Only `docker-compose` v1, or neither → detected before side effects, clear abort (DA #6).
- Compose edit fails / doesn't parse → restore backup + abort + point at the snippet (DA #7).

## Testing

**Server** (node:test, `NODE_ENV=test`, 40% c8):
- `src/utils/zip.js`: build a zip of known files; **independent-oracle validation** — decode each
  entry using offsets hardcoded in the TEST (not the writer's own parser), assert CRC-32 against
  `zlib.crc32` (independent — the writer rolls its own), sizes + central-dir offsets exact. Include
  an **empty-file entry** (CRC `0x00000000`, off-by-one magnet). Plus a CI step running system
  `unzip -t` on the buffer and **asserting its exit status is 0** (no `| …` that swallows the code).
- `gatewaySetup` service: substitution fills name/image/paths; bundle file list complete; slug
  sanitization incl. **hostile names** (`a\nb`, `$(id)`, `'; reboot #`, `../../x`) → safe single-
  line filename, rendered script passes `bash -n`, no unescaped name, `GATEWAY_NAME='…'` single line.
- Endpoints: `setup-script` 200 `text/plain` + attachment + tailored body; `setup-bundle.zip` 200
  `application/zip` + valid non-empty zip; 404 unknown; 403 `gateway_fleet` off. (Mirror
  `tests/gateway_api_list.test.js`: login + agent.)
- `setup.sh` rendered → `bash -n` clean; assert it contains the detach/rollback guard, the
  "skip-if-unchanged" branch, the compose-binary detection, and the case-insensitive match.
- **Drift check** (DA #3 + DA2 #1): vendored files **byte-identical** to the gateway repo's
  `deploy/<name>` at the manifest's release tag (no header strip — copies carry no injected line).
- i18n parity for new keys.

## i18n

New flat keys (de+en) + both `layout.njk` GC.t: `gateways.setup_title`, `gateways.setup_note`,
`gateways.setup_done`, `gateways.setup_pending`, `gateways.setup_download_script`,
`gateways.setup_download_zip`, `gateways.setup_guide`, `gateways.setup_synology`,
`gateways.setup_linux`. (Detailed step text lives in the served `README.md`; UI strings stay minimal.)

## Out of scope / future

- Creating the DSM task automatically (needs root/GUI on the NAS — we print the steps).
- Server-orchestrated setup over SSH (rejected — keeps the server out of host credentials).
- Windows gateway hosts.

## File structure (server repo)

- `src/utils/zip.js` (new) — store-only zip writer.
- `src/services/gatewaySetup.js` (new) — render tailored script + bundle file set from templates.
- `src/services/gatewaySetup/templates/` (new) — `setup.sh`, `update.sh`, `systemd/*.{service,path}`,
  `docker-compose.state-snippet.yml`, `README.md` (each with a `# vendored-from:` header).
- `src/routes/api/gateways.js` (modify) — two GET endpoints.
- `public/js/gateways.js` (modify) — the "Auto-Update einrichten" card.
- `src/i18n/{en,de}.json` + `templates/{default,pro}/layout.njk` (modify) — i18n + GC.t.
- `.github/workflows/test.yml` (modify) — `unzip -t` validity step + vendored-template drift check.
- `docs/feature-gateway-autoupdate-setup-bundle.md` (new) — writeup.
- Tests: `tests/zip.test.js`, `tests/gateway_setup_bundle.test.js`.
