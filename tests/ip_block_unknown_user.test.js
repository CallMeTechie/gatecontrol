'use strict';

// IP-Sperre, „Unbekannte Benutzernamen zählen …“ (services/ipBlock.js
// unknown_user_weight): a failed login with a name that matches no account
// counts with the weight of the setting (default 3), a wrong password of an
// existing account and a wrong second factor once. The answer of the login
// is the same for both — only the counting differs. Covered: the weights per
// entry point (GateControl login, app sign-in, route login, 2FA), the ban at
// the right attempt, the summary of the ban, the setting (validation, API,
// backup round trip) and identical HTTP answers for unknown and known names.

const crypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');

const fs = require('node:fs');
const path = require('node:path');
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const argon2 = require('argon2');
const { setup, teardown, getAgent, getCsrf } = require('./helpers/setup');

let app, agent, csrf, db, ipBlock, lockout, tmp;
const PW = 'Plain!Pass1234';
const PUT = (p, b) => agent.put('/api/v1' + p).set('X-CSRF-Token', csrf).send(b);

/** Points and flagged rows of an address in ip_block_failures. */
function counted(ip) {
  return db.prepare('SELECT COALESCE(SUM(weight), 0) AS points, COUNT(*) AS rows, COALESCE(SUM(unknown_user), 0) AS unknown FROM ip_block_failures WHERE ip = ?').get(ip);
}
function banOf(ip) { return ipBlock.listBans().find((b) => b.ip === ip) || null; }

before(async () => {
  ({ app } = await setup());
  agent = getAgent();
  csrf = getCsrf();
  db = require('../src/db/connection').getDb();
  ipBlock = require('../src/services/ipBlock');
  lockout = require('../src/services/lockout');
  tmp = fs.mkdtempSync(path.join(process.env.GC_DATA_DIR, 'ipbu-'));
  const hash = await argon2.hash(PW, require('../src/utils/argon2Options'));
  db.prepare('INSERT INTO users (username, password_hash, role, self_service_enabled, self_enroll_enabled) VALUES (?, ?, ?, 1, 1)').run('ipbu-lena', hash, 'user');
});

after(() => teardown());

beforeEach(() => {
  db.prepare('DELETE FROM ip_blocks').run();
  db.prepare('DELETE FROM ip_block_failures').run();
  db.prepare('DELETE FROM ip_block_strikes').run();
  db.prepare('DELETE FROM login_attempts').run();
  db.prepare("DELETE FROM settings WHERE key LIKE 'ipblock.%'").run();
  ipBlock._resetForTest({ blockFile: path.join(tmp, 'ipblock.list'), dataDir: path.join(tmp, 'lists'), engine: true });
  try { require('../src/services/appSignin')._reset(); } catch { /* not loaded yet */ }
});

// ─── Weights ─────────────────────────────────────────

test('default: unknown names count three times', () => {
  assert.equal(ipBlock.getConfig().unknown_user_weight, 3);
  assert.deepEqual(ipBlock.UNKNOWN_WEIGHTS, [1, 2, 3, 5]);
});

test('weights: known name 1, unknown name 3, wrong second factor 1, other sources never weighted', () => {
  lockout.recordFailedAttempt('ipbu-lena', 'admin', '185.220.101.1');
  assert.deepEqual(counted('185.220.101.1'), { points: 1, rows: 1, unknown: 0 });

  lockout.recordFailedAttempt('nobody@leak.example', 'admin', '185.220.101.2', { unknownUser: true });
  assert.deepEqual(counted('185.220.101.2'), { points: 3, rows: 1, unknown: 1 });

  // a wrong 2FA code: the account exists — once, even if a caller said otherwise
  lockout.recordFailedAttempt('admin_2fa:1', 'admin_2fa', '185.220.101.3', { unknownUser: true });
  assert.deepEqual(counted('185.220.101.3'), { points: 1, rows: 1, unknown: 0 });

  // route login with an e-mail address that is not the route's account
  lockout.recordFailedAttempt('stranger@leak.example:99999', 'route_auth', '185.220.101.4', { unknownUser: true });
  assert.deepEqual(counted('185.220.101.4'), { points: 3, rows: 1, unknown: 1 });

  // only logins are weighted
  ipBlock.noteFailure('185.220.101.5', 'waf', 'a.example.de', { unknownUser: true });
  assert.deepEqual(counted('185.220.101.5'), { points: 1, rows: 1, unknown: 0 });

  // the lockout's second row of one attempt does not count again
  lockout.recordFailedAttempt('ipbu-lena', 'admin', '185.220.101.6', { ipBlock: false });
  assert.deepEqual(counted('185.220.101.6'), { points: 0, rows: 0, unknown: 0 });

  // the setting changes the weight
  ipBlock.setConfig({ unknown_user_weight: 5 });
  lockout.recordFailedAttempt('nobody2@leak.example', 'admin', '185.220.101.7', { unknownUser: true });
  assert.deepEqual(counted('185.220.101.7'), { points: 5, rows: 1, unknown: 1 });
});

test('ban: with threshold 10 the 4th unknown name bans; the ban says "unknown user names"', () => {
  const ip = '185.220.101.10';
  for (let i = 1; i <= 3; i++) {
    assert.equal(ipBlock.noteFailure(ip, 'login', `nobody${i}@leak.example`, { unknownUser: true }), false, `attempt ${i}`);
  }
  assert.equal(counted(ip).points, 9);
  assert.equal(ipBlock.check(ip), null);
  assert.equal(ipBlock.noteFailure(ip, 'login', 'nobody4@leak.example', { unknownUser: true }), true);
  assert.deepEqual(ipBlock.check(ip), { by: 'ban' });
  const b = banOf(ip);
  assert.equal(b.reason, 'login');
  assert.equal(b.hits, 12);
  assert.equal(b.attempts, 4);
  assert.equal(b.unknownUsers, 4);
  assert.equal(b.unknownMain, true);
  assert.deepEqual(b.sources, { login: 12 });
  const act = db.prepare("SELECT message, details FROM activity_log WHERE event_type = 'ip_blocked' ORDER BY id DESC LIMIT 1").get();
  assert.match(act.message, /12 failures, login, mostly unknown user names/);
  assert.equal(JSON.parse(act.details).unknown_users, 4);
});

test('ban: known names still need 10 attempts, a mix counts the points, weight 1 counts every name once', () => {
  const known = '185.220.101.20';
  for (let i = 1; i <= 9; i++) assert.equal(ipBlock.noteFailure(known, 'login', 'ipbu-lena'), false);
  assert.equal(ipBlock.noteFailure(known, 'login', 'ipbu-lena'), true);
  assert.equal(banOf(known).unknownMain, false);
  assert.equal(banOf(known).unknownUsers, 0);

  // 1 unknown (3) + 6 known (6) = 9, the 7th known bans
  const mix = '185.220.101.21';
  ipBlock.noteFailure(mix, 'login', 'nobody@leak.example', { unknownUser: true });
  for (let i = 1; i <= 6; i++) assert.equal(ipBlock.noteFailure(mix, 'login', 'ipbu-lena'), false);
  assert.equal(ipBlock.noteFailure(mix, 'login', 'ipbu-lena'), true);
  const m = banOf(mix);
  assert.equal(m.hits, 10);
  assert.equal(m.attempts, 8);
  assert.equal(m.unknownUsers, 1);
  assert.equal(m.unknownMain, false, '3 of 10 points are not the majority');

  ipBlock.setConfig({ unknown_user_weight: 1 });
  const one = '185.220.101.22';
  for (let i = 1; i <= 9; i++) assert.equal(ipBlock.noteFailure(one, 'login', `n${i}@leak.example`, { unknownUser: true }), false);
  assert.equal(ipBlock.noteFailure(one, 'login', 'n10@leak.example', { unknownUser: true }), true);
});

test('stats count points, as before', () => {
  ipBlock.noteFailure('185.220.101.30', 'login', 'nobody@leak.example', { unknownUser: true });
  ipBlock.noteFailure('185.220.101.31', 'login', 'ipbu-lena');
  const s = ipBlock.stats();
  assert.equal(s.failures24h, 4);
  assert.equal(s.failureIps24h, 2);
});

// ─── The setting ─────────────────────────────────────

test('setting: only 1, 2, 3 or 5 — anything else is an IpBlockError 400 on the field', () => {
  for (const bad of [0, 4, 6, -3, 2.5, 'drei', true, null, {}]) {
    assert.throws(() => ipBlock.setConfig({ unknown_user_weight: bad }), (err) => {
      assert.ok(err instanceof ipBlock.IpBlockError, String(bad));
      assert.equal(err.statusCode, 400);
      assert.equal(err.field, 'unknown_user_weight');
      return true;
    });
  }
  assert.equal(ipBlock.getConfig().unknown_user_weight, 3, 'unchanged after the errors');
  for (const ok of [1, 2, 5, '3']) assert.equal(ipBlock.setConfig({ unknown_user_weight: ok }).unknown_user_weight, Number(ok));
  // a stored value that is not allowed falls back to the default
  db.prepare("UPDATE settings SET value = ? WHERE key = 'ipblock.config'").run(JSON.stringify({ unknown_user_weight: 7 }));
  assert.equal(ipBlock.getConfig().unknown_user_weight, 3);
});

test('API: read, field error, save', async () => {
  let r = await agent.get('/api/v1/settings/ip-block');
  assert.equal(r.status, 200);
  assert.equal(r.body.config.unknown_user_weight, 3);
  r = await PUT('/settings/ip-block', { unknown_user_weight: 4 });
  assert.equal(r.status, 400);
  assert.ok(r.body.fields && r.body.fields.unknown_user_weight);
  r = await PUT('/settings/ip-block', { threshold: 12, unknown_user_weight: 5 });
  assert.equal(r.status, 200);
  assert.equal(r.body.config.unknown_user_weight, 5);
  assert.equal(r.body.config.threshold, 12);
});

// ─── Identical answers ───────────────────────────────

async function webLogin(ip, username, password) {
  const a = supertest.agent(app);
  const page = await a.get('/login').set('X-Forwarded-For', ip).expect(200);
  const loginCsrf = page.text.match(/name="_csrf"\s+value="([^"]+)"/)[1];
  const res = await a.post('/login').set('X-Forwarded-For', ip).type('form').send({ username, password, _csrf: loginCsrf });
  const after = await a.get('/login').set('X-Forwarded-For', ip).expect(200);
  const flash = (after.text.match(/class="login-error"[\s\S]*?<span>([^<]+)<\/span>/) || [])[1];
  return { status: res.status, location: res.headers.location, body: res.text, flash };
}

test('GateControl login: unknown and known name get the same answer; only the counting differs', async () => {
  const unknown = await webLogin('185.220.102.1', 'nobody@leak.example', PW);
  const known = await webLogin('185.220.102.2', 'ipbu-lena', 'Wrong!Pass1234');
  assert.equal(unknown.status, 302);
  assert.ok(unknown.flash, 'an error is shown');
  assert.deepEqual(unknown, known);
  assert.deepEqual(counted('185.220.102.1'), { points: 3, rows: 1, unknown: 1 });
  assert.deepEqual(counted('185.220.102.2'), { points: 1, rows: 1, unknown: 0 });
  const rows = db.prepare("SELECT message, details FROM activity_log WHERE event_type = 'login_failed' ORDER BY id DESC LIMIT 2").all();
  const byUser = Object.fromEntries(rows.map((x) => [x.message, x.details ? JSON.parse(x.details) : null]));
  assert.deepEqual(byUser['Failed login for user: nobody@leak.example'], { unknownUser: true });
  assert.equal(byUser['Failed login for user: ipbu-lena'], null);
  assert.ok(!rows.some((x) => (x.details || '').includes(PW) || x.message.includes(PW)), 'no password in the log');
});

test('app sign-in: unknown and known name get the same answer; only the counting differs', async () => {
  const signin = (ip, body) => supertest(app).post('/api/v1/client/signin/password').set('X-Forwarded-For', ip).send(body);
  const u = await signin('185.220.102.11', { username: 'nobody@leak.example', password: PW });
  const k = await signin('185.220.102.12', { username: 'ipbu-lena', password: 'Wrong!Pass1234' });
  assert.equal(u.status, 401);
  assert.equal(u.status, k.status);
  assert.deepEqual(u.body, k.body);
  assert.deepEqual(u.body, { ok: false, error: 'invalid_credentials' });
  assert.deepEqual(counted('185.220.102.11'), { points: 3, rows: 1, unknown: 1 });
  assert.deepEqual(counted('185.220.102.12'), { points: 1, rows: 1, unknown: 0 });
});

test('route login: another e-mail than the route\'s account gets the same answer and counts 3', async () => {
  const domain = 'ipbu-route.example.de';
  const rid = Number(db.prepare("INSERT INTO routes (domain, target_ip, target_port, route_type, enabled) VALUES (?, '10.0.0.5', 80, 'http', 1)").run(domain).lastInsertRowid);
  const hash = await argon2.hash(PW, require('../src/utils/argon2Options'));
  db.prepare("INSERT INTO route_auth (route_id, auth_type, email, password_hash) VALUES (?, 'email_password', 'owner@example.de', ?)").run(rid, hash);
  async function routeLogin(ip, email, password) {
    const a = supertest.agent(app);
    const page = await a.get('/route-auth/login').query({ route: domain }).set('X-Forwarded-For', ip).expect(200);
    const token = page.text.match(/name="_csrf"\s+value="([^"]+)"/)[1];
    const r = await a.post('/route-auth/login').set('X-Forwarded-For', ip).send({ email, password, domain, _csrf: token });
    return { status: r.status, body: r.body };
  }
  const u = await routeLogin('185.220.102.21', 'stranger@leak.example', PW);
  const k = await routeLogin('185.220.102.22', 'owner@example.de', 'Wrong!Pass1234');
  assert.equal(u.status, 401);
  assert.deepEqual(u, k);
  assert.deepEqual(counted('185.220.102.21'), { points: 3, rows: 1, unknown: 1 });
  assert.deepEqual(counted('185.220.102.22'), { points: 1, rows: 1, unknown: 0 });
});

// ─── Backup (last: the restore replaces the whole database content) ──────

test('backup round trip keeps the setting', async () => {
  const backup = require('../src/services/backup');
  ipBlock.setConfig({ unknown_user_weight: 5, threshold: 15 });
  const b = JSON.parse(JSON.stringify(await backup.createBackup()));
  const row = b.data.settings.find((s) => s.key === 'ipblock.config');
  assert.ok(row, 'ipblock.config is in the backup');
  assert.equal(JSON.parse(row.value).unknown_user_weight, 5);
  ipBlock.setConfig({ unknown_user_weight: 1, threshold: 10 });
  await backup.restoreBackup(b);
  const c = ipBlock.getConfig();
  assert.equal(c.unknown_user_weight, 5);
  assert.equal(c.threshold, 15);
});
