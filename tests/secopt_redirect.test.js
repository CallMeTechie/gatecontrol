'use strict';

// caddyConfig contract for the HTTP→HTTPS redirect route
// (docs/feature-security-options.md §0): first route in srv0, matches plain
// HTTP for every host with https_enabled=1 (plus alias FQDNs), excludes the
// ACME challenge path, paused hosts, http-only routes, the portal host and the
// management host unless GC_BASE_URL is https; answers 308 to the same URL.

const { describe, it, before, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
process.env.GC_BASE_URL = 'http://gc.example.com';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-secopt-redirect-'));
process.env.GC_DB_PATH = path.join(tmp, 'test.db');
process.env.GC_DATA_DIR = tmp;

let buildCaddyConfig, db, config;

before(() => {
  require('../src/db/migrations').runMigrations();
  buildCaddyConfig = require('../src/services/caddyConfig').buildCaddyConfig;
  db = require('../src/db/connection').getDb();
  config = require('../config/default');
});

afterEach(() => {
  db.prepare('DELETE FROM tls_status').run();
  config.app.baseUrl = 'http://gc.example.com';
});

function httpRoute(over = {}) {
  return {
    id: 1, domain: 'a.example.com', route_type: 'http',
    target_kind: 'peer', target_ip: '10.8.0.7', target_port: 80,
    enabled: 1, https_enabled: 1,
    ...over,
  };
}

const srv0 = (cfg) => cfg.apps.http.servers.srv0;
const redirectOf = (cfg) => srv0(cfg).routes.find((r) => r['@id'] === 'gc_https_redirect') || null;

describe('caddyConfig contract: HTTP→HTTPS redirect (§0)', () => {
  it('is the first route of srv0 and answers 308 to the same URL over https', () => {
    const cfg = buildCaddyConfig([httpRoute(), httpRoute({ id: 2, domain: 'b.example.com' })]);
    const routes = srv0(cfg).routes;
    assert.equal(routes[0]['@id'], 'gc_https_redirect', 'redirect route first');
    assert.deepEqual(routes[0], {
      '@id': 'gc_https_redirect',
      match: [{
        protocol: 'http',
        host: ['a.example.com', 'b.example.com'],
        not: [{ path: ['/.well-known/acme-challenge/*'] }],
      }],
      handle: [{
        handler: 'static_response',
        status_code: 308,
        headers: { Location: ['https://{http.request.host}{http.request.uri}'] },
      }],
      terminal: true,
    });
    // the host routes still follow, untouched
    assert.ok(routes.some((r) => r['@id'] === 'gc_route_1'));
    assert.ok(routes.some((r) => r['@id'] === 'gc_route_2'));
  });

  it('leaves out routes with https_enabled=0', () => {
    const cfg = buildCaddyConfig([httpRoute(), httpRoute({ id: 2, domain: 'plain.example.com', https_enabled: 0 })]);
    assert.deepEqual(redirectOf(cfg).match[0].host, ['a.example.com']);
  });

  it('leaves out paused hosts (TLS guard)', () => {
    db.prepare("INSERT INTO tls_status (host, state, paused_reason) VALUES ('b.example.com', 'paused', 'preflight')").run();
    const cfg = buildCaddyConfig([httpRoute(), httpRoute({ id: 2, domain: 'b.example.com' })]);
    assert.deepEqual(redirectOf(cfg).match[0].host, ['a.example.com']);
    assert.ok(srv0(cfg).automatic_https.skip.includes('b.example.com'));
  });

  it('is omitted entirely when no host qualifies', () => {
    const cfg = buildCaddyConfig([httpRoute({ https_enabled: 0 })]);
    assert.equal(redirectOf(cfg), null);
    assert.equal(srv0(cfg).routes[0]['@id'], 'gc_route_1');
  });

  it('includes alias FQDNs of hosts whose HTTP entry has HTTPS', () => {
    const cfg = buildCaddyConfig([
      httpRoute({ host_aliases: '["www"]', host_alias_mode: 'redirect' }),
      httpRoute({ id: 2, domain: 'b.example.com', https_enabled: 0, host_aliases: '["www"]' }),
    ]);
    assert.deepEqual(redirectOf(cfg).match[0].host, ['a.example.com', 'www.a.example.com']);
  });

  it('never lists the portal host; lists the management host only for an https GC_BASE_URL', () => {
    let cfg = buildCaddyConfig([httpRoute()]);
    const hosts = redirectOf(cfg).match[0].host;
    assert.ok(!hosts.some((h) => h.startsWith('home.')), 'portal host absent');
    assert.ok(!hosts.includes('gc.example.com'), 'http management host absent');

    config.app.baseUrl = 'https://gc.example.com';
    cfg = buildCaddyConfig([httpRoute()]);
    assert.deepEqual(redirectOf(cfg).match[0].host, ['a.example.com', 'gc.example.com']);
  });

  it('is byte-stable across two builds', () => {
    const routes = [httpRoute(), httpRoute({ id: 2, domain: 'b.example.com' })];
    assert.equal(JSON.stringify(buildCaddyConfig(routes)), JSON.stringify(buildCaddyConfig(routes)));
  });
});
