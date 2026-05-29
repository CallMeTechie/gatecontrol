#!/bin/bash
# GateControl Auto-Update Script
# Pulls the latest image from GHCR and recreates the container when the RUNNING
# container's image differs from :latest.
#
# The recreate decision is based on the running container's image digest vs the
# :latest digest — NOT on `docker pull`'s "Image is up to date" message. That
# message is a no-op whenever :latest was already pulled locally while the
# container still runs an OLDER image (e.g. a prior pull without a recreate, or
# a half-finished deploy). The old logic then exited 0 without recreating, so
# the running container silently stayed on the stale version.
#
# The compose project directory is derived from the script's own location
# (so the script works regardless of where the deployment lives) but can
# be overridden with the COMPOSE_DIR environment variable for unusual
# layouts or CI pipelines.
#
# Resolves symlinks so callers can place a symlink in PATH if they want.

set -euo pipefail

SCRIPT_PATH="$(readlink -f "${BASH_SOURCE[0]:-$0}")"
SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"
COMPOSE_DIR="${COMPOSE_DIR:-$SCRIPT_DIR}"
IMAGE="${GC_IMAGE:-ghcr.io/callmetechie/gatecontrol:latest}"
CONTAINER="${GC_CONTAINER:-gatecontrol}"
LOG="${GC_UPDATE_LOG:-/var/log/gatecontrol-update.log}"
WAIT_TIMEOUT="${GC_WAIT_TIMEOUT:-150}"

# Log to both the logfile (best-effort) and stdout (so manual/interactive runs
# show progress, and cron captures it too).
log() { local m; m="[$(date -Iseconds)] $*"; echo "$m"; echo "$m" >>"$LOG" 2>/dev/null || true; }

# docker-compose.yml is mandatory in the resolved directory — if it is
# missing, fail loudly instead of quietly running in the wrong place.
if [ ! -f "$COMPOSE_DIR/docker-compose.yml" ]; then
  echo "ERROR: no docker-compose.yml in $COMPOSE_DIR" >&2
  echo "       Set COMPOSE_DIR explicitly or move this script next to docker-compose.yml." >&2
  exit 2
fi

# Safety guard: refuse to recreate the live container from a DIFFERENT project
# directory than the one it was actually deployed from. The source repo and the
# deploy dir both contain a docker-compose.yml, but with different /data volumes
# (repo: a named volume; deploy: the real ./data bind-mount). Recreating from
# the wrong dir silently swaps the container onto the wrong/empty volume and
# wipes the live database. Compare the running container's compose working-dir
# label against COMPOSE_DIR. Skipped on first install (no running container).
DEPLOYED_DIR="$(docker inspect "$CONTAINER" --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' 2>/dev/null || true)"
if [ -n "$DEPLOYED_DIR" ]; then
  CANON_COMPOSE="$(readlink -f "$COMPOSE_DIR" 2>/dev/null || echo "$COMPOSE_DIR")"
  CANON_DEPLOYED="$(readlink -f "$DEPLOYED_DIR" 2>/dev/null || echo "$DEPLOYED_DIR")"
  if [ "$CANON_COMPOSE" != "$CANON_DEPLOYED" ]; then
    log "ERROR: container '$CONTAINER' was deployed from '$DEPLOYED_DIR' but this"
    log "       script runs from '$COMPOSE_DIR'. Recreating here would mount a"
    log "       different /data volume and could wipe the live database. Run from"
    log "       '$DEPLOYED_DIR' instead (or: COMPOSE_DIR='$DEPLOYED_DIR' $0)."
    exit 3
  fi
fi

log "Checking for updates ($COMPOSE_DIR)..."

# Always pull so local :latest reflects the registry. Pull failures are fatal
# (don't proceed to compare against a stale local tag).
if ! docker pull "$IMAGE" >>"$LOG" 2>&1; then
  log "ERROR: docker pull '$IMAGE' failed — aborting"
  exit 1
fi

LATEST_ID="$(docker image inspect "$IMAGE" --format '{{.Id}}' 2>/dev/null || true)"
RUNNING_ID="$(docker inspect "$CONTAINER" --format '{{.Image}}' 2>/dev/null || true)"

if [ -z "$LATEST_ID" ]; then
  log "ERROR: could not resolve image id for '$IMAGE' after pull — aborting"
  exit 1
fi

# Recreate ONLY when the running image differs from :latest (or no container
# is running yet). This is the digest-based check that fixes the silent no-op.
if [ -n "$RUNNING_ID" ] && [ "$RUNNING_ID" = "$LATEST_ID" ]; then
  log "Already up to date (running ${RUNNING_ID#sha256:})"
  exit 0
fi

log "Update needed: running=${RUNNING_ID:-<none>} -> latest=${LATEST_ID#sha256:}"

cd "$COMPOSE_DIR"
# --force-recreate guarantees the swap even when compose considers the service
# config unchanged; --wait blocks until the container's healthcheck passes so a
# broken image is reported as a failed deploy instead of a silent unhealthy box.
if docker compose up -d --force-recreate --wait --wait-timeout "$WAIT_TIMEOUT" "$CONTAINER" >>"$LOG" 2>&1; then
  NEW_ID="$(docker inspect "$CONTAINER" --format '{{.Image}}' 2>/dev/null || true)"
  log "Update complete and healthy (now ${NEW_ID#sha256:})"
else
  STATUS="$(docker ps -a --filter "name=$CONTAINER" --format '{{.Status}}' 2>/dev/null || true)"
  log "ERROR: recreate/healthcheck failed (status: ${STATUS:-unknown}) — check 'docker logs $CONTAINER'"
  exit 1
fi
