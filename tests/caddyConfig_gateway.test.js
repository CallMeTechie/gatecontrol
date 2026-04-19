'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const { buildCaddyConfig } = require('../src/services/caddyConfig');

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
