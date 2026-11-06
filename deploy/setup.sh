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

# Set KEY=value in .env without exposing the value to sed/regex metacharacters.
# A previous sed-based approach corrupted passwords containing |, & or \.
# printf '%s' writes the value verbatim — no interpretation of any character.
set_env() {
  local key="$1" value="$2"
  if [ -f .env ]; then
    grep -v "^${key}=" .env > .env.tmp 2>/dev/null || true
    mv .env.tmp .env
  fi
  printf '%s=%s\n' "$key" "$value" >> .env
}

# Install Docker from its official, GPG-verified package repository instead of
# piping a remote script straight into a shell. Falls back to the upstream
# convenience script only for unrecognised distros (downloaded to a file, with
# a warning — never piped blind).
install_docker() {
  case "$OS" in
    ubuntu|debian)
      install_package ca-certificates curl
      install -m 0755 -d /etc/apt/keyrings
      curl -fsSL "https://download.docker.com/linux/${OS}/gpg" -o /etc/apt/keyrings/docker.asc
      chmod a+r /etc/apt/keyrings/docker.asc
      local codename
      codename="$(. /etc/os-release && echo "$VERSION_CODENAME")"
      echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/${OS} ${codename} stable" \
        > /etc/apt/sources.list.d/docker.list
      apt-get update -qq
      apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
      ;;
    fedora)
      dnf install -y -q dnf-plugins-core
      dnf config-manager --add-repo https://download.docker.com/linux/fedora/docker-ce.repo
      dnf install -y -q docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
      ;;
    centos|rhel|rocky|alma)
      yum install -y -q yum-utils
      yum-config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
      yum install -y -q docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
      ;;
    *)
      echo "  WARNUNG: Unbekanntes OS — Rueckfall auf das offizielle Docker-Skript."
      echo "           Es wird heruntergeladen und ausgefuehrt; nur fortfahren, wenn vertrauenswuerdig."
      curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
      sh /tmp/get-docker.sh
      rm -f /tmp/get-docker.sh
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
  install_docker
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

# WireGuard-Kernelmodul — der Container laeuft bewusst ohne SYS_MODULE und
# kann das Modul nicht selbst laden. Der Host muss es bereitstellen.
if lsmod 2>/dev/null | grep -q '^wireguard'; then
  echo "  WireGuard-Modul: OK (geladen)"
elif modprobe wireguard 2>/dev/null; then
  # Erfolgt auch bei in den Kernel eingebautem WireGuard (built-in).
  echo "  WireGuard-Modul: OK (geladen)"
  echo "wireguard" > /etc/modules-load.d/wireguard.conf 2>/dev/null || true
else
  echo "  WARNUNG: WireGuard-Kernelmodul nicht verfuegbar."
  echo "           Bitte auf dem Host bereitstellen (z. B. 'modprobe wireguard'"
  echo "           oder ein Kernel-/Paket mit WireGuard-Unterstuetzung installieren)."
  echo "           Ohne das Modul kann GateControl keinen VPN-Tunnel aufbauen."
fi

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

# ─── Datenordner ./data ────────────────────────────────
# Die docker-compose.yml bindet ./data:/data. Aeltere Installationen hatten
# ein Docker-Volume (gatecontrol-data). Laeuft so eine noch, wuerde der
# Container mit der neuen Compose-Datei auf einem leeren ./data starten —
# leere Datenbank. Dann lieber anhalten; der Umzug steht im Handbuch.
data_dir_guard() {
  [ -f data/gatecontrol.db ] && return 0
  local mount vols
  mount=$(docker inspect gatecontrol --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Type}}|{{.Name}}{{end}}{{end}}' 2>/dev/null || true)
  vols=$(docker volume ls -q 2>/dev/null | grep -E '(^|_)gatecontrol-data$' || true)
  if [ "${mount%%|*}" = "volume" ] || [ -n "$vols" ]; then
    echo ""
    echo "  ACHTUNG: Es gibt bereits GateControl-Daten in einem Docker-Volume:"
    if [ "${mount%%|*}" = "volume" ]; then echo "    ${mount#*|} (vom laufenden Container gatecontrol)"; fi
    for v in $vols; do echo "    $v"; done
    echo "  Diese docker-compose.yml nutzt den Ordner $(pwd)/data, und der ist leer."
    echo "  Ein Start jetzt beginnt mit einer LEEREN Datenbank. Die Daten im Volume"
    echo "  bleiben erhalten, werden aber nicht benutzt."
    echo "  Umzug nach ./data: Handbuch, FAQ \"Server-Daten von einem Docker-Volume"
    echo "  nach ./data umziehen\" (docs/handbuch/07-faq.md)."
    read -r -p "  Trotzdem mit leerem ./data fortfahren? (j/N): " empty_ok
    if [ "$empty_ok" != "j" ] && [ "$empty_ok" != "J" ]; then
      echo "Setup abgebrochen. Es wurde nichts gestartet."
      exit 1
    fi
  fi
}
data_dir_guard
mkdir -p data

# ─── update.sh ─────────────────────────────────────────
# Das Update-Skript liegt im Image (/app/update.sh) — von dort holen, dann
# passt es zur geladenen Version und klappt auch offline. Eine vorhandene
# update.sh bleibt (sie aktualisiert sich nach Updates selbst).
if [ -f update.sh ]; then
  echo "update.sh vorhanden."
else
  for img in "${GHCR_IMAGE}:latest" gatecontrol:latest; do
    if docker run --rm --entrypoint sh "$img" -c 'cat /app/update.sh' > update.sh.tmp 2>/dev/null \
       && [ -s update.sh.tmp ] && bash -n update.sh.tmp 2>/dev/null; then
      chmod 755 update.sh.tmp && mv -f update.sh.tmp update.sh
      echo "update.sh aus dem Image uebernommen."
      break
    fi
  done
  rm -f update.sh.tmp
  if [ ! -f update.sh ]; then
    echo "  WARNUNG: update.sh konnte nicht aus dem Image gelesen werden. Bitte laden:"
    echo "    curl -fsSLO https://raw.githubusercontent.com/CallMeTechie/gatecontrol/master/update.sh && chmod +x update.sh"
  fi
fi

# ─── Zeitzone ──────────────────────────────────────────
# Der Server gibt seine Zeitzone an die Gateways weiter (Portscan, Speedtest-
# Plan, DNS-Filter-Zeiten). Vorschlag: Zeitzone des Hosts; steht der auf UTC
# (ueblich bei Cloud-Servern), Europe/Berlin.
detect_tz() {
  local tz=""
  if [ -s /etc/timezone ]; then tz=$(head -n1 /etc/timezone | tr -d ' \t\r')
  elif command -v timedatectl >/dev/null 2>&1; then tz=$(timedatectl show -p Timezone --value 2>/dev/null || true)
  fi
  case "$tz" in ""|UTC|Etc/UTC|Etc/Universal|Universal|Zulu|GMT|Etc/GMT) tz="Europe/Berlin" ;; esac
  echo "$tz"
}
valid_tz() {
  [[ "$1" =~ ^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+){0,2}$ ]] || return 1
  [ ! -d /usr/share/zoneinfo ] || [ -e "/usr/share/zoneinfo/$1" ]
}
ask_tz() {
  local suggestion
  suggestion=$(detect_tz)
  valid_tz "$suggestion" || suggestion="Europe/Berlin"
  while true; do
    read -r -p "Zeitzone [${suggestion}]: " time_zone
    time_zone="${time_zone:-$suggestion}"
    valid_tz "$time_zone" && break
    echo "  Unbekannte Zeitzone '${time_zone}' (Beispiel: Europe/Berlin)."
  done
}

# ─── Auto-Update-Zeitplan ──────────────────────────────
# update.sh muss alle 5 Minuten laufen (Einstellungen > Updates). Nur auf
# Nachfrage, nur wenn der Container laeuft (sonst wuerde der erste Lauf ihn
# starten), nur mit /etc/cron.d und ohne vorhandenen Eintrag.
setup_update_cron() {
  local cron_file=/etc/cron.d/gatecontrol-update script
  script="$(pwd)/update.sh"
  local line="*/5 * * * * root ${script}"
  echo ""
  if [ ! -x "$script" ]; then
    echo "  Auto-Update: update.sh fehlt — Zeitplan nicht eingerichtet."
    return 0
  fi
  if [ -e "$cron_file" ] || grep -qs 'update\.sh' /etc/crontab /var/spool/cron/crontabs/root /var/spool/cron/root; then
    echo "  Auto-Update: Es gibt schon einen Zeitplan (${cron_file} oder crontab) — unveraendert."
    return 0
  fi
  if [ ! -d /etc/cron.d ] || [[ "$script" =~ [[:space:]] ]]; then
    echo "  Auto-Update: bitte den Zeitplan selbst anlegen (alle 5 Minuten):"
    echo "    ${line}"
    return 0
  fi
  read -r -p "Auto-Update-Zeitplan einrichten (update.sh alle 5 Minuten per cron)? (J/n): " want_cron
  if [ "$want_cron" = "n" ] || [ "$want_cron" = "N" ]; then
    echo "  Spaeter: echo '${line}' > ${cron_file}"
    return 0
  fi
  printf '%s\n' "$line" > "$cron_file"
  chmod 644 "$cron_file"
  echo "  Zeitplan angelegt: ${cron_file}"
  echo "  Modus (automatisch/manuell) waehlst du unter Einstellungen > Updates."
  if ! { pgrep -x cron >/dev/null 2>&1 || pgrep -x crond >/dev/null 2>&1; }; then
    echo "  WARNUNG: Kein laufender cron-Dienst gefunden (Debian/Ubuntu: apt install cron)."
  fi
}

# ─── .env pruefen ──────────────────────────────────────
if [ -f .env ]; then
  echo ".env existiert bereits."
  read -p "Ueberschreiben? (j/N): " overwrite
  if [ "$overwrite" != "j" ] && [ "$overwrite" != "J" ]; then
    if ! grep -q '^TZ=' .env; then
      echo "In der .env fehlt die Zeitzone (TZ)."
      ask_tz
      set_env TZ "${time_zone}"
      chmod 600 .env
    fi
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

# Time zone (TZ in .env)
ask_tz

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

# Apply user values (metacharacter-safe — see set_env)
set_env GC_BASE_URL "${base_url}"
set_env GC_SECRET "${gc_secret}"
set_env GC_ADMIN_USER "${admin_user}"
set_env GC_ADMIN_PASSWORD "${admin_password}"
set_env GC_WG_HOST "${wg_host}"
set_env GC_CADDY_EMAIL "${caddy_email}"
set_env GC_DEFAULT_LANGUAGE "${language}"
set_env GC_NET_INTERFACE "${net_interface}"
set_env GC_ENCRYPTION_KEY "${encryption_key}"
set_env TZ "${time_zone}"
chmod 600 .env

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
echo "  Zeitzone:         ${time_zone}"
echo "  Daten:            $(pwd)/data"
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
  setup_update_cron
fi
