'use strict';

// caddyConfig contract for HSTS (docs/feature-hsts.md): the header lands in
// reverse_proxy.headers.response.set for HTTPS HTTP routes with the switch on;
// never without HTTPS, never for L4, never on the gateway-offline maintenance
// page; a custom header of the same name is replaced, other custom headers stay.

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-hsts-caddy-'));
process.env.GC_DB_PATH = path.join(tmp, 'test.db');
process.env.GC_DATA_DIR = tmp;

const HSTS = 'Strict-Transport-Security';
let buildCaddyConfig;

before(() => {
  require('../src/db/migrations').runMigrations();
  buildCaddyConfig = require('../src/services/caddyConfig').buildCaddyConfig;
});

function httpRoute(over = {}) {
  return {
    id: 1, domain: 'a.example.com', route_type: 'http',
    target_kind: 'peer', target_ip: '10.8.0.7', target_port: 80,
    enabled: 1, https_enabled: 1,
    hsts_enabled: 1, hsts_max_age: 31536000, hsts_subdomains: 0, hsts_preload: 0,
    ...over,
  };
}

// The route's terminal handler: walks the host-matched route down to the
// reverse_proxy (or static_response) handler.
function terminalHandler(cfg, host) {
  const server = Object.values(cfg.apps.http.servers).find((s) => (s.routes || []).some((r) => r.match?.[0]?.host?.[0] === host));
  assert.ok(server, 'server for ' + host);
  // Skip the HTTP→HTTPS redirect route (§0 of feature-security-options): it
  // matches every HTTPS host first but is not the route's handler chain.
  const route = server.routes.find((r) => r['@id'] !== 'gc_https_redirect' && r.match?.[0]?.host?.[0] === host);
  const stack = [...route.handle];
  let last = null;
  while (stack.length) {
    const h = stack.shift();
    if (h.handler === 'subroute') stack.unshift(...(h.routes || []).flatMap((r) => r.handle || []));
    else last = h;
  }
  return last;
}

const stsOf = (h) => h.headers?.response?.set?.[HSTS];

describe('caddyConfig contract: HSTS', () => {
  it('sets max-age only', () => {
    const h = terminalHandler(buildCaddyConfig([httpRoute()]), 'a.example.com');
    assert.equal(h.handler, 'reverse_proxy');
    assert.deepEqual(stsOf(h), ['max-age=31536000']);
  });

  it('sets includeSubDomains', () => {
    const h = terminalHandler(buildCaddyConfig([httpRoute({ hsts_subdomains: 1 })]), 'a.example.com');
    assert.deepEqual(stsOf(h), ['max-age=31536000; includeSubDomains']);
  });

  it('sets includeSubDomains and preload', () => {
    const h = terminalHandler(buildCaddyConfig([httpRoute({ hsts_max_age: 63072000, hsts_subdomains: 1, hsts_preload: 1 })]), 'a.example.com');
    assert.deepEqual(stsOf(h), ['max-age=63072000; includeSubDomains; preload']);
  });

  it('no header when the switch is off', () => {
    const h = terminalHandler(buildCaddyConfig([httpRoute({ hsts_enabled: 0 })]), 'a.example.com');
    assert.equal(h.handler, 'reverse_proxy');
    assert.equal(stsOf(h), undefined);
  });

  it('no header without https_enabled', () => {
    const h = terminalHandler(buildCaddyConfig([httpRoute({ https_enabled: 0 })]), 'a.example.com');
    assert.equal(h.handler, 'reverse_proxy');
    assert.equal(stsOf(h), undefined);
  });

  it('no header for L4 routes', () => {
    const cfg = buildCaddyConfig([{
      id: 10, route_type: 'l4', target_kind: 'peer', domain: 'l4.example.com',
      l4_protocol: 'tcp', l4_listen_port: '5022', l4_tls_mode: 'none',
      target_ip: '10.8.0.7', target_port: 22, enabled: 1,
      hsts_enabled: 1, hsts_max_age: 31536000, hsts_subdomains: 1, hsts_preload: 0,
    }]);
    assert.ok(cfg.apps.layer4, 'layer4 app present');
    assert.ok(!JSON.stringify(cfg).includes(HSTS), 'no HSTS anywhere in the config');
  });

  it('no header on the gateway-offline maintenance page (static_response)', () => {
    const cfg = buildCaddyConfig([httpRoute({
      target_kind: 'gateway', target_peer_id: 42, target_peer_allowed_ips: '10.8.0.42/32',
      target_lan_host: '192.168.1.10', target_lan_port: 80, gateway_offline: 1, gateway_name: 'Home',
    })]);
    const h = terminalHandler(cfg, 'a.example.com');
    assert.equal(h.handler, 'static_response');
    assert.equal(h.status_code, 502);
    assert.equal(stsOf(h), undefined);
    assert.ok(!JSON.stringify(cfg).includes(HSTS));
  });

  it('replaces a custom Strict-Transport-Security header and keeps the other custom headers', () => {
    const custom = JSON.stringify({
      response: [
        { name: 'strict-transport-security', value: 'max-age=1' },
        { name: 'X-Frame-Options', value: 'DENY' },
      ],
    });
    const h = terminalHandler(buildCaddyConfig([httpRoute({ custom_headers: custom, hsts_subdomains: 1 })]), 'a.example.com');
    assert.deepEqual(h.headers.response.set, {
      'X-Frame-Options': ['DENY'],
      [HSTS]: ['max-age=31536000; includeSubDomains'],
    });
    assert.equal(Object.keys(h.headers.response.set).filter((k) => k.toLowerCase() === HSTS.toLowerCase()).length, 1, 'exactly one STS key');
  });

  it('with the switch off the custom Strict-Transport-Security header still applies', () => {
    const custom = JSON.stringify({ response: [{ name: HSTS, value: 'max-age=1' }] });
    const h = terminalHandler(buildCaddyConfig([httpRoute({ hsts_enabled: 0, custom_headers: custom })]), 'a.example.com');
    assert.deepEqual(stsOf(h), ['max-age=1']);
  });

  it('keeps the gateway request-header block when adding HSTS', () => {
    const cfg = buildCaddyConfig([httpRoute({
      target_kind: 'gateway', target_peer_id: 42, target_peer_allowed_ips: '10.8.0.42/32',
      target_lan_host: '192.168.1.10', target_lan_port: 80,
    })]);
    const h = terminalHandler(cfg, 'a.example.com');
    assert.equal(h.handler, 'reverse_proxy');
    assert.deepEqual(stsOf(h), ['max-age=31536000']);
    assert.deepEqual(h.headers.request.set['X-Gateway-Target'], ['192.168.1.10:80']);
  });
});
