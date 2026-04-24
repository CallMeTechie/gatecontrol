# Installation Guide

This is the complete step-by-step install guide for GateControl. It assumes a fresh Linux host with root access and no previous GateControl setup. Existing installations that want to move to the recommended directory layout should read **[§12 Migration from older setups](#12-migration-from-older-setups)** at the end.

For a one-line summary see the Quick Start in the [README](README.md). This document covers the full flow from DNS to first login.

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Directory layout](#2-directory-layout)
3. [Download the setup files](#3-download-the-setup-files)
4. [Configure `.env`](#4-configure-env)
5. [First start](#5-first-start)
6. [First login](#6-first-login)
7. [First peer and first route](#7-first-peer-and-first-route)
8. [Verifying the installation](#8-verifying-the-installation)
9. [Troubleshooting](#9-troubleshooting)
10. [Backup and restore](#10-backup-and-restore)
11. [Updates](#11-updates)
12. [Migration from older setups](#12-migration-from-older-setups)

---

## 1. Prerequisites

### Hardware

| Resource | Minimum | Recommended |
|---|---|---|
| CPU | 1 vCPU | 2 vCPU |
| RAM | 1 GB | 2 GB |
| Disk | 20 GB | 40 GB (more for long activity logs and Caddy access logs) |

### Software

- **OS:** Any modern Linux distribution (Debian 11+, Ubuntu 22.04+, Fedora, Rocky, Alma, Alpine). Tested on Debian 13.
- **Docker Engine:** 24.0 or newer
- **Docker Compose:** v2 (part of Docker Engine since 23.0)
- **WireGuard kernel module:** present on most modern kernels. The container does not need an external install, but WireGuard capabilities (`NET_ADMIN`) must be grantable to the container.

### DNS

Before starting the container you need **one DNS A-record** (plus optionally AAAA for IPv6) pointing to the public IP of the host:

```
gate.example.com.   IN  A   198.51.100.42
```

GateControl uses this name for two purposes:

- **Admin UI** via `GC_BASE_URL` — Caddy provisions a Let's Encrypt certificate for it automatically on first start.
- **WireGuard endpoint** if you also set `GC_WG_HOST=gate.example.com`. (`GC_WG_HOST` may be a bare public IP instead, but using the same hostname simplifies peer configs.)

Per-route domains (for reverse-proxy routes you create later) need separate A-records pointing to the same host.

### Ports

| Port | Protocol | Purpose | Must be reachable from |
|---|---|---|---|
| 80 | TCP | HTTP → HTTPS redirect, **ACME HTTP-01 challenge** | Internet |
| 443 | TCP | HTTPS admin UI and all reverse-proxy routes | Internet |
| 443 | UDP | HTTP/3 (optional but recommended) | Internet |
| 51820 | UDP | WireGuard VPN endpoint | Internet |
| 53 | TCP/UDP on `127.0.0.1` and on the VPN subnet gateway IP (`10.8.0.1` by default) | Internal DNS for VPN peers | Container only (loopback and WG interface) |

If anything already binds `127.0.0.1:53` on the host (a common cause: NetworkManager-dnsmasq, libvirt-dnsmasq, bind9), the GateControl container will refuse to start. `systemd-resolved` binds `127.0.0.53` and does **not** conflict. The entrypoint checks this explicitly and exits with a clear message if it finds another listener.

Open the first four ports in your cloud firewall / iptables / ufw before you start the container.

---

## 2. Directory layout

Create a dedicated deploy directory — **separate from any cloned source repository**. The recommended path is `/opt/gatecontrol/`:

```
/opt/gatecontrol/
├── docker-compose.yml    # image, ports, volume
├── .env                  # your config (passwords, domain, etc.)
├── update.sh             # helper to pull latest and restart
└── data/                 # created on first start — holds DB, certs, keys, WG config
```

Why separate from the source repository:

- Cleaner mental model: "code" and "config" never get mixed.
- Safe to clone/wipe/update the source repo without losing production state.
- One-line backup: `tar czf backup.tar.gz /opt/gatecontrol` captures everything.

```bash
mkdir -p /opt/gatecontrol
cd /opt/gatecontrol
```

---

## 3. Download the setup files

There are three options. They all end with the same files in `/opt/gatecontrol/`.

### Option A — Interactive setup (recommended)

Download and run `setup.sh`. It installs Docker if missing, walks you through `.env` values interactively, generates secure secrets, and starts the container:

```bash
cd /opt/gatecontrol
curl -fsSLO https://github.com/CallMeTechie/gatecontrol/releases/latest/download/setup.sh
curl -fsSLO https://github.com/CallMeTechie/gatecontrol/releases/latest/download/docker-compose.yml
curl -fsSLO https://github.com/CallMeTechie/gatecontrol/releases/latest/download/.env.example
bash setup.sh
```

Skip straight to [§6 First login](#6-first-login) — setup.sh does the rest.

### Option B — Manual (full control)

```bash
cd /opt/gatecontrol
curl -fsSLO https://github.com/CallMeTechie/gatecontrol/releases/latest/download/docker-compose.yml
curl -fsSLO https://github.com/CallMeTechie/gatecontrol/releases/latest/download/.env.example
curl -fsSLO https://raw.githubusercontent.com/CallMeTechie/gatecontrol/master/update.sh
chmod +x update.sh
cp .env.example .env
```

Proceed to [§4 Configure `.env`](#4-configure-env).

### Option C — Air-gapped / offline

For hosts without internet access during install, download the image tarball from a release:

```bash
curl -fsSLO https://github.com/CallMeTechie/gatecontrol/releases/latest/download/gatecontrol-image.tar.gz
docker load < gatecontrol-image.tar.gz
rm gatecontrol-image.tar.gz
```

Continue with the `docker-compose.yml` and `.env.example` from Option B.

---

## 4. Configure `.env`

Edit `/opt/gatecontrol/.env`. Three values are **required**; everything else has sensible defaults.

### Required

| Variable | What it is | Example |
|---|---|---|
| `GC_ADMIN_PASSWORD` | Initial password for the `admin` account. Read **only** on first start — later changes happen in the UI. | `R7!xK2#wPq9$Lm4v` |
| `GC_WG_HOST` | Public IP or hostname your VPN clients dial. Must be reachable from the internet on UDP/51820. | `gate.example.com` or `198.51.100.42` |
| `GC_BASE_URL` | Full URL of the admin UI. Caddy uses the hostname to request a Let's Encrypt certificate. | `https://gate.example.com` |

### Strongly recommended

| Variable | Why | Example |
|---|---|---|
| `GC_CADDY_EMAIL` | Lets Encrypt contacts you for expiry warnings and certificate issues. Without it, certs still work but you get no recovery channel. | `admin@example.com` |

### Optional — left empty for auto-generation

| Variable | Default behavior if unset |
|---|---|
| `GC_SECRET` | A 48-byte session secret is generated on first start and persisted to `/data/.session_secret` (chmod 600). |
| `GC_ENCRYPTION_KEY` | A 32-byte AES-256 key is generated and persisted to `/data/.encryption_key` (chmod 600). **Back this up.** Restoring a DB without the matching key fails. |

See `.env.example` in the repository for the full reference including WireGuard tuning, rate limits, timeouts, client update repos, and licensing keys.

### Edit the file

```bash
cd /opt/gatecontrol
nano .env   # or vim, or any editor
```

Set the three required values. Save and exit.

---

## 5. First start

```bash
cd /opt/gatecontrol
docker compose up -d
docker compose logs -f
```

On the first run the entrypoint does several things. Expect to see, in roughly this order:

1. `» Auto-detected egress interface: <name>` — the outbound network interface used for VPN NAT. If you see `eth0` falling back, it is correct on most cloud VMs; hosts with non-standard NIC names are detected automatically.
2. `» MASQUERADE rule active: 10.8.0.0/24 → <iface>` — iptables NAT rule installed.
3. `» Generating WireGuard server keypair...` — one-time on first start only. The private key is persisted to `./data/wireguard/wg0.conf` with `chmod 600`.
4. `» Session secret generated and saved` — one-time on first start.
5. `» Encryption key generated and saved` — one-time on first start.
6. `» Generating dnsmasq config (split-horizon for <hostname> → 10.8.0.1)...` — internal DNS config.
7. `» Exporting Caddy JSON from DB...` — on a fresh install the DB has no user-defined routes, but the **management-UI route** (`GC_BASE_URL` hostname → `127.0.0.1:3000`) is injected automatically. You do not need to configure this route by hand.
8. `» Starting services via supervisord...`
9. Caddy boots, acquires Let's Encrypt certificate for the `GC_BASE_URL` hostname. First cert fetch takes 10–30 seconds. Watch for:
   - `obtaining certificate` followed by
   - `certificate obtained successfully`
   - If you see `lookup <hostname>: no such host` or `unable to fetch certificate`, DNS is not yet propagated — wait and the ACME client will retry.
10. WireGuard starts, interface `wg0` comes up.
11. Node.js web application starts on `127.0.0.1:3000`. Caddy proxies requests on the `GC_BASE_URL` hostname to it.

Exit the log tail with `Ctrl+C` — the container keeps running in the background.

---

## 6. First login

Open `GC_BASE_URL` in your browser, for example `https://gate.example.com`.

- **Username:** `admin` (configurable via `GC_ADMIN_USER`)
- **Password:** the value you set in `GC_ADMIN_PASSWORD`

### The management-UI route is automatic

You do **not** need to create a reverse-proxy route for the admin UI itself. GateControl inspects `GC_BASE_URL` and injects a Caddy route that maps the hostname to the internal Node.js port. This is how the chicken-and-egg problem of "I need the UI to configure the UI" is resolved on first start.

### Recommended first actions

1. **Change the admin password** — Settings → Profile → Change Password. From this point `GC_ADMIN_PASSWORD` in `.env` is irrelevant; the hash lives in the DB.
2. **Configure SMTP** (optional but useful) — Settings → SMTP. Required for route authentication that uses email OTP, for email alerts, and for the test email feature.
3. **Configure email alerts** (optional) — Settings → Email Alerts. Pick which event groups should trigger notifications.
4. **Review security settings** — Settings → Security. The defaults (password complexity, account lockout after failed logins) are reasonable; adjust to your policy.

---

## 7. First peer and first route

### Create a VPN peer

1. **Peers** → **New peer**
2. Give it a name (e.g. `laptop-alice`).
3. GateControl auto-generates a keypair and allocates an IP from `GC_WG_SUBNET` (default `10.8.0.0/24`, first peer gets `10.8.0.2`).
4. Click **Download config** for a `.conf` file or scan the displayed QR code with the WireGuard mobile app.
5. The peer shows as online once the client completes the first handshake (check the status dot on the peer list).

### Create a reverse-proxy route

Typical use: expose an internal service behind the VPN via HTTPS on a public domain.

1. Create the DNS A-record for `service.example.com` pointing to the GateControl host's public IP.
2. **Routes** → **New route**
3. **Domain:** `service.example.com`
4. **Target:** pick the peer from the dropdown (e.g. `laptop-alice`); the IP is filled in automatically. Or set a manual IP.
5. **Target port:** the port the service listens on inside the peer's network (e.g. `80`, `8080`, `5001`).
6. **Backend HTTPS** if the target uses self-signed TLS (e.g. Synology DSM on port 5001).
7. Save.

Within a few seconds Caddy acquires the certificate and starts serving the route.

---

## 8. Verifying the installation

### Container health

```bash
cd /opt/gatecontrol
docker compose ps
```

Expected:

```
NAME          IMAGE                                       STATUS                   PORTS
gatecontrol   ghcr.io/callmetechie/gatecontrol:latest     Up 2 minutes (healthy)
```

The `(healthy)` badge means Docker's internal healthcheck on `/health` passed.

### `/health` endpoint

From inside the host:

```bash
curl -s http://127.0.0.1:3000/health | jq
```

Expected:

```json
{
  "ok": true,
  "version": "1.52.0",
  "uptime": 42,
  "db": true,
  "wireguard": true,
  "caddy": true
}
```

From the internet (anonymous request):

```bash
curl -s https://gate.example.com/health
```

Expected — no internal detail is leaked to anonymous callers:

```json
{"ok":true}
```

Logged-in admins see the full detail from the browser too: open `GC_BASE_URL/health` in the same tab where you are logged in.

### Container logs

```bash
docker compose logs --tail 100
```

No `level=error` lines should appear after the initial bootstrap. Common non-errors you **can** ignore:

- `dnsmasq warning: interface wg0 does not currently exist` during startup — dnsmasq comes up before wg-quick; `bind-dynamic` takes care of it.
- `storage cleaning happened too recently; skipping for now` — Caddy self-log on every start.

---

## 9. Troubleshooting

### Container refuses to start: `GC_ADMIN_PASSWORD is not set or still default`

Set `GC_ADMIN_PASSWORD` in `.env` to a real password and re-run `docker compose up -d`. The entrypoint refuses to boot with the placeholder value `changeme` on purpose.

### Container refuses to start: `GC_WG_HOST is not set or still the example value`

Same — set `GC_WG_HOST` in `.env`. Any value other than `gate.example.com` passes.

### Container exits with `127.0.0.1:53 is already bound`

Another process on the host owns the DNS port the container needs for its internal dnsmasq. Identify and stop the conflict:

```bash
ss -lntup | grep ':53 '
```

Common culprits:

- **NetworkManager-dnsmasq** — `systemctl disable --now NetworkManager` (on headless servers).
- **libvirt dnsmasq** — `systemctl disable --now libvirtd` or reconfigure libvirt's default network.
- **bind9 / named** — either stop it or move GateControl to a different host.

`systemd-resolved` (binds `127.0.0.53`) does **not** conflict.

### Let's Encrypt fails: `unable to fetch certificate`

The most common causes, in order:

1. **DNS not propagated yet.** Let's Encrypt must resolve your hostname to this host from the public internet. `dig +short gate.example.com` must return your public IP. Give DNS up to 30 minutes after setting the record.
2. **Port 80 not reachable from the internet.** ACME HTTP-01 challenges arrive on port 80. Open it in your cloud firewall.
3. **Hitting Let's Encrypt rate limits.** If you restarted many times in a short window, you may be rate-limited for ~1 hour. Check Caddy logs for `rateLimited` responses.

Caddy retries automatically with exponential backoff — you do not need to restart the container.

### Admin UI shows SSL/TLS errors in the browser (`ERR_SSL_PROTOCOL_ERROR`)

Three things to check, in order:

1. **Container still booting?** First cert fetch takes 10–30 seconds. Wait and reload.
2. **DNS pointing to the right host?** `curl -v https://gate.example.com 2>&1 | grep -i "connected"` — the IP in parentheses must be this host's public IP.
3. **Someone ran the test suite against the live admin API?** GateControl uses `network_mode: host` for dynamic L4 port binding. Running `npm test` on the host while the container is active used to overwrite Caddy's live config. This was fixed in v1.50.9 — if you are on an older version, update and the problem goes away for good.

### `/health` returns 503

Read the JSON from a localhost call (`curl -s http://127.0.0.1:3000/health`). Whichever of `db`, `wireguard`, `caddy` is `false` tells you what is broken:

- `db: false` — SQLite file permissions wrong or disk full. `ls -la /opt/gatecontrol/data/gatecontrol.db` should show owner `101:_ssh` (that's the container's `gatecontrol` user on the host).
- `wireguard: false` — `/sys/class/net/wg0` missing. `docker compose logs` for wg-quick errors.
- `caddy: false` — Caddy admin API on `127.0.0.1:2019` does not answer. `docker compose logs` for Caddy crashes.

### VPN peers connect but have no internet

The `GC_NET_INTERFACE` auto-detection picks the default-route interface. If your host uses a weird name (e.g. containers-inside-containers), it may fail and fall back to `eth0`. Set `GC_NET_INTERFACE` explicitly in `.env` and restart:

```bash
ip route | awk '/^default/ {print $5; exit}'   # find your real interface name
```

---

## 10. Backup and restore

### What to back up

Everything under `/opt/gatecontrol/` — in particular:

- `.env` — your config (passwords, domain).
- `data/gatecontrol.db` — the database (peers, routes, users, sessions, logs).
- `data/.encryption_key` — the AES-256 key for encrypted DB columns. **Without this key the DB is useless.**
- `data/.session_secret` — session cookie signing key. Losing this only invalidates existing sessions; not critical.
- `data/wireguard/wg0.conf` — WireGuard server private key. Regenerated on re-install, but existing peers would need new configs without it.
- `data/caddy/` — certificates and private keys. Can be re-issued by Let's Encrypt, but rate limits apply if you restore often.

### Full backup (recommended)

```bash
BACKUP=/backup/gatecontrol-$(date +%F).tar.gz
tar czf "$BACKUP" -C /opt gatecontrol
chmod 600 "$BACKUP"   # contains secrets — protect accordingly
```

The resulting archive is self-contained and can restore the entire installation. Store it encrypted or on an access-controlled volume.

### In-UI backup

Settings → Backup → **Download full backup**. This produces a portable JSON file with peers, routes, route auth configs, ACL rules, settings, webhooks, and encrypted keys. Restore via **Upload backup** on the same page — works across GateControl instances as long as the encryption key is the same (or you are restoring onto the same instance).

The in-UI backup does **not** include Caddy certificates — those are re-issued automatically after restore.

---

## 11. Updates

### Automatic update

```bash
cd /opt/gatecontrol
./update.sh
```

`update.sh` pulls the latest image from GHCR, recreates the container only if a new image was actually pulled, and logs to `/var/log/gatecontrol-update.log`. Safe to schedule via cron or a systemd timer:

```
# /etc/cron.d/gatecontrol-update
0 3 * * * root /opt/gatecontrol/update.sh
```

### Manual update

```bash
cd /opt/gatecontrol
docker compose pull
docker compose up -d
```

Downtime is roughly 10–30 seconds while the container restarts and Caddy re-reads its persisted state. No data migration is ever required — migrations run automatically on container start, with per-step commits so a failed migration does not roll back successful ones.

### Verify after update

```bash
curl -s http://127.0.0.1:3000/health | jq .version
```

The version string should match the tag you pulled.

---

## 12. Migration from older setups

If you have an older GateControl install with a **named Docker volume** (the historical default), you can migrate to the recommended `/opt/gatecontrol/` layout with a ~15-second downtime. Named volumes are invisible to the host filesystem and make backups awkward; bind-mounts fix that.

Steps:

```bash
# 1. Verify source volume
docker inspect gatecontrol --format '{{range .Mounts}}{{.Type}} {{.Source}}{{"\n"}}{{end}}'
# if "volume <path>" appears, proceed. If "bind <path>" already — you are done.

# 2. Prepare new location
mkdir -p /opt/gatecontrol
cp /path/to/old/.env /opt/gatecontrol/.env
cat > /opt/gatecontrol/docker-compose.yml <<'EOF'
services:
  gatecontrol:
    image: ghcr.io/callmetechie/gatecontrol:latest
    container_name: gatecontrol
    network_mode: host
    cap_add:
      - NET_ADMIN
    volumes:
      - ./data:/data
    env_file:
      - .env
    restart: unless-stopped
EOF

# 3. Stop old, copy data, start new (brief downtime)
cd /path/to/old  # where the old docker-compose.yml lives
docker compose down

mkdir -p /opt/gatecontrol/data
VOL_PATH=$(docker volume inspect <old-volume-name> --format '{{.Mountpoint}}')
cp -a "$VOL_PATH"/. /opt/gatecontrol/data/
chown -R 101:102 /opt/gatecontrol/data

cd /opt/gatecontrol
docker compose up -d

# 4. Verify
docker inspect gatecontrol --format '{{range .Mounts}}{{.Type}} {{.Source}}{{"\n"}}{{end}}'
# should now show: bind /opt/gatecontrol/data
curl -s http://127.0.0.1:3000/health | jq
```

Keep the old named volume around for at least 24 hours as a fallback. Once you are confident the new setup works, remove it:

```bash
docker volume rm <old-volume-name>
```

---

## Getting help

- **Bug reports / feature requests:** [GitHub Issues](https://github.com/CallMeTechie/gatecontrol/issues)
- **Security reports:** see [SECURITY.md](SECURITY.md)
- **Discussions:** [GitHub Discussions](https://github.com/CallMeTechie/gatecontrol/discussions)

When filing an issue, include the output of:

```bash
docker compose ps
docker compose logs --tail 200
curl -s http://127.0.0.1:3000/health
```

and redact any sensitive values (passwords, tokens, private keys) before posting.
