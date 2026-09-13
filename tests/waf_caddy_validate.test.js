'use strict';

// WAF (docs/feature-waf.md): `caddy validate` of a GENERATED config with WAF
// handlers (block + detect + forward-auth chain + exclusions + block page).
// Needs a Caddy binary that carries http.handlers.waf — the image built from
// the Dockerfile (coraza-caddy). Looked up via GC_CADDY_BIN, /usr/local/bin/caddy,
// /usr/bin/caddy; skipped when none of them has the module (plain CI runner).
//   docker run … -v <caddy>:/usr/local/bin/caddy:ro node:20-alpine node --test tests/waf_caddy_validate.test.js

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync, spawnSync } = require('node:child_process');

process.env.NODE_ENV = 'test';
process.env.GC_LOG_LEVEL = process.env.GC_LOG_LEVEL || 'silent';
process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-waf-validate-'));
process.env.GC_DB_PATH = path.join(tmp, 'test.db');
process.env.GC_DATA_DIR = tmp;
process.env.GC_CADDY_DATA_DIR = path.join(tmp, 'caddy');
fs.mkdirSync(process.env.GC_CADDY_DATA_DIR, { recursive: true });

function findCaddyWithWaf() {
  for (const bin of [process.env.GC_CADDY_BIN, '/usr/local/bin/caddy', '/usr/bin/caddy'].filter(Boolean)) {
    try {
      if (!fs.existsSync(bin)) continue;
      const out = execFileSync(bin, ['list-modules'], { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'ignore'] });
      if (/^\s*http\.handlers\.waf\s*$/m.test(out)) return bin;
    } catch { /* next */ }
  }
  return null;
}

const CADDY = findCaddyWithWaf();
let waf, buildCaddyConfig;

before(() => {
  require('../src/db/migrations').runMigrations();
  waf = require('../src/services/waf');
  buildCaddyConfig = require('../src/services/caddyConfig').buildCaddyConfig;
});
after(() => { waf._setEngineForTest(null); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } });

test('generated config with WAF handlers passes `caddy validate`', { skip: CADDY ? false : 'no Caddy binary with http.handlers.waf (build the image)' }, () => {
  waf._setEngineForTest(true);
  const base = { route_type: 'http', target_kind: 'direct', target_ip: '127.0.0.1', target_port: 8081, enabled: 1, https_enabled: 0, external_enabled: 1 };
  const cfg = buildCaddyConfig([
    { ...base, id: 1, domain: 'block.test', waf_enabled: 1, waf_mode: 'block', waf_paranoia: 1,
      waf_exclusions: JSON.stringify({ rule_ids: [920350, 942100], paths: ['/excluded', '/api/upload'] }), max_body_mb: 10 },
    { ...base, id: 2, domain: 'detect.test', waf_enabled: 1, waf_mode: 'detect', waf_paranoia: 4 },
    // ip_filter_enabled → forward-auth handler chain (caddyAuthSubroute)
    { ...base, id: 3, domain: 'auth.test', ip_filter_enabled: 1, waf_enabled: 1, waf_mode: 'block', waf_paranoia: 2 },
  ]);
  const hs = JSON.stringify(cfg);
  assert.equal((hs.match(/"handler":"waf"/g) || []).length, 3);
  assert.ok(cfg.apps.http.servers.srv0.errors, 'block page error route present');
  // Keep every file the config opens inside the temp dir.
  cfg.logging.logs.access.writer.filename = path.join(tmp, 'caddy', 'access.log');
  const file = path.join(tmp, 'caddy.json');
  fs.writeFileSync(file, JSON.stringify(cfg));
  const res = spawnSync(CADDY, ['validate', '--config', file], {
    encoding: 'utf8', timeout: 120000, env: { ...process.env, XDG_DATA_HOME: path.join(tmp, 'caddy'), XDG_CONFIG_HOME: path.join(tmp, 'caddy') },
  });
  const out = `${res.stdout}\n${res.stderr}`;
  assert.equal(res.status, 0, out.slice(-2000));
  assert.match(out, /Valid configuration/);
});
