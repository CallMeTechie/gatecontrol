# GateControl Gateway — Auto-Update Setup

This bundle sets up the one-time host configuration required for the GateControl
"Update" button to work in the gateway detail view.

**Gateway:** `{{GATEWAY_NAME}}`
**Image:** `{{GATEWAY_IMAGE}}`

---

## Quick start (recommended)

Run `setup.sh` as root on the gateway host. It auto-detects your Docker Compose
setup, adds the `/state` volume mount, writes `update.sh`, recreates the container
in the background (with health-gated auto-rollback), and wires the periodic trigger.

```sh
sudo sh setup.sh
# or, if your compose dir differs from the default ({{DEFAULT_COMPOSE_DIR}}):
sudo sh setup.sh /path/to/your/compose-dir {{SERVICE}}
```

> **Synology note:** your SSH session may briefly drop if it routes through the gateway
> during the recreate. Reconnect and check `gateway-state/setup-result.txt`.

---

## Manual setup — Synology (DSM)

1. **Add the `/state` volume** to `docker-compose.yml` for the `{{SERVICE}}` service
   (keep the existing `config:ro` line):

   ```yaml
   volumes:
     - ./config:/config:ro
     - ./gateway-state:/state
   ```
   See `docker-compose.state-snippet.yml` in this bundle for the exact lines.

2. **Recreate the container** so the mount takes effect:

   ```sh
   cd {{DEFAULT_COMPOSE_DIR}}
   docker compose pull {{SERVICE}}
   docker compose up -d --force-recreate {{SERVICE}}
   ```

3. **Install `update.sh`** into the compose directory:

   ```sh
   cp update.sh {{DEFAULT_COMPOSE_DIR}}/update.sh
   chmod +x {{DEFAULT_COMPOSE_DIR}}/update.sh
   ```

4. **Create a DSM Task Scheduler entry** (Control Panel → Task Scheduler →
   Create → Scheduled Task → User-defined script):

   - User: `root`
   - Schedule: daily, repeat every **1 minute**
   - Command:
     ```
     PATH=/usr/local/bin:$PATH GATEWAY_STATE_DIR={{DEFAULT_COMPOSE_DIR}}/gateway-state {{DEFAULT_COMPOSE_DIR}}/update.sh
     ```

---

## Manual setup — Linux (systemd)

1. **Add the `/state` volume** and recreate as above (steps 1–3 from the Synology
   section, adjusting the compose directory as needed).

2. **Install the systemd units** from the `systemd/` folder in this bundle:

   ```sh
   cp systemd/gatecontrol-gateway-update.service /etc/systemd/system/
   cp systemd/gatecontrol-gateway-update.path    /etc/systemd/system/
   ```

3. **Edit the service** to set `GATEWAY_STATE_DIR` and `ExecStart` for your compose dir:

   ```ini
   [Service]
   Type=oneshot
   Environment=GATEWAY_STATE_DIR=/your/compose-dir/gateway-state
   ExecStart=/your/compose-dir/update.sh
   ```

4. **Enable and start** the path unit:

   ```sh
   systemctl daemon-reload
   systemctl enable --now gatecontrol-gateway-update.path
   ```

---

## Verification

Once the gateway is running with the `/state` mount, GateControl will detect
`state_dir_writable` in the telemetry and activate the Update button automatically.
The setup card in the detail view will show "✓ Set up" when ready.

---

## Files in this bundle

| File | Purpose |
|---|---|
| `setup.sh` | Orchestrator — run this (auto-detects, re-runnable) |
| `update.sh` | Vendored from `gatecontrol-gateway` — the update logic |
| `docker-compose.state-snippet.yml` | Volume lines to add manually |
| `systemd/gatecontrol-gateway-update.service` | Vendored systemd unit |
| `systemd/gatecontrol-gateway-update.path` | Vendored systemd path watcher |
| `README.md` | This file |
