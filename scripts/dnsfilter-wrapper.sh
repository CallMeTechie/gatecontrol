#!/bin/sh
# Filter service of the DNS protection for VPN devices (supervisord program
# `dnsfilter`, src/services/vpnDnsFilter/service.js).
#
# The service is its own process and only runs while it is wanted: the server
# (src/services/vpnDns.js) creates <dir>/enabled when a plugin with the right
# permissions.vpnDns switched the protection on, and removes it again. Without
# that file this wrapper only sleeps — no node process, no open port.
#
# It is deliberately not a child of the node server: a server restart must not
# take the filter down with it. When the service exits (crash, "Filter-Dienst
# neu starten", switched off) the loop starts it again while the file exists;
# in the meantime the DNS chain (src/services/dnsChain.js) has put dnsmasq back
# on the default upstreams.
DIR="${GC_VPNDNS_DIR:-${GC_DATA_PATH:-/data}/vpn-dns}"
CHILD=

_stop() {
  if [ -n "$CHILD" ]; then
    kill "$CHILD" 2>/dev/null
    wait "$CHILD" 2>/dev/null
  fi
  exit 0
}

trap _stop TERM INT

while true; do
  if [ -f "$DIR/enabled" ]; then
    echo "» Starting the DNS filter service..."
    # The lists live outside the JS heap (8 bytes per entry, at most 24 MB);
    # the heap limit only catches a leak before it hurts the server.
    GC_VPNDNS_DIR="$DIR" node --disable-sigusr1 --max-old-space-size=192 /app/src/services/vpnDnsFilter/service.js &
    CHILD=$!
    wait "$CHILD"
    echo "» DNS filter service exited ($?)"
    CHILD=
    sleep 1
  else
    sleep 2 &
    wait $!
  fi
done
