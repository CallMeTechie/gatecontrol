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

## 2.11 Names in the VPN

Every VPN device can get a name. You then reach your office computer, for
example, as `laptop-buero.gc.internal` instead of an address like `10.8.0.14`.
The names only exist in the VPN.

If you have entered a domain of your own under “Services” → “Domains / Routes”,
the names can hang on it:

1. Open “Settings” → “VPN & network” → “Names in the VPN”.
2. Choose your domain under “Domain”.
3. Leave the suggestion `vpn` under “Subdomain” or enter another one. Below
   you see at once what a device will be called, for example
   `laptop-buero.vpn.example.com`.
4. Click “Save” at the bottom.

The previous name with `gc.internal` keeps working. You do not have to enter
anything at your domain provider, and nobody can resolve these names from
outside. If the page says that the subdomain already is a host or a route, use
the free subdomain it suggests.

You see and change the name of a device under “Devices” → “Peers / Clients”:
it is on the card of the device, with a button to copy it. A device without a
name offers “Give a name”. For a gateway the name is in the head of its page;
you change it there under “More” → “Change name and group …”.

**Names of gateways:** A gateway has a name too, and it resolves on every VPN
device. Only the server can reach it, though: the tunnel of a gateway lets no
other VPN device in, on purpose. The interface says so below the name; in
the dialog “Change name and group …” the line reads “The gateway's name in the
VPN: …” instead of “Reachable as …”.
`nas.vpn.example.com:5000` therefore does not answer, even when the gateway
runs on the NAS. For services in the home network behind the gateway – the
interface of the NAS, a printer, a camera – create a route under “Services” →
“Domains / Routes”: choose the gateway or its pool as the target and enter the
address of the device in the home network and the port (for example
`192.168.1.20` and `5000`). The host of the route must not be below the zone
of the device names: `nas.example.com` works, `nas.vpn.example.com` does not.
Exception: with a valid “certificate for the names”, internal routes with a
name of their own work below the zone, such as `nas-web.vpn.example.com` (see
[2.12](#212-a-valid-certificate-for-the-names-in-the-vpn)).

Names under your own domain exist from server **1.271.0**. The Windows apps
resolve them from GateControl Pro **1.85.0** and Community **1.49.0** – they
create one DNS rule per zone for this. Older apps only resolve the spelling
with `gc.internal` reliably; use that name there until the update. The Android
app needs no update.

**Check:** Under “Settings” → “VPN & network” → “State of the names” the row
“Service” says “running”. On a device in the VPN,
`ping laptop-buero.vpn.example.com` answers (with the name of one of your devices).

## 2.12 A valid certificate for the names in the VPN

The names under your VPN zone can get a certificate that every browser trusts
– without a warning and without confirming anything on each device. The names
stay in the VPN: at your domain provider a check record appears for a moment
only, nothing else. The public certificate logs only show
`*.vpn.example.com`, no device or service name.

**Requirement:** An own domain is chosen under “Names in the VPN” (see
[2.11](#211-names-in-the-vpn)), and your domain provider offers a DNS
interface. If not, take the way “Forwarding via deSEC” further below. The
function belongs to the licence feature “Internal DNS”.

1. Open “Settings” → “VPN & network” → “Certificate for the names” and click
   “Set up”.
2. Choose your provider under “DNS provider”. If there already is a suggestion
   (“Detected from the name servers …”), it usually fits.
3. Create an access for the interface at the provider (table below) and enter
   it. Give the access as few rights as possible.
4. Click “Test”. All five items should get a tick. The test writes a check
   record with a unique test value under `_acme-challenge.vpn.example.com`
   (with a forwarding under its target), waits until the responsible DNS
   servers serve it and deletes it again. Let's Encrypt is not asked. Under
   “Publicly visible” it suggests a waiting time; “Use” enters it under
   “Advanced”.
5. Click “Save” at the bottom. After one to three minutes the card says
   “valid”.

As soon as the certificate is valid, the server switches over by itself:

- **Portal:** It then runs under `home.vpn.example.com` with the valid
  certificate. This address goes to the apps that resolve the zone: the
  Android app, GateControl Pro from **1.85.0** and Community from **1.49.0**.
  Older Windows apps, invitation and kiosk links and the link in the menu keep
  using `home.gc.internal` – that address works for good. If a public portal
  domain is entered under “Portal”, the portal stays there.
- **Management:** In the VPN you also reach the management under
  `https://server.vpn.example.com` and `https://gc-server.vpn.example.com`.
  The main address (`GC_BASE_URL`) stays. Under the new names you sign in
  separately (a sign-in applies per address); passkeys and the sign-in via a
  directory service (OIDC) only exist under the main address. Outside the VPN
  the names do not answer.

If the server stops the certificate or it expires, the portal and the
management go back to their previous addresses.

The certificate renews itself 30 days before it expires. If that fails
several times, the server stops further attempts so that Let's Encrypt does
not block the domain, and the card says what the provider reported. If the
certificate expires in less than 14 days, it shows up among the problems on
the dashboard and under “Domains & certificates”.

**Forwarding via deSEC (safest way):** Create a free zone at deSEC, for example
`vpn-example.dedyn.io`, and a token there that may only change TXT records
under `_acme-challenge`. Add once by hand at your domain provider:

```
_acme-challenge.vpn.example.com.  CNAME  _acme-challenge.vpn-example.dedyn.io.
```

In GateControl choose “Forwarding via deSEC”, enter the target and the token
and click “Test”. The access to your actual domain stays out of GateControl
entirely. With another provider for the target zone it works the same way:
switch on “Use forwarding (CNAME)” under “Advanced”.

### Where you get the access and which rights are enough

| Provider | What you enter | Where | Limit the rights |
|---|---|---|---|
| Hetzner | API token | Hetzner Console › project › security › API tokens (“Read & Write”) | whole project – put the zone into a project of its own; move zones from the old DNS console first |
| IONOS | API key (`prefix.secret`) | IONOS developer portal › API keys | all zones – forwarding is better |
| netcup | customer number, API key, API password | customer control panel › master data › API | all domains – forwarding is better |
| INWX | user name, password, 2FA secret if active | INWX account; if possible a user for DNS only | account/user – forwarding is better |
| All-Inkl.com | KAS login, KAS password | KAS | whole account – forwarding strongly recommended |
| OVHcloud | endpoint, application key/secret, consumer key | OVH API: token with rules for `/domain/zone/example.com/*` only | one zone |
| Cloudflare | API token | profile › API tokens › “Zone · DNS · Edit”, this zone only | one zone |
| deSEC | token | deSEC › token with a policy: domain, subname `_acme-challenge.vpn`, type TXT | TXT only |
| RFC 2136 | server, key name, algorithm, key | own DNS server (BIND: `update-policy { grant … name _acme-challenge.vpn.example.com TXT; };`) | TXT only |
| acme-dns | server URL, user, password, subdomain, CNAME target | own acme-dns service + one CNAME at the provider | TXT only |

Strato and other providers without a DNS interface: use the forwarding via
deSEC.

The credentials are stored encrypted in the database and in backups. The
interface never shows them again, only “stored on …”; with “Change” an empty
field keeps the stored value. “Switch off” deletes them. If you choose another
zone under “Names in the VPN”, the card asks for a new setup.

**What the certificate does not cover:** services that run directly on a
device, for example the interface of a NAS under `nas.vpn.example.com:5001`:
their TLS ends on the device. And a certificate covers one level:
`nas-web.vpn.example.com` yes, `a.b.vpn.example.com` no. Which names the
server answers with it is listed in the card under “Used by”.

**Internal routes below the zone:** For a service on a device or behind a
gateway, create a host with a name of its own below the zone under “Services”
→ “Domains / Routes”, for example `nas-web` under `example.com` (that is
`nas-web.vpn.example.com`), target the NAS. That works while the certificate
is valid, and one level deep only. Such routes are **always reachable in the
VPN only** – the dialog says so, and the switch “Reachable externally” stays
off. A name a VPN device already has and the fixed names of the server
(`home`, `server`, `gateway` …) do not work. The route gets the wildcard
certificate; when that ends, it gets an internal certificate of the server.

**Check:** The card “Certificate for the names” says “valid” with the expiry
date, “Used by” lists `home.vpn.example.com` (portal) and
`server.vpn.example.com` (management), and `*.vpn.example.com` appears under
“Domains & certificates” with Let's Encrypt as issuer. On a device in the VPN,
`https://home.vpn.example.com` opens the portal without a warning.
