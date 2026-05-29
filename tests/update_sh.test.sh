#!/usr/bin/env bash
# Behavior tests for update.sh via a fake `docker` shim on PATH (no real Docker).
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PASS=0; FAIL=0
ok(){ echo "  ok - $1"; PASS=$((PASS+1)); }
no(){ echo "  NOT OK - $1"; FAIL=$((FAIL+1)); }

newbox(){ # $1=running $2=latest $3=workdir_label [$4=force-recreate-exit, default 0] → exports SBX, CALLS, prepends shim
  local FR="${4:-0}"
  SBX="$(mktemp -d)"; mkdir -p "$SBX/bin" "$SBX/data"
  printf 'services:\n  gatecontrol:\n    image: x\n' >"$SBX/docker-compose.yml"
  CALLS="$SBX/calls"; : >"$CALLS"
  cat >"$SBX/bin/docker" <<EOF
#!/usr/bin/env bash
echo "\$*" >>"$CALLS"
case "\$1" in
  pull) exit 0 ;;
  compose)
    for __a in "\$@"; do
      [ "\$__a" = down ] && exit 0                 # down always ok
      [ "\$__a" = --force-recreate ] && exit $FR    # force-recreate up: baked result (0 ok, 1 = race fail)
    done
    exit 0 ;;                                        # recovery up (no --force-recreate)
  image) [ "\$2" = inspect ] && { echo "$2"; exit 0; } ;;
  inspect) case "\$4" in *Labels*) echo "$3";; *Image*) echo "$1";; *) echo "";; esac; exit 0 ;;
esac
exit 0
EOF
  chmod +x "$SBX/bin/docker"; export PATH="$SBX/bin:$PATH"
}
run(){ GC_DATA_DIR="$SBX/data" GC_UPDATE_LOG="$SBX/log" COMPOSE_DIR="$SBX" GC_CONTAINER=gatecontrol bash "$ROOT/update.sh" >/dev/null 2>&1; echo $?; }

# 1) directory guard → exit 3 (label points elsewhere)
newbox runDIG latDIG /somewhere/else
[ "$(run)" = 3 ] && ok "guard exits 3 on wrong dir" || no "guard exit 3"
rm -rf "$SBX"

# 2) manual + no flag → no-op, no pull, marker mode=manual
newbox runX latX __SELF__; sed -i "s#__SELF__#$SBX#" "$SBX/bin/docker"
printf '{"mode":"manual"}\n' >"$SBX/data/.auto-update-config.json"
run >/dev/null
grep -q '"action":"noop"' "$SBX/data/.auto-update-state.json" && grep -q '"mode":"manual"' "$SBX/data/.auto-update-state.json" && ok "manual no-flag → noop marker" || no "manual noop marker"
grep -q '^pull' "$CALLS" && no "manual no-flag must NOT pull" || ok "manual no-flag does not pull"
rm -rf "$SBX"

# 3) auto branch removes an orphaned pending-update flag (running==latest → noop)
newbox SAME SAME __SELF__; sed -i "s#__SELF__#$SBX#" "$SBX/bin/docker"
printf '{"mode":"auto"}\n' >"$SBX/data/.auto-update-config.json"
echo '{}' >"$SBX/data/pending-update"
run >/dev/null
[ -f "$SBX/data/pending-update" ] && no "auto must remove orphan flag" || ok "auto removes orphan flag"
rm -rf "$SBX"

# 4) recreate race recovery: --force-recreate up fails → clean down+up recovers → updated
newbox OLD NEW __SELF__ 1; sed -i "s#__SELF__#$SBX#" "$SBX/bin/docker"
printf '{"mode":"auto"}\n' >"$SBX/data/.auto-update-config.json"   # auto, running(OLD)!=latest(NEW) → recreate
code="$(run)"
{ [ "$code" = 0 ] && grep -q '"action":"updated"' "$SBX/data/.auto-update-state.json"; } && ok "recreate recovers via down+up → updated" || no "recreate recovery (code=$code)"
grep -q 'compose down' "$SBX/calls" && ok "recovery invoked compose down" || no "recovery did not run down"
rm -rf "$SBX"

echo "update_sh.test.sh: $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
