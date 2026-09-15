#!/bin/sh
# Restore the last known WireGuard peer endpoints right after `wg-quick up`
# (called by wg-wrapper.sh). src/services/wgEndpoints.js records them while
# the server runs; after a container restart wg0 would otherwise wait until
# every peer re-handshakes on its own (~1 minute of 502 on gateway routes).
#
# Usage: wg-restore-endpoints.sh [file]   (interface from $GC_WG_INTERFACE)
# Each line: <public key> <endpoint> <tunnel ip>. Stale files (> 30 min) and
# malformed lines are ignored; peers no longer on the interface are skipped.
# Values are only ever passed as arguments (never evaluated).

IFACE="${GC_WG_INTERFACE:-wg0}"
FILE="${1:-${GC_WG_ENDPOINTS_FILE:-/data/wireguard/last-endpoints}}"
MAX_AGE="${GC_WG_ENDPOINTS_MAX_AGE:-1800}"

[ -r "$FILE" ] || exit 0
now=$(date +%s)
mtime=$(stat -c %Y "$FILE" 2>/dev/null) || exit 0
age=$((now - mtime))
if [ "$age" -gt "$MAX_AGE" ]; then
  echo "» WireGuard: last endpoints are ${age}s old — not restoring"
  exit 0
fi

# only_chars <value> <tr set>: true when <value> consists of those characters only
only_chars() { [ -z "$(printf '%s' "$1" | tr -d "$2")" ]; }

peers=$(wg show "$IFACE" peers 2>/dev/null) || exit 0
restored=0
while read -r pub ep ip rest; do
  [ -n "$pub" ] || continue
  [ -z "$rest" ] || continue
  [ "${#pub}" -eq 44 ] && only_chars "$pub" 'A-Za-z0-9+/=' || continue
  case "$ep" in
    \[*\]:[0-9]*)
      inner=${ep%%]*}; inner=${inner#[}; port=${ep##*]:}
      only_chars "$inner" '0-9A-Fa-f:.' && only_chars "$port" '0-9' || continue ;;
    *.*.*.*:[0-9]*) only_chars "$ep" '0-9.:' || continue ;;
    *) continue ;;
  esac
  case "$ip" in *.*.*.*) only_chars "$ip" '0-9.' || continue ;; *) continue ;; esac
  printf '%s\n' "$peers" | grep -qxF -- "$pub" || continue
  if wg set "$IFACE" peer "$pub" endpoint "$ep" 2>/dev/null; then
    # One packet towards the peer makes WireGuard start the handshake now.
    ping -c 1 -W 1 "$ip" >/dev/null 2>&1 &
    restored=$((restored + 1))
  fi
done < "$FILE"
echo "» WireGuard: restored ${restored} peer endpoint(s)"
exit 0
