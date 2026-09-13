#!/usr/bin/env bash
# Behavior tests for update.sh via a fake `docker` shim on PATH (no real Docker).
# The shim keeps a tiny image/tag/container model in $SHIM_ST:
#   remote        image ID the registry serves for :latest (what `pull` tags)
#   tag_<ref>     local tag → image ID
#   running       image ID of the gatecontrol container
#   bad           image IDs whose `compose up --wait` fails the health check
#   race          present → every `up --force-recreate` fails (host-net/name race)
#   pullflag      present → `compose up --help` advertises --pull
#   ver_<id>      OCI version label of an image
# shellcheck disable=SC2015  # `cond && ok .. || no ..`: ok/no always return 0
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PASS=0; FAIL=0
ok(){ echo "  ok - $1"; PASS=$((PASS+1)); }
no(){ echo "  NOT OK - $1"; FAIL=$((FAIL+1)); }
LATEST=ghcr.io/callmetechie/gatecontrol:latest
RB=ghcr.io/callmetechie/gatecontrol:rollback
ORIG_PATH="$PATH"

newbox(){ # $1=running $2=remote latest $3=workdir label (__SELF__ = sandbox) [$4=1 → force-recreate race]
  SBX="$(mktemp -d)"; mkdir -p "$SBX/bin" "$SBX/data" "$SBX/st"
  export SHIM_ST="$SBX/st"
  printf 'services:\n  gatecontrol:\n    image: x\n' >"$SBX/docker-compose.yml"
  CALLS="$SHIM_ST/calls"; : >"$CALLS"
  [ -n "$1" ] && echo "$1" >"$SHIM_ST/running"
  echo "$2" >"$SHIM_ST/remote"
  if [ "$3" = __SELF__ ]; then echo "$SBX" >"$SHIM_ST/label"; else echo "$3" >"$SHIM_ST/label"; fi
  [ "${4:-0}" = 1 ] && : >"$SHIM_ST/race"
  cat >"$SBX/bin/docker" <<'EOF'
#!/usr/bin/env bash
S="$SHIM_ST"; IMG=ghcr.io/callmetechie/gatecontrol:latest
echo "$*" >>"$S/calls"
tf(){ printf '%s/tag_%s' "$S" "$(printf '%s' "$1" | tr '/:@' '___')"; }
res(){ case "$1" in sha256:*) echo "$1" ;; *) cat "$(tf "$1")" 2>/dev/null ;; esac; }   # ref → image ID
case "$1" in
  pull) cat "$S/remote" >"$(tf "$2")"; exit 0 ;;
  tag) id="$(res "$2")"; [ -n "$id" ] || exit 1; echo "$id" >"$(tf "$3")"; exit 0 ;;
  image)
    case "$2" in
      inspect) id="$(res "$3")"; [ -n "$id" ] || exit 1
               case "$*" in *Labels*) cat "$S/ver_$id" 2>/dev/null || echo "" ;; *) echo "$id" ;; esac; exit 0 ;;
      *) exit 0 ;;                                    # prune
    esac ;;
  inspect) case "$*" in *Labels*) cat "$S/label" ;; *Image*) cat "$S/running" 2>/dev/null || true ;; esac; exit 0 ;;
  compose)
    case "$*" in *--help*) [ -f "$S/pullflag" ] && echo "      --pull string   Pull image before running"; exit 0 ;; esac
    case "$*" in *" down"*) exit 0 ;; *" guacd") exit 0 ;; esac
    case "$*" in *--force-recreate*) [ -f "$S/race" ] && exit 1 ;; esac
    id="$(res "$IMG")"; echo "$id" >"$S/running"      # up: container now runs whatever :latest is locally
    grep -qx "$id" "$S/bad" 2>/dev/null && exit 1     # --wait: health check failed
    exit 0 ;;
esac
exit 0
EOF
  chmod +x "$SBX/bin/docker"; export PATH="$SBX/bin:$ORIG_PATH"
}
run(){ GC_DATA_DIR="$SBX/data" GC_UPDATE_LOG="$SBX/log" COMPOSE_DIR="$SBX" GC_CONTAINER=gatecontrol TMPDIR="$SBX" bash "$ROOT/update.sh" >/dev/null 2>&1; echo $?; }
st(){ cat "$SBX/data/.auto-update-state.json" 2>/dev/null; }
tagof(){ cat "$SHIM_ST/tag_$(printf '%s' "$1" | tr '/:@' '___')" 2>/dev/null; }
ups(){ grep -c '^compose up -d' "$CALLS" | tr -d ' '; }   # compose up calls (gatecontrol + guacd)
auto(){ printf '{"mode":"auto"}\n' >"$SBX/data/.auto-update-config.json"; }

# 0) vendored server copy must stay byte-identical to the repo-root script
cmp -s "$ROOT/update.sh" "$ROOT/src/services/systemSetup/templates/update.sh" \
  && ok "templates/update.sh == repo-root update.sh" || no "templates/update.sh drifted from repo-root update.sh"

# 1) directory guard → exit 3 (label points elsewhere)
newbox sha256:run sha256:lat /somewhere/else
[ "$(run)" = 3 ] && ok "guard exits 3 on wrong dir" || no "guard exit 3"
rm -rf "$SBX"

# 2) manual + no flag → no-op, no pull, marker mode=manual
newbox sha256:x sha256:y __SELF__
printf '{"mode":"manual"}\n' >"$SBX/data/.auto-update-config.json"
run >/dev/null
st | grep -q '"action":"noop"' && st | grep -q '"mode":"manual"' && ok "manual no-flag → noop marker" || no "manual noop marker"
grep -q '^pull' "$CALLS" && no "manual no-flag must NOT pull" || ok "manual no-flag does not pull"
rm -rf "$SBX"

# 3) auto branch removes an orphaned pending-update flag (running==latest → noop)
newbox sha256:same sha256:same __SELF__; auto
echo '{}' >"$SBX/data/pending-update"
run >/dev/null
[ -f "$SBX/data/pending-update" ] && no "auto must remove orphan flag" || ok "auto removes orphan flag"
rm -rf "$SBX"

# 4) recreate race recovery: --force-recreate up fails → clean down+up recovers → updated
newbox sha256:old sha256:new __SELF__ 1; auto
code="$(run)"
{ [ "$code" = 0 ] && st | grep -q '"action":"updated"'; } && ok "recreate recovers via down+up → updated" || no "recreate recovery (code=$code)"
grep -q 'compose down' "$CALLS" && ok "recovery invoked compose down" || no "recovery did not run down"
rm -rf "$SBX"

# 5) success: previous image pinned as :rollback, prune is dangling-only, stale bad record cleared
newbox sha256:old sha256:new __SELF__; auto
printf 'sha256:older rolled_back 1.0.0\n' >"$SBX/data/.auto-update-bad-image"
code="$(run)"
{ [ "$code" = 0 ] && st | grep -q '"action":"updated"' && [ "$(cat "$SHIM_ST/running")" = sha256:new ]; } \
  && ok "success → updated, runs new image" || no "success path (code=$code)"
grep -qx "tag sha256:old $RB" "$CALLS" && [ "$(tagof "$RB")" = sha256:old ] \
  && ok "previous image tagged $RB before recreate" || no "rollback tag not set"
{ grep -qx 'image prune -f' "$CALLS" && ! grep -q '^image prune.*\(-a\|--all\|--filter\)' "$CALLS"; } \
  && ok "prune is dangling-only (keeps :rollback)" || no "prune args unsafe or missing"
[ -f "$SBX/data/.auto-update-bad-image" ] && no "success must clear the bad-image record" || ok "success clears bad-image record"
rm -rf "$SBX"

# 6) health failure → rollback to the previous image, state rolled_back, bad image remembered
newbox sha256:old sha256:bad __SELF__; auto
echo sha256:bad >"$SHIM_ST/bad"; echo 1.2.3 >"$SHIM_ST/ver_sha256:bad"; : >"$SHIM_ST/pullflag"
code="$(run)"
[ "$code" = 1 ] && ok "rollback run exits 1 (update failed)" || no "rollback exit code ($code)"
[ "$(cat "$SHIM_ST/running")" = sha256:old ] && ok "container runs the previous image again" || no "not rolled back (running=$(cat "$SHIM_ST/running"))"
grep -qx "tag $RB $LATEST" "$CALLS" && ok ":latest re-pointed at the rollback image" || no "no retag of :latest"
grep -q '^compose up .*--pull=never.* gatecontrol$' "$CALLS" && ok "rollback up does not pull" || no "rollback up without --pull=never"
{ st | grep -q '"action":"rolled_back"' && st | grep -q '"bad_image":"sha256:bad"' && st | grep -q '"bad_version":"1.2.3"' && st | grep -q '"ok":false'; } \
  && ok "state rolled_back with bad image + version" || no "rolled_back state: $(st)"
grep -qx 'sha256:bad rolled_back 1.2.3' "$SBX/data/.auto-update-bad-image" && ok "bad image remembered" || no "bad-image record missing"
grep -q '^image prune' "$CALLS" && no "must not prune after a rollback" || ok "no prune after rollback"
grep -q 'compose up -d guacd' "$CALLS" && ok "guacd ensured after rollback" || no "guacd not ensured after rollback"

# 7) next run, :latest still the bad image → skipped (no recreate), state stays rolled_back
before="$(ups)"; code="$(run)"
{ [ "$code" = 0 ] && [ "$(ups)" = "$before" ]; } && ok "same bad :latest → no recreate" || no "bad :latest retried (code=$code)"
st | grep -q '"action":"rolled_back"' && st | grep -q '"bad_image":"sha256:bad"' && ok "skip keeps rolled_back state" || no "skip state: $(st)"
[ "$(cat "$SHIM_ST/running")" = sha256:old ] && ok "skip leaves the previous image running" || no "skip touched the container"

# 8) a newer :latest (different ID) is tried normally
echo sha256:fixed >"$SHIM_ST/remote"
code="$(run)"
{ [ "$code" = 0 ] && [ "$(cat "$SHIM_ST/running")" = sha256:fixed ] && st | grep -q '"action":"updated"'; } \
  && ok "newer :latest → recreated + updated" || no "newer :latest not deployed (code=$code)"
[ "$(tagof "$RB")" = sha256:old ] && ok ":rollback now points at the last good image" || no ":rollback tag wrong ($(tagof "$RB"))"
rm -rf "$SBX"

# 9) rollback itself fails → exit 4, state failed, no retry loop on the next run
newbox sha256:old sha256:bad __SELF__; auto
printf 'sha256:bad\nsha256:old\n' >"$SHIM_ST/bad"
code="$(run)"
[ "$code" = 4 ] && ok "rollback failure exits 4" || no "rollback failure exit ($code)"
{ st | grep -q '"action":"failed"' && st | grep -q '"bad_image":"sha256:bad"'; } && ok "rollback failure → state failed + bad image" || no "rollback-failed state: $(st)"
before="$(ups)"; code="$(run)"
{ [ "$code" = 0 ] && [ "$(ups)" = "$before" ] && st | grep -q '"action":"failed"'; } \
  && ok "after failed rollback: no endless retries" || no "retried after failed rollback (code=$code)"
rm -rf "$SBX"

# 10) manual trigger with a broken image → rolled back; later no-flag runs keep showing it
newbox sha256:old sha256:bad __SELF__
printf '{"mode":"manual"}\n' >"$SBX/data/.auto-update-config.json"
echo '{}' >"$SBX/data/pending-update"; echo sha256:bad >"$SHIM_ST/bad"
code="$(run)"
{ [ "$code" = 1 ] && [ "$(cat "$SHIM_ST/running")" = sha256:old ] && st | grep -q '"action":"rolled_back"' && st | grep -q '"mode":"manual"'; } \
  && ok "manual trigger rolls back" || no "manual rollback (code=$code): $(st)"
run >/dev/null
st | grep -q '"action":"rolled_back"' && ok "manual no-flag keeps rolled_back visible" || no "manual no-flag state: $(st)"
rm -rf "$SBX"

# 11) no running container → nothing to roll back to: plain failure (exit 1), no retag of :latest
newbox "" sha256:bad __SELF__; auto
echo sha256:bad >"$SHIM_ST/bad"
code="$(run)"
{ [ "$code" = 1 ] && st | grep -q '"action":"failed"' && ! grep -q "^tag .* $LATEST" "$CALLS" && ! st | grep -q bad_image; } \
  && ok "no previous image → failed without rollback" || no "no-prev failure (code=$code)"
rm -rf "$SBX"

echo "update_sh.test.sh: $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
