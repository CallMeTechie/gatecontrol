# Layer 4 Routing Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add TCP/UDP Layer 4 proxy support to GateControl via caddy-l4 plugin, enabling raw protocol forwarding (RDP, SSH, databases, etc.) with optional TLS-SNI routing.

**Architecture:** Extend the existing routes system with a `route_type` field (`http`/`l4`). L4 routes generate a parallel `apps.layer4` section in the Caddy JSON config alongside the existing `apps.http`. Docker switches to `network_mode: host` for dynamic port binding.

**Tech Stack:** caddy-l4 plugin (compiled via xcaddy), SQLite migrations, Express.js API, Nunjucks templates, vanilla JS frontend

**Spec:** `docs/superpowers/specs/2026-03-15-layer4-routing-design.md`

---

## File Map

### Create
- `tests/l4.test.js` — L4 validation, config generation, and conflict detection tests
- `src/services/l4.js` — L4-specific logic: server grouping, config generation, conflict detection, port helpers

### Modify
- `src/db/migrations.js` — Add L4 columns, relax domain UNIQUE constraint
- `src/utils/validate.js` — Add L4 field validators
- `src/services/routes.js` — Integrate L4 config into `buildCaddyConfig()`, update CRUD
- `src/routes/api/routes.js` — Accept/return L4 fields, type filter
- `src/services/backup.js` — Include L4 fields in export/restore
- `config/default.js` — Add `l4` config section
- `Dockerfile` — Custom Caddy build with L4 plugin
- `deploy/docker-compose.yml` — Switch to `network_mode: host`
- `templates/default/pages/routes.njk` — Add L4 form fields
- `templates/default/partials/modals/route-edit.njk` — Add L4 edit fields
- `public/js/routes.js` — Dynamic form toggling, L4 tag rendering
- `src/i18n/en.json` — L4 translation keys
- `src/i18n/de.json` — L4 translation keys

---

## Chunk 1: Infrastructure and Configuration

### Task 1: Dockerfile — Custom Caddy with L4 plugin

**Files:**
- Modify: `/root/gatecontrol/Dockerfile`

- [ ] **Step 1: Update Dockerfile with caddy-builder stage**

Replace the current Dockerfile content. Key changes:
1. Add `caddy:2-builder` stage that compiles Caddy with caddy-l4
2. Remove `caddy` from `apk add` in runtime stage
3. Copy custom binary from builder
4. Remove `EXPOSE` directive (meaningless with host networking)

```dockerfile
# Stage 1: Caddy with L4 plugin
FROM caddy:2-builder AS caddy-builder
RUN xcaddy build \
    --with github.com/mholt/caddy-l4

# Stage 2: Node dependencies
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --production --ignore-scripts && \
    npm rebuild argon2 better-sqlite3

# Stage 3: Runtime
FROM node:20-alpine

RUN apk add --no-cache \
    wireguard-tools \
    iptables ip6tables \
    supervisor curl procps openssl

COPY --from=caddy-builder /usr/bin/caddy /usr/local/bin/caddy

WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY . .

RUN mkdir -p /data/caddy /data/wireguard /etc/wireguard && \
    chmod 700 /data/wireguard /etc/wireguard

VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -f http://127.0.0.1:3000/login || exit 1

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
CMD ["supervisord", "-c", "/app/supervisord.conf"]
```

- [ ] **Step 2: Verify Dockerfile syntax**

Run: `cd /root/gatecontrol && docker build --check .` or visually verify the Dockerfile is valid.

- [ ] **Step 3: Commit**

```
git add Dockerfile
git commit -m "feat: build custom Caddy with caddy-l4 plugin"
```

### Task 2: docker-compose.yml — Switch to host networking

**Files:**
- Modify: `/root/gatecontrol/deploy/docker-compose.yml`

- [ ] **Step 1: Update docker-compose.yml**

Replace with:

```yaml
services:
  gatecontrol:
    image: ghcr.io/callmetechie/gatecontrol:latest
    container_name: gatecontrol
    network_mode: host
    cap_add:
      - NET_ADMIN
      - SYS_MODULE
    volumes:
      - gatecontrol-data:/data
    env_file:
      - .env
    restart: unless-stopped

volumes:
  gatecontrol-data:
```

Changes: removed `ports`, removed `sysctls` (entrypoint.sh handles these), added `network_mode: host`.

- [ ] **Step 2: Commit**

```
git add deploy/docker-compose.yml
git commit -m "feat: switch to host networking for dynamic L4 port binding"
```

### Task 3: Configuration — Add L4 settings

**Files:**
- Modify: `/root/gatecontrol/config/default.js:59-64` (after caddy section)

- [ ] **Step 1: Add L4 config section**

After the existing `caddy` block (around line 64), add:

```javascript
  l4: {
    blockedPorts: (process.env.GC_L4_BLOCKED_PORTS || '80,443,2019,3000,51820')
      .split(',').map(p => parseInt(p.trim(), 10)).filter(Boolean),
    maxPortRange: parseInt(process.env.GC_L4_MAX_PORT_RANGE, 10) || 100,
  },
```

- [ ] **Step 2: Commit**

```
git add config/default.js
git commit -m "feat: add L4 configuration (blocked ports, max port range)"
```

---

## Chunk 2: Database Migration

### Task 4: Add L4 columns and relax domain constraint

**Files:**
- Modify: `/root/gatecontrol/src/db/migrations.js:118-145` (after existing migrations, before indexes)

- [ ] **Step 1: Add L4 migration block**

After the existing `backend_https` migration try/catch block (around line 124), add a new migration block. Since SQLite does not support ALTER COLUMN, the domain constraint change requires table recreation:

```javascript
  // Migration: Add Layer 4 routing support
  try {
    db.exec(`ALTER TABLE routes ADD COLUMN route_type TEXT NOT NULL DEFAULT 'http'`);
    db.exec(`ALTER TABLE routes ADD COLUMN l4_protocol TEXT`);
    db.exec(`ALTER TABLE routes ADD COLUMN l4_listen_port TEXT`);
    db.exec(`ALTER TABLE routes ADD COLUMN l4_tls_mode TEXT`);
    logger.info('Migration: Added L4 routing columns');
  } catch (e) {
    // Columns already exist
  }

  // Migration: Relax domain UNIQUE NOT NULL constraint for L4 routes without domain
  try {
    const hasNullableDomain = db.prepare(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name='routes'`
    ).get();
    if (hasNullableDomain.sql.includes('domain TEXT NOT NULL UNIQUE')) {
      db.exec(`
        CREATE TABLE routes_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          domain TEXT,
          target_ip TEXT NOT NULL,
          target_port INTEGER NOT NULL,
          description TEXT,
          peer_id INTEGER,
          https_enabled INTEGER NOT NULL DEFAULT 1,
          basic_auth_enabled INTEGER NOT NULL DEFAULT 0,
          basic_auth_user TEXT,
          basic_auth_password_hash TEXT,
          enabled INTEGER NOT NULL DEFAULT 1,
          backend_https INTEGER NOT NULL DEFAULT 0,
          route_type TEXT NOT NULL DEFAULT 'http',
          l4_protocol TEXT,
          l4_listen_port TEXT,
          l4_tls_mode TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (peer_id) REFERENCES peers(id) ON DELETE SET NULL
        );
        INSERT INTO routes_new SELECT
          id, domain, target_ip, target_port, description, peer_id,
          https_enabled, basic_auth_enabled, basic_auth_user, basic_auth_password_hash,
          enabled, backend_https, route_type, l4_protocol, l4_listen_port, l4_tls_mode,
          created_at, updated_at
        FROM routes;
        DROP TABLE routes;
        ALTER TABLE routes_new RENAME TO routes;
      `);
      logger.info('Migration: Relaxed domain constraint for L4 routes');
    }
  } catch (e) {
    logger.warn('Migration: Domain constraint change skipped', e.message);
  }
```

- [ ] **Step 2: Update indexes section**

In the indexes block (around line 127-141), add after the existing route indexes:

```javascript
    db.exec(`CREATE INDEX IF NOT EXISTS idx_routes_route_type ON routes(route_type)`);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_routes_domain_unique ON routes(domain) WHERE domain IS NOT NULL AND domain != ''`);
```

- [ ] **Step 3: Commit**

```
git add src/db/migrations.js
git commit -m "feat: add L4 columns and relax domain constraint migration"
```

---

## Chunk 3: Validation and Tests (TDD)

### Task 5: Write L4 validation tests

**Files:**
- Create: `/root/gatecontrol/tests/l4.test.js`

- [ ] **Step 1: Write validation tests**

```javascript
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

let validate;

describe('L4 Validation', () => {
  before(() => {
    validate = require('../src/utils/validate');
  });

  describe('validateL4Protocol', () => {
    it('accepts tcp', () => {
      assert.equal(validate.validateL4Protocol('tcp'), null);
    });
    it('accepts udp', () => {
      assert.equal(validate.validateL4Protocol('udp'), null);
    });
    it('rejects invalid protocol', () => {
      assert.ok(validate.validateL4Protocol('icmp'));
    });
    it('rejects empty', () => {
      assert.ok(validate.validateL4Protocol(''));
    });
    it('rejects null', () => {
      assert.ok(validate.validateL4Protocol(null));
    });
  });

  describe('validateL4ListenPort', () => {
    it('accepts single port', () => {
      assert.equal(validate.validateL4ListenPort('3389'), null);
    });
    it('accepts port range', () => {
      assert.equal(validate.validateL4ListenPort('5000-5010'), null);
    });
    it('rejects port 0', () => {
      assert.ok(validate.validateL4ListenPort('0'));
    });
    it('rejects port above 65535', () => {
      assert.ok(validate.validateL4ListenPort('70000'));
    });
    it('rejects inverted range', () => {
      assert.ok(validate.validateL4ListenPort('5010-5000'));
    });
    it('rejects range exceeding max size', () => {
      assert.ok(validate.validateL4ListenPort('1000-2000'));
    });
    it('rejects non-numeric', () => {
      assert.ok(validate.validateL4ListenPort('abc'));
    });
    it('rejects empty', () => {
      assert.ok(validate.validateL4ListenPort(''));
    });
  });

  describe('validateL4TlsMode', () => {
    it('accepts none', () => {
      assert.equal(validate.validateL4TlsMode('none'), null);
    });
    it('accepts passthrough', () => {
      assert.equal(validate.validateL4TlsMode('passthrough'), null);
    });
    it('accepts terminate', () => {
      assert.equal(validate.validateL4TlsMode('terminate'), null);
    });
    it('rejects invalid', () => {
      assert.ok(validate.validateL4TlsMode('invalid'));
    });
    it('rejects empty', () => {
      assert.ok(validate.validateL4TlsMode(''));
    });
  });

  describe('isPortBlocked', () => {
    it('blocks port 80', () => {
      assert.equal(validate.isPortBlocked(80), true);
    });
    it('blocks port 443', () => {
      assert.equal(validate.isPortBlocked(443), true);
    });
    it('blocks port 2019', () => {
      assert.equal(validate.isPortBlocked(2019), true);
    });
    it('blocks port 3000', () => {
      assert.equal(validate.isPortBlocked(3000), true);
    });
    it('blocks port 51820', () => {
      assert.equal(validate.isPortBlocked(51820), true);
    });
    it('allows port 3389', () => {
      assert.equal(validate.isPortBlocked(3389), false);
    });
  });

  describe('parsePortRange', () => {
    it('parses single port', () => {
      assert.deepEqual(validate.parsePortRange('3389'), { start: 3389, end: 3389 });
    });
    it('parses range', () => {
      assert.deepEqual(validate.parsePortRange('5000-5010'), { start: 5000, end: 5010 });
    });
    it('returns null for invalid', () => {
      assert.equal(validate.parsePortRange('abc'), null);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /root/gatecontrol && npm test -- --test-name-pattern="L4 Validation" 2>&1 | head -30`
Expected: FAIL — functions do not exist yet

- [ ] **Step 3: Commit test file**

```
git add tests/l4.test.js
git commit -m "test: add L4 validation tests (red)"
```

### Task 6: Implement L4 validators

**Files:**
- Modify: `/root/gatecontrol/src/utils/validate.js:61-66` (before sanitize function)

- [ ] **Step 1: Add L4 validation functions**

Before the `sanitize` function (line 63), add:

```javascript
function validateL4Protocol(protocol) {
  if (!protocol || !['tcp', 'udp'].includes(protocol)) {
    return 'L4 protocol must be tcp or udp';
  }
  return null;
}

function parsePortRange(portStr) {
  if (!portStr || typeof portStr !== 'string') return null;
  const trimmed = portStr.trim();
  const rangeMatch = trimmed.match(/^(\d+)-(\d+)$/);
  if (rangeMatch) {
    const start = parseInt(rangeMatch[1], 10);
    const end = parseInt(rangeMatch[2], 10);
    if (start >= 1 && end <= 65535 && start <= end) return { start, end };
    return null;
  }
  const single = parseInt(trimmed, 10);
  if (!isNaN(single) && single >= 1 && single <= 65535 && String(single) === trimmed) {
    return { start: single, end: single };
  }
  return null;
}

function validateL4ListenPort(portStr) {
  const range = parsePortRange(portStr);
  if (!range) return 'Invalid port or port range';
  const config = require('../../config/default');
  const maxRange = (config.l4 && config.l4.maxPortRange) || 100;
  if (range.end - range.start + 1 > maxRange) {
    return 'Port range exceeds maximum of ' + maxRange + ' ports';
  }
  return null;
}

function validateL4TlsMode(mode) {
  if (!mode || !['none', 'passthrough', 'terminate'].includes(mode)) {
    return 'TLS mode must be none, passthrough, or terminate';
  }
  return null;
}

function isPortBlocked(port) {
  const config = require('../../config/default');
  const blocked = (config.l4 && config.l4.blockedPorts) || [80, 443, 2019, 3000, 51820];
  return blocked.includes(port);
}
```

- [ ] **Step 2: Update module.exports**

At the end of the file, update the exports to include the new functions:

```javascript
module.exports = {
  validateDomain,
  validatePort,
  validateDescription,
  validateBasicAuthUser,
  validateBasicAuthPassword,
  sanitize,
  validateL4Protocol,
  validateL4ListenPort,
  validateL4TlsMode,
  isPortBlocked,
  parsePortRange,
};
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `cd /root/gatecontrol && npm test -- --test-name-pattern="L4 Validation"`
Expected: All PASS

- [ ] **Step 4: Commit**

```
git add src/utils/validate.js
git commit -m "feat: add L4 validation functions (port, protocol, TLS mode)"
```

---

## Chunk 4: L4 Config Generation (TDD)

### Task 7: Write L4 config generation tests

**Files:**
- Modify: `/root/gatecontrol/tests/l4.test.js` (append after validation tests)

- [ ] **Step 1: Add config generation tests**

Append to `tests/l4.test.js`:

```javascript
describe('L4 Config Generation', () => {
  let l4;
  before(() => {
    l4 = require('../src/services/l4');
  });

  describe('buildL4Servers', () => {
    it('generates single TCP server for one route', () => {
      const routes = [{
        id: 1, domain: null, target_ip: '10.8.0.5', target_port: 3389,
        l4_protocol: 'tcp', l4_listen_port: '3389', l4_tls_mode: 'none',
      }];
      const servers = l4.buildL4Servers(routes);
      assert.ok(servers['l4-tcp-3389']);
      assert.deepEqual(servers['l4-tcp-3389'].listen, ['tcp/:3389']);
      assert.equal(servers['l4-tcp-3389'].routes.length, 1);
      assert.equal(servers['l4-tcp-3389'].routes[0].handle[0].handler, 'proxy');
      assert.deepEqual(
        servers['l4-tcp-3389'].routes[0].handle[0].upstreams,
        [{ dial: '10.8.0.5:3389' }]
      );
    });

    it('generates UDP server', () => {
      const routes = [{
        id: 2, domain: null, target_ip: '10.8.0.4', target_port: 27015,
        l4_protocol: 'udp', l4_listen_port: '27015', l4_tls_mode: 'none',
      }];
      const servers = l4.buildL4Servers(routes);
      assert.ok(servers['l4-udp-27015']);
      assert.deepEqual(servers['l4-udp-27015'].listen, ['udp/:27015']);
    });

    it('groups TLS-SNI routes on same port into one server', () => {
      const routes = [
        {
          id: 3, domain: 'ssh.example.com', target_ip: '10.8.0.2', target_port: 22,
          l4_protocol: 'tcp', l4_listen_port: '8443', l4_tls_mode: 'passthrough',
        },
        {
          id: 4, domain: 'db.example.com', target_ip: '10.8.0.3', target_port: 5432,
          l4_protocol: 'tcp', l4_listen_port: '8443', l4_tls_mode: 'passthrough',
        },
      ];
      const servers = l4.buildL4Servers(routes);
      assert.ok(servers['l4-tls-8443']);
      assert.equal(servers['l4-tls-8443'].routes.length, 2);
      assert.deepEqual(
        servers['l4-tls-8443'].routes[0].match,
        [{ tls: { sni: ['ssh.example.com'] } }]
      );
      assert.deepEqual(
        servers['l4-tls-8443'].routes[1].match,
        [{ tls: { sni: ['db.example.com'] } }]
      );
    });

    it('generates TLS terminate handler chain', () => {
      const routes = [{
        id: 5, domain: 'rdp.example.com', target_ip: '10.8.0.5', target_port: 3389,
        l4_protocol: 'tcp', l4_listen_port: '9443', l4_tls_mode: 'terminate',
      }];
      const servers = l4.buildL4Servers(routes);
      const srv = servers['l4-tls-9443'];
      assert.ok(srv);
      const route = srv.routes[0];
      assert.deepEqual(route.match, [{ tls: { sni: ['rdp.example.com'] } }]);
      assert.equal(route.handle[0].handler, 'tls');
      assert.equal(route.handle[1].handler, 'proxy');
    });

    it('handles port ranges in listen address', () => {
      const routes = [{
        id: 6, domain: null, target_ip: '10.8.0.6', target_port: 5000,
        l4_protocol: 'tcp', l4_listen_port: '5000-5010', l4_tls_mode: 'none',
      }];
      const servers = l4.buildL4Servers(routes);
      assert.ok(servers['l4-tcp-5000-5010']);
      assert.deepEqual(servers['l4-tcp-5000-5010'].listen, ['tcp/:5000-5010']);
    });

    it('returns empty object for no routes', () => {
      const servers = l4.buildL4Servers([]);
      assert.deepEqual(servers, {});
    });
  });

  describe('validatePortConflicts', () => {
    it('detects duplicate no-TLS routes on same port and protocol', () => {
      const routes = [
        { id: 1, l4_protocol: 'tcp', l4_listen_port: '3389', l4_tls_mode: 'none' },
        { id: 2, l4_protocol: 'tcp', l4_listen_port: '3389', l4_tls_mode: 'none' },
      ];
      const errors = l4.validatePortConflicts(routes);
      assert.ok(errors.length > 0);
    });

    it('allows multiple TLS routes on same port', () => {
      const routes = [
        { id: 1, domain: 'a.com', l4_protocol: 'tcp', l4_listen_port: '8443', l4_tls_mode: 'passthrough' },
        { id: 2, domain: 'b.com', l4_protocol: 'tcp', l4_listen_port: '8443', l4_tls_mode: 'passthrough' },
      ];
      const errors = l4.validatePortConflicts(routes);
      assert.equal(errors.length, 0);
    });

    it('detects blocked ports', () => {
      const routes = [
        { id: 1, l4_protocol: 'tcp', l4_listen_port: '80', l4_tls_mode: 'none' },
      ];
      const errors = l4.validatePortConflicts(routes);
      assert.ok(errors.length > 0);
    });

    it('detects overlapping port ranges', () => {
      const routes = [
        { id: 1, l4_protocol: 'tcp', l4_listen_port: '5000-5010', l4_tls_mode: 'none' },
        { id: 2, l4_protocol: 'tcp', l4_listen_port: '5005-5015', l4_tls_mode: 'none' },
      ];
      const errors = l4.validatePortConflicts(routes);
      assert.ok(errors.length > 0);
    });

    it('allows non-overlapping ranges on same protocol', () => {
      const routes = [
        { id: 1, l4_protocol: 'tcp', l4_listen_port: '5000-5010', l4_tls_mode: 'none' },
        { id: 2, l4_protocol: 'tcp', l4_listen_port: '6000-6010', l4_tls_mode: 'none' },
      ];
      const errors = l4.validatePortConflicts(routes);
      assert.equal(errors.length, 0);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /root/gatecontrol && npm test -- --test-name-pattern="L4 Config" 2>&1 | head -20`
Expected: FAIL — `src/services/l4.js` does not exist yet

- [ ] **Step 3: Commit**

```
git add tests/l4.test.js
git commit -m "test: add L4 config generation and conflict detection tests (red)"
```

### Task 8: Implement L4 config generation service

**Files:**
- Create: `/root/gatecontrol/src/services/l4.js`

- [ ] **Step 1: Create L4 service module**

```javascript
'use strict';

const { parsePortRange, isPortBlocked } = require('../utils/validate');

/**
 * Build Caddy L4 server configs from L4 routes.
 * Groups routes by (protocol, listen_port, tls_mode) into servers.
 */
function buildL4Servers(routes) {
  if (!routes || routes.length === 0) return {};

  const groups = {};
  for (const route of routes) {
    const key = route.l4_protocol + '|' + route.l4_listen_port + '|' + route.l4_tls_mode;
    if (!groups[key]) groups[key] = [];
    groups[key].push(route);
  }

  const servers = {};
  for (const [key, groupRoutes] of Object.entries(groups)) {
    const { l4_protocol, l4_listen_port, l4_tls_mode } = groupRoutes[0];
    const useTls = l4_tls_mode !== 'none';
    const portLabel = l4_listen_port;
    const serverName = useTls
      ? 'l4-tls-' + portLabel
      : 'l4-' + l4_protocol + '-' + portLabel;

    const listenPrefix = l4_protocol === 'udp' ? 'udp' : 'tcp';
    const server = {
      listen: [listenPrefix + '/:' + l4_listen_port],
      routes: groupRoutes.map(function (r) { return buildL4Route(r, l4_tls_mode); }),
    };

    servers[serverName] = server;
  }

  return servers;
}

/**
 * Build a single Caddy L4 route object.
 */
function buildL4Route(route, tlsMode) {
  var target = route.target_ip + ':' + route.target_port;
  var proxyHandler = {
    handler: 'proxy',
    upstreams: [{ dial: target }],
  };

  var caddyRoute = {};

  if (tlsMode === 'none') {
    caddyRoute.handle = [proxyHandler];
  } else if (tlsMode === 'passthrough') {
    caddyRoute.match = [{ tls: { sni: [route.domain] } }];
    caddyRoute.handle = [proxyHandler];
  } else if (tlsMode === 'terminate') {
    caddyRoute.match = [{ tls: { sni: [route.domain] } }];
    caddyRoute.handle = [
      { handler: 'tls' },
      proxyHandler,
    ];
  }

  return caddyRoute;
}

/**
 * Validate L4 routes for port conflicts, blocked ports, and overlapping ranges.
 * Returns array of error strings (empty = no conflicts).
 */
function validatePortConflicts(routes) {
  var errors = [];

  // Check blocked ports
  for (var i = 0; i < routes.length; i++) {
    var route = routes[i];
    var range = parsePortRange(route.l4_listen_port);
    if (!range) continue;
    for (var p = range.start; p <= range.end; p++) {
      if (isPortBlocked(p)) {
        errors.push('Port ' + p + ' is reserved (route ID ' + route.id + ')');
      }
    }
  }

  // Group by protocol
  var byProtocol = {};
  for (var i = 0; i < routes.length; i++) {
    var route = routes[i];
    var proto = route.l4_protocol;
    if (!byProtocol[proto]) byProtocol[proto] = [];
    byProtocol[proto].push(route);
  }

  for (var proto in byProtocol) {
    var protoRoutes = byProtocol[proto];

    // Check duplicate no-TLS routes on same port
    var noTlsPorts = {};
    for (var i = 0; i < protoRoutes.length; i++) {
      var route = protoRoutes[i];
      if (route.l4_tls_mode !== 'none') continue;
      var key = route.l4_listen_port;
      if (noTlsPorts[key]) {
        errors.push(
          'Duplicate ' + proto + ' port ' + key + ' without TLS (routes ' + noTlsPorts[key] + ' and ' + route.id + ')'
        );
      } else {
        noTlsPorts[key] = route.id;
      }
    }

    // Check overlapping ranges within same protocol
    var ranges = [];
    for (var i = 0; i < protoRoutes.length; i++) {
      var route = protoRoutes[i];
      var parsed = parsePortRange(route.l4_listen_port);
      if (parsed) {
        ranges.push({
          id: route.id,
          start: parsed.start,
          end: parsed.end,
          tlsMode: route.l4_tls_mode,
          listenPort: route.l4_listen_port,
        });
      }
    }

    for (var i = 0; i < ranges.length; i++) {
      for (var j = i + 1; j < ranges.length; j++) {
        var a = ranges[i];
        var b = ranges[j];
        // Skip overlap check if both are TLS on same port (SNI distinguishes)
        if (a.listenPort === b.listenPort && a.tlsMode !== 'none' && b.tlsMode !== 'none') continue;
        // Check range overlap
        if (a.start <= b.end && b.start <= a.end) {
          // Only flag if not already caught by duplicate check
          if (a.listenPort !== b.listenPort) {
            errors.push(
              'Overlapping ' + proto + ' port ranges: ' + a.listenPort + ' and ' + b.listenPort + ' (routes ' + a.id + ' and ' + b.id + ')'
            );
          }
        }
      }
    }
  }

  return errors;
}

module.exports = {
  buildL4Servers: buildL4Servers,
  buildL4Route: buildL4Route,
  validatePortConflicts: validatePortConflicts,
};
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `cd /root/gatecontrol && npm test -- --test-name-pattern="L4" 2>&1`
Expected: All PASS

- [ ] **Step 3: Commit**

```
git add src/services/l4.js
git commit -m "feat: add L4 config generation service (server grouping, TLS modes, conflict detection)"
```

---

## Chunk 5: Route Service and Backup Integration

### Task 9: Integrate L4 into buildCaddyConfig()

**Files:**
- Modify: `/root/gatecontrol/src/services/routes.js:1-10` (imports) and `:36-188` (buildCaddyConfig)

- [ ] **Step 1: Add L4 import at top of file**

At the top of `src/services/routes.js`, after existing requires (around line 8), add:

```javascript
const { buildL4Servers, validatePortConflicts } = require('./l4');
```

- [ ] **Step 2: Split routes by type in buildCaddyConfig()**

Inside `buildCaddyConfig()`, after loading enabled routes from DB (around line 42 where the `routes` variable is defined via the SQL query), add:

```javascript
  const httpRoutes = routes.filter(r => r.route_type !== 'l4');
  const l4Routes = routes.filter(r => r.route_type === 'l4');
```

Then replace the loop variable in the HTTP config generation `for (const route of routes)` with `for (const route of httpRoutes)` to prevent L4 routes from being processed as HTTP routes.

- [ ] **Step 3: Add L4 config generation before return**

Before the `return config;` statement (around line 183), add:

```javascript
  // L4 config generation
  if (l4Routes.length > 0) {
    // Resolve peer IPs for L4 routes (same logic as HTTP)
    for (const route of l4Routes) {
      if (route.peer_id && route.allowed_ips) {
        route.target_ip = route.allowed_ips.split('/')[0];
      }
    }

    const conflicts = validatePortConflicts(l4Routes);
    if (conflicts.length > 0) {
      throw new Error('L4 port conflicts: ' + conflicts.join('; '));
    }

    config.apps.layer4 = {
      servers: buildL4Servers(l4Routes),
    };
  }
```

- [ ] **Step 4: Run existing tests to verify no regression**

Run: `cd /root/gatecontrol && npm test 2>&1`
Expected: All existing tests PASS

- [ ] **Step 5: Commit**

```
git add src/services/routes.js
git commit -m "feat: integrate L4 config generation into buildCaddyConfig()"
```

### Task 10: Update CRUD operations for L4 fields

**Files:**
- Modify: `/root/gatecontrol/src/services/routes.js`

- [ ] **Step 1: Update create() function**

In the `create()` function (around line 239):

1. Extract route type: `const routeType = data.route_type || 'http';`
2. Add L4 validation block (only when `routeType === 'l4'`):
   - Validate `l4_protocol`, `l4_listen_port`, `l4_tls_mode`
   - Check TLS requires domain + TCP
   - Check blocked ports
3. Wrap existing `validateDomain()` call to be conditional:
   `if (routeType === 'http' || data.domain) { ... validateDomain ... }`
4. Update INSERT statement to include `route_type, l4_protocol, l4_listen_port, l4_tls_mode`
5. Add L4 values to parameter array (null for HTTP routes)

- [ ] **Step 2: Update update() function**

Apply same pattern to `update()` (around line 323):
- Add L4 validation when route_type is l4
- Skip domain validation for domainless L4 routes
- Include L4 columns in UPDATE SET clause
- Update rollback INSERT to include L4 columns

- [ ] **Step 3: Update remove() rollback**

In `remove()` (around line 458), update the rollback INSERT to include L4 columns from the saved route data.

- [ ] **Step 4: Update getAll() with type filter**

In `getAll()` (around line 212), add optional `type` parameter:

```javascript
function getAll({ limit = 250, offset = 0, type = null } = {}) {
  let query = 'SELECT r.*, p.name as peer_name, p.enabled as peer_enabled FROM routes r LEFT JOIN peers p ON r.peer_id = p.id';
  const params = [];
  if (type) {
    query += ' WHERE r.route_type = ?';
    params.push(type);
  }
  query += ' ORDER BY r.route_type, r.domain ASC LIMIT ? OFFSET ?';
  params.push(limit, offset);
  return db.prepare(query).all(...params);
}
```

- [ ] **Step 5: Run tests**

Run: `cd /root/gatecontrol && npm test 2>&1`
Expected: All PASS

- [ ] **Step 6: Commit**

```
git add src/services/routes.js
git commit -m "feat: extend route CRUD operations with L4 field support"
```

### Task 11: Update backup service

**Files:**
- Modify: `/root/gatecontrol/src/services/backup.js`

- [ ] **Step 1: Update route export mapping**

In `createBackup()` (around lines 35-50), add L4 fields to the route mapping object:

```javascript
route_type: r.route_type || 'http',
l4_protocol: r.l4_protocol,
l4_listen_port: r.l4_listen_port,
l4_tls_mode: r.l4_tls_mode,
```

- [ ] **Step 2: Update route restore mapping**

In `restoreBackup()` (around lines 181-206), add L4 fields to the restore INSERT and value mapping:

```javascript
route_type: route.route_type || 'http',
l4_protocol: route.l4_protocol || null,
l4_listen_port: route.l4_listen_port || null,
l4_tls_mode: route.l4_tls_mode || null,
```

Update the INSERT statement and parameter array to include the 4 new columns.

- [ ] **Step 3: Update backup validation**

In `validateBackup()` (around line 113), the existing validation rejects routes without domain:
```javascript
if (!r.domain) errors.push(`Route #${i + 1}: missing domain`);
```
Update to allow null/empty domain for L4 routes:
```javascript
if (!r.domain && r.route_type !== 'l4') errors.push(`Route #${i + 1}: missing domain`);
```

- [ ] **Step 4: Increment BACKUP_VERSION**

Find the `BACKUP_VERSION` constant and increment it by 1.

- [ ] **Step 4: Commit**

```
git add src/services/backup.js
git commit -m "feat: include L4 route fields in backup/restore"
```

### Task 12: Update API route handler

**Files:**
- Modify: `/root/gatecontrol/src/routes/api/routes.js`

- [ ] **Step 1: Update GET /api/routes to accept type filter**

In the list handler (around line 44), extract `type` from query:

```javascript
const { limit = 50, offset = 0, type } = req.query;
const routes = routeService.getAll({ limit: Number(limit), offset: Number(offset), type: type || null });
```

- [ ] **Step 2: Update POST/PUT handlers to extract L4 fields from request body**

In the POST handler (around line 95), update the destructured `req.body` to include L4 fields:

```javascript
const { domain, target_ip, target_port, description, peer_id,
  https_enabled, backend_https, basic_auth_enabled, basic_auth_user, basic_auth_password,
  route_type, l4_protocol, l4_listen_port, l4_tls_mode } = req.body;
```

Pass them through to `routes.create()`. Apply the same pattern to the PUT handler (around line 114).

- [ ] **Step 3: Update error mapping**

Add L4-specific error patterns to `VALIDATION_ERROR_MAP` (around line 18):

```javascript
'L4 protocol must be': 'error.routes.l4_invalid_protocol',
'Invalid port or port range': 'error.routes.l4_invalid_port',
'TLS mode must be': 'error.routes.l4_invalid_tls_mode',
'TLS mode requires a domain': 'error.routes.l4_tls_requires_domain',
'TLS requires TCP': 'error.routes.l4_tls_requires_tcp',
'is reserved': 'error.routes.l4_port_blocked',
'port conflicts': 'error.routes.l4_port_conflict',
'Port range exceeds': 'error.routes.l4_port_range_too_large',
```

- [ ] **Step 4: Commit**

```
git add src/routes/api/routes.js
git commit -m "feat: extend route API with L4 fields and type filter"
```

---

## Chunk 6: i18n

### Task 13: Add i18n translation keys

**Files:**
- Modify: `/root/gatecontrol/src/i18n/en.json`
- Modify: `/root/gatecontrol/src/i18n/de.json`

- [ ] **Step 1: Add English keys**

Add after the existing `routes.*` keys (around line 107):

```json
"routes.type_http": "HTTP",
"routes.type_l4": "Layer 4",
"routes.l4_protocol": "Protocol",
"routes.l4_protocol_tcp": "TCP",
"routes.l4_protocol_udp": "UDP",
"routes.l4_listen_port": "Listen Port",
"routes.l4_listen_port_placeholder": "e.g. 3389 or 5000-5010",
"routes.l4_tls_mode": "TLS Mode",
"routes.tls_none": "None",
"routes.tls_passthrough": "Passthrough",
"routes.tls_terminate": "Terminate",
"routes.tls_sni_hint": "Optional — only for TLS-SNI routing",
"routes.tls_terminate_hint": "Caddy will automatically generate a Let's Encrypt certificate",
"routes.tls_none_hint": "Port-based routing only, no SNI",
"routes.tag_tcp": "TCP",
"routes.tag_udp": "UDP",
"routes.tag_tls_sni": "TLS-SNI",
"routes.tag_l4": "L4",
"error.routes.l4_invalid_protocol": "Protocol must be TCP or UDP",
"error.routes.l4_invalid_port": "Invalid port or port range",
"error.routes.l4_invalid_tls_mode": "Invalid TLS mode",
"error.routes.l4_tls_requires_domain": "TLS mode requires a domain for SNI routing",
"error.routes.l4_tls_requires_tcp": "TLS requires TCP protocol",
"error.routes.l4_port_blocked": "This port is reserved by the system",
"error.routes.l4_port_conflict": "Port conflict detected with another L4 route",
"error.routes.l4_port_range_too_large": "Port range exceeds maximum allowed size"
```

- [ ] **Step 2: Add German keys**

Add the same keys with German translations:

```json
"routes.type_http": "HTTP",
"routes.type_l4": "Layer 4",
"routes.l4_protocol": "Protokoll",
"routes.l4_protocol_tcp": "TCP",
"routes.l4_protocol_udp": "UDP",
"routes.l4_listen_port": "Listen-Port",
"routes.l4_listen_port_placeholder": "z.B. 3389 oder 5000-5010",
"routes.l4_tls_mode": "TLS-Modus",
"routes.tls_none": "Keiner",
"routes.tls_passthrough": "Durchleitung",
"routes.tls_terminate": "Terminieren",
"routes.tls_sni_hint": "Optional — nur f\u00fcr TLS-SNI-Routing",
"routes.tls_terminate_hint": "Caddy generiert automatisch ein Let's Encrypt Zertifikat",
"routes.tls_none_hint": "Reines Port-basiertes Routing, kein SNI",
"routes.tag_tcp": "TCP",
"routes.tag_udp": "UDP",
"routes.tag_tls_sni": "TLS-SNI",
"routes.tag_l4": "L4",
"error.routes.l4_invalid_protocol": "Protokoll muss TCP oder UDP sein",
"error.routes.l4_invalid_port": "Ung\u00fcltiger Port oder Port-Bereich",
"error.routes.l4_invalid_tls_mode": "Ung\u00fcltiger TLS-Modus",
"error.routes.l4_tls_requires_domain": "TLS-Modus erfordert eine Domain f\u00fcr SNI-Routing",
"error.routes.l4_tls_requires_tcp": "TLS erfordert TCP-Protokoll",
"error.routes.l4_port_blocked": "Dieser Port ist vom System reserviert",
"error.routes.l4_port_conflict": "Port-Konflikt mit einer anderen L4-Route erkannt",
"error.routes.l4_port_range_too_large": "Port-Bereich \u00fcberschreitet die maximal erlaubte Gr\u00f6\u00dfe"
```

- [ ] **Step 3: Commit**

```
git add src/i18n/en.json src/i18n/de.json
git commit -m "feat: add L4 routing i18n keys (EN + DE)"
```

---

## Chunk 7: Frontend — Templates and JavaScript

### Task 14: Update route create form template

**Files:**
- Modify: `/root/gatecontrol/templates/default/pages/routes.njk`

- [ ] **Step 1: Add route type toggle**

After the form opening tag (around line 40), before the domain field, add a route type toggle group with two buttons (HTTP / Layer 4) and a hidden input `route-type` with default value `http`.

- [ ] **Step 2: Add L4-specific fields**

After the existing `backend_https` toggle (around line 78), add an `l4-fields` container (hidden by default) containing:
- Protocol toggle group (TCP / UDP) with hidden input `l4-protocol`
- Listen Port text input `l4-listen-port` with placeholder from i18n
- TLS Mode select dropdown `l4-tls-mode` with options none/passthrough/terminate
- Hint text element `l4-tls-hint` with data attributes for hint texts

- [ ] **Step 3: Wrap HTTP-only fields**

Wrap the existing Force HTTPS, Backend HTTPS, and Basic Auth sections in an `http-fields` container.

- [ ] **Step 4: Commit**

```
git add templates/default/pages/routes.njk
git commit -m "feat: add L4 fields to route create form template"
```

### Task 15: Update route edit modal template

**Files:**
- Modify: `/root/gatecontrol/templates/default/partials/modals/route-edit.njk`

- [ ] **Step 1: Add L4 fields to edit modal**

Mirror the same L4 fields from the create form with `edit-` prefixed IDs:
- Route type toggle: `edit-route-type-group` / `edit-route-type`
- L4 fields container: `edit-l4-fields`
- Protocol toggle: `edit-l4-protocol-group` / `edit-l4-protocol`
- Listen port: `edit-l4-listen-port`
- TLS mode: `edit-l4-tls-mode`
- TLS hint: `edit-l4-tls-hint`
- HTTP fields wrapper: `edit-http-fields`

- [ ] **Step 2: Commit**

```
git add templates/default/partials/modals/route-edit.njk
git commit -m "feat: add L4 fields to route edit modal template"
```

### Task 16: Update frontend JavaScript

**Files:**
- Modify: `/root/gatecontrol/public/js/routes.js`

- [ ] **Step 1: Add toggle group helper functions**

Add at the bottom of the file (before the init block at line 401):

- `setupToggleGroup(groupId, hiddenId)` — click handler for toggle button groups, calls `updateFieldVisibility()`
- `setToggleGroup(groupId, hiddenId, value)` — programmatically set a toggle group value
- `updateFieldVisibility()` — show/hide l4-fields vs http-fields based on route-type value, update domain required state
- `updateEditFieldVisibility()` — same for edit modal with edit- prefixed IDs
- `updateTlsHint(selectId, hintId)` — update TLS hint text based on select value

- [ ] **Step 2: Update form submit to include L4 fields**

In the create form submit handler (around line 149), read `route-type` value and conditionally add `l4_protocol`, `l4_listen_port`, `l4_tls_mode` to the request body.

- [ ] **Step 3: Update edit modal populate and submit**

In `showEditModal()` (around line 217), set toggle groups and L4 fields from route data. In the edit submit handler, include L4 fields in PUT body.

- [ ] **Step 4: Update renderRoutes() for L4 tags**

In `renderRoutes()` (around line 63), add L4-specific tags (TCP/UDP, TLS-SNI/L4) and update target display to show listen port for L4 routes.

- [ ] **Step 5: Add listen port auto-fill**

When target port changes, auto-fill listen port if user has not manually modified it.

- [ ] **Step 6: Initialize toggle groups**

In the init block (around line 401), call `setupToggleGroup` for all 4 toggle groups and add change listeners on TLS mode selects.

- [ ] **Step 7: Commit**

```
git add public/js/routes.js
git commit -m "feat: add L4 route type toggle, dynamic fields, and tag rendering"
```

---

## Chunk 8: Final Integration and Testing

### Task 17: Run all tests and verify

- [ ] **Step 1: Run all unit tests**

Run: `cd /root/gatecontrol && npm test 2>&1`
Expected: All PASS

- [ ] **Step 2: Build Docker image**

Run: `cd /root/gatecontrol && docker build -t gatecontrol:l4-test .`
Expected: Successful build with all 3 stages

- [ ] **Step 3: Verify Caddy has L4 module**

Run: `docker run --rm gatecontrol:l4-test caddy list-modules 2>&1 | grep layer4`
Expected: Output includes `layer4` module

- [ ] **Step 4: Commit any fixes**

If any fixes were needed during integration testing, commit them.

### Task 18: Build deploy image and push feature branch

- [ ] **Step 1: Build production image**

Run: `cd /root/gatecontrol && docker build -t gatecontrol:latest .`

- [ ] **Step 2: Save deploy image**

Run: `docker save gatecontrol:latest | gzip > /root/gatecontrol-deploy/gatecontrol-image.tar.gz`

- [ ] **Step 3: Final commit on feature branch**

```
git add -A
git commit -m "feat: Layer 4 routing complete — TCP/UDP proxy with TLS-SNI support"
```

- [ ] **Step 4: Push feature branch**

```
git push -u origin feature/layer4-routing
```

After testing is confirmed: merge to master with `git checkout master && git merge feature/layer4-routing && git push`.
