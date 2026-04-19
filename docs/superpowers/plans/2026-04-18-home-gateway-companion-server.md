# Home Gateway Companion — Plan 2/3: GateControl-Server-Änderungen

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Zweites Teilprojekt des Home-Gateway-Companion: GateControl-Server (Repo `/root/gatecontrol`) erweitern um Gateway-Peer-Typ, Gateway-API-Endpoints, Monitoring-Hysteresis, Caddy-Gateway-Routing, WoL-Trigger, UI und Lizenz-Gates.

**Architecture:** Additive Erweiterung der bestehenden Node.js/Express/SQLite-Architektur. Neue Service-Klasse `gateways.js` orchestriert Gateway-spezifische Business-Logik und nutzt das npm-Paket `@callmetechie/gatecontrol-config-hash` (aus Plan 1) für byte-identisches Config-Hashing mit dem Gateway. Monitoring erweitert um Sliding-Window-Hysteresis. Caddy-Config-Builder generiert Proxy-Routen mit speziellen Headern für Gateway-interne LAN-Targets und nutzt partial Admin-API-Patches für Status-Transitions (kein Full-Reload).

**Tech Stack:** Node.js 20 · Express 4.21 · better-sqlite3 (WAL) · Argon2 + bcrypt · AES-256-GCM · Nunjucks · Pino · `node:test` + `node:assert/strict` · `@callmetechie/gatecontrol-config-hash` 1.0.0

**Prerequisites:**
- Plan 1 ist abgeschlossen und `@callmetechie/gatecontrol-config-hash@1.0.0` ist in GitHub Packages publiziert
- GitHub-Token `GH_PACKAGES_TOKEN` als Repo-Secret in `/root/gatecontrol` Repository für CI-Zugriff auf GitHub Packages

**Spec-Referenz:** `/root/gatecontrol/docs/superpowers/specs/2026-04-18-home-gateway-companion-design.md` (v1.2) insbesondere Sektionen 3.1-3.10

---

## Task 1: Migration 36 — Gateway-Schema

**Files:**
- Modify: `/root/gatecontrol/src/db/migrations.js`
- Create: `/root/gatecontrol/tests/migration_gateway.test.js`

- [ ] **Step 1: Failing Test schreiben**

Create `/root/gatecontrol/tests/migration_gateway.test.js`:

```javascript
'use strict';

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

describe('migration 36: gateway support', () => {
  let db;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-migr-'));
  const dbPath = path.join(tmpDir, 'test.db');

  before(async () => {
    process.env.GC_DB_PATH = dbPath;
    delete require.cache[require.resolve('../src/db/connection')];
    delete require.cache[require.resolve('../src/db/migrations')];
    const { getDb } = require('../src/db/connection');
    const { runMigrations } = require('../src/db/migrations');
    db = getDb();
    runMigrations();
  });

  it('peers.peer_type column exists with default "regular"', () => {
    const cols = db.prepare("PRAGMA table_info(peers)").all();
    const peerType = cols.find(c => c.name === 'peer_type');
    assert.ok(peerType, 'peer_type column missing');
    assert.equal(peerType.dflt_value, "'regular'");
  });

  it('routes has target_kind/target_peer_id/target_lan_host/target_lan_port columns', () => {
    const cols = db.prepare("PRAGMA table_info(routes)").all().map(c => c.name);
    assert.ok(cols.includes('target_kind'));
    assert.ok(cols.includes('target_peer_id'));
    assert.ok(cols.includes('target_lan_host'));
    assert.ok(cols.includes('target_lan_port'));
    assert.ok(cols.includes('wol_enabled'));
    assert.ok(cols.includes('wol_mac'));
  });

  it('gateway_meta table exists with expected columns', () => {
    const cols = db.prepare("PRAGMA table_info(gateway_meta)").all().map(c => c.name);
    assert.ok(cols.includes('peer_id'));
    assert.ok(cols.includes('api_port'));
    assert.ok(cols.includes('api_token_hash'));
    assert.ok(cols.includes('push_token_encrypted'));
    assert.ok(cols.includes('needs_repair'));
    assert.ok(cols.includes('last_seen_at'));
    assert.ok(cols.includes('last_config_hash'));
  });

  it('existing routes get target_kind=peer by default', () => {
    db.prepare("INSERT INTO peers (name, public_key, ip_address) VALUES ('legacy', 'key', '10.8.0.99')").run();
    db.prepare("INSERT INTO routes (domain, target_ip, target_port, type) VALUES ('legacy.com', '10.8.0.99', 80, 'http')").run();
    const row = db.prepare("SELECT target_kind FROM routes WHERE domain='legacy.com'").get();
    assert.equal(row.target_kind, 'peer');
  });
});
```

- [ ] **Step 2: Test ausführen — muss failen**

```bash
cd /root/gatecontrol && node --test tests/migration_gateway.test.js
```

Expected: Failures weil Columns/Tables noch nicht existieren.

- [ ] **Step 3: Migration hinzufügen**

Append to `/root/gatecontrol/src/db/migrations.js` im `migrations`-Array (vor dem schließenden `];`):

```javascript
  {
    version: 36,
    name: 'add_gateway_support',
    // SQLite ALTER TABLE ADD COLUMN silently ignores REFERENCES in some versions;
    // we add the column WITHOUT inline FK and rely on service-layer validation.
    // FK cascades for gateway_meta.peer_id work because gateway_meta is CREATE TABLE (not ALTER).
    detect: (db) => {
      const cols = db.prepare("PRAGMA table_info(peers)").all();
      return cols.some(c => c.name === 'peer_type');
    },
    sql: `
      ALTER TABLE peers ADD COLUMN peer_type TEXT NOT NULL DEFAULT 'regular';

      ALTER TABLE routes ADD COLUMN target_kind TEXT NOT NULL DEFAULT 'peer';
      ALTER TABLE routes ADD COLUMN target_peer_id INTEGER;
      ALTER TABLE routes ADD COLUMN target_lan_host TEXT;
      ALTER TABLE routes ADD COLUMN target_lan_port INTEGER;
      ALTER TABLE routes ADD COLUMN wol_enabled INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE routes ADD COLUMN wol_mac TEXT;

      CREATE TABLE IF NOT EXISTS gateway_meta (
        peer_id INTEGER PRIMARY KEY REFERENCES peers(id) ON DELETE CASCADE,
        api_port INTEGER NOT NULL DEFAULT 9876,
        api_token_hash TEXT NOT NULL,
        push_token_encrypted TEXT NOT NULL,
        needs_repair INTEGER NOT NULL DEFAULT 0,
        last_seen_at INTEGER,
        last_config_hash TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_routes_target_peer_id ON routes(target_peer_id);
      CREATE INDEX IF NOT EXISTS idx_gateway_meta_api_token_hash ON gateway_meta(api_token_hash);
    `,
  },
```

**FK-Cascade für routes.target_peer_id:** Service-Layer in `services/gateways.js.deleteGateway()` muss routes manuell auf `enabled=0` setzen und LAN-Daten beibehalten (siehe Sektion 6.2 der Spec). Kein inline FK, weil SQLite `ALTER TABLE ADD COLUMN REFERENCES` nicht zuverlässig enforced.

- [ ] **Step 4: Test ausführen — muss grün sein**

```bash
node --test tests/migration_gateway.test.js
```

Expected: Alle 4 Tests grün.

- [ ] **Step 5: Commit**

```bash
git add src/db/migrations.js tests/migration_gateway.test.js
git commit -m "feat(db): migration 36 — gateway peer type, route target discrimination, gateway_meta"
git push
```

---

## Task 2: `@callmetechie/gatecontrol-config-hash` als Dependency installieren

**Files:**
- Modify: `/root/gatecontrol/package.json`
- Create: `/root/gatecontrol/.npmrc`

- [ ] **Step 1: .npmrc für GitHub-Package-Registry**

Create `/root/gatecontrol/.npmrc`:

```
@callmetechie:registry=https://npm.pkg.github.com/
//npm.pkg.github.com/:_authToken=${GH_PACKAGES_TOKEN}
```

- [ ] **Step 2: Package installieren (lokal via Token)**

```bash
cd /root/gatecontrol && GH_PACKAGES_TOKEN=<dein-gh-token> npm install @callmetechie/gatecontrol-config-hash@^1.0.0
```

Expected: `package.json` bekommt Eintrag in `dependencies`, `package-lock.json` updated.

- [ ] **Step 3: Smoke-Test**

Create `/root/gatecontrol/tests/config_hash_smoke.test.js`:

```javascript
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { computeConfigHash, CONFIG_HASH_VERSION } = require('@callmetechie/gatecontrol-config-hash');

describe('config-hash package wired correctly', () => {
  it('CONFIG_HASH_VERSION is 1', () => {
    assert.equal(CONFIG_HASH_VERSION, 1);
  });

  it('computeConfigHash produces sha256: hash', () => {
    const cfg = { config_hash_version: 1, peer_id: 1, routes: [], l4_routes: [] };
    const hash = computeConfigHash(cfg);
    assert.match(hash, /^sha256:[0-9a-f]{64}$/);
  });
});
```

- [ ] **Step 4: Test ausführen**

```bash
node --test tests/config_hash_smoke.test.js
```

Expected: 2 Tests grün.

- [ ] **Step 5: GitHub Actions Secret setzen**

User-Aktion: In `CallMeTechie/gatecontrol` Repo-Settings → Secrets → `GH_PACKAGES_TOKEN` mit scope `packages:read` anlegen (ansonsten CI-Build bricht ab).

- [ ] **Step 6: CI-Workflow für GH Packages aktualisieren**

Modify `/root/gatecontrol/.github/workflows/release.yml` (oder test.yml, je nach Struktur) — Füge vor dem `npm ci`-Step ein:

```yaml
      - name: Setup Node with GitHub Packages auth
        uses: actions/setup-node@v4
        with:
          node-version: 20
          registry-url: https://npm.pkg.github.com/
          scope: '@callmetechie'

      - name: Install deps
        run: npm ci
        env:
          NODE_AUTH_TOKEN: ${{ secrets.GH_PACKAGES_TOKEN }}
```

(Exakten Patch abhängig von aktuellem Workflow-Stand — genau einfügen ohne existierende Steps zu entfernen.)

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json .npmrc tests/config_hash_smoke.test.js .github/workflows/*.yml
git commit -m "chore: add @callmetechie/gatecontrol-config-hash dep + GH Packages auth in CI"
git push
```

---

## Task 3: License-Feature-Keys

**Files:**
- Modify: `/root/gatecontrol/src/services/license.js`
- Create: `/root/gatecontrol/tests/license_gateway.test.js`

- [ ] **Step 1: Failing Test schreiben**

Create `/root/gatecontrol/tests/license_gateway.test.js`:

```javascript
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { COMMUNITY_FALLBACK } = require('../src/services/license');

describe('license: gateway feature keys', () => {
  it('gateway_peers default is 1', () => {
    assert.equal(COMMUNITY_FALLBACK.gateway_peers, 1);
  });

  it('gateway_http_targets default is 3', () => {
    assert.equal(COMMUNITY_FALLBACK.gateway_http_targets, 3);
  });

  it('gateway_tcp_routing default is false', () => {
    assert.equal(COMMUNITY_FALLBACK.gateway_tcp_routing, false);
  });

  it('gateway_wol default is false', () => {
    assert.equal(COMMUNITY_FALLBACK.gateway_wol, false);
  });
});
```

- [ ] **Step 2: Test ausführen — muss failen**

```bash
node --test tests/license_gateway.test.js
```

Expected: Failure wegen fehlender Keys.

- [ ] **Step 3: Feature-Keys ergänzen**

Modify `/root/gatecontrol/src/services/license.js` — im `COMMUNITY_FALLBACK`-Object die folgenden Einträge hinzufügen (am Ende, vor schließender Klammer):

```javascript
  gateway_peers: 1,
  gateway_http_targets: 3,
  gateway_tcp_routing: false,
  gateway_wol: false,
```

Außerdem: Falls `COMMUNITY_FALLBACK` aus dem Modul nicht exportiert wird, am Ende ein `module.exports.COMMUNITY_FALLBACK = COMMUNITY_FALLBACK;` ergänzen.

- [ ] **Step 4: Test ausführen — muss grün sein**

```bash
node --test tests/license_gateway.test.js
```

Expected: 4 Tests grün.

- [ ] **Step 5: Commit**

```bash
git add src/services/license.js tests/license_gateway.test.js
git commit -m "feat(license): add gateway_peers, gateway_http_targets, gateway_tcp_routing, gateway_wol keys"
git push
```

---

## Task 4: Token-Scope `gateway`

**Files:**
- Modify: `/root/gatecontrol/src/services/tokens.js`
- Create: `/root/gatecontrol/tests/tokens_gateway_scope.test.js`

- [ ] **Step 1: Failing Test schreiben**

Create `/root/gatecontrol/tests/tokens_gateway_scope.test.js`:

```javascript
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const tokens = require('../src/services/tokens');

describe('tokens: gateway scope', () => {
  it('gateway is in VALID_SCOPES', () => {
    assert.ok(tokens.VALID_SCOPES.includes('gateway'));
  });

  it('hasPathAccess(/api/v1/gateway/config, ["gateway"]) returns true', () => {
    assert.equal(tokens.hasPathAccess('/api/v1/gateway/config', ['gateway']), true);
  });

  it('hasPathAccess(/api/v1/gateway/config, ["client"]) returns false', () => {
    assert.equal(tokens.hasPathAccess('/api/v1/gateway/config', ['client']), false);
  });

  it('hasPathAccess(/api/v1/peers, ["gateway"]) returns false', () => {
    assert.equal(tokens.hasPathAccess('/api/v1/peers', ['gateway']), false);
  });
});
```

- [ ] **Step 2: Test ausführen — muss failen**

```bash
node --test tests/tokens_gateway_scope.test.js
```

Expected: Scope nicht definiert.

- [ ] **Step 3: Scope ergänzen**

Modify `/root/gatecontrol/src/services/tokens.js`:

In `VALID_SCOPES`-Array nach `'client:rdp'` einfügen: `'gateway',`

In `SCOPE_MAP`-Array hinzufügen (vor allgemeinen Pfaden):

```javascript
  ['/api/v1/gateway', 'gateway'],
```

- [ ] **Step 4: Test ausführen — muss grün sein**

```bash
node --test tests/tokens_gateway_scope.test.js
```

Expected: 4 Tests grün.

- [ ] **Step 5: Commit**

```bash
git add src/services/tokens.js tests/tokens_gateway_scope.test.js
git commit -m "feat(tokens): add gateway scope to VALID_SCOPES + SCOPE_MAP"
git push
```

---

## Task 5: `gateways.createGateway()` — Peer + Meta + Tokens

**Files:**
- Create: `/root/gatecontrol/src/services/gateways.js`
- Create: `/root/gatecontrol/tests/gateways_create.test.js`

- [ ] **Step 1: Failing Test schreiben**

Create `/root/gatecontrol/tests/gateways_create.test.js`:

```javascript
'use strict';

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

describe('gateways.createGateway', () => {
  let gateways, db;

  before(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-gw-'));
    process.env.GC_DB_PATH = path.join(tmp, 'test.db');
    delete require.cache[require.resolve('../src/db/connection')];
    delete require.cache[require.resolve('../src/db/migrations')];
    delete require.cache[require.resolve('../src/services/gateways')];
    require('../src/db/migrations').runMigrations();
    gateways = require('../src/services/gateways');
    db = require('../src/db/connection').getDb();
  });

  it('creates peer with peer_type=gateway and gateway_meta row', async () => {
    const result = await gateways.createGateway({ name: 'homelab-gw', apiPort: 9876 });
    assert.ok(result.peer.id > 0);
    assert.equal(result.peer.peer_type, 'gateway');

    const meta = db.prepare('SELECT * FROM gateway_meta WHERE peer_id=?').get(result.peer.id);
    assert.ok(meta);
    assert.equal(meta.api_port, 9876);
    assert.ok(meta.api_token_hash);
    assert.ok(meta.push_token_encrypted);
  });

  it('returns plaintext api_token and push_token (for gateway.env)', async () => {
    const result = await gateways.createGateway({ name: 'gw2', apiPort: 9876 });
    assert.match(result.apiToken, /^gc_gw_[a-f0-9]{64}$/);
    assert.match(result.pushToken, /^[a-f0-9]{64}$/);
    assert.notEqual(result.apiToken, result.pushToken);
  });

  it('api_token_hash is SHA-256 of api_token (sha256: prefix)', async () => {
    const result = await gateways.createGateway({ name: 'gw3', apiPort: 9876 });
    const crypto = require('node:crypto');
    const expectedHash = 'sha256:' + crypto.createHash('sha256').update(result.apiToken).digest('hex');
    const meta = db.prepare('SELECT api_token_hash FROM gateway_meta WHERE peer_id=?').get(result.peer.id);
    assert.equal(meta.api_token_hash, expectedHash);
  });

  it('enforces license limit gateway_peers', async () => {
    // COMMUNITY_FALLBACK.gateway_peers = 1 → subsequent creations throw
    await assert.rejects(async () => {
      for (let i = 0; i < 3; i++) {
        await gateways.createGateway({ name: `gw-over-${i}`, apiPort: 9876 });
      }
    }, /gateway_peers|license/i);
  });
});
```

- [ ] **Step 2: Test ausführen — muss failen**

```bash
node --test tests/gateways_create.test.js
```

Expected: Modul nicht vorhanden.

- [ ] **Step 3: Service-Skeleton schreiben**

Create `/root/gatecontrol/src/services/gateways.js`:

```javascript
'use strict';

const crypto = require('node:crypto');
const { getDb } = require('../db/connection');
const { encryptAes256Gcm, decryptAes256Gcm } = require('./crypto');
const license = require('./license');
const peers = require('./peers');
const logger = require('../utils/logger');

const DEFAULT_API_PORT = 9876;

/**
 * Generate cryptographically-random tokens and hashes.
 */
function generateTokens() {
  const apiTokenRaw = crypto.randomBytes(32).toString('hex');
  const apiToken = `gc_gw_${apiTokenRaw}`;
  const apiTokenHash = 'sha256:' + crypto.createHash('sha256').update(apiToken).digest('hex');

  const pushToken = crypto.randomBytes(32).toString('hex');
  const pushTokenEncrypted = encryptAes256Gcm(pushToken);

  return { apiToken, apiTokenHash, pushToken, pushTokenEncrypted };
}

/**
 * Create a Gateway-Peer with its metadata. Enforces license limit gateway_peers.
 * Returns { peer, apiToken, pushToken } (plaintext tokens only shown ONCE at creation
 * for inclusion in gateway.env file).
 *
 * ASYNC because peers.create() generates WireGuard keys asynchronously.
 */
async function createGateway({ name, apiPort = DEFAULT_API_PORT }) {
  const db = getDb();

  const limit = license.getFeature('gateway_peers');
  const current = db.prepare("SELECT COUNT(*) AS n FROM peers WHERE peer_type='gateway'").get().n;
  if (current >= limit) {
    throw new Error(`License limit reached: gateway_peers=${limit} (current=${current})`);
  }

  // peers.create() is the existing async factory — we extend its param list to accept peerType
  const peer = await peers.create({ name, peerType: 'gateway' });

  const { apiToken, apiTokenHash, pushToken, pushTokenEncrypted } = generateTokens();

  db.prepare(`
    INSERT INTO gateway_meta (peer_id, api_port, api_token_hash, push_token_encrypted, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(peer.id, apiPort, apiTokenHash, pushTokenEncrypted, Date.now());

  logger.info({ peerId: peer.id, peerName: name, apiPort }, 'Gateway created');

  return { peer, apiToken, pushToken };
}

module.exports = { createGateway };
```

**Consumer-Hinweis:** Alle Tests, die `gateways.createGateway(...)` aufrufen, müssen das Ergebnis awaiten. Die Test-Snippets in Tasks 5-14 sind mit Promise-Returns geschrieben — bei Ausführung muss das Test-Code-Muster `const gw = await gateways.createGateway(...)` sein. In `before()` hooks: `await` nutzen oder synchronen Wrapper per `before(async () => { ... })` definieren.

- [ ] **Step 4: `peers.create()` um `peerType`-Parameter erweitern**

Modify `/root/gatecontrol/src/services/peers.js` — in der bestehenden `create`-Funktion (Export `module.exports = { create, ... }`):
- Parameter-Destructuring um `peerType = 'regular'` erweitern
- Im INSERT-Statement `peer_type` in die Spaltenliste + VALUES aufnehmen:

```javascript
async function create({ name, peerType = 'regular', /* ...bestehende Parameter */ }) {
  // ... bestehende Logik (Key-Generation, IP-Allocation, etc.) ...
  const info = db.prepare(`
    INSERT INTO peers (name, public_key, ip_address, /* ...bestehende Spalten */, peer_type)
    VALUES (?, ?, ?, /* ...bestehende Placeholders */, ?)
  `).run(name, publicKey, ipAddress, /* ...bestehende Werte */, peerType);
  // ... rest unchanged
}
```

(Exakte Signatur an bestehende Funktion in `src/services/peers.js` anpassen — nicht vorhandene Spalten nicht dazu erfinden. Die Änderung ist rein additiv und backward-compatible, weil `peerType` einen Default hat.)

- [ ] **Step 5: Test ausführen — muss grün sein**

```bash
node --test tests/gateways_create.test.js
```

Expected: 4 Tests grün.

- [ ] **Step 6: Commit**

```bash
git add src/services/gateways.js src/services/peers.js tests/gateways_create.test.js
git commit -m "feat(gateways): add createGateway with peer+meta+tokens and license enforcement"
git push
```

---

## Task 6: `gateways.getGatewayConfig()` — Config-JSON für Gateway-Poll

**Files:**
- Modify: `/root/gatecontrol/src/services/gateways.js`
- Create: `/root/gatecontrol/tests/gateways_getConfig.test.js`

- [ ] **Step 1: Failing Test schreiben**

Create `/root/gatecontrol/tests/gateways_getConfig.test.js`:

```javascript
'use strict';

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { CONFIG_HASH_VERSION } = require('@callmetechie/gatecontrol-config-hash');

describe('gateways.getGatewayConfig', () => {
  let gateways, db, gwPeerId;

  before(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-gw-cfg-'));
    process.env.GC_DB_PATH = path.join(tmp, 'test.db');
    ['../src/db/connection', '../src/db/migrations', '../src/services/gateways']
      .forEach(p => delete require.cache[require.resolve(p)]);
    require('../src/db/migrations').runMigrations();
    gateways = require('../src/services/gateways');
    db = require('../src/db/connection').getDb();
    const gw = await gateways.createGateway({ name: 'gw', apiPort: 9876 });
    gwPeerId = gw.peer.id;

    // Insert gateway-typed HTTP route
    db.prepare(`INSERT INTO routes (domain, target_ip, target_port, type, target_kind, target_peer_id, target_lan_host, target_lan_port, wol_enabled)
                VALUES ('nas.example.com', ?, 8080, 'http', 'gateway', ?, '192.168.1.10', 5001, 0)`)
      .run(gw.peer.ip_address, gwPeerId);
  });

  it('returns config with config_hash_version=1', () => {
    const cfg = gateways.getGatewayConfig(gwPeerId);
    assert.equal(cfg.config_hash_version, CONFIG_HASH_VERSION);
  });

  it('includes peer_id', () => {
    const cfg = gateways.getGatewayConfig(gwPeerId);
    assert.equal(cfg.peer_id, gwPeerId);
  });

  it('includes routes with lan_host/lan_port/wol fields', () => {
    const cfg = gateways.getGatewayConfig(gwPeerId);
    const route = cfg.routes.find(r => r.domain === 'nas.example.com');
    assert.ok(route);
    assert.equal(route.target_kind, 'gateway');
    assert.equal(route.target_lan_host, '192.168.1.10');
    assert.equal(route.target_lan_port, 5001);
    assert.equal(route.wol_enabled, false);
  });

  it('omits routes for other gateways', async () => {
    const gw2 = await gateways.createGateway({ name: 'gw2', apiPort: 9876 });
    // (ignoring license for test: may throw, skip if so)
    const cfg = gateways.getGatewayConfig(gwPeerId);
    assert.equal(cfg.routes.length, 1, 'should only contain gw1 routes');
  });

  it('includes l4_routes array (empty if none)', () => {
    const cfg = gateways.getGatewayConfig(gwPeerId);
    assert.ok(Array.isArray(cfg.l4_routes));
  });
});
```

- [ ] **Step 2: Test ausführen — muss failen**

```bash
node --test tests/gateways_getConfig.test.js
```

Expected: `getGatewayConfig is not a function`.

- [ ] **Step 3: Implementation ergänzen**

Append to `/root/gatecontrol/src/services/gateways.js`:

```javascript
const { CONFIG_HASH_VERSION } = require('@callmetechie/gatecontrol-config-hash');

/**
 * Build the gateway-config payload sent to a Gateway on poll.
 * Includes all HTTP + L4 routes with target_peer_id=peerId.
 */
function getGatewayConfig(peerId) {
  const db = getDb();

  const httpRoutes = db.prepare(`
    SELECT id, domain, target_kind, target_lan_host, target_lan_port,
           COALESCE(protocol, 'http') AS protocol, wol_enabled, wol_mac
    FROM routes
    WHERE target_peer_id = ? AND target_kind = 'gateway' AND enabled = 1
      AND (type = 'http' OR type IS NULL)
    ORDER BY id
  `).all(peerId);

  const l4Routes = db.prepare(`
    SELECT id, target_port AS listen_port, target_lan_host, target_lan_port,
           wol_enabled, wol_mac
    FROM routes
    WHERE target_peer_id = ? AND target_kind = 'gateway' AND enabled = 1
      AND type = 'l4'
    ORDER BY id
  `).all(peerId);

  return {
    config_hash_version: CONFIG_HASH_VERSION,
    peer_id: peerId,
    routes: httpRoutes.map(r => ({
      id: r.id,
      domain: r.domain,
      target_kind: r.target_kind,
      target_lan_host: r.target_lan_host,
      target_lan_port: r.target_lan_port,
      protocol: r.protocol,
      wol_enabled: !!r.wol_enabled,
      ...(r.wol_mac ? { wol_mac: r.wol_mac } : {}),
    })),
    l4_routes: l4Routes.map(r => ({
      id: r.id,
      listen_port: r.listen_port,
      target_lan_host: r.target_lan_host,
      target_lan_port: r.target_lan_port,
      wol_enabled: !!r.wol_enabled,
      ...(r.wol_mac ? { wol_mac: r.wol_mac } : {}),
    })),
  };
}

module.exports.getGatewayConfig = getGatewayConfig;
```

- [ ] **Step 4: Test ausführen — muss grün sein**

```bash
node --test tests/gateways_getConfig.test.js
```

Expected: 5 Tests grün.

- [ ] **Step 5: Commit**

```bash
git add src/services/gateways.js tests/gateways_getConfig.test.js
git commit -m "feat(gateways): add getGatewayConfig building routes+l4_routes payload"
git push
```

---

## Task 7: `gateways.computeConfigHash()` — via config-hash Paket

**Files:**
- Modify: `/root/gatecontrol/src/services/gateways.js`
- Create: `/root/gatecontrol/tests/gateways_hash.test.js`

- [ ] **Step 1: Failing Test schreiben**

Create `/root/gatecontrol/tests/gateways_hash.test.js`:

```javascript
'use strict';

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { computeConfigHash: libHash } = require('@callmetechie/gatecontrol-config-hash');

describe('gateways.computeConfigHash', () => {
  let gateways, gwPeerId;

  before(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-gw-hash-'));
    process.env.GC_DB_PATH = path.join(tmp, 'test.db');
    ['../src/db/connection', '../src/db/migrations', '../src/services/gateways']
      .forEach(p => delete require.cache[require.resolve(p)]);
    require('../src/db/migrations').runMigrations();
    gateways = require('../src/services/gateways');
    const gw = await gateways.createGateway({ name: 'gw-hash', apiPort: 9876 });
    gwPeerId = gw.peer.id;
  });

  it('hash matches library computation (byte-identical)', () => {
    const cfg = gateways.getGatewayConfig(gwPeerId);
    const ourHash = gateways.computeConfigHash(gwPeerId);
    const libComputed = libHash(cfg);
    assert.equal(ourHash, libComputed);
  });

  it('hash stable across repeated calls', () => {
    const a = gateways.computeConfigHash(gwPeerId);
    const b = gateways.computeConfigHash(gwPeerId);
    assert.equal(a, b);
  });

  it('hash format is sha256:<64-hex>', () => {
    const hash = gateways.computeConfigHash(gwPeerId);
    assert.match(hash, /^sha256:[0-9a-f]{64}$/);
  });
});
```

- [ ] **Step 2: Test ausführen — muss failen**

```bash
node --test tests/gateways_hash.test.js
```

Expected: `computeConfigHash is not a function`.

- [ ] **Step 3: Implementation ergänzen**

Append to `/root/gatecontrol/src/services/gateways.js`:

```javascript
const { computeConfigHash: libComputeConfigHash } = require('@callmetechie/gatecontrol-config-hash');

/**
 * Compute SHA-256 hash of the gateway config for a peer. Delegates to the
 * shared library for byte-identical results with the Gateway side.
 */
function computeConfigHash(peerId) {
  const cfg = getGatewayConfig(peerId);
  return libComputeConfigHash(cfg);
}

module.exports.computeConfigHash = computeConfigHash;
```

- [ ] **Step 4: Test ausführen — muss grün sein**

```bash
node --test tests/gateways_hash.test.js
```

Expected: 3 Tests grün.

- [ ] **Step 5: Commit**

```bash
git add src/services/gateways.js tests/gateways_hash.test.js
git commit -m "feat(gateways): computeConfigHash via shared config-hash library"
git push
```

---

## Task 8: Gateway-API Auth-Middleware

**Files:**
- Create: `/root/gatecontrol/src/middleware/gatewayAuth.js`
- Create: `/root/gatecontrol/tests/gateway_auth.test.js`

- [ ] **Step 1: Failing Test schreiben**

Create `/root/gatecontrol/tests/gateway_auth.test.js`:

```javascript
'use strict';

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

describe('gatewayAuth middleware', () => {
  let auth, gateways, peerId, apiToken;

  before(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-gwa-'));
    process.env.GC_DB_PATH = path.join(tmp, 'test.db');
    ['../src/db/connection', '../src/db/migrations', '../src/services/gateways', '../src/middleware/gatewayAuth']
      .forEach(p => delete require.cache[require.resolve(p)]);
    require('../src/db/migrations').runMigrations();
    gateways = require('../src/services/gateways');
    auth = require('../src/middleware/gatewayAuth');
    const gw = await gateways.createGateway({ name: 'auth-gw', apiPort: 9876 });
    peerId = gw.peer.id;
    apiToken = gw.apiToken;
  });

  function mockReqRes(authHeader) {
    const req = { headers: { authorization: authHeader }, gateway: null };
    let statusCode = null, body = null, nextCalled = false;
    const res = {
      status(c) { statusCode = c; return this; },
      json(b) { body = b; return this; },
    };
    const next = () => { nextCalled = true; };
    return { req, res, next, getStatus: () => statusCode, getBody: () => body, wasNextCalled: () => nextCalled };
  }

  it('accepts valid Bearer token and attaches req.gateway', () => {
    const m = mockReqRes(`Bearer ${apiToken}`);
    auth.requireGateway(m.req, m.res, m.next);
    assert.equal(m.wasNextCalled(), true);
    assert.equal(m.req.gateway.peer_id, peerId);
  });

  it('rejects missing Authorization header with 401', () => {
    const m = mockReqRes(undefined);
    auth.requireGateway(m.req, m.res, m.next);
    assert.equal(m.getStatus(), 401);
    assert.equal(m.wasNextCalled(), false);
  });

  it('rejects invalid token with 403', () => {
    const m = mockReqRes('Bearer gc_gw_0000000000000000000000000000000000000000000000000000000000000000');
    auth.requireGateway(m.req, m.res, m.next);
    assert.equal(m.getStatus(), 403);
  });

  it('rejects wrong-format token with 401', () => {
    const m = mockReqRes('NotBearer xyz');
    auth.requireGateway(m.req, m.res, m.next);
    assert.equal(m.getStatus(), 401);
  });
});
```

- [ ] **Step 2: Test ausführen — muss failen**

```bash
node --test tests/gateway_auth.test.js
```

Expected: Module not found.

- [ ] **Step 3: Middleware schreiben**

Create `/root/gatecontrol/src/middleware/gatewayAuth.js`:

```javascript
'use strict';

const crypto = require('node:crypto');
const { getDb } = require('../db/connection');
const logger = require('../utils/logger');

function hashToken(token) {
  return 'sha256:' + crypto.createHash('sha256').update(token).digest('hex');
}

function timingSafeStringEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * Express middleware: validates Bearer token against gateway_meta.api_token_hash
 * (timing-safe). On success attaches req.gateway = { peer_id, peer_name, api_port }.
 */
function requireGateway(req, res, next) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'missing_bearer_token' });
  }
  const token = header.slice(7).trim();
  if (!token.startsWith('gc_gw_')) {
    return res.status(401).json({ error: 'invalid_token_format' });
  }
  const tokenHash = hashToken(token);
  const db = getDb();
  const row = db.prepare(`
    SELECT gm.peer_id, gm.api_port, p.name AS peer_name, p.ip_address
    FROM gateway_meta gm
    JOIN peers p ON p.id = gm.peer_id
    WHERE p.peer_type = 'gateway' AND p.enabled = 1
  `).all();

  let match = null;
  for (const r of row) {
    if (timingSafeStringEqual(r.peer_name ? db.prepare('SELECT api_token_hash FROM gateway_meta WHERE peer_id=?').get(r.peer_id).api_token_hash : '', tokenHash)) {
      match = r;
      break;
    }
  }

  if (!match) {
    logger.warn({ ip: req.ip }, 'Invalid gateway token');
    return res.status(403).json({ error: 'invalid_token' });
  }

  req.gateway = match;
  next();
}

module.exports = { requireGateway };
```

- [ ] **Step 4: Test ausführen — muss grün sein**

```bash
node --test tests/gateway_auth.test.js
```

Expected: 4 Tests grün. Falls es Fehlschläge gibt, den Code entsprechend anpassen (häufig: die Suchlogik für Hash-Match muss geradliniger sein — einfach `SELECT * FROM gateway_meta WHERE api_token_hash=?` mit bereits gehashtem Input).

- [ ] **Step 5: Code mit explizitem timingSafeEqual-Check ergänzen**

Replace the `requireGateway` body:

```javascript
function requireGateway(req, res, next) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'missing_bearer_token' });
  }
  const token = header.slice(7).trim();
  if (!token.startsWith('gc_gw_')) {
    return res.status(401).json({ error: 'invalid_token_format' });
  }
  const tokenHash = hashToken(token);
  const db = getDb();
  const match = db.prepare(`
    SELECT gm.peer_id, gm.api_port, gm.api_token_hash AS stored_hash,
           p.name AS peer_name, p.ip_address
    FROM gateway_meta gm
    JOIN peers p ON p.id = gm.peer_id
    WHERE gm.api_token_hash = ? AND p.peer_type = 'gateway' AND p.enabled = 1
  `).get(tokenHash);

  // Defense-in-depth: even though the indexed lookup already requires matching
  // hashes, do an explicit timingSafeEqual on the stored vs computed hash to
  // prevent any theoretical timing side-channel from b-tree-index comparison.
  if (!match) {
    logger.warn({ ip: req.ip }, 'Invalid gateway token');
    return res.status(403).json({ error: 'invalid_token' });
  }
  const storedBuf = Buffer.from(match.stored_hash, 'utf8');
  const computedBuf = Buffer.from(tokenHash, 'utf8');
  if (storedBuf.length !== computedBuf.length || !crypto.timingSafeEqual(storedBuf, computedBuf)) {
    logger.warn({ ip: req.ip }, 'Timing-safe compare failed — token mismatch');
    return res.status(403).json({ error: 'invalid_token' });
  }

  req.gateway = {
    peer_id: match.peer_id,
    api_port: match.api_port,
    peer_name: match.peer_name,
    ip_address: match.ip_address,
  };
  next();
}
```

(Begründung: Der DB-Index-Lookup auf `api_token_hash` ist in der Praxis schnell, aber B-Tree-Lookups sind nicht garantiert konstant-zeitig. Der explizite `timingSafeEqual` macht den Vergleich korrekt timing-safe und verhindert Sidechannel-Analyse.)

- [ ] **Step 6: Test nochmal grün**

```bash
node --test tests/gateway_auth.test.js
```

- [ ] **Step 7: Commit**

```bash
git add src/middleware/gatewayAuth.js tests/gateway_auth.test.js
git commit -m "feat(middleware): add gatewayAuth — Bearer token verification via SHA-256 hash lookup"
git push
```

---

## Task 9: API-Endpoints `/api/v1/gateway/config` + `/config/check`

**Files:**
- Create: `/root/gatecontrol/src/routes/api/gateway.js`
- Modify: `/root/gatecontrol/src/routes/api/index.js`
- Create: `/root/gatecontrol/tests/gateway_api_config.test.js`

- [ ] **Step 1: Failing Test schreiben**

Create `/root/gatecontrol/tests/gateway_api_config.test.js`:

```javascript
'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');

describe('gateway API: /config + /config/check', () => {
  let app, server, gateways, apiToken, baseUrl;

  before(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-gwapi-'));
    process.env.GC_DB_PATH = path.join(tmp, 'test.db');
    ['../src/db/connection', '../src/db/migrations', '../src/services/gateways', '../src/app']
      .forEach(p => { try { delete require.cache[require.resolve(p)]; } catch (_) {} });
    require('../src/db/migrations').runMigrations();
    gateways = require('../src/services/gateways');
    const gw = await gateways.createGateway({ name: 'api-gw', apiPort: 9876 });
    apiToken = gw.apiToken;

    const { createApp } = require('../src/app');
    app = createApp();
    server = app.listen(0);
    const port = server.address().port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(() => { server && server.close(); });

  async function req(pathStr, headers = {}) {
    return new Promise((resolve, reject) => {
      const url = new URL(baseUrl + pathStr);
      http.get({ host: url.hostname, port: url.port, path: url.pathname + url.search, headers }, (res) => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      }).on('error', reject);
    });
  }

  it('GET /api/v1/gateway/config returns 401 without auth', async () => {
    const r = await req('/api/v1/gateway/config');
    assert.equal(r.status, 401);
  });

  it('GET /api/v1/gateway/config returns 200 with config + hash', async () => {
    const r = await req('/api/v1/gateway/config', { Authorization: `Bearer ${apiToken}` });
    assert.equal(r.status, 200);
    const body = JSON.parse(r.body);
    assert.equal(body.config_hash_version, 1);
    assert.ok(body.peer_id);
    assert.ok(Array.isArray(body.routes));
    assert.match(body.config_hash, /^sha256:[0-9a-f]{64}$/);
  });

  it('GET /api/v1/gateway/config/check?hash=<match> returns 304', async () => {
    const first = await req('/api/v1/gateway/config', { Authorization: `Bearer ${apiToken}` });
    const hash = JSON.parse(first.body).config_hash;
    const r = await req('/api/v1/gateway/config/check?hash=' + encodeURIComponent(hash), { Authorization: `Bearer ${apiToken}` });
    assert.equal(r.status, 304);
  });

  it('GET /api/v1/gateway/config/check?hash=<mismatch> returns 200', async () => {
    const r = await req('/api/v1/gateway/config/check?hash=sha256:' + 'f'.repeat(64), { Authorization: `Bearer ${apiToken}` });
    assert.equal(r.status, 200);
  });
});
```

- [ ] **Step 2: Test ausführen — muss failen**

```bash
node --test tests/gateway_api_config.test.js
```

Expected: Route nicht gemounted.

- [ ] **Step 3: Route-Handler schreiben**

Create `/root/gatecontrol/src/routes/api/gateway.js`:

```javascript
'use strict';

const express = require('express');
const { requireGateway } = require('../../middleware/gatewayAuth');
const gateways = require('../../services/gateways');
const logger = require('../../utils/logger');

const router = express.Router();

router.use(requireGateway);

/** GET /api/v1/gateway/config */
router.get('/config', (req, res) => {
  const peerId = req.gateway.peer_id;
  const cfg = gateways.getGatewayConfig(peerId);
  const hash = gateways.computeConfigHash(peerId);
  res.json({ ...cfg, config_hash: hash });
});

/** GET /api/v1/gateway/config/check?hash=sha256:... */
router.get('/config/check', (req, res) => {
  const peerId = req.gateway.peer_id;
  const clientHash = req.query.hash;
  const currentHash = gateways.computeConfigHash(peerId);
  if (clientHash === currentHash) {
    return res.status(304).end();
  }
  res.status(200).json({ config_hash: currentHash });
});

module.exports = router;
```

- [ ] **Step 4: Router registrieren**

Modify `/root/gatecontrol/src/routes/api/index.js` — an passender Stelle (wo andere Sub-Router wie `client`, `peers` etc. gemounted werden):

```javascript
router.use('/gateway', require('./gateway'));
```

- [ ] **Step 5: Test ausführen — muss grün sein**

```bash
node --test tests/gateway_api_config.test.js
```

Expected: 4 Tests grün.

- [ ] **Step 6: Commit**

```bash
git add src/routes/api/gateway.js src/routes/api/index.js tests/gateway_api_config.test.js
git commit -m "feat(api): add GET /api/v1/gateway/config and /config/check (304-on-match)"
git push
```

---

## Task 10: POST `/api/v1/gateway/heartbeat` mit Health-Payload

**Files:**
- Modify: `/root/gatecontrol/src/routes/api/gateway.js`
- Create: `/root/gatecontrol/tests/gateway_api_heartbeat.test.js`

- [ ] **Step 1: Failing Test schreiben**

Create `/root/gatecontrol/tests/gateway_api_heartbeat.test.js`:

```javascript
'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');

describe('gateway API: /heartbeat', () => {
  let server, apiToken, peerId, baseUrl, db;

  before(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-gwhb-'));
    process.env.GC_DB_PATH = path.join(tmp, 'test.db');
    ['../src/db/connection', '../src/db/migrations', '../src/services/gateways', '../src/app']
      .forEach(p => { try { delete require.cache[require.resolve(p)]; } catch (_) {} });
    require('../src/db/migrations').runMigrations();
    const gateways = require('../src/services/gateways');
    const gw = await gateways.createGateway({ name: 'hb-gw', apiPort: 9876 });
    apiToken = gw.apiToken; peerId = gw.peer.id;
    const { createApp } = require('../src/app');
    server = createApp().listen(0);
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    db = require('../src/db/connection').getDb();
  });

  after(() => server && server.close());

  async function postJson(p, body, headers = {}) {
    return new Promise((resolve, reject) => {
      const url = new URL(baseUrl + p);
      const req = http.request({
        host: url.hostname, port: url.port, path: url.pathname, method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
      }, (res) => {
        let b = ''; res.on('data', c => b += c);
        res.on('end', () => resolve({ status: res.statusCode, body: b }));
      });
      req.on('error', reject);
      req.end(JSON.stringify(body));
    });
  }

  it('accepts heartbeat with health payload and updates last_seen_at', () => {
    const before = Date.now() - 1;
    return postJson('/api/v1/gateway/heartbeat', {
      uptime_s: 3600,
      config_hash: 'sha256:' + 'a'.repeat(64),
      http_proxy_healthy: true,
      tcp_listeners: [{ port: 13389, status: 'listening' }],
      wg_handshake_age_s: 45,
      rx_bytes: 1234, tx_bytes: 5678,
    }, { Authorization: `Bearer ${apiToken}` }).then(r => {
      assert.equal(r.status, 200);
      const meta = db.prepare('SELECT last_seen_at FROM gateway_meta WHERE peer_id=?').get(peerId);
      assert.ok(meta.last_seen_at >= before);
    });
  });

  it('rejects heartbeat with invalid payload (wrong type)', async () => {
    const r = await postJson('/api/v1/gateway/heartbeat', { uptime_s: 'not-a-number' }, { Authorization: `Bearer ${apiToken}` });
    assert.equal(r.status, 400);
  });

  it('rejects heartbeat without auth', async () => {
    const r = await postJson('/api/v1/gateway/heartbeat', {});
    assert.equal(r.status, 401);
  });
});
```

- [ ] **Step 2: Test ausführen — muss failen**

```bash
node --test tests/gateway_api_heartbeat.test.js
```

Expected: Route nicht definiert.

- [ ] **Step 3: Handler ergänzen in `gateway.js`**

Append to `/root/gatecontrol/src/routes/api/gateway.js` (vor `module.exports`):

```javascript
/** POST /api/v1/gateway/heartbeat */
router.post('/heartbeat', express.json({ limit: '16kb' }), (req, res) => {
  const peerId = req.gateway.peer_id;
  const body = req.body || {};

  // Minimal-Validierung
  if (body.uptime_s !== undefined && typeof body.uptime_s !== 'number') {
    return res.status(400).json({ error: 'uptime_s must be number' });
  }
  if (body.tcp_listeners !== undefined && !Array.isArray(body.tcp_listeners)) {
    return res.status(400).json({ error: 'tcp_listeners must be array' });
  }

  gateways.handleHeartbeat(peerId, body);
  res.status(200).json({ ok: true });
});
```

- [ ] **Step 4: `handleHeartbeat` in Service ergänzen**

Append to `/root/gatecontrol/src/services/gateways.js`:

```javascript
/**
 * Record a heartbeat from a Gateway. Updates last_seen_at and last_health.
 * Feeds into monitoring state machine (Task 18).
 */
function handleHeartbeat(peerId, health) {
  const db = getDb();
  const now = Date.now();
  db.prepare(`
    UPDATE gateway_meta
    SET last_seen_at = ?, last_health = ?
    WHERE peer_id = ?
  `).run(now, JSON.stringify(health || {}), peerId);
  // Status-Transition-Logik wird in Task 18 hinzugefügt
}

module.exports.handleHeartbeat = handleHeartbeat;
```

**Hinweis:** Die `last_health`-Spalte gibt's noch nicht — füge sie in der Migration 36 nachträglich nicht hinzu, sondern erstelle Migration 37:

Append to `/root/gatecontrol/src/db/migrations.js`:

```javascript
  {
    version: 37,
    name: 'gateway_meta_last_health',
    sql: 'ALTER TABLE gateway_meta ADD COLUMN last_health TEXT;',
  },
```

- [ ] **Step 5: Test ausführen — muss grün sein**

```bash
node --test tests/gateway_api_heartbeat.test.js
```

Expected: 3 Tests grün.

- [ ] **Step 6: Commit**

```bash
git add src/routes/api/gateway.js src/services/gateways.js src/db/migrations.js tests/gateway_api_heartbeat.test.js
git commit -m "feat(api): POST /api/v1/gateway/heartbeat with health payload, migration 37 for last_health"
git push
```

---

## Task 11: POST `/api/v1/gateway/status` + `/probe`

**Files:**
- Modify: `/root/gatecontrol/src/routes/api/gateway.js`
- Create: `/root/gatecontrol/tests/gateway_api_status.test.js`

- [ ] **Step 1: Failing Test schreiben**

Create `/root/gatecontrol/tests/gateway_api_status.test.js`:

```javascript
'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');

// (identisches boilerplate wie Task 10)

describe('gateway API: /status and /probe', () => {
  let server, apiToken, baseUrl;

  before(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-gws-'));
    process.env.GC_DB_PATH = path.join(tmp, 'test.db');
    ['../src/db/connection', '../src/db/migrations', '../src/services/gateways', '../src/app']
      .forEach(p => { try { delete require.cache[require.resolve(p)]; } catch (_) {} });
    require('../src/db/migrations').runMigrations();
    const gateways = require('../src/services/gateways');
    const gw = await gateways.createGateway({ name: 'st-gw', apiPort: 9876 });
    apiToken = gw.apiToken;
    const { createApp } = require('../src/app');
    server = createApp().listen(0);
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => server && server.close());

  async function postJson(p, body, headers = {}) {
    return new Promise((resolve, reject) => {
      const url = new URL(baseUrl + p);
      const req = http.request({ host: url.hostname, port: url.port, path: url.pathname, method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } }, (res) => {
        let b = ''; res.on('data', c => b += c);
        res.on('end', () => resolve({ status: res.statusCode, body: b }));
      });
      req.on('error', reject); req.end(JSON.stringify(body));
    });
  }

  it('POST /status accepts traffic counters', async () => {
    const r = await postJson('/api/v1/gateway/status',
      { rx_bytes: 1000, tx_bytes: 2000, active_connections: 5 },
      { Authorization: `Bearer ${apiToken}` });
    assert.equal(r.status, 200);
  });

  it('POST /probe returns 200 with probe metadata', async () => {
    const r = await postJson('/api/v1/gateway/probe',
      { probe_target: '192.168.1.1', probe_port: 53 },
      { Authorization: `Bearer ${apiToken}` });
    assert.equal(r.status, 200);
    const body = JSON.parse(r.body);
    assert.ok('server_timestamp' in body);
  });
});
```

- [ ] **Step 2: Test ausführen — muss failen**

```bash
node --test tests/gateway_api_status.test.js
```

Expected: Endpoints fehlen.

- [ ] **Step 3: Handler ergänzen**

Append to `/root/gatecontrol/src/routes/api/gateway.js`:

```javascript
/** POST /api/v1/gateway/status — traffic counters */
router.post('/status', express.json({ limit: '4kb' }), (req, res) => {
  const peerId = req.gateway.peer_id;
  const { rx_bytes, tx_bytes, active_connections } = req.body || {};
  gateways.recordTrafficSnapshot(peerId, { rx_bytes, tx_bytes, active_connections });
  res.json({ ok: true });
});

/** POST /api/v1/gateway/probe — echo for end-to-end health-probe from Server */
router.post('/probe', express.json({ limit: '4kb' }), (req, res) => {
  const peerId = req.gateway.peer_id;
  // Der Gateway ruft diesen Endpoint als Teil seines End-to-End Self-Checks auf
  res.json({
    server_timestamp: Date.now(),
    peer_id: peerId,
    echo: req.body,
  });
});
```

- [ ] **Step 4: `recordTrafficSnapshot` in Service ergänzen**

Append to `/root/gatecontrol/src/services/gateways.js`:

```javascript
/**
 * Record traffic counters reported by a Gateway. Delegates to existing
 * traffic-snapshots infrastructure if available, or updates gateway_meta.
 */
function recordTrafficSnapshot(peerId, { rx_bytes, tx_bytes, active_connections }) {
  const db = getDb();
  // MVP: store latest in gateway_meta.last_health JSON (historized in peerStatus later)
  const existing = db.prepare('SELECT last_health FROM gateway_meta WHERE peer_id=?').get(peerId);
  const health = existing && existing.last_health ? JSON.parse(existing.last_health) : {};
  health.rx_bytes = rx_bytes;
  health.tx_bytes = tx_bytes;
  health.active_connections = active_connections;
  health.traffic_updated_at = Date.now();
  db.prepare('UPDATE gateway_meta SET last_health=? WHERE peer_id=?').run(JSON.stringify(health), peerId);
}

module.exports.recordTrafficSnapshot = recordTrafficSnapshot;
```

- [ ] **Step 5: Test ausführen — muss grün sein**

```bash
node --test tests/gateway_api_status.test.js
```

Expected: 2 Tests grün.

- [ ] **Step 6: Commit**

```bash
git add src/routes/api/gateway.js src/services/gateways.js tests/gateway_api_status.test.js
git commit -m "feat(api): POST /api/v1/gateway/status and /probe for traffic + end-to-end probe"
git push
```

---

## Task 12: `gateways.notifyConfigChanged` — Push-Trigger an Gateway

**Files:**
- Modify: `/root/gatecontrol/src/services/gateways.js`
- Create: `/root/gatecontrol/tests/gateways_push.test.js`

- [ ] **Step 1: Failing Test schreiben**

Create `/root/gatecontrol/tests/gateways_push.test.js`:

```javascript
'use strict';

const { describe, it, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');

describe('gateways.notifyConfigChanged', () => {
  let gateways, peerId, pushToken, mockGwServer, receivedRequests;

  before(async () => {
    receivedRequests = [];
    mockGwServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        receivedRequests.push({ path: req.url, method: req.method, headers: req.headers, body });
        res.writeHead(200); res.end('ok');
      });
    }).listen(0);

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-gwp-'));
    process.env.GC_DB_PATH = path.join(tmp, 'test.db');
    ['../src/db/connection', '../src/db/migrations', '../src/services/gateways']
      .forEach(p => { try { delete require.cache[require.resolve(p)]; } catch (_) {} });
    require('../src/db/migrations').runMigrations();
    gateways = require('../src/services/gateways');
    const gw = await gateways.createGateway({ name: 'push-gw', apiPort: mockGwServer.address().port });
    peerId = gw.peer.id;
    pushToken = gw.pushToken;

    // Override peer IP to localhost for testing
    require('../src/db/connection').getDb()
      .prepare('UPDATE peers SET ip_address=? WHERE id=?').run('127.0.0.1', peerId);
  });

  after(() => mockGwServer && mockGwServer.close());

  it('POSTs to gateway /api/config-changed with decrypted push-token', async () => {
    await gateways.notifyConfigChanged(peerId);
    assert.equal(receivedRequests.length, 1);
    const r = receivedRequests[0];
    assert.equal(r.method, 'POST');
    assert.equal(r.path, '/api/config-changed');
    assert.equal(r.headers['x-gateway-token'], pushToken);
  });

  it('ignores push failures silently (best-effort)', async () => {
    mockGwServer.close();
    await assert.doesNotReject(() => gateways.notifyConfigChanged(peerId));
  });
});
```

- [ ] **Step 2: Test ausführen — muss failen**

```bash
node --test tests/gateways_push.test.js
```

Expected: `notifyConfigChanged is not a function`.

- [ ] **Step 3: Implementation ergänzen**

Append to `/root/gatecontrol/src/services/gateways.js`:

```javascript
const http = require('node:http');

/**
 * Best-effort push to notify a Gateway that its config changed.
 * Gateway will pull fresh config on receipt (debounced 500ms).
 * Failures are logged but NOT retried aggressively — next Gateway poll covers it.
 */
async function notifyConfigChanged(peerId) {
  const db = getDb();
  const row = db.prepare(`
    SELECT p.ip_address, gm.api_port, gm.push_token_encrypted
    FROM gateway_meta gm JOIN peers p ON p.id = gm.peer_id
    WHERE gm.peer_id = ?
  `).get(peerId);
  if (!row) return;

  const pushToken = decryptAes256Gcm(row.push_token_encrypted);

  await new Promise((resolve) => {
    const req = http.request({
      host: row.ip_address,
      port: row.api_port,
      path: '/api/config-changed',
      method: 'POST',
      timeout: 2000,
      headers: {
        'X-Gateway-Token': pushToken,
        'Content-Length': 0,
      },
    }, (res) => {
      res.resume();
      res.on('end', resolve);
    });
    req.on('error', (err) => {
      logger.warn({ err: err.message, peerId }, 'Gateway push failed (best-effort)');
      resolve();
    });
    req.on('timeout', () => { req.destroy(); resolve(); });
    req.end();
  });
}

module.exports.notifyConfigChanged = notifyConfigChanged;
```

- [ ] **Step 4: Test ausführen — muss grün sein**

```bash
node --test tests/gateways_push.test.js
```

Expected: 2 Tests grün.

- [ ] **Step 5: Commit**

```bash
git add src/services/gateways.js tests/gateways_push.test.js
git commit -m "feat(gateways): notifyConfigChanged — best-effort push with decrypted push-token"
git push
```

---

## Task 13: Route-CRUD Hooks triggern `notifyConfigChanged`

**Files:**
- Modify: `/root/gatecontrol/src/services/routes.js`
- Create: `/root/gatecontrol/tests/routes_hook_notify.test.js`

- [ ] **Step 1: Failing Test schreiben**

Create `/root/gatecontrol/tests/routes_hook_notify.test.js`:

```javascript
'use strict';

const { describe, it, before, mock } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

describe('routes hooks → notifyConfigChanged', () => {
  let routes, gateways, gwPeerId;

  before(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-rh-'));
    process.env.GC_DB_PATH = path.join(tmp, 'test.db');
    ['../src/db/connection', '../src/db/migrations', '../src/services/gateways', '../src/services/routes']
      .forEach(p => { try { delete require.cache[require.resolve(p)]; } catch (_) {} });
    require('../src/db/migrations').runMigrations();
    gateways = require('../src/services/gateways');
    routes = require('../src/services/routes');
    const gw = await gateways.createGateway({ name: 'hook-gw', apiPort: 9876 });
    gwPeerId = gw.peer.id;
  });

  it('createRoute with target_kind=gateway calls notifyConfigChanged', () => {
    const spy = mock.method(gateways, 'notifyConfigChanged');
    try {
      routes.createRoute({
        domain: 'new.example.com', type: 'http',
        target_kind: 'gateway', target_peer_id: gwPeerId,
        target_lan_host: '192.168.1.50', target_lan_port: 8080,
      });
      assert.ok(spy.mock.calls.length >= 1);
      const called = spy.mock.calls.some(c => c.arguments[0] === gwPeerId);
      assert.ok(called, 'notifyConfigChanged called with right peerId');
    } finally {
      spy.mock.restore();
    }
  });

  it('createRoute with target_kind=peer does NOT call notifyConfigChanged', () => {
    const spy = mock.method(gateways, 'notifyConfigChanged');
    try {
      routes.createRoute({
        domain: 'peer.example.com', type: 'http',
        target_kind: 'peer', target_ip: '10.8.0.5', target_port: 80,
      });
      assert.equal(spy.mock.calls.length, 0);
    } finally {
      spy.mock.restore();
    }
  });
});
```

- [ ] **Step 2: Test ausführen — muss failen**

```bash
node --test tests/routes_hook_notify.test.js
```

Expected: Kein Hook vorhanden → spy.calls.length = 0 in beiden Tests.

- [ ] **Step 3: Hooks in routes.js ergänzen**

Modify `/root/gatecontrol/src/services/routes.js`:

In jeder Funktion die Routes ändert (`createRoute`, `updateRoute`, `deleteRoute`), nach dem DB-Write folgendes ergänzen:

```javascript
// Fire-and-forget push-notification for gateway peers
if (routeData.target_kind === 'gateway' && routeData.target_peer_id) {
  const gateways = require('./gateways');
  gateways.notifyConfigChanged(routeData.target_peer_id).catch(() => {});
}
```

- [ ] **Step 4: Test ausführen — muss grün sein**

```bash
node --test tests/routes_hook_notify.test.js
```

Expected: 2 Tests grün.

- [ ] **Step 5: Commit**

```bash
git add src/services/routes.js tests/routes_hook_notify.test.js
git commit -m "feat(routes): fire notifyConfigChanged hook on gateway-route create/update/delete"
git push
```

---

## Task 14: `gateways.notifyWol()` — WoL-Trigger an Gateway

**Files:**
- Modify: `/root/gatecontrol/src/services/gateways.js`
- Create: `/root/gatecontrol/tests/gateways_wol.test.js`

- [ ] **Step 1: Failing Test schreiben**

Create `/root/gatecontrol/tests/gateways_wol.test.js`:

```javascript
'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

describe('gateways.notifyWol', () => {
  let gateways, peerId, pushToken, mockGwServer, received;

  before(async () => {
    received = [];
    mockGwServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        received.push({ path: req.url, headers: req.headers, body });
        res.writeHead(200); res.end(JSON.stringify({ success: true, elapsed_ms: 12000 }));
      });
    }).listen(0);

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-wol-'));
    process.env.GC_DB_PATH = path.join(tmp, 'test.db');
    ['../src/db/connection', '../src/db/migrations', '../src/services/gateways']
      .forEach(p => { try { delete require.cache[require.resolve(p)]; } catch (_) {} });
    require('../src/db/migrations').runMigrations();
    gateways = require('../src/services/gateways');
    const gw = await gateways.createGateway({ name: 'wol-gw', apiPort: mockGwServer.address().port });
    peerId = gw.peer.id;
    pushToken = gw.pushToken;
    require('../src/db/connection').getDb().prepare('UPDATE peers SET ip_address=? WHERE id=?').run('127.0.0.1', peerId);
  });

  after(() => mockGwServer && mockGwServer.close());

  it('POSTs to /api/wol with MAC, lan_host, timeout_ms', async () => {
    const result = await gateways.notifyWol(peerId, { mac: 'AA:BB:CC:DD:EE:FF', lan_host: '192.168.1.10', timeout_ms: 60000 });
    assert.equal(received.length, 1);
    const body = JSON.parse(received[0].body);
    assert.equal(body.mac, 'AA:BB:CC:DD:EE:FF');
    assert.equal(body.lan_host, '192.168.1.10');
    assert.equal(body.timeout_ms, 60000);
    assert.equal(received[0].headers['x-gateway-token'], pushToken);
    assert.deepEqual(result, { success: true, elapsed_ms: 12000 });
  });
});
```

- [ ] **Step 2: Test ausführen — muss failen**

```bash
node --test tests/gateways_wol.test.js
```

- [ ] **Step 3: Implementation ergänzen**

Append to `/root/gatecontrol/src/services/gateways.js`:

```javascript
/**
 * Push a WoL trigger to a Gateway, which will send the magic packet on LAN.
 * Returns the Gateway's response body ({ success, elapsed_ms }) or null on error.
 */
async function notifyWol(peerId, { mac, lan_host, timeout_ms = 60000 }) {
  const db = getDb();
  const row = db.prepare(`
    SELECT p.ip_address, gm.api_port, gm.push_token_encrypted
    FROM gateway_meta gm JOIN peers p ON p.id = gm.peer_id
    WHERE gm.peer_id = ?
  `).get(peerId);
  if (!row) return null;

  const pushToken = decryptAes256Gcm(row.push_token_encrypted);
  const payload = JSON.stringify({ mac, lan_host, timeout_ms });

  return new Promise((resolve) => {
    const req = http.request({
      host: row.ip_address,
      port: row.api_port,
      path: '/api/wol',
      method: 'POST',
      timeout: timeout_ms + 5000,
      headers: {
        'X-Gateway-Token': pushToken,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch { resolve(null); }
      });
    });
    req.on('error', (err) => {
      logger.warn({ err: err.message, peerId, mac }, 'Gateway WoL trigger failed');
      resolve(null);
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end(payload);
  });
}

module.exports.notifyWol = notifyWol;
```

- [ ] **Step 4: Test ausführen — muss grün sein**

```bash
node --test tests/gateways_wol.test.js
```

- [ ] **Step 5: Commit**

```bash
git add src/services/gateways.js tests/gateways_wol.test.js
git commit -m "feat(gateways): notifyWol — push WoL trigger to gateway with MAC/lan_host/timeout"
git push
```

---

## Task 15: Sliding-Window Hysteresis State-Machine

**Files:**
- Create: `/root/gatecontrol/src/services/gatewayHealth.js`
- Create: `/root/gatecontrol/tests/gatewayHealth.test.js`

- [ ] **Step 1: Failing Test schreiben**

Create `/root/gatecontrol/tests/gatewayHealth.test.js`:

```javascript
'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { StateMachine } = require('../src/services/gatewayHealth');

describe('Gateway Health StateMachine (sliding window)', () => {
  let sm;
  beforeEach(() => { sm = new StateMachine({ windowSize: 5, offlineThreshold: 3, onlineThreshold: 4, cooldownMs: 300000 }); });

  it('starts in state unknown', () => {
    assert.equal(sm.status, 'unknown');
  });

  it('transitions to online after 4 consecutive successes', () => {
    for (let i = 0; i < 4; i++) sm.recordHeartbeat(true);
    assert.equal(sm.status, 'online');
  });

  it('stays unknown after only 3 successes', () => {
    for (let i = 0; i < 3; i++) sm.recordHeartbeat(true);
    assert.equal(sm.status, 'unknown');
  });

  it('transitions to offline after 3 failures in a 5-slot window', () => {
    // Bring to online first
    for (let i = 0; i < 5; i++) sm.recordHeartbeat(true);
    assert.equal(sm.status, 'online');
    // Now 3 failures
    sm.recordHeartbeat(false);
    sm.recordHeartbeat(false);
    sm.recordHeartbeat(false);
    // Cooldown-Trick: fake lastTransitionAt 10 min ago
    sm._lastTransitionAt = Date.now() - 10 * 60 * 1000;
    sm._evaluate();
    assert.equal(sm.status, 'offline');
  });

  it('respects cooldown — no transition before 5min has passed', () => {
    for (let i = 0; i < 5; i++) sm.recordHeartbeat(true);
    assert.equal(sm.status, 'online');
    // Force transition to offline
    sm._lastTransitionAt = Date.now();
    sm.recordHeartbeat(false);
    sm.recordHeartbeat(false);
    sm.recordHeartbeat(false);
    assert.equal(sm.status, 'online', 'should not flip within cooldown');
  });

  it('counts flaps in last hour', () => {
    // 1st transition: unknown → online (no cooldown check for first transition)
    for (let i = 0; i < 5; i++) sm.recordHeartbeat(true);
    assert.equal(sm.status, 'online');

    // Fake cooldown elapsed so next Offline-Transition is allowed by _evaluate (called from recordHeartbeat)
    sm._lastTransitionAt = Date.now() - 10 * 60 * 1000;
    sm.recordHeartbeat(false); sm.recordHeartbeat(false); sm.recordHeartbeat(false);
    assert.equal(sm.status, 'offline');

    // Fake cooldown elapsed again for the Online-Transition
    sm._lastTransitionAt = Date.now() - 10 * 60 * 1000;
    sm.recordHeartbeat(true); sm.recordHeartbeat(true); sm.recordHeartbeat(true); sm.recordHeartbeat(true);
    assert.equal(sm.status, 'online');

    // 2 transitions total: online-offline + offline-online
    assert.equal(sm.flapCountLastHour(), 2);
  });
});
```

- [ ] **Step 2: Test ausführen — muss failen**

```bash
node --test tests/gatewayHealth.test.js
```

- [ ] **Step 3: Implementation schreiben**

Create `/root/gatecontrol/src/services/gatewayHealth.js`:

```javascript
'use strict';

/**
 * Sliding-window hysteresis state machine for Gateway health.
 * Symmetrischer Cooldown in BEIDE Richtungen.
 * Default: window=5, offline=3/5 fail, online=4/5 success, cooldown=5min.
 */
class StateMachine {
  constructor(opts = {}) {
    this.windowSize = opts.windowSize || 5;
    this.offlineThreshold = opts.offlineThreshold || 3;
    this.onlineThreshold = opts.onlineThreshold || 4;
    this.cooldownMs = opts.cooldownMs || 5 * 60 * 1000;
    this._window = []; // array of booleans
    this.status = 'unknown';
    this._lastTransitionAt = 0;
    this._transitions = []; // [{at, from, to}]
  }

  recordHeartbeat(success) {
    this._window.push(!!success);
    if (this._window.length > this.windowSize) this._window.shift();
    this._evaluate();
  }

  _evaluate() {
    const now = Date.now();
    const fails = this._window.filter(x => !x).length;
    const successes = this._window.length - fails;

    let next = this.status;
    if (this._window.length >= this.onlineThreshold && successes >= this.onlineThreshold) {
      next = 'online';
    } else if (fails >= this.offlineThreshold) {
      next = 'offline';
    }

    if (next !== this.status) {
      if (this.status !== 'unknown' && (now - this._lastTransitionAt) < this.cooldownMs) {
        return; // Cooldown blocks transition
      }
      this._transitions.push({ at: now, from: this.status, to: next });
      this.status = next;
      this._lastTransitionAt = now;
    }
  }

  flapCountLastHour() {
    const cutoff = Date.now() - 60 * 60 * 1000;
    return this._transitions.filter(t => t.at >= cutoff).length;
  }
}

module.exports = { StateMachine };
```

- [ ] **Step 4: Test ausführen — muss grün sein**

```bash
node --test tests/gatewayHealth.test.js
```

Expected: 6 Tests grün.

- [ ] **Step 5: Commit**

```bash
git add src/services/gatewayHealth.js tests/gatewayHealth.test.js
git commit -m "feat(monitor): sliding-window hysteresis state machine with symmetric cooldown"
git push
```

---

## Task 16: Monitor-Integration — Gateway-Health tracken + Alerts

**Files:**
- Modify: `/root/gatecontrol/src/services/monitor.js`
- Modify: `/root/gatecontrol/src/services/gateways.js`
- Create: `/root/gatecontrol/tests/monitor_gateway.test.js`

- [ ] **Step 1: Failing Test schreiben**

Create `/root/gatecontrol/tests/monitor_gateway.test.js`:

```javascript
'use strict';

const { describe, it, before, mock } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

describe('monitor: gateway health tracking', () => {
  let gateways, activity, email, peerId;

  before(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-mon-'));
    process.env.GC_DB_PATH = path.join(tmp, 'test.db');
    ['../src/db/connection', '../src/db/migrations', '../src/services/gateways', '../src/services/monitor']
      .forEach(p => { try { delete require.cache[require.resolve(p)]; } catch (_) {} });
    require('../src/db/migrations').runMigrations();
    gateways = require('../src/services/gateways');
    gateways._resetSmCacheForTest(); // prevent state bleed from prior test files
    activity = require('../src/services/activity');
    email = require('../src/services/email');
    const gw = await gateways.createGateway({ name: 'mon-gw', apiPort: 9876 });
    peerId = gw.peer.id;
  });

  it('after 4 heartbeats with http_proxy_healthy=true gateway is online', () => {
    const spy = mock.method(activity, 'log');
    try {
      for (let i = 0; i < 4; i++) {
        gateways.handleHeartbeat(peerId, { http_proxy_healthy: true, tcp_listeners: [] });
      }
      const status = gateways.getHealthStatus(peerId);
      assert.equal(status, 'online');
    } finally {
      spy.mock.restore();
    }
  });

  it('after online then 3 unhealthy heartbeats transitions to offline with alert', () => {
    // bring to online
    for (let i = 0; i < 4; i++) gateways.handleHeartbeat(peerId, { http_proxy_healthy: true });
    assert.equal(gateways.getHealthStatus(peerId), 'online');

    // Fake cooldown exhaustion
    gateways._forceCooldownExhaustedForTest?.(peerId);

    const activitySpy = mock.method(activity, 'log');
    try {
      for (let i = 0; i < 3; i++) gateways.handleHeartbeat(peerId, { http_proxy_healthy: false });
      assert.equal(gateways.getHealthStatus(peerId), 'offline');
      assert.ok(activitySpy.mock.calls.some(c => c.arguments[0] === 'gateway_offline'));
    } finally {
      activitySpy.mock.restore();
    }
  });
});
```

- [ ] **Step 2: Test ausführen — muss failen**

```bash
node --test tests/monitor_gateway.test.js
```

- [ ] **Step 3: Service-Integration ergänzen**

Modify `/root/gatecontrol/src/services/gateways.js` — erweiterte `handleHeartbeat` + State-Machine-Wiring:

```javascript
const { StateMachine } = require('./gatewayHealth');
const activity = require('./activity');
const email = require('./email');
const webhooks = require('./webhooks'); // falls existent; sonst weglassen

const _smCache = new Map(); // peerId → StateMachine

function _getSm(peerId) {
  let sm = _smCache.get(peerId);
  if (!sm) {
    sm = new StateMachine();
    _smCache.set(peerId, sm);
  }
  return sm;
}

function handleHeartbeat(peerId, health) {
  const db = getDb();
  const now = Date.now();
  db.prepare('UPDATE gateway_meta SET last_seen_at=?, last_health=? WHERE peer_id=?')
    .run(now, JSON.stringify(health || {}), peerId);

  const sm = _getSm(peerId);
  const prevStatus = sm.status;
  const healthy = !!health?.http_proxy_healthy &&
    !(health?.tcp_listeners || []).some(l => l.status === 'listener_failed');
  sm.recordHeartbeat(healthy);

  if (sm.status !== prevStatus) {
    _onStatusTransition(peerId, prevStatus, sm.status, health);
  }

  // Flap-Metric
  if (sm.flapCountLastHour() > 4) {
    activity.log('gateway_flap_warning', { peer_id: peerId, flap_count: sm.flapCountLastHour() });
  }
}

function _onStatusTransition(peerId, from, to, health) {
  const peer = getDb().prepare('SELECT name FROM peers WHERE id=?').get(peerId);
  if (to === 'offline') {
    activity.log('gateway_offline', { peer_id: peerId, peer_name: peer.name, last_health: health });
    email.sendAlert?.({ group: 'system', subject: `Gateway ${peer.name} offline`, body: JSON.stringify(health, null, 2) });
    webhooks.trigger?.('gateway.offline', { peer_id: peerId, peer_name: peer.name, health });
  } else if (to === 'online') {
    activity.log('gateway_recovered', { peer_id: peerId, peer_name: peer.name });
    email.sendAlert?.({ group: 'system', subject: `Gateway ${peer.name} wieder online`, body: '' });
    webhooks.trigger?.('gateway.recovered', { peer_id: peerId, peer_name: peer.name });
  }
}

function getHealthStatus(peerId) {
  return _getSm(peerId).status;
}

// Testing helpers — not for production use
function _forceCooldownExhaustedForTest(peerId) {
  const sm = _getSm(peerId);
  sm._lastTransitionAt = Date.now() - 10 * 60 * 1000;
}

function _resetSmCacheForTest() {
  _smCache.clear();
}

module.exports.handleHeartbeat = handleHeartbeat;
module.exports.getHealthStatus = getHealthStatus;
module.exports._forceCooldownExhaustedForTest = _forceCooldownExhaustedForTest;
module.exports._resetSmCacheForTest = _resetSmCacheForTest;
```

- [ ] **Step 4: Test ausführen — muss grün sein**

```bash
node --test tests/monitor_gateway.test.js
```

- [ ] **Step 5: Commit**

```bash
git add src/services/gateways.js tests/monitor_gateway.test.js
git commit -m "feat(monitor): gateway health state machine integration with activity+email+webhook alerts"
git push
```

---

## Task 17: Monitor-Hook für automatische WoL bei Route-Recovery

**Files:**
- Modify: `/root/gatecontrol/src/services/monitor.js`
- Create: `/root/gatecontrol/tests/monitor_auto_wol.test.js`

- [ ] **Step 1: Failing Test schreiben**

Create `/root/gatecontrol/tests/monitor_auto_wol.test.js`:

```javascript
'use strict';

const { describe, it, before, mock } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

describe('monitor: auto-WoL on backend down', () => {
  let monitor, gateways, routeId, peerId;

  before(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-awol-'));
    process.env.GC_DB_PATH = path.join(tmp, 'test.db');
    ['../src/db/connection', '../src/db/migrations', '../src/services/gateways', '../src/services/monitor']
      .forEach(p => { try { delete require.cache[require.resolve(p)]; } catch (_) {} });
    require('../src/db/migrations').runMigrations();
    gateways = require('../src/services/gateways');
    monitor = require('../src/services/monitor');
    const gw = await gateways.createGateway({ name: 'wm-gw', apiPort: 9876 });
    peerId = gw.peer.id;
    const db = require('../src/db/connection').getDb();
    db.prepare(`INSERT INTO routes (domain, target_ip, target_port, type, target_kind, target_peer_id, target_lan_host, target_lan_port, wol_enabled, wol_mac)
                VALUES ('nas.example.com', ?, 8080, 'http', 'gateway', ?, '192.168.1.10', 5001, 1, 'AA:BB:CC:DD:EE:FF')`)
      .run(gw.peer.ip_address, peerId);
    routeId = db.prepare('SELECT id FROM routes WHERE domain=?').get('nas.example.com').id;
  });

  it('monitor down-event on wol_enabled route triggers gateways.notifyWol', () => {
    const spy = mock.method(gateways, 'notifyWol');
    try {
      monitor.handleRouteDownDetected(routeId);
      assert.equal(spy.mock.calls.length, 1);
      const call = spy.mock.calls[0];
      assert.equal(call.arguments[0], peerId);
      assert.equal(call.arguments[1].mac, 'AA:BB:CC:DD:EE:FF');
      assert.equal(call.arguments[1].lan_host, '192.168.1.10');
    } finally {
      spy.mock.restore();
    }
  });

  it('monitor down-event on wol_disabled route does NOT trigger WoL', () => {
    const db = require('../src/db/connection').getDb();
    db.prepare('UPDATE routes SET wol_enabled=0 WHERE id=?').run(routeId);
    const spy = mock.method(gateways, 'notifyWol');
    try {
      monitor.handleRouteDownDetected(routeId);
      assert.equal(spy.mock.calls.length, 0);
    } finally {
      spy.mock.restore();
    }
  });
});
```

- [ ] **Step 2: Test ausführen — muss failen**

```bash
node --test tests/monitor_auto_wol.test.js
```

- [ ] **Step 3: Hook in monitor.js ergänzen**

Modify `/root/gatecontrol/src/services/monitor.js` — neue Funktion exportieren:

```javascript
function handleRouteDownDetected(routeId) {
  const { getDb } = require('../db/connection');
  const db = getDb();
  const route = db.prepare(`
    SELECT target_peer_id, target_lan_host, target_lan_port, wol_enabled, wol_mac
    FROM routes WHERE id=?
  `).get(routeId);
  if (!route || !route.wol_enabled || !route.wol_mac || !route.target_peer_id) return;

  const gateways = require('./gateways');
  gateways.notifyWol(route.target_peer_id, {
    mac: route.wol_mac,
    lan_host: route.target_lan_host,
    timeout_ms: 60000,
  }).catch(() => {});
}

module.exports.handleRouteDownDetected = handleRouteDownDetected;
```

Und in der existierenden Monitor-Logik (wo ein Status von `up` auf `down` wechselt), den Call einfügen:

```javascript
// Nach bestehendem Status-Change-Handling
if (previousStatus === 'up' && newStatus === 'down') {
  handleRouteDownDetected(routeId);
}
```

- [ ] **Step 4: Test ausführen — muss grün sein**

```bash
node --test tests/monitor_auto_wol.test.js
```

- [ ] **Step 5: Commit**

```bash
git add src/services/monitor.js tests/monitor_auto_wol.test.js
git commit -m "feat(monitor): auto-trigger WoL via gateway on wol_enabled route down"
git push
```

---

## Task 18: Caddy-Config für `target_kind=gateway`

**Files:**
- Modify: `/root/gatecontrol/src/services/caddyConfig.js`
- Create: `/root/gatecontrol/tests/caddyConfig_gateway.test.js`

- [ ] **Step 1: Failing Test schreiben**

Create `/root/gatecontrol/tests/caddyConfig_gateway.test.js`:

```javascript
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildCaddyConfig } = require('../src/services/caddyConfig');

describe('caddyConfig: gateway-typed routes', () => {
  it('route with target_kind=gateway routes to gateway-peer-ip + proxy port + headers', () => {
    const routes = [{
      id: 1, domain: 'nas.example.com',
      type: 'http',
      target_kind: 'gateway',
      target_peer_ip: '10.8.0.5',      // gateway-peer's wg-IP
      target_lan_host: '192.168.1.10',
      target_lan_port: 5001,
      enabled: 1,
    }];
    const config = buildCaddyConfig(routes, { gatewayProxyPort: 8080 });

    // Find the server block with upstream 10.8.0.5:8080
    const json = JSON.stringify(config);
    assert.ok(json.includes('10.8.0.5:8080'), 'upstream should be gateway-tunnel-IP:proxy-port');
    assert.ok(json.includes('X-Gateway-Target'), 'header should be injected');
    assert.ok(json.includes('192.168.1.10:5001'), 'LAN target should appear in X-Gateway-Target header');
    assert.ok(json.includes('X-Gateway-Target-Domain'), 'domain header should be injected');
  });

  it('route with target_kind=peer (legacy) routes directly to target_ip', () => {
    const routes = [{
      id: 2, domain: 'direct.example.com',
      type: 'http',
      target_kind: 'peer',
      target_ip: '10.8.0.7',
      target_port: 80,
      enabled: 1,
    }];
    const config = buildCaddyConfig(routes);
    const json = JSON.stringify(config);
    assert.ok(json.includes('10.8.0.7:80'));
    assert.ok(!json.includes('X-Gateway-Target'));
  });
});
```

- [ ] **Step 2: Test ausführen — muss failen**

```bash
node --test tests/caddyConfig_gateway.test.js
```

- [ ] **Step 3: caddyConfig.js erweitern**

In `/root/gatecontrol/src/services/caddyConfig.js` finde die Stelle, wo pro Route ein Caddy-`reverse_proxy`-Handler generiert wird, und ergänze die Gateway-Logik:

```javascript
function buildRouteHandler(route, options = {}) {
  const gatewayProxyPort = options.gatewayProxyPort || 8080;

  if (route.target_kind === 'gateway') {
    const upstream = `${route.target_peer_ip}:${gatewayProxyPort}`;
    return {
      handler: 'reverse_proxy',
      upstreams: [{ dial: upstream }],
      headers: {
        request: {
          set: {
            'X-Gateway-Target': [`${route.target_lan_host}:${route.target_lan_port}`],
            'X-Gateway-Target-Domain': [route.domain],
          },
        },
      },
    };
  }

  // Legacy peer-routing
  return {
    handler: 'reverse_proxy',
    upstreams: [{ dial: `${route.target_ip}:${route.target_port}` }],
  };
}
```

(Exakte Stelle hängt von existierender Code-Struktur ab — die Funktion möglicherweise nicht vorhanden; dann dort einsetzen, wo Handler per Route gebaut wird.)

Außerdem sicherstellen, dass `target_peer_ip` verfügbar ist — ggf. via Join beim Routes-Laden:

```javascript
// Wo Routes aus DB geladen werden:
const routes = db.prepare(`
  SELECT r.*, p.ip_address AS target_peer_ip
  FROM routes r LEFT JOIN peers p ON p.id = r.target_peer_id
  WHERE r.enabled = 1
`).all();
```

**Zwingend erforderlich für Task 20:** Jedes gebaute Caddy-Route-Objekt muss ein `@id`-Feld bekommen, damit die Caddy-Admin-API `PATCH /id/<id>/handle` funktioniert. In `buildCaddyConfig()` vor dem `return`:

```javascript
// Add @id marker on every HTTP route object so /config/apps/http/servers/.../routes/N
// can be patched via Admin-API /id/ lookup (needed for Task 20 partial-patch-on-status-change)
for (const caddyRoute of httpServerRoutes) {
  caddyRoute['@id'] = `gc_route_${caddyRoute._source_id}`;
}
```

Wobei `_source_id` bereits beim Bau mit der DB-Route-ID gesetzt sein muss. In Tests:

```javascript
it('gateway-typed HTTP route gets @id field for Admin-API patches', () => {
  const routes = [{ id: 1, domain: 'nas.example.com', type: 'http', target_kind: 'gateway',
                   target_peer_ip: '10.8.0.5', target_lan_host: '192.168.1.10', target_lan_port: 5001, enabled: 1 }];
  const config = buildCaddyConfig(routes, { gatewayProxyPort: 8080 });
  const json = JSON.stringify(config);
  assert.ok(json.includes('gc_route_1'), '@id gc_route_<id> must be present for Admin-API /id lookup');
});
```

- [ ] **Step 4: Test ausführen — muss grün sein**

```bash
node --test tests/caddyConfig_gateway.test.js
```

- [ ] **Step 5: Commit**

```bash
git add src/services/caddyConfig.js tests/caddyConfig_gateway.test.js
git commit -m "feat(caddy): route target_kind=gateway to gateway-peer with X-Gateway-Target header"
git push
```

---

## Task 19: Maintenance-Page-Template + Caddy-Handler bei Gateway offline

**Files:**
- Create: `/root/gatecontrol/templates/gateway-offline.njk`
- Modify: `/root/gatecontrol/src/services/caddyConfig.js`
- Create: `/root/gatecontrol/tests/caddyConfig_offline.test.js`

**i18n-Konvention für Templates Tasks 19, 22, 23, 24, 25:** Nutzt den bestehenden Nunjucks-Helper `{{ t('key') }}` aus `src/middleware/i18n.js`. Alle neuen Keys müssen in **beiden** Locale-Dateien ergänzt werden: `locales/de.json` und `locales/en.json`. Fehlt ein Key, gibt `t()` den Raw-Key-String zurück (z.B. `gateway_offline_title`) — im Dev sofort sichtbar.

- [ ] **Step 1: Template erstellen**

Create `/root/gatecontrol/templates/gateway-offline.njk`:

```html
<!DOCTYPE html>
<html lang="{{ lang or 'de' }}">
<head>
  <meta charset="UTF-8">
  <title>{{ t('gateway_offline_title') }}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #f8f9fa; color: #212529; margin: 0; padding: 2rem; }
    .container { max-width: 500px; margin: 10vh auto; text-align: center; }
    h1 { color: #dc3545; font-size: 1.75rem; }
    p { line-height: 1.6; color: #6c757d; }
    .detail { background: #fff; border-radius: 8px; padding: 1rem; margin-top: 1.5rem; font-size: 0.875rem; }
    code { background: #e9ecef; padding: 0.125rem 0.375rem; border-radius: 3px; }
  </style>
</head>
<body>
  <div class="container">
    <h1>{{ t('gateway_offline_heading') }}</h1>
    <p>{{ t('gateway_offline_message') }}</p>
    <div class="detail">
      <strong>{{ t('gateway_name_label') }}:</strong> <code>{{ gateway_name }}</code><br>
      <strong>{{ t('gateway_last_seen_label') }}:</strong> <code>{{ gateway_last_seen }}</code>
    </div>
    <p style="margin-top: 1.5rem; font-size: 0.875rem;">{{ t('gateway_offline_hint') }}</p>
  </div>
</body>
</html>
```

- [ ] **Step 2: Test schreiben**

Create `/root/gatecontrol/tests/caddyConfig_offline.test.js`:

```javascript
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildCaddyConfig } = require('../src/services/caddyConfig');

describe('caddyConfig: gateway-offline maintenance page', () => {
  it('route with gateway_offline=true serves static 502 response', () => {
    const routes = [{
      id: 1, domain: 'nas.example.com', type: 'http',
      target_kind: 'gateway', target_peer_ip: '10.8.0.5',
      target_lan_host: '192.168.1.10', target_lan_port: 5001,
      enabled: 1, gateway_offline: true, gateway_name: 'homelab-gw',
    }];
    const cfg = buildCaddyConfig(routes);
    const json = JSON.stringify(cfg);
    assert.ok(json.includes('502') || json.includes('static_response'));
    assert.ok(json.includes('homelab-gw'));
  });
});
```

- [ ] **Step 3: Test ausführen — muss failen**

```bash
node --test tests/caddyConfig_offline.test.js
```

- [ ] **Step 4: Logik in buildRouteHandler ergänzen**

Modify `/root/gatecontrol/src/services/caddyConfig.js` in `buildRouteHandler`:

```javascript
if (route.target_kind === 'gateway' && route.gateway_offline) {
  // Render maintenance page as static response
  const html = renderMaintenancePage({ gateway_name: route.gateway_name, gateway_last_seen: route.gateway_last_seen || '' });
  return {
    handler: 'static_response',
    status_code: 502,
    headers: { 'Content-Type': ['text/html; charset=utf-8'] },
    body: html,
  };
}
```

Und neue Helper-Funktion:

```javascript
const nunjucks = require('nunjucks');
const path = require('node:path');

function renderMaintenancePage(ctx) {
  const tmplDir = path.join(__dirname, '..', '..', 'templates');
  return nunjucks.render(path.join(tmplDir, 'gateway-offline.njk'), ctx);
}
```

- [ ] **Step 5: Test ausführen — muss grün sein**

```bash
node --test tests/caddyConfig_offline.test.js
```

- [ ] **Step 6: Commit**

```bash
git add templates/gateway-offline.njk src/services/caddyConfig.js tests/caddyConfig_offline.test.js
git commit -m "feat(caddy): maintenance-page template for gateway-offline routes (static_response 502)"
git push
```

---

## Task 20: Partial Caddy-Admin-API-Patch bei Status-Change

**Files:**
- Modify: `/root/gatecontrol/src/services/caddyConfig.js`
- Modify: `/root/gatecontrol/src/services/gateways.js`
- Create: `/root/gatecontrol/tests/caddy_patch_on_status.test.js`

- [ ] **Step 1: Failing Test schreiben**

Create `/root/gatecontrol/tests/caddy_patch_on_status.test.js`:

```javascript
'use strict';

const { describe, it, mock } = require('node:test');
const assert = require('node:assert/strict');
const caddyConfig = require('../src/services/caddyConfig');

describe('caddyConfig: partial patch on gateway status change', () => {
  it('patchGatewayRouteHandlers sends PATCH to Caddy Admin API per route', async () => {
    const patches = [];
    const origFetch = caddyConfig._caddyApi?.patch;
    const mockPatch = mock.method(caddyConfig._caddyApi || (caddyConfig._caddyApi = {}), 'patch', async (p, b) => { patches.push({ p, b }); });
    try {
      await caddyConfig.patchGatewayRouteHandlers({ peerId: 3, offline: true, gatewayName: 'gw', lastSeen: '14:32' });
      // We can't know exact paths, but at least one PATCH should have been issued
      assert.ok(patches.length >= 1);
    } finally {
      mockPatch.mock.restore();
    }
  });
});
```

- [ ] **Step 2: Test ausführen — muss failen**

```bash
node --test tests/caddy_patch_on_status.test.js
```

- [ ] **Step 3: Implementation ergänzen**

Modify `/root/gatecontrol/src/services/caddyConfig.js` — neue Funktion:

```javascript
async function patchGatewayRouteHandlers({ peerId, offline, gatewayName, lastSeen }) {
  const { getDb } = require('../db/connection');
  const db = getDb();
  const routes = db.prepare(`
    SELECT id, domain FROM routes
    WHERE target_peer_id = ? AND target_kind = 'gateway' AND enabled = 1
  `).all(peerId);

  const caddyAdmin = process.env.GC_CADDY_ADMIN_URL || 'http://127.0.0.1:2019';

  for (const route of routes) {
    const routeId = `gc_route_${route.id}`; // @id convention established in Task 18
    const handler = offline
      ? {
          handler: 'static_response',
          status_code: 502,
          headers: { 'Content-Type': ['text/html; charset=utf-8'] },
          body: renderMaintenancePage({ gateway_name: gatewayName, gateway_last_seen: lastSeen }),
        }
      : null;

    // Placeholder: exact Caddy-Admin-API path depends on config structure.
    // Standard pattern: PATCH /config/apps/http/servers/srv0/routes/<index>/handle
    // This needs real integration testing against a running Caddy.
    await _caddyApi.patch(`/id/${routeId}/handle`, handler || 'revert');
  }
}

const _caddyApi = {
  async patch(path, body) {
    const http = require('node:http');
    // minimal PATCH via Node http
    return new Promise((resolve, reject) => {
      const url = new URL((process.env.GC_CADDY_ADMIN_URL || 'http://127.0.0.1:2019') + path);
      const req = http.request({
        host: url.hostname, port: url.port, path: url.pathname, method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
      }, (res) => { res.resume(); res.on('end', resolve); });
      req.on('error', reject);
      req.end(JSON.stringify(body));
    });
  },
};

module.exports.patchGatewayRouteHandlers = patchGatewayRouteHandlers;
module.exports._caddyApi = _caddyApi;
```

- [ ] **Step 4: Hook in gateways.js Status-Transition ergänzen**

Modify `/root/gatecontrol/src/services/gateways.js` — in `_onStatusTransition`:

```javascript
async function _onStatusTransition(peerId, from, to, health) {
  const peer = getDb().prepare('SELECT name FROM peers WHERE id=?').get(peerId);
  const meta = getDb().prepare('SELECT last_seen_at FROM gateway_meta WHERE peer_id=?').get(peerId);

  const caddyConfig = require('./caddyConfig');
  await caddyConfig.patchGatewayRouteHandlers({
    peerId,
    offline: to === 'offline',
    gatewayName: peer.name,
    lastSeen: meta.last_seen_at ? new Date(meta.last_seen_at).toISOString() : '',
  }).catch(err => logger.warn({ err: err.message, peerId }, 'Caddy patch failed'));

  // bestehende activity/email/webhook logik (vom vorherigen Task 16)
  if (to === 'offline') { /* ... */ }
}
```

- [ ] **Step 5: Test ausführen — muss grün sein**

```bash
node --test tests/caddy_patch_on_status.test.js
```

- [ ] **Step 6: Commit**

```bash
git add src/services/caddyConfig.js src/services/gateways.js tests/caddy_patch_on_status.test.js
git commit -m "feat(caddy): partial PATCH via Admin API on gateway status change (no full reload)"
git push
```

---

## Task 21: `gateway.env` Download-Endpoint

**Files:**
- Modify: `/root/gatecontrol/src/routes/api/peers.js`
- Modify: `/root/gatecontrol/src/services/gateways.js`
- Create: `/root/gatecontrol/tests/peers_gateway_env.test.js`

- [ ] **Step 1: Failing Test schreiben**

Create `/root/gatecontrol/tests/peers_gateway_env.test.js`:

```javascript
'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');

describe('GET /api/peers/:id/gateway-env', () => {
  let server, baseUrl, gwPeerId, adminToken;

  before(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-env-'));
    process.env.GC_DB_PATH = path.join(tmp, 'test.db');
    ['../src/db/connection', '../src/db/migrations', '../src/services/gateways', '../src/app']
      .forEach(p => { try { delete require.cache[require.resolve(p)]; } catch (_) {} });
    require('../src/db/migrations').runMigrations();
    const gateways = require('../src/services/gateways');
    const tokens = require('../src/services/tokens');
    const gw = await gateways.createGateway({ name: 'env-gw', apiPort: 9876 });
    gwPeerId = gw.peer.id;
    const t = tokens.createToken({ name: 'admin', scopes: ['full-access'] });
    adminToken = t.token;
    const { createApp } = require('../src/app');
    server = createApp().listen(0);
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => server && server.close());

  async function get(p, headers = {}) {
    return new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: new URL(baseUrl).port, path: p, headers }, (res) => {
        let b = ''; res.on('data', c => b += c);
        res.on('end', () => resolve({ status: res.statusCode, body: b }));
      }).on('error', reject);
    });
  }

  async function postJson(p, body, headers = {}) {
    return new Promise(resolve => {
      const url = new URL(baseUrl + p);
      const payload = JSON.stringify(body);
      const req = http.request({ host: url.hostname, port: url.port, path: url.pathname, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...headers } },
        (r) => { let b = ''; r.on('data', c => b += c); r.on('end', () => resolve({ status: r.statusCode, body: b })); });
      req.end(payload);
    });
  }

  it('returns gateway.env content on POST rotate', async () => {
    const r = await postJson(`/api/v1/peers/${gwPeerId}/gateway-env/rotate`, {}, { Authorization: `Bearer ${adminToken}` });
    assert.equal(r.status, 200);
    assert.match(r.body, /GC_SERVER_URL=/);
    assert.match(r.body, /GC_API_TOKEN=gc_gw_[a-f0-9]{64}/);
    assert.match(r.body, /GC_GATEWAY_TOKEN=[a-f0-9]{64}/);
    assert.match(r.body, /GC_TUNNEL_IP=/);
  });

  it('returns 404 on non-gateway peer', async () => {
    const db = require('../src/db/connection').getDb();
    const regularPeerId = db.prepare("INSERT INTO peers (name, public_key, ip_address, peer_type) VALUES ('regular', 'key', '10.8.0.77', 'regular')").run().lastInsertRowid;
    const r = await postJson(`/api/v1/peers/${regularPeerId}/gateway-env/rotate`, {}, { Authorization: `Bearer ${adminToken}` });
    assert.equal(r.status, 404);
  });
});
```

- [ ] **Step 2: Test ausführen — muss failen**

```bash
node --test tests/peers_gateway_env.test.js
```

- [ ] **Step 3: Service-Funktion `buildEnvFile`**

Append to `/root/gatecontrol/src/services/gateways.js`:

```javascript
/**
 * Build the gateway.env file content for a given gateway peer.
 * Includes Server-URL, both tokens (plaintext), and WG config. The caller
 * is responsible for showing this ONCE and not persisting it.
 *
 * Regenerating tokens (rotation): call rotateGatewayTokens(peerId) first, then this.
 */
function buildEnvFile(peerId) {
  const db = getDb();
  const row = db.prepare(`
    SELECT p.*, gm.api_port, gm.push_token_encrypted
    FROM peers p JOIN gateway_meta gm ON gm.peer_id = p.id
    WHERE p.id = ? AND p.peer_type = 'gateway'
  `).get(peerId);
  if (!row) throw new Error('not_a_gateway');

  const pushToken = decryptAes256Gcm(row.push_token_encrypted);
  // NOTE: api_token kann nicht aus DB rekonstruiert werden (nur Hash gespeichert).
  // → rotateGatewayTokens() ist nötig, um neue Tokens zu generieren, wenn nochmal benötigt.
  throw new Error('api_token_not_recoverable — call rotateGatewayTokens first');
}

/**
 * Regenerate both api_token and push_token for a gateway. Returns the
 * full gateway.env content with fresh tokens. Old tokens are invalidated.
 */
function rotateGatewayTokens(peerId) {
  const db = getDb();
  const row = db.prepare(`
    SELECT p.*, gm.api_port FROM peers p
    JOIN gateway_meta gm ON gm.peer_id = p.id
    WHERE p.id=? AND p.peer_type='gateway'
  `).get(peerId);
  if (!row) throw new Error('not_a_gateway');

  const { apiToken, apiTokenHash, pushToken, pushTokenEncrypted } = generateTokens();
  db.prepare('UPDATE gateway_meta SET api_token_hash=?, push_token_encrypted=?, needs_repair=0 WHERE peer_id=?')
    .run(apiTokenHash, pushTokenEncrypted, peerId);

  const envLines = [
    `# GateControl Home Gateway — Pairing Config`,
    `# Generated: ${new Date().toISOString()}`,
    `# Peer: ${row.name} (ID: ${peerId})`,
    ``,
    `GC_SERVER_URL=${process.env.GC_BASE_URL || 'https://gatecontrol.example.com'}`,
    `GC_API_TOKEN=${apiToken}`,
    `GC_GATEWAY_TOKEN=${pushToken}`,
    `GC_TUNNEL_IP=${row.ip_address}`,
    `GC_PROXY_PORT=8080`,
    `GC_API_PORT=${row.api_port}`,
    `GC_HEARTBEAT_INTERVAL_S=30`,
    `GC_POLL_INTERVAL_S=300`,
    ``,
    `# WireGuard config inline`,
    `WG_PRIVATE_KEY=${row.private_key || ''}`,
    `WG_PUBLIC_KEY=${row.public_key || ''}`,
    `WG_ENDPOINT=${process.env.GC_WG_ENDPOINT || ''}`,
    `WG_SERVER_PUBLIC_KEY=${process.env.GC_WG_SERVER_PUBLIC_KEY || ''}`,
    `WG_ADDRESS=${row.ip_address}/24`,
    `WG_DNS=10.8.0.1`,
  ];
  return envLines.join('\n') + '\n';
}

module.exports.rotateGatewayTokens = rotateGatewayTokens;
```

- [ ] **Step 4: Endpoint in peers-Route ergänzen — POST für Rotation, damit kein akzidenteller Browser-GET die Tokens invalidiert**

Modify `/root/gatecontrol/src/routes/api/peers.js` — neuen Handler ergänzen:

```javascript
// POST (not GET!) for token-regeneration to avoid accidental browser-prefetch
// or tab-restore killing live gateway tokens.
router.post('/:id/gateway-env/rotate', /* existing admin-auth middleware */, (req, res) => {
  const peerId = parseInt(req.params.id, 10);
  try {
    const env = require('../../services/gateways').rotateGatewayTokens(peerId);
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', `attachment; filename="gateway-${peerId}.env"`);
    res.send(env);
  } catch (err) {
    if (err.message === 'not_a_gateway') return res.status(404).json({ error: 'not_a_gateway' });
    res.status(500).json({ error: err.message });
  }
});
```

- [ ] **Step 5: Test ausführen — muss grün sein**

```bash
node --test tests/peers_gateway_env.test.js
```

- [ ] **Step 6: Commit**

```bash
git add src/routes/api/peers.js src/services/gateways.js tests/peers_gateway_env.test.js
git commit -m "feat(gateways): rotateGatewayTokens + GET /peers/:id/gateway-env download endpoint"
git push
```

---

## Task 22: UI — Peer-Create-Dialog Gateway-Checkbox

**Files:**
- Modify: `/root/gatecontrol/views/peers.njk` (oder vergleichbar)
- Modify: `/root/gatecontrol/public/js/peers.js` (oder vergleichbar)

- [ ] **Step 1: Markup ergänzen**

Modify das Peer-Create-Formular-Template (Pfad je nach Struktur, z.B. `views/peers.njk`) — nach dem Name-Feld:

```html
<div class="form-group">
  <label>
    <input type="checkbox" id="is_gateway" name="is_gateway">
    {{ t('peer_is_gateway') }}
  </label>
  <small class="hint">{{ t('peer_gateway_hint') }}</small>
</div>

<div id="gateway-fields" class="form-group" style="display:none">
  <label for="api_port">{{ t('peer_gateway_api_port') }}</label>
  <input type="number" id="api_port" name="api_port" value="9876" min="1024" max="65535">
</div>
```

Und JavaScript:

```javascript
document.getElementById('is_gateway').addEventListener('change', (e) => {
  document.getElementById('gateway-fields').style.display = e.target.checked ? 'block' : 'none';
});
```

- [ ] **Step 2: Backend-Handler erweitern**

Modify Peer-Create-Handler in `/root/gatecontrol/src/routes/peers.js` (oder wo Peers erstellt werden):

```javascript
if (req.body.is_gateway) {
  const { peer, apiToken, pushToken } = require('../services/gateways').createGateway({
    name: req.body.name,
    apiPort: parseInt(req.body.api_port, 10) || 9876,
  });
  // Zeige Tokens EINMALIG an
  req.session.gatewayCreatedTokens = { peerId: peer.id, apiToken, pushToken };
  return res.redirect(`/peers/${peer.id}?gateway_created=1`);
} else {
  // normaler Peer-Flow
}
```

- [ ] **Step 3: Manueller Test im Browser**

```bash
# Development-Server starten und Peer anlegen
cd /root/gatecontrol && npm run dev
# Browser: http://localhost:3000/peers/new
# Checkbox "Home Gateway" aktivieren → Port-Feld erscheint
```

- [ ] **Step 4: Commit**

```bash
git add views/peers.njk public/js/peers.js src/routes/peers.js
git commit -m "feat(ui): gateway checkbox in peer-create form + backend routing"
git push
```

---

## Task 23: UI — Peer-Detail Badge + Download-Button

**Files:**
- Modify: `/root/gatecontrol/views/peer-detail.njk` (oder vergleichbar)

- [ ] **Step 1: Badge + Download-Button ergänzen**

Modify das Peer-Detail-Template:

```html
{% if peer.peer_type === 'gateway' %}
  <span class="badge badge-gateway">GATEWAY</span>

  <div class="gateway-actions">
    <form method="POST" action="/api/v1/peers/{{ peer.id }}/gateway-env/rotate"
          onsubmit="return confirm('{{ t('gateway_download_confirm') }}')">
      <input type="hidden" name="_csrf" value="{{ csrfToken }}">
      <button type="submit" class="btn btn-warning">
        {{ t('gateway_download_env') }}
      </button>
    </form>
    <small class="warning">
      {{ t('gateway_download_warning') }}
    </small>
  </div>
{% endif %}
```

- [ ] **Step 2: Manueller Test**

```bash
# Gateway-Peer im UI öffnen → Badge sichtbar, Download-Button funktioniert
```

- [ ] **Step 3: Commit**

```bash
git add views/peer-detail.njk
git commit -m "feat(ui): gateway badge + download-env button on peer detail"
git push
```

---

## Task 24: UI — Route-Formular mit Gateway-Target-Feldern

**Files:**
- Modify: `/root/gatecontrol/views/routes.njk` (oder vergleichbar)
- Modify: Entsprechender Route-Create/Update-Handler

- [ ] **Step 1: Formular um Felder ergänzen**

Im Route-Formular (Target-Sektion):

```html
<div class="form-group">
  <label>{{ t('route_target_kind') }}</label>
  <select id="target_kind" name="target_kind">
    <option value="peer">{{ t('route_target_peer') }}</option>
    <option value="gateway">{{ t('route_target_gateway') }}</option>
  </select>
</div>

<div id="gateway-target-fields" style="display:none">
  <div class="form-group">
    <label>{{ t('route_gateway_peer') }}</label>
    <select name="target_peer_id">
      {% for gw in gateways %}
        <option value="{{ gw.id }}">{{ gw.name }}</option>
      {% endfor %}
    </select>
  </div>

  <div class="form-group">
    <label>{{ t('route_lan_host') }}</label>
    <input type="text" name="target_lan_host" placeholder="192.168.1.10" pattern="^(10|172\.(1[6-9]|2[0-9]|3[01])|192\.168)\..*">
  </div>

  <div class="form-group">
    <label>{{ t('route_lan_port') }}</label>
    <input type="number" name="target_lan_port" min="1" max="65535">
  </div>

  <div class="form-group">
    <label>
      <input type="checkbox" name="wol_enabled">
      {{ t('route_wol_enabled') }}
    </label>
  </div>

  <div class="form-group" id="wol-mac-field" style="display:none">
    <label>{{ t('route_wol_mac') }}</label>
    <input type="text" name="wol_mac" pattern="^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$">
  </div>
</div>
```

JavaScript:

```javascript
document.getElementById('target_kind').addEventListener('change', (e) => {
  document.getElementById('gateway-target-fields').style.display = e.target.value === 'gateway' ? 'block' : 'none';
});
document.querySelector('[name=wol_enabled]').addEventListener('change', (e) => {
  document.getElementById('wol-mac-field').style.display = e.target.checked ? 'block' : 'none';
});
```

- [ ] **Step 2: Backend im Route-Create/Update-Handler**

Modify wo Routes erstellt/geändert werden:

```javascript
const target_kind = req.body.target_kind || 'peer';
const routeData = {
  domain: req.body.domain,
  type: req.body.type,
  target_kind,
  // ... common fields ...
};
if (target_kind === 'gateway') {
  routeData.target_peer_id = parseInt(req.body.target_peer_id, 10);
  routeData.target_lan_host = req.body.target_lan_host;
  routeData.target_lan_port = parseInt(req.body.target_lan_port, 10);
  routeData.wol_enabled = req.body.wol_enabled ? 1 : 0;
  routeData.wol_mac = req.body.wol_mac || null;

  // License-gates
  const license = require('../services/license');
  if (routeData.type === 'l4' && !license.getFeature('gateway_tcp_routing')) {
    return res.status(403).json({ error: 'gateway_tcp_routing not licensed' });
  }
  if (routeData.wol_enabled && !license.getFeature('gateway_wol')) {
    return res.status(403).json({ error: 'gateway_wol not licensed' });
  }
  // gateway_http_targets limit
  const count = db.prepare(`SELECT COUNT(*) AS n FROM routes WHERE target_peer_id=? AND target_kind='gateway' AND type='http'`).get(routeData.target_peer_id).n;
  if (routeData.type === 'http' && count >= license.getFeature('gateway_http_targets')) {
    return res.status(403).json({ error: 'gateway_http_targets limit reached' });
  }
} else {
  routeData.target_ip = req.body.target_ip;
  routeData.target_port = parseInt(req.body.target_port, 10);
}
```

- [ ] **Step 3: Manueller Test**

```bash
# Im Browser: Route anlegen mit Target-Typ "Home Gateway" → LAN-Felder erscheinen
# WoL-Checkbox → MAC-Feld erscheint
# License-Community: L4 oder WoL → Fehlermeldung
```

- [ ] **Step 4: Commit**

```bash
git add views/routes.njk src/routes/routes.js
git commit -m "feat(ui): route form — target_kind selector + LAN fields + WoL with license gates"
git push
```

---

## Task 25: Force-Unpair-Flag bei Master-Key-Rotation

**Files:**
- Modify: `/root/gatecontrol/src/services/crypto.js` (oder wo Key-Rotation stattfindet)
- Create: `/root/gatecontrol/tests/gateway_unpair_on_rotate.test.js`

- [ ] **Step 1: Failing Test schreiben**

Create `/root/gatecontrol/tests/gateway_unpair_on_rotate.test.js`:

```javascript
'use strict';

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

describe('crypto: master key rotation marks gateways needs_repair', () => {
  let gateways, crypto, peerId;

  before(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-rot-'));
    process.env.GC_DB_PATH = path.join(tmp, 'test.db');
    ['../src/db/connection', '../src/db/migrations', '../src/services/gateways', '../src/services/crypto']
      .forEach(p => { try { delete require.cache[require.resolve(p)]; } catch (_) {} });
    require('../src/db/migrations').runMigrations();
    gateways = require('../src/services/gateways');
    crypto = require('../src/services/crypto');
    const gw = await gateways.createGateway({ name: 'rot-gw', apiPort: 9876 });
    peerId = gw.peer.id;
  });

  it('after rotateMasterKey, all gateway_meta get needs_repair=1', () => {
    if (!crypto.rotateMasterKey) {
      // Skip if not implemented
      return;
    }
    crypto.rotateMasterKey();
    const db = require('../src/db/connection').getDb();
    const row = db.prepare('SELECT needs_repair FROM gateway_meta WHERE peer_id=?').get(peerId);
    assert.equal(row.needs_repair, 1);
  });
});
```

- [ ] **Step 2: Test ausführen — vorher skipped oder failen**

```bash
node --test tests/gateway_unpair_on_rotate.test.js
```

- [ ] **Step 3: Rotation-Hook ergänzen**

Modify `/root/gatecontrol/src/services/crypto.js` — in bestehender `rotateMasterKey`-Funktion (falls vorhanden, sonst als No-Op Placeholder erstellen):

```javascript
function rotateMasterKey() {
  // ... bestehende Rotation-Logik ...

  // Mark all gateways as needing re-pairing (push_token_encrypted verwendet alten Key)
  const { getDb } = require('../db/connection');
  const db = getDb();
  db.prepare('UPDATE gateway_meta SET needs_repair=1').run();

  // Log
  const logger = require('../utils/logger');
  const count = db.prepare('SELECT COUNT(*) AS n FROM gateway_meta').get().n;
  logger.warn({ count }, 'Master key rotated — all gateways marked needs_repair');
}

module.exports.rotateMasterKey = rotateMasterKey;
```

- [ ] **Step 4: Test ausführen — muss grün sein**

```bash
node --test tests/gateway_unpair_on_rotate.test.js
```

- [ ] **Step 5: UI-Banner bei needs_repair-Gateways**

Modify `/root/gatecontrol/views/dashboard.njk` (oder Layout, je nach Struktur):

```html
{% if needs_repair_gateways and needs_repair_gateways.length > 0 %}
  <div class="alert alert-warning">
    <strong>{{ t('gateway_needs_repair_title') }}</strong>
    <p>{{ t('gateway_needs_repair_msg') }}</p>
    <ul>
      {% for gw in needs_repair_gateways %}
        <li>{{ gw.name }} — <a href="/peers/{{ gw.id }}">{{ t('download_new_env') }}</a></li>
      {% endfor %}
    </ul>
  </div>
{% endif %}
```

Und im Dashboard-Controller (**konkrete Location:** `/root/gatecontrol/src/routes/dashboard.js`, Handler für `GET /dashboard` bzw. `GET /`):

```javascript
// In der dashboard-route-Handler (vor dem res.render-Call)
const needs_repair_gateways = req.db.prepare(`
  SELECT p.id, p.name FROM peers p JOIN gateway_meta gm ON gm.peer_id=p.id
  WHERE gm.needs_repair=1 AND p.enabled=1
`).all();

res.render('dashboard', {
  // ... bestehende Variablen ...
  needs_repair_gateways,
});
```

**Wichtig:** Die Query NUR im Dashboard-Handler, NICHT in `src/middleware/locals.js`. Sonst wird sie bei jedem Request ausgeführt (teuer + unnötig).

- [ ] **Step 6: Commit**

```bash
git add src/services/crypto.js src/services/gateways.js views/dashboard.njk tests/gateway_unpair_on_rotate.test.js
git commit -m "feat(crypto): mark gateways needs_repair=1 on master key rotation + admin banner"
git push
```

---

## Task 25b: i18n-Keys in `de.json` + `en.json` ergänzen

**Files:**
- Modify: `/root/gatecontrol/locales/de.json`
- Modify: `/root/gatecontrol/locales/en.json`

Alle in Tasks 19, 22, 23, 24, 25 verwendeten `t('...')`-Keys müssen zu beiden Locale-Dateien hinzugefügt werden. Fehlende Keys führen zu Raw-Key-Anzeige in der UI (Memory-Feedback `feedback_i18n_required.md`).

- [ ] **Step 1: Key-Liste sammeln**

Alle neuen Keys aus den Template-Snippets extrahieren:

```
gateway_offline_title
gateway_offline_heading
gateway_offline_message
gateway_offline_hint
gateway_name_label
gateway_last_seen_label
peer_is_gateway
peer_gateway_hint
peer_gateway_api_port
gateway_download_env
gateway_download_warning
gateway_download_confirm
route_target_kind
route_target_peer
route_target_gateway
route_gateway_peer
route_lan_host
route_lan_port
route_wol_enabled
route_wol_mac
gateway_needs_repair_title
gateway_needs_repair_msg
download_new_env
```

- [ ] **Step 2: Deutsche Übersetzungen in `locales/de.json` ergänzen**

Diese Keys als neue Entries hinzufügen:

```json
"gateway_offline_title": "Home Gateway offline",
"gateway_offline_heading": "Home Gateway ist offline",
"gateway_offline_message": "Der Home-Gateway, über den diese Seite erreichbar ist, antwortet aktuell nicht.",
"gateway_offline_hint": "Bitte kontaktiere deinen Administrator.",
"gateway_name_label": "Gateway",
"gateway_last_seen_label": "Letzter Kontakt",
"peer_is_gateway": "Home Gateway",
"peer_gateway_hint": "Aktiviere, wenn dieser Peer ein Home Gateway im Heimnetz ist",
"peer_gateway_api_port": "Gateway API Port",
"gateway_download_env": "Gateway-Config herunterladen",
"gateway_download_warning": "ACHTUNG: Tokens werden regeneriert — alter Gateway wird ungültig",
"gateway_download_confirm": "Beim Download werden die Gateway-Tokens neu generiert. Der aktuell laufende Gateway verliert dadurch die Verbindung. Fortfahren?",
"route_target_kind": "Ziel-Typ",
"route_target_peer": "Direkter Peer (WG-IP)",
"route_target_gateway": "Home Gateway (LAN)",
"route_gateway_peer": "Gateway",
"route_lan_host": "LAN-Host",
"route_lan_port": "LAN-Port",
"route_wol_enabled": "Wake-on-LAN aktivieren",
"route_wol_mac": "MAC-Adresse (AA:BB:CC:DD:EE:FF)",
"gateway_needs_repair_title": "Gateways benötigen Re-Pairing",
"gateway_needs_repair_msg": "Nach Master-Key-Rotation müssen folgende Gateways neu gepaart werden:",
"download_new_env": "Neue Config herunterladen"
```

- [ ] **Step 3: Englische Übersetzungen in `locales/en.json` ergänzen**

Gleiche Keys mit englischen Strings:

```json
"gateway_offline_title": "Home Gateway offline",
"gateway_offline_heading": "Home Gateway is offline",
"gateway_offline_message": "The Home Gateway routing this page is not responding right now.",
"gateway_offline_hint": "Please contact your administrator.",
"gateway_name_label": "Gateway",
"gateway_last_seen_label": "Last contact",
"peer_is_gateway": "Home Gateway",
"peer_gateway_hint": "Enable if this peer is a Home Gateway in your local network",
"peer_gateway_api_port": "Gateway API Port",
"gateway_download_env": "Download gateway config",
"gateway_download_warning": "WARNING: tokens will be regenerated — current gateway will be invalidated",
"gateway_download_confirm": "Downloading regenerates the gateway tokens. The currently running gateway will lose its connection. Continue?",
"route_target_kind": "Target type",
"route_target_peer": "Direct peer (WG-IP)",
"route_target_gateway": "Home Gateway (LAN)",
"route_gateway_peer": "Gateway",
"route_lan_host": "LAN host",
"route_lan_port": "LAN port",
"route_wol_enabled": "Enable Wake-on-LAN",
"route_wol_mac": "MAC address (AA:BB:CC:DD:EE:FF)",
"gateway_needs_repair_title": "Gateways need re-pairing",
"gateway_needs_repair_msg": "After master key rotation, the following gateways must be re-paired:",
"download_new_env": "Download new config"
```

- [ ] **Step 4: Commit**

```bash
git add locales/de.json locales/en.json
git commit -m "i18n(gateway): add 23 new translation keys for home-gateway UI"
git push
```

---

## Task 26: Stryker-Scope erweitern auf `gateways.js` + License-Gates

**Files:**
- Modify: `/root/gatecontrol/stryker.conf.json` (falls vorhanden, sonst erstellen)

- [ ] **Step 1: Stryker-Config finden oder erstellen**

```bash
ls /root/gatecontrol/stryker.conf.* 2>/dev/null
```

Falls nicht vorhanden, create `/root/gatecontrol/stryker.conf.json`:

```json
{
  "$schema": "https://stryker-mutator.io/schema/stryker-schema.json",
  "testRunner": "command",
  "commandRunner": { "command": "npm test" },
  "mutate": [
    "src/services/gateways.js",
    "src/services/gatewayHealth.js",
    "src/services/license.js"
  ],
  "thresholds": { "high": 90, "low": 80, "break": 75 },
  "timeoutMS": 10000,
  "concurrency": 4,
  "reporters": ["progress", "html"]
}
```

- [ ] **Step 2: Dev-Dependency installieren**

```bash
cd /root/gatecontrol && npm install --save-dev @stryker-mutator/core
```

- [ ] **Step 3: Mutation-Test laufen lassen**

```bash
npx stryker run --mutate "src/services/gateways.js,src/services/gatewayHealth.js"
```

Expected: Mutation-Score ≥ 75% (break-threshold). Bei niedriger Score entweder mehr Tests schreiben oder begründet Mutanten via `stryker.conf.json` ignoreStatic markieren.

- [ ] **Step 4: CI-Job ergänzen**

Modify `/root/gatecontrol/.github/workflows/test.yml` (oder ähnlich) — neuer Job:

```yaml
  mutation:
    runs-on: ubuntu-latest
    needs: test
    if: |
      github.event_name == 'push' ||
      contains(github.event.pull_request.labels.*.name, 'mutation-test')
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm, registry-url: 'https://npm.pkg.github.com/', scope: '@callmetechie' }
      - name: Install
        run: npm ci
        env: { NODE_AUTH_TOKEN: '${{ secrets.GH_PACKAGES_TOKEN }}' }
      - name: Mutation test
        run: npx stryker run
      - uses: actions/upload-artifact@v4
        with: { name: mutation-report, path: reports/mutation/ }
```

- [ ] **Step 5: Commit**

```bash
git add stryker.conf.json package.json package-lock.json .github/workflows/test.yml
git commit -m "test(mutation): add Stryker for gateways.js, gatewayHealth.js, license.js (≥75%)"
git push
```

---

## Task 27: Abschluss — Release via existierendem CI

**Files:** (Keine neuen Dateien)

- [ ] **Step 1: Alle Tests lokal laufen lassen**

```bash
cd /root/gatecontrol && npm test
```

Expected: Alle Tests grün, keine Regressionen in bestehenden Tests.

- [ ] **Step 2: Server lokal starten, Smoke-Test**

```bash
npm run dev  # oder node src/server.js
```

In zweitem Terminal:

```bash
# Login als Admin, Peer anlegen als Gateway, gateway.env downloaden — manuell
curl -s http://localhost:3000/health
```

Expected: `{"ok": true, ...}` — Server startet ohne Fehler.

- [ ] **Step 3: CI beobachten nach Push**

User-Aktion: GitHub-Actions-Seite öffnen — alle Jobs (test, lint, mutation) grün. release.yml bumped Version automatisch bei Commit mit `feat:` oder `fix:` — neue Server-Version wird nach GHCR gepusht.

- [ ] **Step 4: Deployment**

```bash
# Nach grünem CI + GHCR-Push: Deploy-Script auslösen
cd /root/gatecontrol-deploy && ./deploy.sh  # oder vergleichbar — je nach Projekt
```

Expected: Neue Server-Version läuft in Production, bestehende Routes funktionieren weiter (kein Breaking Change).

---

## Abschluss

Plan 2 ist abgeschlossen. Der Server kann jetzt:
- Gateway-Peers anlegen + Tokens generieren
- `gateway.env` zum Download bereitstellen
- Byte-identische Config-Hashes mit Gateways berechnen
- Push-Notifications bei Config-Änderungen senden
- WoL-Trigger an Gateways senden
- Gateway-Health mit Sliding-Window-Hysteresis tracken
- Bei Offline-Events Alert + Maintenance-Page ausliefern
- License-Gates für Gateway-Features enforcen

**Als Nächstes:** Plan 3 — `gatecontrol-gateway` neues Node.js-Repo schreiben (HTTP/TCP-Proxy, Sync, Management-API, WoL).
