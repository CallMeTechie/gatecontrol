#!/bin/sh
# Caddy launcher for supervisord. Dispatches based on file extension:
# native JSON (no adapter) when entrypoint.sh pre-generated the final
# config from the DB, Caddyfile (--adapter caddyfile) as fallback.
#
# Replaces the previous inline supervisord command so the JSON/Caddyfile
# selection stays readable and doesn't need an escape-soup one-liner.

CONFIG="${GC_CADDY_CONFIG_PATH:-/app/config/Caddyfile}"
LOG=/data/caddy/caddy-stdout.log

if [ ! -f "$CONFIG" ]; then
  echo "caddy-start: config not found at $CONFIG, falling back to Caddyfile" >&2
  CONFIG=/app/config/Caddyfile
fi

case "$CONFIG" in
  *.json)
    caddy run --config "$CONFIG" 2>&1 | tee -a "$LOG"
    ;;
  *)
    caddy run --config "$CONFIG" --adapter caddyfile 2>&1 | tee -a "$LOG"
    ;;
esac
