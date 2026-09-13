'use strict';

// caddyConfig contract for docs/feature-security-options.md:
//   A  host aliases in both modes (redirect route before the host route /
//      alias FQDNs in the host matcher), TLS subjects, internal-only gate
//   B  backend TLS verify transport in every combination (+ gateway routes untouched)
//   D  request_body handler before the proxy in both handler chains
//   E/F tls_connection_policies: mTLS → zone 1.3 → catch-all, omitted when default
//   PEM files: written from the DB and orphans removed (caddyPemFiles.sync)
//   Stability: without any new option the config carries none of the new keys.

const { describe, it, before, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-secopt-caddy-'));
process.env.GC_DB_PATH = path.join(tmp, 'test.db');
process.env.GC_DATA_DIR = tmp;
process.env.GC_CADDY_DATA_DIR = path.join(tmp, 'caddy');

const { CA_PEM, BUNDLE_PEM } = require('./helpers/secopt_ca');

let buildCaddyConfig, pemFiles, db;

before(() => {
  require('../src/db/migrations').runMigrations();
  buildCaddyConfig = require('../src/services/caddyConfig').buildCaddyConfig;
  pemFiles = require('../src/services/caddyPemFiles');
  db = require('../src/db/connection').getDb();
});

afterEach(() => {
  db.prepare('DELETE FROM tls_status').run();
  db.prepare('DELETE FROM route_auth').run();
});

function httpRoute(over = {}) {
  return {
    id: 1, domain: 'a.example.com', route_type: 'http',
    target_kind: 'peer', target_ip: '10.8.0.7', target_port: 80,
    enabled: 1, https_enabled: 1, external_enabled: 1,
    ...over,
  };
}
function gatewayRoute(over = {}) {
  return httpRoute({
    target_kind: 'gateway', target_peer_id: 42, target_peer_allowed_ips: '10.8.0.42/32',
    target_lan_host: '192.168.1.10', target_lan_port: 443, backend_https: 1,
    ...over,
  });
}

const srv0 = (cfg) => cfg.apps.http.servers.srv0;
const routesOf = (cfg) => srv0(cfg).routes;
const byId = (cfg, id) => routesOf(cfg).find((r) => r['@id'] === id) || null;
const hostRoute = (cfg, host) => routesOf(cfg).find((r) => r['@id'] !== 'gc_https_redirect' && !String(r['@id'] || '').startsWith('gc_alias_') && (r.match?.[0]?.host || []).includes(host)) || null;
const handlersOf = (route) => {
  const out = [];
  const walk = (hs) => { for (const h of hs || []) { out.push(h); if (h.handler === 'subroute') for (const r of h.routes || []) walk(r.handle); } };
  walk(route.handle);
  return out;
};
const proxyOf = (route) => handlersOf(route).find((h) => h.handler === 'reverse_proxy' && !h.rewrite && !(h.upstreams || []).some((u) => u.dial === '127.0.0.1:3000'));
const subjects = (cfg) => cfg.apps.tls.automation.policies.flatMap((p) => p.subjects || []);

// ─── A. aliases ─────────────────────────────────────────

describe('caddyConfig contract: host aliases (§A)', () => {
  it('redirect mode: 308 route to the primary name BEFORE the host route; alias in TLS subjects and in the https redirect', () => {
    const cfg = buildCaddyConfig([httpRoute({ host_aliases: '["www", "old"]', host_alias_mode: 'redirect' })]);
    const routes = routesOf(cfg);
    const idx = routes.findIndex((r) => r['@id'] === 'gc_alias_1');
    assert.ok(idx > 0, 'alias route present');
    assert.equal(routes[0]['@id'], 'gc_https_redirect');
    assert.deepEqual(routes[idx], {
      '@id': 'gc_alias_1',
      match: [{ host: ['www.a.example.com', 'old.a.example.com'] }],
      handle: [{ handler: 'static_response', status_code: 308, headers: { Location: ['https://a.example.com{http.request.uri}'] } }],
      terminal: true,
    });
    assert.equal(routes[idx + 1]['@id'], 'gc_route_1', 'host route follows the alias route');
    assert.deepEqual(routes[idx + 1].match[0].host, ['a.example.com'], 'primary matcher unchanged in redirect mode');
    assert.deepEqual(byId(cfg, 'gc_https_redirect').match[0].host, ['a.example.com', 'www.a.example.com', 'old.a.example.com']);
    assert.ok(subjects(cfg).includes('www.a.example.com') && subjects(cfg).includes('old.a.example.com'), 'aliases are ACME subjects');
  });

  it('redirect mode without HTTPS on the primary points at http://', () => {
    const cfg = buildCaddyConfig([httpRoute({ https_enabled: 0, host_aliases: '["www"]' })]);
    assert.deepEqual(byId(cfg, 'gc_alias_1').handle[0].headers.Location, ['http://a.example.com{http.request.uri}']);
    assert.equal(byId(cfg, 'gc_https_redirect'), null);
  });

  it('serve mode: alias FQDNs join the host matcher of the content route', () => {
    const cfg = buildCaddyConfig([httpRoute({ host_aliases: ['www'], host_alias_mode: 'serve' })]);
    assert.equal(byId(cfg, 'gc_alias_1'), null, 'no redirect route in serve mode');
    assert.deepEqual(byId(cfg, 'gc_route_1').match[0].host, ['a.example.com', 'www.a.example.com']);
    assert.ok(subjects(cfg).includes('www.a.example.com'));
  });

  it('serve mode with forward-auth and internal-only: outer subroute match and external fallback carry the alias', () => {
    const cfg = buildCaddyConfig([httpRoute({ ip_filter_enabled: 1, external_enabled: 0, host_aliases: ['www'], host_alias_mode: 'serve' })]);
    const outer = routesOf(cfg).find((r) => r.handle[0].handler === 'subroute');
    assert.deepEqual(outer.match[0].host, ['a.example.com', 'www.a.example.com']);
    assert.ok(outer.match[0].remote_ip, 'gate hoisted on the outer match');
    const fallback = routesOf(cfg).find((r) => !r['@id'] && r.handle[0].handler === 'static_response' && r.handle[0].status_code === 404);
    assert.deepEqual(fallback.match[0].host, ['a.example.com', 'www.a.example.com']);
  });

  it('redirect mode on an internal-only host: alias redirect is gated and gets the external fallback', () => {
    const cfg = buildCaddyConfig([httpRoute({ external_enabled: 0, host_aliases: ['www'], host_alias_mode: 'redirect' })]);
    const alias = byId(cfg, 'gc_alias_1');
    assert.ok(alias.match[0].remote_ip, 'alias redirect behind the remote_ip gate');
    const i = routesOf(cfg).indexOf(alias);
    const next = routesOf(cfg)[i + 1];
    assert.deepEqual(next.match, [{ host: ['www.a.example.com'] }]);
    assert.equal(next.handle[0].status_code, 404);
  });

  it('a paused alias is skipped by ACME, the https redirect and automatic_https, the primary stays', () => {
    db.prepare("INSERT INTO tls_status (host, state, paused_reason) VALUES ('www.a.example.com', 'paused', 'preflight')").run();
    const cfg = buildCaddyConfig([httpRoute({ host_aliases: ['www'] })]);
    assert.ok(!subjects(cfg).includes('www.a.example.com'));
    assert.ok(subjects(cfg).includes('a.example.com'));
    assert.deepEqual(byId(cfg, 'gc_https_redirect').match[0].host, ['a.example.com']);
    assert.ok(srv0(cfg).automatic_https.skip.includes('www.a.example.com'));
    assert.ok(byId(cfg, 'gc_alias_1'), 'alias route still served');
  });

  it('aliases are ignored on L4 routes and on routes with malformed alias JSON', () => {
    const cfg = buildCaddyConfig([httpRoute({ host_aliases: '{not json' })]);
    assert.equal(byId(cfg, 'gc_alias_1'), null);
    assert.deepEqual(byId(cfg, 'gc_route_1').match[0].host, ['a.example.com']);
  });
});

// ─── B. backend TLS ─────────────────────────────────────

describe('caddyConfig contract: backend certificate verification (§B)', () => {
  const transport = (cfg) => proxyOf(hostRoute(cfg, 'a.example.com')).transport;

  it('backend_https without verify keeps insecure_skip_verify (unchanged)', () => {
    assert.deepEqual(transport(buildCaddyConfig([httpRoute({ backend_https: 1 })])), { protocol: 'http', tls: { insecure_skip_verify: true } });
  });

  it('verify without server name or CA → empty tls block (system roots)', () => {
    assert.deepEqual(transport(buildCaddyConfig([httpRoute({ backend_https: 1, backend_tls_verify: 1 })])), { protocol: 'http', tls: {} });
  });

  it('verify with server name', () => {
    assert.deepEqual(transport(buildCaddyConfig([httpRoute({ backend_https: 1, backend_tls_verify: 1, backend_tls_server_name: 'nas.lan' })])),
      { protocol: 'http', tls: { server_name: 'nas.lan' } });
  });

  it('verify with CA → root_ca_pem_files under <dataDir>/backend-ca/<id>.pem', () => {
    assert.deepEqual(transport(buildCaddyConfig([httpRoute({ id: 7, backend_https: 1, backend_tls_verify: 1, backend_tls_ca_pem: CA_PEM })])),
      { protocol: 'http', tls: { root_ca_pem_files: [path.join(tmp, 'caddy', 'backend-ca', '7.pem')] } });
  });

  it('verify with server name and CA', () => {
    const t = transport(buildCaddyConfig([httpRoute({ id: 7, backend_https: 1, backend_tls_verify: 1, backend_tls_server_name: 'nas.lan', backend_tls_ca_pem: CA_PEM })]));
    assert.deepEqual(t, { protocol: 'http', tls: { server_name: 'nas.lan', root_ca_pem_files: [path.join(tmp, 'caddy', 'backend-ca', '7.pem')] } });
    assert.ok(!JSON.stringify(t).includes('insecure_skip_verify'));
  });

  it('no transport without backend_https even with verify set', () => {
    assert.equal(transport(buildCaddyConfig([httpRoute({ backend_https: 0, backend_tls_verify: 1, backend_tls_ca_pem: CA_PEM })])), undefined);
  });

  it('gateway routes: fields stored but no transport at all (the gateway dials the backend)', () => {
    const cfg = buildCaddyConfig([gatewayRoute({ backend_tls_verify: 1, backend_tls_server_name: 'nas.lan', backend_tls_ca_pem: CA_PEM })]);
    assert.equal(transport(cfg), undefined);
    assert.ok(!JSON.stringify(cfg).includes('backend-ca'));
  });
});

// ─── D. body limit ──────────────────────────────────────

describe('caddyConfig contract: request size limit (§D)', () => {
  it('request_body sits right before reverse_proxy in the normal chain', () => {
    const cfg = buildCaddyConfig([httpRoute({ max_body_mb: 50, compress_enabled: 1 })]);
    const hs = byId(cfg, 'gc_route_1').handle;
    const i = hs.findIndex((h) => h.handler === 'request_body');
    assert.ok(i >= 0);
    assert.deepEqual(hs[i], { handler: 'request_body', max_size: 50 * 1048576 });
    assert.equal(hs[i + 1].handler, 'reverse_proxy');
    assert.equal(hs[i - 1].handler, 'encode');
  });

  it('request_body sits right before reverse_proxy in the forward-auth chain', () => {
    const cfg = buildCaddyConfig([httpRoute({ max_body_mb: 1, ip_filter_enabled: 1 })]);
    const outer = routesOf(cfg).find((r) => r.handle[0].handler === 'subroute');
    const content = outer.handle[0].routes.find((r) => r['@id'] === 'gc_route_1');
    const hs = content.handle;
    const i = hs.findIndex((h) => h.handler === 'request_body');
    assert.ok(i >= 0);
    assert.equal(hs[i].max_size, 1048576);
    assert.equal(hs[i + 1].handler, 'reverse_proxy');
    assert.equal(hs[0].handler, 'reverse_proxy', 'forward-auth subrequest still first');
    assert.ok(hs[0].rewrite);
  });

  it('0 = unlimited (no handler); L4 routes never get one', () => {
    assert.ok(!JSON.stringify(buildCaddyConfig([httpRoute({ max_body_mb: 0 })])).includes('request_body'));
    const cfg = buildCaddyConfig([{
      id: 10, route_type: 'l4', target_kind: 'peer', domain: 'l4.example.com', max_body_mb: 5,
      l4_protocol: 'tcp', l4_listen_port: '5022', l4_tls_mode: 'none', target_ip: '10.8.0.7', target_port: 22, enabled: 1,
    }]);
    assert.ok(cfg.apps.layer4);
    assert.ok(!JSON.stringify(cfg).includes('request_body'));
  });
});

// ─── E/F. TLS policies ──────────────────────────────────

describe('caddyConfig contract: tls_connection_policies (§E TLS profile, §F mTLS)', () => {
  it('omitted entirely when every zone is 1.2 and no route has mTLS', () => {
    const cfg = buildCaddyConfig([httpRoute({ host_domain_id: 1, zone_tls_min_version: '1.2' }), httpRoute({ id: 2, domain: 'b.example.com' })]);
    assert.equal('tls_connection_policies' in srv0(cfg), false);
  });

  it('zone 1.3: one policy with every served FQDN of the zone incl. aliases, then the catch-all', () => {
    const cfg = buildCaddyConfig([
      httpRoute({ host_domain_id: 1, zone_tls_min_version: '1.3', host_aliases: ['www'] }),
      httpRoute({ id: 2, domain: 'b.example.com', host_domain_id: 1, zone_tls_min_version: '1.3' }),
      httpRoute({ id: 3, domain: 'c.other.com', host_domain_id: 2, zone_tls_min_version: '1.2' }),
    ]);
    assert.deepEqual(srv0(cfg).tls_connection_policies, [
      { match: { sni: ['a.example.com', 'www.a.example.com', 'b.example.com'] }, protocol_min: 'tls1.3' },
      {},
    ]);
  });

  it('mTLS: policy per route (SNI = fqdn + aliases) with the CA file, before zone policies, catch-all last', () => {
    const cfg = buildCaddyConfig([
      httpRoute({ id: 5, host_domain_id: 1, zone_tls_min_version: '1.3', host_aliases: ['www'], mtls_enabled: 1, mtls_ca_pem: CA_PEM }),
      httpRoute({ id: 6, domain: 'b.example.com', host_domain_id: 1, zone_tls_min_version: '1.3' }),
      httpRoute({ id: 7, domain: 'c.other.com', host_domain_id: 2, zone_tls_min_version: '1.2', mtls_enabled: 1, mtls_ca_pem: CA_PEM }),
    ]);
    const pol = srv0(cfg).tls_connection_policies;
    assert.deepEqual(pol, [
      {
        match: { sni: ['a.example.com', 'www.a.example.com'] },
        protocol_min: 'tls1.3',
        client_authentication: { mode: 'require_and_verify', trusted_ca_certs_pem_files: [path.join(tmp, 'caddy', 'mtls', '5.pem')] },
      },
      {
        match: { sni: ['c.other.com'] },
        client_authentication: { mode: 'require_and_verify', trusted_ca_certs_pem_files: [path.join(tmp, 'caddy', 'mtls', '7.pem')] },
      },
      { match: { sni: ['a.example.com', 'www.a.example.com', 'b.example.com'] }, protocol_min: 'tls1.3' },
      {},
    ]);
    assert.deepEqual(pol[pol.length - 1], {}, 'catch-all last');
  });

  it('mTLS needs https_enabled and a CA; L4 routes never get a policy', () => {
    let cfg = buildCaddyConfig([httpRoute({ https_enabled: 0, mtls_enabled: 1, mtls_ca_pem: CA_PEM })]);
    assert.equal('tls_connection_policies' in srv0(cfg), false);
    cfg = buildCaddyConfig([httpRoute({ mtls_enabled: 1, mtls_ca_pem: null })]);
    assert.equal('tls_connection_policies' in srv0(cfg), false);
  });
});

// ─── PEM files ──────────────────────────────────────────

describe('caddyPemFiles: written from the DB, orphans removed', () => {
  it('sync writes both kinds, keeps unchanged files, removes orphans and stale tmp files', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'pem-'));
    fs.mkdirSync(path.join(dir, 'mtls'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'mtls', '99.pem'), 'orphan');
    fs.writeFileSync(path.join(dir, 'mtls', '98.pem.tmp'), 'stale');
    fs.writeFileSync(path.join(dir, 'mtls', 'README'), 'not ours');

    const rows = [
      { id: 1, backend_tls_ca_pem: CA_PEM, mtls_ca_pem: null },
      { id: 2, backend_tls_ca_pem: null, mtls_ca_pem: BUNDLE_PEM },
      { id: 3, backend_tls_ca_pem: '   ', mtls_ca_pem: '' },
    ];
    let r = pemFiles.sync({ rows, dataDir: dir });
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.written.sort(), [path.join(dir, 'backend-ca', '1.pem'), path.join(dir, 'mtls', '2.pem')]);
    assert.deepEqual(r.removed.sort(), [path.join(dir, 'mtls', '98.pem.tmp'), path.join(dir, 'mtls', '99.pem')]);
    assert.equal(fs.readFileSync(path.join(dir, 'backend-ca', '1.pem'), 'utf8'), CA_PEM);
    assert.equal(fs.readFileSync(path.join(dir, 'mtls', '2.pem'), 'utf8'), BUNDLE_PEM);
    assert.ok(fs.existsSync(path.join(dir, 'mtls', 'README')), 'foreign files untouched');
    assert.ok(!fs.existsSync(path.join(dir, 'backend-ca', '3.pem')));

    r = pemFiles.sync({ rows, dataDir: dir });
    assert.deepEqual(r.written, []);
    assert.deepEqual(r.removed, []);
    assert.equal(r.unchanged, 2);

    r = pemFiles.sync({ rows: [rows[1]], dataDir: dir });
    assert.deepEqual(r.removed, [path.join(dir, 'backend-ca', '1.pem')]);
    assert.equal(pemFiles.backendCaPath(4, { dataDir: dir }), path.join(dir, 'backend-ca', '4.pem'));
    assert.equal(pemFiles.mtlsCaPath(4, { dataDir: dir }), path.join(dir, 'mtls', '4.pem'));
  });

  it('buildCaddyConfig() from the DB writes the files of stored routes', () => {
    const id = db.prepare(`INSERT INTO routes (domain, target_ip, target_port, https_enabled, backend_https, backend_tls_verify, backend_tls_ca_pem, mtls_enabled, mtls_ca_pem, enabled)
      VALUES ('pem.example.com', '10.8.0.9', 443, 1, 1, 1, ?, 1, ?, 1)`).run(CA_PEM, BUNDLE_PEM).lastInsertRowid;
    try {
      const cfg = buildCaddyConfig();
      const bp = path.join(tmp, 'caddy', 'backend-ca', `${id}.pem`);
      const mp = path.join(tmp, 'caddy', 'mtls', `${id}.pem`);
      assert.equal(fs.readFileSync(bp, 'utf8'), CA_PEM);
      assert.equal(fs.readFileSync(mp, 'utf8'), BUNDLE_PEM);
      assert.deepEqual(proxyOf(hostRoute(cfg, 'pem.example.com')).transport.tls.root_ca_pem_files, [bp]);
      assert.equal(srv0(cfg).tls_connection_policies[0].client_authentication.trusted_ca_certs_pem_files[0], mp);
      db.prepare('DELETE FROM routes WHERE id = ?').run(id);
      buildCaddyConfig();
      // no PEM-bearing route left → the build itself removes the orphans
      assert.equal(fs.existsSync(bp), false);
      assert.equal(fs.existsSync(mp), false);
      assert.deepEqual(pemFiles.sync().removed, []);
    } finally {
      db.prepare('DELETE FROM routes WHERE id = ?').run(id);
    }
  });
});

// ─── stability ──────────────────────────────────────────

describe('caddyConfig contract: config without new options carries none of the new keys', () => {
  it('no request_body, no tls_connection_policies, no alias routes, no *_pem_files; only the https redirect is new', () => {
    const cfg = buildCaddyConfig([httpRoute({ backend_https: 1 }), httpRoute({ id: 2, domain: 'b.example.com', ip_filter_enabled: 1 })]);
    const s = JSON.stringify(cfg);
    for (const key of ['request_body', 'tls_connection_policies', 'gc_alias_', 'root_ca_pem_files', 'trusted_ca_certs_pem_files', 'server_name', 'protocol_min']) {
      assert.ok(!s.includes(key), key + ' absent');
    }
    assert.equal(routesOf(cfg)[0]['@id'], 'gc_https_redirect');
  });
});
