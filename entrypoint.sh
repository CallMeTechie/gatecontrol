#!/bin/sh
set -e

# ─── Defaults ────────────────────────────────────────
GC_WG_INTERFACE="${GC_WG_INTERFACE:-wg0}"
GC_WG_PORT="${GC_WG_PORT:-51820}"
GC_WG_SUBNET="${GC_WG_SUBNET:-10.8.0.0/24}"
GC_WG_GATEWAY_IP="${GC_WG_GATEWAY_IP:-10.8.0.1}"
GC_WG_DNS="${GC_WG_DNS:-10.8.0.1}"
GC_DNSMASQ_UPSTREAMS="${GC_DNSMASQ_UPSTREAMS:-1.1.1.1,8.8.8.8}"
GC_DNS_DOMAIN="${GC_DNS_DOMAIN:-gc.internal}"
GC_DNS_HOSTS_FILE="${GC_DNS_HOSTS_FILE:-/data/dns/peers.hosts}"
GC_WG_POST_UP="${GC_WG_POST_UP:-}"
GC_WG_POST_DOWN="${GC_WG_POST_DOWN:-}"
GC_WG_MTU="${GC_WG_MTU:-}"
# Auto-detect the default-route interface if GC_NET_INTERFACE is not
# set, OR if the configured value does not actually exist on the host.
# Historically the default was "eth0", which is wrong on many hosts
# (OVH dedicated/VPS uses ens18, Debian/Ubuntu often uses enpXsY, etc.).
# A stale value produces a silent NAT misconfig: the MASQUERADE rule is
# installed on a non-existent interface, so VPN peer traffic gets
# forwarded from wg0 with source IP 10.8.0.x and the reply never finds
# its way back. Result: VPN clients have no internet, no API access, and
# no connectivity to anything that isn't terminated on the gatecontrol
# container itself. Auto-detection fixes this for both new deployments
# and upgrades of existing deployments whose .env still carries the old
# default. Explicit overrides for real, existing interfaces are honored.
_detect_egress_if() {
  ip route 2>/dev/null | awk '/^default/ {print $5; exit}'
}
_iface_exists() {
  ip link show "$1" > /dev/null 2>&1
}
if [ -z "$GC_NET_INTERFACE" ] || ! _iface_exists "$GC_NET_INTERFACE"; then
  if [ -n "$GC_NET_INTERFACE" ]; then
    echo "» Configured GC_NET_INTERFACE='${GC_NET_INTERFACE}' does not exist — auto-detecting"
  fi
  GC_NET_INTERFACE=$(_detect_egress_if)
  if [ -z "$GC_NET_INTERFACE" ]; then
    echo "WARNING: no default route found — falling back to eth0"
    GC_NET_INTERFACE="eth0"
  else
    echo "» Auto-detected egress interface: ${GC_NET_INTERFACE}"
  fi
fi
export GC_NET_INTERFACE
GC_DB_PATH="${GC_DB_PATH:-/data/gatecontrol.db}"

# Persistent config lives in the data volume
WG_DATA_CONF="/data/wireguard/${GC_WG_INTERFACE}.conf"
WG_SYSTEM_CONF="/etc/wireguard/${GC_WG_INTERFACE}.conf"

# Override config path to point to persistent location
export GC_WG_CONFIG_PATH="$WG_SYSTEM_CONF"
export GC_WG_INTERFACE

# ─── Validate required secrets ─────────────────────────
if [ -z "$GC_ADMIN_PASSWORD" ] || [ "$GC_ADMIN_PASSWORD" = "changeme" ]; then
  echo "ERROR: GC_ADMIN_PASSWORD is not set or still default."
  echo "       Please set a strong password in your .env file."
  exit 1
fi

if [ -z "$GC_WG_HOST" ] || [ "$GC_WG_HOST" = "gate.example.com" ]; then
  echo "ERROR: GC_WG_HOST is not set or still the example value."
  echo "       Please set your server's public IP or domain in your .env file."
  exit 1
fi

echo "╔══════════════════════════════════════╗"
echo "║         GateControl Starting         ║"
echo "╚══════════════════════════════════════╝"

# ─── Enable IP forwarding ────────────────────────────
echo "» Enabling IP forwarding..."
sysctl -w net.ipv4.ip_forward=1 > /dev/null 2>&1 || true
sysctl -w net.ipv4.conf.all.src_valid_mark=1 > /dev/null 2>&1 || true

# ─── Safety-net MASQUERADE for the VPN subnet ────────
# Even with a correctly-generated wg0.conf, wg-quick PostUp rules are
# applied when the wg interface comes up — which happens AFTER this
# entrypoint script returns control to supervisord. If any step of that
# hand-off is interrupted or the PostUp rule targets the wrong egress
# interface, VPN peers lose internet. Install an idempotent MASQUERADE
# rule here so the NAT is in place the moment wg0 is created, regardless
# of wg-quick's own rule. -C checks before -A to avoid duplicates.
iptables -t nat -C POSTROUTING -s "${GC_WG_SUBNET}" -o "${GC_NET_INTERFACE}" -j MASQUERADE 2>/dev/null || \
  iptables -t nat -A POSTROUTING -s "${GC_WG_SUBNET}" -o "${GC_NET_INTERFACE}" -j MASQUERADE
echo "» MASQUERADE rule active: ${GC_WG_SUBNET} → ${GC_NET_INTERFACE}"

# ─── Ensure data directory ───────────────────────────
mkdir -p /data/caddy /data/wireguard /data/branding
mkdir -p "$(dirname "$GC_DB_PATH")"

# Internal DNS peer hosts file — managed by services/dns.js at runtime.
# Touched here so dnsmasq doesn't abort if no peer has a hostname yet.
mkdir -p "$(dirname "$GC_DNS_HOSTS_FILE")"
[ -f "$GC_DNS_HOSTS_FILE" ] || : > "$GC_DNS_HOSTS_FILE"

# ─── Generate WireGuard config if not exists ─────────
# Config is stored persistently in /data/wireguard/ and symlinked to /etc/wireguard/
if [ ! -f "$WG_DATA_CONF" ]; then
  echo "» Generating WireGuard server keypair..."
  PRIVATE_KEY=$(wg genkey)
  PUBLIC_KEY=$(echo "$PRIVATE_KEY" | wg pubkey)

  POST_UP="${GC_WG_POST_UP}"
  POST_DOWN="${GC_WG_POST_DOWN}"

  if [ -z "$POST_UP" ]; then
    # -i wg0 -j ACCEPT is a catch-all for the forward path out of the
    # tunnel: it permits both peer-to-peer (wg0 → wg0) and peer → internet
    # (wg0 → ens18). Scoping to -d ${GC_WG_SUBNET} here was too narrow —
    # it only allowed peer-to-peer and silently dropped every packet that
    # VPN clients sent to the public internet, so the tunnel came up but
    # no outbound traffic worked. The reply path is covered by the
    # RELATED,ESTABLISHED rule below.
    POST_UP="iptables -I FORWARD 1 -i ${GC_WG_INTERFACE} -j ACCEPT; iptables -I FORWARD 2 -i ${GC_NET_INTERFACE} -o ${GC_WG_INTERFACE} -m state --state RELATED,ESTABLISHED -j ACCEPT; iptables -t nat -A POSTROUTING -s ${GC_WG_SUBNET} -o ${GC_NET_INTERFACE} -j MASQUERADE"
    POST_UP_MSS="iptables -t mangle -A FORWARD -i ${GC_WG_INTERFACE} -p tcp --tcp-flags SYN,RST SYN -j TCPMSS --clamp-mss-to-pmtu; iptables -t mangle -A FORWARD -o ${GC_WG_INTERFACE} -p tcp --tcp-flags SYN,RST SYN -j TCPMSS --clamp-mss-to-pmtu"
  fi
  if [ -z "$POST_DOWN" ]; then
    POST_DOWN="iptables -D FORWARD -i ${GC_WG_INTERFACE} -j ACCEPT; iptables -D FORWARD -i ${GC_NET_INTERFACE} -o ${GC_WG_INTERFACE} -m state --state RELATED,ESTABLISHED -j ACCEPT; iptables -t nat -D POSTROUTING -s ${GC_WG_SUBNET} -o ${GC_NET_INTERFACE} -j MASQUERADE"
    POST_DOWN_MSS="iptables -t mangle -D FORWARD -i ${GC_WG_INTERFACE} -p tcp --tcp-flags SYN,RST SYN -j TCPMSS --clamp-mss-to-pmtu; iptables -t mangle -D FORWARD -o ${GC_WG_INTERFACE} -p tcp --tcp-flags SYN,RST SYN -j TCPMSS --clamp-mss-to-pmtu"
  fi

  echo "» Writing WireGuard config to ${WG_DATA_CONF}..."
  cat > "$WG_DATA_CONF" <<EOF
[Interface]
Address = ${GC_WG_GATEWAY_IP}/$(echo "$GC_WG_SUBNET" | cut -d'/' -f2)
ListenPort = ${GC_WG_PORT}
PrivateKey = ${PRIVATE_KEY}
PostUp = ${POST_UP}
PostUp = ${POST_UP_MSS:-}
PostDown = ${POST_DOWN}
PostDown = ${POST_DOWN_MSS:-}
EOF

  WG_MTU="${GC_WG_MTU:-1420}"
  echo "MTU = ${WG_MTU}" >> "$WG_DATA_CONF"

  chmod 600 "$WG_DATA_CONF"
  echo "» WireGuard config generated (pubkey: ${PUBLIC_KEY})"
else
  echo "» WireGuard config exists at ${WG_DATA_CONF}"

  # Existing deployments may have a wg0.conf whose PostUp MASQUERADEs
  # on a stale interface name (e.g. baked-in "eth0" on a host that
  # actually uses "ens18"). Detect that case by scanning the PostUp
  # lines for "-o <iface>" and rewrite any mismatched interface in-
  # place. Preserves private key, peer list, address, port — only the
  # iptables directives are touched.
  STALE_IF=$(grep -oE '\-o [A-Za-z0-9]+' "$WG_DATA_CONF" | awk '{print $2}' | sort -u | head -1)
  if [ -n "$STALE_IF" ] && [ "$STALE_IF" != "$GC_NET_INTERFACE" ]; then
    echo "» Migrating wg0.conf PostUp interface ${STALE_IF} → ${GC_NET_INTERFACE}"
    # POSIX sed handles every occurrence; -i is GNU/BusyBox-compatible.
    sed -i "s/-o ${STALE_IF}/-o ${GC_NET_INTERFACE}/g" "$WG_DATA_CONF"
  fi
fi

# Symlink persistent config to system path
ln -sf "$WG_DATA_CONF" "$WG_SYSTEM_CONF"
echo "» Symlinked ${WG_DATA_CONF} → ${WG_SYSTEM_CONF}"

# ─── Generate Caddyfile if not exists ────────────────
CADDYFILE="/app/config/Caddyfile"
if [ ! -f "$CADDYFILE" ]; then
  echo "» Generating initial Caddyfile..."
  cat > "$CADDYFILE" <<EOF
{
  admin 127.0.0.1:2019 {
    origins 127.0.0.1 127.0.0.1:2019
  }
  ${GC_CADDY_EMAIL:+email $GC_CADDY_EMAIL}
  ${GC_CADDY_ACME_CA:+acme_ca $GC_CADDY_ACME_CA}
}
EOF
fi

# ─── Ensure Caddy admin allows local origin (v2.11+) ──
if ! grep -q "origins" "$CADDYFILE" 2>/dev/null; then
  echo "» Updating Caddyfile: adding admin origins for Caddy v2.11+..."
  sed -i 's|admin 127.0.0.1:2019|admin 127.0.0.1:2019 {\n    origins 127.0.0.1 127.0.0.1:2019\n  }|' "$CADDYFILE"
fi

# ─── Validate Caddy config ────────────────────────────
echo "» Validating Caddy config..."
if ! caddy validate --config "$CADDYFILE" --adapter caddyfile > /dev/null 2>&1; then
  echo "WARNING: Caddy config validation failed — check your Caddyfile"
fi

# ─── Pre-generate Caddy JSON from DB state ───────────
# Previously Caddy started with the minimal Caddyfile and Node replaced
# its whole config via POST /load 5 s later. Caddy's internal TLS re-init
# during that /load sometimes left the listener in a broken state —
# browsers and the Home-Gateway heartbeat got `TLS alert 80 (internal
# error)` until the container was restarted a second time. Writing the
# final JSON here and booting Caddy directly with it eliminates the race.
# Falls back to the Caddyfile if the export or validation fails, so the
# admin UI stays reachable on fresh installs or after a bad DB state.
CADDY_JSON="/data/caddy/runtime.json"
echo "» Exporting Caddy JSON from DB..."
if node /app/src/bin/export-caddy-config.js "$CADDY_JSON" && \
   caddy validate --config "$CADDY_JSON" > /dev/null 2>&1; then
  export GC_CADDY_CONFIG_PATH="$CADDY_JSON"
  export GC_CADDY_CONFIG_PRELOADED=1
  echo "» Caddy will start from pre-generated JSON ($CADDY_JSON)"
else
  export GC_CADDY_CONFIG_PATH="$CADDYFILE"
  echo "» Caddy will start from Caddyfile (export/validate skipped)"
fi

# ─── Generate dnsmasq config for split-horizon DNS ────
# VPN peers normally resolve the API hostname to its public IP. WireGuard
# then creates an endpoint-route exception for that IP, so API traffic to
# the server goes DIRECTLY (not through the tunnel) and fails when the
# client's physical network cannot reach the public endpoint.
#
# Dnsmasq listens on ${GC_WG_GATEWAY_IP}:53 and hijacks the API hostname
# to return the VPN gateway IP instead. Clients that use this DNS (set
# via GC_WG_DNS in their peer config) will resolve the API hostname to
# the VPN-internal gateway and their traffic flows through the tunnel,
# hitting Caddy bound on 0.0.0.0:443 via the wg0 interface.
#
# The hostname to hijack comes from GC_BASE_URL (the API URL clients
# use), NOT from GC_WG_HOST (which is the WireGuard endpoint and is
# often a bare IP). If GC_BASE_URL is unset we fall back to GC_WG_HOST.
# If the resulting value looks like an IPv4 address, the host-record is
# skipped because rewriting IP→IP is nonsense.
#
# Regenerated every start so changes to GC_BASE_URL / GC_WG_GATEWAY_IP
# propagate without manual intervention.
if [ -n "$GC_BASE_URL" ]; then
  GC_API_HOST=$(echo "$GC_BASE_URL" | sed -E 's|^[a-z]+://||; s|[/:?#].*||')
else
  GC_API_HOST="$GC_WG_HOST"
fi

DNSMASQ_CONF="/app/config/dnsmasq.conf"
echo "» Generating dnsmasq config (split-horizon for ${GC_API_HOST} → ${GC_WG_GATEWAY_IP})..."
{
  echo "# Auto-generated by entrypoint.sh — do not edit manually."
  # bind-dynamic + interface=<name> makes dnsmasq watch for the named
  # interface to appear and bind to its current addresses, even if the
  # interface does not exist at dnsmasq startup. This is critical for
  # wg0, which wg-quick may create AFTER dnsmasq has already started
  # (supervisord does not serialize on the wireguard program's readiness
  # before launching dnsmasq). Using listen-address= here would silently
  # skip 10.8.0.1 whenever dnsmasq wins the startup race.
  echo "bind-dynamic"
  echo "interface=lo"
  echo "interface=${GC_WG_INTERFACE}"
  echo "except-interface=${GC_NET_INTERFACE}"
  echo "no-resolv"
  echo "no-hosts"
  echo "cache-size=1000"
  echo "log-facility=-"
  # Internal DNS hardening: never forward queries for the internal domain
  # upstream (prevents leaking internal hostnames to public resolvers and
  # blocks poisoning via spoofed upstream answers). domain-needed drops
  # name-only (un-qualified) lookups; bogus-priv drops reverse lookups of
  # RFC1918 addresses.
  echo "local=/${GC_DNS_DOMAIN}/"
  echo "domain=${GC_DNS_DOMAIN}"
  echo "domain-needed"
  echo "bogus-priv"
  # Peer-hostname hosts file. The file is regenerated atomically by
  # services/dns.js on peer mutations and dnsmasq is reloaded via SIGHUP.
  # We touch it here to ensure dnsmasq doesn't abort on missing file at
  # cold-start (before any peer is registered).
  echo "addn-hosts=${GC_DNS_HOSTS_FILE}"
  # Static gateway entries — always resolvable regardless of peer state.
  echo "host-record=gateway.${GC_DNS_DOMAIN},${GC_WG_GATEWAY_IP}"
  echo "host-record=server.${GC_DNS_DOMAIN},${GC_WG_GATEWAY_IP}"
  echo "host-record=gc-server.${GC_DNS_DOMAIN},${GC_WG_GATEWAY_IP}"
  # Upstream resolvers (comma-separated env var → one server= line each)
  echo "$GC_DNSMASQ_UPSTREAMS" | tr ',' '\n' | while IFS= read -r upstream; do
    upstream=$(echo "$upstream" | tr -d '[:space:]')
    [ -n "$upstream" ] && echo "server=$upstream"
  done
  # Hijack: return the VPN gateway IP for the configured API hostname.
  # Only emit when GC_API_HOST is a DNS name — IPv4 literals are skipped.
  if echo "$GC_API_HOST" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'; then
    echo "# WARNING: GC_API_HOST=${GC_API_HOST} is an IPv4 literal — set"
    echo "# GC_BASE_URL=https://<hostname> in .env so clients hit the hostname"
    echo "# and dnsmasq can rewrite it to the VPN gateway."
  else
    echo "host-record=${GC_API_HOST},${GC_WG_GATEWAY_IP}"
  fi
} > "$DNSMASQ_CONF"
chmod 644 "$DNSMASQ_CONF"

# ─── Preflight: port 53 must be free on 127.0.0.1 ────
# dnsmasq binds 127.0.0.1:53 (via interface=lo) in addition to the wg0
# gateway address. With host-networking, the container shares the host's
# loopback — any pre-existing listener (NetworkManager-dnsmasq, libvirt
# dnsmasq, another bind9/unbound) will make dnsmasq enter a restart loop
# in supervisord with no clear indication why. Fail loudly here instead.
#
# systemd-resolved by default binds 127.0.0.53:53 (not 127.0.0.1:53) and
# does NOT conflict — we only alert when something owns 127.0.0.1:53.
_port53_holder=""
if command -v ss >/dev/null 2>&1; then
  _port53_holder=$(ss -lntu 2>/dev/null | awk '$5 ~ /^127\.0\.0\.1:53$/ {print; exit}')
fi
if [ -n "$_port53_holder" ]; then
  echo "ERROR: 127.0.0.1:53 is already bound — dnsmasq cannot start."
  echo "       Conflict detected: $_port53_holder"
  echo "       Common causes: NetworkManager-dnsmasq, libvirt-dnsmasq, bind9."
  echo "       Inspect with: ss -lntup | grep ':53 '"
  echo "       Fix the host-side listener, then restart the container."
  exit 1
fi

# ─── Generate session secret if not set ──────────────
SECRET_FILE="/data/.session_secret"
if [ -z "$GC_SECRET" ]; then
  if [ -f "$SECRET_FILE" ]; then
    export GC_SECRET=$(cat "$SECRET_FILE")
    echo "» Session secret loaded from $SECRET_FILE"
  else
    export GC_SECRET=$(openssl rand -hex 48)
    echo "$GC_SECRET" > "$SECRET_FILE"
    echo "» Session secret generated and saved to $SECRET_FILE"
  fi
else
  if [ ! -f "$SECRET_FILE" ] || [ "$(cat "$SECRET_FILE")" != "$GC_SECRET" ]; then
    echo "$GC_SECRET" > "$SECRET_FILE"
    echo "» Session secret persisted to $SECRET_FILE"
  fi
fi
chmod 600 "$SECRET_FILE"
chown root:root "$SECRET_FILE"

# ─── Generate encryption key if not set ──────────────
KEY_FILE="/data/.encryption_key"
if [ -z "$GC_ENCRYPTION_KEY" ]; then
  if [ -f "$KEY_FILE" ]; then
    export GC_ENCRYPTION_KEY=$(cat "$KEY_FILE")
    echo "» Encryption key loaded from $KEY_FILE"
  else
    export GC_ENCRYPTION_KEY=$(openssl rand -hex 32)
    echo "$GC_ENCRYPTION_KEY" > "$KEY_FILE"
    echo "» Encryption key generated and saved to $KEY_FILE"
  fi
else
  # Persist explicitly provided key so it survives container recreation
  if [ ! -f "$KEY_FILE" ] || [ "$(cat "$KEY_FILE")" != "$GC_ENCRYPTION_KEY" ]; then
    echo "$GC_ENCRYPTION_KEY" > "$KEY_FILE"
    echo "» Encryption key persisted to $KEY_FILE"
  fi
fi
# Harden key file permissions — readable only by root
chmod 600 "$KEY_FILE"
chown root:root "$KEY_FILE"

# ─── Set ownership for non-root Node process ─────────
chown -R gatecontrol:gatecontrol /data 2>/dev/null || true
chown -R gatecontrol:gatecontrol /app/config 2>/dev/null || true

# Re-secure sensitive key files after recursive chown
chown root:root /data/.session_secret /data/.encryption_key 2>/dev/null || true
chmod 600 /data/.session_secret /data/.encryption_key 2>/dev/null || true

echo "» Starting services via supervisord..."
exec "$@"
