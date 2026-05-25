# Gateway Auto-Update Setup Bundle — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Self-service "Auto-Update einrichten" in the gateway detail view — tailored downloadable setup **script** + **ZIP**, plus a guide, with a note that the auto-update button only works after this one-time host setup.

**Architecture:** Two GET endpoints under `/api/v1/gateways` emit a tailored `setup.sh` (text) and a store-only ZIP (built by a first-party in-repo zip writer) from vendored templates; the detail-view card links to them. Server-only; no host action server-side.

**Tech Stack:** Node 20, Express, better-sqlite3, Nunjucks, `node:test`. Spec: `docs/superpowers/specs/2026-05-25-gateway-autoupdate-setup-bundle-design.md` (v3).

**Branch:** `feat/gateway-setup-bundle` (already created off master 1.68.0). One PR.

---

## File Structure
- `src/utils/zip.js` (new) — store-only zip writer + own CRC-32.
- `src/services/gatewaySetup/templates/` (new) — `setup.sh`, `update.sh` (vendored), `systemd/gatecontrol-gateway-update.{service,path}` (vendored), `docker-compose.state-snippet.yml`, `README.md`, `VENDORED.md`.
- `src/services/gatewaySetup.js` (new) — render tailored script + bundle file list.
- `src/routes/api/gateways.js` (modify) — two GET endpoints.
- `public/js/gateways.js` (modify) — "Auto-Update einrichten" card.
- `public/css/{app,pro}.css` (modify) — `.gw-fleet .gw-setup` styling (details/summary, actions row, `.done` secondary).
- `src/i18n/{en,de}.json` + `templates/{default,pro}/layout.njk` (modify) — i18n + GC.t.
- `scripts/check-vendored-templates.js` (new) + `.github/workflows/test.yml` (modify) — drift check + `unzip -t`.
- `docs/feature-gateway-autoupdate-setup-bundle.md` (new).
- Tests: `tests/zip.test.js`, `tests/gateway_setup_bundle.test.js`.

---

## Task T1: store-only ZIP writer

**Files:** Create `src/utils/zip.js`, `tests/zip.test.js`

- [ ] **Step 1 — failing test** (`tests/zip.test.js`). Independent oracle = well-known CRC-32 check constants (version-independent; do NOT depend on `zlib.crc32`):
```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createZip, crc32 } = require('../src/utils/zip');

test('crc32 matches known reference values', () => {
  assert.equal(crc32(Buffer.from('')), 0x00000000);
  assert.equal(crc32(Buffer.from('123456789')), 0xCBF43926); // canonical CRC-32 check
  assert.equal(crc32(Buffer.from('hello')), 0x3610A686);
});

test('createZip produces a structurally valid store-only archive', () => {
  const files = [{ name: 'a.txt', data: Buffer.from('hello') }, { name: 'empty', data: Buffer.from('') }];
  const z = createZip(files);
  const eocd = z.length - 22;                              // EOCD (22 bytes)
  assert.equal(z.readUInt32LE(eocd), 0x06054b50);
  assert.equal(z.readUInt16LE(eocd + 10), 2);             // total entries
  const cdSize = z.readUInt32LE(eocd + 12);
  const cdOff = z.readUInt32LE(eocd + 16);
  assert.equal(cdOff + cdSize, eocd);                     // central dir sits right before EOCD
  assert.equal(z.readUInt32LE(0), 0x04034b50);            // first local header
  assert.equal(z.readUInt16LE(8), 0);                     // method = store
  assert.equal(z.readUInt32LE(14), crc32(Buffer.from('hello')));
  assert.equal(z.readUInt32LE(18), 5);                    // compressed size = stored size
  assert.equal(z.readUInt32LE(22), 5);
  assert.equal(z.readUInt32LE(cdOff), 0x02014b50);        // central dir
  assert.equal(z.readUInt32LE(cdOff + 42), 0);            // offset of first local header
});
```

- [ ] **Step 2 — run, expect fail** (module missing): `NODE_ENV=test node --test tests/zip.test.js`.

- [ ] **Step 3 — implement** `src/utils/zip.js`:
```js
'use strict';
// First-party store-only (method 0) ZIP writer — no dependency. Computes its own CRC-32
// (so tests can validate against an independent oracle). Suitable for small text bundles.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = (CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8)) >>> 0;
  return (c ^ 0xFFFFFFFF) >>> 0;
}

const DOS_TIME = 0;       // fixed
const DOS_DATE = 0x21;    // 1980-01-01 (minimal valid)

function createZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const dataBuf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    const crc = crc32(dataBuf);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);            // version needed
    lh.writeUInt16LE(0, 6);             // gp flag
    lh.writeUInt16LE(0, 8);             // method = store
    lh.writeUInt16LE(DOS_TIME, 10);
    lh.writeUInt16LE(DOS_DATE, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(dataBuf.length, 18);
    lh.writeUInt32LE(dataBuf.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, nameBuf, dataBuf);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);            // version made by
    ch.writeUInt16LE(20, 6);            // version needed
    ch.writeUInt16LE(0, 8);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(DOS_TIME, 12);
    ch.writeUInt16LE(DOS_DATE, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(dataBuf.length, 20);
    ch.writeUInt32LE(dataBuf.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);            // extra
    ch.writeUInt16LE(0, 32);            // comment
    ch.writeUInt16LE(0, 34);            // disk
    ch.writeUInt16LE(0, 36);            // internal attrs
    ch.writeUInt32LE(0, 38);           // external attrs
    ch.writeUInt32LE(offset, 42);      // local header offset
    central.push(ch, nameBuf);
    offset += lh.length + nameBuf.length + dataBuf.length;
  }
  const localPart = Buffer.concat(locals);
  const centralPart = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralPart.length, 12);
  eocd.writeUInt32LE(localPart.length, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([localPart, centralPart, eocd]);
}

module.exports = { createZip, crc32 };
```

- [ ] **Step 4 — run, expect pass.** `NODE_ENV=test node --test tests/zip.test.js`.
- [ ] **Step 5 — commit:** `git commit -am "feat(util): store-only zip writer (first-party, own CRC-32)"`

## Task T2: vendored templates + setup.sh + manifest

**Files:** Create the `src/services/gatewaySetup/templates/` tree.

- [ ] **Step 1 — vendor (byte-identical) from gatecontrol-gateway@v1.10.1:** copy verbatim (no edits, no header):
  - `gatecontrol-gateway:deploy/update.sh` → `templates/update.sh`
  - `gatecontrol-gateway:deploy/systemd/gatecontrol-gateway-update.service` → `templates/systemd/…service`
  - `gatecontrol-gateway:deploy/systemd/gatecontrol-gateway-update.path` → `templates/systemd/…path`
  Source the exact bytes from `/root/gatecontrol-gateway` (tag `v1.10.1`): `cp /root/gatecontrol-gateway/deploy/update.sh src/services/gatewaySetup/templates/update.sh` etc.

- [ ] **Step 2 — `templates/VENDORED.md`:**
```markdown
# Vendored from gatecontrol-gateway

Byte-identical copies of `gatecontrol-gateway` `deploy/` at the tag below. The CI drift check
(scripts/check-vendored-templates.js) fails the build if they diverge.

- tag: v1.10.1
- update.sh ← deploy/update.sh
- systemd/gatecontrol-gateway-update.service ← deploy/systemd/gatecontrol-gateway-update.service
- systemd/gatecontrol-gateway-update.path ← deploy/systemd/gatecontrol-gateway-update.path
```

- [ ] **Step 3 — `templates/docker-compose.state-snippet.yml`:**
```yaml
# Add this to your gateway service's volumes: (keep the existing config:ro line)
    volumes:
      - ./config:/config:ro
      - ./gateway-state:/state
```

- [ ] **Step 4 — `templates/setup.sh`** (our orchestrator; POSIX sh; placeholders `{{GATEWAY_NAME}}`, `{{GATEWAY_IMAGE}}`, `{{DEFAULT_COMPOSE_DIR}}`, `{{SERVICE}}`, `{{UPDATE_SH}}` substituted at render time). Full content:
```sh
#!/bin/sh
# GateControl Gateway — auto-update host setup (run as root on the gateway host).
# Adds the /state volume, installs update.sh, recreates the container (detached,
# health-gated, auto-rollback), and wires the periodic trigger. Re-runnable.
set -u
GATEWAY_NAME='{{GATEWAY_NAME}}'
GATEWAY_IMAGE='{{GATEWAY_IMAGE}}'
MIN_VERSION='1.10.0'
DEFAULT_COMPOSE_DIR='{{DEFAULT_COMPOSE_DIR}}'
SERVICE_DEFAULT='{{SERVICE}}'
export PATH="/usr/local/bin:$PATH"

say(){ echo "» $*"; }
die(){ echo "ERROR: $*" >&2; exit 1; }
ver_ge(){ awk -v a="$1" -v b="$2" 'BEGIN{split(a,x,".");split(b,y,".");for(i=1;i<=3;i++){xi=x[i]+0;yi=y[i]+0;if(xi>yi){print 1;exit}if(xi<yi){print 0;exit}}print 1}'; }

[ "$(id -u)" = 0 ] || { say "re-exec via sudo…"; exec sudo -E sh "$0" "$@"; }

if docker compose version >/dev/null 2>&1; then DC="docker compose";
elif command -v docker-compose >/dev/null 2>&1; then DC="docker-compose";
else die "Docker Compose (v2 plugin or docker-compose) required"; fi

# Resolve compose dir + service: explicit args win, else auto-detect by image substring.
COMPOSE_DIR=""; SERVICE=""; CID=""
if [ -n "${1:-}" ]; then COMPOSE_DIR="$1"; SERVICE="${2:-$SERVICE_DEFAULT}"; fi
if [ -z "$COMPOSE_DIR" ]; then
  matches=$(docker ps --format '{{.ID}} {{.Image}}' | awk 'tolower($2) ~ /gatecontrol-gateway/ {print $1}')
  n=$(printf '%s\n' "$matches" | grep -c . 2>/dev/null || echo 0)
  [ "$n" = 1 ] || die "found $n gateway containers — pass the compose dir explicitly: sh setup.sh /path/to/compose-dir [service]"
  CID="$matches"
  COMPOSE_DIR=$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$CID")
  SERVICE=$(docker inspect --format '{{index .Config.Labels "com.docker.compose.service"}}' "$CID")
fi
[ -n "$SERVICE" ] || SERVICE="$SERVICE_DEFAULT"
CF="$COMPOSE_DIR/docker-compose.yml"
[ -f "$CF" ] || die "no docker-compose.yml in $COMPOSE_DIR"
$DC -f "$CF" config --services 2>/dev/null | grep -qx "$SERVICE" || die "service '$SERVICE' not found in $CF"
[ -n "$CID" ] || CID=$($DC -f "$CF" ps -q "$SERVICE" 2>/dev/null | head -1)
say "compose: $CF (service: $SERVICE)"

STATE="$COMPOSE_DIR/gateway-state"
mkdir -p "$STATE"

cat > "$COMPOSE_DIR/update.sh" <<'__UPDATE_SH_EOF__'
{{UPDATE_SH}}
__UPDATE_SH_EOF__
chmod +x "$COMPOSE_DIR/update.sh"
say "wrote $COMPOSE_DIR/update.sh"

# Skip the recreate only if already on a current (>= MIN) image with the mount + healthy.
need_recreate=1
if grep -q 'gateway-state:/state' "$CF" && [ -n "$CID" ]; then
  hs=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$CID" 2>/dev/null)
  ver=$(docker exec "$CID" node -p "require('./package.json').version" 2>/dev/null)
  if { [ "$hs" = healthy ] || [ "$hs" = none ]; } && [ -n "$ver" ] && [ "$(ver_ge "$ver" "$MIN_VERSION")" = 1 ]; then
    need_recreate=0
  fi
fi

if [ "$need_recreate" = 0 ]; then
  say "already set up (mount present, version $ver, healthy) — no recreate needed"
else
  cp "$CF" "$CF.bak-$(date +%s)"
  if ! grep -q 'gateway-state:/state' "$CF"; then
    awk -v svc="$SERVICE" '
      function lead(s){ if(match(s,/[^ ]/)) return substr(s,1,RSTART-1); return "" }
      { print }
      ($0 ~ /^  [A-Za-z0-9._-]+:[ \t]*$/){ h=$0; sub(/^  /,"",h); sub(/:[ \t]*$/,"",h); cur=h }
      (cur==svc && !done && $0 ~ /\.\/config:\/config:ro/){ print lead($0) "- ./gateway-state:/state"; done=1 }
      END{ if(!done) exit 3 }
    ' "$CF" > "$CF.new" || { rm -f "$CF.new"; die "could not find the config volume in service $SERVICE (long-form volumes?). Edit manually — see docker-compose.state-snippet.yml"; }
    mv "$CF.new" "$CF"
  fi
  grep -q 'gateway-state:/state' "$CF" || die "mount insert failed"
  $DC -f "$CF" config >/dev/null 2>&1 || { for b in "$CF".bak-*; do cp "$b" "$CF"; done; die "compose no longer parses — restored backup; edit manually"; }
  say "added /state mount; launching recreate in background (detached + auto-rollback)…"
  say "⚠ Your SSH may drop if it routes through this gateway. Reconnect and check $STATE/setup-result.txt"
  OLD_DIGEST=$(docker inspect --format '{{.Image}}' "$CID" 2>/dev/null)
  nohup sh -c '
    CF="'"$CF"'"; DC="'"$DC"'"; SVC="'"$SERVICE"'"; STATE="'"$STATE"'"; OLD="'"$OLD_DIGEST"'"; CDIR="'"$COMPOSE_DIR"'"
    $DC -f "$CF" pull "$SVC" >>"$STATE/setup.log" 2>&1
    $DC -f "$CF" up -d --force-recreate "$SVC" >>"$STATE/setup.log" 2>&1
    ok=0; i=0
    while [ $i -lt 24 ]; do
      c=$($DC -f "$CF" ps -q "$SVC" 2>/dev/null | head -1)
      if [ -n "$c" ]; then
        h=$(docker inspect --format "{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}" "$c" 2>/dev/null)
        [ "$h" = healthy ] && { ok=1; break; }
        [ "$h" = none ] && { ok=1; break; }
      fi
      i=$((i+1)); sleep 5
    done
    if [ "$ok" = 1 ]; then echo "OK recreated + healthy at $(date -Iseconds)" > "$STATE/setup-result.txt";
    else
      [ -n "$OLD" ] && { printf "services:\n  %s:\n    image: %s\n" "$SVC" "$OLD" > "$CDIR/docker-compose.rollback.yml";
        $DC -f "$CF" -f "$CDIR/docker-compose.rollback.yml" up -d --force-recreate "$SVC" >>"$STATE/setup.log" 2>&1; }
      echo "ROLLBACK (new image unhealthy) at $(date -Iseconds)" > "$STATE/setup-result.txt"
    fi
  ' >/dev/null 2>&1 </dev/null &
fi

# Wire the periodic trigger
DSM_CMD="PATH=/usr/local/bin:\$PATH GATEWAY_STATE_DIR=$STATE $COMPOSE_DIR/update.sh"
if [ -f /etc/synoinfo.conf ] || command -v synoschedtask >/dev/null 2>&1; then
  cat <<EOF

=== Synology: create a DSM Task Scheduler entry (one-time) ===
Control Panel → Task Scheduler → Create → Scheduled Task → User-defined script
  User:     root
  Schedule: daily, repeat every 1 minute
  Command:  $DSM_CMD
EOF
elif command -v systemctl >/dev/null 2>&1; then
  cat > /etc/systemd/system/gatecontrol-gateway-update.service <<EOF
[Unit]
Description=GateControl Gateway self-update (oneshot)
[Service]
Type=oneshot
Environment=GATEWAY_STATE_DIR=$STATE
ExecStart=$COMPOSE_DIR/update.sh
EOF
  cat > /etc/systemd/system/gatecontrol-gateway-update.path <<EOF
[Unit]
Description=Watch for GateControl Gateway pending-update flag
[Path]
PathExists=$STATE/pending-update
Unit=gatecontrol-gateway-update.service
[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload && systemctl enable --now gatecontrol-gateway-update.path
  say "installed + enabled systemd path unit"
else
  say "No DSM/systemd detected — run this every minute via cron: $DSM_CMD"
fi
say "Done. Once the gateway reports state_dir_writable, the Update button activates in GateControl."
```
*(The bundle also ships the vendored standalone systemd units for reference; the DSM `GATEWAY_STATE_DIR`/`PATH` match the production-verified nas3 command.)*

- [ ] **Step 5 — `templates/README.md`** — Synology (DSM) + Linux (systemd) step-by-step (mirror setup.sh + the manual fallback using `docker-compose.state-snippet.yml`). Uses the same `{{…}}` placeholders.

- [ ] **Step 6 — verify** the vendored `update.sh` is byte-identical: `diff src/services/gatewaySetup/templates/update.sh /root/gatecontrol-gateway/deploy/update.sh` → no output.

- [ ] **Step 7 — commit:** `git commit -am "feat(gateway-setup): vendored templates + setup.sh orchestrator + manifest"`

## Task T3: gatewaySetup service (render + bundle)

**Files:** Create `src/services/gatewaySetup.js`, `tests/gateway_setup_bundle.test.js`

- [ ] **Step 1 — failing test** (`tests/gateway_setup_bundle.test.js`), pure-function part:
```js
'use strict';
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const gs = require('../src/services/gatewaySetup');

test('slug sanitizes hostile names', () => {
  assert.equal(gs._slug('Office GW', 7), 'office-gw');
  assert.equal(gs._slug('..', 7), 'gateway-7');
  assert.equal(gs._slug('a\nb', 7), 'a-b');
  assert.equal(gs._slug('', 7), 'gateway-7');
  assert.equal(gs._slug('  ', 7), 'gateway-7');
});

test('renderScript embeds update.sh + single-quotes/escapes name + lowercase image', () => {
  const s = gs.renderScript({ id: 7, name: "weird ' name" });
  const m = s.match(/^GATEWAY_NAME=.*$/m);
  assert.ok(m && m[0].indexOf("'\\''") !== -1, "name single-quote-escaped on one line");
  assert.equal(s.indexOf('{{UPDATE_SH}}'), -1, 'UPDATE_SH placeholder consumed');
  assert.match(s, /GATEWAY_STATE_DIR:-\/state/);                    // string unique to update.sh → embed proven
  assert.match(s, /ghcr\.io\/callmetechie\/gatecontrol-gateway:latest/); // lowercase image
});
test('renderScript does not interpret $-sequences in the name (replace footgun)', () => {
  const s = gs.renderScript({ id: 7, name: '$& $$ end' });
  assert.match(s, /^GATEWAY_NAME='\$& \$\$ end'$/m); // literal $&/$$ preserved on one line
});

test('buildBundleFiles lists all expected entries', () => {
  const names = gs.buildBundleFiles({ id: 7, name: 'gw' }).map((f) => f.name).sort();
  assert.deepEqual(names, ['README.md','docker-compose.state-snippet.yml','setup.sh','systemd/gatecontrol-gateway-update.path','systemd/gatecontrol-gateway-update.service','update.sh']);
});
```

- [ ] **Step 2 — run, expect fail.**

- [ ] **Step 3 — implement** `src/services/gatewaySetup.js`:
```js
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const TPL = path.join(__dirname, 'gatewaySetup', 'templates');
const read = (rel) => fs.readFileSync(path.join(TPL, rel), 'utf8');
const REPO = (process.env.GC_GATEWAY_REPO || 'CallMeTechie/gatecontrol-gateway').toLowerCase();
const IMAGE = `ghcr.io/${REPO}:latest`;
const DEFAULT_COMPOSE_DIR = '/volume1/docker/gatecontrol-gateway';
const SERVICE = 'gateway';

function _slug(name, id) {
  let s = String(name == null ? '' : name).toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-').replace(/[-.]{2,}/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 64);
  if (!s) s = `gateway-${id}`;
  return s;
}
function _shQuote(name) {
  return String(name == null ? '' : name).replace(/[\r\n]+/g, ' ').replace(/'/g, `'\\''`);
}
// NOTE: all replacements use the FUNCTION form `() => value` so that `$`-sequences
// (`$&`, `$$`, `` $` ``, `$'`, `$1`) in the value are NOT interpreted by String.replace
// (a real footgun — a name like `$&` or an embedded script with `$$` would corrupt).
function _fill(tpl, gw) {
  return tpl
    .replace(/\{\{GATEWAY_NAME\}\}/g, () => _shQuote(gw.name))
    .replace(/\{\{GATEWAY_IMAGE\}\}/g, () => IMAGE)
    .replace(/\{\{DEFAULT_COMPOSE_DIR\}\}/g, () => DEFAULT_COMPOSE_DIR)
    .replace(/\{\{SERVICE\}\}/g, () => SERVICE);
}
function renderScript(gw) {
  return _fill(read('setup.sh'), gw).replace(/\{\{UPDATE_SH\}\}/g, () => read('update.sh').replace(/\s+$/, ''));
}
function buildBundleFiles(gw) {
  return [
    { name: 'setup.sh', data: Buffer.from(renderScript(gw)) },
    { name: 'update.sh', data: Buffer.from(read('update.sh')) },
    { name: 'systemd/gatecontrol-gateway-update.service', data: Buffer.from(read('systemd/gatecontrol-gateway-update.service')) },
    { name: 'systemd/gatecontrol-gateway-update.path', data: Buffer.from(read('systemd/gatecontrol-gateway-update.path')) },
    { name: 'docker-compose.state-snippet.yml', data: Buffer.from(read('docker-compose.state-snippet.yml')) },
    { name: 'README.md', data: Buffer.from(_fill(read('README.md'), gw)) },
  ];
}
function slug(gw) { return _slug(gw.name, gw.id); }
module.exports = { renderScript, buildBundleFiles, slug, _slug, _shQuote };
```

- [ ] **Step 4 — run, expect pass.** Tune the regex assertions to the actual escaped form (invariants: single line, `'`→`'\''`, update.sh embedded, lowercase image).
- [ ] **Step 5 — `bash -n` the rendered script:** add a test that writes `renderScript({id:1,name:"x"})` to a temp file and runs `bash -n <tmpfile>` through a spawned process (`node:child_process` `spawnSync('bash', ['-n', tmp])`), asserting `status === 0`.
- [ ] **Step 6 — commit:** `git commit -am "feat(gateway-setup): tailored setup-script + bundle render service"`

## Task T4: GET endpoints

**Files:** Modify `src/routes/api/gateways.js`; extend `tests/gateway_setup_bundle.test.js`

- [ ] **Step 1 — failing test** (extend; mirror `tests/gateway_api_list.test.js` login+agent harness): seed a gateway peer; assert:
  - `GET …/:id/setup-script` → 200, `text/plain…`, `content-disposition` has `attachment` + `.sh`, body contains `GATEWAY_NAME=` + `gateway-state:/state`.
  - `GET …/:id/setup-bundle.zip` → 200, `application/zip`, body begins with bytes `50 4b 03 04` (PK\x03\x04), non-empty.
  - 404 unknown id; 403 with `require('../src/services/license')._overrideForTest({ gateway_fleet:false })` (reset `{gateway_fleet:true}` after); 404-before-403 (unknown id while feature off → 404).

- [ ] **Step 2 — run, expect fail.**

- [ ] **Step 3 — implement** in `src/routes/api/gateways.js` (add requires at top; `getDb`/`router` already present):
```js
const gatewaySetup = require('../../services/gatewaySetup');
const { createZip } = require('../../utils/zip');

function _setupGatewayOr4xx(req, res) {
  const id = Number(req.params.id);
  const row = getDb().prepare(`SELECT p.id, p.name, p.peer_type, p.enabled
    FROM peers p JOIN gateway_meta gm ON gm.peer_id = p.id WHERE p.id = ?`).get(id);
  if (!row || row.peer_type !== 'gateway' || !row.enabled) { res.status(404).json({ ok: false, error: 'not_found' }); return null; }
  if (!require('../../services/license').hasFeature('gateway_fleet')) { res.status(403).json({ ok: false, error: 'gateway_fleet not licensed' }); return null; }
  return { id: row.id, name: row.name };
}

router.get('/:id/setup-script', (req, res) => {
  const gw = _setupGatewayOr4xx(req, res); if (!gw) return;
  res.set('Content-Type', 'text/plain; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="gatecontrol-gateway-setup-${gatewaySetup.slug(gw)}.sh"`);
  res.set('Cache-Control', 'no-store');
  res.send(gatewaySetup.renderScript(gw));
});

router.get('/:id/setup-bundle.zip', (req, res) => {
  const gw = _setupGatewayOr4xx(req, res); if (!gw) return;
  const zip = createZip(gatewaySetup.buildBundleFiles(gw));
  res.set('Content-Type', 'application/zip');
  res.set('Content-Disposition', `attachment; filename="gatecontrol-gateway-setup-${gatewaySetup.slug(gw)}.zip"`);
  res.set('Cache-Control', 'no-store');
  res.send(zip);
});
```

- [ ] **Step 4 — run, expect pass.**
- [ ] **Step 5 — commit:** `git commit -am "feat(api): gateway setup-script + setup-bundle.zip endpoints"`

## Task T5: detail-view card

**Files:** Modify `public/js/gateways.js`

- [ ] **Step 1 — implement** (verify `node --check` + `grep -c innerHTML` === 0). In `renderDetail(g)`, after the existing cards, append a new card via `el()`. Compute `migrated = !!(g.health && g.health.telemetry && g.health.telemetry.state_dir_writable)`.
  - `var c = el('div','gw gw-setup' + (migrated ? ' done' : ''));`
  - top: `el('div','top')` with `el('h3', null, T('gateways.setup_title','Set up auto-update'))` + a **plain status span** (NOT `.pill` — `.pill` capitalizes + adds a `::before` dot which would double the glyph): `el('span','gw-setup-status ' + (migrated?'done':'pending'), migrated ? T('gateways.setup_done','✓ Set up') : T('gateways.setup_pending','⚠ Not set up yet'))`.
  - body: when `!migrated`, a note `el('div','note', T('gateways.setup_note', '…'))`; then a row with two anchor downloads:
    `var a1=el('a','recheck','⬇ '+T('gateways.setup_download_script','Setup script')); a1.href='/api/v1/gateways/'+g.peer_id+'/setup-script';`
    `var a2=el('a','recheck','⬇ '+T('gateways.setup_download_zip','ZIP (all files)')); a2.href='/api/v1/gateways/'+g.peer_id+'/setup-bundle.zip';`
    then a `el('details')` containing `el('summary',null,T('gateways.setup_guide','Step-by-step guide'))` + two short labelled blocks (`T('gateways.setup_synology')`, `T('gateways.setup_linux')`) noting the full steps are in the downloaded README.
  - Append the card to the detail `grid`/root.
- [ ] **Step 2 — CSS** (append to the `.gw-fleet` block in BOTH `public/css/app.css` and `public/css/pro.css` — they're byte-duplicated; use design tokens):
```css
.gw-fleet .gw-setup .gw-setup-status { font-size: 12px; font-weight: 600; }
.gw-fleet .gw-setup .gw-setup-status.done { color: var(--green); }
.gw-fleet .gw-setup .gw-setup-status.pending { color: var(--amber); }
.gw-fleet .gw-setup .gw-actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 10px 0; }
.gw-fleet .gw-setup details { margin-top: 8px; font-size: 13px; }
.gw-fleet .gw-setup details > summary { cursor: pointer; color: var(--text-2); }
.gw-fleet .gw-setup details[open] > summary { margin-bottom: 8px; }
.gw-fleet .gw.gw-setup.done { opacity: .85; }   /* secondary when already set up */
```
(The download links reuse the existing `.recheck` button-link style; the note reuses `.note`.)
- [ ] **Step 3 — verify:** `node --check public/js/gateways.js`; `grep -c innerHTML public/js/gateways.js` → 0.
- [ ] **Step 4 — commit:** `git commit -am "feat(gateways-ui): Auto-Update einrichten card (downloads + guide + note) + CSS"`

## Task T6: i18n + GC.t

**Files:** `src/i18n/{en,de}.json`, `templates/{default,pro}/layout.njk`; extend a parity test.

- [ ] **Step 1 — add keys** (en / de):
```
gateways.setup_title           = "Set up auto-update" / "Auto-Update einrichten"
gateways.setup_note            = "The automatic Update button only works after this one-time host setup." / "Der automatische Update-Button funktioniert erst nach diesem einmaligen Host-Setup."
gateways.setup_done            = "✓ Set up" / "✓ Eingerichtet"
gateways.setup_pending         = "⚠ Not set up yet" / "⚠ Noch nicht eingerichtet"
gateways.setup_download_script = "Setup script" / "Setup-Script"
gateways.setup_download_zip    = "ZIP (all files)" / "ZIP (alle Dateien)"
gateways.setup_guide           = "Step-by-step guide" / "Schritt-für-Schritt-Anleitung"
gateways.setup_synology        = "Synology (DSM)" / "Synology (DSM)"
gateways.setup_linux           = "Linux (systemd)" / "Linux (systemd)"
```
Add all 9 to BOTH json files AND to the `gateways.*` group of `window.GC.t` in BOTH layouts. **Comma fix:** in all four files the current last gateways key is `gateways.last_pull_never` followed by `}` with NO trailing comma — add a comma after it before appending the new keys (last new key `gateways.setup_linux` gets no trailing comma).
- [ ] **Step 2 — extend the parity test** (`tests/i18n_update_keys.test.js`): besides en/de JSON, assert each of the 9 `gateways.setup_*` keys appears in BOTH `templates/default/layout.njk` AND `templates/pro/layout.njk` GC.t blocks (read each file, check `"'" + key + "':"` present). Without this, a key missing from one layout silently falls back to the English default and no test catches it. Then verify JSON valid + both layouts compile (nunjucks `getTemplate(f,true)`).
- [ ] **Step 3 — commit:** `git commit -am "feat(i18n): gateway setup-bundle strings (en+de) + GC.t"`

## Task T7: CI drift check + zip validity

**Files:** Create `scripts/check-vendored-templates.js`; modify `.github/workflows/test.yml`

- [ ] **Step 1 — `scripts/check-vendored-templates.js`:** parse the tag from `templates/VENDORED.md`; for each vendored file `https.get('https://raw.githubusercontent.com/CallMeTechie/gatecontrol-gateway/<tag>/deploy/<name>')` and **byte-compare** to the local copy; on any mismatch print which file + `process.exit(1)`.
- [ ] **Step 2 — `.github/workflows/test.yml`:** add a `node scripts/check-vendored-templates.js` step, and a zip-validity step:
```
node -e "const {createZip}=require('./src/utils/zip');require('fs').writeFileSync('/tmp/b.zip',createZip([{name:'a',data:Buffer.from('x')},{name:'e',data:Buffer.from('')}]))"
unzip -t /tmp/b.zip
```
(`unzip -t` exits non-zero on a corrupt archive → fails the job; do not pipe it.)
- [ ] **Step 3 — run the drift check locally** (if network allows) — expect pass against v1.10.1. Note: `unzip` may not be installed on the dev host; the `unzip -t` validity step is for CI (`ubuntu-latest` ships `unzip`). The zip's own structure/CRC is already covered by `tests/zip.test.js` (T1).
- [ ] **Step 4 — commit:** `git commit -am "ci: vendored-template drift check + zip validity (unzip -t)"`

## Task T8: docs + finish

- [ ] **Step 1 — `docs/feature-gateway-autoupdate-setup-bundle.md`** (force-add): overview, the card, the two downloads, the tailored setup.sh (auto-detect + detached recreate + trigger), the vendoring/drift policy, security.
- [ ] **Step 2 — full suite:** `NODE_ENV=test node --test --test-force-exit tests/`. On a dev host **with `wg` installed**, the `tests/api.test.js` peer/route tests RUN (gated `{skip:!hasWg}`) and may fail if Caddy/WireGuard can't fully operate in the sandbox — that's pre-existing + environmental, NOT a regression; CI (`ubuntu-latest`, no `wg`) SKIPS them. Treat only NEW failures as real. `node --check public/js/gateways.js`.
- [ ] **Step 3 — push + open PR:** `feat: gateway auto-update setup bundle (detail-view download + guide)`.

---

## Self-Review
- **Spec coverage:** zip writer (T1), vendored templates + setup.sh (T2 — DA2 #1 byte-identical, #2 version-gated skip, #3 service-block-aware insert), render+slug/escape (T3 — DA #4 / DA2 #6), endpoints 404→403 (T4 — DA2 #4), card (T5), i18n (T6), drift + `unzip -t` (T7 — DA2 #1/#5), docs (T8). All present.
- **Type/name consistency:** bundle entry names in T3 match T4's zip + the `unzip -t` corpus; `slug`/`renderScript`/`buildBundleFiles` consistent T3→T4; placeholders consistent setup.sh (T2) ↔ `_fill` (T3).
- **Placeholders:** no TBDs; README.md prose (T2.5) + card guide gist (T5) are described, not logic gaps.
- **CRC oracle:** T1 test uses fixed reference constants (Node-version-independent); `unzip -t` in CI is the structural oracle; the writer rolls its own CRC (independence preserved).
