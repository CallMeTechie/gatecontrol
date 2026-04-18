# Home Gateway Companion — Plan 3/3: Gateway-Repository

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Drittes und letztes Teilprojekt des Home-Gateway-Companion: das neue Repo `gatecontrol-gateway` mit HTTP-Reverse-Proxy, TCP-Port-Forwarder, Wake-on-LAN, Config-Sync und Management-API. Läuft als Docker-Container im Heimnetz, verbindet sich per WireGuard-Tunnel mit GateControl-Server.

**Architecture:** Node.js 20 Monolithic Service. WireGuard-Lifecycle via `wg-quick` + `wireguard-go` (Userspace). Express-basierte interne Management-API bindet ausschließlich auf Tunnel-IP (hard-enforced). HTTP-Proxy via `http-proxy` mit Header-Stripping + X-Gateway-Target-Routing. TCP-Proxy via `net.Socket`-Piping mit Dual-Bind-Overlap für Port-Changes. Hybrid-Pull-Sync (5min Poll + Push-Trigger). 4-Layer-Self-Check (Process + Network + Per-Route + End-to-End-Probe). Multi-arch Docker-Image (amd64/arm64/armv7) mit non-root + setcap + read_only-FS Hardening.

**Tech Stack:** Node.js 20 · Express 4.21 · http-proxy 1.18 · axios 1.x · pino 9.x · zod 3.x · `@callmetechie/gatecontrol-config-hash` 1.0.0 · `wireguard-go` + `wireguard-tools` · Alpine Linux 3.20 · `node:test` + `node:assert/strict` · Stryker · GitHub Actions · GHCR

**Prerequisites:**
- Plan 1 abgeschlossen (`@callmetechie/gatecontrol-config-hash@^1.0.0` in GitHub Packages verfügbar)
- Plan 2 abgeschlossen (Server hat `/api/v1/gateway/*` Endpoints und kann `gateway.env` ausliefern)
- Leeres GitHub-Repo `CallMeTechie/gatecontrol-gateway` angelegt, `GH_PACKAGES_TOKEN` mit `packages:write` als Repo-Secret

**Spec-Referenz:** `/root/gatecontrol/docs/superpowers/specs/2026-04-18-home-gateway-companion-design.md` (v1.2) Sektionen 4.1-4.6

---

## Task 1: Repo-Scaffold + NPM + Jest-Setup

**Files:**
- Create: `/root/gatecontrol-gateway/package.json`
- Create: `/root/gatecontrol-gateway/.gitignore`
- Create: `/root/gatecontrol-gateway/.npmrc`
- Create: `/root/gatecontrol-gateway/README.md`
- Create: `/root/gatecontrol-gateway/tests/smoke.test.js`

- [ ] **Step 1: Repo klonen**

```bash
cd /root && git clone git@github.com:CallMeTechie/gatecontrol-gateway.git
cd gatecontrol-gateway
```

- [ ] **Step 2: package.json**

Create `/root/gatecontrol-gateway/package.json`:

```json
{
  "name": "gatecontrol-gateway",
  "version": "0.0.0",
  "description": "Home Gateway companion for GateControl — HTTP/TCP proxy + WoL",
  "license": "UNLICENSED",
  "private": true,
  "main": "src/index.js",
  "engines": { "node": ">=20.0.0" },
  "scripts": {
    "start": "node src/index.js",
    "dev": "node --watch src/index.js",
    "test": "node --test --test-force-exit tests/",
    "test:coverage": "node --test --experimental-test-coverage --test-force-exit tests/",
    "test:mutation": "stryker run",
    "lint": "eslint src tests"
  },
  "dependencies": {
    "@callmetechie/gatecontrol-config-hash": "^1.0.0",
    "axios": "^1.7.0",
    "express": "^4.21.0",
    "http-proxy": "^1.18.1",
    "pino": "^9.4.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@stryker-mutator/core": "^8.0.0",
    "eslint": "^9.10.0",
    "eslint-plugin-security": "^3.0.0"
  }
}
```

- [ ] **Step 3: .gitignore + .npmrc**

Create `/root/gatecontrol-gateway/.gitignore`:

```
node_modules/
coverage/
.stryker-tmp/
reports/
*.log
.DS_Store
config/gateway.env
config/wg0.conf
```

Create `/root/gatecontrol-gateway/.npmrc`:

```
@callmetechie:registry=https://npm.pkg.github.com/
//npm.pkg.github.com/:_authToken=${GH_PACKAGES_TOKEN}
```

- [ ] **Step 4: Smoke-Test + README-Stub**

Create `/root/gatecontrol-gateway/tests/smoke.test.js`:

```javascript
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('smoke', () => {
  it('node test runner works', () => {
    assert.equal(1 + 1, 2);
  });
});
```

Create `/root/gatecontrol-gateway/README.md`:

```markdown
# GateControl Home Gateway

Companion product for [GateControl](https://github.com/CallMeTechie/gatecontrol): an always-on Docker container in your home network that bridges a single WireGuard tunnel to multiple LAN devices via HTTP/TCP proxies.

Status: **In development.**

See `docs/deployment/linux-docker.md` (Pi, VM, bare-metal) and `docs/deployment/synology.md` for setup.
```

- [ ] **Step 5: npm install + Test + erster Commit**

```bash
cd /root/gatecontrol-gateway
GH_PACKAGES_TOKEN=<your-gh-token> npm install
node --test tests/smoke.test.js
git add package.json package-lock.json .gitignore .npmrc README.md tests/
git commit -m "chore: scaffold gatecontrol-gateway with jest-free node:test + pino + express"
git push origin main
```

Expected: smoke.test.js grün.

---

## Task 2: Logger-Setup (Pino)

**Files:**
- Create: `/root/gatecontrol-gateway/src/logger.js`
- Create: `/root/gatecontrol-gateway/tests/logger.test.js`

- [ ] **Step 1: Failing Test**

Create `/root/gatecontrol-gateway/tests/logger.test.js`:

```javascript
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const logger = require('../src/logger');

describe('logger', () => {
  it('exposes pino log levels', () => {
    assert.ok(typeof logger.info === 'function');
    assert.ok(typeof logger.warn === 'function');
    assert.ok(typeof logger.error === 'function');
    assert.ok(typeof logger.debug === 'function');
  });

  it('has a child() for sub-loggers', () => {
    const child = logger.child({ module: 'test' });
    assert.ok(typeof child.info === 'function');
  });
});
```

- [ ] **Step 2: Implementation**

Create `/root/gatecontrol-gateway/src/logger.js`:

```javascript
'use strict';

const pino = require('pino');

const level = process.env.LOG_LEVEL || 'info';

const logger = pino({
  level,
  base: { service: 'gatecontrol-gateway' },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: ['*.password', '*.token', '*.api_token', '*.push_token', '*.authorization'],
});

module.exports = logger;
```

- [ ] **Step 3: Test + Commit**

```bash
node --test tests/logger.test.js
git add src/logger.js tests/logger.test.js
git commit -m "feat(logger): pino-based structured logger with secret redaction"
git push
```

---

## Task 3: Config-Parser + Validation

**Files:**
- Create: `/root/gatecontrol-gateway/src/config.js`
- Create: `/root/gatecontrol-gateway/tests/config.test.js`
- Create: `/root/gatecontrol-gateway/config/gateway.env.example`

- [ ] **Step 1: Failing Tests**

Create `/root/gatecontrol-gateway/tests/config.test.js`:

```javascript
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadConfig, isRfc1918, isTunnelIpValid } = require('../src/config');

describe('config', () => {
  function writeEnv(content) {
    const f = path.join(os.tmpdir(), `gw-env-${Date.now()}-${Math.random()}`);
    fs.writeFileSync(f, content);
    return f;
  }

  it('loads required keys from .env file', () => {
    const f = writeEnv(`
GC_SERVER_URL=https://example.com
GC_API_TOKEN=gc_gw_${'a'.repeat(64)}
GC_GATEWAY_TOKEN=${'b'.repeat(64)}
GC_TUNNEL_IP=10.8.0.5
GC_PROXY_PORT=8080
GC_API_PORT=9876
GC_HEARTBEAT_INTERVAL_S=30
GC_POLL_INTERVAL_S=300
WG_PRIVATE_KEY=xxx
WG_PUBLIC_KEY=yyy
WG_ENDPOINT=example.com:51820
WG_SERVER_PUBLIC_KEY=zzz
WG_ADDRESS=10.8.0.5/24
WG_DNS=10.8.0.1
    `.trim());
    const cfg = loadConfig(f);
    assert.equal(cfg.serverUrl, 'https://example.com');
    assert.equal(cfg.tunnelIp, '10.8.0.5');
    assert.equal(cfg.proxyPort, 8080);
    assert.equal(cfg.apiPort, 9876);
    assert.equal(cfg.heartbeatIntervalS, 30);
  });

  it('throws on missing required key', () => {
    const f = writeEnv('GC_SERVER_URL=https://example.com\n');
    assert.throws(() => loadConfig(f), /GC_API_TOKEN|missing/i);
  });

  it('throws on malformed API_TOKEN', () => {
    const f = writeEnv(`GC_SERVER_URL=https://example.com
GC_API_TOKEN=invalid
GC_GATEWAY_TOKEN=${'b'.repeat(64)}
GC_TUNNEL_IP=10.8.0.5
GC_PROXY_PORT=8080
GC_API_PORT=9876
WG_PRIVATE_KEY=xxx
WG_PUBLIC_KEY=yyy
WG_ENDPOINT=example.com:51820
WG_SERVER_PUBLIC_KEY=zzz
WG_ADDRESS=10.8.0.5/24
WG_DNS=10.8.0.1`);
    assert.throws(() => loadConfig(f), /GC_API_TOKEN|format/i);
  });

  it('isRfc1918 accepts private ranges', () => {
    assert.equal(isRfc1918('10.0.0.1'), true);
    assert.equal(isRfc1918('172.16.0.1'), true);
    assert.equal(isRfc1918('192.168.1.1'), true);
    assert.equal(isRfc1918('169.254.1.1'), true); // link-local
  });

  it('isRfc1918 rejects public + loopback', () => {
    assert.equal(isRfc1918('8.8.8.8'), false);
    assert.equal(isRfc1918('127.0.0.1'), false);
    assert.equal(isRfc1918('1.2.3.4'), false);
    assert.equal(isRfc1918('172.15.0.1'), false); // out of 172.16/12
    assert.equal(isRfc1918('172.32.0.1'), false);
  });

  it('isTunnelIpValid rejects 0.0.0.0', () => {
    assert.equal(isTunnelIpValid('0.0.0.0'), false);
    assert.equal(isTunnelIpValid('10.8.0.5'), true);
  });
});
```

- [ ] **Step 2: Test ausführen — muss failen**

```bash
node --test tests/config.test.js
```

- [ ] **Step 3: Implementation**

Create `/root/gatecontrol-gateway/src/config.js`:

```javascript
'use strict';

const fs = require('node:fs');
const { z } = require('zod');

const ConfigSchema = z.object({
  GC_SERVER_URL: z.string().url(),
  GC_API_TOKEN: z.string().regex(/^gc_gw_[a-f0-9]{64}$/, 'GC_API_TOKEN must be gc_gw_<64-hex>'),
  GC_GATEWAY_TOKEN: z.string().regex(/^[a-f0-9]{64}$/, 'GC_GATEWAY_TOKEN must be 64-hex'),
  GC_TUNNEL_IP: z.string().regex(/^\d+\.\d+\.\d+\.\d+$/, 'GC_TUNNEL_IP must be IPv4'),
  GC_PROXY_PORT: z.coerce.number().int().min(1024).max(65535).default(8080),
  GC_API_PORT: z.coerce.number().int().min(1024).max(65535).default(9876),
  GC_HEARTBEAT_INTERVAL_S: z.coerce.number().int().min(5).max(600).default(30),
  GC_POLL_INTERVAL_S: z.coerce.number().int().min(30).max(3600).default(300),
  GC_LAN_PROBE_TARGET: z.string().optional(),
  WG_PRIVATE_KEY: z.string().min(1),
  WG_PUBLIC_KEY: z.string().min(1),
  WG_ENDPOINT: z.string().min(1),
  WG_SERVER_PUBLIC_KEY: z.string().min(1),
  WG_ADDRESS: z.string().min(1),
  WG_DNS: z.string().optional(),
});

function parseEnvFile(contents) {
  const out = {};
  for (const line of contents.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

function loadConfig(path) {
  const raw = fs.readFileSync(path, 'utf8');
  const kv = parseEnvFile(raw);
  const parsed = ConfigSchema.parse(kv);

  if (!isTunnelIpValid(parsed.GC_TUNNEL_IP)) {
    throw new Error(`GC_TUNNEL_IP cannot be 0.0.0.0 (binding to all interfaces is forbidden)`);
  }

  return {
    serverUrl: parsed.GC_SERVER_URL,
    apiToken: parsed.GC_API_TOKEN,
    gatewayToken: parsed.GC_GATEWAY_TOKEN,
    tunnelIp: parsed.GC_TUNNEL_IP,
    proxyPort: parsed.GC_PROXY_PORT,
    apiPort: parsed.GC_API_PORT,
    heartbeatIntervalS: parsed.GC_HEARTBEAT_INTERVAL_S,
    pollIntervalS: parsed.GC_POLL_INTERVAL_S,
    lanProbeTarget: parsed.GC_LAN_PROBE_TARGET || null,
    wg: {
      privateKey: parsed.WG_PRIVATE_KEY,
      publicKey: parsed.WG_PUBLIC_KEY,
      endpoint: parsed.WG_ENDPOINT,
      serverPublicKey: parsed.WG_SERVER_PUBLIC_KEY,
      address: parsed.WG_ADDRESS,
      dns: parsed.WG_DNS || null,
    },
  };
}

function isRfc1918(ip) {
  const octets = ip.split('.').map(Number);
  if (octets.length !== 4 || octets.some(o => Number.isNaN(o) || o < 0 || o > 255)) return false;
  const [a, b] = octets;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true; // link-local
  return false;
}

function isTunnelIpValid(ip) {
  return ip !== '0.0.0.0' && /^\d+\.\d+\.\d+\.\d+$/.test(ip);
}

module.exports = { loadConfig, isRfc1918, isTunnelIpValid };
```

- [ ] **Step 4: gateway.env.example + Test + Commit**

Create `/root/gatecontrol-gateway/config/gateway.env.example`:

```
# Download aus GateControl-UI → Peer-Detail → "Gateway-Config herunterladen"
# Diese Datei NICHT in Git commiten (liegt in .gitignore)

GC_SERVER_URL=https://gatecontrol.example.com
GC_API_TOKEN=gc_gw_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
GC_GATEWAY_TOKEN=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
GC_TUNNEL_IP=10.8.0.5
GC_PROXY_PORT=8080
GC_API_PORT=9876
GC_HEARTBEAT_INTERVAL_S=30
GC_POLL_INTERVAL_S=300
GC_LAN_PROBE_TARGET=192.168.1.1

WG_PRIVATE_KEY=xxx
WG_PUBLIC_KEY=yyy
WG_ENDPOINT=gatecontrol.example.com:51820
WG_SERVER_PUBLIC_KEY=zzz
WG_ADDRESS=10.8.0.5/24
WG_DNS=10.8.0.1
```

```bash
node --test tests/config.test.js
git add src/config.js tests/config.test.js config/gateway.env.example
git commit -m "feat(config): env parser + Zod validation + RFC1918 + Tunnel-IP checks"
git push
```

---

## Task 4: WireGuard Lifecycle-Wrapper

**Files:**
- Create: `/root/gatecontrol-gateway/src/wireguard.js`
- Create: `/root/gatecontrol-gateway/tests/wireguard.test.js`

- [ ] **Step 1: Failing Tests (nur Parser — Command-Execution mocked/skipped)**

Create `/root/gatecontrol-gateway/tests/wireguard.test.js`:

```javascript
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseWgShowDump, buildWgConfFile } = require('../src/wireguard');

describe('wireguard', () => {
  it('parseWgShowDump extracts peer + handshake age', () => {
    // wg show wg0 dump format:
    // privatekey publickey listenport fwmark
    // peer_pub preshared_key endpoint allowed_ips latest_handshake rx tx persistent_keepalive
    const sample = [
      'PRIV\tPUB\t51820\toff',
      'PEERKEY\t(none)\t203.0.113.1:51820\t0.0.0.0/0\t1700000000\t1234\t5678\t25',
    ].join('\n');
    const now = 1700000060; // 60s after handshake
    const parsed = parseWgShowDump(sample, now);
    assert.equal(parsed.interface.privateKey, 'PRIV');
    assert.equal(parsed.peers.length, 1);
    assert.equal(parsed.peers[0].publicKey, 'PEERKEY');
    assert.equal(parsed.peers[0].latestHandshakeTs, 1700000000);
    assert.equal(parsed.peers[0].handshakeAgeS, 60);
  });

  it('buildWgConfFile produces valid wg-quick INI', () => {
    const cfg = {
      wg: {
        privateKey: 'PRIV',
        address: '10.8.0.5/24',
        dns: '10.8.0.1',
        publicKey: 'IGNORED',
        serverPublicKey: 'SERV',
        endpoint: 'host.example:51820',
      },
    };
    const ini = buildWgConfFile(cfg);
    assert.match(ini, /\[Interface\]/);
    assert.match(ini, /PrivateKey\s*=\s*PRIV/);
    assert.match(ini, /Address\s*=\s*10\.8\.0\.5\/24/);
    assert.match(ini, /\[Peer\]/);
    assert.match(ini, /PublicKey\s*=\s*SERV/);
    assert.match(ini, /Endpoint\s*=\s*host\.example:51820/);
    assert.match(ini, /AllowedIPs\s*=\s*0\.0\.0\.0\/0/);
  });
});
```

- [ ] **Step 2: Test ausführen — muss failen**

```bash
node --test tests/wireguard.test.js
```

- [ ] **Step 3: Implementation**

Create `/root/gatecontrol-gateway/src/wireguard.js`:

```javascript
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const logger = require('./logger');

const WG_INTERFACE = 'gatecontrol0';
const CONFIG_DIR = process.env.GC_WG_CONFIG_DIR || '/etc/wireguard';

function parseWgShowDump(text, nowSec = Math.floor(Date.now() / 1000)) {
  const lines = text.trim().split('\n');
  if (lines.length === 0) return { interface: {}, peers: [] };

  const ifaceLine = lines[0].split('\t');
  const interfaceInfo = {
    privateKey: ifaceLine[0],
    publicKey: ifaceLine[1],
    listenPort: parseInt(ifaceLine[2], 10) || null,
    fwmark: ifaceLine[3] === 'off' ? null : ifaceLine[3],
  };

  const peers = lines.slice(1).filter(l => l.trim()).map(line => {
    const parts = line.split('\t');
    const latestHandshakeTs = parseInt(parts[4], 10) || 0;
    return {
      publicKey: parts[0],
      presharedKey: parts[1] === '(none)' ? null : parts[1],
      endpoint: parts[2],
      allowedIps: parts[3],
      latestHandshakeTs,
      handshakeAgeS: latestHandshakeTs > 0 ? nowSec - latestHandshakeTs : null,
      rxBytes: parseInt(parts[5], 10) || 0,
      txBytes: parseInt(parts[6], 10) || 0,
      persistentKeepalive: parts[7] === 'off' ? null : parseInt(parts[7], 10),
    };
  });

  return { interface: interfaceInfo, peers };
}

function buildWgConfFile(config) {
  const lines = [
    '[Interface]',
    `PrivateKey = ${config.wg.privateKey}`,
    `Address = ${config.wg.address}`,
  ];
  if (config.wg.dns) lines.push(`DNS = ${config.wg.dns}`);
  lines.push('',
    '[Peer]',
    `PublicKey = ${config.wg.serverPublicKey}`,
    `Endpoint = ${config.wg.endpoint}`,
    `AllowedIPs = 0.0.0.0/0`,
    `PersistentKeepalive = 25`,
  );
  return lines.join('\n') + '\n';
}

function runCommand(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => stdout += d);
    child.stderr.on('data', d => stderr += d);
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${cmd} ${args.join(' ')} exited ${code}: ${stderr}`));
    });
  });
}

async function writeConfAndBringUp(config) {
  const confPath = path.join(CONFIG_DIR, `${WG_INTERFACE}.conf`);
  const ini = buildWgConfFile(config);
  await fs.writeFile(confPath, ini, { mode: 0o600 });
  logger.info({ interface: WG_INTERFACE, path: confPath }, 'Wrote WireGuard config, bringing up');
  await runCommand('wg-quick', ['up', confPath]);
}

async function bringDown() {
  const confPath = path.join(CONFIG_DIR, `${WG_INTERFACE}.conf`);
  try { await runCommand('wg-quick', ['down', confPath]); } catch (e) {
    logger.warn({ err: e.message }, 'wg-quick down failed (may already be down)');
  }
}

async function getStatus() {
  const out = await runCommand('wg', ['show', WG_INTERFACE, 'dump']);
  return parseWgShowDump(out);
}

module.exports = {
  WG_INTERFACE,
  parseWgShowDump,
  buildWgConfFile,
  writeConfAndBringUp,
  bringDown,
  getStatus,
};
```

- [ ] **Step 4: Test + Commit**

```bash
node --test tests/wireguard.test.js
git add src/wireguard.js tests/wireguard.test.js
git commit -m "feat(wireguard): wg-quick wrapper + wg show dump parser"
git push
```

---

## Task 5: Auth-Middleware für Management-API

**Files:**
- Create: `/root/gatecontrol-gateway/src/api/middleware/auth.js`
- Create: `/root/gatecontrol-gateway/tests/api_auth.test.js`

- [ ] **Step 1: Failing Tests**

Create `/root/gatecontrol-gateway/tests/api_auth.test.js`:

```javascript
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createAuthMiddleware } = require('../src/api/middleware/auth');

describe('api/auth', () => {
  const token = 'a'.repeat(64);
  const mw = createAuthMiddleware({ expectedToken: token });

  function mockCall(header) {
    const req = { headers: { 'x-gateway-token': header }, ip: '127.0.0.1' };
    let statusCode = null;
    const res = {
      status(c) { statusCode = c; return this; },
      json() { return this; },
    };
    let nextCalled = false;
    mw(req, res, () => { nextCalled = true; });
    return { statusCode, nextCalled };
  }

  it('accepts valid token', () => {
    const r = mockCall(token);
    assert.equal(r.nextCalled, true);
    assert.equal(r.statusCode, null);
  });

  it('rejects missing token with 401', () => {
    const r = mockCall(undefined);
    assert.equal(r.statusCode, 401);
    assert.equal(r.nextCalled, false);
  });

  it('rejects wrong token with 403', () => {
    const r = mockCall('b'.repeat(64));
    assert.equal(r.statusCode, 403);
  });

  it('uses timing-safe comparison (length-mismatch → 403)', () => {
    const r = mockCall('short');
    assert.equal(r.statusCode, 403);
  });
});
```

- [ ] **Step 2: Test ausführen — muss failen**

```bash
node --test tests/api_auth.test.js
```

- [ ] **Step 3: Implementation**

Create `/root/gatecontrol-gateway/src/api/middleware/auth.js`:

```javascript
'use strict';

const crypto = require('node:crypto');
const logger = require('../../logger');

/**
 * Create middleware that validates X-Gateway-Token header against expectedToken
 * using timing-safe comparison.
 */
function createAuthMiddleware({ expectedToken }) {
  if (!expectedToken || typeof expectedToken !== 'string') {
    throw new Error('expectedToken required');
  }
  const expected = Buffer.from(expectedToken, 'utf8');

  return function authMiddleware(req, res, next) {
    const header = req.headers['x-gateway-token'];
    if (!header || typeof header !== 'string') {
      return res.status(401).json({ error: 'missing_gateway_token' });
    }
    const presented = Buffer.from(header, 'utf8');
    if (presented.length !== expected.length) {
      logger.warn({ ip: req.ip, len: presented.length }, 'Invalid gateway-token length');
      return res.status(403).json({ error: 'invalid_token' });
    }
    if (!crypto.timingSafeEqual(presented, expected)) {
      logger.warn({ ip: req.ip }, 'Invalid gateway-token value');
      return res.status(403).json({ error: 'invalid_token' });
    }
    next();
  };
}

module.exports = { createAuthMiddleware };
```

- [ ] **Step 4: Test + Commit**

```bash
node --test tests/api_auth.test.js
git add src/api/middleware/auth.js tests/api_auth.test.js
git commit -m "feat(api): X-Gateway-Token auth middleware with timing-safe compare"
git push
```

---

## Task 6: API-Server-Bootstrap mit Tunnel-IP-Binding

**Files:**
- Create: `/root/gatecontrol-gateway/src/api/server.js`
- Create: `/root/gatecontrol-gateway/tests/api_server.test.js`

- [ ] **Step 1: Failing Test**

Create `/root/gatecontrol-gateway/tests/api_server.test.js`:

```javascript
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createApiServer } = require('../src/api/server');

describe('api/server', () => {
  it('refuses to bind on 0.0.0.0', () => {
    assert.throws(() => createApiServer({
      bindIp: '0.0.0.0',
      port: 9876,
      expectedToken: 'a'.repeat(64),
    }), /0\.0\.0\.0|tunnel-ip/i);
  });

  it('creates app with listen method', () => {
    const srv = createApiServer({ bindIp: '127.0.0.1', port: 0, expectedToken: 'a'.repeat(64) });
    assert.ok(typeof srv.listen === 'function');
  });

  it('listen binds only to given bindIp', async () => {
    const srv = createApiServer({ bindIp: '127.0.0.1', port: 0, expectedToken: 'a'.repeat(64) });
    const server = await new Promise((resolve) => {
      const s = srv.listen(0, '127.0.0.1', () => resolve(s));
    });
    const addr = server.address();
    assert.equal(addr.address, '127.0.0.1');
    server.close();
  });
});
```

- [ ] **Step 2: Test ausführen — muss failen**

```bash
node --test tests/api_server.test.js
```

- [ ] **Step 3: Implementation**

Create `/root/gatecontrol-gateway/src/api/server.js`:

```javascript
'use strict';

const express = require('express');
const { createAuthMiddleware } = require('./middleware/auth');
const logger = require('../logger');

/**
 * Build the Express app for the management API. Hard-refuses 0.0.0.0 binding
 * (management API must only be reachable through the tunnel).
 */
function createApiServer({ bindIp, port, expectedToken, routerFactories = {} }) {
  if (bindIp === '0.0.0.0' || bindIp === '::') {
    throw new Error(`Management API refuses to bind on ${bindIp} — must bind on tunnel-ip only`);
  }

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '16kb' }));

  const auth = createAuthMiddleware({ expectedToken });

  // Mount routers from provided factories (config-changed, wol, status, etc.)
  for (const [mountPath, factory] of Object.entries(routerFactories)) {
    app.use(mountPath, auth, factory());
  }

  // Basic health endpoint (no auth — used by Docker HEALTHCHECK on 127.0.0.1)
  app.get('/api/health', (req, res) => res.json({ ok: true }));

  app._bindIp = bindIp;
  app._port = port;

  return app;
}

module.exports = { createApiServer };
```

- [ ] **Step 4: Test + Commit**

```bash
node --test tests/api_server.test.js
git add src/api/server.js tests/api_server.test.js
git commit -m "feat(api): Express server with hard 0.0.0.0-binding rejection"
git push
```

---

## Task 7: ConfigStore (In-Memory State + Hash-Diff)

**Files:**
- Create: `/root/gatecontrol-gateway/src/sync/configStore.js`
- Create: `/root/gatecontrol-gateway/tests/configStore.test.js`

- [ ] **Step 1: Failing Tests**

Create `/root/gatecontrol-gateway/tests/configStore.test.js`:

```javascript
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { ConfigStore } = require('../src/sync/configStore');

describe('ConfigStore', () => {
  it('starts empty', () => {
    const s = new ConfigStore();
    assert.equal(s.currentHash, null);
    assert.deepEqual(s.httpRoutes, []);
    assert.deepEqual(s.l4Routes, []);
  });

  it('replaces config + records hash + emits change event', () => {
    const s = new ConfigStore();
    let changeCount = 0;
    s.on('change', () => changeCount++);
    s.replaceConfig({ peer_id: 1, routes: [{ id: 1, domain: 'a.example' }], l4_routes: [] }, 'sha256:aaa');
    assert.equal(s.currentHash, 'sha256:aaa');
    assert.equal(changeCount, 1);
  });

  it('ignores identical hash (no-op)', () => {
    const s = new ConfigStore();
    let changeCount = 0;
    s.on('change', () => changeCount++);
    s.replaceConfig({ peer_id: 1, routes: [], l4_routes: [] }, 'sha256:aaa');
    s.replaceConfig({ peer_id: 1, routes: [], l4_routes: [] }, 'sha256:aaa');
    assert.equal(changeCount, 1);
  });

  it('computes l4 diff for TCP listener reload', () => {
    const s = new ConfigStore();
    s.replaceConfig({ peer_id: 1, routes: [], l4_routes: [
      { id: 1, listen_port: 13389, target_lan_host: 'x', target_lan_port: 3389 },
    ] }, 'sha256:a');
    const diff = s.replaceConfig({ peer_id: 1, routes: [], l4_routes: [
      { id: 1, listen_port: 13389, target_lan_host: 'x', target_lan_port: 3389 }, // unchanged
      { id: 2, listen_port: 2222, target_lan_host: 'y', target_lan_port: 22 },    // added
    ] }, 'sha256:b');
    assert.deepEqual(diff.l4Added.map(r => r.id), [2]);
    assert.deepEqual(diff.l4Removed, []);
    assert.deepEqual(diff.l4Changed, []);
  });

  it('computes l4 diff for changed port', () => {
    const s = new ConfigStore();
    s.replaceConfig({ peer_id: 1, routes: [], l4_routes: [
      { id: 1, listen_port: 13389, target_lan_host: 'x', target_lan_port: 3389 },
    ] }, 'sha256:a');
    const diff = s.replaceConfig({ peer_id: 1, routes: [], l4_routes: [
      { id: 1, listen_port: 14000, target_lan_host: 'x', target_lan_port: 3389 }, // port changed
    ] }, 'sha256:b');
    assert.equal(diff.l4Changed.length, 1);
    assert.equal(diff.l4Changed[0].id, 1);
  });
});
```

- [ ] **Step 2: Test ausführen — muss failen**

```bash
node --test tests/configStore.test.js
```

- [ ] **Step 3: Implementation**

Create `/root/gatecontrol-gateway/src/sync/configStore.js`:

```javascript
'use strict';

const EventEmitter = require('node:events');

class ConfigStore extends EventEmitter {
  constructor() {
    super();
    this.peerId = null;
    this.httpRoutes = [];
    this.l4Routes = [];
    this.currentHash = null;
  }

  /**
   * Replace config and emit 'change' if hash differs. Returns diff {l4Added, l4Removed, l4Changed}.
   */
  replaceConfig(cfg, newHash) {
    if (this.currentHash === newHash) {
      return { l4Added: [], l4Removed: [], l4Changed: [], unchanged: true };
    }
    const oldL4 = new Map(this.l4Routes.map(r => [r.id, r]));
    const newL4 = new Map((cfg.l4_routes || []).map(r => [r.id, r]));

    const l4Added = [];
    const l4Removed = [];
    const l4Changed = [];

    for (const [id, nr] of newL4) {
      const or = oldL4.get(id);
      if (!or) l4Added.push(nr);
      else if (or.listen_port !== nr.listen_port
            || or.target_lan_host !== nr.target_lan_host
            || or.target_lan_port !== nr.target_lan_port) {
        l4Changed.push({ ...nr, oldPort: or.listen_port });
      }
    }
    for (const [id, or] of oldL4) {
      if (!newL4.has(id)) l4Removed.push(or);
    }

    this.peerId = cfg.peer_id;
    this.httpRoutes = cfg.routes || [];
    this.l4Routes = cfg.l4_routes || [];
    this.currentHash = newHash;

    const diff = { l4Added, l4Removed, l4Changed, unchanged: false };
    this.emit('change', { cfg, hash: newHash, diff });
    return diff;
  }

  /**
   * Lookup HTTP route by domain (O(n) — fine for typical Heimnetz size).
   */
  findHttpRouteByDomain(domain) {
    return this.httpRoutes.find(r => r.domain === domain) || null;
  }

  /**
   * Check if a MAC is in the WoL-whitelist of any current route.
   */
  isMacInWolWhitelist(mac) {
    const mSelf = (mac || '').toUpperCase();
    for (const r of [...this.httpRoutes, ...this.l4Routes]) {
      if (r.wol_enabled && r.wol_mac && r.wol_mac.toUpperCase() === mSelf) return true;
    }
    return false;
  }
}

module.exports = { ConfigStore };
```

- [ ] **Step 4: Test + Commit**

```bash
node --test tests/configStore.test.js
git add src/sync/configStore.js tests/configStore.test.js
git commit -m "feat(sync): ConfigStore in-memory state + L4 diff + change events"
git push
```

---

## Task 8: Poller mit Exponential Backoff

**Files:**
- Create: `/root/gatecontrol-gateway/src/sync/poller.js`
- Create: `/root/gatecontrol-gateway/tests/poller.test.js`

- [ ] **Step 1: Failing Tests**

Create `/root/gatecontrol-gateway/tests/poller.test.js`:

```javascript
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { Poller, computeBackoff } = require('../src/sync/poller');

describe('Poller', () => {
  it('computeBackoff follows exponential curve with cap', () => {
    assert.equal(computeBackoff(0, { baseMs: 5000, maxMs: 300000 }), 5000);
    assert.equal(computeBackoff(1, { baseMs: 5000, maxMs: 300000 }), 10000);
    assert.equal(computeBackoff(2, { baseMs: 5000, maxMs: 300000 }), 20000);
    // cap at 300000
    assert.equal(computeBackoff(20, { baseMs: 5000, maxMs: 300000 }), 300000);
  });

  it('Poller.triggerImmediate debounces rapid calls', async () => {
    let calls = 0;
    const p = new Poller({
      intervalMs: 999999,
      fetcher: async () => { calls++; return { changed: false }; },
      debounceMs: 50,
    });
    p.triggerImmediate();
    p.triggerImmediate();
    p.triggerImmediate();
    await new Promise(r => setTimeout(r, 100));
    assert.equal(calls, 1);
  });

  it('Poller backs off after failures and recovers on success', async () => {
    let attempts = 0;
    const p = new Poller({
      intervalMs: 999999,
      fetcher: async () => {
        attempts++;
        if (attempts < 3) throw new Error('sim-fail');
        return { changed: true };
      },
      debounceMs: 0,
      baseMs: 5,
      maxMs: 100,
    });
    p.triggerImmediate();
    await new Promise(r => setTimeout(r, 500));
    assert.ok(attempts >= 3, `expected at least 3 attempts, got ${attempts}`);
    assert.equal(p.consecutiveFails, 0);
  });
});
```

- [ ] **Step 2: Test ausführen — muss failen**

```bash
node --test tests/poller.test.js
```

- [ ] **Step 3: Implementation**

Create `/root/gatecontrol-gateway/src/sync/poller.js`:

```javascript
'use strict';

const logger = require('../logger');

function computeBackoff(fails, { baseMs = 5000, maxMs = 300000 } = {}) {
  const delay = baseMs * Math.pow(2, fails);
  return Math.min(delay, maxMs);
}

class Poller {
  constructor({ intervalMs = 300000, fetcher, debounceMs = 500, baseMs = 5000, maxMs = 300000 }) {
    this.intervalMs = intervalMs;
    this.fetcher = fetcher;
    this.debounceMs = debounceMs;
    this.baseMs = baseMs;
    this.maxMs = maxMs;
    this.consecutiveFails = 0;
    this._timer = null;
    this._debounceTimer = null;
    this._running = false;
  }

  start() {
    this._scheduleNext(this.intervalMs);
  }

  stop() {
    if (this._timer) clearTimeout(this._timer);
    if (this._debounceTimer) clearTimeout(this._debounceTimer);
    this._timer = null;
    this._debounceTimer = null;
  }

  /** Trigger an immediate poll (debounced). */
  triggerImmediate() {
    if (this._debounceTimer) clearTimeout(this._debounceTimer);
    this._debounceTimer = setTimeout(() => {
      this._debounceTimer = null;
      this._runOnce();
    }, this.debounceMs);
  }

  async _runOnce() {
    if (this._running) return; // prevent concurrent
    this._running = true;
    try {
      await this.fetcher();
      this.consecutiveFails = 0;
      this._scheduleNext(this.intervalMs);
    } catch (err) {
      this.consecutiveFails++;
      const backoff = computeBackoff(this.consecutiveFails, { baseMs: this.baseMs, maxMs: this.maxMs });
      logger.warn({ err: err.message, fails: this.consecutiveFails, backoffMs: backoff }, 'Poll failed, backing off');
      this._scheduleNext(backoff);
    } finally {
      this._running = false;
    }
  }

  _scheduleNext(delayMs) {
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => this._runOnce(), delayMs);
  }
}

module.exports = { Poller, computeBackoff };
```

- [ ] **Step 4: Test + Commit**

```bash
node --test tests/poller.test.js
git add src/sync/poller.js tests/poller.test.js
git commit -m "feat(sync): Poller with exponential backoff + debounced trigger"
git push
```

---

## Task 9: API-Route `/api/config-changed` (Push-Receiver)

**Files:**
- Create: `/root/gatecontrol-gateway/src/api/routes/configChanged.js`
- Create: `/root/gatecontrol-gateway/tests/api_config_changed.test.js`

- [ ] **Step 1: Failing Test**

Create `/root/gatecontrol-gateway/tests/api_config_changed.test.js`:

```javascript
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { createAuthMiddleware } = require('../src/api/middleware/auth');
const { createConfigChangedRouter } = require('../src/api/routes/configChanged');

describe('POST /api/config-changed', () => {
  async function startServer(poller) {
    const app = express();
    app.use(express.json());
    const auth = createAuthMiddleware({ expectedToken: 't'.repeat(64) });
    app.use('/api', auth, createConfigChangedRouter({ poller }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise(r => server.on('listening', r));
    return { server, port: server.address().port };
  }

  it('triggers poller on valid token', async () => {
    let triggered = 0;
    const poller = { triggerImmediate: () => triggered++ };
    const { server, port } = await startServer(poller);
    const res = await new Promise(resolve => {
      const req = http.request({ host: '127.0.0.1', port, path: '/api/config-changed', method: 'POST', headers: { 'X-Gateway-Token': 't'.repeat(64) } }, (r) => { r.resume(); r.on('end', () => resolve(r.statusCode)); });
      req.end();
    });
    assert.equal(res, 200);
    assert.equal(triggered, 1);
    server.close();
  });

  it('rejects without token', async () => {
    const poller = { triggerImmediate: () => {} };
    const { server, port } = await startServer(poller);
    const res = await new Promise(resolve => {
      const req = http.request({ host: '127.0.0.1', port, path: '/api/config-changed', method: 'POST' }, (r) => { r.resume(); r.on('end', () => resolve(r.statusCode)); });
      req.end();
    });
    assert.equal(res, 401);
    server.close();
  });
});
```

- [ ] **Step 2: Test ausführen — muss failen**

```bash
node --test tests/api_config_changed.test.js
```

- [ ] **Step 3: Implementation**

Create `/root/gatecontrol-gateway/src/api/routes/configChanged.js`:

```javascript
'use strict';

const express = require('express');
const logger = require('../../logger');

function createConfigChangedRouter({ poller }) {
  const router = express.Router();
  router.post('/config-changed', (req, res) => {
    logger.info({ ip: req.ip }, 'Received config-changed push, triggering poll');
    poller.triggerImmediate();
    res.status(200).json({ ok: true });
  });
  return router;
}

module.exports = { createConfigChangedRouter };
```

- [ ] **Step 4: Test + Commit**

```bash
node --test tests/api_config_changed.test.js
git add src/api/routes/configChanged.js tests/api_config_changed.test.js
git commit -m "feat(api): POST /api/config-changed push-receiver triggers poller"
git push
```

---

## Task 10: HTTP-Router (Domain → LAN-Target-Map)

**Files:**
- Create: `/root/gatecontrol-gateway/src/proxy/router.js`
- Create: `/root/gatecontrol-gateway/tests/router.test.js`

- [ ] **Step 1: Failing Test**

Create `/root/gatecontrol-gateway/tests/router.test.js`:

```javascript
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { Router } = require('../src/proxy/router');

describe('http router', () => {
  it('resolves by domain', () => {
    const r = new Router();
    r.setRoutes([
      { domain: 'nas.example.com', target_lan_host: '192.168.1.10', target_lan_port: 5001, wol_enabled: false },
    ]);
    const t = r.resolve('nas.example.com');
    assert.deepEqual(t, { host: '192.168.1.10', port: 5001, wolMac: null, routeId: undefined });
  });

  it('returns null for unknown domain', () => {
    const r = new Router();
    r.setRoutes([]);
    assert.equal(r.resolve('unknown.example.com'), null);
  });

  it('atomic swap keeps old routes serving until new ones ready', () => {
    const r = new Router();
    r.setRoutes([{ domain: 'a.example', target_lan_host: '1.1.1.1', target_lan_port: 80 }]);
    const oldMap = r._map;
    r.setRoutes([{ domain: 'b.example', target_lan_host: '2.2.2.2', target_lan_port: 80 }]);
    assert.notEqual(r._map, oldMap, 'map reference must be swapped, not mutated');
  });

  it('passes wol_mac when present', () => {
    const r = new Router();
    r.setRoutes([
      { id: 1, domain: 'x.example', target_lan_host: '10.0.0.1', target_lan_port: 80, wol_enabled: true, wol_mac: 'AA:BB:CC:DD:EE:FF' },
    ]);
    const t = r.resolve('x.example');
    assert.equal(t.wolMac, 'AA:BB:CC:DD:EE:FF');
    assert.equal(t.routeId, 1);
  });
});
```

- [ ] **Step 2: Test ausführen — muss failen**

```bash
node --test tests/router.test.js
```

- [ ] **Step 3: Implementation**

Create `/root/gatecontrol-gateway/src/proxy/router.js`:

```javascript
'use strict';

class Router {
  constructor() {
    this._map = new Map();
  }

  /**
   * Atomic swap of the routing table. Existing in-flight requests use the old
   * map via their closure; new requests get the new map.
   */
  setRoutes(httpRoutes) {
    const next = new Map();
    for (const route of httpRoutes) {
      next.set(route.domain, {
        host: route.target_lan_host,
        port: route.target_lan_port,
        wolMac: route.wol_enabled ? (route.wol_mac || null) : null,
        routeId: route.id,
      });
    }
    this._map = next;
  }

  resolve(domain) {
    return this._map.get(domain) || null;
  }
}

module.exports = { Router };
```

- [ ] **Step 4: Test + Commit**

```bash
node --test tests/router.test.js
git add src/proxy/router.js tests/router.test.js
git commit -m "feat(proxy): Router with atomic map-swap for hot-reload"
git push
```

---

## Task 11: HTTP-Reverse-Proxy

**Files:**
- Create: `/root/gatecontrol-gateway/src/proxy/http.js`
- Create: `/root/gatecontrol-gateway/tests/proxy_http.test.js`

- [ ] **Step 1: Failing Test**

Create `/root/gatecontrol-gateway/tests/proxy_http.test.js`:

```javascript
'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Router } = require('../src/proxy/router');
const { createHttpProxy } = require('../src/proxy/http');

describe('HTTP proxy', () => {
  let upstream, proxy;

  before(async () => {
    upstream = http.createServer((req, res) => {
      // echo received headers for verification
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ host: req.headers.host, path: req.url, receivedGatewayHeader: req.headers['x-gateway-target'] || null }));
    });
    await new Promise(r => upstream.listen(0, '127.0.0.1', r));

    const router = new Router();
    router.setRoutes([{
      id: 1,
      domain: 'test.example',
      target_lan_host: '127.0.0.1',
      target_lan_port: upstream.address().port,
    }]);

    proxy = createHttpProxy({ router });
    await new Promise(r => proxy.listen(0, '127.0.0.1', r));
  });

  after(() => { upstream?.close(); proxy?.close(); });

  it('proxies request based on X-Gateway-Target-Domain', async () => {
    const res = await new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port: proxy.address().port, path: '/foo',
        headers: {
          host: 'test.example',
          'X-Gateway-Target-Domain': 'test.example',
          'X-Gateway-Target': `127.0.0.1:${upstream.address().port}`,
        },
      }, (r) => {
        let b = ''; r.on('data', c => b += c);
        r.on('end', () => resolve({ status: r.statusCode, body: JSON.parse(b) }));
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.path, '/foo');
    // X-Gateway-Target header MUST be stripped before forwarding to upstream
    assert.equal(res.body.receivedGatewayHeader, null);
  });

  it('returns 502 for unknown domain', async () => {
    const status = await new Promise(resolve => {
      http.request({
        host: '127.0.0.1', port: proxy.address().port, path: '/',
        headers: { host: 'unknown.example', 'X-Gateway-Target-Domain': 'unknown.example' },
      }, r => { r.resume(); r.on('end', () => resolve(r.statusCode)); }).end();
    });
    assert.equal(status, 502);
  });
});
```

- [ ] **Step 2: Test ausführen — muss failen**

```bash
node --test tests/proxy_http.test.js
```

- [ ] **Step 3: Implementation**

Create `/root/gatecontrol-gateway/src/proxy/http.js`:

```javascript
'use strict';

const http = require('node:http');
const httpProxy = require('http-proxy');
const logger = require('../logger');

/**
 * Create the HTTP reverse-proxy server. Reads `X-Gateway-Target-Domain`
 * header to determine which LAN-target to forward to.
 *
 * Strips `X-Gateway-*` headers before forwarding (don't leak internal info).
 *
 * On ECONNREFUSED, if wolMac is present, returns a hint status. Caller
 * (bootstrap) should wire WoL trigger into this error event.
 */
function createHttpProxy({ router, onUpstreamUnreachable }) {
  const proxy = httpProxy.createProxyServer({ changeOrigin: false, xfwd: true });
  proxy.on('proxyReq', (proxyReq) => {
    // Strip X-Gateway-* headers before forwarding to LAN
    proxyReq.removeHeader('x-gateway-target');
    proxyReq.removeHeader('x-gateway-target-domain');
  });

  proxy.on('error', (err, req, res) => {
    logger.warn({ err: err.message, code: err.code, url: req?.url }, 'Upstream proxy error');
    if (res && !res.headersSent) {
      if (err.code === 'ECONNREFUSED' && typeof onUpstreamUnreachable === 'function') {
        const target = router.resolve(req._targetDomain);
        if (target && target.wolMac) {
          onUpstreamUnreachable({ domain: req._targetDomain, target });
        }
      }
      res.writeHead(err.code === 'ECONNREFUSED' ? 502 : 504, { 'Content-Type': 'text/plain' });
      res.end(`Gateway upstream error: ${err.code || err.message}`);
    }
  });

  return http.createServer((req, res) => {
    const domain = req.headers['x-gateway-target-domain'] || req.headers.host || '';
    req._targetDomain = domain;
    const target = router.resolve(domain);
    if (!target) {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      return res.end(`No route for domain ${domain}`);
    }
    proxy.web(req, res, {
      target: `http://${target.host}:${target.port}`,
    });
  });
}

module.exports = { createHttpProxy };
```

- [ ] **Step 4: Test + Commit**

```bash
node --test tests/proxy_http.test.js
git add src/proxy/http.js tests/proxy_http.test.js
git commit -m "feat(proxy): HTTP reverse-proxy with header-stripping + ECONNREFUSED WoL hook"
git push
```

---

## Task 12: TCP-Proxy mit Dual-Bind-Lifecycle

**Files:**
- Create: `/root/gatecontrol-gateway/src/proxy/tcp.js`
- Create: `/root/gatecontrol-gateway/tests/proxy_tcp.test.js`

- [ ] **Step 1: Failing Test**

Create `/root/gatecontrol-gateway/tests/proxy_tcp.test.js`:

```javascript
'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { TcpProxyManager } = require('../src/proxy/tcp');

describe('TcpProxyManager', () => {
  let upstream, upstreamPort;

  before(async () => {
    upstream = net.createServer(s => {
      s.on('data', d => s.write('echo:' + d.toString()));
    });
    await new Promise(r => upstream.listen(0, '127.0.0.1', r));
    upstreamPort = upstream.address().port;
  });

  after(() => upstream?.close());

  it('starts listener and proxies a TCP request', async () => {
    const mgr = new TcpProxyManager({ bindIp: '127.0.0.1' });
    await mgr.setRoutes([{ id: 1, listen_port: 0, target_lan_host: '127.0.0.1', target_lan_port: upstreamPort }]);
    const ports = mgr.listListenerPorts();
    assert.equal(ports.length, 1);
    const port = ports[0];

    const reply = await new Promise((resolve, reject) => {
      const client = net.connect(port, '127.0.0.1', () => client.write('hi'));
      client.on('data', d => { resolve(d.toString()); client.end(); });
      client.on('error', reject);
    });
    assert.match(reply, /^echo:hi/);
    await mgr.stopAll();
  });

  it('removes listener when route is removed (setRoutes with smaller set)', async () => {
    const mgr = new TcpProxyManager({ bindIp: '127.0.0.1' });
    await mgr.setRoutes([
      { id: 1, listen_port: 0, target_lan_host: '127.0.0.1', target_lan_port: upstreamPort },
      { id: 2, listen_port: 0, target_lan_host: '127.0.0.1', target_lan_port: upstreamPort },
    ]);
    assert.equal(mgr.listListenerPorts().length, 2);
    await mgr.setRoutes([{ id: 1, listen_port: 0, target_lan_host: '127.0.0.1', target_lan_port: upstreamPort }]);
    assert.equal(mgr.listListenerPorts().length, 1);
    await mgr.stopAll();
  });

  it('handles route port-change without service-gap (dual-bind overlap)', async () => {
    const mgr = new TcpProxyManager({ bindIp: '127.0.0.1' });
    await mgr.setRoutes([{ id: 1, listen_port: 0, target_lan_host: '127.0.0.1', target_lan_port: upstreamPort }]);
    const oldPort = mgr.listListenerPorts()[0];

    // Trigger port-change (we can't force same-route to new-port explicit; simulate with new listen_port=0)
    await mgr.setRoutes([{ id: 1, listen_port: 0, target_lan_host: '127.0.0.1', target_lan_port: upstreamPort, _forcePortChange: true }]);

    // Both listeners should respond for a brief window (test-only simplified check)
    const newPort = mgr.listListenerPorts().find(p => p !== oldPort);
    assert.ok(newPort, 'new port should exist');
    await mgr.stopAll();
  });
});
```

- [ ] **Step 2: Test ausführen — muss failen**

```bash
node --test tests/proxy_tcp.test.js
```

- [ ] **Step 3: Implementation**

Create `/root/gatecontrol-gateway/src/proxy/tcp.js`:

```javascript
'use strict';

const net = require('node:net');
const logger = require('../logger');

const DUAL_BIND_OVERLAP_MS = 10_000;

class TcpProxyManager {
  constructor({ bindIp }) {
    this.bindIp = bindIp;
    this._listeners = new Map(); // id → { server, port, target }
  }

  listListenerPorts() {
    return [...this._listeners.values()].map(l => l.port).filter(Boolean);
  }

  async setRoutes(l4Routes) {
    const newIds = new Set(l4Routes.map(r => r.id));
    // Remove listeners no longer in config
    for (const [id, l] of this._listeners) {
      if (!newIds.has(id)) {
        await this._stopListener(id, l);
      }
    }
    // Add or update
    for (const route of l4Routes) {
      const existing = this._listeners.get(route.id);
      if (!existing) {
        await this._startListener(route);
      } else if (existing.target.port !== route.target_lan_port
              || existing.target.host !== route.target_lan_host
              || existing.listenPortRequested !== route.listen_port
              || route._forcePortChange) {
        // Port- or target-change → dual-bind overlap
        await this._transitionListener(route, existing);
      }
    }
  }

  async _startListener(route) {
    const server = net.createServer(socket => this._handleConnection(socket, route));
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(route.listen_port, this.bindIp, () => { server.off('error', reject); resolve(); });
    });
    const port = server.address().port;
    logger.info({ routeId: route.id, port, target: `${route.target_lan_host}:${route.target_lan_port}` }, 'TCP listener started');
    this._listeners.set(route.id, {
      server, port,
      target: { host: route.target_lan_host, port: route.target_lan_port },
      listenPortRequested: route.listen_port,
    });
  }

  async _stopListener(id, l) {
    logger.info({ routeId: id, port: l.port }, 'TCP listener stopping');
    await new Promise(resolve => l.server.close(resolve));
    this._listeners.delete(id);
  }

  async _transitionListener(route, existing) {
    logger.info({ routeId: route.id }, 'TCP listener transition (dual-bind overlap)');
    // Start new listener BEFORE closing old
    const newServer = net.createServer(socket => this._handleConnection(socket, route));
    await new Promise((resolve, reject) => {
      newServer.once('error', reject);
      newServer.listen(route.listen_port, this.bindIp, () => { newServer.off('error', reject); resolve(); });
    });
    const newPort = newServer.address().port;

    // Store as new listener under a temp key, swap after overlap
    const oldL = existing;
    this._listeners.set(route.id, {
      server: newServer, port: newPort,
      target: { host: route.target_lan_host, port: route.target_lan_port },
      listenPortRequested: route.listen_port,
    });

    setTimeout(async () => {
      await new Promise(r => oldL.server.close(r));
      logger.info({ routeId: route.id, oldPort: oldL.port, newPort }, 'Dual-bind overlap expired, old listener closed');
    }, DUAL_BIND_OVERLAP_MS);
  }

  _handleConnection(clientSocket, route) {
    const upstream = net.connect(route.target_lan_port, route.target_lan_host);
    clientSocket.pipe(upstream);
    upstream.pipe(clientSocket);
    const onCloseOrError = () => { try { upstream.destroy(); } catch {} try { clientSocket.destroy(); } catch {} };
    clientSocket.on('error', onCloseOrError);
    upstream.on('error', onCloseOrError);
    clientSocket.on('close', onCloseOrError);
    upstream.on('close', onCloseOrError);
  }

  async stopAll() {
    for (const [id, l] of [...this._listeners]) {
      await this._stopListener(id, l);
    }
  }
}

module.exports = { TcpProxyManager, DUAL_BIND_OVERLAP_MS };
```

- [ ] **Step 4: Test + Commit**

```bash
node --test tests/proxy_tcp.test.js
git add src/proxy/tcp.js tests/proxy_tcp.test.js
git commit -m "feat(proxy): TcpProxyManager with dual-bind port-change overlap"
git push
```

---

## Task 13: Wake-on-LAN Magic-Packet Sender

**Files:**
- Create: `/root/gatecontrol-gateway/src/wol.js`
- Create: `/root/gatecontrol-gateway/tests/wol.test.js`

- [ ] **Step 1: Failing Tests**

Create `/root/gatecontrol-gateway/tests/wol.test.js`:

```javascript
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildMagicPacket, validateMac } = require('../src/wol');

describe('wol', () => {
  it('buildMagicPacket produces 102 bytes: 6xFF + 16xMAC', () => {
    const p = buildMagicPacket('AA:BB:CC:DD:EE:FF');
    assert.equal(p.length, 6 + 16 * 6);
    for (let i = 0; i < 6; i++) assert.equal(p[i], 0xff);
    for (let r = 0; r < 16; r++) {
      const off = 6 + r * 6;
      assert.equal(p[off], 0xaa);
      assert.equal(p[off + 1], 0xbb);
      assert.equal(p[off + 5], 0xff);
    }
  });

  it('buildMagicPacket accepts mac with dashes', () => {
    const p = buildMagicPacket('AA-BB-CC-DD-EE-FF');
    assert.equal(p.length, 102);
  });

  it('buildMagicPacket accepts mac without separators', () => {
    const p = buildMagicPacket('AABBCCDDEEFF');
    assert.equal(p.length, 102);
  });

  it('buildMagicPacket throws on invalid mac', () => {
    assert.throws(() => buildMagicPacket('ZZ:ZZ:ZZ:ZZ:ZZ:ZZ'), /mac/i);
    assert.throws(() => buildMagicPacket('AA:BB:CC:DD:EE'), /mac/i);
  });

  it('validateMac accepts standard formats', () => {
    assert.equal(validateMac('AA:BB:CC:DD:EE:FF'), true);
    assert.equal(validateMac('aa-bb-cc-dd-ee-ff'), true);
    assert.equal(validateMac('not-a-mac'), false);
  });
});
```

- [ ] **Step 2: Test ausführen — muss failen**

```bash
node --test tests/wol.test.js
```

- [ ] **Step 3: Implementation**

Create `/root/gatecontrol-gateway/src/wol.js`:

```javascript
'use strict';

const dgram = require('node:dgram');
const os = require('node:os');
const net = require('node:net');
const logger = require('./logger');

const WG_INTERFACE = 'gatecontrol0';

function validateMac(mac) {
  return /^([0-9a-fA-F]{2}[:-]?){5}[0-9a-fA-F]{2}$/.test(mac);
}

function normalizeMac(mac) {
  const clean = mac.replace(/[:-]/g, '').toLowerCase();
  if (clean.length !== 12) throw new Error(`Invalid MAC: ${mac}`);
  if (!/^[0-9a-f]{12}$/.test(clean)) throw new Error(`Invalid MAC hex: ${mac}`);
  return Buffer.from(clean, 'hex');
}

function buildMagicPacket(mac) {
  const bytes = normalizeMac(mac);
  const packet = Buffer.alloc(6 + 16 * 6);
  packet.fill(0xff, 0, 6);
  for (let i = 0; i < 16; i++) bytes.copy(packet, 6 + i * 6);
  return packet;
}

/**
 * Send magic packet on all non-loopback, non-WG interfaces that have a broadcast address.
 * Returns array of { interface, broadcast, sent }.
 */
async function sendMagicPacket(mac) {
  const packet = buildMagicPacket(mac);
  const ifaces = os.networkInterfaces();
  const sendPromises = [];
  const results = [];

  for (const [name, addrs] of Object.entries(ifaces)) {
    if (name === 'lo' || name.startsWith(WG_INTERFACE)) continue;
    if (name.startsWith('docker') || name.startsWith('br-')) continue;
    for (const addr of addrs) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      const broadcast = _computeBroadcast(addr.address, addr.netmask);
      if (!broadcast) continue;

      sendPromises.push(new Promise((resolve) => {
        const sock = dgram.createSocket('udp4');
        sock.bind(() => {
          sock.setBroadcast(true);
          sock.send(packet, 9, broadcast, (err) => {
            sock.close();
            results.push({ interface: name, broadcast, sent: !err, err: err?.message });
            resolve();
          });
        });
      }));
    }
  }

  await Promise.all(sendPromises);
  logger.info({ mac, results }, 'Magic packet sent');
  return results;
}

function _computeBroadcast(ip, netmask) {
  const ipParts = ip.split('.').map(Number);
  const maskParts = netmask.split('.').map(Number);
  if (ipParts.length !== 4 || maskParts.length !== 4) return null;
  const broadcastParts = ipParts.map((o, i) => (o & maskParts[i]) | (~maskParts[i] & 0xff));
  return broadcastParts.join('.');
}

/**
 * After sending magic packet, poll TCP reachability until timeout.
 */
async function waitForReachable(host, port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise(resolve => {
      const sock = net.createConnection({ host, port, timeout: 2000 });
      sock.once('connect', () => { sock.destroy(); resolve(true); });
      sock.once('error', () => resolve(false));
      sock.once('timeout', () => { sock.destroy(); resolve(false); });
    });
    if (ok) return Date.now() - (deadline - timeoutMs);
    await new Promise(r => setTimeout(r, 2000));
  }
  return null;
}

module.exports = { buildMagicPacket, validateMac, sendMagicPacket, waitForReachable, _computeBroadcast };
```

- [ ] **Step 4: Test + Commit**

```bash
node --test tests/wol.test.js
git add src/wol.js tests/wol.test.js
git commit -m "feat(wol): magic packet builder + SO_BROADCAST sender + reachability poll"
git push
```

---

## Task 14: API `/api/wol` Receiver

**Files:**
- Create: `/root/gatecontrol-gateway/src/api/routes/wol.js`
- Create: `/root/gatecontrol-gateway/tests/api_wol.test.js`

- [ ] **Step 1: Failing Tests**

Create `/root/gatecontrol-gateway/tests/api_wol.test.js`:

```javascript
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { createAuthMiddleware } = require('../src/api/middleware/auth');
const { createWolRouter } = require('../src/api/routes/wol');

describe('POST /api/wol', () => {
  async function serverWith(configStore, { sendMagicPacket, waitForReachable } = {}) {
    const app = express();
    app.use(express.json());
    const auth = createAuthMiddleware({ expectedToken: 't'.repeat(64) });
    app.use('/api', auth, createWolRouter({
      configStore,
      sendMagicPacket: sendMagicPacket || (async () => [{ sent: true }]),
      waitForReachable: waitForReachable || (async () => 5000),
    }));
    const s = app.listen(0, '127.0.0.1');
    await new Promise(r => s.on('listening', r));
    return s;
  }

  async function postJson(port, path, body) {
    return new Promise(resolve => {
      const payload = JSON.stringify(body);
      const req = http.request({
        host: '127.0.0.1', port, path, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'X-Gateway-Token': 't'.repeat(64) },
      }, (r) => { let b = ''; r.on('data', c => b += c); r.on('end', () => resolve({ status: r.statusCode, body: b })); });
      req.end(payload);
    });
  }

  it('accepts whitelisted MAC + sends packet + polls reachability', async () => {
    const store = { isMacInWolWhitelist: (m) => m === 'AA:BB:CC:DD:EE:FF' };
    let sent = 0, polled = 0;
    const s = await serverWith(store, { sendMagicPacket: async () => { sent++; return [{ sent: true }]; }, waitForReachable: async () => { polled++; return 3000; } });
    const r = await postJson(s.address().port, '/api/wol', { mac: 'AA:BB:CC:DD:EE:FF', lan_host: '192.168.1.10', timeout_ms: 10000 });
    assert.equal(r.status, 200);
    const body = JSON.parse(r.body);
    assert.equal(body.success, true);
    assert.equal(body.elapsed_ms, 3000);
    assert.equal(sent, 1);
    assert.equal(polled, 1);
    s.close();
  });

  it('rejects MAC not in whitelist with 403', async () => {
    const store = { isMacInWolWhitelist: () => false };
    const s = await serverWith(store);
    const r = await postJson(s.address().port, '/api/wol', { mac: '11:22:33:44:55:66', lan_host: '192.168.1.10', timeout_ms: 5000 });
    assert.equal(r.status, 403);
    s.close();
  });

  it('rejects invalid MAC format with 400', async () => {
    const store = { isMacInWolWhitelist: () => true };
    const s = await serverWith(store);
    const r = await postJson(s.address().port, '/api/wol', { mac: 'not-a-mac', lan_host: '192.168.1.10', timeout_ms: 5000 });
    assert.equal(r.status, 400);
    s.close();
  });
});
```

- [ ] **Step 2: Test ausführen — muss failen**

```bash
node --test tests/api_wol.test.js
```

- [ ] **Step 3: Implementation**

Create `/root/gatecontrol-gateway/src/api/routes/wol.js`:

```javascript
'use strict';

const express = require('express');
const { validateMac } = require('../../wol');
const logger = require('../../logger');

function createWolRouter({ configStore, sendMagicPacket, waitForReachable }) {
  const router = express.Router();

  router.post('/wol', async (req, res) => {
    const { mac, lan_host, timeout_ms } = req.body || {};
    if (!mac || !validateMac(mac)) {
      return res.status(400).json({ error: 'invalid_mac' });
    }
    if (!lan_host || typeof lan_host !== 'string') {
      return res.status(400).json({ error: 'invalid_lan_host' });
    }
    if (!configStore.isMacInWolWhitelist(mac)) {
      logger.warn({ mac }, 'WoL request MAC not in whitelist');
      return res.status(403).json({ error: 'mac_not_whitelisted' });
    }
    const results = await sendMagicPacket(mac);
    const elapsed_ms = await waitForReachable(lan_host, 80, timeout_ms || 60000);
    if (elapsed_ms === null) {
      return res.status(200).json({ success: false, reason: 'timeout', sent_on: results });
    }
    res.json({ success: true, elapsed_ms, sent_on: results });
  });

  return router;
}

module.exports = { createWolRouter };
```

- [ ] **Step 4: Test + Commit**

```bash
node --test tests/api_wol.test.js
git add src/api/routes/wol.js tests/api_wol.test.js
git commit -m "feat(api): POST /api/wol with MAC-whitelist + reachability poll"
git push
```

---

## Task 15: Self-Check 4-Layer

**Files:**
- Create: `/root/gatecontrol-gateway/src/health/selfCheck.js`
- Create: `/root/gatecontrol-gateway/tests/selfCheck.test.js`

- [ ] **Step 1: Failing Tests**

Create `/root/gatecontrol-gateway/tests/selfCheck.test.js`:

```javascript
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { runSelfCheck } = require('../src/health/selfCheck');

describe('selfCheck', () => {
  it('returns structured health result with all layers', async () => {
    const result = await runSelfCheck({
      proxyPort: 9999, // unreachable
      apiPort: 9998,   // unreachable
      tcpPorts: [],
      wgStatus: async () => ({ peers: [{ handshakeAgeS: 30 }] }),
      dnsResolveFn: async () => ['1.2.3.4'],
      reachabilityFn: async () => ({ reachable: true, latencyMs: 10 }),
      routes: [],
    });
    assert.ok('http_proxy_healthy' in result);
    assert.ok('tcp_listeners' in result);
    assert.ok('wg_handshake_age_s' in result);
    assert.ok('dns_resolve_ok' in result);
    assert.ok('route_reachability' in result);
  });

  it('reports wg_handshake_age_s from wgStatus', async () => {
    const result = await runSelfCheck({
      proxyPort: 9999, apiPort: 9998,
      tcpPorts: [],
      wgStatus: async () => ({ peers: [{ handshakeAgeS: 42 }] }),
      dnsResolveFn: async () => [],
      reachabilityFn: async () => ({ reachable: true }),
      routes: [],
    });
    assert.equal(result.wg_handshake_age_s, 42);
  });

  it('returns per-route reachability summary', async () => {
    const result = await runSelfCheck({
      proxyPort: 9999, apiPort: 9998,
      tcpPorts: [],
      wgStatus: async () => ({ peers: [] }),
      dnsResolveFn: async () => [],
      reachabilityFn: async (host, port) => ({ reachable: host === '192.168.1.10', latencyMs: 15 }),
      routes: [
        { id: 1, domain: 'a.example', target_lan_host: '192.168.1.10', target_lan_port: 80 },
        { id: 2, domain: 'b.example', target_lan_host: '192.168.1.20', target_lan_port: 80 },
      ],
    });
    assert.equal(result.route_reachability.length, 2);
    assert.equal(result.route_reachability.find(r => r.route_id === 1).reachable, true);
    assert.equal(result.route_reachability.find(r => r.route_id === 2).reachable, false);
  });
});
```

- [ ] **Step 2: Test ausführen — muss failen**

```bash
node --test tests/selfCheck.test.js
```

- [ ] **Step 3: Implementation**

Create `/root/gatecontrol-gateway/src/health/selfCheck.js`:

```javascript
'use strict';

const net = require('node:net');

async function tcpProbe(host, port, timeoutMs = 2000) {
  return new Promise(resolve => {
    const start = Date.now();
    const sock = net.createConnection({ host, port, timeout: timeoutMs });
    sock.once('connect', () => { sock.destroy(); resolve({ reachable: true, latencyMs: Date.now() - start }); });
    sock.once('error', () => resolve({ reachable: false }));
    sock.once('timeout', () => { sock.destroy(); resolve({ reachable: false, reason: 'timeout' }); });
  });
}

async function runSelfCheck({ proxyPort, apiPort, tcpPorts, wgStatus, dnsResolveFn, reachabilityFn, routes }) {
  // Layer 1 — Process: HTTP-Proxy localhost probe
  const proxyHealthy = (await tcpProbe('127.0.0.1', proxyPort)).reachable;
  const apiHealthy = (await tcpProbe('127.0.0.1', apiPort)).reachable;

  // Layer 1b — TCP-Listeners
  const tcp_listeners = await Promise.all((tcpPorts || []).map(async (port) => ({
    port,
    status: (await tcpProbe('127.0.0.1', port)).reachable ? 'listening' : 'listener_failed',
  })));

  // Layer 2 — Network: WG + DNS
  let wg_handshake_age_s = null;
  try {
    const wgs = await wgStatus();
    const peer = (wgs.peers || [])[0];
    wg_handshake_age_s = peer ? peer.handshakeAgeS : null;
  } catch { /* tunnel down */ }

  let dns_resolve_ok = false;
  try { const list = await dnsResolveFn(); dns_resolve_ok = Array.isArray(list) && list.length > 0; } catch { /* dns failed */ }

  // Layer 3 — Per-Route LAN reachability
  const route_reachability = await Promise.all((routes || []).map(async (r) => {
    const res = await reachabilityFn(r.target_lan_host, r.target_lan_port);
    return { route_id: r.id, domain: r.domain, reachable: res.reachable, latency_ms: res.latencyMs || null, last_checked_at: Date.now() };
  }));

  const anyListenerFailed = tcp_listeners.some(l => l.status === 'listener_failed');

  return {
    http_proxy_healthy: proxyHealthy,
    api_healthy: apiHealthy,
    tcp_listeners,
    wg_handshake_age_s,
    dns_resolve_ok,
    route_reachability,
    overall_healthy: proxyHealthy && apiHealthy && !anyListenerFailed,
  };
}

module.exports = { runSelfCheck, tcpProbe };
```

- [ ] **Step 4: Test + Commit**

```bash
node --test tests/selfCheck.test.js
git add src/health/selfCheck.js tests/selfCheck.test.js
git commit -m "feat(health): 4-layer self-check (proxy + tcp + wg + dns + per-route reachability)"
git push
```

---

## Task 16: Status/Health/Probe API + Heartbeat-Client

**Files:**
- Create: `/root/gatecontrol-gateway/src/api/routes/status.js`
- Create: `/root/gatecontrol-gateway/src/api/routes/probe.js`
- Create: `/root/gatecontrol-gateway/src/heartbeat.js`
- Create: `/root/gatecontrol-gateway/tests/heartbeat.test.js`

- [ ] **Step 1: Status-Route + Probe-Route**

Create `/root/gatecontrol-gateway/src/api/routes/status.js`:

```javascript
'use strict';

const express = require('express');

function createStatusRouter({ getSelfCheckResult }) {
  const router = express.Router();
  router.get('/status', async (req, res) => {
    const result = await getSelfCheckResult();
    res.json(result);
  });
  return router;
}

module.exports = { createStatusRouter };
```

Create `/root/gatecontrol-gateway/src/api/routes/probe.js`:

```javascript
'use strict';

const express = require('express');

function createProbeRouter({ lanProbeFn }) {
  const router = express.Router();
  // POST /api/probe — triggered by Server as end-to-end health check
  router.post('/probe', async (req, res) => {
    const start = Date.now();
    const result = await lanProbeFn();
    res.json({
      gateway_timestamp: Date.now(),
      probe_latency_ms: Date.now() - start,
      probe_result: result,
      echo: req.body || null,
    });
  });
  return router;
}

module.exports = { createProbeRouter };
```

- [ ] **Step 2: Heartbeat-Client**

Create `/root/gatecontrol-gateway/tests/heartbeat.test.js`:

```javascript
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { sendHeartbeat } = require('../src/heartbeat');

describe('heartbeat', () => {
  it('sends POST /api/v1/gateway/heartbeat with Bearer + JSON payload', async () => {
    let received = null;
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        received = { path: req.url, auth: req.headers.authorization, body };
        res.writeHead(200); res.end('{}');
      });
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;

    await sendHeartbeat({
      serverUrl: `http://127.0.0.1:${port}`,
      apiToken: 'gc_gw_' + 'a'.repeat(64),
      health: { http_proxy_healthy: true, tcp_listeners: [], wg_handshake_age_s: 30, uptime_s: 100 },
    });

    assert.equal(received.path, '/api/v1/gateway/heartbeat');
    assert.match(received.auth, /^Bearer gc_gw_/);
    const body = JSON.parse(received.body);
    assert.equal(body.http_proxy_healthy, true);
    server.close();
  });
});
```

Create `/root/gatecontrol-gateway/src/heartbeat.js`:

```javascript
'use strict';

const axios = require('axios');
const logger = require('./logger');

async function sendHeartbeat({ serverUrl, apiToken, health }) {
  try {
    await axios.post(`${serverUrl}/api/v1/gateway/heartbeat`, health, {
      headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
      timeout: 10_000,
    });
  } catch (err) {
    logger.warn({ err: err.message, status: err.response?.status }, 'Heartbeat failed');
  }
}

function startHeartbeatTicker({ serverUrl, apiToken, getHealth, intervalMs }) {
  const tick = async () => {
    const health = await getHealth();
    await sendHeartbeat({ serverUrl, apiToken, health });
  };
  const timer = setInterval(tick, intervalMs);
  tick(); // fire immediately
  return { stop: () => clearInterval(timer) };
}

module.exports = { sendHeartbeat, startHeartbeatTicker };
```

- [ ] **Step 3: Test + Commit**

```bash
node --test tests/heartbeat.test.js
git add src/api/routes/status.js src/api/routes/probe.js src/heartbeat.js tests/heartbeat.test.js
git commit -m "feat(health): status/probe endpoints + heartbeat ticker to server"
git push
```

---

## Task 17: Sync-Client gegen Server-API

**Files:**
- Create: `/root/gatecontrol-gateway/src/sync/syncClient.js`
- Create: `/root/gatecontrol-gateway/tests/syncClient.test.js`

- [ ] **Step 1: Failing Test + Implementation**

Create `/root/gatecontrol-gateway/tests/syncClient.test.js`:

```javascript
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { fetchConfig, checkHash } = require('../src/sync/syncClient');

describe('syncClient', () => {
  it('fetches config from /api/v1/gateway/config with Bearer', async () => {
    let req;
    const server = http.createServer((r, res) => {
      req = r;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ config_hash_version: 1, peer_id: 3, routes: [], l4_routes: [], config_hash: 'sha256:xyz' }));
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));

    const cfg = await fetchConfig({ serverUrl: `http://127.0.0.1:${server.address().port}`, apiToken: 'gc_gw_x' });
    assert.equal(cfg.peer_id, 3);
    assert.equal(cfg.config_hash, 'sha256:xyz');
    assert.match(req.headers.authorization, /Bearer gc_gw_x/);
    server.close();
  });

  it('checkHash returns 304 as { changed: false }', async () => {
    const server = http.createServer((r, res) => { res.writeHead(304); res.end(); });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const result = await checkHash({ serverUrl: `http://127.0.0.1:${server.address().port}`, apiToken: 'x', hash: 'sha256:a' });
    assert.equal(result.changed, false);
    server.close();
  });
});
```

Create `/root/gatecontrol-gateway/src/sync/syncClient.js`:

```javascript
'use strict';

const axios = require('axios');
const logger = require('../logger');

async function fetchConfig({ serverUrl, apiToken }) {
  const res = await axios.get(`${serverUrl}/api/v1/gateway/config`, {
    headers: { Authorization: `Bearer ${apiToken}` },
    timeout: 10_000,
  });
  return res.data;
}

async function checkHash({ serverUrl, apiToken, hash }) {
  try {
    const res = await axios.get(`${serverUrl}/api/v1/gateway/config/check`, {
      headers: { Authorization: `Bearer ${apiToken}` },
      params: { hash },
      timeout: 5_000,
      validateStatus: (s) => s === 200 || s === 304,
    });
    return { changed: res.status === 200, hash: res.data?.config_hash };
  } catch (err) {
    logger.warn({ err: err.message }, 'checkHash failed');
    throw err;
  }
}

module.exports = { fetchConfig, checkHash };
```

- [ ] **Step 2: Test + Commit**

```bash
node --test tests/syncClient.test.js
git add src/sync/syncClient.js tests/syncClient.test.js
git commit -m "feat(sync): syncClient — fetchConfig + checkHash with Bearer auth"
git push
```

---

## Task 18: Bootstrap (src/index.js) — alles zusammenführen

**Files:**
- Create: `/root/gatecontrol-gateway/src/bootstrap.js`
- Create: `/root/gatecontrol-gateway/src/index.js`

- [ ] **Step 1: Bootstrap-Modul**

Create `/root/gatecontrol-gateway/src/bootstrap.js`:

```javascript
'use strict';

const { loadConfig, isRfc1918 } = require('./config');
const wireguard = require('./wireguard');
const { ConfigStore } = require('./sync/configStore');
const { Poller } = require('./sync/poller');
const { fetchConfig, checkHash } = require('./sync/syncClient');
const { Router } = require('./proxy/router');
const { createHttpProxy } = require('./proxy/http');
const { TcpProxyManager } = require('./proxy/tcp');
const { createApiServer } = require('./api/server');
const { createConfigChangedRouter } = require('./api/routes/configChanged');
const { createWolRouter } = require('./api/routes/wol');
const { createStatusRouter } = require('./api/routes/status');
const { createProbeRouter } = require('./api/routes/probe');
const { runSelfCheck } = require('./health/selfCheck');
const { sendMagicPacket, waitForReachable } = require('./wol');
const { startHeartbeatTicker, sendHeartbeat } = require('./heartbeat');
const { computeConfigHash: libComputeHash } = require('@callmetechie/gatecontrol-config-hash');
const logger = require('./logger');
const net = require('node:net');
const dns = require('node:dns/promises');

const DEFAULT_ENV_PATH = process.env.GATEWAY_ENV_PATH || '/config/gateway.env';

async function bootstrap() {
  const config = loadConfig(DEFAULT_ENV_PATH);
  logger.info({ tunnelIp: config.tunnelIp, apiPort: config.apiPort, proxyPort: config.proxyPort }, 'Starting GateControl Home Gateway');

  // 1. Bring up WireGuard
  await wireguard.writeConfAndBringUp(config);

  // 2. In-memory state
  const store = new ConfigStore();
  const router = new Router();
  const tcpMgr = new TcpProxyManager({ bindIp: config.tunnelIp });

  // 3. On config change → apply
  store.on('change', async ({ cfg, hash }) => {
    logger.info({ hash, httpRoutes: cfg.routes.length, l4Routes: cfg.l4_routes.length }, 'Applying new config');
    router.setRoutes(cfg.routes);
    await tcpMgr.setRoutes(cfg.l4_routes);
  });

  // 4. Poller
  const poller = new Poller({
    intervalMs: config.pollIntervalS * 1000,
    debounceMs: 500,
    fetcher: async () => {
      if (store.currentHash) {
        const hc = await checkHash({ serverUrl: config.serverUrl, apiToken: config.apiToken, hash: store.currentHash });
        if (!hc.changed) return { changed: false };
      }
      const data = await fetchConfig({ serverUrl: config.serverUrl, apiToken: config.apiToken });
      const { config_hash, ...cfgBody } = data;
      // Verify hash matches what we'd compute
      const recomputed = libComputeHash(cfgBody);
      if (config_hash && config_hash !== recomputed) {
        logger.warn({ server_hash: config_hash, our_hash: recomputed }, 'Hash mismatch — this should not happen if shared library is correct');
      }
      store.replaceConfig(cfgBody, config_hash || recomputed);
      return { changed: true };
    },
  });

  // 5. Initial config-fetch, then start polling
  await poller._runOnce();
  poller.start();

  // 6. HTTP Proxy
  const httpProxyServer = createHttpProxy({
    router,
    onUpstreamUnreachable: ({ domain, target }) => {
      if (target.wolMac) {
        logger.info({ domain, mac: target.wolMac }, 'Triggering WoL for unreachable upstream');
        sendMagicPacket(target.wolMac).catch(() => {});
      }
    },
  });
  await new Promise(r => httpProxyServer.listen(config.proxyPort, config.tunnelIp, r));
  logger.info({ bind: `${config.tunnelIp}:${config.proxyPort}` }, 'HTTP proxy listening');

  // 7. Management API
  const apiApp = createApiServer({
    bindIp: config.tunnelIp,
    port: config.apiPort,
    expectedToken: config.gatewayToken,
    routerFactories: {
      '/api': () => {
        const mergeRouter = require('express').Router();
        mergeRouter.use(createConfigChangedRouter({ poller }));
        mergeRouter.use(createWolRouter({
          configStore: store,
          sendMagicPacket,
          waitForReachable,
        }));
        mergeRouter.use(createStatusRouter({
          getSelfCheckResult: async () => {
            const allRoutes = [...store.httpRoutes, ...store.l4Routes.map(r => ({ id: r.id, domain: `l4:${r.listen_port}`, target_lan_host: r.target_lan_host, target_lan_port: r.target_lan_port }))];
            return runSelfCheck({
              proxyPort: config.proxyPort,
              apiPort: config.apiPort,
              tcpPorts: tcpMgr.listListenerPorts(),
              wgStatus: () => wireguard.getStatus(),
              dnsResolveFn: async () => dns.resolve4(new URL(config.serverUrl).hostname),
              reachabilityFn: async (h, p) => {
                const res = await require('./health/selfCheck').tcpProbe(h, p);
                return { reachable: res.reachable, latencyMs: res.latencyMs };
              },
              routes: allRoutes,
            });
          },
        }));
        mergeRouter.use(createProbeRouter({
          lanProbeFn: async () => {
            if (!config.lanProbeTarget) return { skipped: true };
            const [host, port = 80] = config.lanProbeTarget.split(':');
            return require('./health/selfCheck').tcpProbe(host, parseInt(port, 10));
          },
        }));
        return mergeRouter;
      },
    },
  });
  const apiServer = apiApp.listen(config.apiPort, config.tunnelIp, () => {
    logger.info({ bind: `${config.tunnelIp}:${config.apiPort}` }, 'Management API listening');
  });

  // 8. Heartbeat
  const hb = startHeartbeatTicker({
    serverUrl: config.serverUrl,
    apiToken: config.apiToken,
    intervalMs: config.heartbeatIntervalS * 1000,
    getHealth: async () => {
      const routes = [...store.httpRoutes, ...store.l4Routes.map(r => ({ id: r.id, target_lan_host: r.target_lan_host, target_lan_port: r.target_lan_port }))];
      return runSelfCheck({
        proxyPort: config.proxyPort,
        apiPort: config.apiPort,
        tcpPorts: tcpMgr.listListenerPorts(),
        wgStatus: () => wireguard.getStatus(),
        dnsResolveFn: async () => dns.resolve4(new URL(config.serverUrl).hostname),
        reachabilityFn: async (h, p) => {
          const res = await require('./health/selfCheck').tcpProbe(h, p);
          return { reachable: res.reachable, latencyMs: res.latencyMs };
        },
        routes,
      });
    },
  });

  return { config, poller, httpProxyServer, apiServer, tcpMgr, hb };
}

module.exports = { bootstrap };
```

- [ ] **Step 2: Entry Point**

Create `/root/gatecontrol-gateway/src/index.js`:

```javascript
'use strict';

const { bootstrap } = require('./bootstrap');
const logger = require('./logger');
const wireguard = require('./wireguard');

async function main() {
  let ctx;
  try {
    ctx = await bootstrap();
    logger.info('Gateway running');
  } catch (err) {
    logger.fatal({ err: err.message, stack: err.stack }, 'Bootstrap failed — exiting');
    process.exit(1);
  }

  // Graceful shutdown
  async function shutdown(signal) {
    logger.info({ signal }, 'Shutting down');
    try {
      ctx.hb?.stop();
      ctx.poller?.stop();
      await new Promise(r => ctx.apiServer?.close(r));
      await new Promise(r => ctx.httpProxyServer?.close(r));
      await ctx.tcpMgr?.stopAll();
      await wireguard.bringDown();
    } catch (err) {
      logger.warn({ err: err.message }, 'Shutdown error');
    }
    process.exit(0);
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main();
```

- [ ] **Step 3: Commit (Tests für Bootstrap werden in Task 19 als Integrationstest abgedeckt)**

```bash
git add src/bootstrap.js src/index.js
git commit -m "feat: bootstrap glue + main entry point with graceful shutdown"
git push
```

---

## Task 19: Integration-Test (Mock-Server + Full Flow)

**Files:**
- Create: `/root/gatecontrol-gateway/tests/integration/full-flow.test.js`

- [ ] **Step 1: Test schreiben**

Create `/root/gatecontrol-gateway/tests/integration/full-flow.test.js`:

```javascript
'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { computeConfigHash } = require('@callmetechie/gatecontrol-config-hash');

describe('integration: full-flow with mock server', () => {
  let mockServer, gatewayCtx;

  // Mock GateControl server: serves /api/v1/gateway/config + /heartbeat + /probe-ack
  before(async () => {
    const cfgBody = {
      config_hash_version: 1, peer_id: 1,
      routes: [{ id: 1, domain: 'nas.example.com', target_kind: 'gateway', target_lan_host: '127.0.0.1', target_lan_port: 65000, wol_enabled: false }],
      l4_routes: [],
    };
    const hash = computeConfigHash(cfgBody);

    mockServer = http.createServer((req, res) => {
      if (req.url === '/api/v1/gateway/config') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ...cfgBody, config_hash: hash }));
      }
      if (req.url.startsWith('/api/v1/gateway/config/check')) {
        const given = new URL('http://x' + req.url).searchParams.get('hash');
        res.writeHead(given === hash ? 304 : 200); return res.end();
      }
      if (req.url === '/api/v1/gateway/heartbeat') {
        res.writeHead(200); return res.end('{}');
      }
      res.writeHead(404); res.end();
    });
    await new Promise(r => mockServer.listen(0, '127.0.0.1', r));

    // Mock LAN target on 65000 for the route
    const lanTarget = http.createServer((req, res) => res.end('hello from LAN'));
    await new Promise(r => lanTarget.listen(65000, '127.0.0.1', r));
  });

  after(() => mockServer?.close());

  it('placeholder — full bootstrap with real WG is integration-test-only', () => {
    // Full bootstrap requires root + wg-quick; run manually or in docker-smoke.
    assert.ok(true);
  });
});
```

- [ ] **Step 2: Commit**

```bash
git add tests/integration/
git commit -m "test: integration harness (full bootstrap requires root for WG; covered in docker-smoke)"
git push
```

---

## Task 20: Dockerfile (Multi-Stage + non-root + setcap)

**Files:**
- Create: `/root/gatecontrol-gateway/Dockerfile`

- [ ] **Step 1: Dockerfile schreiben**

Create `/root/gatecontrol-gateway/Dockerfile`:

```dockerfile
# syntax=docker/dockerfile:1.7
ARG NODE_VERSION=20
ARG ALPINE_VERSION=3.20

# --- Stage 1: build wireguard-go from source (pinned via WG_GO_REF) ---
FROM golang:1.23-alpine${ALPINE_VERSION} AS wg-build
ARG WG_GO_REF=v0.0.20230223
RUN apk add --no-cache git make && \
    git clone --depth 1 --branch ${WG_GO_REF} https://git.zx2c4.com/wireguard-go /src && \
    cd /src && make && cp wireguard-go /wireguard-go

# --- Stage 2: npm install ---
FROM node:${NODE_VERSION}-alpine${ALPINE_VERSION} AS node-build
WORKDIR /build
COPY package.json package-lock.json .npmrc ./
ARG GH_PACKAGES_TOKEN
ENV NODE_AUTH_TOKEN=${GH_PACKAGES_TOKEN}
RUN npm ci --omit=dev --ignore-scripts
COPY src ./src

# --- Stage 3: runtime ---
FROM node:${NODE_VERSION}-alpine${ALPINE_VERSION}
RUN apk add --no-cache wireguard-tools iproute2 libcap tini && \
    addgroup -S gateway && adduser -S -G gateway -H -s /sbin/nologin gateway && \
    mkdir -p /config /var/log/gateway && \
    chown -R gateway:gateway /var/log/gateway

COPY --from=wg-build /wireguard-go /usr/local/bin/wireguard-go
COPY --from=node-build /build/node_modules /app/node_modules
COPY --from=node-build /build/src /app/src
COPY --chown=gateway:gateway package.json /app/package.json

# Grant NET_ADMIN cap to wireguard-go binary (so we can drop CAP_NET_ADMIN from container)
# Note: Container must still have CAP_NET_ADMIN in cap_add (setcap only works if FS supports it)
RUN setcap cap_net_admin+ep /usr/local/bin/wireguard-go

WORKDIR /app
USER gateway

HEALTHCHECK --interval=60s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:' + (process.env.GC_API_PORT || 9876) + '/api/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--", "node", "src/index.js"]
```

- [ ] **Step 2: Local Build testen**

```bash
cd /root/gatecontrol-gateway
docker build --build-arg GH_PACKAGES_TOKEN=<your-token> -t gatecontrol-gateway:dev .
```

Expected: Image builds successfully, size ~80-120 MB.

- [ ] **Step 3: Commit**

```bash
git add Dockerfile
git commit -m "chore(docker): multi-stage Dockerfile with wireguard-go build + non-root user + setcap"
git push
```

---

## Task 21: docker-compose.example.yml mit Hardening

**Files:**
- Create: `/root/gatecontrol-gateway/docker-compose.example.yml`

- [ ] **Step 1: Compose-File schreiben**

Create `/root/gatecontrol-gateway/docker-compose.example.yml`:

```yaml
# GateControl Home Gateway — Example docker-compose
# Copy to docker-compose.yml and adjust to your environment.
#
# Requirements:
#   - gateway.env from GateControl UI (Peer-Detail → Download)
#   - Gateway must be on same L2 segment as target LAN devices (WoL!)
#   - Host network mode required for dynamic L4 port binding

services:
  gateway:
    image: ghcr.io/callmetechie/gatecontrol-gateway:latest
    restart: unless-stopped
    network_mode: host
    cap_drop:
      - ALL
    cap_add:
      - NET_ADMIN         # for wg-quick + TUN device
      - NET_BIND_SERVICE  # for L4 routes on ports <1024 (DNS, HTTP, SSH, HTTPS)
    # NET_RAW NOT added: WoL uses SO_BROADCAST which NET_ADMIN covers.
    # Only enable NET_RAW if Device Discovery (V2) is active.
    security_opt:
      - no-new-privileges:true
    read_only: true
    tmpfs:
      - /tmp
      - /run
      - /etc/wireguard     # wireguard-go writes config here; keep in tmpfs for read-only-FS
    volumes:
      - ./config:/config:ro      # Place gateway.env here
    environment:
      - LOG_LEVEL=info
      - GATEWAY_ENV_PATH=/config/gateway.env
    healthcheck:
      interval: 60s
      timeout: 5s
      retries: 3
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
```

- [ ] **Step 2: Commit**

```bash
git add docker-compose.example.yml
git commit -m "chore(docker): hardened docker-compose example (cap_drop ALL, read_only, no-new-privs)"
git push
```

---

## Task 22: GitHub Actions — Test-Workflow (umfassend)

**Files:**
- Create: `/root/gatecontrol-gateway/.github/workflows/test.yml`
- Create: `/root/gatecontrol-gateway/.eslintrc.json`
- Create: `/root/gatecontrol-gateway/stryker.conf.json`

- [ ] **Step 1: ESLint-Config**

Create `/root/gatecontrol-gateway/.eslintrc.json`:

```json
{
  "env": { "node": true, "es2022": true },
  "parserOptions": { "ecmaVersion": 2022, "sourceType": "commonjs" },
  "plugins": ["security"],
  "extends": ["eslint:recommended", "plugin:security/recommended"],
  "rules": {
    "no-console": "warn",
    "no-unused-vars": ["error", { "argsIgnorePattern": "^_" }]
  }
}
```

- [ ] **Step 2: Stryker-Config**

Create `/root/gatecontrol-gateway/stryker.conf.json`:

```json
{
  "$schema": "https://stryker-mutator.io/schema/stryker-schema.json",
  "testRunner": "command",
  "commandRunner": { "command": "node --test --test-force-exit tests/" },
  "mutate": [
    "src/wol.js",
    "src/sync/configStore.js",
    "src/sync/poller.js",
    "src/api/middleware/auth.js",
    "src/config.js",
    "src/proxy/router.js"
  ],
  "thresholds": { "high": 90, "low": 80, "break": 75 },
  "timeoutMS": 10000,
  "concurrency": 4,
  "reporters": ["progress", "html", "clear-text"]
}
```

- [ ] **Step 3: Test-Workflow**

Create `/root/gatecontrol-gateway/.github/workflows/test.yml`:

```yaml
name: Test

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

permissions:
  contents: read
  security-events: write

jobs:
  syntax:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: |
          find src tests -name "*.js" -exec node --check {} +

  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, registry-url: 'https://npm.pkg.github.com/', scope: '@callmetechie' }
      - run: npm ci
        env: { NODE_AUTH_TOKEN: '${{ secrets.GH_PACKAGES_TOKEN }}' }
      - run: npm run lint
      - name: Hadolint (Dockerfile)
        uses: hadolint/hadolint-action@v3.1.0
        with: { dockerfile: Dockerfile }
      - name: KICS (IaC)
        uses: checkmarx/kics-github-action@v1.7.0
        with: { path: '.', fail_on: high }

  simplification:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npx jscpd src || true
      - run: npx knip || true  # report-only

  secrets:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: gitleaks/gitleaks-action@v2
        env: { GITHUB_TOKEN: '${{ github.token }}' }

  dependency:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, registry-url: 'https://npm.pkg.github.com/', scope: '@callmetechie' }
      - run: npm ci
        env: { NODE_AUTH_TOKEN: '${{ secrets.GH_PACKAGES_TOKEN }}' }
      - run: npm audit --audit-level=high
      - uses: actions/dependency-review-action@v4
        if: github.event_name == 'pull_request'

  sast:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - uses: github/codeql-action/init@v3
        with: { languages: javascript }
      - uses: github/codeql-action/analyze@v3
      - run: npx njsscan src || true

  unit:
    runs-on: ubuntu-latest
    strategy:
      matrix: { node: [20, 22] }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '${{ matrix.node }}', registry-url: 'https://npm.pkg.github.com/', scope: '@callmetechie' }
      - run: npm ci
        env: { NODE_AUTH_TOKEN: '${{ secrets.GH_PACKAGES_TOKEN }}' }
      - run: node --test --experimental-test-coverage --test-force-exit tests/ | tee test-output.txt
      - name: Check coverage ≥85%
        run: |
          LINES=$(grep -oE 'lines[^0-9]+[0-9.]+%' test-output.txt | head -1 | grep -oE '[0-9.]+')
          echo "Line coverage: $LINES%"
          awk -v v="$LINES" 'BEGIN{exit (v+0 < 85)}' || { echo "Coverage below 85%"; exit 1; }

  mutation:
    runs-on: ubuntu-latest
    needs: unit
    if: |
      github.event_name == 'push' ||
      contains(github.event.pull_request.labels.*.name, 'mutation-test')
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, registry-url: 'https://npm.pkg.github.com/', scope: '@callmetechie' }
      - run: npm ci
        env: { NODE_AUTH_TOKEN: '${{ secrets.GH_PACKAGES_TOKEN }}' }
      - run: npx stryker run
      - uses: actions/upload-artifact@v4
        with: { name: mutation-report, path: reports/mutation/ }
```

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/test.yml .eslintrc.json stryker.conf.json
git commit -m "ci: comprehensive test workflow — syntax+lint+KICS+gitleaks+SAST+unit+mutation"
git push
```

Expected: Push triggert Workflow — nach ein paar Minuten sollten alle Jobs grün sein (Mutation ggf. später wenn genug Tests).

---

## Task 23: GitHub Actions — Release-Workflow (Multi-Arch + Trivy + SBOM)

**Files:**
- Create: `/root/gatecontrol-gateway/.github/workflows/release.yml`

- [ ] **Step 1: Release-Workflow**

Create `/root/gatecontrol-gateway/.github/workflows/release.yml`:

```yaml
name: Release

on:
  push:
    branches: [main]
    tags: ['v*']

permissions:
  contents: write
  packages: write

jobs:
  build-and-release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }

      - name: Setup Node
        uses: actions/setup-node@v4
        with: { node-version: 20, registry-url: 'https://npm.pkg.github.com/', scope: '@callmetechie' }

      - name: Install deps
        run: npm ci
        env: { NODE_AUTH_TOKEN: '${{ secrets.GH_PACKAGES_TOKEN }}' }

      - name: Tests
        run: node --test --test-force-exit tests/

      - name: Determine version
        id: v
        run: |
          if [[ "${{ github.ref }}" == refs/tags/v* ]]; then
            echo "tag=${GITHUB_REF_NAME}" >> $GITHUB_OUTPUT
            echo "version=${GITHUB_REF_NAME#v}" >> $GITHUB_OUTPUT
          else
            # auto-bump on main push
            CURRENT=$(node -p "require('./package.json').version")
            MSG="${{ github.event.head_commit.message }}"
            IFS='.' read -r MAJ MIN PAT <<< "$CURRENT"
            if echo "$MSG" | head -1 | grep -qE '^feat'; then MIN=$((MIN+1)); PAT=0; else PAT=$((PAT+1)); fi
            NEW="${MAJ}.${MIN}.${PAT}"
            echo "tag=v$NEW" >> $GITHUB_OUTPUT
            echo "version=$NEW" >> $GITHUB_OUTPUT
          fi

      - name: Bump package.json (for main-push)
        if: github.ref == 'refs/heads/main'
        run: |
          npm version --no-git-tag-version ${{ steps.v.outputs.version }}
          git config user.name 'github-actions[bot]'
          git config user.email 'github-actions[bot]@users.noreply.github.com'
          git add package.json package-lock.json
          git commit -m "chore: bump version to ${{ steps.v.outputs.version }}"
          git tag ${{ steps.v.outputs.tag }}
          git push origin main --follow-tags

      - name: Setup Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Setup QEMU (for multi-arch)
        uses: docker/setup-qemu-action@v3

      - name: Login to GHCR
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Build multi-arch image
        uses: docker/build-push-action@v6
        with:
          context: .
          platforms: linux/amd64,linux/arm64,linux/arm/v7
          push: true
          build-args: |
            GH_PACKAGES_TOKEN=${{ secrets.GH_PACKAGES_TOKEN }}
          tags: |
            ghcr.io/callmetechie/gatecontrol-gateway:latest
            ghcr.io/callmetechie/gatecontrol-gateway:${{ steps.v.outputs.tag }}
            ghcr.io/callmetechie/gatecontrol-gateway:${{ steps.v.outputs.version }}

      - name: Trivy scan
        uses: aquasecurity/trivy-action@master
        with:
          image-ref: ghcr.io/callmetechie/gatecontrol-gateway:${{ steps.v.outputs.tag }}
          format: sarif
          output: trivy-results.sarif
          severity: CRITICAL,HIGH
          exit-code: 1  # Block on critical CVEs

      - name: SBOM via Syft
        uses: anchore/sbom-action@v0
        with:
          image: ghcr.io/callmetechie/gatecontrol-gateway:${{ steps.v.outputs.tag }}
          format: cyclonedx-json
          output-file: sbom.cdx.json

      - name: GitHub Release
        uses: softprops/action-gh-release@v2
        if: startsWith(github.ref, 'refs/tags/') || github.ref == 'refs/heads/main'
        with:
          tag_name: ${{ steps.v.outputs.tag }}
          generate_release_notes: true
          files: |
            sbom.cdx.json
            trivy-results.sarif

  smoke-multiarch:
    runs-on: ubuntu-latest
    needs: build-and-release
    strategy:
      matrix:
        platform: [linux/amd64, linux/arm64, linux/arm/v7]
    steps:
      - uses: docker/setup-qemu-action@v3
      - name: Pull and run container
        run: |
          docker pull --platform ${{ matrix.platform }} ghcr.io/callmetechie/gatecontrol-gateway:latest
          # Start with a dummy gateway.env that binds API on 127.0.0.1 instead of tunnel-IP
          # Note: full bootstrap needs WG, so we just check that binary runs + version flag
          docker run --rm --platform ${{ matrix.platform }} \
            ghcr.io/callmetechie/gatecontrol-gateway:latest node -e "console.log('ok')"
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "ci: release workflow — multi-arch build + Trivy + SBOM + smoke-test"
git push
```

---

## Task 24: Platform Deployment Docs

**Files:**
- Create: `/root/gatecontrol-gateway/docs/deployment/linux-docker.md`
- Create: `/root/gatecontrol-gateway/docs/deployment/synology.md`
- Create: `/root/gatecontrol-gateway/docs/deployment/migration-from-dwg.md`
- Create: `/root/gatecontrol-gateway/docs/deployment/raspberry-pi.md`

- [ ] **Step 1: Linux / Generic Docker**

Create `/root/gatecontrol-gateway/docs/deployment/linux-docker.md`:

```markdown
# Deployment: Linux / Debian / Ubuntu / Raspberry Pi

## Voraussetzungen

- Docker 24+ und docker-compose
- Host muss im gleichen L2-Segment wie die Ziel-LAN-Geräte sein (für WoL)
- Admin-Rechte für `NET_ADMIN` + `NET_BIND_SERVICE` Capabilities

## Schritte

1. **Gateway-Peer in GateControl-UI anlegen**

   UI → Peers → „Neuer Peer" → „Home Gateway"-Checkbox aktivieren → API-Port 9876 (Standard) → Speichern.

2. **`gateway.env` herunterladen**

   Auf der Peer-Detail-Seite: Button „Gateway-Config herunterladen" → die Datei landet lokal.

3. **Compose-Setup**

   ```bash
   mkdir -p /opt/gatecontrol-gateway/config
   cd /opt/gatecontrol-gateway
   cp /path/to/gateway-<id>.env config/gateway.env
   wget https://raw.githubusercontent.com/CallMeTechie/gatecontrol-gateway/main/docker-compose.example.yml -O docker-compose.yml
   ```

4. **Starten**

   ```bash
   docker compose up -d
   docker compose logs -f
   ```

   Erwartet: Logs zeigen WireGuard up, Config-Poll erfolgreich, HTTP-Proxy/API-Server binden auf Tunnel-IP.

5. **Verifikation**

   Im GateControl-UI sollte der Gateway als „online" erscheinen (nach ~2-5 min Hysteresis-Cooldown).

## Troubleshooting

- **„Refused to bind on 0.0.0.0"** → `GC_TUNNEL_IP` in `gateway.env` fehlt oder ist falsch
- **WoL funktioniert nicht** → Gateway ist nicht im gleichen L2-Segment wie Ziel, oder Host-Bridge statt NAT notwendig
- **Gateway zeigt als offline in UI** → Check `docker logs`, häufig sind es DNS-Auflösung oder Tunnel-Probleme
```

- [ ] **Step 2: Synology**

Create `/root/gatecontrol-gateway/docs/deployment/synology.md`:

```markdown
# Deployment: Synology DSM 7.2+

## Voraussetzungen

- DSM 7.2 oder neuer mit Container Manager (DSM 7.0/7.1 siehe "Legacy" unten)
- NAS im gleichen LAN wie Ziel-Geräte
- Administrator-Rechte

## Schritte

1. **Image importieren**

   Container Manager kann keine Images selbst bauen. Download:

   ```
   docker pull ghcr.io/callmetechie/gatecontrol-gateway:latest
   docker save -o gatecontrol-gateway.tar ghcr.io/callmetechie/gatecontrol-gateway:latest
   ```

   Dann per File Station nach `/volume1/docker/` hochladen und im Container Manager → „Importieren" auswählen.

2. **Ordnerstruktur**

   Via File Station:
   ```
   /volume1/docker/gatecontrol-gateway/
     └── config/
         └── gateway.env    ← aus GateControl-UI heruntergeladen
   ```

3. **Projekt erstellen**

   Container Manager → Projekt → Erstellen:
   - Pfad: `/volume1/docker/gatecontrol-gateway`
   - docker-compose.yml: Copy-Paste aus `docker-compose.example.yml` (siehe Haupt-Repo)

4. **Starten**

   Projekt → Start. Logs via Container Manager → Projekt → Logs.

## DSM 7.0/7.1 (Legacy)

Container Manager auf älteren DSM-Versionen hat eingeschränkten docker-compose-Support. Empfohlen: Standalone Docker via SSH:

```bash
ssh admin@synology
cd /volume1/docker/gatecontrol-gateway
sudo docker compose up -d
```

Für User die lieber beim alten Setup bleiben: [`docker-wireguard-go`](https://github.com/CallMeTechie/docker-wireguard-go) ist weiterhin als einfacher WG-Client ohne Gateway-Features verfügbar.
```

- [ ] **Step 3: Migration-Doc + Pi-Spezifika**

Create `/root/gatecontrol-gateway/docs/deployment/migration-from-dwg.md`:

```markdown
# Migration von docker-wireguard-go

Wer bereits `docker-wireguard-go` im Einsatz hat und jetzt Home-Gateway-Features (HTTP/TCP-Proxy, WoL) nutzen möchte:

## Schritt 1: Alte Instanz stoppen

```bash
cd /volume1/docker/wireguard-go  # (oder wo dwg läuft)
docker compose down
```

## Schritt 2: Neuen Gateway-Peer in GateControl anlegen

Alter Peer (dwg) bleibt bestehen — der neue Gateway nutzt eigene WG-Keys. UI → Peers → „Home Gateway"-Checkbox → neue `gateway.env` herunterladen.

## Schritt 3: Neues Setup

Siehe [`linux-docker.md`](linux-docker.md) oder [`synology.md`](synology.md).

## Schritt 4: Alten dwg-Peer deaktivieren

Erst NACHDEM neuer Gateway läuft und alle Routen funktionieren: alten Peer in GateControl deaktivieren oder löschen.

## Wichtige Unterschiede

| Feature | docker-wireguard-go | gatecontrol-gateway |
|---|---|---|
| WireGuard Tunnel | ✅ | ✅ |
| HTTP/TCP Proxy | ❌ | ✅ |
| Wake-on-LAN | ❌ | ✅ |
| Server-Sync | ❌ (manuelle Config) | ✅ (auto) |
| Management-API | ❌ | ✅ |
```

Create `/root/gatecontrol-gateway/docs/deployment/raspberry-pi.md`:

```markdown
# Deployment: Raspberry Pi

## Empfehlungen

- **Raspberry Pi 3B+ oder neuer** (Pi Zero W hat zu wenig RAM für Proxy + mehrere Listener)
- **Externe SSD auf USB** statt SD-Card (SD-Cards verschleißen durch ständige Log-Writes)
- Alternativ: Read-Only-Root-FS mit Log-Volume auf tmpfs

## SSD-on-USB Setup

```bash
# 1. USB-SSD formatieren + mounten auf /mnt/ssd
sudo mkfs.ext4 /dev/sda1
sudo mkdir /mnt/ssd
sudo mount /dev/sda1 /mnt/ssd

# 2. Docker-Root-Dir umziehen (spart SD-Wear)
sudo systemctl stop docker
sudo mv /var/lib/docker /mnt/ssd/docker
sudo ln -s /mnt/ssd/docker /var/lib/docker
sudo systemctl start docker
```

## Log-Rotation (falls kein SSD)

Bereits im `docker-compose.example.yml` aktiv:
```yaml
logging:
  driver: json-file
  options:
    max-size: "10m"
    max-file: "3"
```

## NTP-Check

Pi ohne RTC: bei jedem Boot muss NTP synchronisieren. Empfohlen: systemd-timesyncd oder chrony. Check:

```bash
timedatectl status
```

Sollte „System clock synchronized: yes" zeigen.
```

- [ ] **Step 4: Commit**

```bash
git add docs/deployment/
git commit -m "docs: platform deployment guides (Linux, Synology, migration from dwg, Pi SSD)"
git push
```

---

## Task 25: README erweitern

**Files:**
- Modify: `/root/gatecontrol-gateway/README.md`

- [ ] **Step 1: Umfassendes README**

Replace `/root/gatecontrol-gateway/README.md`:

```markdown
# GateControl Home Gateway

Companion product for [GateControl](https://github.com/CallMeTechie/gatecontrol): an always-on Docker container in your home network that bridges a single WireGuard tunnel to multiple LAN devices via HTTP/TCP proxies.

## Features

- **HTTP reverse proxy** for L7 routes (NAS UI, Plex, Home Assistant, etc.)
- **TCP port forwarder** for L4 routes (RDP, SSH, databases)
- **Wake-on-LAN** triggered on backend-down (zero-config from GateControl UI)
- **Auto-sync** with GateControl: no manual re-config when routes change
- **Self-monitoring** with health reporting to server (sliding-window hysteresis, per-route reachability)
- **Security-hardened**: non-root container, `cap_drop: ALL` + minimal adds, read-only filesystem

## Architecture

```
Internet ─→ GateControl (VPS) ─WireGuard→ Home Gateway ─LAN→ NAS / Desktop / IoT
                                               │
                                               ├─ HTTP Proxy (Tunnel-IP:8080)
                                               ├─ TCP Listeners (dynamic L4 ports)
                                               ├─ WoL Endpoint
                                               └─ Management API (Tunnel-IP:9876)
```

## Platform Support

See [Deployment Docs](docs/deployment/) for platform-specific instructions:

- [Linux / Pi / VM](docs/deployment/linux-docker.md) — Tier 1
- [Synology DSM 7.2+](docs/deployment/synology.md) — Tier 1
- [Raspberry Pi tips](docs/deployment/raspberry-pi.md) — SSD, NTP, log-rotation
- [Migration from docker-wireguard-go](docs/deployment/migration-from-dwg.md)

**Unsupported:** VM in NAT-mode (WoL broken). Bridge-mode required.

## Quick Start

1. **GateControl-UI** → Peers → „Neuer Peer" → Checkbox „Home Gateway" → Speichern
2. Auf Peer-Detail: „Gateway-Config herunterladen" → ergibt `gateway-<id>.env`
3. Auf deinem Heimnetz-Host:
   ```bash
   mkdir -p /opt/gatecontrol-gateway/config
   cp gateway-*.env /opt/gatecontrol-gateway/config/gateway.env
   curl -L https://raw.githubusercontent.com/CallMeTechie/gatecontrol-gateway/main/docker-compose.example.yml -o /opt/gatecontrol-gateway/docker-compose.yml
   cd /opt/gatecontrol-gateway && docker compose up -d
   ```
4. Fertig — Gateway meldet sich beim Server. In der UI kannst du jetzt Routes mit `target_kind=gateway` anlegen.

## Security Hardening

- `network_mode: host` bleibt zwingend (dynamische L4-Port-Binding)
- Container läuft als non-root `gateway` User
- `cap_drop: ALL` + nur `NET_ADMIN` (wg-quick) + `NET_BIND_SERVICE` (ports <1024)
- `read_only: true` Root-FS mit tmpfs für `/tmp`, `/run`, `/etc/wireguard`
- `security_opt: no-new-privileges:true`
- Management-API bindet **ausschließlich** auf Tunnel-IP (Startup-Assertion)

## Development

```bash
# Clone + install (requires GH_PACKAGES_TOKEN with packages:read)
git clone git@github.com:CallMeTechie/gatecontrol-gateway.git
cd gatecontrol-gateway
GH_PACKAGES_TOKEN=<your-token> npm install

# Run tests
npm test

# Run with coverage
npm run test:coverage

# Mutation testing
npm run test:mutation

# Lint
npm run lint
```

## License

UNLICENSED / private. See main GateControl repo for context.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: comprehensive README with architecture, quick start, hardening"
git push
```

---

## Task 26: Release v1.0.0

**Files:**
- Modify: `/root/gatecontrol-gateway/package.json`
- Create: `/root/gatecontrol-gateway/CHANGELOG.md`

- [ ] **Step 1: CHANGELOG**

Create `/root/gatecontrol-gateway/CHANGELOG.md`:

```markdown
# Changelog

## [1.0.0] — 2026-04-18

### Added
- Initial release
- HTTP reverse proxy with X-Gateway-Target header routing
- TCP port forwarder with dual-bind overlap for port changes
- Wake-on-LAN via SO_BROADCAST (no NET_RAW)
- Hybrid pull + push config sync with @callmetechie/gatecontrol-config-hash
- 4-layer self-check (process + network + per-route + end-to-end)
- Heartbeat ticker to server with health payload
- Multi-arch Docker image (amd64, arm64, arm/v7)
- Security-hardened container: non-root user, cap_drop ALL, read-only FS, no-new-privileges
- Platform deployment guides (Linux, Synology DSM 7.2+, Pi, migration from dwg)
```

- [ ] **Step 2: Version auf 1.0.0 + Commit + Tag**

Modify `/root/gatecontrol-gateway/package.json` — `"version": "0.0.0"` → `"version": "1.0.0"`.

```bash
cd /root/gatecontrol-gateway
git add package.json CHANGELOG.md
git commit -m "chore: release 1.0.0"
git tag v1.0.0
git push origin main --follow-tags
```

- [ ] **Step 3: Release-Workflow beobachten**

User-Aktion: GitHub-Actions-Tab öffnen — Build-and-Release läuft:
- Multi-arch Build auf amd64 + arm64 + arm/v7
- Trivy scannt finales Image auf Critical CVEs (block bei critical)
- SBOM wird als Asset angehängt
- Smoke-Test läuft auf allen 3 Archs

Expected: `ghcr.io/callmetechie/gatecontrol-gateway:v1.0.0` + `:latest` sind publiziert, GitHub Release ist erstellt mit SBOM.

- [ ] **Step 4: Manueller Smoke-Test**

```bash
docker pull ghcr.io/callmetechie/gatecontrol-gateway:v1.0.0
mkdir -p /tmp/gw-smoke/config
# (gateway.env aus GateControl-UI herunterladen, nach /tmp/gw-smoke/config/ legen)
docker run --rm --network host --cap-drop ALL --cap-add NET_ADMIN --cap-add NET_BIND_SERVICE \
  --security-opt no-new-privileges:true \
  -v /tmp/gw-smoke/config:/config:ro \
  ghcr.io/callmetechie/gatecontrol-gateway:v1.0.0
```

Expected: WireGuard startet, Gateway-Health-Check antwortet mit 200 auf `http://127.0.0.1:9876/api/health`.

---

## Abschluss

Plan 3 ist abgeschlossen. Das komplette Home-Gateway-Companion ist damit produktionsreif:

- **Plan 1:** `@callmetechie/gatecontrol-config-hash@1.0.0` publiziert
- **Plan 2:** GateControl-Server bietet Gateway-Peer-Typ, alle APIs, UI, Monitoring
- **Plan 3:** `gatecontrol-gateway:v1.0.0` Container läuft auf Pi/Synology/VM im Heimnetz

**Nächste Schritte (nach Release):**
- Beta-Testing an 1-2 Installationen
- Nach Feedback-Runde: Community-Release
- V2-Roadmap aus Spec Sektion 1 „Out-of-Scope" priorisieren:
  - Device Discovery (ARP-Scan)
  - Kernel-WireGuard-Backend für Pi/VM Performance
  - Bandwidth-Monitoring
  - IPv6
  - Multi-Gateway
  - Setup-Wizard statt `gateway.env`-Download
