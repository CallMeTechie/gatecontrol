#!/bin/sh
# Caddy launcher for supervisord. Dispatches based on file extension:
# native JSON (no adapter) when entrypoint.sh pre-generated the final
# config from the DB, Caddyfile (--adapter caddyfile) as fallback.
#
# Replaces the previous inline supervisord command so the JSON/Caddyfile
# selection stays readable and doesn't need an escape-soup one-liner.
#
# stdout/stderr stream straight through supervisord, which forwards to
# the container's stdout where Docker's log driver applies rotation.
# We deliberately do NOT tee into a file under /data — that produced an
# unbounded duplicate of every log line (observed: 678 MB and growing
# in a 4-day-old container) without rotation.

CONFIG="${GC_CADDY_CONFIG_PATH:-/app/config/Caddyfile}"

if [ ! -f "$CONFIG" ]; then
  echo "caddy-start: config not found at $CONFIG, falling back to Caddyfile" >&2
  CONFIG=/app/config/Caddyfile
fi

case "$CONFIG" in
  *.json)
    exec caddy run --config "$CONFIG"
    ;;
  *)
    exec caddy run --config "$CONFIG" --adapter caddyfile
    ;;
esac
