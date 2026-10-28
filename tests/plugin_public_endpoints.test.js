'use strict';

// Public endpoints of plugins (docs/plugins.md "Public endpoints", since 1.211.0): the permission, tokens minted by
// the plugin (one person, one path prefix, a lifetime), /plugin-public/<id>/… without a session — the token checks,
// bodies into the media store (size, claimed or dropped), the answers (JSON, text, media with Range, a form page),
// the headers a plugin may and may not set, the rate limit of failed requests.

const crypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const supertest = require('supertest');
const { helloPackage, HELLO } = require('./helpers/plugins');
const { setup, teardown, getCsrf } = require('./helpers/setup');
const H = require('./helpers/notify');

let app, agent, csrf, runtime, plugins, config, savedBase, anna, bert;
const API = '/api/v1/plugins';
const PID = 'pl-office';
const helloManifest = JSON.parse(fs.readFileSync(path.join(HELLO, 'plugin.json'), 'utf8'));
const clone = (v) => JSON.parse(JSON.stringify(v));
const MB = 1024 * 1024;

async function install(overrides) {
  const r = await agent.post(API + '/inspect').set('X-CSRF-Token', csrf).set('Content-Type', 'application/octet-stream').send(helloPackage({ overrides })).expect(200);
  assert.equal(r.body.canInstall, true, JSON.stringify(r.body.checks));
  await agent.post(API + '/install').set('X-CSRF-Token', csrf).send({ token: r.body.token, accept: true }).expect(200);
}
const gc = async (fn, ...args) => (await agent.post(`${API}/${PID}/api/gc`).set('X-CSRF-Token', csrf).send({ fn, args })).body;
const kv = (key, value) => agent.post(`${API}/${PID}/api/kv`).set('X-CSRF-Token', csrf).send({ key, value }).expect(200);
const kvGet = async (key) => (await agent.get(`${API}/${PID}/api/kv`).query({ key }).expect(200)).body.value;
const pub = () => supertest(app);
const binary = (res, cb) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); };
async function token(opts) {
  const r = await gc('publicEndpoints.token', { user: anna, path: 'wopi/files/7', ...opts });
  assert.equal(r.ok, true, JSON.stringify(r));
  return r.result;
}
const P = `/plugin-public/${PID}`;

before(async () => {
  ({ app, agent } = await setup());
  csrf = getCsrf();
  runtime = require('../src/services/plugins/runtime');
  plugins = require('../src/services/plugins');
  config = require('../config/default');
  savedBase = config.app.baseUrl;
  config.app.baseUrl = 'https://gc.home-test.net';
  anna = H.makeUser('pe-anna');
  bert = H.makeUser('pe-bert', { enabled: 0 });
  await install({
    id: PID, name: { de: 'Office-Test', en: 'Office test' },
    permissions: { ...clone(helloManifest.permissions), publicEndpoints: { maxBodyBytes: 1 * MB } },
    media: { maxBytes: 2 * MB, types: ['application/octet-stream', 'application/pdf'], quotaDefault: '1GB' },
  });
  assert.equal(await runtime.waitRunning(PID), true);
});
after(async () => {
  config.app.baseUrl = savedBase;
  await plugins.stop();
  teardown();
});

beforeEach(async () => {
  const rl = require('../src/middleware/rateLimit');
  const { ipKeyGenerator } = require('express-rate-limit');
  for (const ip of ['127.0.0.1', '::ffff:127.0.0.1', '::1']) {
    rl.pluginPublicLimiter.resetKey(`plugin-public:${ipKeyGenerator(ip)}`);
    rl.pluginPublicFailLimiter.resetKey(`plugin-public-fail:${ipKeyGenerator(ip)}`);
  }
  await kv('public-answer', null);
  await kv('public-claim', null);
  await kv('public-last', null);
});

describe('the manifest', () => {
  const manifest = require('../src/services/plugins/manifest');
  const base = () => ({ ...clone(helloManifest), permissions: { ...clone(helloManifest.permissions) } });
  it('takes true or { maxBodyBytes } and needs media for bodies', () => {
    const a = base(); a.permissions.publicEndpoints = true;
    assert.deepEqual(manifest.validate(a).manifest.permissions.publicEndpoints, { maxBodyBytes: 0 });
    const b = base(); b.permissions.publicEndpoints = { maxBodyBytes: 1000 };
    assert.ok(manifest.validate(b).errors.includes('permissions.publicEndpoints.maxBodyBytes: needs media'));
    b.media = { maxBytes: 2000, types: ['application/pdf'] };
    assert.deepEqual(manifest.validate(b).manifest.permissions.publicEndpoints, { maxBodyBytes: 1000 });
    b.media.maxBytes = 500;
    assert.equal(manifest.validate(b).ok, false, 'not above media.maxBytes');
    const c = base(); c.permissions.publicEndpoints = { paths: ['x'] };
    assert.ok(manifest.validate(c).errors.includes('permissions.publicEndpoints: invalid'));
    const d = base();
    assert.equal(manifest.validate(d).manifest.permissions.publicEndpoints, null);
  });
});

describe('tokens', () => {
  it('are minted for an enabled person and a path', async () => {
    const t = await token({ ttlS: 600, data: 'write' });
    assert.match(t.token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
    assert.equal(t.url, `https://gc.home-test.net${P}/wopi/files/7`);
    assert.ok(Math.abs(t.expiresAt - (Date.now() + 600000)) < 5000);
    assert.equal((await gc('publicEndpoints.base')).result.url, `https://gc.home-test.net${P}/`);
    for (const bad of [{ user: bert }, { user: 0 }, { path: '../x' }, { path: '' }, { path: 'a b' }, { ttlS: 10 }, { ttlS: 90000 }, { data: 'x'.repeat(300) }]) {
      assert.equal((await gc('publicEndpoints.token', { user: anna, path: 'wopi', ...bad })).code, 'ERR_INVALID', JSON.stringify(bad));
    }
  });

  it('are refused to a plugin without the permission', async () => {
    const pe = require('../src/services/plugins/publicEndpoints');
    assert.equal(pe.declOf({ manifest: { permissions: { publicEndpoints: null } } }), null);
  });

  it('open the path and below it, nothing else, and only while valid', async () => {
    const { token: tk } = await token({ data: 'write' });
    const r = await pub().get(`${P}/wopi/files/7`).query({ access_token: tk }).expect(200);
    assert.deepEqual(r.body, { ok: true, path: '/wopi/files/7', user: anna, data: 'write' });
    assert.equal(r.headers['x-wopi-itemversion'], 'v1');
    assert.notEqual(r.headers['x-frame-options'], 'ALLOWALL', 'never a header the browser acts on');
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.equal(r.headers['set-cookie'], undefined, 'no session, no cookie');
    await pub().get(`${P}/wopi/files/7/contents`).set('Authorization', `Bearer ${tk}`).expect(200);
    await pub().get(`${P}/wopi/files/70`).query({ access_token: tk }).expect(401);
    await pub().get(`${P}/wopi/files`).query({ access_token: tk }).expect(401);
    await pub().get(`${P}/wopi/files/7`).expect(401);
    await pub().get(`${P}/wopi/files/7`).query({ access_token: tk.slice(0, -2) + (tk.endsWith('AA') ? 'BB' : 'AA') }).expect(401);
    await pub().get(`/plugin-public/hello-nope/wopi/files/7`).query({ access_token: tk }).expect(404);
    // a token of another plugin id does not open this one
    const pe = require('../src/services/plugins/publicEndpoints');
    const other = pe.mint('other-plugin', { user: anna, path: 'wopi/files/7' });
    await pub().get(`${P}/wopi/files/7`).query({ access_token: other.token }).expect(401);
    // expired
    const old = pe.mint(PID, { user: anna, path: 'wopi/files/7', ttlS: 60 }, Date.now() - 120000);
    await pub().get(`${P}/wopi/files/7`).query({ access_token: old.token }).expect(401);
    // the hook gets the request without the token, the x- headers but not the proxy's
    await pub().get(`${P}/wopi/files/7`).query({ access_token: tk, a: '1' }).set('X-WOPI-Proof', 'abc').set('X-Forwarded-For', '1.2.3.4').set('Cookie', 'gc.sid=x').expect(200);
    const last = await kvGet('public-last');
    assert.deepEqual(last.query, { a: '1' });
    assert.equal(last.headers['x-wopi-proof'], 'abc');
    assert.equal(last.headers['x-forwarded-for'], undefined);
    assert.equal(last.headers.cookie, undefined);
    assert.equal(last.user.id, anna);
    assert.equal(last.body, null);
    assert.match(last.url, /^https:\/\/gc\.home-test\.net\/plugin-public\/pl-office\/wopi\/files\/7\?access_token=/);
  });

  it('end when the person is disabled', async () => {
    const carl = H.makeUser('pe-carl');
    const r = await gc('publicEndpoints.token', { user: carl, path: 'x' });
    H.db().prepare('UPDATE users SET enabled = 0 WHERE id = ?').run(carl);
    await pub().get(`${P}/x`).query({ access_token: r.result.token }).expect(401);
  });
});

describe('bodies', () => {
  it('become an unclaimed media file of the person, dropped unless the plugin keeps it', async () => {
    const { token: tk } = await token();
    const data = crypto.randomBytes(4000);
    await pub().post(`${P}/wopi/files/7/contents`).query({ access_token: tk }).set('Content-Type', 'application/octet-stream').set('X-WOPI-Override', 'PUT').send(data).expect(200);
    const last = await kvGet('public-last');
    assert.equal(last.body.bytes, 4000);
    assert.equal(last.body.sha256, crypto.createHash('sha256').update(data).digest('hex'));
    assert.equal(last.headers['x-wopi-override'], 'PUT');
    const info = (await gc('media.info', last.body.mediaId)).result;
    assert.equal(info.owner, anna);
    assert.equal(info.claimed, false);
    // an error answer drops the upload
    await kv('public-answer', { status: 409, headers: { 'X-WOPI-Lock': 'other' } });
    const r = await pub().post(`${P}/wopi/files/7/contents`).query({ access_token: tk }).set('Content-Type', 'application/octet-stream').send(data).expect(409);
    assert.equal(r.headers['x-wopi-lock'], 'other');
    const gone = await kvGet('public-last');
    assert.equal((await gc('media.info', gone.body.mediaId)).result, null);
    // kept when claimed
    await kv('public-answer', { status: 500 });
    await kv('public-claim', true);
    await pub().post(`${P}/wopi/files/7/contents`).query({ access_token: tk }).set('Content-Type', 'application/octet-stream').send(data).expect(500);
    const kept = await kvGet('public-last');
    assert.equal((await gc('media.info', kept.body.mediaId)).result.claimed, true);
  });

  it('are limited to maxBodyBytes and need a token first', async () => {
    const { token: tk } = await token();
    await pub().post(`${P}/wopi/files/7/contents`).query({ access_token: tk }).set('Content-Type', 'application/octet-stream').send(Buffer.alloc(MB + 1)).expect(413);
    await pub().post(`${P}/wopi/files/7/contents`).set('Content-Type', 'application/octet-stream').send(Buffer.alloc(100)).expect(401);
    await pub().post(`${P}/wopi/files/7/contents`).query({ access_token: tk }).set('Content-Type', 'application/json').send({ a: 1 }).expect(415);
    // no body (a WOPI lock): fine
    await pub().post(`${P}/wopi/files/7`).query({ access_token: tk }).set('X-WOPI-Override', 'LOCK').expect(200);
    assert.equal((await kvGet('public-last')).body, null);
    await pub().delete(`${P}/wopi/files/7`).query({ access_token: tk }).expect(405);
  });
});

describe('answers', () => {
  it('serve a media file of the plugin with Range', async () => {
    const { token: tk } = await token();
    const data = crypto.randomBytes(3000);
    await kv('public-claim', true);
    await pub().post(`${P}/wopi/files/7/contents`).query({ access_token: tk }).set('Content-Type', 'application/octet-stream').send(data).expect(200);
    const id = (await kvGet('public-last')).body.mediaId;
    await kv('public-claim', null);
    await kv('public-answer', { media: id, headers: { 'X-WOPI-ItemVersion': '3' } });
    const r = await pub().get(`${P}/wopi/files/7/contents`).query({ access_token: tk }).buffer(true).parse(binary).expect(200);
    assert.ok(r.body.equals(data));
    assert.equal(r.headers['x-wopi-itemversion'], '3');
    assert.match(r.headers['content-disposition'], /^attachment/);
    assert.match(r.headers['content-security-policy'], /sandbox/);
    const part = await pub().get(`${P}/wopi/files/7/contents`).query({ access_token: tk }).set('Range', 'bytes=10-19').buffer(true).parse(binary).expect(206);
    assert.ok(part.body.equals(data.subarray(10, 20)));
    await kv('public-answer', { media: 'f'.repeat(32) });
    await pub().get(`${P}/wopi/files/7/contents`).query({ access_token: tk }).expect(404);
  });

  it('render a form page that posts to the editor, nothing else', async () => {
    const { token: tk } = await token({ path: 'office/open/7' });
    await kv('public-answer', { form: { action: 'https://office.example.net/browser/x/cool.html?WOPISrc=a%22b', fields: { access_token: 'tok"<>', access_token_ttl: 123 } } });
    const r = await pub().get(`${P}/office/open/7`).query({ access_token: tk }).expect(200);
    assert.match(r.headers['content-type'], /^text\/html/);
    assert.match(r.headers['content-security-policy'], /form-action https:\/\/office\.example\.net;/);
    assert.match(r.headers['content-security-policy'], /script-src 'nonce-[A-Za-z0-9+/=]+'/);
    assert.equal(r.headers['x-frame-options'], 'DENY');
    assert.ok(r.text.includes('value="tok&quot;&lt;&gt;"'));
    assert.ok(r.text.includes('name="access_token_ttl" value="123"'));
    assert.ok(r.text.includes('action="https://office.example.net/browser/x/cool.html?WOPISrc=a%22b"'));
    for (const bad of [{ form: { action: 'javascript:alert(1)', fields: {} } }, { form: { action: 'https://a.example/', fields: { 'a b': 'x' } } },
      { status: 302, headers: { Location: 'https://evil.example/' } }, { text: 5 }, { media: '../x' }]) {
      await kv('public-answer', bad);
      await pub().get(`${P}/office/open/7`).query({ access_token: tk }).expect(502);
    }
  });

  it('answer text and errors of the plugin', async () => {
    const { token: tk } = await token();
    await kv('public-answer', { status: 404, text: 'no such file' });
    const r = await pub().get(`${P}/wopi/files/7`).query({ access_token: tk }).expect(404);
    assert.equal(r.text, 'no such file');
    await kv('public-answer', 'throw');
    await pub().get(`${P}/wopi/files/7`).query({ access_token: tk }).expect(502);
  });
});

describe('the rate limit', () => {
  it('stops an address after many requests without a valid token', async () => {
    let last = 0;
    for (let i = 0; i < 61; i++) last = (await pub().get(`${P}/wopi/files/7`).query({ access_token: 'x.y' })).status;
    assert.equal(last, 429);
    const { token: tk } = await token();
    await pub().get(`${P}/wopi/files/7`).query({ access_token: tk }).expect(429);
  });
});
