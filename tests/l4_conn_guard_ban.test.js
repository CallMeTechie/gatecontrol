'use strict';

// docs/feature-next-package.md §S1.3: the layer-4 connection guard hands an
// offender to the EXISTING ban infrastructure (wafBans.autoBan → waf_bans →
// the ban route on both the HTTP and the L4 side). This is the safety net:
//   * an own (trusted) address is never banned
//   * a private / loopback address is never banned
//   * an address already banned is not banned twice
//   * the whole poll path works end to end against a real DB
// The log parsing and the counting itself are covered in l4_protect.test.js.

const crypto = require('node:crypto');
const os = require('node:os');
const nodePath = require('node:path');
const nodeFs = require('node:fs');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
// tests/helpers/setup only redirects GC_DATA_DIR — without this the Caddy data
// dir stays at its /data/caddy default and the guard's log path is not
// writable for the unprivileged user CI runs as.
process.env.GC_CADDY_DATA_DIR = process.env.GC_CADDY_DATA_DIR
  || nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'gc-l4guard-'));

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setup, teardown } = require('./helpers/setup');

let db, wafBans, guard, settings, routeId, logFile;

function connLine(ip, port, tsMs) {
  return JSON.stringify({
    level: 'debug', ts: tsMs / 1000, logger: 'layer4', msg: 'started handling connection',
    network: 'tcp', local: '10.0.0.2:' + port, remote: ip + ':' + (40000 + (tsMs % 1000)),
  });
}

/** Append `n` connection lines of `ip` to the log and run one poll. */
function burst(ip, n, port = '2023') {
  const now = Date.now();
  const lines = [];
  for (let i = 0; i < n; i++) lines.push(connLine(ip, port, now + i));
  fs.appendFileSync(logFile, lines.join('\n') + '\n');
  return guard.pollOnce();
}

function activeBan(ip) {
  return db.prepare('SELECT * FROM waf_bans WHERE ip = ?').get(ip) || null;
}

before(async () => {
  await setup();
  db = require('../src/db/connection').getDb();
  wafBans = require('../src/services/wafBans');
  guard = require('../src/services/l4ConnGuard');
  settings = require('../src/services/settings');
  routeId = db.prepare(`INSERT INTO routes (domain, target_ip, target_port, route_type, l4_protocol, l4_listen_port, l4_tls_mode,
      l4_conn_limit, l4_conn_window_s, external_enabled, https_enabled)
    VALUES (NULL, '10.0.0.9', 22, 'l4', 'tcp', '2023', 'none', 3, 60, 1, 0)`).run().lastInsertRowid;
  logFile = guard.logPath();
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.writeFileSync(logFile, '');
  guard.start({ file: logFile, intervalMs: 3600000 });
});

after(() => {
  guard.stop(); wafBans._resetForTest(); teardown();
  try { fs.rmSync(process.env.GC_CADDY_DATA_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('more connections than the limit put the address on the ban list', () => {
  const ip = '45.33.32.156';
  assert.equal(activeBan(ip), null);
  assert.equal(burst(ip, 3), 0, '3 of 3 is still fine');
  assert.equal(burst(ip, 1), 1, 'the 4th crosses the limit');
  const ban = activeBan(ip);
  assert.ok(ban, 'the address is banned');
  assert.equal(ban.manual, 0);
  assert.match(ban.reason, /^l4_rate: 4 connections in 60 s on port 2023 \(limit 3\)$/);
  assert.equal(ban.hits, 4);
  assert.ok(ban.expires_at > new Date().toISOString(), 'the ban expires');
  // The generator turns it into ranges for both the HTTP and the L4 side.
  assert.ok(wafBans.banRanges().includes(ip + '/32'));
});

test('a second burst does not ban an already banned address twice', () => {
  const ip = '45.33.32.156';
  const before = activeBan(ip).banned_at;
  assert.equal(burst(ip, 10), 0);
  assert.equal(activeBan(ip).banned_at, before, 'the existing ban is untouched');
});

test('own (trusted) addresses are never banned', () => {
  const ip = '91.240.118.77';
  settings.set('waf.trusted_ips', JSON.stringify(['91.240.118.0/24']));
  try {
    assert.equal(burst(ip, 10), 0);
    assert.equal(activeBan(ip), null, 'trusted stays unbanned no matter how many connections');
    assert.equal(wafBans.autoBan({ ip, reason: 'l4_rate: direct call' }), null);
  } finally { settings.set('waf.trusted_ips', '[]'); }
  // Without the trusted list the very same address would be banned.
  assert.equal(burst(ip, 10), 1);
  assert.ok(activeBan(ip));
});

test('private, loopback, link-local and reserved addresses are never banned', () => {
  // 203.0.113.0/24 and 198.51.100.0/24 are documentation ranges — ipaddr.js
  // reports them as `reserved`, so isPublicIp keeps them out just like an
  // RFC1918 address. Banning them would only ever hit a test set-up.
  for (const ip of ['10.10.0.5', '192.168.1.9', '127.0.0.1', '169.254.1.1', 'fd00::1', '203.0.113.9', '198.51.100.9']) {
    assert.equal(burst(ip, 10), 0, ip);
    assert.equal(activeBan(ip), null, ip);
  }
});

test('a listener without a limit is not counted at all', () => {
  const ip = '45.33.40.1';
  assert.equal(burst(ip, 50, '9999'), 0, 'port 9999 has no entry with a rate');
  assert.equal(activeBan(ip), null);
});

test('switching the rate off stops the guard from counting', () => {
  db.prepare('UPDATE routes SET l4_conn_limit = NULL, l4_conn_window_s = NULL WHERE id = ?').run(routeId);
  const ip = '45.33.40.2';
  assert.equal(burst(ip, 50), 0);
  assert.equal(activeBan(ip), null);
  db.prepare('UPDATE routes SET l4_conn_limit = 3, l4_conn_window_s = 60 WHERE id = ?').run(routeId);
});

test('a disabled entry does not arm the guard either', () => {
  db.prepare('UPDATE routes SET enabled = 0 WHERE id = ?').run(routeId);
  const ip = '45.33.40.3';
  assert.equal(burst(ip, 50), 0);
  assert.equal(activeBan(ip), null);
  db.prepare('UPDATE routes SET enabled = 1 WHERE id = ?').run(routeId);
});

test('a rotated (truncated) log is read from the top again', () => {
  const ip = '45.33.40.4';
  fs.writeFileSync(logFile, '');            // Caddy rolled the file
  assert.equal(burst(ip, 4), 1, 'the guard notices the shrink and re-reads');
  assert.ok(activeBan(ip));
});
