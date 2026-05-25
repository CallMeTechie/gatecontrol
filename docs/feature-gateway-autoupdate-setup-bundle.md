# Gateway Auto-Update Setup (detail-view guide + update.sh download)

In the gateway detail view, a card **"Auto-Update einrichten"** shows the one-time host setup
needed for the auto-update feature (#2b), with a short Synology/Linux guide and a download of the
generic `update.sh`. New gateways onboarded via the GC server already ship the `/state` volume
(see the onboarding compose), so the only remaining per-host step is the periodic trigger.

## Why it exists

The auto-update "Update" button is gated on a gateway reporting `state_dir_writable=true`. For that
to work, the host needs:
1. the `/state` volume on the gateway container — **now baked into the onboarding compose**, so new
   gateways have it out of the box;
2. an image ≥1.10.0 (has the self-update route + telemetry) — new gateways pull `:latest`;
3. `update.sh` on the host next to the compose file — **downloaded from this card**;
4. a periodic trigger (DSM Task Scheduler / systemd `.path` / cron) running `update.sh` — the one
   genuinely host-level step that can't live in a container.

So for a freshly-onboarded gateway the setup reduces to: drop `update.sh` in the compose folder +
create the trigger. The card provides the download and the exact command.

## The card

- **Status:** "✓ Eingerichtet" when telemetry reports `state_dir_writable`, else "⚠ Noch nicht eingerichtet".
- **Note** (when not set up): the Update button only works after this one-time host setup.
- **Download:** `⬇ update.sh` → `GET /api/v1/gateways/:id/update-sh` (session + `gateway_fleet`, text/plain attachment). The script is generic (reads `GATEWAY_STATE_DIR`, auto-resolves the compose dir) — no per-gateway tailoring.
- **Guide** (collapsible) for Synology (DSM Task Scheduler) and Linux (cron / systemd `.path`), each with the exact command:
  `PATH=/usr/local/bin:$PATH GATEWAY_STATE_DIR=<compose-dir>/gateway-state <compose-dir>/update.sh`
- **Legacy hint:** gateways created before auto-update also need `- ./gateway-state:/state` added to their compose + one recreate.

## Implementation

- `src/services/gatewaySetup.js` — `readUpdateSh()` returns the vendored `update.sh`.
- `src/services/gatewaySetup/templates/update.sh` — byte-identical vendored copy of the
  `gatecontrol-gateway` `deploy/update.sh` at the tag in `VENDORED.md`; the CI drift check
  (`scripts/check-vendored-templates.js`) fails the build if it diverges from upstream.
- `src/routes/api/gateways.js` — `GET /:id/update-sh` (404→403 like `POST /:id/update`).
- `public/js/gateways.js` + `public/css/{app,pro}.css` — the card.
- `src/i18n/{en,de}.json` + both `layout.njk` — i18n + `GC.t`.
- `public/js/peers.js` — the onboarding compose now includes `./gateway-state:/state`.

## History

Originally shipped (1.69.0) with a tailored `setup.sh` orchestrator + a ZIP bundle (built by an
in-repo zip writer). Simplified afterward: since new gateways get `/state` from onboarding, the
heavy orchestrator/retrofit was unnecessary — replaced by a plain `update.sh` download + an inline
guide. The zip writer, `setup.sh` orchestrator, and bundle endpoints were removed.

## Out of scope

Auto-creating the DSM task (needs root/GUI on the NAS); server-orchestrated setup over SSH;
Windows gateway hosts.
