'use strict';

// Server log (Logs & Monitoring, FEATURES.md "Server Log"):
//   - utils/serverLogFile.js: rotation by size, file rights, errors never
//     reach the caller, exit flush, on/off from the environment
//   - utils/logger.js: the same redacted lines on stdout and in the file
//   - services/serverLog.js: level groups, text/field/time filters, cursor
//     paging across rotated files, counts and histogram
//   - GET /api/v1/logs/server(+/export): admin session only (tokens with the
//     `logs` right and members get 403), not behind log_export, formats
//   - the optional activity filters of /api/v1/logs/activity

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const argon2 = require('argon2');
const supertest = require('supertest');
const { setup, teardown, getAgent } = require('./helpers/setup');

const ROOT = path.join(__dirname, '..');
const { RotatingFileStream, resolveOptions, rotationFiles } = require('../src/utils/serverLogFile');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), `gc-test-slog-${p}-`));
// stat through an open descriptor (no check-then-use on the path)
function fstat(p) {
  const fd = fs.openSync(p, 'r');
  try { return fs.fstatSync(fd); } finally { fs.closeSync(fd); }
}
const line = (o) => JSON.stringify({ pid: 1, hostname: 'h', ...o }) + '\n';

describe('serverLogFile: options', () => {
  it('on by default, off under NODE_ENV=test unless asked, GC_SERVER_LOG=off', () => {
    assert.equal(resolveOptions({ GC_DATA_DIR: '/x' }).enabled, true);
    assert.equal(resolveOptions({ GC_DATA_DIR: '/x' }).file, '/x/logs/server.log');
    assert.equal(resolveOptions({ NODE_ENV: 'test' }).enabled, false);
    assert.equal(resolveOptions({ NODE_ENV: 'test', GC_SERVER_LOG: 'on' }).enabled, true);
    for (const v of ['off', 'false', '0', 'no', 'OFF']) assert.equal(resolveOptions({ GC_SERVER_LOG: v }).enabled, false, v);
    const o = resolveOptions({ GC_SERVER_LOG_DIR: '/l', GC_SERVER_LOG_MAX_MB: '2', GC_SERVER_LOG_FILES: '3' });
    assert.deepEqual([o.file, o.maxBytes, o.files], ['/l/server.log', 2 * 1024 * 1024, 3]);
    const bad = resolveOptions({ GC_SERVER_LOG_MAX_MB: 'x', GC_SERVER_LOG_FILES: '999' });
    assert.deepEqual([bad.maxBytes, bad.files], [5 * 1024 * 1024, 20]);
    assert.deepEqual(rotationFiles('/l/s.log', 3), ['/l/s.log', '/l/s.log.1', '/l/s.log.2']);
  });
});

describe('serverLogFile: RotatingFileStream', () => {
  it('writes asynchronously with rights 0600/0700 and rotates by size keeping N files', async () => {
    const dir = path.join(tmp('rot'), 'logs');
    const file = path.join(dir, 'server.log');
    const s = new RotatingFileStream({ file, maxBytes: 1000, files: 3, flushDelayMs: 1 });
    const row = 'x'.repeat(99) + '\n'; // 100 bytes
    for (let i = 0; i < 9; i++) s.write(row);
    assert.deepEqual(fs.readdirSync(path.dirname(dir)), [], 'nothing written synchronously');
    await s.flush();
    const st = fstat(file);
    assert.equal(st.size, 900);
    assert.equal(st.mode & 0o777, 0o600);
    assert.equal(fstat(dir).mode & 0o777, 0o700);
    // 900 + 500 > 1000 → rotate; 500 + 500 fits; and so on (2 rounds per file).
    for (let round = 0; round < 6; round++) {
      for (let i = 0; i < 5; i++) s.write(`r${round}-${i}`.padEnd(99, '.') + '\n');
      await s.flush();
    }
    const names = fs.readdirSync(dir).sort();
    assert.deepEqual(names, ['server.log', 'server.log.1', 'server.log.2'], 'oldest dropped');
    const text = Object.fromEntries(names.map((n) => [n, fs.readFileSync(path.join(dir, n), 'utf8')]));
    for (const n of names) assert.ok(Buffer.byteLength(text[n]) <= 1000, n);
    assert.match(text['server.log'], /^r4-0[^]*r5-4\.+\n$/);
    assert.match(text['server.log.1'], /^r2-0/);
    assert.match(text['server.log.2'], /^r0-0/, 'the first 900 bytes are gone');
    await s.close();
  });

  it('a pre-existing file gets 0600', async () => {
    const dir = tmp('mode');
    const file = path.join(dir, 'server.log');
    fs.writeFileSync(file, '', { mode: 0o644 });
    fs.chmodSync(file, 0o644);
    const s = new RotatingFileStream({ file, maxBytes: 1e6, files: 2, flushDelayMs: 1 });
    s.write('a\n');
    await s.flush();
    assert.equal(fstat(file).mode & 0o777, 0o600);
    await s.close();
  });

  it('errors never reach the caller: reported once, lines counted and noted after recovery', async () => {
    const base = tmp('err');
    const blocker = path.join(base, 'logs');
    fs.writeFileSync(blocker, 'not a directory');
    const file = path.join(blocker, 'server.log');
    const errors = [];
    const s = new RotatingFileStream({ file, maxBytes: 1e6, files: 2, flushDelayMs: 1, onError: (e) => errors.push(e.code) });
    assert.doesNotThrow(() => { s.write(line({ level: 30, time: 1, msg: 'a' })); s.write(line({ level: 30, time: 2, msg: 'b' })); });
    await s.flush();
    await new Promise((r) => setImmediate(r));
    assert.equal(errors.length, 1);
    assert.ok(['ENOTDIR', 'EEXIST'].includes(errors[0]), errors[0]);
    assert.equal(s.dropped, 2);
    // During the pause after a failure lines are dropped, not buffered.
    s.write(line({ level: 30, time: 3, msg: 'c' }));
    assert.equal(s.dropped, 3);
    assert.equal(s.buf.length, 0);
    // The directory becomes writable: the next line carries the note.
    fs.rmSync(blocker);
    s.retryAt = 0;
    s.write(line({ level: 30, time: 4, msg: 'd' }));
    await s.flush();
    const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(rows.length, 2);
    assert.equal(rows[0].level, 40);
    assert.match(rows[0].msg, /3 lines dropped/);
    assert.equal(rows[1].msg, 'd');
    assert.equal(errors.length, 1, 'once per failure streak');
    await s.close();
  });

  it('a full buffer drops instead of growing', () => {
    const s = new RotatingFileStream({ file: path.join(tmp('buf'), 'server.log'), maxBytes: 1e6, files: 2, maxBuffer: 50, flushDelayMs: 1e6 });
    for (let i = 0; i < 10; i++) s.write('0123456789\n');
    assert.ok(s.bufBytes <= 50);
    assert.equal(s.dropped, 6);
    clearTimeout(s.timer);
  });

  it('flushSync writes the rest on exit', () => {
    const dir = path.join(tmp('sync'), 'logs');
    const file = path.join(dir, 'server.log');
    const s = new RotatingFileStream({ file, maxBytes: 1e6, files: 2, flushDelayMs: 1e6 });
    s.write('last words\n');
    s.flushSync();
    assert.equal(fs.readFileSync(file, 'utf8'), 'last words\n');
  });
});

describe('logger: stdout and the file carry the same redacted lines', () => {
  const run = (env, code) => spawnSync(process.execPath, ['-e', code], {
    cwd: ROOT, encoding: 'utf8', timeout: 60000,
    env: { ...process.env, GC_LOG_LEVEL: 'info', NODE_ENV: 'production', GC_SERVER_LOG: '', ...env },
  });

  it('writes both, keeps secrets out, flushes a fatal line before exit', () => {
    const dir = tmp('logger');
    const r = run({ GC_SERVER_LOG_DIR: dir, GC_SERVER_LOG: 'on' },
      "const l=require('./src/utils/logger');l.info({headers:{authorization:'Bearer gc_secret'},plugin:'p'},'hello');l.fatal('bye');process.exit(3)");
    assert.equal(r.status, 3, `status ${r.status} signal ${r.signal} stderr ${r.stderr}`);
    const file = fs.readFileSync(path.join(dir, 'server.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(file.map((o) => o.msg), ['hello', 'bye']);
    assert.equal(file[0].headers.authorization, '[REDACTED]');
    assert.equal(file[1].level, 60);
    const out = r.stdout.trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(out.map((o) => o.msg), ['hello', 'bye'], 'stdout unchanged');
    assert.ok(!r.stdout.includes('gc_secret') && !fs.readFileSync(path.join(dir, 'server.log'), 'utf8').includes('gc_secret'));
  });

  it('GC_SERVER_LOG=off writes no file', () => {
    const dir = tmp('logger-off');
    const r = run({ GC_SERVER_LOG_DIR: dir, GC_SERVER_LOG: 'off' }, "require('./src/utils/logger').info('x')");
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(fs.readdirSync(dir), []);
    assert.match(r.stdout, /"msg":"x"/);
  });
});

// ─── Reader + API ────────────────────────────────────────────────────────────

const T0 = Date.UTC(2026, 10, 2, 8, 0, 0);
let app;
let db;
let tokens;
let logDir;

function writeFixture() {
  // server.log.1 (older) and server.log (newer); three lines share one ms.
  fs.mkdirSync(logDir, { recursive: true });
  const older = [
    line({ level: 30, time: T0, msg: 'host started' }),
    line({ level: 40, time: T0 + 1000, blockedMs: 2300, msg: 'event loop was blocked' }),
    line({ level: 50, time: T0 + 2000, plugin: 'gatecontrol-mail', op: 'run', phase: 'statement', msg: 'plugin storage timed out — worker restarted' }),
    'not json at all\n',
  ].join('');
  const newer = [
    line({ level: 20, time: T0 + 60000, msg: 'debug detail' }),
    line({ level: 30, time: T0 + 61000, plugin: 'gatecontrol-alltag', msg: 'plugin ready' }),
    line({ level: 30, time: T0 + 62000, msg: 'same ms a' }),
    line({ level: 30, time: T0 + 62000, msg: 'same ms b' }),
    line({ level: 30, time: T0 + 62000, msg: 'same ms c' }),
    line({ level: 60, time: T0 + 63000, err: { message: 'boom', stack: 'Error: boom\n    at x' }, msg: 'Uncaught exception — exiting' }),
    line({ level: 10, time: T0 + 64000, module: 'caddy', msg: 'trace "quoted" line' }),
  ].join('');
  fs.writeFileSync(path.join(logDir, 'server.log.1'), older);
  fs.writeFileSync(path.join(logDir, 'server.log'), newer);
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

before(async () => {
  logDir = process.env.GC_SERVER_LOG_DIR;
  assert.ok(logDir && logDir.startsWith(os.tmpdir()), 'test-env routes the server log into a temp dir');
  const ctx = await setup();
  app = ctx.app;
  db = require('../src/db/connection').getDb();
  tokens = require('../src/services/tokens');
  writeFixture();
});
after(() => teardown());

describe('services/serverLog', () => {
  const S = () => require('../src/services/serverLog');
  const msgs = (r) => r.entries.map((e) => e.msg);

  it('newest first across the rotation, unparseable lines skipped, level groups', async () => {
    const r = await S().query(S().parseFilter({}), { limit: 50 });
    assert.equal(r.entries.length, 10);
    assert.equal(r.entries[0].msg, 'trace "quoted" line');
    assert.equal(r.entries[0].level, 'debug');
    assert.equal(r.entries[0].levelName, 'trace');
    assert.equal(r.entries[9].msg, 'host started');
    const fatal = r.entries.find((e) => e.levelName === 'fatal');
    assert.equal(fatal.level, 'error');
    assert.equal(fatal.fields.err.message, 'boom');
    assert.equal(fatal.time, new Date(T0 + 63000).toISOString());
    assert.deepEqual(r.files.map((f) => f.name), ['server.log', 'server.log.1']);
    assert.equal(r.next, null);
    assert.equal(r.more, false);
  });

  it('filters: several levels, text in fields, field values, msg, time range', async () => {
    const f = (q) => S().query(S().parseFilter(q), { limit: 50 });
    assert.deepEqual(msgs(await f({ level: 'error,warn' })), ['Uncaught exception — exiting', 'plugin storage timed out — worker restarted', 'event loop was blocked']);
    assert.deepEqual(msgs(await f({ level: ['warn', 'error'] })).length, 3, 'repeated parameter');
    assert.deepEqual(msgs(await f({ q: 'BLOCKEDMS' })), ['event loop was blocked'], 'case-insensitive, in fields');
    assert.deepEqual(msgs(await f({ q: '"quoted"' })), ['trace "quoted" line'], 'escaped characters still match');
    assert.deepEqual(msgs(await f({ plugin: 'gatecontrol-mail' })), ['plugin storage timed out — worker restarted']);
    assert.deepEqual(msgs(await f({ module: 'caddy' })), ['trace "quoted" line']);
    assert.deepEqual(msgs(await f({ field: 'phase:statement' })), ['plugin storage timed out — worker restarted']);
    assert.deepEqual(msgs(await f({ msg: 'plugin' })), ['plugin ready', 'plugin storage timed out — worker restarted']);
    assert.deepEqual(msgs(await f({ msg: 'gatecontrol-mail' })), [], 'msg looks at the message only');
    assert.deepEqual(msgs(await f({ from: String(T0 + 61000), to: new Date(T0 + 62000).toISOString() })),
      ['same ms c', 'same ms b', 'same ms a', 'plugin ready']);
  });

  it('cursor paging is exact when lines share a millisecond', async () => {
    const seen = [];
    let before = null;
    for (let i = 0; i < 20; i++) {
      const r = await S().query(S().parseFilter({}), { limit: 2, before: before ? S().parseCursor(before) : null });
      seen.push(...msgs(r));
      if (!r.next) break;
      before = r.next;
    }
    const all = msgs(await S().query(S().parseFilter({}), { limit: 50 }));
    assert.deepEqual(seen, all);
    const p = await S().query(S().parseFilter({ level: 'info' }), { limit: 2, before: S().parseCursor(`${T0 + 62000}-1`) });
    assert.deepEqual(msgs(p), ['same ms b', 'same ms a']);
    assert.equal(p.next, `${T0 + 62000}-3`);
  });

  it('counts per level ignore the level filter, histogram per bucket', async () => {
    const r = await S().query(S().parseFilter({ level: 'error' }), { limit: 1, counts: true, bucketMs: 60000 });
    assert.equal(r.entries.length, 1);
    assert.deepEqual(r.counts, { error: 2, warn: 1, info: 5, debug: 2, total: 10 });
    assert.deepEqual(r.histogram.buckets.map((b) => [b.time, b.error, b.warn, b.info, b.debug]), [
      [new Date(T0).toISOString(), 1, 1, 1, 0],
      [new Date(T0 + 60000).toISOString(), 1, 0, 4, 2],
    ]);
  });

  it('invalid parameters are QueryErrors', () => {
    for (const q of [{ level: 'loud' }, { from: 'yesterday' }, { from: String(T0 + 1), to: String(T0) }, { field: 'level:30' },
      { field: 'bad key:x' }, { q: 'x'.repeat(201) }, { plugin: ['a', 'b'] }]) {
      assert.throws(() => S().parseFilter(q), (e) => e.code === 'INVALID_QUERY', JSON.stringify(q));
    }
    assert.throws(() => S().parseCursor('../etc'), /invalid before/);
    assert.throws(() => S().parseLimit('501'), /invalid limit/);
    assert.equal(S().parseLimit(undefined), 200);
  });

  it('text, json and csv lines of the export', () => {
    const o = { level: 40, time: T0, pid: 1, hostname: 'h', blockedMs: 2300, msg: 'event loop was blocked' };
    assert.equal(S().textLine(o), `${new Date(T0).toISOString()} WARN  event loop was blocked {"blockedMs":2300}`);
    assert.deepEqual(S().restOf(o), { blockedMs: 2300 });
  });
});

describe('GET /api/v1/logs/server', () => {
  it('answers an admin session with entries, files, retention and counts', async () => {
    const r = await getAgent().get('/api/v1/logs/server?level=warn,error&counts=1&bucket=1m').expect(200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.enabled, false, 'no file stream under NODE_ENV=test');
    assert.equal(r.body.entries.length, 3);
    assert.equal(r.body.counts.total, 10);
    assert.equal(r.body.histogram.bucketMs, 60000);
    assert.deepEqual(r.body.files.map((f) => f.name), ['server.log', 'server.log.1']);
    assert.ok(!JSON.stringify(r.body.files).includes(logDir), 'no paths');
    assert.equal(r.body.retention.files, 5);
    assert.equal(r.headers['cache-control'], 'no-store');
    const page = await getAgent().get('/api/v1/logs/server?limit=4').expect(200);
    assert.equal(page.body.entries.length, 4);
    const next = await getAgent().get(`/api/v1/logs/server?limit=4&before=${page.body.next}`).expect(200);
    assert.equal(next.body.entries[0].msg, 'same ms a');
  });

  it('400 for invalid filters, never a path from the request', async () => {
    for (const q of ['level=loud', 'from=x', 'limit=0', 'before=../../etc/passwd', 'bucket=2h&counts=1', 'field=time:1']) {
      const r = await getAgent().get(`/api/v1/logs/server?${q}`);
      assert.equal(r.status, 400, q);
      assert.equal(r.body.code, 'INVALID_QUERY');
    }
    const r = await getAgent().get('/api/v1/logs/server/export?format=xml');
    assert.equal(r.status, 400);
    assert.equal(r.headers['content-disposition'], undefined);
  });

  it('administrators only: tokens with the logs right (or full access) and members get 403', async () => {
    const mk = (scopes) => tokens.create({ name: `slog-${crypto.randomBytes(3).toString('hex')}`, scopes }, '127.0.0.1').rawToken;
    const logsToken = mk(['logs']);
    // The same token still reads the activity log (its right is unchanged).
    assert.equal((await supertest(app).get('/api/v1/logs/activity').set('X-API-Token', logsToken)).status, 200);
    for (const t of [logsToken, mk(['full-access']), mk(['read-only'])]) {
      for (const url of ['/api/v1/logs/server', '/api/v1/logs/server/export?format=log']) {
        assert.equal((await supertest(app).get(url).set('X-API-Token', t)).status, 403, url);
      }
    }
    const member = await loginAs(`slog-member-${crypto.randomBytes(3).toString('hex')}`, 'user');
    assert.equal((await member.get('/api/v1/logs/server')).status, 403);
    assert.equal((await member.get('/api/v1/logs/server/export')).status, 403);
    assert.equal((await supertest(app).get('/api/v1/logs/server')).status, 401);
  });

  it('export: log, json and csv with the same filters, not behind log_export', async () => {
    // Activity and access exports need the log_export licence, the server log export does not.
    const src = fs.readFileSync(path.join(ROOT, 'src/routes/api/logs.js'), 'utf8');
    assert.match(src, /router\.get\('\/activity\/export', requireFeature\('log_export'\)/);
    assert.match(src, /router\.get\('\/server\/export', requireAdminSession, async/);
    assert.match(src, /router\.get\('\/server', requireAdminSession, async/);
    const log = await getAgent().get('/api/v1/logs/server/export?format=log&level=warn,error').expect(200);
    assert.match(log.headers['content-type'], /^text\/plain/);
    assert.match(log.headers['content-disposition'], /^attachment; filename="gatecontrol-server-\d{8}-\d{4}\.log"$/);
    const rows = log.text.trim().split('\n');
    assert.equal(rows.length, 3);
    assert.match(rows[0], /^2026-11-02T08:00:01\.000Z WARN  event loop was blocked \{"blockedMs":2300\}$/, 'oldest first');
    assert.match(rows[2], /FATAL Uncaught exception — exiting \{"err":\{"message":"boom","stack":"Error: boom\\n    at x"\}\}/);

    const json = await getAgent().get('/api/v1/logs/server/export?format=json&plugin=gatecontrol-mail').expect(200);
    assert.match(json.headers['content-type'], /^application\/json/);
    const arr = JSON.parse(json.text);
    assert.equal(arr.length, 1);
    assert.equal(arr[0].op, 'run');
    assert.equal(arr[0].level, 50);

    const empty = await getAgent().get(`/api/v1/logs/server/export?format=json&from=${T0 + 1e9}`).expect(200);
    assert.deepEqual(JSON.parse(empty.text), []);

    const csv = await getAgent().get('/api/v1/logs/server/export?format=csv&q=plugin').expect(200);
    assert.match(csv.headers['content-type'], /^text\/csv/);
    const lines = csv.text.trim().split('\n');
    assert.equal(lines[0], 'time,level,msg,plugin,module,details');
    assert.equal(lines.length, 3);
    assert.ok(lines[1].startsWith('2026-11-02T08:00:02.000Z,error,plugin storage timed out — worker restarted,gatecontrol-mail,,'));
  });
});

describe('GET /api/v1/logs/activity: optional filters', () => {
  const activity = () => require('../src/services/activity');

  before(() => {
    db.prepare('DELETE FROM activity_log').run();
    const ins = db.prepare('INSERT INTO activity_log (event_type, message, source, severity, created_at) VALUES (?, ?, ?, ?, ?)');
    ins.run('peer_created', 'Peer created: laptop', 'admin', 'success', '2026-11-01 10:00:00');
    ins.run('login_failed', 'Failed login for user: eve', 'system', 'warning', '2026-11-01 11:00:00');
    ins.run('route_down', 'Route down: nas.example.com', 'monitor', 'error', '2026-11-02 08:00:00');
    ins.run('route_up', 'Route up: nas.example.com', 'monitor', 'info', '2026-11-02 08:05:00');
  });

  it('without filters the answer is unchanged', async () => {
    const r = await getAgent().get('/api/v1/logs/activity').expect(200);
    assert.deepEqual(Object.keys(r.body).sort(), ['entries', 'limit', 'ok', 'page', 'total', 'totalPages']);
    assert.equal(r.body.total, 4);
  });

  it('several severities, text, event types, category and time range', async () => {
    const get = async (q) => (await getAgent().get(`/api/v1/logs/activity?${q}`).expect(200)).body;
    assert.deepEqual((await get('severity=warning,error')).entries.map((e) => e.event_type), ['route_down', 'login_failed']);
    assert.equal((await get('q=nas.example')).total, 2);
    assert.deepEqual((await get('event=route_up,peer_created')).entries.map((e) => e.event_type), ['route_up', 'peer_created']);
    assert.equal((await get('category=route')).total, 2);
    assert.equal((await get('from=2026-11-02T00:00:00Z')).total, 2);
    assert.equal((await get(`to=${Date.UTC(2026, 10, 1, 10, 30)}`)).total, 1);
    assert.equal((await get('q=100%25')).total, 0, 'LIKE wildcards are literal');
  });

  it('counts=1: per severity without the severity filter, event types, histogram', async () => {
    const r = (await getAgent().get('/api/v1/logs/activity?severity=error&counts=1&bucket=1d').expect(200)).body;
    assert.equal(r.total, 1);
    assert.deepEqual(r.counts, { info: 1, success: 1, warning: 1, error: 1, total: 4 });
    assert.deepEqual(r.events, [{ event_type: 'route_down', count: 1 }]);
    assert.deepEqual(r.histogram.buckets.map((b) => [b.time.slice(0, 10), b.error, b.warning, b.success, b.info]),
      [['2026-11-01', 0, 1, 1, 0], ['2026-11-02', 1, 0, 0, 1]]);
  });

  it('invalid filters are 400', async () => {
    for (const q of ['severity=loud', 'category=evil', 'event=a%20b', 'from=soon', `q=${'x'.repeat(201)}`]) {
      assert.equal((await getAgent().get(`/api/v1/logs/activity?${q}`)).status, 400, q);
    }
    assert.equal((await getAgent().get('/api/v1/logs/access?status=4xx')).status, 400);
  });

  it('the filtered export uses the same filter (service level; the route needs log_export)', () => {
    const rows = activity().getAllFiltered({ severities: ['info', 'success'] });
    assert.deepEqual(rows.map((e) => e.event_type), ['route_up', 'peer_created']);
  });
});
