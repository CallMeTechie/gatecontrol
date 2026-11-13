# 2. Setting up the server

[← Overview](01-overview.md) · [Contents](README.md) · [Next: Setting up a gateway →](03-gateway-setup.md)

The easiest way is the installation script `setup.sh`. It installs Docker if it
is missing, asks you for the most important values (the time zone too), creates
secure keys, writes the settings file `.env`, creates the data folder `data` and
fetches the update script `update.sh`.

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
   ```

All data of the server (database, keys, certificates) later lives in the folder
`/opt/gatecontrol/data` next to the compose file.

If your server has been running for a while and its data still sits in a Docker
volume, do **not** simply replace the compose file with the new one – it would
start with an empty database. The move is described in the FAQ:
[Move the server data from a Docker volume to ./data](07-faq.md#move-the-server-data-from-a-docker-volume-to-data).

**Check:** `ls -a /opt/gatecontrol` shows `setup.sh`, `docker-compose.yml` and
`.env.example`.

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
   | `Zeitzone [...]` (time zone) | Enter if the suggestion is right (otherwise e.g. `Europe/London`) |
   | `Netzwerk-Interface [...]` (network interface) | Enter (the script detects it) |
   | `Container jetzt starten? (J/n)` (start the container now?) | Enter (= yes) |
   | `Auto-Update-Zeitplan einrichten …? (J/n)` (set up the auto-update schedule?) | Enter (= yes), see [2.9](#29-setting-up-updates) |

   If the script reports `Port … ist bereits belegt` (port already in use), a
   web server or VPN already runs on the server. Stop the script and end that
   service first.

**Check:** The script shows the “Zusammenfassung” (summary) and there are the file
`/opt/gatecontrol/.env`, the folder `/opt/gatecontrol/data` and the script
`/opt/gatecontrol/update.sh`.

## 2.5 The values in `.env` you really need

`setup.sh` has set these values for you. You only need to know them:

| Value | Meaning |
|---|---|
| `GC_BASE_URL` | Address of the web interface, e.g. `https://gate.example.com`. The server fetches the HTTPS certificate for this domain by itself. |
| `GC_WG_HOST` | Address where gateways and devices reach the VPN. |
| `GC_ADMIN_USER` / `GC_ADMIN_PASSWORD` | First login. The password only counts at the very first start; after that you change it in the interface. |
| `GC_CADDY_EMAIL` | Contact for Let's Encrypt (certificate warnings). |
| `GC_SECRET`, `GC_ENCRYPTION_KEY` | Secret keys created by the script. **Never change them, never pass them on.** Without the encryption key a database backup is worthless. |
| `TZ` | Time zone, e.g. `Europe/Berlin` (an IANA name). The gateways take it over from the server. It applies to the nightly port scan, the speed test plan and the DNS filter's times. Without `TZ` the server runs in UTC, and the gateways then use UTC as well. |

`setup.sh` protects the file so that only root can read it (`chmod 600`).

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

**Check:** `grep -c '^TZ=' /opt/gatecontrol/.env` shows `1`. If it shows `0`
(older installation), add the line – see the FAQ
[“The server runs in UTC”](07-faq.md#the-server-runs-in-utc).

## 2.6 Start the server

1. If you answered “Container jetzt starten” (start the container now) with yes
   in `setup.sh`, GateControl is already running. Otherwise start it:

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
2. Create the route in GateControl (“Services” → “Domains / Routes”).

The server fetches the certificate by itself.

**Check:** `https://nas.example.com` opens without a certificate warning.

## 2.9 Setting up updates

GateControl updates itself with `update.sh`. The script has to run every 5 minutes.

1. `setup.sh` creates the schedule when you answered yes to
   “Auto-Update-Zeitplan einrichten” (set up the auto-update schedule). Check it:

   ```bash
   cat /etc/cron.d/gatecontrol-update
   ```

   If the file is missing, create it yourself:

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

Whether there are updates is shown on the dashboard, in the “Updates” card
right below the tiles. It has four fields: Server, Plugins, Gateways and Apps.
When everything is up to date, there is only the line “Everything is up to
date”. When there are updates, the card opens: each field says what is new and
leads to the matching page. The “Server” field names the new version in Manual
mode, too. The “Apps” field counts the devices whose app is older than the
newest version. Devices that have not reported a version yet do not count as
outdated; they are listed as “without a version”. For this, GateControl asks
GitHub at most once an hour. If GitHub or the plugin catalogue does not answer,
the field shows “Could not be checked” and the last known state. The arrow
button on the right of the card checks again right away.

**Check:** After 5 minutes at most, “Settings” → “Updates” shows a status (no
longer “Auto-update not set up”). The log is in `/var/log/gatecontrol-update.log`.
If it stays at “not set up”, see the FAQ
[“Auto-update not set up” although the schedule runs](07-faq.md#auto-update-not-set-up-although-the-schedule-runs).

## 2.10 Backup

The easiest way is to back up the whole folder (it contains secrets, so protect it well):

```bash
tar czf /root/gatecontrol-$(date +%F).tar.gz -C /opt gatecontrol
chmod 600 /root/gatecontrol-*.tar.gz
```

More on this (also backups in the interface under “Settings” → “Backups”):
[INSTALL.md §10](../../INSTALL.md#10-backup-and-restore).

**Plugin data in the backup:** every backup takes up to 512 MB of plugin data
(the databases and files of all plugins together). If a part no longer fits,
it is missing – and that shows under “Local backup files”, at the off-site
target and on the dashboard under “Problems”, e.g. “⚠ Not complete: Mail
(database too large for the backup)”, plus a notification like for a failed
backup. What is in it and what is not:
[FAQ: What is in the backup?](07-faq.md#what-is-in-the-backup). Plan disk
space for one backup more than you keep: the oldest is only deleted once the
new one is complete. If there is not enough space, GateControl makes no
backup and says so.

**Off-site backups** (Settings → Backups, licence “scheduled backups”)
upload an encrypted copy over SFTP, SMB, S3 or WebDAV after every automatic
backup. For a NAS at home behind a gateway, choose “Through a VPN device” or
“Through a route” under “Connection” – exactly as for Drive's storage
target; “Take over a storage target from Drive/plugins” fills in its
settings. See
[FAQ: Off-site backup to a NAS behind the VPN](07-faq.md#off-site-backup-to-a-nas-behind-the-vpn).
The encrypted copy is stored briefly on the server's disk next to the
backups while it is uploaded (it is never held in memory, so a small VPS is
fine) – plan free space for about one more backup. If it is missing,
GateControl uploads nothing and says so at the target.

The connection is always encrypted, without any certificate file:

- **WebDAV and S3:** if the NAS identifies itself with its own certificate
  (common for NAS devices on a home network), “Test” shows the device and how
  long the certificate is valid, with the button **“Trust this device”**.
  Through a VPN device or a route, GateControl remembers the certificate on
  first contact (“NAS certificate remembered”). With “Directly to the
  address” you always decide with a click.
- **New certificate:** when the NAS renews its certificate, GateControl stops
  and asks: “The NAS certificate has changed (e.g. after a renewal). Is that
  okay?” – with the button **“Trust the new certificate”**. A changed
  certificate is never taken over silently.
- **SMB:** “Encrypt connection (SMB3)” is on for new targets. If the share
  cannot do it, “Test” tells you where to switch it on at the NAS (Synology:
  Control Panel › File Services › SMB › Advanced → SMB3 encryption).

The field for a PEM file is still there, folded under “Advanced” – only for
experts with their own CA.

**Check:** `tar tzf /root/gatecontrol-*.tar.gz | grep -c data/` shows a number greater than 0.

Continue with [chapter 3: Setting up a gateway](03-gateway-setup.md).
