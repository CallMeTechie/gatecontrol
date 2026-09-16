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
#   tz            TZ the script passed to `date +%H:%M` (fake clock, see $FAKE_NOW)
#   image_sh      content `docker run … cat /app/update.sh` serves (self-update);
#                 missing → the run fails, as with an image without the file
# The script under test is a COPY in the sandbox ($SBX/update.sh): the
# self-update replaces the file it runs from, which must never be the repo copy.
# shellcheck disable=SC2015  # `cond && ok .. || no ..`: ok/no always return 0
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PASS=0; FAIL=0
ok(){ echo "  ok - $1"; PASS=$((PASS+1)); }
no(){ echo "  NOT OK - $1"; FAIL=$((FAIL+1)); }
LATEST=ghcr.io/callmetechie/gatecontrol:latest
RB=ghcr.io/callmetechie/gatecontrol:rollback
ORIG_PATH="$PATH"
REAL_DATE="$(command -v date)"

newbox(){ # $1=running $2=remote latest $3=workdir label (__SELF__ = sandbox) [$4=1 → force-recreate race]
  SBX="$(mktemp -d)"; mkdir -p "$SBX/bin" "$SBX/data" "$SBX/st"
  export SHIM_ST="$SBX/st"
  printf 'services:\n  gatecontrol:\n    image: x\n' >"$SBX/docker-compose.yml"
  CALLS="$SHIM_ST/calls"; : >"$CALLS"
  [ -n "$1" ] && echo "$1" >"$SHIM_ST/running"
  echo "$2" >"$SHIM_ST/remote"
  if [ "$3" = __SELF__ ]; then echo "$SBX" >"$SHIM_ST/label"; else echo "$3" >"$SHIM_ST/label"; fi
  [ "${4:-0}" = 1 ] && : >"$SHIM_ST/race"
  cp "$ROOT/update.sh" "$SBX/update.sh"; chmod 755 "$SBX/update.sh"
  cat >"$SBX/bin/docker" <<'EOF'
#!/usr/bin/env bash
S="$SHIM_ST"; IMG=ghcr.io/callmetechie/gatecontrol:latest
echo "$*" >>"$S/calls"
tf(){ printf '%s/tag_%s' "$S" "$(printf '%s' "$1" | tr '/:@' '___')"; }
res(){ case "$1" in sha256:*) echo "$1" ;; *) cat "$(tf "$1")" 2>/dev/null ;; esac; }   # ref → image ID
case "$1" in
  run) [ -f "$S/image_sh" ] || exit 1; cat "$S/image_sh"; exit 0 ;;   # --entrypoint sh <img> -c 'cat /app/update.sh'
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
  chmod +x "$SBX/bin/docker"
  # Fake clock for the maintenance window: `date +%H:%M` answers $FAKE_NOW and
  # records the TZ it was asked for; every other date call is the real one.
  cat >"$SBX/bin/date" <<DATESHIM
#!/usr/bin/env bash
if [ "\${1:-}" = "+%H:%M" ] && [ -n "\${FAKE_NOW:-}" ]; then printf '%s' "\${TZ:-}" >"\$SHIM_ST/tz"; echo "\$FAKE_NOW"; exit 0; fi
exec $REAL_DATE "\$@"
DATESHIM
  chmod +x "$SBX/bin/date"; export PATH="$SBX/bin:$ORIG_PATH"
}
run(){ GC_DATA_DIR="$SBX/data" GC_UPDATE_LOG="$SBX/log" COMPOSE_DIR="$SBX" GC_CONTAINER=gatecontrol TMPDIR="$SBX" bash "$SBX/update.sh" >/dev/null 2>&1; echo $?; }
st(){ cat "$SBX/data/.auto-update-state.json" 2>/dev/null; }
tagof(){ cat "$SHIM_ST/tag_$(printf '%s' "$1" | tr '/:@' '___')" 2>/dev/null; }
ups(){ grep -c '^compose up -d' "$CALLS" | tr -d ' '; }   # compose up calls (gatecontrol + guacd)
auto(){ printf '{"mode":"auto"}\n' >"$SBX/data/.auto-update-config.json"; }
win(){ # $1=mode $2=start $3=end [$4=tz] — config as the server writes it (window only when enabled)
  printf '{"mode":"%s","window":{"start":"%s","end":"%s","tz":"%s"}}\n' "$1" "$2" "$3" "${4:-Europe/Berlin}" >"$SBX/data/.auto-update-config.json"
}

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

# 12) maintenance window: update available outside the window → waiting_window, no recreate, exit 0
newbox sha256:old sha256:new __SELF__; win auto 03:00 05:00
export FAKE_NOW=12:00
code="$(run)"
{ [ "$code" = 0 ] && [ "$(ups)" = 0 ] && [ "$(cat "$SHIM_ST/running")" = sha256:old ]; } \
  && ok "outside window → no recreate, exit 0" || no "outside window recreated (code=$code, ups=$(ups))"
{ st | grep -q '"action":"waiting_window"' && st | grep -q '"mode":"auto"' && st | grep -q '"ok":true'; } \
  && ok "outside window → state waiting_window" || no "waiting_window state: $(st)"
grep -q 'outside maintenance window' "$SBX/log" && ok "log says 'outside maintenance window'" || no "no window log line"
[ "$(cat "$SHIM_ST/tz" 2>/dev/null)" = Europe/Berlin ] && ok "window time read in the configured TZ" || no "TZ passed to date: '$(cat "$SHIM_ST/tz" 2>/dev/null)'"
grep -q '^pull' "$CALLS" && ok "image is pulled outside the window (deploy later is fast)" || no "no pull outside window"

# 13) same box, clock inside the window → deployed
export FAKE_NOW=04:59
code="$(run)"
{ [ "$code" = 0 ] && [ "$(cat "$SHIM_ST/running")" = sha256:new ] && st | grep -q '"action":"updated"'; } \
  && ok "inside window → updated" || no "inside window (code=$code): $(st)"
rm -rf "$SBX"

# 14) window over midnight (23:00-02:00): start inclusive, end exclusive
for c in "22:59 waiting_window" "23:00 updated" "01:30 updated" "02:00 waiting_window"; do
  now="${c% *}"; want="${c#* }"
  newbox sha256:old sha256:new __SELF__; win auto 23:00 02:00
  export FAKE_NOW="$now"; run >/dev/null
  st | grep -q "\"action\":\"$want\"" && ok "midnight window at $now → $want" || no "midnight window at $now: $(st)"
  rm -rf "$SBX"
done

# 15) "Update now" (flag) in auto mode ignores the window; flag is consumed
newbox sha256:old sha256:new __SELF__; win auto 03:00 05:00
echo '{}' >"$SBX/data/pending-update"; export FAKE_NOW=12:00
code="$(run)"
{ [ "$code" = 0 ] && [ "$(cat "$SHIM_ST/running")" = sha256:new ] && st | grep -q '"action":"updated"'; } \
  && ok "flag deploys outside the window" || no "flag outside window (code=$code): $(st)"
[ -f "$SBX/data/pending-update" ] && no "flag not consumed" || ok "flag consumed"
rm -rf "$SBX"

# 16) nothing to update outside the window → noop (waiting_window only when an update waits)
newbox sha256:same sha256:same __SELF__; win auto 03:00 05:00
export FAKE_NOW=12:00; run >/dev/null
st | grep -q '"action":"noop"' && ok "up to date outside window → noop" || no "up-to-date outside window: $(st)"
rm -rf "$SBX"

# 17) manual mode: the window does not apply, a manual trigger deploys at any time
newbox sha256:old sha256:new __SELF__; win manual 03:00 05:00
echo '{}' >"$SBX/data/pending-update"; export FAKE_NOW=12:00
code="$(run)"
{ [ "$code" = 0 ] && [ "$(cat "$SHIM_ST/running")" = sha256:new ] && st | grep -q '"mode":"manual"' && st | grep -q '"action":"updated"'; } \
  && ok "manual trigger ignores the window" || no "manual + window (code=$code): $(st)"
rm -rf "$SBX"

# 18) an invalid window (bad time / injected or odd TZ) is ignored → update as before, TZ never used
for bad in '25:00|05:00|Europe/Berlin' '03:00|05:00|$(touch /tmp/gc-x)' '03:00|05:00|../../etc/passwd'; do
  IFS='|' read -r b1 b2 b3 <<<"$bad"
  newbox sha256:old sha256:new __SELF__; win auto "$b1" "$b2" "$b3"
  export FAKE_NOW=12:00; run >/dev/null
  { st | grep -q '"action":"updated"' && [ ! -f "$SHIM_ST/tz" ] && grep -q 'invalid maintenance window' "$SBX/log"; } \
    && ok "invalid window '$bad' ignored" || no "invalid window '$bad': $(st)"
  rm -rf "$SBX"
done
[ -e /tmp/gc-x ] && no "TZ value was executed" || ok "TZ value never executed"

# 19) known-bad :latest outside the window keeps the rollback state (loop guard first)
newbox sha256:old sha256:bad __SELF__; win auto 03:00 05:00
printf 'sha256:bad rolled_back 1.2.3\n' >"$SBX/data/.auto-update-bad-image"
export FAKE_NOW=12:00; run >/dev/null
st | grep -q '"action":"rolled_back"' && ok "known-bad image outside window stays rolled_back" || no "bad+window: $(st)"
rm -rf "$SBX"
unset FAKE_NOW

# ── update.sh updates itself (docs/feature-next-package.md §S2.2) ──────────
# The image copy is read with `docker run --rm --entrypoint sh <img> -c
# 'cat /app/update.sh'` and replaces the host copy only after a successful
# update, only on a real difference, only when it parses.
selfbox(){ # $1=content of /app/update.sh in the image ('' = image has no file)
  newbox sha256:old sha256:new __SELF__; auto
  [ -n "$1" ] && printf '%s' "$1" >"$SHIM_ST/image_sh"
  BEFORE="$(cat "$SBX/update.sh")"
}
SELFV="$(sed -n 's/^# gc-update-sh: \([0-9][0-9]*\)$/\1/p' "$ROOT/update.sh" | head -n1)"

# 20) the script carries a version marker and reports it in the state marker
[ -n "$SELFV" ] && ok "update.sh carries a '# gc-update-sh: <n>' marker (v$SELFV)" || no "no gc-update-sh marker"
cmp -s "$ROOT/update.sh" "$ROOT/src/services/systemSetup/templates/update.sh" \
  && ok "both copies share the marker" || no "copies differ"

# 21) identical content → nothing replaced, no .bak, marker carries the version
selfbox ''
cp "$SBX/update.sh" "$SHIM_ST/image_sh"
code="$(run)"
{ [ "$code" = 0 ] && [ "$(cat "$SBX/update.sh")" = "$BEFORE" ] && [ ! -f "$SBX/update.sh.bak" ]; } \
  && ok "identical update.sh → not replaced, no backup" || no "identical self-update (code=$code)"
grep -q 'already the version from the image' "$SBX/log" && ok "log says it is already current" || no "no 'already the version' log line"
st | grep -q "\"update_sh\":$SELFV" && ok "state marker carries update_sh:$SELFV" || no "state marker without update_sh: $(st)"
rm -rf "$SBX"

# 22) new content → replaced atomically, mode 755, old version kept as .bak
selfbox '#!/bin/bash
# gc-update-sh: 999
echo new
'
code="$(run)"
{ [ "$code" = 0 ] && grep -q '^echo new$' "$SBX/update.sh"; } && ok "different update.sh → replaced" || no "not replaced (code=$code)"
[ "$(stat -c %a "$SBX/update.sh")" = 755 ] && ok "replacement is mode 755" || no "mode is $(stat -c %a "$SBX/update.sh")"
{ [ -f "$SBX/update.sh.bak" ] && [ "$(cat "$SBX/update.sh.bak")" = "$BEFORE" ]; } \
  && ok "old version kept as update.sh.bak" || no "no/incorrect update.sh.bak"
grep -q "update.sh replaced: v$SELFV → v999" "$SBX/log" && ok "log names both versions" || no "no replace log line"
st | grep -q '"update_sh":999' && ok "state marker reports the new version" || no "state marker after replace: $(st)"
# No re-exec: the OLD script finished this run — its state marker is there and
# the trivial replacement (which writes nothing) never ran.
st | grep -q '"action":"updated"' && ok "no re-exec: the running script finished the run" || no "state after replace: $(st)"
ls "$SBX"/update.sh.new.* >/dev/null 2>&1 && no "temp file left behind" || ok "no temp file left behind"
rm -rf "$SBX"

# 23) syntax error in the image copy → not replaced, warning, no .bak
selfbox '#!/bin/bash
# gc-update-sh: 999
if [ 1 = 1 ; then echo broken
'
code="$(run)"
{ [ "$code" = 0 ] && [ "$(cat "$SBX/update.sh")" = "$BEFORE" ]; } && ok "broken update.sh → not replaced" || no "broken file replaced (code=$code)"
grep -q 'syntax error' "$SBX/log" && ok "log warns about the syntax error" || no "no syntax-error warning"
[ -f "$SBX/update.sh.bak" ] && no "no backup when nothing is replaced" || ok "no backup when nothing is replaced"
ls "$SBX"/update.sh.new.* >/dev/null 2>&1 && no "broken temp file left behind" || ok "broken temp file removed"
rm -rf "$SBX"

# 24) GC_UPDATE_SH_SELFUPDATE=0 → nothing happens at all
selfbox '#!/bin/bash
# gc-update-sh: 999
echo new
'
code="$(GC_UPDATE_SH_SELFUPDATE=0 GC_DATA_DIR="$SBX/data" GC_UPDATE_LOG="$SBX/log" COMPOSE_DIR="$SBX" GC_CONTAINER=gatecontrol TMPDIR="$SBX" bash "$SBX/update.sh" >/dev/null 2>&1; echo $?)"
{ [ "$code" = 0 ] && [ "$(cat "$SBX/update.sh")" = "$BEFORE" ] && [ ! -f "$SBX/update.sh.bak" ]; } \
  && ok "GC_UPDATE_SH_SELFUPDATE=0 → untouched" || no "disabled self-update ran (code=$code)"
grep -q 'self-update disabled' "$SBX/log" && ok "log says the self-update is off" || no "no 'disabled' log line"
grep -q '^run ' "$CALLS" && no "disabled self-update must not read the image" || ok "disabled self-update does not read the image"
rm -rf "$SBX"

# 25) image without /app/update.sh → warning, host copy untouched
selfbox ''
code="$(run)"
{ [ "$code" = 0 ] && [ "$(cat "$SBX/update.sh")" = "$BEFORE" ]; } && ok "unreadable image copy → untouched" || no "unreadable image copy (code=$code)"
grep -q 'could not read /app/update.sh' "$SBX/log" && ok "log warns that the image copy is unreadable" || no "no unreadable warning"
rm -rf "$SBX"

# 26) no self-update without a successful update (rollback run)
newbox sha256:old sha256:bad __SELF__; auto
printf '#!/bin/bash\n# gc-update-sh: 999\necho new\n' >"$SHIM_ST/image_sh"
BEFORE="$(cat "$SBX/update.sh")"; echo sha256:bad >"$SHIM_ST/bad"
run >/dev/null
[ "$(cat "$SBX/update.sh")" = "$BEFORE" ] && ok "no self-update after a rollback" || no "self-update ran after a rollback"
rm -rf "$SBX"

echo "update_sh.test.sh: $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
