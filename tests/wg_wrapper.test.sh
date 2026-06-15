#!/usr/bin/env bash
# Behavior test for scripts/wg-wrapper.sh: verifies that the wrapper SUPERVISES
# dnsmasq and respawns it after it exits. This is what services/dns.js
# restartDnsmasq relies on (it terminates dnsmasq so the wrapper restarts it,
# re-reading the config — SIGHUP alone does not reload upstream server= lines).
# Uses fake `wg-quick` / `dnsmasq` shims on PATH; no real WireGuard/dnsmasq.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PASS=0; FAIL=0
ok(){ echo "  ok - $1"; PASS=$((PASS+1)); }
no(){ echo "  NOT OK - $1"; FAIL=$((FAIL+1)); }

SBX="$(mktemp -d)"; mkdir -p "$SBX/bin"
STARTS="$SBX/starts"; : >"$STARTS"

# fake wg-quick: print a non-"privatekey" line so the wrapper's
# `... | grep -vi privatekey` pipeline succeeds (interface "up").
cat >"$SBX/bin/wg-quick" <<EOF
#!/usr/bin/env bash
echo "[#] ip link add \$2 type wireguard"
exit 0
EOF

# fake dnsmasq: record one start, then exit immediately. The wrapper's
# supervise loop should detect the exit and respawn — accumulating starts.
cat >"$SBX/bin/dnsmasq" <<EOF
#!/usr/bin/env bash
echo "start" >>"$STARTS"
exit 0
EOF
chmod +x "$SBX/bin/wg-quick" "$SBX/bin/dnsmasq"

GC_WG_INTERFACE=wg0 timeout 5 env PATH="$SBX/bin:$PATH" sh "$ROOT/scripts/wg-wrapper.sh" >"$SBX/out" 2>&1
rc=$?

COUNT=$(wc -l <"$STARTS" | tr -d ' ')
# timeout sends SIGTERM (124 on kill) — the wrapper traps it and exits 0; either
# is acceptable here. We only care that dnsmasq was (re)started multiple times.
[ "$COUNT" -ge 2 ] && ok "wrapper respawns dnsmasq after it exits (starts=$COUNT)" || no "wrapper did not respawn dnsmasq (starts=$COUNT)"
grep -q "restarting to apply current config" "$SBX/out" && ok "logs restart-on-exit message" || no "missing restart log (out: $(cat "$SBX/out" | tr '\n' '|'))"

rm -rf "$SBX"
echo "wg_wrapper.test.sh: $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
