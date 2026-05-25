#!/usr/bin/env bash
# GateControl Gateway self-update. Triggered by the pending-update flag.
# Pulls + recreates the gateway container detached, health-gates, and on
# failure rolls back to the previously-running image (digest-pinned override,
# because compose pins :latest). Records the result in /state/last-pull,
# echoing the request_id so the server can match it skew-proof.
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

log() { echo "[$(date -Iseconds)] $*" >>"$LOG"; }
dc() { docker compose -f "$COMPOSE_DIR/docker-compose.yml" "$@"; }
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
    docker compose -f "$COMPOSE_DIR/docker-compose.yml" -f "$OVERRIDE" up -d --force-recreate "$SERVICE" >>"$LOG" 2>&1 || log "rollback up failed"
  else
    log "no old digest captured — cannot roll back (locally-built image?)"
  fi
else
  rm -f "$OVERRIDE"   # clear any stale rollback pin after a good update
fi

RUN_DIGEST="$(repo_digest "$(running_cid)")"
PULLED_AT=$(( $(date +%s) * 1000 ))
printf '{"request_id":"%s","pulled_at":%s,"image_digest":"%s","ok":%s}\n' \
  "$REQUEST_ID" "$PULLED_AT" "$RUN_DIGEST" "$ok" >"$LASTPULL"
log "wrote last-pull ok=$ok digest=${RUN_DIGEST:-none}"
