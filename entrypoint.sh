#!/bin/sh
set -e

# ─── Defaults ────────────────────────────────────────
GC_WG_INTERFACE="${GC_WG_INTERFACE:-wg0}"
GC_WG_PORT="${GC_WG_PORT:-51820}"
GC_WG_SUBNET="${GC_WG_SUBNET:-10.8.0.0/24}"
GC_WG_GATEWAY_IP="${GC_WG_GATEWAY_IP:-10.8.0.1}"
GC_WG_DNS="${GC_WG_DNS:-1.1.1.1,8.8.8.8}"
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
mkdir -p /data/caddy /data/wireguard
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
    POST_UP="iptables -A FORWARD -i ${GC_WG_INTERFACE} -j ACCEPT; iptables -t nat -A POSTROUTING -o ${GC_NET_INTERFACE} -j MASQUERADE"
  fi
  if [ -z "$POST_DOWN" ]; then
    POST_DOWN="iptables -D FORWARD -i ${GC_WG_INTERFACE} -j ACCEPT; iptables -t nat -D POSTROUTING -o ${GC_NET_INTERFACE} -j MASQUERADE"
  fi

  echo "» Writing WireGuard config to ${WG_DATA_CONF}..."
  cat > "$WG_DATA_CONF" <<EOF
[Interface]
Address = ${GC_WG_GATEWAY_IP}/$(echo "$GC_WG_SUBNET" | cut -d'/' -f2)
ListenPort = ${GC_WG_PORT}
PrivateKey = ${PRIVATE_KEY}
PostUp = ${POST_UP}
PostDown = ${POST_DOWN}
EOF

  if [ -n "$GC_WG_MTU" ]; then
    echo "MTU = ${GC_WG_MTU}" >> "$WG_DATA_CONF"
  fi

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

echo "» Starting services via supervisord..."
exec "$@"
