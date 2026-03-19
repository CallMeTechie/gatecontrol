#!/bin/sh
# WireGuard wrapper for supervisord — ensures wg-quick down is called on stop
_stop() {
  echo "» Stopping WireGuard interface ${GC_WG_INTERFACE}..."
  wg-quick down "$GC_WG_INTERFACE" 2>&1 || true
  exit 0
}

trap _stop TERM INT

echo "» Starting WireGuard interface ${GC_WG_INTERFACE}..."
wg-quick up "$GC_WG_INTERFACE" 2>&1

# Keep the process alive until signalled
sleep infinity &
wait $!
