# Gateway Auto-Update (#2b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Admin-triggered gateway image update from the web UI via flag-file + host `update.sh`, with a clock-skew-proof, server-tracked update lifecycle (request_id matching).

**Architecture:** Server `POST /api/v1/gateways/:id/update` → `notifySelfUpdate` (X-Gateway-Token over tunnel) → companion writes `/state/pending-update` → host systemd `.path`/DSM task runs `update.sh` (pull + recreate detached, health-gate, digest-pinned rollback) → companion heartbeat relays result (request_id) → server derives `update_state`. Spec: `docs/superpowers/specs/2026-05-25-gateway-auto-update-design.md`.

**Tech Stack:** Node 20, Express, better-sqlite3, Nunjucks, `node:test`; bash + systemd/DSM for the host; Docker Compose.

**Two repos / two PRs (sequenced deploy — companion first):**
- **Part A** — `/root/gatecontrol-gateway` (companion): A1–A4 → PR in gateway repo.
- **Part B** — `/root/gatecontrol` (server): B1–B7 → PR in server repo.

---

## File Structure

**Gateway (`/root/gatecontrol-gateway`)**
- Create `src/api/routes/selfUpdate.js` — POST /api/self-update; writes flag; cooldown/dedupe by request_id.
- Modify `src/config.js` — add `GATEWAY_STATE_DIR` → `config.stateDir`.
- Modify `src/bootstrap.js` — register selfUpdate router.
- Modify `src/health/telemetry.js` — relay last-pull fields + state_dir_writable + pending_update.
- Create `deploy/update.sh` — host updater (pull/recreate/health/rollback/last-pull).
- Create `deploy/systemd/gatecontrol-gateway-update.{service,path}`.
- Modify `docker-compose.example.yml` — add `./gateway-state:/state` (rw).
- Create `docs/auto-update.md` — Linux + Synology host setup + dry-run verify.
- Tests: `tests/api_self_update.test.js`, extend `tests/telemetry*.test.js` (or new `tests/telemetry_lastpull.test.js`).

**Server (`/root/gatecontrol`)**
- Modify `src/db/migrationList.js` — migration v44: 3 `gateway_meta` columns.
- Modify `src/services/gateways.js` — `notifySelfUpdate`, `markUpdateRequested`, `_normalizeTargetVersion`, `_deriveUpdateState`, clear-on-terminal; exports.
- Modify `src/routes/api/gateways.js` — `POST /:id/update`; augment `GET '/'` with `update_state`.
- Modify `public/js/gateways.js` — update button + lifecycle banner + image_digest/last_pull rows.
- Modify `src/i18n/en.json`, `src/i18n/de.json` — new keys.
- Modify `templates/default/layout.njk`, `templates/pro/layout.njk` — GC.t whitelist.
- Create `docs/feature-gateway-auto-update.md`.
- Tests: `tests/api_gateway_update.test.js`, `tests/gateway_update_state.test.js`.

---

# PART A — Gateway companion (`/root/gatecontrol-gateway`)

> Branch: `feat/self-update`. Run tests with `npm test` (`node --test tests/`).

## Task A1: `GATEWAY_STATE_DIR` config

**Files:** Modify `src/config.js`

- [ ] **Step 1 — failing test** (`tests/config.test.js`, add a case mirroring existing ones):

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../src/config'); // mirror how existing config.test.js imports

test('stateDir defaults to /state and honors GATEWAY_STATE_DIR', () => {
  const base = { /* spread whatever minimal valid env the existing tests use */ };
  // Reuse the existing test's valid-env builder; assert default:
  // assert.equal(cfg.stateDir, '/state');
  // and with GATEWAY_STATE_DIR=/data/state → '/data/state'
});
```
(Read `tests/config.test.js` first and copy its valid-env construction; assert `cfg.stateDir === '/state'` by default and respects `GATEWAY_STATE_DIR`.)

- [ ] **Step 2 — run, expect fail** (`stateDir` undefined). `npm test`.

- [ ] **Step 3 — implement.** In `src/config.js`, add to the zod schema:
```js
GATEWAY_STATE_DIR: z.string().default('/state'),
```
and to the returned config object (next to `gatewayToken`/`apiPort`):
```js
stateDir: parsed.GATEWAY_STATE_DIR,
```

- [ ] **Step 4 — run, expect pass.** `npm test`.

- [ ] **Step 5 — commit:** `git commit -am "feat(config): GATEWAY_STATE_DIR (writable runtime state dir)"`

## Task A2: `POST /api/self-update` route

**Files:** Create `src/api/routes/selfUpdate.js`; Modify `src/bootstrap.js`; Test `tests/api_self_update.test.js`

- [ ] **Step 1 — failing test** (`tests/api_self_update.test.js`), mirroring `tests/api_wol.test.js` structure (build an app via `createApiServer` with a temp stateDir, send requests with the `X-Gateway-Token`):

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const request = require('supertest'); // if used by api_wol.test.js; else use http like that file
const { createApiServer } = require('../src/api/server');
const { createSelfUpdateRouter } = require('../src/api/routes/selfUpdate');

const TOKEN = 'a'.repeat(64);
function appWith(stateDir) {
  return createApiServer({
    bindIp: '127.0.0.1', port: 0, expectedToken: TOKEN,
    routerFactories: { '/api': () => { const r = require('express').Router(); r.use(createSelfUpdateRouter({ stateDir })); return r; } },
  });
}

test('writes pending-update flag and returns queued', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-'));
  const app = appWith(dir);
  const res = await request(app).post('/api/self-update')
    .set('X-Gateway-Token', TOKEN).send({ request_id: 'rid-1', target_version: '1.9.4' });
  assert.equal(res.status, 200);
  assert.equal(res.body.queued, true);
  const flag = JSON.parse(fs.readFileSync(path.join(dir, 'pending-update'), 'utf8'));
  assert.equal(flag.request_id, 'rid-1');
  assert.equal(flag.target_version, '1.9.4');
  assert.equal(flag.triggered_via, 'server-push');
});

test('requires request_id', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-'));
  const res = await request(appWith(dir)).post('/api/self-update').set('X-Gateway-Token', TOKEN).send({});
  assert.equal(res.status, 400);
});

test('401/403 without valid token', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-'));
  const res = await request(appWith(dir)).post('/api/self-update').send({ request_id: 'x' });
  assert.equal(res.status, 401);
});

test('cooldown: same request_id already in last-pull is skipped', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-'));
  fs.writeFileSync(path.join(dir, 'last-pull'), JSON.stringify({ request_id: 'rid-1', ok: true, pulled_at: Date.now() }));
  const res = await request(appWith(dir)).post('/api/self-update')
    .set('X-Gateway-Token', TOKEN).send({ request_id: 'rid-1' });
  assert.equal(res.status, 200);
  assert.equal(res.body.skipped, 'cooldown');
  assert.equal(fs.existsSync(path.join(dir, 'pending-update')), false);
});

test('new request_id after a failed pull is NOT cooled down', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-'));
  fs.writeFileSync(path.join(dir, 'last-pull'), JSON.stringify({ request_id: 'old', ok: false, pulled_at: Date.now() }));
  const res = await request(appWith(dir)).post('/api/self-update')
    .set('X-Gateway-Token', TOKEN).send({ request_id: 'new' });
  assert.equal(res.status, 200);
  assert.equal(res.body.queued, true);
});
```
(First read `tests/api_wol.test.js` — if it uses raw `http` instead of `supertest`, copy that harness exactly.)

- [ ] **Step 2 — run, expect fail** (module missing). `npm test`.

- [ ] **Step 3 — implement** `src/api/routes/selfUpdate.js`:

```js
'use strict';

const express = require('express');
const fs = require('node:fs/promises');
const fssync = require('node:fs');
const path = require('node:path');
const logger = require('../../logger');

const COOLDOWN_MS = 60_000;

function createSelfUpdateRouter({ stateDir }) {
  const router = express.Router();
  router.post('/self-update', async (req, res) => {
    const { request_id, target_version } = req.body || {};
    if (!request_id || typeof request_id !== 'string') {
      return res.status(400).json({ error: 'request_id_required' });
    }
    try { await fs.access(stateDir, fssync.constants.W_OK); }
    catch { return res.status(500).json({ error: 'state_unavailable' }); }

    // Dedupe / loop-guard: read existing last-pull (best effort).
    try {
      const lp = JSON.parse(await fs.readFile(path.join(stateDir, 'last-pull'), 'utf8'));
      const already = lp && lp.request_id === request_id;
      const postSuccessLoop = lp && lp.ok === true && typeof lp.pulled_at === 'number'
        && (Date.now() - lp.pulled_at) < COOLDOWN_MS;
      if (already || postSuccessLoop) {
        return res.status(200).json({ ok: true, skipped: 'cooldown' });
      }
    } catch { /* no/invalid last-pull → proceed */ }

    const flag = path.join(stateDir, 'pending-update');
    try {
      await fs.writeFile(flag, JSON.stringify({
        request_id,
        target_version: typeof target_version === 'string' ? target_version : null,
        requested_at: new Date().toISOString(),
        triggered_via: 'server-push',
      }) + '\n', { mode: 0o600 });
      logger.info({ request_id }, 'Self-update flag written');
      res.status(200).json({ ok: true, queued: true });
    } catch (err) {
      logger.warn({ err: err.message }, 'Failed to write self-update flag');
      res.status(500).json({ error: 'flag_write_failed' });
    }
  });
  return router;
}

module.exports = { createSelfUpdateRouter };
```

- [ ] **Step 4 — register** in `src/bootstrap.js` mergeRouter (next to `createWolRouter`):
```js
const { createSelfUpdateRouter } = require('./api/routes/selfUpdate');
// ... inside the '/api' factory mergeRouter:
mergeRouter.use(createSelfUpdateRouter({ stateDir: config.stateDir }));
```

- [ ] **Step 5 — run, expect pass.** `npm test`.

- [ ] **Step 6 — commit:** `git commit -am "feat(api): POST /api/self-update writes pending-update flag (request_id, cooldown)"`

## Task A3: telemetry relays update state

**Files:** Modify `src/health/telemetry.js`; Test `tests/telemetry_lastpull.test.js`

- [ ] **Step 1 — failing test** (`tests/telemetry_lastpull.test.js`):

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

test('collectTelemetry relays last-pull + state flags', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-'));
  process.env.GATEWAY_STATE_DIR = dir;
  delete require.cache[require.resolve('../src/health/telemetry')];
  const { collectTelemetry } = require('../src/health/telemetry');

  let t = collectTelemetry();
  assert.equal(t.state_dir_writable, true);
  assert.equal(t.pending_update, false);
  assert.equal(t.last_pull_at, null);
  assert.equal(t.last_pull_request_id, null);

  fs.writeFileSync(path.join(dir, 'last-pull'), JSON.stringify({ request_id: 'r1', pulled_at: 1700000000000, image_digest: 'repo@sha256:abc', ok: true }));
  fs.writeFileSync(path.join(dir, 'pending-update'), '{}');
  delete require.cache[require.resolve('../src/health/telemetry')];
  t = require('../src/health/telemetry').collectTelemetry();
  assert.equal(t.last_pull_request_id, 'r1');
  assert.equal(t.last_pull_ok, true);
  assert.equal(t.last_pull_at, 1700000000000);
  assert.equal(t.image_digest, 'repo@sha256:abc');
  assert.equal(t.pending_update, true);
});
```

- [ ] **Step 2 — run, expect fail.** `npm test`.

- [ ] **Step 3 — implement** in `src/health/telemetry.js`. Ensure `fs` + `path` required at top; add near other module-scope helpers:
```js
const STATE_DIR = process.env.GATEWAY_STATE_DIR || '/state';
function _readLastPull() {
  try { return JSON.parse(require('node:fs').readFileSync(require('node:path').join(STATE_DIR, 'last-pull'), 'utf8')); }
  catch { return null; }
}
function _stateDirWritable() { try { require('node:fs').accessSync(STATE_DIR, require('node:fs').constants.W_OK); return true; } catch { return false; } }
function _pendingUpdate() { try { require('node:fs').accessSync(require('node:path').join(STATE_DIR, 'pending-update')); return true; } catch { return false; } }
```
Add to the object returned by `collectTelemetry()`:
```js
const _lp = _readLastPull();
// ...
image_digest: _lp && _lp.image_digest ? _lp.image_digest : null,
last_pull_at: _lp && typeof _lp.pulled_at === 'number' ? _lp.pulled_at : null,
last_pull_ok: _lp ? (_lp.ok === true) : null,
last_pull_request_id: _lp && _lp.request_id ? _lp.request_id : null,
state_dir_writable: _stateDirWritable(),
pending_update: _pendingUpdate(),
```

- [ ] **Step 4 — run, expect pass.** `npm test`.

- [ ] **Step 5 — commit:** `git commit -am "feat(telemetry): relay last-pull (request_id/digest/ok), state_dir_writable, pending_update"`

## Task A4: host `update.sh` + systemd + compose + docs

**Files:** Create `deploy/update.sh`, `deploy/systemd/gatecontrol-gateway-update.service`, `deploy/systemd/gatecontrol-gateway-update.path`; Modify `docker-compose.example.yml`; Create `docs/auto-update.md`

*(No unit test — host script. Verify with `bash -n` + shellcheck if present. Manual DSM verification documented.)*

- [ ] **Step 1 — create `deploy/update.sh`** (chmod +x):

```bash
#!/usr/bin/env bash
# GateControl Gateway self-update. Triggered by the pending-update flag.
# Pulls + recreates the gateway container detached, health-gates, and on
# failure rolls back to the previously-running image (digest-pinned override,
# because compose pins :latest). Records the result in /state/last-pull,
# echoing the request_id so the server can match it skew-proof.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]:-$0}")")" && pwd)"
COMPOSE_DIR="${GC_GW_COMPOSE_DIR:-$SCRIPT_DIR}"
STATE_DIR="${GATEWAY_STATE_DIR:-/state}"
SERVICE="${GC_GW_SERVICE:-gateway}"
HEALTH_CEILING="${GC_GW_HEALTH_CEILING:-300}"
LOG="${GC_GW_UPDATE_LOG:-$STATE_DIR/update.log}"
LOCK="$COMPOSE_DIR/.update.lock"
FLAG="$STATE_DIR/pending-update"
LASTPULL="$STATE_DIR/last-pull"
OVERRIDE="$COMPOSE_DIR/docker-compose.rollback.yml"

log() { echo "[$(date -Iseconds)] $*" >>"$LOG"; }
dc() { docker compose -f "$COMPOSE_DIR/docker-compose.yml" "$@"; }
running_cid() { dc ps -q "$SERVICE" 2>/dev/null | head -1; }
repo_digest() { docker inspect --format '{{if .RepoDigests}}{{index .RepoDigests 0}}{{end}}' "$1" 2>/dev/null || true; }

[ -f "$COMPOSE_DIR/docker-compose.yml" ] || { echo "no docker-compose.yml in $COMPOSE_DIR" >&2; exit 2; }

exec 9>"$LOCK"
if ! flock -n 9; then log "another update running, exit"; exit 0; fi

REQUEST_ID=""
if [ -f "$FLAG" ]; then
  REQUEST_ID="$(grep -o '"request_id":"[^"]*"' "$FLAG" | head -1 | cut -d'"' -f4 || true)"
  rm -f "$FLAG"   # consume-on-lock: a later trigger writes a fresh flag
fi
log "update start request_id=${REQUEST_ID:-none}"

CID="$(running_cid)"
OLD_DIGEST=""
[ -n "$CID" ] && OLD_DIGEST="$(repo_digest "$CID")"
log "container=$CID old_digest=${OLD_DIGEST:-none}"

dc pull "$SERVICE" >>"$LOG" 2>&1 || log "pull reported error (continuing)"
dc up -d --force-recreate "$SERVICE" >>"$LOG" 2>&1

ok=false
deadline=$(( $(date +%s) + HEALTH_CEILING ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  NCID="$(running_cid)"
  if [ -n "$NCID" ]; then
    hs="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$NCID" 2>/dev/null || echo starting)"
    case "$hs" in
      healthy|none) ok=true; break ;;
      unhealthy)    ok=false; break ;;
      *)            : ;;  # starting → keep waiting through start-period
    esac
  fi
  sleep 5
done
log "health ok=$ok"

if [ "$ok" != true ]; then
  if [ -n "$OLD_DIGEST" ]; then
    log "rolling back to $OLD_DIGEST"
    cat >"$OVERRIDE" <<YAML
services:
  $SERVICE:
    image: $OLD_DIGEST
YAML
    docker compose -f "$COMPOSE_DIR/docker-compose.yml" -f "$OVERRIDE" up -d --force-recreate "$SERVICE" >>"$LOG" 2>&1 || log "rollback up failed"
  else
    log "no old digest captured — cannot roll back (locally-built image?)"
  fi
else
  rm -f "$OVERRIDE"   # clear any stale rollback pin after a good update
fi

RUN_DIGEST="$(repo_digest "$(running_cid)")"
PULLED_AT=$(( $(date +%s) * 1000 ))
printf '{"request_id":"%s","pulled_at":%s,"image_digest":"%s","ok":%s}\n' \
  "$REQUEST_ID" "$PULLED_AT" "$RUN_DIGEST" "$ok" >"$LASTPULL"
log "wrote last-pull ok=$ok digest=${RUN_DIGEST:-none}"
```

- [ ] **Step 2 — syntax check.** Run: `bash -n deploy/update.sh && command -v shellcheck && shellcheck deploy/update.sh || true`. Expected: no syntax errors.

- [ ] **Step 3 — create systemd units.**
`deploy/systemd/gatecontrol-gateway-update.service`:
```ini
[Unit]
Description=GateControl Gateway self-update (oneshot)

[Service]
Type=oneshot
ExecStart=/opt/gatecontrol-gateway/deploy/update.sh
```
`deploy/systemd/gatecontrol-gateway-update.path`:
```ini
[Unit]
Description=Watch for GateControl Gateway pending-update flag

[Path]
PathExists=/state/pending-update
Unit=gatecontrol-gateway-update.service

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 4 — modify `docker-compose.example.yml`.** Under the gateway service `volumes:` add (keep `/config:ro`):
```yaml
      - ./gateway-state:/state          # rw: self-update flag + last-pull marker (#2b)
```

- [ ] **Step 5 — create `docs/auto-update.md`** documenting: the `/state` volume; Linux systemd `.path`+`.service` install (`systemctl enable --now gatecontrol-gateway-update.path`); Synology DSM Task Scheduler (user-defined script running `/opt/gatecontrol-gateway/deploy/update.sh` every 1–2 min, root); the poll-interval latency; the lockfile; and a **dry-run verify**: `echo '{"request_id":"dryrun"}' > ./gateway-state/pending-update` then confirm `update.sh` consumed it and wrote `gateway-state/last-pull` with `"request_id":"dryrun"`. Include the rollback-path note.

- [ ] **Step 6 — commit:** `git commit -am "feat(deploy): self-update host script + systemd units + /state volume + docs"`

- [ ] **Step 7 — finish Part A.** Push branch, open PR in the gateway repo titled `feat: admin-triggered self-update (flag-file + host update.sh)`.

---

# PART B — Server (`/root/gatecontrol`)

> Branch: `feat/gateway-auto-update`. Tests: `NODE_ENV=test npx c8 --check-coverage --lines 40 node --test tests/` (mirror existing); per-file `NODE_ENV=test node --test tests/<file>`.

## Task B1: DB migration (3 columns)

**Files:** Modify `src/db/migrationList.js`

- [ ] **Step 1 — implement migration** (append after the `version: 43` entry; `hasColumn` is already imported in this file):
```js
  {
    version: 44,
    name: 'gateway_meta_update_tracking',
    sql: `
      ALTER TABLE gateway_meta ADD COLUMN update_request_id TEXT;
      ALTER TABLE gateway_meta ADD COLUMN update_requested_at INTEGER;
      ALTER TABLE gateway_meta ADD COLUMN update_target_version TEXT;
    `,
    detect: (db) => hasColumn(db, 'gateway_meta', 'update_request_id'),
  },
```

- [ ] **Step 2 — verify migration runs.** Run: `NODE_ENV=test node -e "require('./src/db/connection').getDb(); console.log('migrated')"` (the connection runs migrations on open). Expected: prints `migrated`, no error.

- [ ] **Step 3 — commit:** `git commit -am "feat(db): migration v44 — gateway_meta update tracking columns"`

## Task B2: service — notifySelfUpdate + lifecycle helpers

**Files:** Modify `src/services/gateways.js`; Test `tests/gateway_update_state.test.js`

- [ ] **Step 1 — failing test** (`tests/gateway_update_state.test.js`) for the pure helpers:
```js
'use strict';
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const gw = require('../src/services/gateways');

test('_normalizeTargetVersion strips leading v', () => {
  assert.equal(gw._normalizeTargetVersion('v1.9.4'), '1.9.4');
  assert.equal(gw._normalizeTargetVersion('1.9.4'), '1.9.4');
  assert.equal(gw._normalizeTargetVersion(null), null);
});

const TIMEOUT = 15 * 60 * 1000;
function row(over) { return Object.assign({ update_request_id: null, update_requested_at: null, update_target_version: null }, over); }

test('_deriveUpdateState: idle when no request', () => {
  assert.equal(gw._deriveUpdateState(row(), {}).state, 'idle');
});
test('_deriveUpdateState: updating until request_id matches', () => {
  const r = row({ update_request_id: 'rid', update_requested_at: Date.now(), update_target_version: '1.9.4' });
  assert.equal(gw._deriveUpdateState(r, { last_pull_request_id: 'OTHER', gateway_version: '1.9.3' }).state, 'updating');
});
test('_deriveUpdateState: done on matching id + ok + version satisfied', () => {
  const r = row({ update_request_id: 'rid', update_requested_at: Date.now(), update_target_version: '1.9.4' });
  assert.equal(gw._deriveUpdateState(r, { last_pull_request_id: 'rid', last_pull_ok: true, gateway_version: '1.9.4' }).state, 'done');
});
test('_deriveUpdateState: failed on matching id + ok:false', () => {
  const r = row({ update_request_id: 'rid', update_requested_at: Date.now(), update_target_version: '1.9.4' });
  assert.equal(gw._deriveUpdateState(r, { last_pull_request_id: 'rid', last_pull_ok: false, gateway_version: '1.9.3' }).state, 'failed');
});
test('_deriveUpdateState: unknown version → failed (never green)', () => {
  const r = row({ update_request_id: 'rid', update_requested_at: Date.now(), update_target_version: '1.9.4' });
  assert.equal(gw._deriveUpdateState(r, { last_pull_request_id: 'rid', last_pull_ok: true, gateway_version: 'unknown' }).state, 'failed');
});
test('_deriveUpdateState: clock skew does NOT cause false done', () => {
  // host pulled_at far in the future, but request_id does not match → still updating
  const r = row({ update_request_id: 'rid', update_requested_at: Date.now(), update_target_version: '1.9.4' });
  assert.equal(gw._deriveUpdateState(r, { last_pull_request_id: 'stale', last_pull_at: Date.now() + 1e9, last_pull_ok: true, gateway_version: '1.9.4' }).state, 'updating');
});
test('_deriveUpdateState: unknown(sticky) after timeout with no match', () => {
  const r = row({ update_request_id: 'rid', update_requested_at: Date.now() - TIMEOUT - 1000, update_target_version: '1.9.4' });
  assert.equal(gw._deriveUpdateState(r, { last_pull_request_id: null }).state, 'unknown');
});
```

- [ ] **Step 2 — run, expect fail.** `NODE_ENV=test node --test tests/gateway_update_state.test.js`.

- [ ] **Step 3 — implement helpers** in `src/services/gateways.js` (near `_mergeHealth`; reuse the file's existing `decrypt`, `http`, `_peerIp`, `getDb`, `logger`, `require('./activity')`, and `compareVersions` from `../utils/version`):
```js
const { compareVersions } = require('../utils/version');
const crypto = require('node:crypto');
const UPDATE_TIMEOUT_MS = Number(process.env.GC_UPDATE_TIMEOUT_MS || 15 * 60 * 1000);

function _normalizeTargetVersion(v) {
  if (v == null) return null;
  const s = String(v).trim().replace(/^v/i, '');
  return s || null;
}

// Pure: derive the update lifecycle state from the gateway_meta row + relayed telemetry.
// Completion is matched by request_id (skew-proof); timestamps are display-only.
function _deriveUpdateState(row, telemetry) {
  const rid = row && row.update_request_id;
  if (!rid) return { state: 'idle' };
  const t = telemetry || {};
  const matched = t.last_pull_request_id && t.last_pull_request_id === rid;
  if (matched) {
    const ok = t.last_pull_ok === true;
    const target = row.update_target_version;
    const reported = t.gateway_version;
    const parses = (x) => /^\d+(\.\d+){0,2}$/.test(String(x == null ? '' : x).replace(/^v/i, '').split('-')[0]);
    const versionOk = !target || (parses(reported) && parses(target) && compareVersions(reported, target) >= 0);
    if (ok && versionOk) return { state: 'done' };
    return { state: 'failed' };
  }
  if (Date.now() - (row.update_requested_at || 0) > UPDATE_TIMEOUT_MS) return { state: 'unknown' };
  return { state: 'updating' };
}

function markUpdateRequested(peerId, requestId, targetVersion) {
  getDb().prepare(`UPDATE gateway_meta SET update_request_id=?, update_requested_at=?, update_target_version=? WHERE peer_id=?`)
    .run(requestId, Date.now(), _normalizeTargetVersion(targetVersion), peerId);
}
function _clearUpdateTracking(peerId) {
  getDb().prepare(`UPDATE gateway_meta SET update_request_id=NULL, update_requested_at=NULL, update_target_version=NULL WHERE peer_id=?`).run(peerId);
}

async function notifySelfUpdate(peerId, { request_id, target_version } = {}) {
  const db = getDb();
  const row = db.prepare(`SELECT p.allowed_ips, gm.api_port, gm.push_token_encrypted
    FROM gateway_meta gm JOIN peers p ON p.id = gm.peer_id WHERE gm.peer_id = ?`).get(peerId);
  if (!row) return { ok: false };
  const pushToken = decrypt(row.push_token_encrypted);
  const ip = _peerIp(row.allowed_ips);
  const payload = JSON.stringify({ request_id, target_version });
  return new Promise((resolve) => {
    let body = '';
    const req = http.request({
      host: ip, port: row.api_port, path: '/api/self-update', method: 'POST', timeout: 5000,
      headers: { 'X-Gateway-Token': pushToken, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      res.on('data', (c) => { body += c; });
      res.on('end', () => { try { const j = JSON.parse(body); resolve({ ok: res.statusCode === 200, skipped: j.skipped, queued: j.queued }); } catch { resolve({ ok: res.statusCode === 200 }); } });
    });
    req.on('error', (err) => { logger.warn({ err: err.message, peerId }, 'Gateway self-update push failed'); resolve({ ok: false }); });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false }); });
    req.end(payload);
  });
}
```
Add to `module.exports`: `notifySelfUpdate, markUpdateRequested, _clearUpdateTracking, _deriveUpdateState, _normalizeTargetVersion, UPDATE_TIMEOUT_MS`.

- [ ] **Step 4 — run, expect pass.** `NODE_ENV=test node --test tests/gateway_update_state.test.js`.

- [ ] **Step 5 — commit:** `git commit -am "feat(gateways): notifySelfUpdate + request_id-matched update lifecycle helpers"`

## Task B3: API route — POST /:id/update + GET augmentation

**Files:** Modify `src/routes/api/gateways.js`; Test `tests/api_gateway_update.test.js`

- [ ] **Step 1 — failing test** (`tests/api_gateway_update.test.js`) — mirror `tests/api_gateways_fleet.test.js` harness (in-memory DB seed of a gateway peer + gateway_meta). Cover: 200 queued (stub `notifySelfUpdate`→`{ok:true,queued:true}`, telemetry has `state_dir_writable:true`); 200 `queued:false` when stub returns `{skipped:'cooldown'}` AND assert columns NOT set; 404 unknown peer; 403 when `gateway_fleet` feature off; 409 when telemetry lacks `state_dir_writable`. Use the project's existing way of stubbing service methods + faking session auth (copy from `api_gateways_fleet.test.js`).

- [ ] **Step 2 — run, expect fail.** `NODE_ENV=test node --test tests/api_gateway_update.test.js`.

- [ ] **Step 3 — implement** in `src/routes/api/gateways.js`. Add after the `POST /:id/probe` route:
```js
const crypto = require('node:crypto');

router.post('/:id/update', async (req, res) => {
  const id = Number(req.params.id);
  const db = getDb();
  const row = db.prepare(`SELECT p.id, p.peer_type, p.enabled, gm.last_health
    FROM peers p JOIN gateway_meta gm ON gm.peer_id = p.id WHERE p.id = ?`).get(id);
  if (!row || row.peer_type !== 'gateway' || !row.enabled) {
    return res.status(404).json({ ok: false, error: 'not_found' });
  }
  const license = require('../../services/license');
  if (!license.hasFeature('gateway_fleet')) {
    return res.status(403).json({ ok: false, error: 'gateway_fleet not licensed' });
  }
  let health = {}; try { health = row.last_health ? JSON.parse(row.last_health) : {}; } catch { /* ignore */ }
  const tel = health.telemetry || {};
  if (!tel.state_dir_writable) {
    return res.status(409).json({ ok: false, error: 'not_migrated' });
  }
  const gateways = require('../../services/gateways');
  const requestId = crypto.randomUUID();
  const target = gateways._normalizeTargetVersion(require('../../services/gatewayRelease').getLatestVersion());
  const r = await gateways.notifySelfUpdate(id, { request_id: requestId, target_version: target });
  if (r && r.skipped === 'cooldown') {
    return res.json({ ok: true, queued: false, reason: 'cooldown' });
  }
  if (!r || r.ok === false) {
    return res.json({ ok: true, queued: false, reason: 'unreachable' });
  }
  gateways.markUpdateRequested(id, requestId, target);
  require('../../services/activity').log('gateway_update_requested',
    `Gateway ${id} update requested (target ${target || 'latest'})`,
    { source: 'admin', severity: 'info', details: { peer_id: id, target, request_id: requestId } });
  res.json({ ok: true, queued: true });
});
```
In `GET '/'`, after building each gateway object, derive + clear-on-terminal:
```js
const st = gatewaysSvc._deriveUpdateState(
  { update_request_id: row.update_request_id, update_requested_at: row.update_requested_at, update_target_version: row.update_target_version },
  health.telemetry || {});
g.update_state = st.state;
g.update_target_version = row.update_target_version || null;
if (st.state === 'done' || st.state === 'failed') gatewaysSvc._clearUpdateTracking(row.id);
```
(Extend the `rows` SELECT in `GET '/'` to also fetch `gm.update_request_id, gm.update_requested_at, gm.update_target_version`.)

- [ ] **Step 4 — run, expect pass.** `NODE_ENV=test node --test tests/api_gateway_update.test.js`.

- [ ] **Step 5 — commit:** `git commit -am "feat(api): POST /api/v1/gateways/:id/update + update_state in list"`

## Task B4: i18n keys + GC.t

**Files:** Modify `src/i18n/en.json`, `src/i18n/de.json`, `templates/default/layout.njk`, `templates/pro/layout.njk`

- [ ] **Step 1 — failing test** (extend the existing i18n parity test, or add `tests/i18n_update_keys.test.js`): assert all of `['gateways.update_confirm','gateways.update_requested','gateways.update_running','gateways.update_done','gateways.update_failed','gateways.update_unknown','gateways.update_dismiss','gateways.update_cooldown','gateways.update_not_migrated','gateways.release_notes','gateways.lbl_image_digest','gateways.lbl_last_pull','gateways.last_pull_never']` exist in BOTH en.json and de.json.

- [ ] **Step 2 — run, expect fail.**

- [ ] **Step 3 — add keys.** `src/i18n/en.json` (before closing `}` of the gateways block):
```
  "gateways.update_confirm": "Update this gateway to the newest published version?",
  "gateways.update_requested": "Update requested (may take a few minutes)",
  "gateways.update_running": "Update running (started {x} ago)",
  "gateways.update_done": "Updated to {x}",
  "gateways.update_failed": "Update failed — rolled back",
  "gateways.update_unknown": "Update status unknown — check the gateway",
  "gateways.update_dismiss": "Dismiss",
  "gateways.update_cooldown": "Please wait a moment before retrying",
  "gateways.update_not_migrated": "This gateway is not set up for auto-update yet",
  "gateways.release_notes": "Release notes",
  "gateways.lbl_image_digest": "Image",
  "gateways.lbl_last_pull": "Last pull",
  "gateways.last_pull_never": "never"
```
`src/i18n/de.json` (matching keys):
```
  "gateways.update_confirm": "Dieses Gateway auf die neueste veröffentlichte Version aktualisieren?",
  "gateways.update_requested": "Update angefordert (kann einige Minuten dauern)",
  "gateways.update_running": "Update läuft (vor {x} angestoßen)",
  "gateways.update_done": "Aktualisiert auf {x}",
  "gateways.update_failed": "Update fehlgeschlagen — zurückgerollt",
  "gateways.update_unknown": "Update-Status unbekannt — Gateway prüfen",
  "gateways.update_dismiss": "Verwerfen",
  "gateways.update_cooldown": "Bitte kurz warten und erneut versuchen",
  "gateways.update_not_migrated": "Dieses Gateway ist noch nicht für Auto-Update eingerichtet",
  "gateways.release_notes": "Release-Notes",
  "gateways.lbl_image_digest": "Image",
  "gateways.lbl_last_pull": "Letztes Pull",
  "gateways.last_pull_never": "nie"
```
(Watch the comma on the previously-last gateways key.) Add the same 13 keys to the `gateways.*` group of `window.GC.t` in BOTH `templates/default/layout.njk` and `templates/pro/layout.njk` using the `'key': {{ t('key') | dump | safe }},` pattern (the last existing gateways key gains a trailing comma).

- [ ] **Step 4 — run, expect pass.** Also `node -e "JSON.parse(require('fs').readFileSync('src/i18n/de.json'));JSON.parse(require('fs').readFileSync('src/i18n/en.json'))"`.

- [ ] **Step 5 — commit:** `git commit -am "feat(i18n): gateway auto-update strings (en+de) + GC.t"`

## Task B5: client — update button + lifecycle banner + telemetry rows

**Files:** Modify `public/js/gateways.js`

- [ ] **Step 1 — implement** (no JS unit harness in repo; verify via `node --check` + manual). In `detailHead(g)`: replace the GitHub `gw-update` link with logic:
  - Compute `us = g.update_state || 'idle'`.
  - Render a secondary GitHub "Release-Notes" link (`T('gateways.release_notes')` → `GW_RELEASES`, target _blank).
  - If `g.health.telemetry.state_dir_writable` AND `g.update_available`: render `<button class="gw-update" data-act="update" data-id=…>` `T('gateways.update_to','Update auf')+' '+latest`; set `disabled` when `us==='updating'`.
  - If telemetry lacks `state_dir_writable` but `update_available`: render the disabled button with `title=T('gateways.update_not_migrated')`.
  - Render a lifecycle banner element under the header when `us!=='idle'`: updating→`update_running`, done→`update_done`, failed→`update_failed`, unknown→`update_unknown` (+ a `data-act="dismiss"` button for unknown).
- In `versionsCard(g)`: add a `kvRow(T('gateways.lbl_image_digest'), shortDigest)` (last 12 of `telemetry.image_digest` after `sha256:` or '—') and `kvRow(T('gateways.lbl_last_pull'), telemetry.last_pull_at ? ago(telemetry.last_pull_at) : T('gateways.last_pull_never'))`.
- In the `detailView` click handler: add `data-act="update"` → `confirm(T('gateways.update_confirm'))` then `POST /api/v1/gateways/<id>/update` with `X-CSRF-Token`; on `{queued:true}` toast `update_requested`, on `{reason:'cooldown'}` toast `update_cooldown`; then `load()`. Add `data-act="dismiss"` → POST nothing, just locally hide (server clears on next terminal/timeout; optional: call a dismiss — out of scope, just hide).

- [ ] **Step 2 — verify.** `node --check public/js/gateways.js`; `grep -c innerHTML public/js/gateways.js` → 0.

- [ ] **Step 3 — commit:** `git commit -am "feat(gateways-ui): update button + lifecycle banner + image/last-pull rows"`

## Task B6: feature doc

**Files:** Create `docs/feature-gateway-auto-update.md`

- [ ] **Step 1 — write** the doc: overview, the request_id lifecycle, the `/state` volume + host setup pointer (to the gateway repo `docs/auto-update.md`), the rollback behavior, security notes, and the sequenced rollout. Force-add (`git add -f`, docs/ is gitignored).

- [ ] **Step 2 — commit:** `git commit -m "docs: gateway auto-update feature writeup"`

## Task B7: finish Part B

- [ ] **Step 1 — full test + lint.** `NODE_ENV=test npx c8 --check-coverage --lines 40 node --test tests/`; `npx eslint src/ public/js/gateways.js` (if configured). Fix any gate failures.
- [ ] **Step 2 — push branch, open PR** in the server repo titled `feat: gateway auto-update trigger (#2b)`.

---

## Self-Review (author)

- **Spec coverage:** request_id lifecycle (B2/B3 + A2/A3/A4), digest-pinned rollback (A4), cooldown scoping (A2 + B3), state_dir_writable gating (A3 + B3 409), version classifier rejecting `unknown` (B2), sticky timeout (B2 `unknown` + B3 no-clear on non-terminal), `/state` volume (A1/A4), telemetry relay (A3), UI button/banner/rows (B5), i18n (B4), docs (A4/B6). All present.
- **Type consistency:** `last_pull_request_id`/`last_pull_ok`/`last_pull_at`/`image_digest`/`state_dir_writable`/`pending_update` are written by `update.sh` (A4) → relayed by telemetry (A3) → read by `_deriveUpdateState` (B2) and the route/UI (B3/B5) with identical names. `request_id` is uuid string end to end.
- **Placeholders:** the i18n `{x}` tokens are interpolated client-side (replace `{x}` with the value) — the client must do the substitution; noted in B5.
- **Deploy order:** companion PR/image first, then nas3 `/state` migration + host task + dry-run, then server PR/deploy (button auto-enables on `state_dir_writable`). Covered in spec §Deployment.
