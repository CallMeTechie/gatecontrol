'use strict';

// Logs & Monitoring (FEATURES.md "Logs & Monitoring"): every source as one
// stream (services/logEvents.js), problems (services/logProblems.js), export
// (services/logExport.js) and the API below /api/v1/logs (routes/api/logsHub.js):
//   - search syntax, merge by time, cursor paging across sources, facets,
//     KPI tiles, entries by id
//   - rights: admin session all sources; a token with the `logs` right only
//     activity, access, sessions (server/plugins → 403); problems and saved
//     views admin session only; members 403
//   - problems: grouped by code across plugins, normalised messages, status,
//     "returned", correlation, notification through the activity log
//   - export: csv/json/ndjson/log, columns, privacy (IP, e-mail, user names),
//     time zone, licence gate of activity/access, error report ZIP
//   - the page: template, island, pure helpers of public/js/logs.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const argon2 = require('argon2');
const supertest = require('supertest');

// Caddy's access log of this file (before config/default is loaded).
const caddyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-test-lghub-caddy-'));
process.env.GC_CADDY_DATA_DIR = caddyDir;
const { setup, teardown, getAgent } = require('./helpers/setup');

const ROOT = path.join(__dirname, '..');
const NOW = Date.now();
const T0 = NOW - 3600e3; // all fixtures within the last hour
let app;
let db;
let tokens;
let logDir;

const sq = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const line = (o) => JSON.stringify({ pid: 1, hostname: 'h', ...o }) + '\n';

function fixtures() {
  logDir = process.env.GC_SERVER_LOG_DIR;
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(path.join(logDir, 'server.log'), [
    line({ level: 30, time: T0 + 1000, msg: 'host started' }),
    line({ level: 50, time: T0 + 10000, plugin: 'gatecontrol-door', phase: 'statement', msg: 'plugin storage timed out — worker restarted' }),
    line({ level: 40, time: T0 + 11000, blockedMs: 6412, msg: 'event loop was blocked' }),
    line({ level: 50, time: T0 + 70000, plugin: 'gatecontrol-door', phase: 'statement', msg: 'plugin storage timed out — worker restarted' }),
    line({ level: 40, time: T0 + 71000, blockedMs: 2100, msg: 'event loop was blocked' }),
    line({ level: 20, time: T0 + 200000, msg: 'debug noise' }),
    line({ level: 40, time: T0 + 300000, msg: 'mail from anna@example.org via 203.0.113.24 for alice-user' }),
  ].join(''));
  const ins = db.prepare('INSERT INTO plugin_logs (plugin_id, level, message, created_at) VALUES (?, ?, ?, ?)');
  ins.run('gatecontrol-door', 'warn', 'background step failed: nukilog storage timeout', T0 + 10500);
  ins.run('gatecontrol-mail', 'warn', 'folder sync failed (Konto 1): storage timeout', T0 + 10600);
  ins.run('gatecontrol-mail', 'warn', 'pim step failed (Konto 1): storage timeout', T0 + 70500);
  ins.run('gatecontrol-mail', 'info', 'sync done', T0 + 400000);
  db.prepare('DELETE FROM activity_log').run();
  const act = db.prepare('INSERT INTO activity_log (event_type, message, source, ip_address, severity, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  act.run('login_failed', 'Failed login for user: alice-user', 'system', '203.0.113.24', 'warning', sq(T0 + 500000));
  act.run('peer_created', 'Peer created: laptop', 'admin', null, 'success', sq(T0 + 510000));
  fs.writeFileSync(path.join(caddyDir, 'access.log'), [
    { ts: (T0 + 600000) / 1000, request: { method: 'GET', host: 'nas.example.com', uri: '/', remote_ip: '198.51.100.7', headers: {} }, status: 200, duration: 0.01 },
    { ts: (T0 + 601000) / 1000, request: { method: 'GET', host: 'nas.example.com', uri: '/x', remote_ip: '198.51.100.7', headers: {} }, status: 502, duration: 0.02 },
  ].map((o) => JSON.stringify(o)).join('\n') + '\n');
}

async function loginAs(username, role) {
  const hash = await argon2.hash('Plain!Pass1234', require('../src/utils/argon2Options'));
  db.prepare('INSERT INTO users (username, password_hash, role, self_service_enabled) VALUES (?, ?, ?, ?)').run(username, hash, role, role === 'user' ? 1 : 0);
  const a = supertest.agent(app);
  const page = await a.get('/login').expect(200);
  const csrf = page.text.match(/name="_csrf"\s+value="([^"]+)"/)[1];
  await a.post('/login').type('form').send({ username, password: 'Plain!Pass1234', _csrf: csrf }).expect(302);
  return a;
}
const token = (scopes) => tokens.create({ name: `lghub-${crypto.randomBytes(3).toString('hex')}`, scopes }, '127.0.0.1').rawToken;
const range = `from=${T0}&to=${NOW}`;

before(async () => {
  const ctx = await setup();
  app = ctx.app;
  db = require('../src/db/connection').getDb();
  tokens = require('../src/services/tokens');
  if (!db.prepare("SELECT 1 FROM users WHERE username = 'alice-user'").get()) {
    db.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('alice-user', 'Alice Example', 'x', 'user')").run();
  }
  fixtures();
});
after(() => teardown());

describe('logEvents: search syntax', () => {
  const E = () => require('../src/services/logEvents');
  it('words, "phrases", -words, key:value, -level', () => {
    const s = E().parseSearch('plugin:mail -debug "storage timeout" sync -source:server foo:bar');
    assert.deepEqual(s.words, ['sync', 'foo:bar']);
    assert.deepEqual(s.phrases, ['storage timeout']);
    assert.deepEqual(s.notLevels, ['debug']);
    assert.deepEqual(s.keyed, [{ key: 'plugin', value: 'mail', neg: false }, { key: 'source', value: 'server', neg: true }]);
    const e = { msg: 'folder sync failed: storage timeout', ctx: '', fields: {}, source: 'plugins', plugin: 'gatecontrol-mail', pluginName: 'Mail', level: 'warn', code: 'storage_timeout' };
    assert.equal(E().matchSearch(e, E().parseSearch('plugin:mail "storage timeout" sync')), true);
    assert.equal(E().matchSearch(e, E().parseSearch('-warn')), false);
    assert.equal(E().matchSearch(e, E().parseSearch('-plugin:mail')), false);
    assert.equal(E().matchSearch(e, E().parseSearch('-sync')), false);
    assert.equal(E().matchSearch(e, E().parseSearch('code:storage')), true);
  });
  it('known codes', () => {
    const c = E().codeOf;
    assert.equal(c('plugin storage timed out — worker restarted'), 'storage_worker_restarted');
    assert.equal(c('x: storage timeout'), 'storage_timeout');
    assert.equal(c('event loop was blocked'), 'event_loop_blocked');
    assert.equal(c('slow plugin database statements'), 'slow_plugin_db');
    assert.equal(c('data disk is slow to write — see Logs & Monitoring'), 'slow_disk');
    assert.equal(c('plugin did not start in time'), 'plugin_start_timeout');
    assert.equal(c('fetch failed', { err: { code: 'ECONNRESET' } }), 'ECONNRESET');
    assert.equal(c('socket hang up ERR_NET_X'), 'ERR_NET_X');
    assert.equal(c('all fine'), null);
  });
});

describe('GET /api/v1/logs/events', () => {
  it('merges every source newest first with ids, levels and context', async () => {
    const r = await getAgent().get(`/api/v1/logs/events?${range}&limit=50`).expect(200);
    const src = r.body.entries.map((e) => e.source);
    for (const s of ['server', 'plugins', 'activity', 'access']) assert.ok(src.includes(s), s);
    const ts = r.body.entries.map((e) => e.ts);
    assert.deepEqual(ts, ts.slice().sort((a, b) => b - a));
    const access = r.body.entries.find((e) => e.source === 'access' && e.level === 'error');
    assert.match(access.msg, /GET nas\.example\.com\/x → 502/);
    assert.match(access.id, /^h\.\d+\.[0-9a-f]{12}$/);
    const act = r.body.entries.find((e) => e.source === 'activity' && e.level === 'warn');
    assert.equal(act.code, 'login_failed');
    assert.equal(r.body.entries.find((e) => e.levelName === 'success').level, 'info');
  });

  it('filters level, source, plugin, problem; cursor pages are exact', async () => {
    const get = async (q) => (await getAgent().get(`/api/v1/logs/events?${range}&${q}`).expect(200)).body;
    assert.ok((await get('level=error')).entries.every((e) => e.level === 'error'));
    assert.ok((await get('source=plugins')).entries.every((e) => e.source === 'plugins'));
    assert.deepEqual((await get('plugin=gatecontrol-door')).entries.map((e) => e.source).sort(), ['plugins', 'server', 'server']);
    assert.equal((await get('problem=' + encodeURIComponent('c:storage_timeout'))).entries.length, 3);
    const all = (await get('limit=500')).entries.map((e) => e.id);
    const seen = [];
    let before = '';
    for (let i = 0; i < 50; i++) {
      const p = await get(`limit=3${before ? '&before=' + before : ''}`);
      seen.push(...p.entries.map((e) => e.id));
      if (!p.next) break;
      before = p.next;
    }
    assert.deepEqual(seen, all);
  });

  it('one entry by id with fields, raw data and its problem', async () => {
    const list = (await getAgent().get(`/api/v1/logs/events?${range}&source=server&q=${encodeURIComponent('code:event_loop_blocked')}`).expect(200)).body.entries;
    assert.equal(list.length, 2);
    const r = await getAgent().get('/api/v1/logs/events/item?id=' + list[0].id).expect(200);
    assert.equal(r.body.entry.fields.blockedMs, 2100);
    assert.equal(r.body.entry.raw.msg, 'event loop was blocked');
    assert.deepEqual(r.body.problem, { key: 'c:event_loop_blocked' });
    assert.equal((await getAgent().get('/api/v1/logs/events/item?id=s.1.0000000000')).status, 404);
    assert.equal((await getAgent().get('/api/v1/logs/events/item?id=../../etc')).status, 404);
  });

  it('stats: facets ignore their own filter, histogram, KPI tiles', async () => {
    const r = (await getAgent().get(`/api/v1/logs/events/stats?${range}&level=error&source=server&bucket=1h`).expect(200)).body;
    assert.equal(r.total, 2);
    assert.equal(r.counts.levels.warn, 3, 'levels of the server source');
    assert.equal(r.counts.sources.access, 1, 'errors of the access log');
    assert.equal(r.kpi.blocked.count, 2);
    assert.equal(r.kpi.blocked.maxMs, 6412);
    assert.deepEqual(r.kpi.http, { total: 2, errors: 1 });
    assert.equal(r.kpi.topWarning.code, 'storage_timeout');
    assert.ok(r.kpi.plugins.withErrors.some((p) => p.id === 'gatecontrol-mail'));
    assert.equal(r.kpi.errorsBefore, 0);
    assert.equal(r.histogram.bucketMs, 3600e3);
    assert.equal(r.histogram.buckets.reduce((n, b) => n + b.error, 0), 2);
  });

  it('400 for invalid filters', async () => {
    for (const q of ['level=loud', 'source=disk', 'plugin=../x', 'before=abc', 'limit=501', 'from=soon']) {
      const r = await getAgent().get('/api/v1/logs/events?' + q);
      assert.equal(r.status, 400, q);
      assert.equal(r.body.code, 'INVALID_QUERY');
    }
  });
});

describe('plugin entries: the version that wrote them', () => {
  // A plugin updated since: an entry shows the version it was written with
  // (plugin_logs.plugin_version, migration 122), never the one installed now;
  // entries from before have none.
  const E = () => require('../src/services/logEvents');
  const registry = () => require('../src/services/plugins/registry');
  before(() => {
    db.prepare(`INSERT INTO plugins (id, name, version, publisher, manifest, signature, enabled)
      VALUES ('lghub-ver', 'Mail', '1.7.1', 'T', ?, 'trusted', 0)`).run(JSON.stringify({ id: 'lghub-ver', name: { de: 'Mail', en: 'Mail' }, version: '1.7.1' }));
    E().resetCaches();
  });
  after(() => { db.prepare("DELETE FROM plugins WHERE id = 'lghub-ver'").run(); registry().remove('lghub-ver'); E().resetCaches(); });

  it('addLog stores the given version, else the installed one', () => {
    registry().addLog('lghub-ver', 'warn', 'written by the old process', '1.7.0');
    registry().addLog('lghub-ver', 'info', 'written by the host');
    const rows = db.prepare("SELECT message, plugin_version FROM plugin_logs WHERE plugin_id = 'lghub-ver' ORDER BY id").all();
    assert.deepEqual(rows.map((r) => r.plugin_version), ['1.7.0', '1.7.1']);
  });

  it('list, detail and export: stored version or none — not the installed one', async () => {
    const ins = db.prepare('INSERT INTO plugin_logs (plugin_id, level, message, created_at, plugin_version) VALUES (?, ?, ?, ?, ?)');
    const oldId = ins.run('lghub-ver', 'warn', 'lghub-ver entry of 1.7.0', T0 + 20000, '1.7.0').lastInsertRowid;
    const legacyId = ins.run('lghub-ver', 'warn', 'lghub-ver entry before the column', T0 + 21000, null).lastInsertRowid;
    const list = (await getAgent().get(`/api/v1/logs/events?${range}&plugin=lghub-ver&q=entry`).expect(200)).body.entries;
    const byId = Object.fromEntries(list.map((e) => [e.id, e]));
    assert.equal(byId[`p.${oldId}`].ctx, 'Mail 1.7.0');
    assert.equal(byId[`p.${legacyId}`].ctx, 'Mail');
    let item = (await getAgent().get(`/api/v1/logs/events/item?id=p.${oldId}`).expect(200)).body.entry;
    assert.equal(item.fields.version, '1.7.0');
    item = (await getAgent().get(`/api/v1/logs/events/item?id=p.${legacyId}`).expect(200)).body.entry;
    assert.equal(item.fields.version, null);
    assert.equal(item.ctx, 'Mail');
    const nd = (await getAgent().get(`/api/v1/logs/events/export?format=ndjson&${range}&plugin=lghub-ver&q=entry`)
      .buffer(true).parse((res, cb) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); })
      .expect(200)).body.toString();
    assert.ok(!nd.includes('1.7.1'), nd);
    assert.match(nd, /1\.7\.0/);
  });
});

describe('rights', () => {
  it('a token with the logs right reads activity, access and sessions only', async () => {
    const t = token(['logs']);
    const meta = await supertest(app).get('/api/v1/logs/meta').set('X-API-Token', t).expect(200);
    assert.deepEqual(meta.body.sources, ['activity', 'access', 'sessions']);
    assert.equal(meta.body.admin, false);
    const r = await supertest(app).get(`/api/v1/logs/events?${range}&limit=100`).set('X-API-Token', t).expect(200);
    assert.ok(r.body.entries.length > 0);
    assert.ok(r.body.entries.every((e) => ['activity', 'access', 'sessions'].includes(e.source)));
    for (const q of ['source=server', 'source=plugins,activity']) {
      const f = await supertest(app).get('/api/v1/logs/events?' + q).set('X-API-Token', t);
      assert.equal(f.status, 403, q);
      assert.equal(f.body.code, 'SOURCE_FORBIDDEN');
    }
    const serverItem = (await getAgent().get(`/api/v1/logs/events?${range}&source=server&limit=1`)).body.entries[0];
    assert.equal((await supertest(app).get('/api/v1/logs/events/item?id=' + serverItem.id).set('X-API-Token', t)).status, 404);
    const st = await supertest(app).get(`/api/v1/logs/events/stats?${range}`).set('X-API-Token', t).expect(200);
    assert.deepEqual(Object.keys(st.body.counts.sources), ['activity', 'access', 'sessions']);
    assert.equal(st.body.kpi.blocked.count, 0, 'no server data in the tiles');
    for (const url of ['/api/v1/logs/problems', '/api/v1/logs/saved', `/api/v1/logs/events/export?scope=report&${range}`]) {
      assert.equal((await supertest(app).get(url).set('X-API-Token', t)).status, 403, url);
    }
  });

  it('a token without the logs right and a member get nothing', async () => {
    assert.equal((await supertest(app).get('/api/v1/logs/events').set('X-API-Token', token(['peers']))).status, 403);
    const member = await loginAs(`lghub-m-${crypto.randomBytes(3).toString('hex')}`, 'user');
    for (const url of ['/api/v1/logs/meta', '/api/v1/logs/events', '/api/v1/logs/problems', '/api/v1/logs/events/export']) {
      assert.equal((await member.get(url)).status, 403, url);
    }
    assert.equal((await supertest(app).get('/api/v1/logs/events')).status, 401);
  });
});

describe('problems', () => {
  const P = () => require('../src/services/logProblems');
  it('normalised messages', () => {
    assert.equal(P().normalise('Peer "laptop" disabled after 3 tries from 10.0.0.1 /a/b/c'), 'peer "…" disabled after # tries from <ip> <path>');
    assert.equal(P().keyOf({ source: 'plugins', code: null, msg: 'Sync 12 failed' }), P().keyOf({ source: 'server', code: null, msg: 'sync 99 failed' }));
    assert.equal(P().keyOf({ source: 'access', fields: { status: 200 } }), null);
  });

  it('groups errors and warnings of every source by code, with counts, sources, spark', async () => {
    const r = (await getAgent().get(`/api/v1/logs/problems?${range}`).expect(200)).body;
    const st = r.problems.find((p) => p.key === 'c:storage_timeout');
    assert.equal(st.count, 3);
    assert.deepEqual(st.plugins, { 'gatecontrol-door': 1, 'gatecontrol-mail': 2 });
    assert.equal(st.kinds, 3);
    assert.equal(st.known, true);
    assert.equal(st.spark.reduce((a, b) => a + b, 0), 3);
    assert.equal(st.flags.new, true);
    assert.ok(r.problems.some((p) => p.key === 'h:502:nas.example.com'));
    assert.ok(r.problems.some((p) => p.key === 'c:login_failed'));
    assert.ok(!r.problems.some((p) => p.key.includes('debug noise')), 'only warnings and errors');
    assert.equal(r.counts.open, r.problems.length);
  });

  it('correlation: storage restarts fall together with a blocked server', async () => {
    const r = (await getAgent().get(`/api/v1/logs/problems/item?key=${encodeURIComponent('c:storage_worker_restarted')}&${range}`).expect(200)).body.problem;
    const c = r.correlations.find((x) => x.key === 'c:event_loop_blocked');
    assert.ok(c, JSON.stringify(r.correlations));
    assert.deepEqual([c.hits, c.of], [2, 2]);
    assert.equal(r.times, undefined, 'internal times stay inside');
  });

  it('status: resolved, returned, notification through the activity log; muted', async () => {
    const put = (body) => getAgent().put('/api/v1/logs/problems/state').set('X-CSRF-Token', require('./helpers/setup').getCsrf()).send(body);
    assert.equal((await put({ key: 'x', status: 'open' })).status, 400);
    assert.equal((await put({ key: 'c:event_loop_blocked', status: 'gone' })).status, 400);
    assert.equal((await put({ key: 'c:event_loop_blocked', status: 'resolved', notifyOnReturn: true, title: 'Server war blockiert' })).status, 200);
    let r = (await getAgent().get(`/api/v1/logs/problems?status=resolved&${range}`).expect(200)).body;
    assert.ok(r.problems.some((p) => p.key === 'c:event_loop_blocked'));
    // A new occurrence after "resolved" → open again, flagged returned, one notification.
    fs.appendFileSync(path.join(logDir, 'server.log'), line({ level: 40, time: Date.now() + 5, blockedMs: 3000, msg: 'event loop was blocked' }));
    await new Promise((res) => setTimeout(res, 20));
    r = (await getAgent().get(`/api/v1/logs/problems?status=open&from=${T0}`).expect(200)).body;
    const p = r.problems.find((x) => x.key === 'c:event_loop_blocked');
    assert.equal(p.flags.returned, true);
    assert.equal(await P().checkReturns(), 1);
    assert.equal(await P().checkReturns(), 0, 'once');
    const row = db.prepare("SELECT * FROM activity_log WHERE event_type = 'log_problem_returned'").get();
    assert.match(row.message, /Server war blockiert/);
    assert.equal(row.severity, 'warning');
    const n = require('../src/services/notifications');
    assert.ok(n.CATALOGUE.flatMap((g) => g.events).some((e) => e.id === 'log_problem' && e.types.includes('log_problem_returned')));
    assert.equal((await put({ key: 'c:login_failed', status: 'muted' })).body.state.status, 'muted');
    r = (await getAgent().get(`/api/v1/logs/problems?status=muted&${range}`).expect(200)).body;
    assert.ok(r.problems[0].mutedUntil);
  });
});

describe('export', () => {
  const X = () => require('../src/services/logExport');
  const get = (q) => getAgent().get('/api/v1/logs/events/export?' + q).buffer(true)
    .parse((res, cb) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });

  it('privacy: IPs, e-mail addresses, user names', () => {
    const m = X().masker({ maskIp: true, maskEmail: true, pseudonymize: true });
    const id = db.prepare("SELECT id FROM users WHERE username = 'alice-user'").get().id;
    assert.deepEqual(m({ a: 'from 203.0.113.24 and 2001:db8:85a3:0:0:8a2e:370:7334', b: ['anna@example.org'], c: { u: 'Failed login for user: alice-user (Alice Example)' } }), {
      a: 'from 203.0.113.x and 2001:db8:85a3::x', b: ['a***@example.org'], c: { u: `Failed login for user: user-${id} (user-${id})` },
    });
    assert.equal(X().masker({})('203.0.113.24'), '203.0.113.24');
  });

  it('time zones', () => {
    assert.equal(X().timeFormatter('utc')(Date.UTC(2026, 10, 2, 6, 28, 29, 412)), '2026-11-02T06:28:29.412Z');
    assert.equal(X().timeFormatter('Europe/Berlin')(Date.UTC(2026, 10, 2, 6, 28, 29, 412)), '2026-11-02 07:28:29.412 UTC+1');
    assert.equal(X().validTimeZone('Mars/Base'), false);
  });

  it('csv, json, ndjson and log of the view, filtered, with columns', async () => {
    const csv = await get(`scope=view&format=csv&${range}&level=error&source=server&columns=time,level,source,message&tz=utc`).expect(200);
    assert.match(csv.headers['content-type'], /^text\/csv/);
    assert.match(csv.headers['content-disposition'], /^attachment; filename="gatecontrol-logs_\d{8}-\d{4}_\d{8}-\d{4}\.csv"$/);
    const rows = csv.body.toString().trim().split('\n');
    assert.equal(rows[0], 'time,level,source,message');
    assert.equal(rows.length, 3);
    assert.match(rows[1], /^\d{4}-\d{2}-\d{2}T[\d:.]+Z,error,server,plugin storage timed out — worker restarted$/);
    const json = JSON.parse((await get(`format=json&${range}&source=plugins&columns=time,source,message,fields`).expect(200)).body.toString());
    assert.equal(json.length, 4);
    assert.equal(json[0].plugin, 'gatecontrol-mail');
    assert.equal(json[0].level, undefined, 'not a chosen column');
    const nd = (await get(`format=ndjson&${range}&source=access`).expect(200)).body.toString().trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(nd.length, 2);
    const log = (await get(`format=log&${range}&q=${encodeURIComponent('"anna@"')}&mask_ip=1&mask_email=1`).expect(200)).body.toString();
    assert.match(log, /WARN {2}\[server\] mail from a\*\*\*@example\.org via 203\.0\.113\.x for alice-user/);
  });

  it('selection, problem and window scopes', async () => {
    const list = (await getAgent().get(`/api/v1/logs/events?${range}&source=plugins&limit=2`)).body.entries;
    const sel = JSON.parse((await get(`scope=selection&format=json&ids=${list.map((e) => e.id).join(',')}`).expect(200)).body.toString());
    assert.deepEqual(sel.map((e) => e.message), list.map((e) => e.msg));
    const prob = JSON.parse((await get(`scope=problem&format=json&problem=${encodeURIComponent('c:storage_timeout')}&${range}`).expect(200)).body.toString());
    assert.equal(prob.length, 3);
    const blocked = (await getAgent().get(`/api/v1/logs/events?${range}&source=server&q=code:event_loop_blocked`)).body.entries;
    const win = JSON.parse((await get(`scope=window&format=json&around=${blocked[blocked.length - 1].id}&window=10`).expect(200)).body.toString());
    assert.deepEqual(win.map((e) => e.message).sort(), ['background step failed: nukilog storage timeout', 'event loop was blocked', 'folder sync failed (Konto 1): storage timeout',
      'host started', 'plugin storage timed out — worker restarted'].sort(), 'all sources and levels ±10 s');
    assert.equal((await get('scope=selection&ids=../x')).status, 400);
  });

  it('preview: first rows, count, size; note in the activity log', async () => {
    const p = (await getAgent().get(`/api/v1/logs/events/export/preview?format=csv&${range}&source=server`).expect(200)).body;
    assert.equal(p.count, 7);
    assert.equal(p.lines.length, 6, 'six rows of preview');
    assert.ok(p.bytes > 100);
    assert.equal(p.header, 'time,level,source,message,fields');
    await get(`format=log&${range}&source=server&note=1`).expect(200);
    await new Promise((r) => setTimeout(r, 20));
    const row = db.prepare("SELECT * FROM activity_log WHERE event_type = 'logs_exported' ORDER BY id DESC").get();
    assert.match(row.message, /Logs exported: view, log, 7 entries/);
  });

  it('licence: activity and access exports need log_export, the rest stays free', async () => {
    const license = require('../src/services/license');
    license._overrideForTest({ log_export: false });
    try {
      const r = await getAgent().get(`/api/v1/logs/events/export?format=csv&${range}&source=server,activity`);
      assert.equal(r.status, 403);
      assert.equal(r.body.code, 'LICENSE_LOG_EXPORT');
      assert.deepEqual(r.body.locked, ['activity']);
      await get(`format=csv&${range}&source=server,plugins,sessions`).expect(200);
      assert.equal((await getAgent().get('/api/v1/logs/activity/export?format=json')).status, 403, 'the old export keeps its gate');
    } finally {
      license._overrideForTest({ log_export: true });
    }
  });

  it('error report: a ZIP with README, problems and examples with surroundings', async () => {
    const r = await get(`scope=report&${range}&mask_ip=1`).expect(200);
    assert.equal(r.headers['content-type'], 'application/zip');
    const buf = r.body;
    assert.equal(buf.readUInt32LE(0), 0x04034b50);
    const names = [];
    let off = 0;
    const files = {};
    while (buf.readUInt32LE(off) === 0x04034b50) {
      const comp = buf.readUInt32LE(off + 18);
      const nlen = buf.readUInt16LE(off + 26);
      const name = buf.slice(off + 30, off + 30 + nlen).toString();
      names.push(name);
      files[name] = zlib.inflateRawSync(buf.slice(off + 30 + nlen, off + 30 + nlen + comp)).toString();
      off += 30 + nlen + comp;
    }
    assert.deepEqual(names.slice(0, 3), ['README.txt', 'problems.json', 'versions.json']);
    assert.ok(names.some((n) => /^problems\/\d\d-storage-timeout\.ndjson$/.test(n)), names.join());
    assert.match(files['README.txt'], /GateControl \d+\.\d+\.\d+/);
    const ex = files[names.find((n) => /storage-timeout/.test(n))].trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(ex.length >= 1 && ex.length <= 10);
    assert.ok(ex[0].around.some((a) => a.self));
    assert.ok(!files['problems.json'].includes('203.0.113.24'));
  });

  it('the ZIP writer produces archives the inflate side reads back', () => {
    const z = X().zip([{ name: 'a.txt', data: 'hällo' }]);
    assert.equal(z.readUInt32LE(z.length - 22), 0x06054b50);
    assert.equal(zlib.inflateRawSync(z.slice(30 + 5, 30 + 5 + z.readUInt32LE(18))).toString(), 'hällo');
  });
});

describe('saved filters and export templates', () => {
  it('create, list, delete (admin session)', async () => {
    const csrf = require('./helpers/setup').getCsrf();
    const c = await getAgent().post('/api/v1/logs/saved').set('X-CSRF-Token', csrf).send({ kind: 'filter', name: 'Nur Fehler', data: { state: 'level=error', evil: { x: 1 } } }).expect(201);
    assert.deepEqual(c.body.saved.data, { state: 'level=error' }, 'only plain values');
    const l = await getAgent().get('/api/v1/logs/saved').expect(200);
    assert.ok(l.body.saved.some((s) => s.name === 'Nur Fehler' && s.kind === 'filter'));
    assert.equal((await getAgent().post('/api/v1/logs/saved').set('X-CSRF-Token', csrf).send({ kind: 'other', name: 'x', data: {} })).status, 400);
    await getAgent().delete('/api/v1/logs/saved/' + c.body.saved.id).set('X-CSRF-Token', csrf).expect(200);
    assert.equal((await getAgent().delete('/api/v1/logs/saved/' + c.body.saved.id).set('X-CSRF-Token', csrf)).status, 404);
  });
});

describe('page /logs', () => {
  const L = require('../public/js/logs.js');
  it('renders the shell with tabs, island and scripts', async () => {
    const r = await getAgent().get('/logs').expect(200);
    for (const id of ['lg-page', 'lg-range', 'lg-tab-events', 'lg-tab-problems', 'lg-panel-access', 'lg-panel-sessions', 'lg-panel-saved', 'lg-sheet', 'rdp-history-list']) {
      assert.ok(r.text.includes(`id="${id}"`), id);
    }
    assert.match(r.text, /id="lg-i18n" data-prefixes="lg\. common\."/);
    assert.match(r.text, /"lg\.code\.storage_timeout\.text":/);
    assert.match(r.text, /<script src="\/js\/logs\.js/);
  });

  it('a slow data disk: one hint at the top (services/diskHealth.js), none while it writes fast', async () => {
    const diskHealth = require('../src/services/diskHealth');
    diskHealth._resetForTest();
    try {
      let r = await getAgent().get('/logs').expect(200);
      assert.ok(!r.text.includes('id="lg-disk-slow"'));
      for (let i = 0; i < diskHealth.MIN_SAMPLES; i++) diskHealth.addSample(75);
      r = await getAgent().get('/logs').expect(200);
      const m = /<p class="lg-note lg-note-warn" id="lg-disk-slow" role="status">([^<]+)<\/p>/.exec(r.text);
      assert.ok(m, 'hint shown');
      assert.match(m[1], /Ø 75 ms je Schreibvorgang|avg\. 75 ms per write/);
      assert.match(m[1], /SSD/);
      assert.equal(r.text.split('id="lg-disk-slow"').length, 2, 'exactly one');
    } finally { diskHealth._resetForTest(); }
  });

  it('no innerHTML in the page script', () => {
    const src = fs.readFileSync(path.join(ROOT, 'public/js/logs.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
    assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  });

  it('state in the address round-trips, defaults left out', () => {
    const s = L.parseState('range=custom&from=1793600000000&to=1793603600000&level=error&source=server,access&plugin=gatecontrol-mail&q=storage%20timeout&problem=c%3Ax');
    assert.deepEqual(s, { range: 'custom', from: 1793600000000, to: 1793603600000, levels: ['error'], sources: ['server', 'access'], plugins: ['gatecontrol-mail'], q: 'storage timeout', problem: 'c:x' });
    assert.equal(L.stateQuery(L.parseState(L.stateQuery(s))), L.stateQuery(s));
    assert.equal(L.stateQuery(L.parseState('')), '');
    assert.deepEqual(L.parseState('level=loud&source=disk&range=1y').levels, []);
    assert.equal(L.parseState('range=custom').range, '24h', 'custom needs from');
    assert.deepEqual(L.parseHash('#e/s.1.abcdef0123'), { tab: 'events', query: '', entry: 's.1.abcdef0123', problem: null });
    assert.deepEqual(L.parseHash('#problems/c%3Astorage_timeout'), { tab: 'problems', query: '', entry: null, problem: 'c:storage_timeout' });
    assert.equal(L.parseHash('#nonsense').tab, 'events');
  });

  it('collapse and clusters', () => {
    const e = (id, ts, level, source, msg, plugin) => ({ id, ts, level, source, msg, plugin: plugin || null });
    const rows = L.collapse([e('a', 10000, 'warn', 'plugins', 'sync 1 failed', 'm'), e('b', 9000, 'warn', 'plugins', 'sync 2 failed', 'm'), e('c', 8500, 'error', 'server', 'x'),
      e('d', 1000, 'info', 'server', 'y')], true);
    assert.deepEqual(rows.map((r) => [r.entry.id, r.n]), [['a', 2], ['c', 1], ['d', 1]]);
    assert.deepEqual(L.clusters(rows).map((c) => [c.start, c.end, c.n, c.sources]), [[0, 1, 3, 2]]);
    assert.deepEqual(L.clusters(L.collapse([e('a', 10000, 'warn', 'server', 'x'), e('b', 9000, 'warn', 'server', 'y'), e('c', 8000, 'warn', 'server', 'z')], false)), [], 'one source is no cluster');
    assert.equal(L.collapse(rows.map((r) => r.entry), false).length, 3);
  });

  it('helpers: api query, buckets, field filters', () => {
    const s = L.parseState('level=error,warn&q=a');
    assert.equal(L.apiQuery(s, 1e12, { limit: 5 }), 'from=999913600000&level=error%2Cwarn&source=server%2Cplugins%2Cactivity&q=a&limit=5');
    assert.equal(L.bucketTimes(0, 7200e3, 3600e3).length, 3);
    assert.equal(L.fieldFilter('plugin', 'gatecontrol-mail'), 'plugin:gatecontrol-mail');
    assert.equal(L.fieldFilter('phase', 'statement'), '"statement"');
    assert.deepEqual(L.flatFields({ a: 1, err: { message: 'x', stack: 'y' }, n: null }), [['a', 1], ['err.message', 'x'], ['err.stack', 'y']]);
  });
});
