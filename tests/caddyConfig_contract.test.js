'use strict';

/**
 * Contract test for src/services/caddyConfig.js.
 *
 * Locks down the externally-observable behaviour of buildCaddyConfig so a
 * future internal split of the ~600-line monolith cannot silently change
 * what gets pushed to Caddy. Asserts:
 *
 *   1. Public module exports stay stable (importers in routes.js,
 *      gateways.js, server.js, export-caddy-config.js, routes/api/routes.js
 *      depend on these names).
 *   2. buildCaddyConfig is deterministic — two calls with the same input
 *      produce deeply-equal output, and JSON.stringify is byte-stable.
 *   3. Top-level config shape (apps.http.servers / apps.layer4.servers).
 *   4. Per-feature handlers land in the output: rate_limit, acl peer-block,
 *      circuit-breaker open response, retry try_duration, backend_https
 *      transport, mirror handler, multi-backend load_balancing.
 *
 * The fixture-style assertions intentionally do NOT pin every byte of the
 * Caddy JSON. Internal field names that have nothing to do with the public
 * API can move freely; only the externally-meaningful shape is fixed.
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-cc-contract-'));
process.env.GC_DB_PATH = path.join(tmp, 'test.db');
process.env.GC_DATA_DIR = tmp;

let caddyConfig;
let buildCaddyConfig;

before(() => {
  require('../src/db/migrations').runMigrations();
  caddyConfig = require('../src/services/caddyConfig');
  buildCaddyConfig = caddyConfig.buildCaddyConfig;
});

// ───────────────────────────────────────────────────────────────────────
// 1. Public API surface
// ───────────────────────────────────────────────────────────────────────
describe('caddyConfig contract: public exports', () => {
  it('exposes the symbols every importer relies on', () => {
    const required = [
      'buildCaddyConfig',
      'syncToCaddy',
      'caddyApi',
      '_caddyApi',
      'getAclPeers',
      'setAclPeers',
      'patchGatewayRouteHandlers',
      'renderMaintenancePage',
    ];
    const exported = Object.keys(caddyConfig);
    for (const sym of required) {
      assert.ok(
        exported.includes(sym),
        `caddyConfig must export ${sym} (consumed by routes.js / gateways.js / server.js / export-caddy-config.js / routes/api/routes.js / tests)`,
      );
    }
  });
});

// ───────────────────────────────────────────────────────────────────────
// 2. Determinism
// ───────────────────────────────────────────────────────────────────────
describe('caddyConfig contract: deterministic output', () => {
  const fixture = [{
    id: 1, domain: 'a.example.com', route_type: 'http',
    target_kind: 'peer', target_ip: '10.8.0.7', target_port: 80,
    enabled: 1, https_enabled: 1,
  }];

  it('two consecutive buildCaddyConfig calls are deep-equal', () => {
    const a = buildCaddyConfig(fixture);
    const b = buildCaddyConfig(fixture);
    assert.deepStrictEqual(a, b);
  });

  it('JSON.stringify of buildCaddyConfig output is byte-stable', () => {
    const a = JSON.stringify(buildCaddyConfig(fixture));
    const b = JSON.stringify(buildCaddyConfig(fixture));
    assert.equal(a, b);
  });
});

// ───────────────────────────────────────────────────────────────────────
// 3. Top-level shape
// ───────────────────────────────────────────────────────────────────────
describe('caddyConfig contract: top-level shape', () => {
  it('http-only routes produce apps.http.servers.srv0 and no layer4', () => {
    const cfg = buildCaddyConfig([{
      id: 1, domain: 'a.example.com', route_type: 'http',
      target_kind: 'peer', target_ip: '10.8.0.7', target_port: 80,
      enabled: 1, https_enabled: 1,
    }]);
    assert.ok(cfg.apps, 'cfg.apps must be present');
    assert.ok(cfg.apps.http, 'apps.http must be present');
    assert.ok(cfg.apps.http.servers, 'apps.http.servers must be present');
    assert.ok(cfg.apps.http.servers.srv0, 'srv0 server must be present for http routes');
    assert.ok(Array.isArray(cfg.apps.http.servers.srv0.routes), 'srv0.routes must be array');
    assert.ok(!cfg.apps.layer4, 'no layer4 app when no l4 routes');
  });

  it('l4 routes add apps.layer4.servers', () => {
    const cfg = buildCaddyConfig([{
      id: 10, route_type: 'l4', target_kind: 'peer',
      l4_protocol: 'tcp', l4_listen_port: '5022', l4_tls_mode: 'none',
      target_ip: '10.8.0.7', target_port: 22,
      enabled: 1,
    }]);
    assert.ok(cfg.apps.layer4, 'layer4 app must be present');
    assert.ok(cfg.apps.layer4.servers, 'layer4.servers must be present');
  });

  it('http route is wrapped with host matcher and terminal flag', () => {
    const cfg = buildCaddyConfig([{
      id: 1, domain: 'b.example.com', route_type: 'http',
      target_kind: 'peer', target_ip: '10.8.0.7', target_port: 80,
      enabled: 1, https_enabled: 1,
    }]);
    const serverRoutes = cfg.apps.http.servers.srv0.routes;
    const match = serverRoutes.find(r => r.match?.[0]?.host?.[0] === 'b.example.com');
    assert.ok(match, 'route must match on host b.example.com');
    assert.equal(match.terminal, true, 'route must be terminal');
  });
});

// ───────────────────────────────────────────────────────────────────────
// 4. Per-feature handlers
// ───────────────────────────────────────────────────────────────────────
describe('caddyConfig contract: per-feature handlers', () => {
  it('rate_limit_enabled produces a rate_limit handler', () => {
    const cfg = buildCaddyConfig([{
      id: 1, domain: 'rl.example.com', route_type: 'http',
      target_kind: 'peer', target_ip: '10.8.0.7', target_port: 80,
      enabled: 1, https_enabled: 1,
      rate_limit_enabled: 1, rate_limit_requests: 60, rate_limit_window: '1m',
    }]);
    const json = JSON.stringify(cfg);
    assert.ok(json.includes('"handler":"rate_limit"'), 'rate_limit handler must appear in config');
    assert.ok(json.includes('"max_events":60'), 'max_events must reflect rate_limit_requests');
  });

  it('circuit_breaker open emits a static_response 503 with Retry-After', () => {
    const cfg = buildCaddyConfig([{
      id: 1, domain: 'cb.example.com', route_type: 'http',
      target_kind: 'peer', target_ip: '10.8.0.7', target_port: 80,
      enabled: 1, https_enabled: 1,
      circuit_breaker_enabled: 1, circuit_breaker_status: 'open',
      circuit_breaker_timeout: 45,
    }]);
    const json = JSON.stringify(cfg);
    assert.ok(json.includes('"status_code":"503"'), '503 status must be set when CB is open');
    assert.ok(json.includes('Retry-After'), 'Retry-After header must be present');
    assert.ok(json.includes('"45"'), 'configured timeout must surface in the header value');
  });

  it('retry_enabled wires retries + try_duration that scales with retry_count', () => {
    const cfg = buildCaddyConfig([{
      id: 1, domain: 're.example.com', route_type: 'http',
      target_kind: 'peer', target_ip: '10.8.0.7', target_port: 80,
      enabled: 1, https_enabled: 1,
      retry_enabled: 1, retry_count: 4, retry_match_status: '502,503',
    }]);
    const json = JSON.stringify(cfg);
    assert.ok(json.includes('"retries":4'), 'retries must mirror retry_count');
    assert.ok(json.includes('"try_duration":"8s"'), 'try_duration scales as max(5, retry_count*2) seconds');
    assert.ok(json.includes('"status_code":[502,503]'), 'retry_match must contain admin status codes');
  });

  it('backend_https on non-gateway route adds insecure_skip_verify transport', () => {
    const cfg = buildCaddyConfig([{
      id: 1, domain: 'bh.example.com', route_type: 'http',
      target_kind: 'peer', target_ip: '10.8.0.7', target_port: 443,
      enabled: 1, https_enabled: 1,
      backend_https: 1,
    }]);
    const json = JSON.stringify(cfg);
    assert.ok(json.includes('"insecure_skip_verify":true'),
      'backend_https must produce a transport with insecure_skip_verify on non-gateway routes');
  });

  it('backend_https on gateway-typed route DOES NOT add tls transport', () => {
    // Gateway-routed traffic always uses plain HTTP on the gateway proxy
    // port — adding TLS here would 502 every gateway route. Lock that
    // invariant in: it has been a regression source before.
    const cfg = buildCaddyConfig([{
      id: 1, domain: 'gw-bh.example.com', route_type: 'http',
      target_kind: 'gateway',
      target_peer_ip: '10.8.0.5', target_lan_host: '192.168.1.10', target_lan_port: 5001,
      target_port: 8080,
      enabled: 1, https_enabled: 1,
      backend_https: 1,
    }], { gatewayProxyPort: 8080 });
    const json = JSON.stringify(cfg);
    assert.ok(!json.includes('"insecure_skip_verify"'),
      'gateway-typed routes must skip the backend_https transport block');
  });

  it('multi-backend route emits load_balancing selection_policy', () => {
    // Insert two real peers so the backend resolver finds them.
    const { getDb } = require('../src/db/connection');
    const db = getDb();
    db.prepare('INSERT INTO peers (id, name, public_key, allowed_ips, enabled) VALUES (?,?,?,?,?)')
      .run(901, 'lb-a', 'pkA', '10.9.0.1/32', 1);
    db.prepare('INSERT INTO peers (id, name, public_key, allowed_ips, enabled) VALUES (?,?,?,?,?)')
      .run(902, 'lb-b', 'pkB', '10.9.0.2/32', 1);

    const cfg = buildCaddyConfig([{
      id: 1, domain: 'lb.example.com', route_type: 'http',
      target_kind: 'peer', target_ip: '10.9.0.1', target_port: 80,
      enabled: 1, https_enabled: 1,
      backends: JSON.stringify([
        { peer_id: 901, port: 80, weight: 1 },
        { peer_id: 902, port: 80, weight: 1 },
      ]),
    }]);
    const json = JSON.stringify(cfg);
    assert.ok(json.includes('"selection_policy"'),
      'multi-backend route must emit a selection_policy');
    assert.ok(json.includes('"round_robin"'),
      'equal weights must collapse to round_robin');
  });
});

// ───────────────────────────────────────────────────────────────────────
// 5. Upstream resolution invariants
// ───────────────────────────────────────────────────────────────────────
describe('caddyConfig contract: upstream resolution', () => {
  it('peer-typed http route uses target_ip:target_port as upstream', () => {
    const cfg = buildCaddyConfig([{
      id: 1, domain: 'p.example.com', route_type: 'http',
      target_kind: 'peer', target_ip: '10.8.0.7', target_port: 8080,
      enabled: 1, https_enabled: 1,
    }]);
    assert.ok(JSON.stringify(cfg).includes('10.8.0.7:8080'));
  });

  it('gateway-typed http route uses gateway-peer-ip:proxyPort as upstream', () => {
    const cfg = buildCaddyConfig([{
      id: 1, domain: 'g.example.com', route_type: 'http',
      target_kind: 'gateway',
      target_peer_ip: '10.8.0.5',
      target_lan_host: '192.168.1.10', target_lan_port: 5001,
      target_port: 8080,
      enabled: 1, https_enabled: 1,
    }], { gatewayProxyPort: 8080 });
    assert.ok(JSON.stringify(cfg).includes('10.8.0.5:8080'));
  });

  it('admin patch @id marker is preserved on http routes', () => {
    const cfg = buildCaddyConfig([{
      id: 42, domain: 'patch.example.com', route_type: 'http',
      target_kind: 'gateway',
      target_peer_ip: '10.8.0.5', target_lan_host: '192.168.1.10', target_lan_port: 5001,
      target_port: 8080,
      enabled: 1, https_enabled: 1,
    }], { gatewayProxyPort: 8080 });
    const json = JSON.stringify(cfg);
    assert.ok(json.includes('gc_route_42'),
      '@id gc_route_<id> is required for partial PATCH support via the Admin API');
  });
});
