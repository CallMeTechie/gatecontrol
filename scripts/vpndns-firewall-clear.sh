#!/bin/sh
# Takes away the firewall rules of "Fremden DNS und DoT sperren" (DNS
# protection for VPN devices, src/services/vpnDnsFirewall.js): the four jumps
# and the two chains GC_VPNDNS_NAT / GC_VPNDNS_FWD. Nothing else is touched.
#
# The container shares the host's network: rules it set would outlive it. So
# they are cleared when the container starts (entrypoint.sh — the server sets
# them again once the protection filters) and when WireGuard is stopped
# (wg-wrapper.sh). Missing rules, a missing chain or no iptables are no error.
IFACE="${GC_WG_INTERFACE:-wg0}"

command -v iptables >/dev/null 2>&1 || exit 0

del() {
  t="$1"; c="$2"; shift 2
  n=0
  while [ "$n" -lt 8 ] && iptables -w 5 -t "$t" -D "$c" "$@" 2>/dev/null; do n=$((n + 1)); done
}

drop() {
  iptables -w 5 -t "$1" -F "$2" 2>/dev/null && iptables -w 5 -t "$1" -X "$2" 2>/dev/null
  return 0
}

del nat PREROUTING -i "$IFACE" -p udp -m udp --dport 53 -j GC_VPNDNS_NAT
del nat PREROUTING -i "$IFACE" -p tcp -m tcp --dport 53 -j GC_VPNDNS_NAT
del filter FORWARD -i "$IFACE" -p tcp -m tcp --dport 853 -j GC_VPNDNS_FWD
del filter FORWARD -i "$IFACE" -p udp -m udp --dport 853 -j GC_VPNDNS_FWD
drop nat GC_VPNDNS_NAT
drop filter GC_VPNDNS_FWD
exit 0
