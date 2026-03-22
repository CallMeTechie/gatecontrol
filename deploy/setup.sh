#!/bin/bash
set -e

GHCR_IMAGE="ghcr.io/callmetechie/gatecontrol"

echo "=== GateControl Setup ==="
echo ""
echo "  Hinweis: GateControl nutzt Host-Networking (network_mode: host)."
echo "  Alle Ports (HTTP 80, HTTPS 443, WireGuard 51820/UDP sowie"
echo "  Layer-4-Routen) werden direkt auf dem Host gebunden."
echo ""

# ─── Root-Check ─────────────────────────────────────────
if [ "$(id -u)" -ne 0 ]; then
  echo "Fehler: Dieses Skript muss als root ausgefuehrt werden."
  echo "  sudo bash setup.sh"
  exit 1
fi

# ─── Betriebssystem erkennen ────────────────────────────
detect_os() {
  if [ -f /etc/os-release ]; then
    . /etc/os-release
    echo "$ID"
  else
    echo "unknown"
  fi
}

OS=$(detect_os)
echo "Betriebssystem: ${OS}"

# ─── Paketmanager-Helfer ────────────────────────────────
install_package() {
  case "$OS" in
    ubuntu|debian)
      apt-get update -qq && apt-get install -y -qq "$@"
      ;;
    fedora)
      dnf install -y -q "$@"
      ;;
    centos|rhel|rocky|alma)
      yum install -y -q "$@"
      ;;
    alpine)
      apk add --no-cache "$@"
      ;;
    *)
      echo "Fehler: Paketmanager nicht erkannt. Bitte '$*' manuell installieren."
      exit 1
      ;;
  esac
}

# ─── Voraussetzungen pruefen ────────────────────────────
echo ""
echo "Pruefe Voraussetzungen..."

# curl
if ! command -v curl &>/dev/null; then
  echo "  curl nicht gefunden, wird installiert..."
  install_package curl
fi
echo "  curl: OK"

# openssl
if ! command -v openssl &>/dev/null; then
  echo "  openssl nicht gefunden, wird installiert..."
  install_package openssl
fi
echo "  openssl: OK"

# Docker
if ! command -v docker &>/dev/null; then
  echo "  Docker nicht gefunden, wird installiert..."
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
  echo "  Docker installiert und gestartet."
else
  if ! docker info &>/dev/null; then
    echo "  Docker installiert, aber Daemon laeuft nicht. Starte Docker..."
    systemctl enable --now docker
  fi
fi
echo "  Docker: OK ($(docker --version | cut -d' ' -f3 | tr -d ','))"

# Docker Compose (v2 Plugin)
if ! docker compose version &>/dev/null; then
  echo "  Docker Compose Plugin nicht gefunden, wird installiert..."
  case "$OS" in
    ubuntu|debian)
      install_package docker-compose-plugin
      ;;
    *)
      COMPOSE_VERSION=$(curl -fsSL https://api.github.com/repos/docker/compose/releases/latest | grep '"tag_name"' | cut -d'"' -f4)
      ARCH=$(uname -m)
      mkdir -p /usr/local/lib/docker/cli-plugins
      curl -fsSL "https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/docker-compose-linux-${ARCH}" \
        -o /usr/local/lib/docker/cli-plugins/docker-compose
      chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
      ;;
  esac
fi
echo "  Docker Compose: OK ($(docker compose version --short))"

echo ""
echo "Alle Voraussetzungen erfuellt."

# ─── Docker-Image laden ────────────────────────────────
echo ""
if [ -f gatecontrol-image.tar.gz ]; then
  echo "Offline-Modus: Lade Image aus gatecontrol-image.tar.gz..."
  docker load < gatecontrol-image.tar.gz
  echo "Image geladen."
else
  echo "Online-Modus: Lade Image von GitHub Container Registry..."
  docker pull "${GHCR_IMAGE}:latest"
  echo "Image geladen."
fi
echo ""

# ─── .env pruefen ──────────────────────────────────────
if [ -f .env ]; then
  echo ".env existiert bereits."
  read -p "Ueberschreiben? (j/N): " overwrite
  if [ "$overwrite" != "j" ] && [ "$overwrite" != "J" ]; then
    echo "Starte Container..."
    docker compose up -d
    echo ""
    echo "GateControl laeuft!"
    exit 0
  fi
fi

# ─── Konfiguration abfragen ───────────────────────────
echo "─── Konfiguration ───"
echo ""

# Base URL / Domain
read -p "Domain fuer das Web-Interface (z.B. gate.example.com): " domain
domain="${domain:-gate.example.com}"

# Protocol
read -p "HTTPS verwenden? (J/n): " use_https
if [ "$use_https" = "n" ] || [ "$use_https" = "N" ]; then
  base_url="http://${domain}"
else
  base_url="https://${domain}"
fi

# WireGuard Host
read -p "Oeffentliche IP oder Domain fuer WireGuard [${domain}]: " wg_host
wg_host="${wg_host:-$domain}"

# Admin credentials
read -p "Admin-Benutzername [admin]: " admin_user
admin_user="${admin_user:-admin}"

while true; do
  read -s -p "Admin-Passwort: " admin_password
  echo ""
  if [ -z "$admin_password" ]; then
    echo "Passwort darf nicht leer sein."
    continue
  fi
  read -s -p "Passwort wiederholen: " admin_password2
  echo ""
  if [ "$admin_password" != "$admin_password2" ]; then
    echo "Passwoerter stimmen nicht ueberein."
    continue
  fi
  break
done

# Language
read -p "Sprache (de/en) [de]: " language
language="${language:-de}"

# Caddy email for Let's Encrypt
read -p "E-Mail fuer Let's Encrypt Zertifikate (optional): " caddy_email

# Network interface (auto-detect default)
default_iface=$(ip route show default 2>/dev/null | awk '/default/ {print $5; exit}')
default_iface="${default_iface:-eth0}"
echo ""
echo "  Erkanntes Netzwerk-Interface: ${default_iface}"
echo "  Dieses Interface wird fuer NAT/Masquerading und WireGuard-Routing verwendet."
read -p "Netzwerk-Interface [${default_iface}]: " net_interface
net_interface="${net_interface:-$default_iface}"

# Port conflict check
echo ""
echo "Pruefe Port-Konflikte..."
port_conflict=0
for port in 80 443 51820; do
  pid=$(ss -tlnp "sport = :${port}" 2>/dev/null | grep -v "State" | awk '{print $6}' | head -1)
  if [ -n "$pid" ]; then
    echo "  WARNUNG: Port ${port} ist bereits belegt: ${pid}"
    port_conflict=1
  fi
done
if [ "$port_conflict" = "1" ]; then
  echo ""
  echo "  GateControl benoetigt die Ports 80, 443 und 51820/UDP."
  read -p "  Trotzdem fortfahren? (j/N): " force_continue
  if [ "$force_continue" != "j" ] && [ "$force_continue" != "J" ]; then
    echo "Setup abgebrochen."
    exit 1
  fi
else
  echo "  Keine Konflikte gefunden."
fi

# Generate secrets
gc_secret=$(openssl rand -hex 32)
encryption_key=$(openssl rand -hex 32)

echo ""
echo "Erstelle .env..."

# Build .env from template
cp .env.example .env

# Apply user values
sed -i "s|GC_BASE_URL=.*|GC_BASE_URL=${base_url}|" .env
sed -i "s|GC_SECRET=.*|GC_SECRET=${gc_secret}|" .env
sed -i "s|GC_ADMIN_USER=.*|GC_ADMIN_USER=${admin_user}|" .env
sed -i "s|GC_ADMIN_PASSWORD=.*|GC_ADMIN_PASSWORD=${admin_password}|" .env
sed -i "s|GC_WG_HOST=.*|GC_WG_HOST=${wg_host}|" .env
sed -i "s|GC_CADDY_EMAIL=.*|GC_CADDY_EMAIL=${caddy_email}|" .env
sed -i "s|GC_DEFAULT_LANGUAGE=.*|GC_DEFAULT_LANGUAGE=${language}|" .env
sed -i "s|GC_NET_INTERFACE=.*|GC_NET_INTERFACE=${net_interface}|" .env
sed -i "s|GC_ENCRYPTION_KEY=.*|GC_ENCRYPTION_KEY=${encryption_key}|" .env

# PostUp/PostDown are left empty — entrypoint.sh generates correct rules
# based on GC_NET_INTERFACE and GC_WG_SUBNET automatically.

echo ".env erstellt."
echo ""

# ─── Zusammenfassung ──────────────────────────────────
echo "─── Zusammenfassung ───"
echo ""
echo "  Domain:           ${domain}"
echo "  Base URL:         ${base_url}"
echo "  WireGuard Host:   ${wg_host}"
echo "  Admin-User:       ${admin_user}"
echo "  Sprache:          ${language}"
echo "  Netzwerk:         ${net_interface} (Host-Networking)"
echo "  Caddy E-Mail:     ${caddy_email:-nicht gesetzt}"
echo ""

# ─── Container starten ─────────────────────────────────
read -p "Container jetzt starten? (J/n): " start_now
if [ "$start_now" = "n" ] || [ "$start_now" = "N" ]; then
  echo "Starte spaeter mit: docker compose up -d"
else
  docker compose up -d
  echo ""
  echo "=== GateControl laeuft! ==="
  echo ""
  echo "  Web-Interface: ${base_url}"
  echo "  Login:         ${admin_user} / <dein Passwort>"
  echo ""
  echo "  Ports (Host-Networking):"
  echo "    80/TCP    — HTTP (Redirect auf HTTPS)"
  echo "    443/TCP   — HTTPS (Web-Interface + Reverse Proxy)"
  echo "    51820/UDP — WireGuard VPN"
  echo "    + Layer-4-Routen (dynamisch via Web-Interface)"
  echo ""
  echo "  Features (konfigurierbar im Web-Interface):"
  echo "    - VPN Peer Management mit Ablaufdatum"
  echo "    - Reverse Proxy mit Auto-HTTPS, Komprimierung, Custom Headers"
  echo "    - Route Auth (Email/TOTP/2FA), Peer ACL, Geo-Blocking"
  echo "    - Load Balancing, Rate Limiting, Retry, Sticky Sessions"
  echo "    - Uptime Monitoring, Email-Alerts, API Tokens"
  echo "    - Automatische Backups, Log-Export (CSV/JSON)"
  echo ""
  echo "  API-Dokumentation: ${base_url}/api/v1/ (Token in Settings > API Tokens)"
fi
