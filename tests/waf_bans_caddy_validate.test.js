'use strict';

// Release B §3: `caddy validate` of a GENERATED config with the scanner-ban
// route gc_waf_bans (IPv4, IPv6, CIDR) and the trusted-bypass directive
// (id 9003) in WAF handlers — plain chain and forward-auth chain.
// Needs a Caddy binary with http.handlers.waf (the image's); skipped otherwise.
//   docker run … -v <caddy>:/usr/local/bin/caddy:ro node:20-alpine node --test tests/waf_bans_caddy_validate.test.js

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
process.env.GC_BASE_URL = 'https://gc.example.net';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-wafban-validate-'));
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
let waf, buildCaddyConfig, db;

before(() => {
  require('../src/db/migrations').runMigrations();
  db = require('../src/db/connection').getDb();
  waf = require('../src/services/waf');
  buildCaddyConfig = require('../src/services/caddyConfig').buildCaddyConfig;
});
after(() => { waf._setEngineForTest(null); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } });

test('generated config with gc_waf_bans and the trusted bypass passes `caddy validate`', { skip: CADDY ? false : 'no Caddy binary with http.handlers.waf (build the image)' }, () => {
  waf._setEngineForTest(true);
  const settings = require('../src/services/settings');
  settings.set('waf.trusted_ips', JSON.stringify(['93.215.209.180', '10.0.0.0/8', '2001:db8::/32']));
  settings.set('waf.trusted_bypass', 'true');
  const now = new Date();
  const exp = new Date(now.getTime() + 3600000).toISOString();
  const ins = db.prepare("INSERT INTO waf_bans (ip, reason, hits, banned_at, expires_at, manual) VALUES (?, 'x', 1, ?, ?, 0)");
  for (const ip of ['45.33.32.156', '2a01:4f8:1:2::3', '198.51.100.0/24']) ins.run(ip, now.toISOString(), exp);

  const base = { route_type: 'http', target_kind: 'direct', target_ip: '127.0.0.1', target_port: 8081, enabled: 1, external_enabled: 1 };
  const cfg = buildCaddyConfig([
    { ...base, id: 1, domain: 'block.test', https_enabled: 1, waf_enabled: 1, waf_mode: 'block', waf_paranoia: 1 },
    { ...base, id: 2, domain: 'auth.test', https_enabled: 0, ip_filter_enabled: 1, waf_enabled: 1, waf_mode: 'detect', waf_paranoia: 2 },
  ]);
  const srv = cfg.apps.http.servers.srv0;
  assert.equal(srv.routes[0]['@id'], 'gc_https_redirect');
  assert.equal(srv.routes[1]['@id'], 'gc_waf_bans');
  const hs = JSON.stringify(cfg);
  assert.equal((hs.match(/"handler":"waf"/g) || []).length, 2);
  assert.equal((hs.match(/id:9003/g) || []).length, 2);
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
