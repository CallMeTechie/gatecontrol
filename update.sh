#!/bin/bash
# GateControl Auto-Update Script — mode-aware.
#
# Mode comes from $DATA_DIR/.auto-update-config.json (written by the server):
#   "auto"   → track :latest (recreate when the running image != :latest)
#   "manual" → only update when the server dropped a pending-update flag
# Each run writes a status marker to $DATA_DIR/.auto-update-state.json (read by
# the dashboard). Recreate decision uses the running container's image digest vs
# :latest (not the pull output). Refuses to recreate from a different project dir
# than the one the container was deployed from (would mount the wrong /data).
set -euo pipefail

SCRIPT_PATH="$(readlink -f "${BASH_SOURCE[0]:-$0}")"
SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"
COMPOSE_DIR="${COMPOSE_DIR:-$SCRIPT_DIR}"
IMAGE="${GC_IMAGE:-ghcr.io/callmetechie/gatecontrol:latest}"
CONTAINER="${GC_CONTAINER:-gatecontrol}"
DATA_DIR="${GC_DATA_DIR:-$COMPOSE_DIR/data}"
LOG="${GC_UPDATE_LOG:-/var/log/gatecontrol-update.log}"
WAIT_TIMEOUT="${GC_WAIT_TIMEOUT:-150}"

CONFIG_FILE="$DATA_DIR/.auto-update-config.json"
STATE_FILE="$DATA_DIR/.auto-update-state.json"
FLAG_FILE="$DATA_DIR/pending-update"

log() { local m; m="[$(date -Iseconds)] $*"; echo "$m"; echo "$m" >>"$LOG" 2>/dev/null || true; }

# Atomic write: temp + rename (rename is atomic on the same fs) so a concurrent
# reader never sees a half-written/empty file. Marker is 644 (container UID 101
# must read it).
write_state() { # $1=action $2=mode
  local tmp ok="true"; [ "$1" = "failed" ] && ok="false"
  tmp="$(mktemp "${STATE_FILE}.XXXXXX")" || return 0
  { printf '{"checked_at":"%s","action":"%s","mode":"%s","ok":%s}\n' \
    "$(date -Iseconds)" "$1" "$2" "$ok" >"$tmp" && chmod 644 "$tmp" && mv -f "$tmp" "$STATE_FILE"; } || true
}

# Overlap lock — only if flock is available; never abort the update because flock
# is missing (the script is published and runs on unknown hosts).
if command -v flock >/dev/null 2>&1 && exec 9>"${TMPDIR:-/tmp}/gc-update.lock" 2>/dev/null; then
  flock -n 9 2>/dev/null || { log "another update.sh run holds the lock — skipping"; exit 0; }
else
  log "no overlap lock (flock missing or lock dir unwritable) — continuing"
fi

if [ ! -f "$COMPOSE_DIR/docker-compose.yml" ]; then
  echo "ERROR: no docker-compose.yml in $COMPOSE_DIR" >&2
  echo "       Set COMPOSE_DIR or run from the deployment directory." >&2
  exit 2
fi

# Directory guard: do not recreate the live container from a different project
# dir than it was deployed from.
DEPLOYED_DIR="$(docker inspect "$CONTAINER" --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' 2>/dev/null || true)"
if [ -n "$DEPLOYED_DIR" ]; then
  C="$(readlink -f "$COMPOSE_DIR" 2>/dev/null || echo "$COMPOSE_DIR")"
  D="$(readlink -f "$DEPLOYED_DIR" 2>/dev/null || echo "$DEPLOYED_DIR")"
  if [ "$C" != "$D" ]; then
    log "ERROR: '$CONTAINER' deployed from '$DEPLOYED_DIR' but running from '$COMPOSE_DIR' — refusing (would mount wrong /data). exit 3"
    exit 3
  fi
fi

# Read mode (default auto on missing/corrupt config).
MODE="auto"
if [ -f "$CONFIG_FILE" ]; then
  if grep -q '"mode"[[:space:]]*:[[:space:]]*"manual"' "$CONFIG_FILE" 2>/dev/null; then MODE="manual"; fi
fi

recreate() {
  # Happy path: --force-recreate + --wait. On failure, recover with a clean
  # down+up: `docker compose up --force-recreate` can intermittently leave the
  # new container stuck in "Created" (host networking + fixed container_name
  # rename race), taking the service down with no retry. A `down` clears the
  # stuck/partial container, then a fresh `up` brings it back. Returns the
  # recovery up's status, so a genuinely broken image still reports failure.
  (
    cd "$COMPOSE_DIR" || exit 1
    if docker compose up -d --force-recreate --wait --wait-timeout "$WAIT_TIMEOUT" "$CONTAINER" >>"$LOG" 2>&1; then
      exit 0
    fi
    log "recreate failed — clean down+up recovery (host-net/name race)"
    docker compose down >>"$LOG" 2>&1 || true
    docker compose up -d --wait --wait-timeout "$WAIT_TIMEOUT" "$CONTAINER" >>"$LOG" 2>&1
  )
}

ensure_guacd() {
  # Idempotent guacd sidecar rollout. Pinned tag → pull is a near no-op when the
  # image is already present. `up -d guacd` (NO --force-recreate) starts guacd
  # only if it isn't already running, so it never kills active browser sessions
  # on a routine tick. Runs after a successful gatecontrol recreate, which also
  # covers the recovery path (the recovery `down` stops guacd; this brings it back).
  ( cd "$COMPOSE_DIR" || exit 1
    docker pull guacamole/guacd:1.6.0 >>"$LOG" 2>&1 || true
    docker compose up -d guacd >>"$LOG" 2>&1 || true
  )
}

needs_update() { # echoes "yes" if running image != :latest
  local latest running
  latest="$(docker image inspect "$IMAGE" --format '{{.Id}}' 2>/dev/null || true)"
  running="$(docker inspect "$CONTAINER" --format '{{.Image}}' 2>/dev/null || true)"
  [ -z "$latest" ] && { echo "err"; return; }
  if [ -n "$running" ] && [ "$running" = "$latest" ]; then echo "no"; else echo "yes"; fi
}

if [ "$MODE" = "manual" ]; then
  if [ ! -f "$FLAG_FILE" ]; then
    log "manual mode, no pending-update — no-op"; write_state noop manual; exit 0
  fi
  rm -f "$FLAG_FILE"                       # consume the trigger
  if ! docker pull "$IMAGE" >>"$LOG" 2>&1; then log "pull failed"; write_state failed manual; exit 1; fi
  case "$(needs_update)" in
    no)  log "manual trigger but already on latest — no recreate"; write_state noop manual; exit 0 ;;
    err) log "could not resolve :latest digest"; write_state failed manual; exit 1 ;;
  esac
  log "manual trigger — recreating"
  if recreate; then ensure_guacd || true; write_state updated manual; else log "recreate/health failed"; write_state failed manual; exit 1; fi
  exit 0
fi

# auto mode
rm -f "$FLAG_FILE" 2>/dev/null || true     # clear any orphaned flag from a prior manual session
if ! docker pull "$IMAGE" >>"$LOG" 2>&1; then log "pull failed"; write_state failed auto; exit 1; fi
case "$(needs_update)" in
  no)  log "auto: already up to date"; write_state noop auto; exit 0 ;;
  err) log "could not resolve :latest digest"; write_state failed auto; exit 1 ;;
esac
log "auto: update needed — recreating"
if recreate; then ensure_guacd || true; write_state updated auto; else log "recreate/health failed"; write_state failed auto; exit 1; fi
