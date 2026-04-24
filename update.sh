#!/bin/bash
# GateControl Auto-Update Script
# Pulls the latest image from GHCR and recreates the container if updated.
#
# The compose project directory is derived from the script's own location
# (so the script works regardless of where the deployment lives) but can
# be overridden with the COMPOSE_DIR environment variable for unusual
# layouts or CI pipelines.
#
# Resolves symlinks so callers can place a symlink in PATH if they want.

set -e

SCRIPT_PATH="$(readlink -f "${BASH_SOURCE[0]:-$0}")"
SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"
COMPOSE_DIR="${COMPOSE_DIR:-$SCRIPT_DIR}"
IMAGE="${GC_IMAGE:-ghcr.io/callmetechie/gatecontrol:latest}"
LOG="${GC_UPDATE_LOG:-/var/log/gatecontrol-update.log}"

# docker-compose.yml is mandatory in the resolved directory — if it is
# missing, fail loudly instead of quietly running in the wrong place.
if [ ! -f "$COMPOSE_DIR/docker-compose.yml" ]; then
  echo "ERROR: no docker-compose.yml in $COMPOSE_DIR" >&2
  echo "       Set COMPOSE_DIR explicitly or move this script next to docker-compose.yml." >&2
  exit 2
fi

echo "[$(date -Iseconds)] Checking for updates ($COMPOSE_DIR)..." >> "$LOG"

# Pull latest image
PULL_OUTPUT=$(docker pull "$IMAGE" 2>&1)

if echo "$PULL_OUTPUT" | grep -q "Image is up to date"; then
  echo "[$(date -Iseconds)] Already up to date" >> "$LOG"
  exit 0
fi

echo "[$(date -Iseconds)] New image found, updating..." >> "$LOG"
echo "$PULL_OUTPUT" >> "$LOG"

# Recreate container with new image
cd "$COMPOSE_DIR"
docker compose up -d --force-recreate gatecontrol >> "$LOG" 2>&1

echo "[$(date -Iseconds)] Update complete" >> "$LOG"

# Wait for health check
sleep 35
STATUS=$(docker ps --filter name=gatecontrol --format '{{.Status}}')
echo "[$(date -Iseconds)] Container status: $STATUS" >> "$LOG"
