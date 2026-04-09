#!/bin/sh
set -e

# ─── Defaults ────────────────────────────────────────
GC_WG_INTERFACE="${GC_WG_INTERFACE:-wg0}"
GC_WG_PORT="${GC_WG_PORT:-51820}"
GC_WG_SUBNET="${GC_WG_SUBNET:-10.8.0.0/24}"
GC_WG_GATEWAY_IP="${GC_WG_GATEWAY_IP:-10.8.0.1}"
GC_WG_DNS="${GC_WG_DNS:-10.8.0.1}"
GC_DNSMASQ_UPSTREAMS="${GC_DNSMASQ_UPSTREAMS:-1.1.1.1,8.8.8.8}"
GC_WG_POST_UP="${GC_WG_POST_UP:-}"
GC_WG_POST_DOWN="${GC_WG_POST_DOWN:-}"
GC_WG_MTU="${GC_WG_MTU:-}"
GC_NET_INTERFACE="${GC_NET_INTERFACE:-eth0}"
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

# ─── Ensure data directory ───────────────────────────
mkdir -p /data/caddy /data/wireguard /data/branding
mkdir -p "$(dirname "$GC_DB_PATH")"

# ─── Generate WireGuard config if not exists ─────────
# Config is stored persistently in /data/wireguard/ and symlinked to /etc/wireguard/
if [ ! -f "$WG_DATA_CONF" ]; then
  echo "» Generating WireGuard server keypair..."
  PRIVATE_KEY=$(wg genkey)
  PUBLIC_KEY=$(echo "$PRIVATE_KEY" | wg pubkey)

  POST_UP="${GC_WG_POST_UP}"
  POST_DOWN="${GC_WG_POST_DOWN}"

  if [ -z "$POST_UP" ]; then
    POST_UP="iptables -I FORWARD 1 -i ${GC_WG_INTERFACE} -d ${GC_WG_SUBNET} -j ACCEPT; iptables -I FORWARD 2 -i ${GC_NET_INTERFACE} -o ${GC_WG_INTERFACE} -m state --state RELATED,ESTABLISHED -j ACCEPT; iptables -t nat -A POSTROUTING -s ${GC_WG_SUBNET} -o ${GC_NET_INTERFACE} -j MASQUERADE"
    POST_UP_MSS="iptables -t mangle -A FORWARD -i ${GC_WG_INTERFACE} -p tcp --tcp-flags SYN,RST SYN -j TCPMSS --clamp-mss-to-pmtu; iptables -t mangle -A FORWARD -o ${GC_WG_INTERFACE} -p tcp --tcp-flags SYN,RST SYN -j TCPMSS --clamp-mss-to-pmtu"
  fi
  if [ -z "$POST_DOWN" ]; then
    POST_DOWN="iptables -D FORWARD -i ${GC_WG_INTERFACE} -d ${GC_WG_SUBNET} -j ACCEPT; iptables -D FORWARD -i ${GC_NET_INTERFACE} -o ${GC_WG_INTERFACE} -m state --state RELATED,ESTABLISHED -j ACCEPT; iptables -t nat -D POSTROUTING -s ${GC_WG_SUBNET} -o ${GC_NET_INTERFACE} -j MASQUERADE"
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

# ─── Generate dnsmasq config for split-horizon DNS ────
# VPN peers normally resolve ${GC_WG_HOST} to its public IP. WireGuard
# then creates an endpoint-route exception for that IP, so API traffic
# to the server goes DIRECTLY (not through the tunnel) and fails when
# the client's physical network cannot reach the public endpoint.
#
# Dnsmasq listens on ${GC_WG_GATEWAY_IP}:53 and hijacks ${GC_WG_HOST} to
# return the VPN gateway IP instead. Clients that use this DNS (set via
# GC_WG_DNS in their peer config) will resolve the API hostname to the
# VPN-internal gateway and their traffic flows through the tunnel,
# hitting Caddy bound on 0.0.0.0:443 via the wg0 interface.
#
# Regenerated every start so changes to GC_WG_HOST / GC_WG_GATEWAY_IP
# propagate without manual intervention.
DNSMASQ_CONF="/app/config/dnsmasq.conf"
echo "» Generating dnsmasq config (split-horizon for ${GC_WG_HOST} → ${GC_WG_GATEWAY_IP})..."
{
  echo "# Auto-generated by entrypoint.sh — do not edit manually."
  echo "bind-dynamic"
  echo "listen-address=127.0.0.1,${GC_WG_GATEWAY_IP}"
  echo "no-resolv"
  echo "no-hosts"
  echo "cache-size=1000"
  echo "log-facility=-"
  # Upstream resolvers (comma-separated env var → one server= line each)
  echo "$GC_DNSMASQ_UPSTREAMS" | tr ',' '\n' | while IFS= read -r upstream; do
    upstream=$(echo "$upstream" | tr -d '[:space:]')
    [ -n "$upstream" ] && echo "server=$upstream"
  done
  # Hijack: return the VPN gateway IP for the configured public hostname
  echo "host-record=${GC_WG_HOST},${GC_WG_GATEWAY_IP}"
} > "$DNSMASQ_CONF"
chmod 644 "$DNSMASQ_CONF"

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
