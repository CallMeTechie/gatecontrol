'use strict';

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

// Ensure tests have a migrated DB — buildCaddyConfig() does DB lookups even
// when given explicit `routes` (e.g. getAuthForRoute, getAclPeers).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-cc-gw-'));
process.env.GC_DB_PATH = path.join(tmp, 'test.db');
process.env.GC_DATA_DIR = tmp;

let buildCaddyConfig;

before(() => {
  require('../src/db/migrations').runMigrations();
  buildCaddyConfig = require('../src/services/caddyConfig').buildCaddyConfig;
});

describe('caddyConfig: gateway-typed routes', () => {
  it('route with target_kind=gateway routes to gateway-peer-ip + proxy port + headers', () => {
    const routes = [{
      id: 1, domain: 'nas.example.com',
      route_type: 'http',
      target_kind: 'gateway',
      target_peer_ip: '10.8.0.5',      // gateway-peer's wg-IP
      target_lan_host: '192.168.1.10',
      target_lan_port: 5001,
      target_port: 8080,
      enabled: 1,
      https_enabled: 1,
    }];
    const config = buildCaddyConfig(routes, { gatewayProxyPort: 8080 });

    const json = JSON.stringify(config);
    assert.ok(json.includes('10.8.0.5:8080'), 'upstream should be gateway-tunnel-IP:proxy-port');
    assert.ok(json.includes('X-Gateway-Target'), 'header should be injected');
    assert.ok(json.includes('192.168.1.10:5001'), 'LAN target should appear in X-Gateway-Target header');
    assert.ok(json.includes('X-Gateway-Target-Domain'), 'domain header should be injected');
  });

  it('route with target_kind=peer (legacy) routes directly to target_ip', () => {
    const routes = [{
      id: 2, domain: 'direct.example.com',
      route_type: 'http',
      target_kind: 'peer',
      target_ip: '10.8.0.7',
      target_port: 80,
      enabled: 1,
      https_enabled: 1,
    }];
    const config = buildCaddyConfig(routes);
    const json = JSON.stringify(config);
    assert.ok(json.includes('10.8.0.7:80'));
    assert.ok(!json.includes('X-Gateway-Target'));
  });

  it('L4 gateway route forwards to gateway-peer-ip:listen_port (not the 127.0.0.1 placeholder)', () => {
    // Previously buildL4Route built `target = target_ip + ':' + target_port`
    // which for gateway routes was '127.0.0.1:<placeholder>' — Caddy L4
    // then forwarded to its own loopback and the route silently dropped.
    // Fix: gateway-typed L4 routes must target <gateway-peer-tunnel-ip>:
    // <l4_listen_port>, since the gateway's TcpProxyManager binds that
    // port on the tunnel IP and forwards on to the LAN.
    const routes = [{
      id: 10, route_type: 'l4', target_kind: 'gateway',
      l4_protocol: 'tcp', l4_listen_port: '3389', l4_tls_mode: 'none',
      target_peer_allowed_ips: '10.8.0.5/32',
      target_lan_host: '192.168.2.100', target_lan_port: 3389,
      target_ip: '127.0.0.1', target_port: 0,  // legacy placeholder fields
      enabled: 1,
    }];
    const config = buildCaddyConfig(routes);
    const json = JSON.stringify(config);
    assert.ok(json.includes('10.8.0.5:3389'), 'upstream should be gateway-tunnel-IP:l4_listen_port');
    assert.ok(!json.includes('127.0.0.1:0'), 'placeholder target_ip must not leak into the Caddy L4 config');
  });

  it('gateway-typed HTTP route gets @id field for Admin-API patches', () => {
    const routes = [{
      id: 1, domain: 'nas.example.com', route_type: 'http', target_kind: 'gateway',
      target_peer_ip: '10.8.0.5', target_lan_host: '192.168.1.10', target_lan_port: 5001,
      target_port: 8080,
      enabled: 1, https_enabled: 1,
    }];
    const config = buildCaddyConfig(routes, { gatewayProxyPort: 8080 });
    const json = JSON.stringify(config);
    assert.ok(json.includes('gc_route_1'), '@id gc_route_<id> must be present for Admin-API /id lookup');
  });
});
