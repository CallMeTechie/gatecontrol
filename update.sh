#!/bin/bash
# GateControl Auto-Update Script
# Pulls latest image from GHCR and recreates container if updated

set -e

COMPOSE_DIR="/root/gatecontrol"
IMAGE="ghcr.io/callmetechie/gatecontrol:latest"
LOG="/var/log/gatecontrol-update.log"

echo "[$(date -Iseconds)] Checking for updates..." >> "$LOG"

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
