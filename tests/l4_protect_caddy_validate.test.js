'use strict';

// docs/feature-next-package.md §S1: `caddy validate` of a GENERATED config
// whose layer4 servers carry the ban route (§S1.1), an allow filter and a deny
// filter (§S1.2) and the connection log (§S1.3). Needs a Caddy binary with the
// caddy-l4 modules (the image's); skipped otherwise.
//   docker run … -v <caddy>:/usr/local/bin/caddy:ro node:20-alpine node --test tests/l4_protect_caddy_validate.test.js

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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-l4-validate-'));
process.env.GC_DB_PATH = path.join(tmp, 'test.db');
process.env.GC_DATA_DIR = tmp;
process.env.GC_CADDY_DATA_DIR = path.join(tmp, 'caddy');
fs.mkdirSync(process.env.GC_CADDY_DATA_DIR, { recursive: true });

// The modules the whole strand stands on — if one is missing, the shipped
// Caddy cannot do what the generator emits and the test must not pretend.
const NEEDED = ['layer4.matchers.remote_ip', 'layer4.matchers.not', 'layer4.matchers.tls', 'layer4.handlers.close'];

function findCaddyWithL4() {
  for (const bin of [process.env.GC_CADDY_BIN, '/usr/local/bin/caddy', '/usr/bin/caddy'].filter(Boolean)) {
    try {
      if (!fs.existsSync(bin)) continue;
      const out = execFileSync(bin, ['list-modules'], { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'ignore'] });
      if (NEEDED.every((m) => new RegExp('^\\s*' + m.replace(/\./g, '\\.') + '\\s*$', 'm').test(out))) return bin;
    } catch { /* next */ }
  }
  return null;
}

const CADDY = findCaddyWithL4();
let buildCaddyConfig, db;

before(() => {
  require('../src/db/migrations').runMigrations();
  db = require('../src/db/connection').getDb();
  buildCaddyConfig = require('../src/services/caddyConfig').buildCaddyConfig;
});
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } });

function validate(cfg) {
  cfg.logging.logs.access.writer.filename = path.join(tmp, 'caddy', 'access.log');
  if (cfg.logging.logs.l4conn) cfg.logging.logs.l4conn.writer.filename = path.join(tmp, 'caddy', 'l4conn.log');
  const file = path.join(tmp, 'caddy.json');
  fs.writeFileSync(file, JSON.stringify(cfg));
  const res = spawnSync(CADDY, ['validate', '--config', file], {
    encoding: 'utf8', timeout: 120000,
    env: { ...process.env, XDG_DATA_HOME: path.join(tmp, 'caddy'), XDG_CONFIG_HOME: path.join(tmp, 'caddy') },
  });
  return `${res.status}\n${res.stdout}\n${res.stderr}`;
}

const l4base = {
  route_type: 'l4', target_kind: 'direct', enabled: 1, external_enabled: 1,
  l4_protocol: 'tcp', l4_tls_mode: 'none', target_ip: '10.10.0.5', target_port: 22, domain: null,
};

test('L4 ban route + allow filter + deny filter + connection log pass `caddy validate`', { skip: CADDY ? false : 'no Caddy binary with the caddy-l4 modules (build the image)' }, () => {
  const now = new Date();
  const exp = new Date(now.getTime() + 3600000).toISOString();
  const ins = db.prepare("INSERT INTO waf_bans (ip, reason, hits, banned_at, expires_at, manual) VALUES (?, 'scanner', 1, ?, ?, 0)");
  for (const ip of ['45.33.32.156', '2a01:4f8:1:2::3', '198.51.100.0/24']) ins.run(ip, now.toISOString(), exp);

  const cfg = buildCaddyConfig([
    // plain SSH forward: allow list + a connection rate
    { ...l4base, id: 1, l4_listen_port: '2023',
      ip_filter_enabled: 1, ip_filter_mode: 'whitelist',
      ip_filter_rules: JSON.stringify([{ type: 'ip', value: '203.0.113.7' }, { type: 'cidr', value: '2a01:4f8::/32' }]),
      l4_conn_limit: 20, l4_conn_window_s: 60 },
    // UDP forward: deny list
    { ...l4base, id: 2, l4_listen_port: '5353', l4_protocol: 'udp', target_port: 53,
      ip_filter_enabled: 1, ip_filter_mode: 'blacklist',
      ip_filter_rules: JSON.stringify([{ type: 'cidr', value: '45.33.0.0/16' }]) },
    // TLS passthrough pair on one port: one filtered, one not
    { ...l4base, id: 3, l4_listen_port: '8443', l4_tls_mode: 'passthrough', domain: 'a.example', target_port: 443,
      ip_filter_enabled: 1, ip_filter_mode: 'allow', ip_filter_rules: JSON.stringify([{ type: 'ip', value: '198.51.100.9' }]) },
    { ...l4base, id: 4, l4_listen_port: '8443', l4_tls_mode: 'passthrough', domain: 'b.example', target_port: 443 },
  ]);

  const servers = cfg.apps.layer4.servers;
  assert.deepEqual(Object.keys(servers).sort(), ['l4-tcp-2023', 'l4-tls-8443', 'l4-udp-5353']);
  // Ban route first on every listener.
  for (const name of Object.keys(servers)) {
    const first = servers[name].routes[0];
    assert.deepEqual(first.handle, [{ handler: 'close' }], name);
    assert.deepEqual(first.match[0].remote_ip.ranges,
      ['198.51.100.0/24', '2a01:4f8:1:2::3/128', '45.33.32.156/32'], name);
  }
  assert.deepEqual(servers['l4-tcp-2023'].routes[1].match, [{ not: [{ remote_ip: { ranges: ['203.0.113.7/32', '2a01:4f8::/32'] } }] }]);
  assert.deepEqual(servers['l4-udp-5353'].routes[1].match, [{ remote_ip: { ranges: ['45.33.0.0/16'] } }]);
  assert.deepEqual(servers['l4-tls-8443'].routes[1].match, [{ tls: { sni: ['a.example'] }, not: [{ remote_ip: { ranges: ['198.51.100.9/32'] } }] }]);
  assert.equal(servers['l4-tls-8443'].routes.length, 4, 'ban + a-guard + a + b');
  // The connection log exists because entry 1 has a rate.
  assert.equal(cfg.logging.logs.l4conn.level, 'DEBUG');
  assert.deepEqual(cfg.logging.logs.l4conn.include, ['layer4']);

  const out = validate(cfg);
  assert.match(out, /^0\n/, out.slice(-2000));
  assert.match(out, /Valid configuration/);
});

test('without bans, filters and rates the layer4 app is exactly the pre-S1 one', { skip: CADDY ? false : 'no Caddy binary with the caddy-l4 modules (build the image)' }, () => {
  db.prepare('DELETE FROM waf_bans').run();
  const cfg = buildCaddyConfig([{ ...l4base, id: 1, l4_listen_port: '2023' }]);
  assert.deepEqual(cfg.apps.layer4.servers['l4-tcp-2023'], {
    listen: ['tcp/:2023'],
    routes: [{ handle: [{ handler: 'proxy', upstreams: [{ dial: ['10.10.0.5:22'] }] }] }],
  });
  assert.equal(cfg.logging.logs.l4conn, undefined, 'no connection log without a rate');
  const out = validate(cfg);
  assert.match(out, /^0\n/, out.slice(-2000));
});
