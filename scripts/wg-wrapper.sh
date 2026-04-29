#!/bin/sh
# WireGuard wrapper for supervisord — also owns the dnsmasq lifecycle,
# since dnsmasq can only bind 10.8.0.1:53 once wg0 exists. Running it
# as a separate supervisord program raced this script and left the
# program in a permanent FATAL retry loop.
WG_UP=0
DNSMASQ_PID=

_stop() {
  echo "» Stopping WireGuard interface ${GC_WG_INTERFACE}..."
  if [ -n "$DNSMASQ_PID" ]; then
    kill "$DNSMASQ_PID" 2>/dev/null
  fi
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

# wg0 is now up — start dnsmasq so it can bind 10.8.0.1:53 (in addition
# to 127.0.0.1:53 via interface=lo). Alpine dnsmasq 2.91 with
# bind-dynamic does NOT reliably pick up interfaces that appear after
# its initial bind phase, which is why dnsmasq starts here, not earlier.
# Any leftover dnsmasq from a botched prior run is killed first so the
# new instance can claim the sockets cleanly.
if command -v pgrep >/dev/null 2>&1 && pgrep -x dnsmasq >/dev/null 2>&1; then
  echo "» Killing leftover dnsmasq before starting fresh instance..."
  kill $(pgrep -x dnsmasq) 2>/dev/null
  sleep 1
fi

echo "» Starting dnsmasq bound to lo + ${GC_WG_INTERFACE}..."
dnsmasq --keep-in-foreground --conf-file=/app/config/dnsmasq.conf &
DNSMASQ_PID=$!

# Keep the process alive until signalled
sleep infinity &
wait $!
