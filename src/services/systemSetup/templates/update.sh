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
# Self-update: after a successful update this script compares itself with
# /app/update.sh of the NEW image, checks the syntax and replaces itself
# atomically (temp + mv, mode 755, old version kept as update.sh.bak). Only on
# a real difference; GC_UPDATE_SH_SELFUPDATE=0 switches it off. The new version
# is never executed in the same run — it applies from the next cron run.
# ClamAV (marker 3): "ClamAV auf diesem Server" in Einstellungen → Virenscan
# makes the server write "clamav":"on" into the config file; every run then
# starts the clamav container when it is not running (docker compose profile
# "clamav" when docker-compose.yml has it, else a plain docker run with the
# same settings) and stops it again — only when this script started it — once
# another scanner is chosen. Result: $DATA_DIR/.clamav-state.json.
# Messenger bridges (marker 5): the server writes "bridges":"whatsapp" into the
# config file while an administrator has them switched on. Every run then
# brings up the services bruecken-hs and bruecken-<name> of the compose
# profile "bruecken" (only when docker-compose.yml has them — no docker run
# fallback: their settings live in that file) and removes the containers
# again — only when this script started them — once the field is gone. Their
# data in $DATA_DIR/bridges stays. Result: $DATA_DIR/.bridges-state.json with
# the state, the image and the memory each container really uses.
# Marker 6: a bridge may have a relay (bruecken-<name>-relay); the server
# writes the containers' configuration into $DATA_DIR/bridges and its revision
# as "bridges_rev" — a new revision or a replaced docker-compose.yml updates
# the containers this script started. `./update.sh bridges-probe [seconds]`
# starts the wanted bridges, measures memory and disk writes and writes
# $DATA_DIR/.bridges-probe.json (see bridges_probe below).
# Marker 7: the server itself has a relay too (bruecken-core-relay — the
# homeserver's events reach GateControl through it); it is started with the
# bridges when the docker-compose.yml has it and reported as "core-relay"
# ("present":false = the compose file is older and has to be replaced once).
# The probe's log lines leave out everything about linking and events and
# blank ids, numbers and keys (probe_text).
# Marker 8 (stage 5 of the bridges):
#  - "bridges_images":"hs=<repo>:<tag>@<digest>,whatsapp=…" — the images the
#    server pins. Only references of the repositories this script knows for a
#    name (bridge_repo) and only for services the docker-compose.yml has are
#    written into $COMPOSE_DIR/.bruecken-images.yml, a compose override used
#    for `up`; a GateControl release with a new pin so updates the containers
#    without a new docker-compose.yml. Nothing unpinned is pulled.
#  - "bridges_backup":"<id>" — a snapshot: the bridges and the homeserver are
#    stopped, their data folders packed into $DATA_DIR/bridges/backup/
#    state-<id>.tar (owner of that folder, 0600), started again; result in
#    $DATA_DIR/.bridges-backup.json. The server encrypts the file at once.
#  - "bridges_restore":"<id>" — the server left backup/restore-<id>.tar: every
#    member is checked (a plain file or folder below hs/data or <bridge>/data),
#    the containers are stopped, the current folders kept as *.prev, the file
#    unpacked; result in $DATA_DIR/.bridges-restore.json.
# Marker 9 (recordings of the plugin "Fernzugriff", gc.remote stage 3): the
# release docker-compose.yml mounts the volume remote-recordings at
# /recordings in gatecontrol AND guacd (guacd writes the RDP/VNC recordings
# there, GateControl encrypts them). Every run writes
# $DATA_DIR/.remote-recordings-state.json: whether docker-compose.yml has the
# volume ("compose") and whether the running guacd / gatecontrol containers
# have it mounted. Nothing is restarted for it: the containers pick the
# volume up at the next update (ensure_guacd's `up -d guacd` recreates guacd
# when the compose file changed); until then GateControl records SSH only
# and says so.
# Marker 10 (stage 7a of the bridges, Signal): bridge_repo knows Signal and
# Telegram (and their relays) — a pin for them is taken only from
# dock.mau.dev/mautrix/signal / …/telegram; probe_redact blanks Signal account
# ids (UUIDs), group ids and drops lines with sgnl://linkdevice, the transfer
# archive, tg://login tokens and t.me links. bruecken-signal and
# bruecken-telegram start only when docker-compose.yml has them (the new
# release file) and the server asks for them.
# The marker line below is the version both sides compare; bump it whenever
# this file changes in a way the host should pick up.
# gc-update-sh: 10
#
# Data directory: $COMPOSE_DIR/data (the release compose binds ./data:/data).
# When the running container mounts /data from somewhere else — the named
# volume gatecontrol-data of older installs, or another bind path — that
# mountpoint is used instead (logged; nothing is moved). GC_DATA_DIR overrides.
#
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

# Version marker of an update.sh file ("# gc-update-sh: <n>"); empty when the
# file has none (an update.sh from before this feature).
update_sh_version() {
  sed -n 's/^# gc-update-sh: \([0-9][0-9]*\)$/\1/p' "$1" 2>/dev/null | head -n1
}
SELF_VERSION="$(update_sh_version "$SCRIPT_PATH")"
[ -n "$SELF_VERSION" ] || SELF_VERSION=0

write_state() { # $1=action $2=mode [$3=failed image ID $4=its version]
  local ok="true" extra=""
  case "$1" in failed|rolled_back) ok="false" ;; esac
  [ -n "${3:-}" ] && extra="$(printf ',"bad_image":"%s","bad_version":"%s"' "$(safe "$3")" "$(safe "${4:-}")")"
  # update_sh = version of THIS script, so the server can compare the host copy
  # with the one shipped in the image (GET /api/v1/system/auto-update).
  printf '{"checked_at":"%s","action":"%s","mode":"%s","ok":%s,"update_sh":%s%s}\n' \
    "$(date -Iseconds)" "$1" "$2" "$ok" "$SELF_VERSION" "$extra" | write_atomic "$STATE_FILE"
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

# Data directory: where the container's /data really lives. The release
# docker-compose.yml binds ./data; older installs used the named
# volume gatecontrol-data (Docker prefixes it with the project, e.g.
# gatecontrol_gatecontrol-data). For those, ./data does not exist and the
# server's config/state files sit in the volume — use its mountpoint instead
# of running into nothing. No data is moved; the handbook (FAQ "Server-Daten
# von einem Docker-Volume nach ./data umziehen") describes the move. An
# explicit GC_DATA_DIR always wins.
if [ -z "${GC_DATA_DIR:-}" ]; then
  DATA_MOUNT="$(docker inspect "$CONTAINER" --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Type}}|{{.Name}}|{{.Source}}{{end}}{{end}}' 2>/dev/null || true)"
  DATA_TYPE="${DATA_MOUNT%%|*}"; DATA_REST="${DATA_MOUNT#*|}"
  DATA_VOL="${DATA_REST%%|*}"; DATA_SRC="${DATA_REST#*|}"
  if [ "$DATA_TYPE" = "volume" ] && [ -n "$DATA_SRC" ]; then
    if [ -d "$DATA_SRC" ]; then
      log "NOTE: /data of '$CONTAINER' is the Docker volume '$DATA_VOL' ($DATA_SRC), not $COMPOSE_DIR/data — using the volume. Moving to ./data is optional; see the GateControl handbook, FAQ: move the server data from a Docker volume to ./data"
      DATA_DIR="$DATA_SRC"
    else
      log "WARN: /data of '$CONTAINER' is the Docker volume '$DATA_VOL', but its mountpoint $DATA_SRC is not reachable from here — falling back to $DATA_DIR (set GC_DATA_DIR)"
    fi
  elif [ "$DATA_TYPE" = "bind" ] && [ -n "$DATA_SRC" ] && [ -d "$DATA_SRC" ] \
       && [ "$(readlink -f "$DATA_SRC" 2>/dev/null || echo "$DATA_SRC")" != "$(readlink -f "$DATA_DIR" 2>/dev/null || echo "$DATA_DIR")" ]; then
    log "NOTE: /data of '$CONTAINER' is bound to $DATA_SRC, not $COMPOSE_DIR/data — using $DATA_SRC"
    DATA_DIR="$DATA_SRC"
  fi
fi

CONFIG_FILE="$DATA_DIR/.auto-update-config.json"
STATE_FILE="$DATA_DIR/.auto-update-state.json"
FLAG_FILE="$DATA_DIR/pending-update"
BAD_FILE="$DATA_DIR/.auto-update-bad-image"

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

# Marker 9: is the drive of the recordings there? (state only — see the header)
REC_STATE="$DATA_DIR/.remote-recordings-state.json"
has_recordings_mount() { # $1=container
  docker inspect -f '{{range .Mounts}}{{println .Destination}}{{end}}' "$1" 2>/dev/null | grep -x '/recordings' >/dev/null
}
sync_recordings() {
  local compose=false guacd=false gc=false
  grep -q 'remote-recordings:/recordings' "$COMPOSE_DIR/docker-compose.yml" 2>/dev/null && compose=true
  has_recordings_mount guacd && guacd=true
  has_recordings_mount "$CONTAINER" && gc=true
  printf '{"checked_at":"%s","compose":%s,"guacd":%s,"gatecontrol":%s}\n' \
    "$(date -Iseconds)" "$compose" "$guacd" "$gc" | write_atomic "$REC_STATE"
}

CLAMAV_IMAGE="${GC_CLAMAV_IMAGE:-clamav/clamav:1.4}"
CLAMAV_STATE="$DATA_DIR/.clamav-state.json"
# Kept next to docker-compose.yml (root's), not on the /data volume: GateControl
# can write /data, and clamd.conf decides what clamd listens on.
CLAMAV_DIR="$COMPOSE_DIR/clamav"
CLAMAV_MANAGED="$CLAMAV_DIR/.managed"
CLAMAV_MIN_MEM_MB="${GC_CLAMAV_MIN_MEM_MB:-3000}"

clamav_wanted() { [ -f "$CONFIG_FILE" ] && grep -q '"clamav"[[:space:]]*:[[:space:]]*"on"' "$CONFIG_FILE" 2>/dev/null; }
clamav_exists() { docker inspect clamav >/dev/null 2>&1; }
clamav_running() { [ "$(docker inspect -f '{{.State.Running}}' clamav 2>/dev/null || true)" = "true" ]; }
clamav_state() { # $1=state (running|starting|failed|stopped) [$2=error code]
  printf '{"checked_at":"%s","state":"%s","error":"%s","update_sh":%s}\n' \
    "$(date -Iseconds)" "$(safe "$1")" "$(safe "${2:-}")" "$SELF_VERSION" | write_atomic "$CLAMAV_STATE"
}
clamav_in_compose() { ( cd "$COMPOSE_DIR" && docker compose --profile clamav config --services 2>/dev/null ) | grep -x clamav >/dev/null; }

run_clamav() {
  # Same settings as the clamav service of docker-compose.yml, for a compose
  # file from before it: clamd only on 127.0.0.1:3310 (host network), freshclam
  # 12x a day, signatures in the volume clamav-db, at most 2 GB.
  mkdir -p "$CLAMAV_DIR" || return 1
  cat >"$CLAMAV_DIR/clamd.conf" <<'CONF' || return 1
Foreground yes
LogTime yes
LocalSocket /tmp/clamd.sock
TCPSocket 3310
TCPAddr 127.0.0.1
DatabaseDirectory /var/lib/clamav
ConcurrentDatabaseReload no
SelfCheck 3600
StreamMaxLength 200M
MaxFileSize 200M
MaxScanSize 400M
MaxRecursion 5
MaxThreads 4
CONF
  chmod 644 "$CLAMAV_DIR/clamd.conf" 2>/dev/null || true
  docker run -d --name clamav --network host --restart unless-stopped --memory 2g \
    --log-driver json-file --log-opt max-size=10m --log-opt max-file=3 \
    -e FRESHCLAM_CHECKS=12 -v clamav-db:/var/lib/clamav \
    -v "$CLAMAV_DIR/clamd.conf:/etc/clamav/clamd.conf:ro" \
    --label gatecontrol.clamav=managed "$CLAMAV_IMAGE" >>"$LOG" 2>&1
}

start_clamav() {
  docker pull "$CLAMAV_IMAGE" >>"$LOG" 2>&1 || [ -n "$(image_id "$CLAMAV_IMAGE")" ] || return 1
  if clamav_exists; then
    docker start clamav >>"$LOG" 2>&1 && return 0
    docker rm -f clamav >>"$LOG" 2>&1 || true
  fi
  if clamav_in_compose; then
    ( cd "$COMPOSE_DIR" && docker compose --profile clamav up -d clamav ) >>"$LOG" 2>&1
  else
    run_clamav
  fi
}

sync_clamav() {
  # Every run: bring ClamAV in line with the choice in Einstellungen → Virenscan.
  if clamav_wanted; then
    if clamav_running; then clamav_state running; return 0; fi
    # a failed start is retried every 30 minutes, not every run
    if [ -n "$(find "$CLAMAV_STATE" -mmin -30 2>/dev/null)" ] && grep -q '"state":"failed"' "$CLAMAV_STATE" 2>/dev/null; then return 0; fi
    local mem_kb
    mem_kb="$(sed -n 's/^MemTotal:[[:space:]]*\([0-9][0-9]*\) kB$/\1/p' /proc/meminfo 2>/dev/null | head -n1)"
    if [ -n "$mem_kb" ] && [ "$((mem_kb / 1024))" -lt "$CLAMAV_MIN_MEM_MB" ]; then
      log "clamav: not started — $((mem_kb / 1024)) MB RAM, needs $CLAMAV_MIN_MEM_MB (GC_CLAMAV_MIN_MEM_MB)"
      clamav_state failed low_memory; return 0
    fi
    log "clamav: starting (ClamAV auf diesem Server)"
    if start_clamav; then
      mkdir -p "$CLAMAV_DIR" 2>/dev/null && : >"$CLAMAV_MANAGED" 2>/dev/null || true
      clamav_state starting
    else
      log "clamav: start failed"
      clamav_state failed start_failed
    fi
  elif [ -f "$CLAMAV_MANAGED" ]; then
    # only a container this script started; one started by hand stays
    log "clamav: another scanner chosen — stopping the clamav container"
    docker rm -f clamav >>"$LOG" 2>&1 || true
    rm -f "$CLAMAV_MANAGED"
    clamav_state stopped
  fi
}

BRIDGES_STATE="$DATA_DIR/.bridges-state.json"
BRIDGES_PROBE="$DATA_DIR/.bridges-probe.json"
# Next to docker-compose.yml (root's), not on the /data volume GateControl can write.
BRIDGES_MANAGED="$COMPOSE_DIR/.bruecken-managed"
# marker 8: the images the server pins (a compose override of this script's own), snapshots and their restore
BRIDGES_IMAGES="$COMPOSE_DIR/.bruecken-images.yml"
BRIDGES_BACKUP="$DATA_DIR/.bridges-backup.json"
BRIDGES_RESTORE="$DATA_DIR/.bridges-restore.json"
BRIDGES_BACKUP_DONE="$COMPOSE_DIR/.bruecken-backup-done"
BRIDGES_MISSING=""   # marker 10: wanted bridges the docker-compose.yml lacks (sync_bridges)
# docker-compose.yml mounts the bridges' folders from here (default ./data/bridges):
# the data directory may be somewhere else (see above).
export GC_BRIDGES_DIR="$DATA_DIR/bridges"

bridges_wanted() { # the wanted bridges, one per line (strict charset: the names end up in container names)
  [ -f "$CONFIG_FILE" ] || return 0
  tr -d '\n' <"$CONFIG_FILE" 2>/dev/null | sed -n 's/.*"bridges"[[:space:]]*:[[:space:]]*"\([a-z,]*\)".*/\1/p' \
    | tr ',' '\n' | grep -E '^[a-z]{2,16}$' | sort -u || true
}
# marker 10: a wanted bridge the docker-compose.yml does not know yet (Signal, Telegram in an older file) is left out
# — the others run; the state file says "<name>":{"present":false} and the server shows "replace docker-compose.yml"
bridges_wanted_split() { # $1=present|missing → the wanted bridges the compose file has (or lacks), one per line
  local n svc want
  want="$(bridges_wanted)"
  [ -n "$want" ] || return 0
  svc="$(bridges_services)"
  for n in $want; do
    if has_line "$svc" "bruecken-$n"; then [ "$1" = present ] && echo "$n"; else [ "$1" = missing ] && echo "$n"; fi
  done
  return 0
}
bridges_rev() { # the revision of the containers' configuration the server wrote ("" = unknown)
  [ -f "$CONFIG_FILE" ] || return 0
  tr -d '\n' <"$CONFIG_FILE" 2>/dev/null | sed -n 's/.*"bridges_rev"[[:space:]]*:[[:space:]]*"\([0-9a-f]\{12\}\)".*/\1/p'
}
bridges_id() { # $1=key → a 12-hex id the server wrote ("" = none)
  [ -f "$CONFIG_FILE" ] || return 0
  tr -d '\n' <"$CONFIG_FILE" 2>/dev/null | sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([0-9a-f]\{12\}\)\".*/\1/p" | head -n1
}
bridge_repo() { # $1=name → the only repository its image may come from
  case "$1" in
    hs) echo 'ghcr.io/matrix-construct/tuwunel' ;;
    whatsapp) echo 'dock.mau.dev/mautrix/whatsapp' ;;
    signal) echo 'dock.mau.dev/mautrix/signal' ;;
    telegram) echo 'dock.mau.dev/mautrix/telegram' ;;
    core-relay|whatsapp-relay|signal-relay|telegram-relay) echo 'alpine/socat' ;;
    *) return 1 ;;
  esac
}
bridges_images_sync() { # the pins of the server → .bruecken-images.yml (only known repositories, only services of the compose file)
  local list item name ref repo svc body="" tmp
  [ -f "$CONFIG_FILE" ] || return 0
  list="$(tr -d '\n' <"$CONFIG_FILE" 2>/dev/null | sed -n 's/.*"bridges_images"[[:space:]]*:[[:space:]]*"\([A-Za-z0-9._:\/@=,-]*\)".*/\1/p' | head -n1)"
  svc="$(bridges_services)"
  for item in $(printf '%s' "$list" | tr ',' ' '); do
    name="${item%%=*}"; ref="${item#*=}"
    repo="$(bridge_repo "$name")" || continue
    case "$ref" in "$repo:"*) ;; *) log "bridges: the image for $name is not from $repo — not taken"; continue ;; esac
    printf '%s' "${ref#"$repo:"}" | grep -E '^[A-Za-z0-9._-]{1,60}@sha256:[0-9a-f]{64}$' >/dev/null || { log "bridges: the image for $name is no pin — not taken"; continue; }
    has_line "$svc" "bruecken-$name" || continue
    body="$body  bruecken-$name:\n    image: \"$ref\"\n"
  done
  if [ -z "$body" ]; then rm -f "$BRIDGES_IMAGES"; return 0; fi
  tmp="$(mktemp "$BRIDGES_IMAGES.XXXXXX")" || return 0
  printf '# Written by update.sh: the images GateControl pins (src/services/bridges/images.js).\nservices:\n%b' "$body" >"$tmp"
  if cmp -s "$tmp" "$BRIDGES_IMAGES" 2>/dev/null; then rm -f "$tmp"; else chmod 644 "$tmp"; mv -f "$tmp" "$BRIDGES_IMAGES"; fi
}
bcompose() { # docker compose for the profile — `up` with the server's pins when it named them
  local f=""
  if [ "$1" = up ] && [ -f "$BRIDGES_IMAGES" ]; then
    f="-f docker-compose.yml"
    [ -f "$COMPOSE_DIR/docker-compose.override.yml" ] && f="$f -f docker-compose.override.yml"
    f="$f -f $(basename "$BRIDGES_IMAGES")"
  fi
  # shellcheck disable=SC2086
  ( cd "$COMPOSE_DIR" && docker compose $f --profile bruecken "$@" )
}
# bruecken-hs, bruecken-<name> and the relay of a bridge (bruecken-<name>-relay: hands the homeserver's calls to
# the bridge's Unix socket)
bridges_services() { ( cd "$COMPOSE_DIR" && docker compose --profile bruecken config --services 2>/dev/null ) | grep -E '^bruecken-[a-z]{2,16}(-relay)?$' || true; }
# $1=list (one per line) $2=name → 0 when $2 is one of the lines. No pipe on purpose: under pipefail,
# `printf '%s\n' "$list" | grep -qx …` fails at random — grep -q leaves at the first hit, bash writes the list
# line by line and the next write gets SIGPIPE (exit 141), so a present service read as missing.
has_line() { case $'\n'"$1"$'\n' in *$'\n'"$2"$'\n'*) return 0 ;; esac; return 1; }
bridge_running() { [ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null || true)" = "true" ]; }
to_mb() { # "123.4MiB" / "1.2GiB" / "900KiB" → whole MiB; anything else → nothing
  printf '%s' "$1" | awk '/^[0-9.]+GiB$/ { printf "%d", $0 * 1024; exit } /^[0-9.]+MiB$/ { printf "%d", $0 + 0.5; exit } /^[0-9.]+KiB$/ { printf "%d", $0 / 1024; exit } /^[0-9.]+B$/ { printf "0"; exit }'
}
bridge_image() { docker inspect -f '{{.Config.Image}}' "$1" 2>/dev/null | head -n1 | tr -cd 'A-Za-z0-9._:+/@-' || true; }
bridge_json() { # $1=container → {"running":…,"mem_mb":…,"limit_mb":…,"version":"…","image":"…"}
  local run=false usage="" mem="" lim="" ver="" img=""
  if bridge_running "$1"; then
    run=true
    usage="$(docker stats --no-stream --format '{{.MemUsage}}' "$1" 2>/dev/null | head -n1 | tr -d ' ' || true)"
    mem="$(to_mb "${usage%%/*}")"; lim="$(to_mb "${usage##*/}")"
    ver="$(safe "$(docker inspect -f '{{ index .Config.Labels "org.opencontainers.image.version" }}' "$1" 2>/dev/null || true)")"
    # the image the container really runs (<repo>:<tag>@<digest> as docker-compose.yml names it): the server
    # compares it with the one it pins and shows "outdated"
    img="$(bridge_image "$1")"
  fi
  printf '{"running":%s,"mem_mb":%s,"limit_mb":%s,"version":"%s","image":"%s"}' "$run" "${mem:-null}" "${lim:-null}" "$ver" "$img"
}
bridges_state() { # $1=state (running|starting|failed|stopped) $2=error code (or "") $3…=bridge names
  local st="$1" er="$2" body n
  shift 2
  body="\"hs\":$(bridge_json bruecken-hs)"
  for n in "$@"; do body="$body,\"$n\":$(bridge_json "bruecken-$n")"; done
  for n in $BRIDGES_MISSING; do body="$body,\"$n\":{\"present\":false,\"running\":false}"; done
  # the server's own relay: missing in an older docker-compose.yml
  if has_line "$(bridges_services)" 'bruecken-core-relay'; then
    body="$body,\"core-relay\":{\"present\":true,\"running\":$(bridge_running bruecken-core-relay && echo true || echo false)}"
  else
    body="$body,\"core-relay\":{\"present\":false,\"running\":false}"
  fi
  printf '{"checked_at":"%s","state":"%s","error":"%s","update_sh":%s,"services":{%s}}\n' \
    "$(date -Iseconds)" "$(safe "$st")" "$(safe "$er")" "$SELF_VERSION" "$body" | write_atomic "$BRIDGES_STATE"
}
# What the containers were started with: the configuration revision of the server and the docker-compose.yml.
# A change of either means `compose up` has to look again (it recreates only what really changed; a new
# configuration needs --force-recreate, the files are bind mounts compose does not watch).
bridges_stamp() {
  local img=""
  [ -f "$BRIDGES_IMAGES" ] && img=" images=$(cksum <"$BRIDGES_IMAGES" 2>/dev/null | tr -d ' ')"
  printf 'rev=%s compose=%s%s\n' "$(bridges_rev)" "$(cksum <"$COMPOSE_DIR/docker-compose.yml" 2>/dev/null | tr -d ' ')" "$img"
}

bridges_backup_maybe() { # $@=wanted bridges — a snapshot of the stopped containers' data, once per request of the server
  local id dir tmp res=ok bytes=null paths="hs/data" stop="" start="bruecken-hs" n
  id="$(bridges_id bridges_backup)"
  [ -n "$id" ] || return 0
  [ "$id" = "$(cat "$BRIDGES_BACKUP_DONE" 2>/dev/null || true)" ] && return 0
  dir="$GC_BRIDGES_DIR/backup"
  mkdir -p "$dir" && chmod 700 "$dir"
  for n in "$@"; do
    stop="$stop bruecken-$n"; start="$start bruecken-$n"
    [ -d "$GC_BRIDGES_DIR/$n/data" ] && paths="$paths $n/data"
  done
  stop="${stop# } bruecken-hs"
  log "bridges: snapshot — stopping$stop for a moment"
  tmp="$dir/.state-$id.tar.part"
  # shellcheck disable=SC2086
  if ( cd "$COMPOSE_DIR" && docker compose --profile bruecken stop $stop ) >>"$LOG" 2>&1; then
    # shellcheck disable=SC2086
    if ( umask 077; tar -C "$GC_BRIDGES_DIR" -cf "$tmp" $paths ) 2>>"$LOG"; then
      chown --reference="$dir" "$tmp" 2>/dev/null || true
      mv -f "$tmp" "$dir/state-$id.tar"
      bytes="$(stat -c %s "$dir/state-$id.tar" 2>/dev/null || echo null)"
    else
      res=failed; rm -f "$tmp"
    fi
  else
    res=failed
  fi
  # shellcheck disable=SC2086
  ( cd "$COMPOSE_DIR" && docker compose --profile bruecken start $start ) >>"$LOG" 2>&1 || log "bridges: start after the snapshot failed — the next run starts them"
  [ "$res" = ok ] || log "bridges: snapshot failed"
  printf '{"id":"%s","result":"%s","at":"%s","bytes":%s,"update_sh":%s}\n' "$id" "$res" "$(date -Iseconds)" "$bytes" "$SELF_VERSION" | write_atomic "$BRIDGES_BACKUP"
  printf '%s\n' "$id" >"$BRIDGES_BACKUP_DONE" 2>/dev/null || true
}

bridges_restore_result() { # $1=id $2=result
  printf '{"id":"%s","result":"%s","at":"%s","update_sh":%s}\n' "$1" "$2" "$(date -Iseconds)" "$SELF_VERSION" | write_atomic "$BRIDGES_RESTORE"
}
bridges_restore_maybe() { # $@=wanted bridges — put a snapshot back the server left; 0 = something was done (the containers are stopped)
  local id f re d n stop="" dirs="hs/data" bad
  id="$(bridges_id bridges_restore)"
  [ -n "$id" ] || return 1
  [ "$(sed -n 's/.*"id":"\([0-9a-f]*\)".*/\1/p' "$BRIDGES_RESTORE" 2>/dev/null | head -n1)" = "$id" ] && return 1
  f="$GC_BRIDGES_DIR/backup/restore-$id.tar"
  if [ ! -f "$f" ] || [ -L "$f" ]; then bridges_restore_result "$id" missing; return 1; fi
  re='hs'
  for n in "$@"; do re="$re|$n"; stop="$stop bruecken-$n"; dirs="$dirs $n/data"; done
  # only plain files and folders, only below the data folders, no way out
  bad="$(tar -tvf "$f" 2>/dev/null | awk '{ t = substr($1, 1, 1); if (t != "-" && t != "d") { print "x"; exit } }')"
  if [ -z "$bad" ]; then
    bad="$(tar -tf "$f" 2>/dev/null | grep -Ev "^($re)/data(/[A-Za-z0-9._+=-]+)*/?\$" | head -n1 || true)"
    tar -tf "$f" >/dev/null 2>&1 || bad="x"
    tar -tf "$f" 2>/dev/null | grep '\.\.' >/dev/null && bad="x"
  fi
  if [ -n "$bad" ]; then
    log "bridges: the snapshot to restore holds something else than the data folders — not restored"
    bridges_restore_result "$id" invalid; rm -f "$f"; return 1
  fi
  log "bridges: restoring the snapshot — stopping the containers"
  # shellcheck disable=SC2086
  ( cd "$COMPOSE_DIR" && docker compose --profile bruecken stop ${stop# } bruecken-hs ) >>"$LOG" 2>&1 || true
  for d in $dirs; do
    rm -rf "${GC_BRIDGES_DIR:?}/$d.prev"
    [ -e "$GC_BRIDGES_DIR/$d" ] && mv "$GC_BRIDGES_DIR/$d" "$GC_BRIDGES_DIR/$d.prev"
  done
  if tar -C "$GC_BRIDGES_DIR" --no-same-owner -xf "$f" 2>>"$LOG"; then
    for d in $dirs; do
      mkdir -p "$GC_BRIDGES_DIR/$d"; chmod 700 "$GC_BRIDGES_DIR/$d"
      chown --reference="$GC_BRIDGES_DIR/backup" "$GC_BRIDGES_DIR/$d" 2>/dev/null || true
    done
    bridges_restore_result "$id" ok
  else
    log "bridges: unpacking failed — the folders before stay"
    for d in $dirs; do
      rm -rf "${GC_BRIDGES_DIR:?}/$d"
      [ -e "$GC_BRIDGES_DIR/$d.prev" ] && mv "$GC_BRIDGES_DIR/$d.prev" "$GC_BRIDGES_DIR/$d"
    done
    bridges_restore_result "$id" failed
  fi
  rm -f "$f"
  return 0
}

sync_bridges() {
  # Every run: bring the bridges in line with the switch in the messenger's settings.
  local want svc names n cfg up=1 stamp old force=""
  want="$(bridges_wanted_split present)"
  BRIDGES_MISSING="$(bridges_wanted_split missing | tr '\n' ' ')"
  if [ -n "$BRIDGES_MISSING" ]; then log "bridges: docker-compose.yml has no service for:$(printf ' %s' $BRIDGES_MISSING) — replace it with the release file"; fi
  if [ -z "$want" ] && [ -n "$BRIDGES_MISSING" ]; then
    # shellcheck disable=SC2086
    bridges_state failed compose_missing; return 0
  fi
  if [ -n "$want" ]; then
    svc="$(bridges_services)"
    names="bruecken-hs"
    if has_line "$svc" 'bruecken-core-relay'; then names="$names bruecken-core-relay"; fi
    for n in $want; do
      names="$names bruecken-$n"
      if has_line "$svc" "bruecken-$n-relay"; then names="$names bruecken-$n-relay"; fi
    done
    for n in $names; do
      if ! has_line "$svc" "$n"; then
        # a docker-compose.yml without the profile: it has to be replaced once, by hand
        # shellcheck disable=SC2086
        bridges_state failed compose_missing $want; return 0
      fi
      bridge_running "$n" || up=0
    done
    # the server writes the configuration before it asks for the bridges; without it Docker would make empty
    # folders and the containers would only crash
    cfg="hs/config/tuwunel.toml"
    for n in $want; do cfg="$cfg $n/config/config.yaml"; done
    for n in $cfg; do
      if [ ! -f "$GC_BRIDGES_DIR/$n" ]; then
        # shellcheck disable=SC2086
        bridges_state failed config_missing $want; return 0
      fi
    done
    # a bridge that was switched off while others stay on
    if [ -f "$BRIDGES_MANAGED" ]; then
      for n in $svc; do
        case " $names " in *" $n "*) ;; *) bridge_running "$n" && { log "bridges: $n switched off — removing the container"; docker rm -f "$n" >>"$LOG" 2>&1 || true; } ;; esac
      done
    fi
    # marker 8: a snapshot to put back first (it stops the containers), then the images the server pins
    # shellcheck disable=SC2086
    if bridges_restore_maybe $want; then up=0; rm -f "$BRIDGES_STATE"; fi
    bridges_images_sync
    stamp="$(bridges_stamp)"
    old="$(cat "$BRIDGES_MANAGED" 2>/dev/null || true)"
    if [ -f "$BRIDGES_MANAGED" ] && [ "$old" != "$stamp" ]; then
      # only containers this script started are touched
      case "$old" in "rev=$(bridges_rev) "*) ;; *) force="--force-recreate" ;; esac
      if [ "$up" = 1 ]; then
        up=0
        log "bridges: configuration or docker-compose.yml changed — updating the containers"
        rm -f "$BRIDGES_STATE"
      fi
    fi
    # shellcheck disable=SC2086
    if [ "$up" = 1 ]; then bridges_backup_maybe $want; bridges_state running "" $want; return 0; fi
    # a failed start is retried every 30 minutes, not every run
    if [ -n "$(find "$BRIDGES_STATE" -mmin -30 2>/dev/null)" ] && grep -q '"state":"failed"' "$BRIDGES_STATE" 2>/dev/null; then return 0; fi
    log "bridges: starting $names"
    # shellcheck disable=SC2086
    if bcompose up -d $force $names >>"$LOG" 2>&1; then
      printf '%s\n' "$stamp" >"$BRIDGES_MANAGED" 2>/dev/null || true
      # shellcheck disable=SC2086
      bridges_state starting "" $want
    else
      log "bridges: start failed"
      # shellcheck disable=SC2086
      bridges_state failed start_failed $want
    fi
  elif [ -f "$BRIDGES_MANAGED" ]; then
    # only containers this script started; their data in $DATA_DIR/bridges stays
    log "bridges: switched off — removing the containers"
    for n in $(bridges_services); do docker rm -f "$n" >>"$LOG" 2>&1 || true; done
    rm -f "$BRIDGES_MANAGED"
    rm -f "$BRIDGES_IMAGES"
    bridges_state stopped ""
  fi
}

# ./update.sh bridges-probe [seconds]
# Starts the bridges that are switched on (nothing else, and nothing when they are off), waits until they
# run, then measures for <seconds> (default 60, 10…900): memory per container (now and the highest value
# seen), what each wrote to the disk in that time, restarts, and the last log lines. Result:
# $DATA_DIR/.bridges-probe.json (the messenger's settings show the numbers; the log lines are only in the
# file) and a summary on the terminal. Reads and measures only — it changes no setting.
probe_redact() { # stdin → the same lines, without what belongs to nobody but the person
  # Whole lines go: linking (QR and pairing data, wa.me links; Signal's sgnl://linkdevice and its transfer archive;
  # Telegram's tg://login tokens and t.me links), calls of the provisioning API, raw events and request bodies. In the
  # rest: Matrix addresses, WhatsApp ids (JID/LID), Signal account ids (UUIDs, also PNI:…), id fields, keys and tokens
  # (Base64 and the like, 20 characters and more — Signal's group ids too) and runs of digits (Telegram's numeric ids,
  # phone numbers) are blanked.
  grep -Eiv 'wa\.me|linked_devices|/_matrix/provision|provisioning|event_data|pairing|(^|[^a-z])qr([^a-z]|$)|req(uest)?_?body|"body"|sgnl:|linkdevice|link_device|transfer.?archive|ephemeral.?backup|tg:|t\.me/|telegram\.me/|login.?token|2fa|password' \
    | sed -E \
      -e 's/(PNI:)?[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/[uuid]/g' \
      -e 's/@[A-Za-z0-9._=\/+-]+:[A-Za-z0-9.-]+/[@]/g' \
      -e 's/[A-Za-z0-9._:+-]+@(s\.whatsapp\.net|lid|g\.us|c\.us|broadcast|newsletter|hosted|hosted\.lid)/[jid]/g' \
      -e 's/(user_mxid|user_id|user_login_id|login_id|portal_id|portal_receiver|sender_id|chat_id|room_id|event_id|message_id|ghost_id|jid|lid|phone|identifier|aci|pni|service_id|recipient_id|group_id|e164|number|username|peer_id|channel_id|access_hash)(["=: ]+)[^ ,"}]+/\1\2[...]/g' \
      -e 's/[!$][A-Za-z0-9._=\/+-]{8,}(:[A-Za-z0-9.-]+)?/[id]/g' \
      -e 's/[A-Za-z0-9+\/=_-]{20,}/[...]/g' \
      -e 's/\+[0-9][0-9 ()\/-]{5,}[0-9]/[#]/g' \
      -e 's/([0-9]{2,} ){2,}[0-9]{2,}/[#]/g' \
      -e 's/[0-9]{5,}/[#]/g' || true
}
probe_text() { # stdin → the inside of a JSON string: redacted (probe_redact), control characters dropped
  probe_redact | tail -c 6000 | tr -d '\000-\010\013-\037' \
    | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/\t/ /g' | awk 'BEGIN { ORS = "" } NR > 1 { print "\\n" } { print }'
}
probe_write_kb() { # $1=container → kB its main process wrote so far (/proc/<pid>/io), "" when unreadable
  local pid
  pid="$(docker inspect -f '{{.State.Pid}}' "$1" 2>/dev/null || true)"
  case "$pid" in ''|0|*[!0-9]*) return 0 ;; esac
  awk '/^write_bytes:/ { printf "%d", $2 / 1024 }' "/proc/$pid/io" 2>/dev/null || true
}
probe_blkio_kb() { # $1=container → kB written according to docker stats ("1.2MB / 3.4MB" → the second), "" when unknown
  docker stats --no-stream --format '{{.BlockIO}}' "$1" 2>/dev/null | head -n1 | awk -F'/' '{ v = $2; gsub(/ /, "", v);
    if (v ~ /^[0-9.]+GB$/) printf "%d", v * 1000000; else if (v ~ /^[0-9.]+MB$/) printf "%d", v * 1000;
    else if (v ~ /^[0-9.]+kB$/) printf "%d", v + 0; else if (v ~ /^[0-9.]+B$/) printf "0" }' || true
}
probe_mem_mb() { to_mb "$(docker stats --no-stream --format '{{.MemUsage}}' "$1" 2>/dev/null | head -n1 | tr -d ' ' | cut -d/ -f1)"; }
bridges_probe() {
  local window="${1:-60}" want names="" svc n c i result="ok" st er body="" socks="" logs="" disk=""
  case "$window" in ''|*[!0-9]*) window=60 ;; esac
  if [ "$window" -lt 10 ] || [ "$window" -gt 900 ]; then window=60; fi
  want="$(bridges_wanted_split present)"
  if [ -z "$(bridges_wanted)" ]; then
    result="not_wanted"
    echo "The bridges are not switched on (Messenger › Übersicht › Brücken; the server needs GC_BRIDGES_PREVIEW=1)."
  else
    rm -f "$BRIDGES_STATE"   # start now, not at the next retry
    sync_bridges
    st="$(sed -n 's/.*"state":"\([a-z_]*\)".*/\1/p' "$BRIDGES_STATE" 2>/dev/null | head -n1)"
    er="$(sed -n 's/.*"error":"\([a-z_]*\)".*/\1/p' "$BRIDGES_STATE" 2>/dev/null | head -n1)"
    svc="$(bridges_services)"
    names="bruecken-hs"
    if has_line "$svc" 'bruecken-core-relay'; then names="$names bruecken-core-relay"; fi
    for n in $want; do
      names="$names bruecken-$n"
      if has_line "$svc" "bruecken-$n-relay"; then names="$names bruecken-$n-relay"; fi
    done
    if [ "$st" = "failed" ]; then
      result="${er:-start_failed}"
      echo "The bridges were not started: $result (details: $LOG)."
    else
      echo "Waiting for the containers ($names) …"
      i=0
      while [ "$i" -lt 36 ]; do
        c=1
        for n in $names; do bridge_running "$n" || c=0; done
        [ -S "$GC_BRIDGES_DIR/hs/run/hs.sock" ] || c=0
        for n in $want; do [ -S "$GC_BRIDGES_DIR/run/$n.sock" ] || c=0; done
        [ "$c" = 1 ] && break
        sleep 5; i=$((i + 1))
      done
      [ "$c" = 1 ] || result="not_running"
    fi
  fi
  if [ -n "$names" ] && [ "$result" != "compose_missing" ] && [ "$result" != "config_missing" ]; then
    local w0 b0 w1 b1 mem peak m lim usage t
    declare -A W0 B0 PEAK
    for n in $names; do W0[$n]="$(probe_write_kb "$n")"; B0[$n]="$(probe_blkio_kb "$n")"; PEAK[$n]=0; done
    echo "Measuring for $window seconds …"
    t=0
    while [ "$t" -lt "$window" ]; do
      sleep 10; t=$((t + 10))
      for n in $names; do m="$(probe_mem_mb "$n")"; if [ -n "$m" ] && [ "$m" -gt "${PEAK[$n]}" ]; then PEAK[$n]="$m"; fi; done
    done
    for n in $names; do
      usage="$(docker stats --no-stream --format '{{.MemUsage}}' "$n" 2>/dev/null | head -n1 | tr -d ' ' || true)"
      mem="$(to_mb "${usage%%/*}")"; lim="$(to_mb "${usage##*/}")"
      w1="$(probe_write_kb "$n")"; b1="$(probe_blkio_kb "$n")"; w0="${W0[$n]}"; b0="${B0[$n]}"
      peak="${PEAK[$n]}"; if [ -n "$mem" ] && [ "$mem" -gt "$peak" ]; then peak="$mem"; fi
      c="${n#bruecken-}"
      body="$body${body:+,}\"$c\":{\"running\":$(bridge_running "$n" && echo true || echo false)"
      body="$body,\"restarts\":$(docker inspect -f '{{.RestartCount}}' "$n" 2>/dev/null | tr -cd '0-9' | head -c 6 | grep . || echo null)"
      body="$body,\"oom\":$([ "$(docker inspect -f '{{.State.OOMKilled}}' "$n" 2>/dev/null || true)" = "true" ] && echo true || echo false)"
      body="$body,\"exit\":$(docker inspect -f '{{.State.ExitCode}}' "$n" 2>/dev/null | tr -cd '0-9' | head -c 4 | grep . || echo null)"
      body="$body,\"health\":\"$(safe "$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$n" 2>/dev/null || true)")\""
      body="$body,\"mem_mb\":${mem:-null},\"mem_peak_mb\":${peak:-null},\"limit_mb\":${lim:-null}"
      if [ -n "$w0" ] && [ -n "$w1" ] && [ "$w1" -ge "$w0" ]; then body="$body,\"write_kb\":$((w1 - w0))"; else body="$body,\"write_kb\":null"; fi
      if [ -n "$b0" ] && [ -n "$b1" ] && [ "$b1" -ge "$b0" ]; then body="$body,\"blkio_write_kb\":$((b1 - b0))"; else body="$body,\"blkio_write_kb\":null"; fi
      body="$body,\"image\":\"$(bridge_image "$n")\"}"
      logs="$logs${logs:+,}\"$c\":\"$(docker logs --tail 60 "$n" 2>&1 | probe_text)\""
      printf '  %-26s %s  memory %s MB (highest %s, limit %s)  written %s kB in %ss  restarts %s\n' "$n" \
        "$(bridge_running "$n" && echo running || echo 'NOT RUNNING')" "${mem:-?}" "${peak:-?}" "${lim:-?}" \
        "$([ -n "$w0" ] && [ -n "$w1" ] && echo $((w1 - w0)) || echo '?')" "$window" "$(docker inspect -f '{{.RestartCount}}' "$n" 2>/dev/null || echo '?')"
    done
    socks="\"hs\":$([ -S "$GC_BRIDGES_DIR/hs/run/hs.sock" ] && echo true || echo false)"
    for n in $want; do socks="$socks,\"$n\":$([ -S "$GC_BRIDGES_DIR/run/$n.sock" ] && echo true || echo false)"; done
  fi
  disk="$(du -sm "$GC_BRIDGES_DIR" 2>/dev/null | awk '{ printf "%d", $1 }' || true)"
  printf '{"probed_at":"%s","update_sh":%s,"result":"%s","window_s":%s,"disk_mb":%s,"services":{%s},"sockets":{%s},"logs":{%s}}\n' \
    "$(date -Iseconds)" "$SELF_VERSION" "$(safe "$result")" "$window" "${disk:-null}" "$body" "$socks" "$logs" | write_atomic "$BRIDGES_PROBE"
  echo "Result: $result — written to $BRIDGES_PROBE"
}

ensure_clamav() {
  # After a GateControl update: pull the pinned tag of the clamav container
  # (the 1.4 LTS series — engine fixes arrive here) and recreate it when the
  # image changed. Signatures are freshclam's job inside the container.
  clamav_running || return 0
  docker pull "$CLAMAV_IMAGE" >>"$LOG" 2>&1 || return 0
  [ "$(docker inspect -f '{{.Image}}' clamav 2>/dev/null || true)" = "$(image_id "$CLAMAV_IMAGE")" ] && return 0
  log "clamav: new image — recreating"
  if [ -n "$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.project" }}' clamav 2>/dev/null || true)" ]; then
    ( cd "$COMPOSE_DIR" && docker compose --profile clamav up -d clamav ) >>"$LOG" 2>&1 || true
  else
    docker rm -f clamav >>"$LOG" 2>&1 || true
    run_clamav || log "clamav: recreate failed"
  fi
}

prune_images() {
  # Reclaim disk after a successful update: each :latest pull leaves the previous
  # image dangling. Without pruning the host fills up over time (incident
  # 2026-06-23: 187 images → root fs 100% → pulls failed → auto-update stalled).
  # -f removes ONLY dangling (untagged) images, so tagged/in-use images are safe
  # — including $ROLLBACK_TAG. Never add -a here: it would drop the rollback image.
  docker image prune -f >>"$LOG" 2>&1 || true
}

self_update() {
  # Replace THIS script with /app/update.sh of the new image — only after a
  # successful update, only on a real difference, only when the new file parses.
  # Never re-executed here: the running bash keeps the old inode (mv only swaps
  # the directory entry), so the new version takes effect on the next cron run.
  if [ "${GC_UPDATE_SH_SELFUPDATE:-1}" = "0" ]; then
    log "update.sh self-update disabled (GC_UPDATE_SH_SELFUPDATE=0) — keeping version $SELF_VERSION"
    return 0
  fi
  local tmp new_ver checker
  if ! tmp="$(mktemp "$SCRIPT_PATH.new.XXXXXX" 2>/dev/null)"; then
    log "WARN: update.sh self-update: no temporary file next to $SCRIPT_PATH (read-only dir?) — skipping"
    return 0
  fi
  if ! docker run --rm --entrypoint sh "$IMAGE" -c 'cat /app/update.sh' >"$tmp" 2>>"$LOG"; then
    log "WARN: update.sh self-update: could not read /app/update.sh from $IMAGE — keeping version $SELF_VERSION"
    rm -f "$tmp"; return 0
  fi
  if [ ! -s "$tmp" ]; then
    log "WARN: update.sh self-update: the image delivered an empty /app/update.sh — keeping version $SELF_VERSION"
    rm -f "$tmp"; return 0
  fi
  if cmp -s "$tmp" "$SCRIPT_PATH"; then
    log "update.sh is already the version from the image (v$SELF_VERSION) — nothing to do"
    rm -f "$tmp"; return 0
  fi
  new_ver="$(update_sh_version "$tmp")"; [ -n "$new_ver" ] || new_ver=0
  if command -v bash >/dev/null 2>&1; then checker="bash"; else checker="sh"; fi
  if ! "$checker" -n "$tmp" 2>>"$LOG"; then
    log "WARN: update.sh from the image has a syntax error ($checker -n failed) — NOT replacing, keeping version $SELF_VERSION"
    rm -f "$tmp"; return 0
  fi
  if ! cp -p "$SCRIPT_PATH" "$SCRIPT_PATH.bak" 2>>"$LOG"; then
    log "WARN: update.sh self-update: could not write $SCRIPT_PATH.bak — NOT replacing"
    rm -f "$tmp"; return 0
  fi
  if ! { chmod 755 "$tmp" && mv -f "$tmp" "$SCRIPT_PATH"; } 2>>"$LOG"; then
    log "WARN: update.sh self-update: replacing $SCRIPT_PATH failed — the old version stays in place"
    rm -f "$tmp"; return 0
  fi
  log "update.sh replaced: v$SELF_VERSION → v$new_ver (previous version kept as $SCRIPT_PATH.bak); it takes effect on the next run"
  SELF_VERSION="$new_ver"   # the marker written below describes the file on disk
  return 0
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
    ensure_guacd || true; sync_recordings || true; ensure_clamav || true; prune_images || true; self_update || true; write_state updated "$mode"; exit 0
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
    ensure_guacd || true; sync_recordings || true
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

if [ "${1:-}" = "bridges-probe" ]; then
  bridges_probe "${2:-}" || true
  exit 0
fi

sync_clamav || true
sync_bridges || true
sync_recordings || true

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
