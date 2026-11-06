# 2. Setting up the server

[← Overview](01-overview.md) · [Contents](README.md) · [Next: Setting up a gateway →](03-gateway-setup.md)

The easiest way is the installation script `setup.sh`. It installs Docker if it
is missing, asks you for the most important values, creates secure keys and
writes the settings file `.env`.

All commands in this chapter run **on the server as root**.

## 2.1 Point the domain to the server

1. Log in at your domain provider.
2. Create an **A record** that points to the public IPv4 address of your server:

   ```
   gate.example.com.   IN  A   198.51.100.42
   ```

3. Wait until the record is known worldwide (usually a few minutes, rarely up to 30 minutes).

**Check:** `dig +short gate.example.com` (or `nslookup gate.example.com`) shows the IP of your server.

## 2.2 Open the ports

Open these in your server provider's firewall (and in `ufw`/`iptables` if you use them):

| Port | Protocol | What for |
|---|---|---|
| 80 | TCP | HTTP and Let's Encrypt's automatic certificate check |
| 443 | TCP | HTTPS for the web interface and all routes |
| 443 | UDP | HTTP/3 (optional) |
| 51820 | UDP | WireGuard VPN (gateways and devices) |

**Check:** The four rules are listed in your provider's firewall overview.

## 2.3 Download the files

1. Log in to the server via SSH and become root:

   ```bash
   sudo -i
   ```

2. Create the folder and download the files:

   ```bash
   mkdir -p /opt/gatecontrol && cd /opt/gatecontrol
   curl -fsSLO https://github.com/CallMeTechie/gatecontrol/releases/latest/download/setup.sh
   curl -fsSLO https://github.com/CallMeTechie/gatecontrol/releases/latest/download/docker-compose.yml
   curl -fsSLO https://github.com/CallMeTechie/gatecontrol/releases/latest/download/.env.example
   curl -fsSLO https://raw.githubusercontent.com/CallMeTechie/gatecontrol/master/update.sh
   chmod +x update.sh
   ```

3. Keep the data in the folder `data` next to the compose file. Otherwise the
   shipped `docker-compose.yml` stores it in a Docker volume you do not see in
   the file system. The update script `update.sh` and the backups in
   [INSTALL.md](../../INSTALL.md#10-backup-and-restore) expect the folder
   `/opt/gatecontrol/data`:

   ```bash
   sed -i 's#gatecontrol-data:/data#./data:/data#' docker-compose.yml
   grep -n ':/data' docker-compose.yml
   ```

   If your server has been running with the unchanged file for a while, do
   **not** simply change it – it would start with an empty database. The move is
   described in [INSTALL.md §12](../../INSTALL.md#12-migration-from-older-setups).

**Check:** `ls -a /opt/gatecontrol` shows `setup.sh`, `docker-compose.yml`,
`.env.example` and `update.sh`. The `grep` command shows the line `- ./data:/data`.

## 2.4 Run the installation script

1. Start the script:

   ```bash
   cd /opt/gatecontrol
   bash setup.sh
   ```

2. Answer the questions (the script asks in German):

   | Question of the script | What you enter |
   |---|---|
   | `Domain fuer das Web-Interface` (domain for the web interface) | your domain, e.g. `gate.example.com` |
   | `HTTPS verwenden? (J/n)` (use HTTPS?) | Enter (= yes) |
   | `Oeffentliche IP oder Domain fuer WireGuard` (public IP or domain for WireGuard) | Enter (= the same domain) |
   | `Admin-Benutzername [admin]` (admin user name) | Enter or a name of your own |
   | `Admin-Passwort` / `Passwort wiederholen` (password / repeat) | a strong password (not shown while typing) |
   | `Sprache (de/en) [de]` (language) | `en` |
   | `E-Mail fuer Let's Encrypt Zertifikate (optional)` | your e-mail address (recommended) |
   | `Netzwerk-Interface [...]` (network interface) | Enter (the script detects it) |
   | `Container jetzt starten? (J/n)` (start the container now?) | **`n`** – first you set the time zone |

   If the script reports `Port … ist bereits belegt` (port already in use), a
   web server or VPN already runs on the server. Stop the script and end that
   service first.

**Check:** The script shows the “Zusammenfassung” (summary) and there is a file
`/opt/gatecontrol/.env`.

## 2.5 The values in `.env` you really need

`setup.sh` has set these values for you. You only need to know them:

| Value | Meaning |
|---|---|
| `GC_BASE_URL` | Address of the web interface, e.g. `https://gate.example.com`. The server fetches the HTTPS certificate for this domain by itself. |
| `GC_WG_HOST` | Address where gateways and devices reach the VPN. |
| `GC_ADMIN_USER` / `GC_ADMIN_PASSWORD` | First login. The password only counts at the very first start; after that you change it in the interface. |
| `GC_CADDY_EMAIL` | Contact for Let's Encrypt (certificate warnings). |
| `GC_SECRET`, `GC_ENCRYPTION_KEY` | Secret keys created by the script. **Never change them, never pass them on.** Without the encryption key a database backup is worthless. |

One line is still missing: the **time zone**.

1. Add it to `.env`:

   ```bash
   cd /opt/gatecontrol
   echo 'TZ=Europe/Berlin' >> .env
   ```

   Use your own zone instead of `Europe/Berlin` (an IANA name such as
   `Europe/London`). Why? The gateways take their time zone from the server. It
   applies to the nightly port scan, the speed test plan and the DNS filter's
   times. Without `TZ` the server runs in UTC, and the gateways then use UTC as well.

2. Protect the file so that only root can read it:

   ```bash
   chmod 600 .env
   ```

**Security note:** `.env` contains your admin password and the secret keys.
Never pass it on, never send it by chat or e-mail and never paste it into a ticket.

A rule for later: after **every** change to `.env` you restart with

```bash
cd /opt/gatecontrol
docker compose up -d
```

– **not** with `docker restart gatecontrol`. Only `docker compose up -d`
recreates the container with the new values. `docker restart` starts it with
the old values.

**Check:** `grep -c '^TZ=' /opt/gatecontrol/.env` shows `1`.

## 2.6 Start the server

1. Start GateControl:

   ```bash
   cd /opt/gatecontrol
   docker compose up -d
   ```

2. Watch the first start:

   ```bash
   docker compose logs -f gatecontrol
   ```

   After 10–30 seconds `certificate obtained successfully` appears. Now the
   server has its HTTPS certificate. Leave the view with `Ctrl+C` – the server
   keeps running.

**Check:**

- `docker compose ps` shows `gatecontrol` with `(healthy)`.
- `curl -s https://gate.example.com/health` answers `{"ok":true}`.
- `docker exec gatecontrol printenv TZ` shows your time zone.

## 2.7 First login

1. Open your address in the browser, e.g. `https://gate.example.com`.
2. Log in with the user name (default `admin`) and the password from `setup.sh`.
3. Change the password: user menu at the top right → “Profile” → “Change Password”.

You do not need to create a route for the web interface itself. GateControl does that automatically.

**Check:** You see the dashboard. The browser shows a lock symbol (valid certificate).

## 2.8 Domain and HTTPS

HTTPS for the web interface is now done. The same applies to every further
domain you set up as a route (e.g. `nas.example.com`):

1. Create an A record pointing to the server's IP at your domain provider.
2. Create the route in GateControl (“Network” → “Domains / Routes”).

The server fetches the certificate by itself.

**Check:** `https://nas.example.com` opens without a certificate warning.

## 2.9 Setting up updates

GateControl updates itself with `update.sh`. The script has to run every 5 minutes.

1. Create the schedule:

   ```bash
   echo '*/5 * * * * root /opt/gatecontrol/update.sh' > /etc/cron.d/gatecontrol-update
   ```

   If the folder `/etc/cron.d` is missing, install cron first (Debian/Ubuntu: `apt install cron`).

2. In GateControl choose the mode under “Settings” → “Updates”:
   - **Automatic:** new versions come by themselves, if you like only in a maintenance window.
   - **Manual:** the server only updates when you click “Update now”.

You can update by hand at any time:

```bash
cd /opt/gatecontrol
./update.sh
```

If an update fails, `update.sh` brings back the previous version automatically.

**Check:** After 5 minutes at most, “Settings” → “Updates” shows a status (no
longer “Auto-update not set up”). The log is in `/var/log/gatecontrol-update.log`.

## 2.10 Backup

The easiest way is to back up the whole folder (it contains secrets, so protect it well):

```bash
tar czf /root/gatecontrol-$(date +%F).tar.gz -C /opt gatecontrol
chmod 600 /root/gatecontrol-*.tar.gz
```

More on this (also backups in the interface under “Settings” → “Backups”):
[INSTALL.md §10](../../INSTALL.md#10-backup-and-restore).

**Check:** `tar tzf /root/gatecontrol-*.tar.gz | grep -c data/` shows a number greater than 0.

Continue with [chapter 3: Setting up a gateway](03-gateway-setup.md).
