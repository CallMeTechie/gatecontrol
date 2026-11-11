#!/usr/bin/env bash
# GateControl Gateway self-update. Triggered by the pending-update flag.
# Pulls + recreates the gateway container detached, health-gates, and on
# failure rolls back to the previously-running image (digest-pinned override,
# because compose pins :latest). Records the result in /state/last-pull,
# echoing the request_id so the server can match it skew-proof. After a good
# update the office container (own image :office, docs/print.md) is renewed as
# well — only if it is in the compose file and in use on this host.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]:-$0}")")" && pwd)"
COMPOSE_DIR="${GC_GW_COMPOSE_DIR:-$SCRIPT_DIR}"
STATE_DIR="${GATEWAY_STATE_DIR:-/state}"
SERVICE="${GC_GW_SERVICE:-gateway}"
HEALTH_CEILING="${GC_GW_HEALTH_CEILING:-300}"
LOG="${GC_GW_UPDATE_LOG:-$STATE_DIR/update.log}"
LOCK="$COMPOSE_DIR/.update.lock"
FLAG="$STATE_DIR/pending-update"
LASTPULL="$STATE_DIR/last-pull"
OVERRIDE="$COMPOSE_DIR/docker-compose.rollback.yml"

OFFICE_SERVICE="${GC_GW_OFFICE_SERVICE:-office}"

log() { echo "[$(date -Iseconds)] $*" >>"$LOG"; }
dc() { docker compose -f "$COMPOSE_DIR/docker-compose.yml" "$@"; }
# Dienst office: in docker-compose.example.yml steht er im Profil "office" – mit dem Profil sieht
# compose ihn in jeder Fassung der Datei (ohne Profil: Datei aus GateControl, Pi-Image).
dco() { docker compose --profile office -f "$COMPOSE_DIR/docker-compose.yml" "$@"; }

# Office-Image (ghcr.io/…:office, „Office-Dateien drucken“) mit erneuern: nur wenn der Dienst in
# der Compose-Datei steht UND sein Container auf diesem Host angelegt ist (sonst lüde jedes Update
# ≈ 200 MB für eine Funktion, die hier niemand eingeschaltet hat). Läuft nach last-pull – das
# Ergebnis des Gateway-Updates wartet nicht auf den Download. Fehler hier ändern es nicht.
update_office() {
  local services cid old_img new_img running
  services="$(dco config --services 2>/dev/null || true)"
  grep -qx "$OFFICE_SERVICE" <<<"$services" || return 0
  cid="$(dco ps -a -q "$OFFICE_SERVICE" 2>/dev/null | head -1)"
  [ -n "$cid" ] || { log "office: in compose, no container on this host — image left alone"; return 0; }
  old_img="$(docker inspect --format '{{.Image}}' "$cid" 2>/dev/null || true)"
  running="$(docker inspect --format '{{.State.Running}}' "$cid" 2>/dev/null || echo false)"
  log "office: renewing image (container=$cid running=$running)"
  if ! dco pull "$OFFICE_SERVICE" >>"$LOG" 2>&1; then log "office: pull failed — keeping the current image"; return 0; fi
  # nur ein laufender Dienst wird neu angelegt; ein gestoppter nimmt das neue Image beim nächsten Start
  if [ "$running" = true ]; then
    dco up -d --no-deps "$OFFICE_SERVICE" >>"$LOG" 2>&1 || { log "office: recreate failed"; return 0; }
    cid="$(dco ps -a -q "$OFFICE_SERVICE" 2>/dev/null | head -1)"
    new_img="$(docker inspect --format '{{.Image}}' "$cid" 2>/dev/null || true)"
    # das alte Image (≈ 700 MB) freigeben – ohne -f: bleibt, solange es noch jemand benutzt
    if [ -n "$old_img" ] && [ -n "$new_img" ] && [ "$old_img" != "$new_img" ]; then
      docker image rm "$old_img" >>"$LOG" 2>&1 || log "office: old image kept (still in use)"
    fi
  fi
  log "office: done"
}
running_cid() { dc ps -q "$SERVICE" 2>/dev/null | head -1; }
# Resolve a container's image RepoDigest (repo@sha256:…). RepoDigests lives on the IMAGE,
# not the container, so resolve the container's image id first, then inspect the image.
repo_digest() {
  img=$(docker inspect --format '{{.Image}}' "$1" 2>/dev/null) || return 0
  [ -n "$img" ] || return 0
  docker inspect --format '{{if .RepoDigests}}{{index .RepoDigests 0}}{{end}}' "$img" 2>/dev/null || true
}

[ -f "$COMPOSE_DIR/docker-compose.yml" ] || { echo "no docker-compose.yml in $COMPOSE_DIR" >&2; exit 2; }

exec 9>"$LOCK"
if ! flock -n 9; then log "another update running, exit"; exit 0; fi

# Nothing to do unless a flag is present. DSM polls this script on a timer, so
# without this guard every poll would pull+recreate the container.
if [ ! -f "$FLAG" ]; then exit 0; fi
REQUEST_ID="$(grep -o '"request_id":"[^"]*"' "$FLAG" | head -1 | cut -d'"' -f4 || true)"
rm -f "$FLAG"   # consume-on-lock: a later trigger writes a fresh flag
log "update start request_id=${REQUEST_ID:-none}"

CID="$(running_cid)"
OLD_DIGEST=""
[ -n "$CID" ] && OLD_DIGEST="$(repo_digest "$CID")"
log "container=$CID old_digest=${OLD_DIGEST:-none}"

# Edge-Container im Stack? (gleiches Image, wird nach dem Gateway mitgezogen)
EDGE=""
if dc config --services 2>/dev/null | grep -qx "${GC_GW_EDGE_SERVICE:-edge}"; then EDGE="${GC_GW_EDGE_SERVICE:-edge}"; fi

dc pull "$SERVICE" >>"$LOG" 2>&1 || log "pull reported error (continuing)"
# Guard against set -e: if recreate fails we must still reach the rollback +
# last-pull steps below (don't let a non-zero exit abort the script).
up_ok=true
dc up -d --force-recreate "$SERVICE" >>"$LOG" 2>&1 || { log "compose up failed"; up_ok=false; }

ok=false
deadline=$(( $(date +%s) + HEALTH_CEILING ))
while [ "$up_ok" = true ] && [ "$(date +%s)" -lt "$deadline" ]; do
  NCID="$(running_cid)"
  if [ -n "$NCID" ]; then
    hs="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$NCID" 2>/dev/null || echo starting)"
    case "$hs" in
      healthy|none) ok=true; break ;;
      unhealthy)    ok=false; break ;;
      *)            : ;;  # starting → keep waiting through start-period
    esac
  fi
  sleep 5
done
log "health ok=$ok"

if [ "$ok" != true ]; then
  if [ -n "$OLD_DIGEST" ]; then
    log "rolling back to $OLD_DIGEST"
    cat >"$OVERRIDE" <<YAML
services:
  $SERVICE:
    image: $OLD_DIGEST
YAML
    # Edge-Container nutzt dasselbe Image → auf denselben Stand zurück
    if [ -n "$EDGE" ]; then
      printf '  %s:\n    image: %s\n' "$EDGE" "$OLD_DIGEST" >>"$OVERRIDE"
    fi
    docker compose -f "$COMPOSE_DIR/docker-compose.yml" -f "$OVERRIDE" up -d --force-recreate "$SERVICE" $EDGE >>"$LOG" 2>&1 || log "rollback up failed"
  else
    log "no old digest captured — cannot roll back (locally-built image?)"
  fi
else
  rm -f "$OVERRIDE"   # clear any stale rollback pin after a good update
  # Edge-Container (gleiches Image, docs/edge.md) auf das neue Image heben
  if [ -n "$EDGE" ]; then
    dc up -d --no-deps "$EDGE" >>"$LOG" 2>&1 || log "edge recreate failed"
  fi
fi

RUN_DIGEST="$(repo_digest "$(running_cid)")"
PULLED_AT=$(( $(date +%s) * 1000 ))
printf '{"request_id":"%s","pulled_at":%s,"image_digest":"%s","ok":%s}\n' \
  "$REQUEST_ID" "$PULLED_AT" "$RUN_DIGEST" "$ok" >"$LASTPULL"
log "wrote last-pull ok=$ok digest=${RUN_DIGEST:-none}"

# erst jetzt, nach einem gelungenen Update: das Office-Image nachziehen (nach einem Rollback nicht)
if [ "$ok" = true ]; then update_office || log "office: update step failed"; fi
