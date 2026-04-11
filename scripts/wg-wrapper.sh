#!/bin/sh
# WireGuard wrapper for supervisord — ensures wg-quick down is called on stop
WG_UP=0

_stop() {
  echo "» Stopping WireGuard interface ${GC_WG_INTERFACE}..."
  if [ "$WG_UP" -eq 1 ]; then
    wg-quick down "$GC_WG_INTERFACE" 2>&1 || true
  fi
  exit 0
}

trap _stop TERM INT

echo "» Starting WireGuard interface ${GC_WG_INTERFACE}..."
if ! wg-quick up "$GC_WG_INTERFACE" 2>&1 | grep -vi "privatekey"; then
  echo "Failed to start WireGuard"
  exit 1
fi
WG_UP=1

# Restart dnsmasq so it binds to the now-available wg0 interface.
# Alpine dnsmasq 2.91 with bind-dynamic does NOT reliably pick up
# interfaces that appear after its initial bind phase.
if command -v pgrep >/dev/null 2>&1 && pgrep -x dnsmasq >/dev/null 2>&1; then
  echo "» Restarting dnsmasq to bind to ${GC_WG_INTERFACE}..."
  kill $(pgrep -x dnsmasq) 2>/dev/null
  sleep 1
  dnsmasq --keep-in-foreground --conf-file=/app/config/dnsmasq.conf &
fi

# Keep the process alive until signalled
sleep infinity &
wait $!
