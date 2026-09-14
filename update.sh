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
#
# Maintenance window (auto mode only): with "window":{"start":"03:00","end":
# "05:00","tz":"Europe/Berlin"} in the config file, a new :latest is deployed
# only while the local time in tz lies in [start, end) — end < start spans
# midnight. Outside the window the run pulls, logs "outside maintenance window"
# and writes the state waiting_window (exit 0). "Update now" in the UI drops the
# pending-update flag, which deploys immediately regardless of the window.
#
# Rollback: before a recreate the running image is tagged <repo>:rollback. If the
# new image fails its health check, :latest is re-pointed locally at that image
# and the container recreated from it (no pull, docker-compose.yml untouched).
# The failed image ID is kept in $DATA_DIR/.auto-update-bad-image so auto mode
# does not retry it every run; a newer :latest (different ID) is tried normally.
# Exit: 0 ok/no-op/skipped, 1 update failed (rolled back if possible),
#       2 no compose file, 3 wrong project dir, 4 update AND rollback failed.
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
BAD_FILE="$DATA_DIR/.auto-update-bad-image"

# Rollback target tag in the same repo as $IMAGE (digest/tag stripped; a
# registry port like host:5000/ is not a tag).
IMAGE_REPO="${IMAGE%%@*}"
case "${IMAGE_REPO##*/}" in *:*) IMAGE_REPO="${IMAGE_REPO%:*}" ;; esac
ROLLBACK_TAG="$IMAGE_REPO:rollback"

log() { local m; m="[$(date -Iseconds)] $*"; echo "$m"; echo "$m" >>"$LOG" 2>/dev/null || true; }

# Atomic write: temp + rename (rename is atomic on the same fs) so a concurrent
# reader never sees a half-written/empty file. Files are 644 (container UID 101
# must read the marker).
write_atomic() { # $1=file, content on stdin
  local tmp
  tmp="$(mktemp "$1.XXXXXX")" || return 0
  { cat >"$tmp" && chmod 644 "$tmp" && mv -f "$tmp" "$1"; } || { rm -f "$tmp"; true; }
}

# Image IDs / version labels end up in JSON: keep a strict charset so they can't break it.
safe() { printf '%s' "$1" | tr -cd 'A-Za-z0-9._:+-'; }

write_state() { # $1=action $2=mode [$3=failed image ID $4=its version]
  local ok="true" extra=""
  case "$1" in failed|rolled_back) ok="false" ;; esac
  [ -n "${3:-}" ] && extra="$(printf ',"bad_image":"%s","bad_version":"%s"' "$(safe "$3")" "$(safe "${4:-}")")"
  printf '{"checked_at":"%s","action":"%s","mode":"%s","ok":%s%s}\n' \
    "$(date -Iseconds)" "$1" "$2" "$ok" "$extra" | write_atomic "$STATE_FILE"
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

# Maintenance window (only present in the config file while enabled). Values
# are validated strictly; an unusable window is ignored (updates as before).
WIN_START="" WIN_END="" WIN_TZ=""
if [ -f "$CONFIG_FILE" ]; then
  WIN_JSON="$(tr -d '\n' <"$CONFIG_FILE" 2>/dev/null | grep -o '"window"[[:space:]]*:[[:space:]]*{[^}]*}' || true)"
  if [ -n "$WIN_JSON" ]; then
    win_field() { printf '%s' "$WIN_JSON" | sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p"; }
    WIN_START="$(win_field start)"; WIN_END="$(win_field end)"; WIN_TZ="$(win_field tz)"
    HHMM='^([01][0-9]|2[0-3]):[0-5][0-9]$' TZRE='^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+){0,2}$'
    if [[ ! "$WIN_START" =~ $HHMM ]] || [[ ! "$WIN_END" =~ $HHMM ]] || [[ ! "$WIN_TZ" =~ $TZRE ]]; then
      log "WARN: invalid maintenance window in $CONFIG_FILE — ignoring it"
      WIN_START="" WIN_END="" WIN_TZ=""
    elif [ ! -e "${TZDIR:-/usr/share/zoneinfo}/$WIN_TZ" ]; then
      log "WARN: time zone '$WIN_TZ' not found on this host (tzdata missing?) — date(1) falls back to UTC"
    fi
  fi
fi

hm_to_min() { echo $(( 10#${1%%:*} * 60 + 10#${1##*:} )); }
in_window() { # [start, end) in WIN_TZ; end < start spans midnight; start == end = always
  local now s e
  now="$(hm_to_min "$(TZ="$WIN_TZ" date +%H:%M)")"
  s="$(hm_to_min "$WIN_START")"; e="$(hm_to_min "$WIN_END")"
  [ "$s" -eq "$e" ] && return 0
  if [ "$s" -lt "$e" ]; then [ "$now" -ge "$s" ] && [ "$now" -lt "$e" ]; else [ "$now" -ge "$s" ] || [ "$now" -lt "$e" ]; fi
}

recreate() { # [$@=extra `compose up` args]
  # Happy path: --force-recreate + --wait. On failure, recover with a clean
  # down+up: `docker compose up --force-recreate` can intermittently leave the
  # new container stuck in "Created" (host networking + fixed container_name
  # rename race), taking the service down with no retry. A `down` clears the
  # stuck/partial container, then a fresh `up` brings it back. Returns the
  # recovery up's status, so a genuinely broken image still reports failure.
  (
    cd "$COMPOSE_DIR" || exit 1
    if docker compose up -d --force-recreate --wait --wait-timeout "$WAIT_TIMEOUT" "$@" "$CONTAINER" >>"$LOG" 2>&1; then
      exit 0
    fi
    log "recreate failed — clean down+up recovery (host-net/name race)"
    docker compose down >>"$LOG" 2>&1 || true
    docker compose up -d --wait --wait-timeout "$WAIT_TIMEOUT" "$@" "$CONTAINER" >>"$LOG" 2>&1
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

prune_images() {
  # Reclaim disk after a successful update: each :latest pull leaves the previous
  # image dangling. Without pruning the host fills up over time (incident
  # 2026-06-23: 187 images → root fs 100% → pulls failed → auto-update stalled).
  # -f removes ONLY dangling (untagged) images, so tagged/in-use images are safe
  # — including $ROLLBACK_TAG. Never add -a here: it would drop the rollback image.
  docker image prune -f >>"$LOG" 2>&1 || true
}

image_id() { docker image inspect "$1" --format '{{.Id}}' 2>/dev/null || true; }
image_version() { # OCI version label of image $1 (empty when the image has none)
  safe "$(docker image inspect "$1" --format '{{ index .Config.Labels "org.opencontainers.image.version" }}' 2>/dev/null || true)"
}

# Known-bad image from a previous rollback: "<image ID> <rolled_back|failed> [version]".
BAD_ID="" BAD_RESULT="" BAD_VERSION=""
if [ -f "$BAD_FILE" ]; then
  read -r BAD_ID BAD_RESULT BAD_VERSION 2>/dev/null <"$BAD_FILE" || true
  [ "$BAD_RESULT" = "failed" ] || BAD_RESULT="rolled_back"
fi

running_image() { docker inspect "$CONTAINER" --format '{{.Image}}' 2>/dev/null || true; }

needs_update() { # echoes "yes" if running image != :latest
  local latest running
  latest="$(image_id "$IMAGE")"
  running="$(running_image)"
  [ -z "$latest" ] && { echo "err"; return; }
  if [ -n "$running" ] && [ "$running" = "$latest" ]; then echo "no"; else echo "yes"; fi
}

deploy() { # $1=mode — recreate onto :latest; on health failure roll back. Exits.
  local mode="$1" prev new_id new_ver help pull_never=""
  new_id="$(image_id "$IMAGE")"
  # Pin the rollback target BEFORE touching the container: the tag keeps the
  # previous image alive across pulls and prune_images (dangling-only).
  prev="$(running_image)"
  if [ -n "$prev" ] && docker tag "$prev" "$ROLLBACK_TAG" >>"$LOG" 2>&1; then
    log "rollback target: $ROLLBACK_TAG = $prev"
  else
    prev=""; log "WARN: no running image to pin as $ROLLBACK_TAG — no rollback possible this run"
  fi

  if recreate; then
    rm -f "$BAD_FILE" 2>/dev/null || true
    ensure_guacd || true; prune_images || true; write_state updated "$mode"; exit 0
  fi
  new_ver="$(image_version "$new_id")"
  log "recreate/health failed — image $new_id ${new_ver:+(v$new_ver)}"
  [ -n "$prev" ] || { write_state failed "$mode"; exit 1; }

  # Roll back: re-point the compose image tag (:latest) at the previous image
  # locally and recreate WITHOUT pulling — compose then starts the old image and
  # docker-compose.yml stays untouched. The next pull re-tags :latest; the bad-
  # image record below keeps auto mode from redeploying it.
  help="$(docker compose up --help 2>/dev/null || true)"
  case "$help" in *--pull*) pull_never="--pull=never" ;; esac
  log "rolling back to $prev"
  if docker tag "$ROLLBACK_TAG" "$IMAGE" >>"$LOG" 2>&1 && recreate ${pull_never:+"$pull_never"} \
     && [ "$(running_image)" = "$prev" ]; then
    printf '%s rolled_back %s\n' "$new_id" "$new_ver" | write_atomic "$BAD_FILE"
    ensure_guacd || true
    log "rolled back to $prev — $new_id will not be retried until :latest changes"
    write_state rolled_back "$mode" "$new_id" "$new_ver"; exit 1
  fi
  # Remember the image anyway: retrying a broken image + rollback every run
  # would only churn the host. Needs a human now. (State "failed" WITH
  # bad_image = the rollback failed; the dashboard shows that distinctly.)
  printf '%s failed %s\n' "$new_id" "$new_ver" | write_atomic "$BAD_FILE"
  log "ERROR: rollback to $prev failed too — manual intervention required (docker compose ps / logs)"
  write_state failed "$mode" "$new_id" "$new_ver"; exit 4
}

if [ "$MODE" = "manual" ]; then
  if [ ! -f "$FLAG_FILE" ]; then
    log "manual mode, no pending-update — no-op"
    # Keep a previous rollback visible until the next update attempt.
    if [ -n "$BAD_ID" ]; then write_state "$BAD_RESULT" manual "$BAD_ID" "$BAD_VERSION"; else write_state noop manual; fi
    exit 0
  fi
  rm -f "$FLAG_FILE"                       # consume the trigger
  if ! docker pull "$IMAGE" >>"$LOG" 2>&1; then log "pull failed"; write_state failed manual; exit 1; fi
  case "$(needs_update)" in
    no)  log "manual trigger but already on latest — no recreate"; rm -f "$BAD_FILE" 2>/dev/null || true; write_state noop manual; exit 0 ;;
    err) log "could not resolve :latest digest"; write_state failed manual; exit 1 ;;
  esac
  # An explicit "Update now" retries even a known-bad image (user's call).
  log "manual trigger — recreating"
  deploy manual
fi

# auto mode
# A pending-update flag here is either an orphan from a prior manual session
# (removed) or — with a maintenance window — "Update now" from the UI, which
# deploys right away like a manual trigger (window and known-bad skip ignored).
REQUESTED=0
if [ -f "$FLAG_FILE" ]; then
  rm -f "$FLAG_FILE" 2>/dev/null || true
  [ -n "$WIN_START" ] && REQUESTED=1
fi
if ! docker pull "$IMAGE" >>"$LOG" 2>&1; then log "pull failed"; write_state failed auto; exit 1; fi
case "$(needs_update)" in
  no)  log "auto: already up to date"; write_state noop auto; exit 0 ;;
  err) log "could not resolve :latest digest"; write_state failed auto; exit 1 ;;
esac
# Loop guard: :latest is still the image that already failed and was rolled
# back → do not redeploy it every run. A newer :latest has a different ID.
if [ "$REQUESTED" = 0 ] && [ -n "$BAD_ID" ] && [ "$(image_id "$IMAGE")" = "$BAD_ID" ]; then
  log "auto: :latest $BAD_ID ${BAD_VERSION:+(v$BAD_VERSION) }failed before ($BAD_RESULT) — skipping until a newer :latest"
  write_state "$BAD_RESULT" auto "$BAD_ID" "$BAD_VERSION"; exit 0
fi
if [ "$REQUESTED" = 0 ] && [ -n "$WIN_START" ] && ! in_window; then
  log "auto: update available but outside maintenance window $WIN_START-$WIN_END ($WIN_TZ) — waiting"
  write_state waiting_window auto "$BAD_ID" "$BAD_VERSION"; exit 0
fi
if [ "$REQUESTED" = 1 ]; then log "auto: update requested from the UI — maintenance window ignored"; fi
log "auto: update needed — recreating"
deploy auto
