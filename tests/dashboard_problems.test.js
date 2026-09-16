'use strict';

// Dashboard problems (docs/feature-next-package.md S3 §1):
// the access-log classification (ECONNREFUSED vs EHOSTUNREACH via status +
// duration), the assembled rows per source, "nur bei Bedarf" and the
// Wake-on-LAN hint, plus GET /api/v1/dashboard/problems.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
// Own Caddy data dir so the access-log reader never looks at /data (CI runs
// unprivileged — a test that writes to /data passes locally and breaks there).
const caddyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-problems-caddy-'));
process.env.GC_CADDY_DATA_DIR = caddyDir;

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown, getAgent } = require('./helpers/setup');

let agent, db, problems, license;
const ACCESS_LOG = path.join(caddyDir, 'access.log');

function writeAccessLog(lines) {
  fs.writeFileSync(ACCESS_LOG, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  problems._resetAccessCacheForTest();
}

function line(host, status, duration, agoS = 60) {
  return {
    level: status >= 500 ? 'error' : 'info',
    ts: Date.now() / 1000 - agoS,
    logger: 'http.log.access.access',
    msg: 'handled request',
    request: { host, method: 'GET', uri: '/' },
    duration,
    status,
  };
}

function insertRoute(cols) {
  const full = { target_ip: '10.8.0.5', target_port: 80, route_type: 'http', https_enabled: 1, enabled: 1, ...cols };
  const keys = Object.keys(full);
  return db.prepare(`INSERT INTO routes (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`)
    .run(...keys.map((k) => full[k])).lastInsertRowid;
}

function byId(list, id) { return list.find((p) => p.id === id); }

before(async () => {
  await setup();
  agent = getAgent();
  db = require('../src/db/connection').getDb();
  problems = require('../src/services/dashboardProblems');
  license = require('../src/services/license');
});

after(() => {
  teardown();
  try { fs.rmSync(caddyDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ─── Access-log classification ──────────────────────────

test('classifyLine: 502 fast = refused, 502 slow and 504 = unreachable', () => {
  assert.equal(problems.classifyLine(502, 0.021), 'refused');
  assert.equal(problems.classifyLine(502, 0.9), 'refused');
  assert.equal(problems.classifyLine(502, 3.0), 'unreachable');
  assert.equal(problems.classifyLine(504, 2.95), 'unreachable');
  assert.equal(problems.classifyLine(200, 0.01), 'ok');
  assert.equal(problems.classifyLine(404, 0.01), 'ok');
  // 503 is the circuit breaker / the app itself, not the dial.
  assert.equal(problems.classifyLine(503, 0.01), null);
  assert.equal(problems.classifyLine(undefined, 1), null);
});

test('scanAccessLog groups per host and accessVerdict picks the reason', async () => {
  writeAccessLog([
    line('refused.example', 502, 0.02),
    line('refused.example', 502, 0.021),
    line('asleep.example', 504, 2.94),
    line('asleep.example', 502, 3.1),
    line('fine.example', 200, 0.1),
  ]);
  const hosts = await problems.scanAccessLog();
  assert.equal(problems.accessVerdict(hosts, 'refused.example').reason, 'refused');
  assert.equal(problems.accessVerdict(hosts, 'asleep.example').reason, 'unreachable');
  assert.equal(problems.accessVerdict(hosts, 'fine.example'), null);
  assert.equal(problems.accessVerdict(hosts, 'unknown.example'), null);
  // Host matching ignores case and a port suffix.
  assert.ok(problems.accessVerdict(hosts, 'REFUSED.example'));
});

test('a later success ends the outage, old lines are outside the window', async () => {
  writeAccessLog([
    line('recovered.example', 502, 0.02, 300),
    line('recovered.example', 200, 0.05, 30),
    line('ancient.example', 502, 0.02, 24 * 3600),
  ]);
  const hosts = await problems.scanAccessLog();
  assert.equal(problems.accessVerdict(hosts, 'recovered.example'), null);
  assert.equal(problems.accessVerdict(hosts, 'ancient.example'), null);
});

test('an unreadable access log is not an error — it is just no evidence', async () => {
  fs.rmSync(ACCESS_LOG, { force: true });
  problems._resetAccessCacheForTest();
  const hosts = await problems.scanAccessLog();
  assert.equal(hosts, null);
  const res = await problems.list();
  assert.equal(res.summary.access_log, 'unavailable');
});

// ─── Assembly ───────────────────────────────────────────

test('entry_down: the reason comes from the log, the fallback from the monitoring', async () => {
  writeAccessLog([line('down.example', 502, 0.02)]);
  const refusedId = insertRoute({ domain: 'down.example', external_enabled: 1 });
  const monitoredId = insertRoute({ domain: 'mon.example', monitoring_enabled: 1, monitoring_status: 'down' });
  const okId = insertRoute({ domain: 'ok.example' });

  const res = await problems.list();
  const refused = byId(res.problems, 'entry:' + refusedId);
  assert.ok(refused, 'the refused entry is a problem');
  assert.equal(refused.kind, 'entry_down');
  assert.equal(refused.reason, 'refused');
  assert.equal(refused.evidence, 'access_log');
  assert.equal(refused.severity, 'error', 'a public entry is an error');

  const monitored = byId(res.problems, 'entry:' + monitoredId);
  assert.ok(monitored);
  assert.equal(monitored.reason, null, 'the monitoring does not know the reason');
  assert.equal(monitored.evidence, 'monitor');
  assert.equal(monitored.severity, 'warning', 'an internal entry is a warning');

  assert.equal(byId(res.problems, 'entry:' + okId), undefined);

  db.prepare('DELETE FROM routes WHERE id IN (?, ?, ?)').run(refusedId, monitoredId, okId);
});

test('"nur bei Bedarf" never becomes a problem and carries the Wake-on-LAN hint', async () => {
  writeAccessLog([line('nas.example', 504, 3.0)]);
  const peerId = db.prepare("INSERT INTO peers (name, public_key, allowed_ips, peer_type) VALUES ('gw', 'k1', '10.8.0.9/32', 'gateway')").run().lastInsertRowid;
  db.prepare("INSERT INTO gateway_meta (peer_id, alive, api_token_hash, push_token_encrypted, created_at) VALUES (?, 1, 'h1', 'e1', datetime('now'))").run(peerId);
  const id = insertRoute({
    domain: 'nas.example', on_demand: 1, label: 'SSH DS918+',
    target_kind: 'gateway', target_peer_id: peerId, target_lan_host: '192.168.1.10', target_lan_port: 22,
    target_ip: '127.0.0.1', target_port: 22, route_type: 'l4', l4_protocol: 'tcp', l4_listen_port: 2023,
  });

  license._overrideForTest({ gateway_wol: true });
  const res = await problems.list();
  assert.equal(byId(res.problems, 'entry:' + id), undefined, 'not in the problems list');
  const note = byId(res.on_demand, 'entry:' + id);
  assert.ok(note, 'listed as a note instead');
  assert.equal(note.kind, 'on_demand');
  assert.equal(note.reason, 'unreachable');
  assert.equal(note.entry.label, 'SSH DS918+');
  assert.equal(note.entry.on_demand, true);
  assert.deepEqual(note.wol, { licensed: true, enabled: false, mac: null });

  license._overrideForTest({ gateway_wol: false });
  const res2 = await problems.list();
  assert.equal(byId(res2.on_demand, 'entry:' + id).wol.licensed, false);

  db.prepare('DELETE FROM routes WHERE id = ?').run(id);
  db.prepare('DELETE FROM gateway_meta WHERE peer_id = ?').run(peerId);
  db.prepare('DELETE FROM peers WHERE id = ?').run(peerId);
});

test('an offline gateway is one row and swallows the entries behind it', async () => {
  writeAccessLog([]);
  const peerId = db.prepare("INSERT INTO peers (name, public_key, allowed_ips, peer_type, enabled) VALUES ('gw-off', 'k2', '10.8.0.10/32', 'gateway', 1)").run().lastInsertRowid;
  db.prepare("INSERT INTO gateway_meta (peer_id, alive, went_down_at, api_token_hash, push_token_encrypted, created_at) VALUES (?, 0, ?, 'h2', 'e2', datetime('now'))").run(peerId, Date.now() - 600000);
  const a = insertRoute({ domain: 'a.example', target_kind: 'gateway', target_peer_id: peerId, target_ip: '127.0.0.1', monitoring_enabled: 1, monitoring_status: 'down' });
  const b = insertRoute({ domain: 'b.example', target_kind: 'gateway', target_peer_id: peerId, target_ip: '127.0.0.1', monitoring_enabled: 1, monitoring_status: 'down' });

  const res = await problems.list();
  const row = byId(res.problems, 'gateway:' + peerId);
  assert.ok(row);
  assert.equal(row.kind, 'gateway_offline');
  assert.equal(row.severity, 'error');
  assert.equal(row.gateway.entries, 2);
  assert.equal(row.href, '/gateways');
  assert.ok(row.since);
  assert.equal(byId(res.problems, 'entry:' + a), undefined, 'no duplicate per entry');
  assert.equal(byId(res.problems, 'entry:' + b), undefined);

  db.prepare('DELETE FROM routes WHERE id IN (?, ?)').run(a, b);
  db.prepare('DELETE FROM gateway_meta WHERE peer_id = ?').run(peerId);
  db.prepare('DELETE FROM peers WHERE id = ?').run(peerId);
});

test('certificates, off-site backups and the auto-update marker become rows', async () => {
  writeAccessLog([]);
  // A paused host only exists together with the HTTPS entry it belongs to
  // (tlsGuard.listStatus builds its universe from the routes).
  const tlsRouteId = insertRoute({ domain: 'paused.example' });
  db.prepare(`INSERT INTO tls_status (host, state, attempts, last_error_code, paused_at, paused_reason)
              VALUES ('paused.example', 'paused', 5, 'rateLimited', datetime('now'), 'dns_mismatch')`).run();
  db.prepare(`INSERT INTO backup_targets (name, type, config_enc, enabled, last_run_at, last_status, created_at)
              VALUES ('NAS', 'sftp', 'x', 1, datetime('now'), 'failed', datetime('now'))`).run();

  const res = await problems.list();
  const tls = res.problems.find((p) => p.kind === 'tls_paused');
  assert.ok(tls, 'the paused host is a row');
  assert.equal(tls.tls.host, 'paused.example');
  assert.equal(tls.tls.paused_reason, 'dns_mismatch');
  assert.equal(tls.href, '/certificates');

  const backup = res.problems.find((p) => p.kind === 'backup_failed');
  assert.ok(backup);
  assert.equal(backup.backup.name, 'NAS');
  assert.equal(backup.href, '/settings#backup');

  db.prepare('DELETE FROM routes WHERE id = ?').run(tlsRouteId);
  db.prepare("DELETE FROM tls_status WHERE host = 'paused.example'").run();
  db.prepare("DELETE FROM backup_targets WHERE name = 'NAS'").run();
});

test('a rolled-back update is reported with its version', async () => {
  const autoUpdate = require('../src/services/autoUpdate');
  fs.mkdirSync(path.dirname(autoUpdate.STATE_FILE), { recursive: true });
  fs.writeFileSync(autoUpdate.STATE_FILE, JSON.stringify({
    checked_at: new Date().toISOString(), action: 'rolled_back', mode: 'auto', bad_version: '1.128.0',
  }));
  const res = await problems.list();
  const row = res.problems.find((p) => p.kind === 'update_rolled_back');
  assert.ok(row);
  assert.equal(row.severity, 'warning');
  assert.equal(row.update.bad_version, '1.128.0');
  assert.equal(row.href, '/dashboard#auto-update');
  fs.rmSync(autoUpdate.STATE_FILE, { force: true });
});

test('problems are sorted: errors first, gateways before entries', async () => {
  writeAccessLog([line('sorted.example', 502, 0.02)]);
  const peerId = db.prepare("INSERT INTO peers (name, public_key, allowed_ips, peer_type) VALUES ('gw-sort', 'k3', '10.8.0.11/32', 'gateway')").run().lastInsertRowid;
  db.prepare("INSERT INTO gateway_meta (peer_id, alive, api_token_hash, push_token_encrypted, created_at) VALUES (?, 0, 'h3', 'e3', datetime('now'))").run(peerId);
  const id = insertRoute({ domain: 'sorted.example', external_enabled: 1 });

  const res = await problems.list();
  const kinds = res.problems.map((p) => p.kind);
  assert.equal(kinds[0], 'gateway_offline');
  assert.ok(kinds.includes('entry_down'));
  const severities = res.problems.map((p) => p.severity);
  assert.deepEqual(severities.slice().sort((a, b) => (a === 'error' ? -1 : 1) - (b === 'error' ? -1 : 1)), severities);

  db.prepare('DELETE FROM routes WHERE id = ?').run(id);
  db.prepare('DELETE FROM gateway_meta WHERE peer_id = ?').run(peerId);
  db.prepare('DELETE FROM peers WHERE id = ?').run(peerId);
});

// ─── API ────────────────────────────────────────────────

test('GET /api/v1/dashboard/problems returns the documented shape', async () => {
  writeAccessLog([line('api.example', 502, 0.02)]);
  const id = insertRoute({ domain: 'api.example', external_enabled: 1, label: 'Nextcloud' });
  const res = await agent.get('/api/v1/dashboard/problems').expect(200);
  assert.equal(res.body.ok, true);
  assert.ok(res.body.generated_at);
  assert.ok(Array.isArray(res.body.problems));
  assert.ok(Array.isArray(res.body.on_demand));
  assert.equal(typeof res.body.summary.total, 'number');
  assert.equal(typeof res.body.summary.error, 'number');
  assert.equal(typeof res.body.summary.warning, 'number');
  assert.equal(res.body.summary.access_log, 'ok');
  const row = byId(res.body.problems, 'entry:' + id);
  assert.ok(row);
  assert.equal(row.entry.label, 'Nextcloud');
  assert.equal(row.entry.proto, 'HTTPS');
  assert.ok(row.href.startsWith('/routes'));
  db.prepare('DELETE FROM routes WHERE id = ?').run(id);
});

test('the endpoint needs a session', async () => {
  const supertest = require('supertest');
  const { createApp } = require('../src/app');
  await supertest(createApp()).get('/api/v1/dashboard/problems').expect(401);
});
