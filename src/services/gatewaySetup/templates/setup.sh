#!/bin/sh
# GateControl Gateway — auto-update host setup (run as root on the gateway host).
# Adds the /state volume, installs update.sh, recreates the container (detached,
# health-gated, auto-rollback), and wires the periodic trigger. Re-runnable.
set -u
GATEWAY_NAME='{{GATEWAY_NAME}}'
GATEWAY_IMAGE='{{GATEWAY_IMAGE}}'
MIN_VERSION='1.10.0'
DEFAULT_COMPOSE_DIR='{{DEFAULT_COMPOSE_DIR}}'
SERVICE_DEFAULT='{{SERVICE}}'
export PATH="/usr/local/bin:$PATH"

say(){ echo "» $*"; }
die(){ echo "ERROR: $*" >&2; exit 1; }
ver_ge(){ awk -v a="$1" -v b="$2" 'BEGIN{split(a,x,".");split(b,y,".");for(i=1;i<=3;i++){xi=x[i]+0;yi=y[i]+0;if(xi>yi){print 1;exit}if(xi<yi){print 0;exit}}print 1}'; }

[ "$(id -u)" = 0 ] || { say "re-exec via sudo…"; exec sudo -E sh "$0" "$@"; }

if docker compose version >/dev/null 2>&1; then DC="docker compose";
elif command -v docker-compose >/dev/null 2>&1; then DC="docker-compose";
else die "Docker Compose (v2 plugin or docker-compose) required"; fi

# Resolve compose dir + service: explicit args win, else auto-detect by image substring.
COMPOSE_DIR=""; SERVICE=""; CID=""
if [ -n "${1:-}" ]; then COMPOSE_DIR="$1"; SERVICE="${2:-$SERVICE_DEFAULT}"; fi
if [ -z "$COMPOSE_DIR" ]; then
  matches=$(docker ps --format '{{.ID}} {{.Image}}' | awk 'tolower($2) ~ /gatecontrol-gateway/ {print $1}')
  n=$(printf '%s\n' "$matches" | grep -c . 2>/dev/null || echo 0)
  [ "$n" = 1 ] || die "found $n gateway containers — pass the compose dir explicitly: sh setup.sh /path/to/compose-dir [service]"
  CID="$matches"
  COMPOSE_DIR=$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$CID")
  SERVICE=$(docker inspect --format '{{index .Config.Labels "com.docker.compose.service"}}' "$CID")
fi
[ -n "$SERVICE" ] || SERVICE="$SERVICE_DEFAULT"
CF="$COMPOSE_DIR/docker-compose.yml"
[ -f "$CF" ] || die "no docker-compose.yml in $COMPOSE_DIR"
$DC -f "$CF" config --services 2>/dev/null | grep -qx "$SERVICE" || die "service '$SERVICE' not found in $CF"
[ -n "$CID" ] || CID=$($DC -f "$CF" ps -q "$SERVICE" 2>/dev/null | head -1)
say "compose: $CF (service: $SERVICE)"

STATE="$COMPOSE_DIR/gateway-state"
mkdir -p "$STATE"

cat > "$COMPOSE_DIR/update.sh" <<'__UPDATE_SH_EOF__'
{{UPDATE_SH}}
__UPDATE_SH_EOF__
chmod +x "$COMPOSE_DIR/update.sh"
say "wrote $COMPOSE_DIR/update.sh"

# Skip the recreate only if already on a current (>= MIN) image with the mount + healthy.
need_recreate=1
if grep -q 'gateway-state:/state' "$CF" && [ -n "$CID" ]; then
  hs=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$CID" 2>/dev/null)
  ver=$(docker exec "$CID" node -p "require('./package.json').version" 2>/dev/null)
  if { [ "$hs" = healthy ] || [ "$hs" = none ]; } && [ -n "$ver" ] && [ "$(ver_ge "$ver" "$MIN_VERSION")" = 1 ]; then
    need_recreate=0
  fi
fi

if [ "$need_recreate" = 0 ]; then
  say "already set up (mount present, version $ver, healthy) — no recreate needed"
else
  cp "$CF" "$CF.bak-$(date +%s)"
  if ! grep -q 'gateway-state:/state' "$CF"; then
    awk -v svc="$SERVICE" '
      function lead(s){ if(match(s,/[^ ]/)) return substr(s,1,RSTART-1); return "" }
      { print }
      ($0 ~ /^  [A-Za-z0-9._-]+:[ \t]*$/){ h=$0; sub(/^  /,"",h); sub(/:[ \t]*$/,"",h); cur=h }
      (cur==svc && !done && $0 ~ /\.\/config:\/config:ro/){ print lead($0) "- ./gateway-state:/state"; done=1 }
      END{ if(!done) exit 3 }
    ' "$CF" > "$CF.new" || { rm -f "$CF.new"; die "could not find the config volume in service $SERVICE (long-form volumes?). Edit manually — see docker-compose.state-snippet.yml"; }
    mv "$CF.new" "$CF"
  fi
  grep -q 'gateway-state:/state' "$CF" || die "mount insert failed"
  $DC -f "$CF" config >/dev/null 2>&1 || { for b in "$CF".bak-*; do cp "$b" "$CF"; done; die "compose no longer parses — restored backup; edit manually"; }
  say "added /state mount; launching recreate in background (detached + auto-rollback)…"
  say "⚠ Your SSH may drop if it routes through this gateway. Reconnect and check $STATE/setup-result.txt"
  OLD_DIGEST=$(docker inspect --format '{{.Image}}' "$CID" 2>/dev/null)
  nohup sh -c '
    CF="'"$CF"'"; DC="'"$DC"'"; SVC="'"$SERVICE"'"; STATE="'"$STATE"'"; OLD="'"$OLD_DIGEST"'"; CDIR="'"$COMPOSE_DIR"'"
    $DC -f "$CF" pull "$SVC" >>"$STATE/setup.log" 2>&1
    $DC -f "$CF" up -d --force-recreate "$SVC" >>"$STATE/setup.log" 2>&1
    ok=0; i=0
    while [ $i -lt 24 ]; do
      c=$($DC -f "$CF" ps -q "$SVC" 2>/dev/null | head -1)
      if [ -n "$c" ]; then
        h=$(docker inspect --format "{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}" "$c" 2>/dev/null)
        [ "$h" = healthy ] && { ok=1; break; }
        [ "$h" = none ] && { ok=1; break; }
      fi
      i=$((i+1)); sleep 5
    done
    if [ "$ok" = 1 ]; then echo "OK recreated + healthy at $(date -Iseconds)" > "$STATE/setup-result.txt";
    else
      [ -n "$OLD" ] && { printf "services:\n  %s:\n    image: %s\n" "$SVC" "$OLD" > "$CDIR/docker-compose.rollback.yml";
        $DC -f "$CF" -f "$CDIR/docker-compose.rollback.yml" up -d --force-recreate "$SVC" >>"$STATE/setup.log" 2>&1; }
      echo "ROLLBACK (new image unhealthy) at $(date -Iseconds)" > "$STATE/setup-result.txt"
    fi
  ' >/dev/null 2>&1 </dev/null &
fi

# Wire the periodic trigger
DSM_CMD="PATH=/usr/local/bin:\$PATH GATEWAY_STATE_DIR=$STATE $COMPOSE_DIR/update.sh"
if [ -f /etc/synoinfo.conf ] || command -v synoschedtask >/dev/null 2>&1; then
  cat <<EOF

=== Synology: create a DSM Task Scheduler entry (one-time) ===
Control Panel → Task Scheduler → Create → Scheduled Task → User-defined script
  User:     root
  Schedule: daily, repeat every 1 minute
  Command:  $DSM_CMD
EOF
elif command -v systemctl >/dev/null 2>&1; then
  cat > /etc/systemd/system/gatecontrol-gateway-update.service <<EOF
[Unit]
Description=GateControl Gateway self-update (oneshot)
[Service]
Type=oneshot
Environment=GATEWAY_STATE_DIR=$STATE
ExecStart=$COMPOSE_DIR/update.sh
EOF
  cat > /etc/systemd/system/gatecontrol-gateway-update.path <<EOF
[Unit]
Description=Watch for GateControl Gateway pending-update flag
[Path]
PathExists=$STATE/pending-update
Unit=gatecontrol-gateway-update.service
[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload && systemctl enable --now gatecontrol-gateway-update.path
  say "installed + enabled systemd path unit"
else
  say "No DSM/systemd detected — run this every minute via cron: $DSM_CMD"
fi
say "Done. Once the gateway reports state_dir_writable, the Update button activates in GateControl."
