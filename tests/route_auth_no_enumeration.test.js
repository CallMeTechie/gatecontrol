'use strict';

// Route login with an e-mail code (routes/routeAuth.js): asking for a code
// must not reveal whether the typed address has access. Same status, same
// body and at least SEND_CODE_MIN_MS for every address; the mail goes out in
// the background (its latency or failure does not reach the answer). An
// address without access counts for the IP block with the weight of
// "Unbekannte Benutzernamen" (unknown_user_weight) and is logged for the
// admin (route, masked address, IP). The code step then fails exactly like
// a wrong code. Also: the resend of the second factor goes to the address of
// the pending session, and the login page shows a masked address only for a
// pending session of its own route.

const crypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');

const fs = require('node:fs');
const path = require('node:path');
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const { setup, teardown } = require('./helpers/setup');

let app, db, ipBlock, emailService, routeAuth, tmp, origSend;
const DOMAIN = 'ranoenum-code.example.de';
const PW_DOMAIN = 'ranoenum-2fa.example.de';
const OWNER = 'owner@example.de';
let rid, pwRid;
let sent = [];
let ipSeq = 0;
const nextIp = () => `185.220.103.${++ipSeq}`;

function counted(ip) {
  return db.prepare('SELECT COALESCE(SUM(weight), 0) AS points, COUNT(*) AS rows, COALESCE(SUM(unknown_user), 0) AS unknown FROM ip_block_failures WHERE ip = ?').get(ip);
}
function setSmtp(on) {
  for (const k of ['smtp_host', 'smtp_port', 'smtp_from']) db.prepare('DELETE FROM settings WHERE key = ?').run(k);
  if (!on) return;
  db.prepare("INSERT INTO settings (key, value) VALUES ('smtp_host', 'mail.example.de'), ('smtp_port', '587'), ('smtp_from', 'gc@example.de')").run();
}
async function csrfFor(agent, domain, ip) {
  const page = await agent.get('/route-auth/login').query({ route: domain }).set('X-Forwarded-For', ip).expect(200);
  return { token: page.text.match(/name="_csrf"\s+value="([^"]+)"/)[1], html: page.text };
}
async function askCode(email, { ip = nextIp(), domain = DOMAIN, agent = supertest.agent(app) } = {}) {
  const { token } = await csrfFor(agent, domain, ip);
  const t0 = Date.now();
  const r = await agent.post('/route-auth/send-code').set('X-Forwarded-For', ip).send({ email, domain, _csrf: token });
  return { status: r.status, body: r.body, ms: Date.now() - t0, ip, agent, token };
}
async function enterCode(ctx, code) {
  const r = await ctx.agent.post('/route-auth/verify-code').set('X-Forwarded-For', ctx.ip)
    .send({ code, domain: ctx.domain || DOMAIN, _csrf: ctx.token, redirect: '/' });
  return { status: r.status, body: r.body, cookie: r.headers['set-cookie'] || null };
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

before(async () => {
  ({ app } = await setup());
  db = require('../src/db/connection').getDb();
  ipBlock = require('../src/services/ipBlock');
  emailService = require('../src/services/email');
  routeAuth = require('../src/services/routeAuth');
  tmp = fs.mkdtempSync(path.join(process.env.GC_DATA_DIR, 'ranoenum-'));
  rid = Number(db.prepare("INSERT INTO routes (domain, target_ip, target_port, route_type, enabled) VALUES (?, '10.0.0.5', 80, 'http', 1)").run(DOMAIN).lastInsertRowid);
  db.prepare("INSERT INTO route_auth (route_id, auth_type, email) VALUES (?, 'email_code', ?)").run(rid, OWNER);
  pwRid = Number(db.prepare("INSERT INTO routes (domain, target_ip, target_port, route_type, enabled) VALUES (?, '10.0.0.6', 80, 'http', 1)").run(PW_DOMAIN).lastInsertRowid);
  db.prepare("INSERT INTO route_auth (route_id, auth_type, email, password_hash, two_factor_enabled, two_factor_method) VALUES (?, 'email_password', ?, 'x', 1, 'email_code')").run(pwRid, OWNER);
  origSend = emailService.sendOtpEmail;
});

after(() => { emailService.sendOtpEmail = origSend; teardown(); });

beforeEach(() => {
  db.prepare('DELETE FROM ip_blocks').run();
  db.prepare('DELETE FROM ip_block_failures').run();
  db.prepare('DELETE FROM ip_block_strikes').run();
  db.prepare('DELETE FROM login_attempts').run();
  db.prepare('DELETE FROM route_auth_otp').run();
  db.prepare("DELETE FROM activity_log WHERE event_type LIKE 'route_auth_%'").run();
  db.prepare("DELETE FROM settings WHERE key LIKE 'ipblock.%'").run();
  ipBlock._resetForTest({ blockFile: path.join(tmp, 'ipblock.list'), dataDir: path.join(tmp, 'lists'), engine: true });
  setSmtp(true);
  sent = [];
  emailService.sendOtpEmail = async (m) => { sent.push(m); };
});

test('known and unknown address: same status, same body, same minimum time', async () => {
  const k = await askCode(OWNER);
  const u = await askCode('stranger@leak.example');
  assert.equal(k.status, 200);
  assert.deepEqual(u.body, k.body);
  assert.equal(u.status, k.status);
  assert.equal(k.body.ok, true);
  assert.match(k.body.message, /we have sent you a code|haben wir Ihnen einen Code geschickt/);
  assert.ok(!JSON.stringify(k.body).includes('***'), 'no masked address in the answer');
  assert.ok(k.ms >= 290 && u.ms >= 290, `both wait the minimum (${k.ms} / ${u.ms} ms)`);
  await flush();
  assert.equal(sent.length, 1, 'only the route\'s own address gets a mail');
  assert.equal(sent[0].to, OWNER);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM route_auth_otp WHERE route_id = ?').get(rid).n, 1);
});

test('unknown address counts with the unknown-name weight and is logged for the admin', async () => {
  const u = await askCode('stranger@leak.example');
  const k = await askCode(OWNER);
  assert.deepEqual(counted(u.ip), { points: 3, rows: 1, unknown: 1 });
  assert.deepEqual(counted(k.ip), { points: 0, rows: 0, unknown: 0 });
  const row = db.prepare("SELECT message, details, ip_address, severity FROM activity_log WHERE event_type = 'route_auth_failed' ORDER BY id DESC").get();
  assert.ok(row, 'activity entry written');
  assert.equal(row.ip_address, u.ip);
  assert.equal(row.severity, 'warning');
  assert.match(row.message, new RegExp(DOMAIN.replace(/\./g, '\\.')));
  assert.ok(row.message.includes('s***@leak.example'), row.message);
  assert.ok(!row.message.includes('stranger@'), 'address is masked');
  const d = JSON.parse(row.details);
  assert.deepEqual(d, { routeId: rid, domain: DOMAIN, step: 'code_request', email: 's***@leak.example', unknownUser: true });
});

test('weight follows the setting (unknown_user_weight 5)', async () => {
  ipBlock.setConfig({ unknown_user_weight: 5 });
  const u = await askCode('other@leak.example');
  assert.deepEqual(counted(u.ip), { points: 5, rows: 1, unknown: 1 });
});

test('address in other case / with spaces still gets the code at the stored address', async () => {
  const k = await askCode('  Owner@EXAMPLE.de ');
  assert.equal(k.status, 200);
  await flush();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, OWNER);
  assert.deepEqual(counted(k.ip), { points: 0, rows: 0, unknown: 0 });
});

test('mail latency does not reach the answer', async () => {
  let release;
  emailService.sendOtpEmail = (m) => new Promise((resolve) => { release = () => { sent.push(m); resolve(); }; });
  const k = await askCode(OWNER);
  assert.equal(k.status, 200);
  assert.ok(k.ms < 1500, `answered before the mail went out (${k.ms} ms)`);
  assert.equal(sent.length, 0, 'mail still pending');
  release();
  await flush();
  assert.equal(sent.length, 1);
});

test('failed delivery: same answer, logged as route_auth_otp_failed', async () => {
  emailService.sendOtpEmail = async () => { throw new Error('connect ECONNREFUSED'); };
  const k = await askCode(OWNER);
  const u = await askCode('stranger@leak.example');
  assert.deepEqual(k.body, u.body);
  await flush();
  const row = db.prepare("SELECT message, details FROM activity_log WHERE event_type = 'route_auth_otp_failed'").get();
  assert.ok(row, 'failure logged');
  assert.ok(row.message.includes('o***@example.de'));
});

test('no plausible address / no mail server: same answer for every address', async () => {
  const bad = await askCode('not-an-address');
  assert.equal(bad.status, 400);
  assert.deepEqual(counted(bad.ip), { points: 0, rows: 0, unknown: 0 });
  setSmtp(false);
  const k = await askCode(OWNER);
  const u = await askCode('stranger@leak.example');
  assert.equal(k.status, 503);
  assert.equal(u.status, k.status);
  assert.deepEqual(u.body, k.body);
  assert.equal(sent.length, 0);
});

test('code step: wrong code and "no code ever sent" fail alike, a right code logs in', async () => {
  const u = await askCode('stranger@leak.example');
  const fromUnknown = await enterCode(u, '123456');
  const k = await askCode(OWNER);
  await flush();
  const wrong = await enterCode(k, sent[0].code === '000000' ? '000001' : '000000');
  assert.equal(fromUnknown.status, 401);
  assert.deepEqual(fromUnknown.body, wrong.body);
  assert.equal(fromUnknown.cookie, null);
  assert.equal(wrong.cookie, null);
  assert.match(wrong.body.error, /wrong or has expired|stimmt nicht oder ist abgelaufen/);
  // A wrong code counts once (the unknown address already counted 3 when it asked).
  assert.deepEqual(counted(u.ip), { points: 4, rows: 2, unknown: 1 });
  assert.deepEqual(counted(k.ip), { points: 1, rows: 1, unknown: 0 });
  const codeRow = db.prepare("SELECT details, ip_address FROM activity_log WHERE event_type = 'route_auth_failed' AND details LIKE '%\"step\":\"code\"%' ORDER BY id DESC").get();
  assert.equal(codeRow.ip_address, k.ip);
  assert.equal(JSON.parse(codeRow.details).email, 'o***@example.de');

  const k2 = await askCode(OWNER);
  await flush();
  const ok = await enterCode(k2, sent[sent.length - 1].code);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.ok, true);
  assert.ok(ok.cookie && ok.cookie.some((c) => c.startsWith('gc.route.sid=')));
});

test('second factor: resend goes to the pending session\'s address, typed address ignored', async () => {
  const agent = supertest.agent(app);
  const ip = nextIp();
  const { id } = routeAuth.createSession(pwRid, OWNER, ip, 5 * 60 * 1000, true);
  const page = await agent.get('/route-auth/login').query({ route: PW_DOMAIN }).set('X-Forwarded-For', ip).set('Cookie', `gc.route.sid=${id}`).expect(200);
  const token = page.text.match(/name="_csrf"\s+value="([^"]+)"/)[1];
  assert.ok(page.text.includes('o***@example.de'), 'step 2 shows the masked address of the session');
  const r = await agent.post('/route-auth/send-code').set('X-Forwarded-For', ip).set('Cookie', `gc.route.sid=${id}`)
    .send({ email: '', domain: PW_DOMAIN, _csrf: token });
  assert.equal(r.status, 200);
  await flush();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, OWNER);
});

test('login page: no masked address without a pending session of this route', async () => {
  const agent = supertest.agent(app);
  const ip = nextIp();
  const plain = await csrfFor(agent, PW_DOMAIN, ip);
  assert.ok(!plain.html.includes('***@'), 'step 1 shows no address');
  // A pending session of ANOTHER route does not open step 2 here.
  const { id } = routeAuth.createSession(rid, OWNER, ip, 5 * 60 * 1000, true);
  const page = await supertest(app).get('/route-auth/login').query({ route: PW_DOMAIN })
    .set('X-Forwarded-For', ip).set('Cookie', `gc.route.sid=${id}`).expect(200);
  assert.ok(!page.text.includes('***@'));
  const r = await supertest(app).post('/route-auth/send-code').set('X-Forwarded-For', ip).set('Cookie', `gc.route.sid=${id}`)
    .send({ email: OWNER, domain: PW_DOMAIN, _csrf: plain.token });
  assert.equal(r.status, 403, 'password route without its own pending session sends nothing');
  await flush();
  assert.equal(sent.length, 0);
});
