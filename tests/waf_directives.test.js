'use strict';

// WAF (docs/feature-waf.md): directive generation (pure), exclusion parsing /
// validation, route field resolution, and the Caddy handler chains: the `waf`
// handler sits after request_body and before reverse_proxy in both chains,
// only for HTTP routes with waf_enabled and only when the engine is available;
// block mode adds the srv0 error route with the own block page.

const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

process.env.NODE_ENV = 'test';
process.env.GC_LOG_LEVEL = process.env.GC_LOG_LEVEL || 'silent';
process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-waf-dir-'));
process.env.GC_DB_PATH = path.join(tmp, 'test.db');
process.env.GC_DATA_DIR = tmp;
process.env.GC_CADDY_DATA_DIR = '/data/caddy';

let waf, buildCaddyConfig, rv, db;

before(() => {
  require('../src/db/migrations').runMigrations();
  waf = require('../src/services/waf');
  rv = require('../src/services/routesValidation');
  buildCaddyConfig = require('../src/services/caddyConfig').buildCaddyConfig;
  db = require('../src/db/connection').getDb();
});
afterEach(() => {
  waf._setEngineForTest(null);
  db.prepare('DELETE FROM route_auth').run();
});
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } });

function httpRoute(over = {}) {
  return {
    id: 7, domain: 'app.example.com', route_type: 'http',
    target_kind: 'peer', target_ip: '10.8.0.7', target_port: 80,
    enabled: 1, https_enabled: 1, external_enabled: 1,
    ...over,
  };
}

const srv0 = (cfg) => cfg.apps.http.servers.srv0;
const hostRoute = (cfg, host) => srv0(cfg).routes.find((r) => r['@id'] !== 'gc_https_redirect' && (r.match?.[0]?.host || []).includes(host));
function handlersOf(route) {
  const out = [];
  const walk = (hs) => { for (const h of hs || []) { out.push(h); if (h.handler === 'subroute') for (const r of h.routes || []) walk(r.handle); } };
  walk(route.handle);
  return out;
}
const names = (route) => handlersOf(route).map((h) => h.handler);

// ─── directivesFor ──────────────────────────────────────

describe('directivesFor', () => {
  it('detect mode, paranoia 1, no exclusions: contract lines in a working order', () => {
    const d = waf.directivesFor({ id: 3, waf_mode: 'detect', waf_paranoia: 1 }).split('\n');
    assert.deepEqual(d, [
      'Include @coraza.conf-recommended',
      'Include @crs-setup.conf.example',
      'SecAction "id:900000,phase:1,pass,nolog,setvar:tx.blocking_paranoia_level=1"',
      'Include @owasp_crs/*.conf',
      'SecRuleEngine DetectionOnly',
      'SecRequestBodyLimitAction ProcessPartial',
      'SecResponseBodyAccess Off',
      'SecAuditEngine RelevantOnly',
      'SecAuditLogRelevantStatus "^40[03]$"',
      'SecAuditLogFormat JSON',
      'SecAuditLog /data/caddy/waf-audit.log',
      'SecAuditLogParts AHZ',
      'SecAuditLogFileMode 0600',
    ]);
  });

  it('block mode → SecRuleEngine On; paranoia is clamped to 1..4', () => {
    assert.match(waf.directivesFor({ id: 1, waf_mode: 'block', waf_paranoia: 3 }), /^SecRuleEngine On$/m);
    assert.match(waf.directivesFor({ id: 1, waf_mode: 'block', waf_paranoia: 3 }), /blocking_paranoia_level=3"/);
    assert.match(waf.directivesFor({ id: 1, waf_paranoia: 9 }), /blocking_paranoia_level=4"/);
    assert.match(waf.directivesFor({ id: 1, waf_paranoia: 0 }), /blocking_paranoia_level=1"/);
    assert.match(waf.directivesFor({ id: 1, waf_paranoia: 'x' }), /blocking_paranoia_level=1"/);
    assert.match(waf.directivesFor({ id: 1, waf_mode: 'weird' }), /^SecRuleEngine DetectionOnly$/m);
  });

  it('paranoia SecAction and path exclusions come BEFORE the CRS include, rule removals AFTER it', () => {
    const d = waf.directivesFor({
      id: 12, waf_mode: 'block', waf_paranoia: 2,
      waf_exclusions: JSON.stringify({ rule_ids: [942100, 920350], paths: ['/api/upload', '/webdav/'] }),
    });
    const lines = d.split('\n');
    const crs = lines.indexOf('Include @owasp_crs/*.conf');
    const pl = lines.findIndex((l) => l.includes('id:900000'));
    const p1 = lines.indexOf('SecRule REQUEST_URI "@beginsWith /api/upload" "id:11200,phase:1,pass,nolog,ctl:ruleEngine=Off"');
    const p2 = lines.indexOf('SecRule REQUEST_URI "@beginsWith /webdav/" "id:11201,phase:1,pass,nolog,ctl:ruleEngine=Off"');
    assert.ok(pl > 0 && pl < crs, 'paranoia before CRS');
    assert.ok(p1 > pl && p1 < crs && p2 === p1 + 1, 'path exclusions (ids 10000 + 12*100 + i) before CRS');
    const r1 = lines.indexOf('SecRuleRemoveById 920350');
    const r2 = lines.indexOf('SecRuleRemoveById 942100');
    assert.ok(r1 > crs && r2 === r1 + 1, 'rule removals after CRS, sorted');
    assert.equal(lines[lines.length - 1], 'SecRuleRemoveById 942100');
  });

  it('audit log path follows the Caddy data dir', () => {
    assert.match(waf.directivesFor({ id: 1 }, { auditLog: '/x/y/waf-audit.log' }), /^SecAuditLog \/x\/y\/waf-audit\.log$/m);
    assert.equal(waf.auditLogPath(), '/data/caddy/waf-audit.log');
  });

  it('broken / hostile exclusions never reach the directives', () => {
    const d = waf.directivesFor({ id: 1, waf_exclusions: '{not json' });
    assert.doesNotMatch(d, /SecRuleRemoveById|@beginsWith/);
    const d2 = waf.directivesFor({
      id: 1,
      waf_exclusions: { rule_ids: ['941100', -1, 1.5, 'x', 99999999], paths: ['/ok', 'no-slash', '/a b', '/q"x', '/nl\nSecRuleEngine Off', '/back\\slash'] },
    });
    assert.match(d2, /^SecRuleRemoveById 941100$/m);
    assert.equal((d2.match(/SecRuleRemoveById/g) || []).length, 1);
    assert.equal((d2.match(/@beginsWith/g) || []).length, 1);
    assert.match(d2, /@beginsWith \/ok"/);
    assert.equal((d2.match(/^SecRuleEngine /gm) || []).length, 1, 'no injected engine line');
  });
});

describe('exclusion helpers', () => {
  it('parseExclusions dedupes, sorts ids and tolerates garbage', () => {
    assert.deepEqual(waf.parseExclusions(null), { rule_ids: [], paths: [] });
    assert.deepEqual(waf.parseExclusions('[]'), { rule_ids: [], paths: [] });
    assert.deepEqual(waf.parseExclusions('{"rule_ids":[942100,920350,942100],"paths":["/a","/a"," /b "]}'),
      { rule_ids: [920350, 942100], paths: ['/a', '/b'] });
  });
  it('validateRuleId / validateExclusionPath throw coded errors', () => {
    assert.equal(waf.validateRuleId('941100'), 941100);
    assert.equal(waf.validateRuleId(1), 1);
    for (const bad of [0, -3, 1.5, 'abc', '', null, 10000000]) {
      assert.throws(() => waf.validateRuleId(bad), (e) => e.code === 'WAF_RULE_ID_INVALID' && e.statusCode === 400, String(bad));
    }
    assert.equal(waf.validateExclusionPath(' /api/v1/upload '), '/api/v1/upload');
    for (const bad of ['', 'api', '/a b', '/a"b', "/a'b", '/a\\b', '/a\nb', '/' + 'x'.repeat(300)]) {
      assert.throws(() => waf.validateExclusionPath(bad), (e) => e.code === 'WAF_PATH_INVALID', JSON.stringify(bad));
    }
  });
});

describe('resolveWafFields', () => {
  it('defaults, PATCH semantics and validation codes', () => {
    assert.deepEqual(rv.resolveWafFields({}, null, { route_type: 'http' }), { waf_enabled: 0, waf_mode: 'detect', waf_paranoia: 1 });
    assert.deepEqual(rv.resolveWafFields({ waf_enabled: true, waf_mode: 'block', waf_paranoia: '3' }, null, { route_type: 'http' }),
      { waf_enabled: 1, waf_mode: 'block', waf_paranoia: 3 });
    const cur = { waf_enabled: 1, waf_mode: 'block', waf_paranoia: 2 };
    assert.deepEqual(rv.resolveWafFields({}, cur, { route_type: 'http' }), cur, 'absent fields keep stored values');
    assert.deepEqual(rv.resolveWafFields({ waf_paranoia: 4 }, cur, { route_type: 'http' }), { ...cur, waf_paranoia: 4 });
    assert.throws(() => rv.resolveWafFields({ waf_mode: 'deny' }, null, { route_type: 'http' }), (e) => e.code === 'WAF_MODE_INVALID');
    for (const p of [0, 5, 1.5, 'x']) {
      assert.throws(() => rv.resolveWafFields({ waf_paranoia: p }, null, { route_type: 'http' }), (e) => e.code === 'WAF_PARANOIA_INVALID', String(p));
    }
    assert.throws(() => rv.resolveWafFields({ waf_enabled: 1 }, null, { route_type: 'l4' }), (e) => e.code === 'WAF_REQUIRES_HTTP' && e.statusCode === 400);
    assert.equal(rv.resolveWafFields({}, cur, { route_type: 'l4' }).waf_enabled, 0, 'inherited flag cleared on L4');
  });
});

// ─── Caddy config ───────────────────────────────────────

describe('caddyConfig: waf handler', () => {
  it('engine available: waf after request_body and before reverse_proxy (plain chain)', () => {
    waf._setEngineForTest(true);
    const cfg = buildCaddyConfig([httpRoute({ waf_enabled: 1, waf_mode: 'detect', waf_paranoia: 2, max_body_mb: 5, compress_enabled: 1 })]);
    const r = hostRoute(cfg, 'app.example.com');
    const n = names(r);
    assert.deepEqual(n.slice(-3), ['request_body', 'waf', 'reverse_proxy']);
    const h = handlersOf(r).find((x) => x.handler === 'waf');
    assert.equal(h.load_owasp_crs, true);
    assert.equal(h.directives, waf.directivesFor({ id: 7, waf_mode: 'detect', waf_paranoia: 2 }));
    assert.equal(srv0(cfg).errors, undefined, 'detect mode: no block page');
  });

  it('forward-auth chain: waf after request_body and before reverse_proxy', () => {
    waf._setEngineForTest(true);
    const cfg = buildCaddyConfig([httpRoute({ ip_filter_enabled: 1, waf_enabled: 1, waf_mode: 'block', max_body_mb: 1 })]);
    const r = hostRoute(cfg, 'app.example.com');
    const inner = handlersOf(r);
    const idxWaf = inner.findIndex((h) => h.handler === 'waf');
    const idxBody = inner.findIndex((h) => h.handler === 'request_body');
    const proxies = inner.map((h, i) => [h, i]).filter(([h]) => h.handler === 'reverse_proxy' && !h.rewrite && !(h.upstreams || []).some((u) => u.dial === '127.0.0.1:3000'));
    assert.equal(proxies.length, 1);
    assert.ok(idxBody >= 0 && idxWaf === idxBody + 1 && proxies[0][1] === idxWaf + 1, JSON.stringify(inner.map((h) => h.handler)));
    // forward-auth subrequest runs before the WAF
    const fa = inner.findIndex((h) => h.handler === 'reverse_proxy' && h.rewrite);
    assert.ok(fa >= 0 && fa < idxWaf);
  });

  it('block mode: srv0 error route (host-scoped) serves the own page with the interruption status', () => {
    waf._setEngineForTest(true);
    const cfg = buildCaddyConfig([
      httpRoute({ waf_enabled: 1, waf_mode: 'block', host_aliases: '["www"]', host_alias_mode: 'serve' }),
      httpRoute({ id: 8, domain: 'other.example.com', waf_enabled: 1, waf_mode: 'detect' }),
    ]);
    const errs = srv0(cfg).errors;
    assert.ok(errs && Array.isArray(errs.routes) && errs.routes.length === 1);
    const e = errs.routes[0];
    assert.deepEqual(e.match[0].host, ['app.example.com', 'www.app.example.com']);
    assert.equal(e.match[0].expression, "{http.error.message} == 'interruption triggered'");
    assert.equal(e.handle[0].handler, 'static_response');
    assert.equal(e.handle[0].status_code, '{http.error.status_code}');
    assert.match(e.handle[0].body, /Anfrage blockiert/);
    assert.match(e.handle[0].body, /\{http\.error\.id\}/);
  });

  it('engine NOT available: handler omitted, config otherwise unchanged', () => {
    waf._setEngineForTest(false);
    const withFlag = buildCaddyConfig([httpRoute({ waf_enabled: 1, waf_mode: 'block' })]);
    const without = buildCaddyConfig([httpRoute()]);
    assert.equal(names(hostRoute(withFlag, 'app.example.com')).includes('waf'), false);
    assert.equal(srv0(withFlag).errors, undefined);
    const strip = (c) => JSON.stringify(c, (k, v) => (k === '@id' && String(v).startsWith('gc_owner_') ? undefined : v));
    assert.equal(strip(withFlag), strip(without));
  });

  it('no WAF anywhere: no waf handler, no errors block (byte-stable config)', () => {
    waf._setEngineForTest(true);
    const cfg = buildCaddyConfig([httpRoute({ waf_enabled: 0, waf_mode: 'block' })]);
    assert.equal(JSON.stringify(cfg).includes('"waf"'), false);
    assert.equal(srv0(cfg).errors, undefined);
  });

  it('gateway maintenance page (static_response) gets no WAF', () => {
    waf._setEngineForTest(true);
    const cfg = buildCaddyConfig([httpRoute({
      target_kind: 'gateway', target_peer_id: 42, target_peer_allowed_ips: '10.8.0.42/32',
      target_lan_host: '192.168.1.10', target_lan_port: 80, gateway_offline: 1,
      waf_enabled: 1, waf_mode: 'block',
    })]);
    const n = names(hostRoute(cfg, 'app.example.com'));
    assert.equal(n.includes('waf'), false);
    assert.equal(srv0(cfg).errors, undefined);
  });

  it('gateway route (online): WAF in front of the proxy to the gateway', () => {
    waf._setEngineForTest(true);
    const cfg = buildCaddyConfig([httpRoute({
      target_kind: 'gateway', target_peer_id: 42, target_peer_allowed_ips: '10.8.0.42/32',
      target_lan_host: '192.168.1.10', target_lan_port: 80, waf_enabled: 1,
    })]);
    assert.deepEqual(names(hostRoute(cfg, 'app.example.com')).slice(-2), ['waf', 'reverse_proxy']);
  });

  it('buildWafHandler: off, L4 and missing engine → null', () => {
    assert.equal(waf.buildWafHandler(httpRoute({ waf_enabled: 0 }), { engine: true }), null);
    assert.equal(waf.buildWafHandler(httpRoute({ waf_enabled: 1, route_type: 'l4' }), { engine: true }), null);
    assert.equal(waf.buildWafHandler(httpRoute({ waf_enabled: 1 }), { engine: false }), null);
    assert.equal(waf.buildWafHandler(httpRoute({ waf_enabled: 1 }), { engine: true }).handler, 'waf');
  });
});

describe('engine detection', () => {
  it('modulesHaveWaf reads `caddy list-modules` output', () => {
    const out = 'http.handlers.trace\nhttp.handlers.waf\nlayer4\n\n  Non-standard modules: 49\n';
    assert.equal(waf.modulesHaveWaf(out), true);
    assert.equal(waf.modulesHaveWaf('http.handlers.waf_other\nhttp.handlers.wafx\n'), false);
    assert.equal(waf.modulesHaveWaf(''), false);
  });
  it('test environment never executes the binary; GC_WAF_ENGINE forces the result', () => {
    assert.equal(waf.engineAvailable(), false);
    process.env.GC_WAF_ENGINE = '1';
    try { assert.equal(waf.engineAvailable(), true); } finally { delete process.env.GC_WAF_ENGINE; }
    waf._setEngineForTest(true);
    assert.equal(waf.engineAvailable(), true);
  });
});
