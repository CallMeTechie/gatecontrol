#!/bin/sh
# WireGuard wrapper for supervisord — also owns the dnsmasq lifecycle,
# since dnsmasq can only bind 10.8.0.1:53 once wg0 exists. Running it
# as a separate supervisord program raced this script and left the
# program in a permanent FATAL retry loop.
#
# This wrapper SUPERVISES dnsmasq: if dnsmasq exits (crash, or an intentional
# `pkill dnsmasq` from services/dns.js restartDnsmasq), it is restarted so it
# re-reads /app/config/dnsmasq.conf. This is required because dnsmasq does NOT
# re-read upstream `server=`/`add-subnet` lines on SIGHUP — only on a restart —
# so the Pi-hole DNS chain (apply/revert) relies on a real dnsmasq restart.
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

start_dnsmasq() {
  # Any leftover dnsmasq from a prior instance is killed first so the new
  # instance can claim the sockets cleanly.
  if command -v pgrep >/dev/null 2>&1 && pgrep -x dnsmasq >/dev/null 2>&1; then
    kill $(pgrep -x dnsmasq) 2>/dev/null
    sleep 1
  fi
  echo "» Starting dnsmasq bound to lo + ${GC_WG_INTERFACE}..."
  dnsmasq --keep-in-foreground --conf-file=/app/config/dnsmasq.conf &
  DNSMASQ_PID=$!
}

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
start_dnsmasq

# Supervise dnsmasq. The `sleep & wait` keeps the TERM/INT trap responsive
# (an un-waited foreground sleep would delay clean shutdown). When dnsmasq is
# no longer running — because it crashed, or services/dns.js terminated it to
# apply a new config — restart it so the current /app/config/dnsmasq.conf
# (e.g. updated Pi-hole upstreams) takes effect.
FAILS=0
while true; do
  sleep 1 &
  wait $!
  if kill -0 "$DNSMASQ_PID" 2>/dev/null; then
    FAILS=0
    continue
  fi
  FAILS=$((FAILS + 1))
  echo "» dnsmasq is not running (attempt #${FAILS}) — restarting to apply current config..."
  start_dnsmasq
  # Back off on repeated immediate failures (e.g. a persistent bind conflict or
  # broken conf) so we don't tight-loop. Keep retrying rather than giving up —
  # a real restart, or the conflicting listener clearing, lets it recover.
  if [ "$FAILS" -ge 5 ]; then
    echo "» dnsmasq has failed ${FAILS} times — backing off 10s before next check..."
    sleep 10 &
    wait $!
  fi
done
