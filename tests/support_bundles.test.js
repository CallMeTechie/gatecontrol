'use strict';

// Support bundles (docs/feature-support-bundle.md):
//   - POST /api/v1/client/support-bundle: token + peer binding, gzip and
//     plain JSON, size/zip-bomb limits, schema check, per-peer rate limit
//   - server-side redaction before anything touches the disk
//   - retention (newest N per peer, max age, orphaned files)
//   - admin API: list / download / delete / request (admin session only)
//   - request flag in heartbeat + peer-info, cleared by the next upload

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const { setup, teardown, getAgent, getCsrf } = require('./helpers/setup');

let app;
let getDb;
let tokens;
let svc;
let config;

const SECRET_PRIV = 'yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=';
const SECRET_PSK = 'FpCyhws9cxwWoV4xELtfJvjJN+zQVRPISllRWgeopVE=';
const SECRET_TOKEN = 'gc_' + 'a1b2c3d4e5f6'.repeat(4);

function seedPeer(name, type = 'regular') {
  return Number(getDb().prepare("INSERT INTO peers (name, public_key, allowed_ips, enabled, peer_type) VALUES (?, ?, '10.8.0.30/32', 1, ?)")
    .run(name, `PUB_${name}_${crypto.randomBytes(4).toString('hex')}=`, type).lastInsertRowid);
}
function tokenFor(peerId, scopes = ['client']) {
  return tokens.create({ name: `sb-${crypto.randomBytes(4).toString('hex')}`, scopes, peerId }, '127.0.0.1').rawToken;
}

function bundle(extra = {}) {
  return {
    schema: 1,
    createdAt: new Date().toISOString(),
    client: { product: 'pro', version: '1.24.0', platform: 'windows', os: 'Windows 10.0.22631 x64', coreVersion: '1.10.0' },
    tunnel: { connected: true, lastHandshakeAgeSec: 12 },
    settings: { server: { url: 'https://gate.example.com', apiKey: SECRET_TOKEN }, tunnel: { killSwitch: true } },
    wireguardConfig: `[Interface]\nPrivateKey = ${SECRET_PRIV}\nAddress = 10.8.0.30/32\n\n[Peer]\nPresharedKey = ${SECRET_PSK}\nEndpoint = gate.example.com:51820`,
    logs: { lines: [`[info] GET /api/v1/client/ping X-API-Token: ${SECRET_TOKEN}`, 'Authorization: Bearer abc.def.ghi', 'normal line'] },
    ...extra,
  };
}

function upload(token, peerId, body, { gzip = true, type } = {}) {
  const req = supertest(app).post(`/api/v1/client/support-bundle?peerId=${peerId}`)
    .set('X-API-Token', token)
    .set('X-Client-Version', '1.24.0')
    .set('X-Client-Platform', 'windows');
  if (gzip) {
    const buf = Buffer.isBuffer(body) ? body : zlib.gzipSync(Buffer.from(JSON.stringify(body)));
    return req.set('Content-Type', type || 'application/gzip').send(buf);
  }
  return req.set('Content-Type', 'application/json').send(body);
}

function bundleDir(peerId) {
  return path.join(config.supportBundles.dir, String(peerId));
}

before(async () => {
  const ctx = await setup();
  app = ctx.app;
  getDb = require('../src/db/connection').getDb;
  tokens = require('../src/services/tokens');
  svc = require('../src/services/supportBundles');
  config = require('../config/default');
});
after(() => teardown());

beforeEach(() => {
  config.supportBundles.perHour = 3;
  config.supportBundles.keepPerPeer = 10;
  config.supportBundles.maxAgeDays = 30;
});

describe('client upload', () => {
  it('stores a gzip bundle on disk with a row, redacted', async () => {
    const peerId = seedPeer('sb-gzip');
    const token = tokenFor(peerId);
    const res = await upload(token, peerId, bundle());
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.ok, true);
    assert.ok(res.body.bundle.id > 0);

    const row = getDb().prepare('SELECT * FROM support_bundles WHERE id = ?').get(res.body.bundle.id);
    assert.equal(row.peer_id, peerId);
    assert.equal(row.client_version, '1.24.0');
    assert.equal(row.client_product, 'pro');
    assert.equal(row.client_platform, 'windows');
    assert.equal(row.os, 'Windows 10.0.22631 x64');
    assert.equal(row.reason, 'user');
    assert.match(row.file_name, /^\d{8}T\d{6}Z-[a-f0-9]{8}\.json\.gz$/);

    const file = path.join(bundleDir(peerId), row.file_name);
    assert.ok(fs.existsSync(file));
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const stored = zlib.gunzipSync(fs.readFileSync(file)).toString('utf8');
    for (const secret of [SECRET_PRIV, SECRET_PSK, SECRET_TOKEN, 'abc.def.ghi']) {
      assert.ok(!stored.includes(secret), `secret leaked: ${secret}`);
    }
    const parsed = JSON.parse(stored);
    assert.equal(parsed.settings.server.apiKey, '[REDACTED]');
    assert.equal(parsed.settings.server.url, 'https://gate.example.com');
    assert.match(parsed.wireguardConfig, /Address = 10\.8\.0\.30\/32/);
    assert.match(parsed.wireguardConfig, /PrivateKey = \[REDACTED\]/);
    assert.equal(parsed.server.peerId, peerId);

    const act = getDb().prepare("SELECT details FROM activity_log WHERE event_type = 'support_bundle_uploaded' ORDER BY id DESC LIMIT 1").get();
    assert.equal(JSON.parse(act.details).peerId, peerId);
  });

  it('accepts plain JSON too', async () => {
    const peerId = seedPeer('sb-json');
    const res = await upload(tokenFor(peerId), peerId, bundle(), { gzip: false });
    assert.equal(res.status, 201, JSON.stringify(res.body));
  });

  it('accepts application/octet-stream gzip', async () => {
    const peerId = seedPeer('sb-octet');
    const res = await upload(tokenFor(peerId), peerId, bundle(), { type: 'application/octet-stream' });
    assert.equal(res.status, 201, JSON.stringify(res.body));
  });

  it('requires a token', async () => {
    const peerId = seedPeer('sb-anon');
    const res = await supertest(app).post(`/api/v1/client/support-bundle?peerId=${peerId}`)
      .set('Content-Type', 'application/gzip').send(zlib.gzipSync(JSON.stringify(bundle())));
    assert.equal(res.status, 401);
  });

  it('refuses tokens bound to another peer or not bound at all', async () => {
    const a = seedPeer('sb-a');
    const b = seedPeer('sb-b');
    const resOther = await upload(tokenFor(a), b, bundle());
    assert.equal(resOther.status, 403);
    const unbound = tokens.create({ name: `sb-unbound-${crypto.randomBytes(3).toString('hex')}`, scopes: ['client'] }, '127.0.0.1').rawToken;
    const resUnbound = await upload(unbound, a, bundle());
    assert.equal(resUnbound.status, 403);
    assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM support_bundles WHERE peer_id IN (?, ?)').get(a, b).n, 0);
  });

  it('refuses tokens without the client scope', async () => {
    const peerId = seedPeer('sb-scope');
    const res = await upload(tokenFor(peerId, ['peers']), peerId, bundle());
    assert.equal(res.status, 403);
  });

  it('refuses admin sessions (only devices upload)', async () => {
    const peerId = seedPeer('sb-session');
    const res = await getAgent().post(`/api/v1/client/support-bundle?peerId=${peerId}`)
      .set('X-CSRF-Token', getCsrf())
      .set('Content-Type', 'application/json')
      .send(bundle());
    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'token_required');
  });

  it('rejects an unknown schema, broken gzip, broken JSON and empty bodies', async () => {
    const peerId = seedPeer('sb-bad');
    const token = tokenFor(peerId);
    assert.equal((await upload(token, peerId, { ...bundle(), schema: 2 })).body.error, 'unsupported_schema');
    assert.equal((await upload(token, peerId, Buffer.from([0x1f, 0x8b, 1, 2, 3]))).body.error, 'invalid_gzip');
    assert.equal((await upload(token, peerId, zlib.gzipSync('{nope'))).body.error, 'invalid_json');
    assert.equal((await upload(token, peerId, zlib.gzipSync('[1,2]'))).body.error, 'invalid_bundle');
    const empty = await upload(token, peerId, Buffer.alloc(0));
    assert.equal(empty.status, 400);
  });

  it('rejects bodies over the upload limit (413)', async () => {
    const peerId = seedPeer('sb-big');
    const big = crypto.randomBytes(config.supportBundles.maxUploadBytes + 1024);
    big[0] = 0x1f; big[1] = 0x8b;
    const res = await upload(tokenFor(peerId), peerId, big);
    assert.equal(res.status, 413);
  });

  it('rejects zip bombs (decompressed size over the JSON limit)', async () => {
    const peerId = seedPeer('sb-bomb');
    const huge = Buffer.alloc(config.supportBundles.maxJsonBytes + 1024, 0x20);
    const res = await upload(tokenFor(peerId), peerId, zlib.gzipSync(huge));
    assert.equal(res.status, 413);
    assert.equal(res.body.error, 'too_large');
  });

  it('allows perHour uploads per peer, then 429', async () => {
    const peerId = seedPeer('sb-rate');
    const token = tokenFor(peerId);
    for (let i = 0; i < 3; i++) {
      assert.equal((await upload(token, peerId, bundle())).status, 201);
    }
    const res = await upload(token, peerId, bundle());
    assert.equal(res.status, 429);
    assert.equal(res.body.error, 'rate_limited');
    // Another peer is not affected.
    const other = seedPeer('sb-rate-2');
    assert.equal((await upload(tokenFor(other), other, bundle())).status, 201);
  });
});

describe('retention', () => {
  it('keeps the newest keepPerPeer bundles', async () => {
    config.supportBundles.keepPerPeer = 2;
    config.supportBundles.perHour = 100;
    const peerId = seedPeer('sb-keep');
    const token = tokenFor(peerId);
    const ids = [];
    for (let i = 0; i < 4; i++) {
      const res = await upload(token, peerId, bundle());
      assert.equal(res.status, 201);
      ids.push(res.body.bundle.id);
      // distinct created_at so ordering is deterministic
      getDb().prepare("UPDATE support_bundles SET created_at = datetime('now', ?) WHERE id = ?").run(`-${10 - i} minutes`, res.body.bundle.id);
    }
    const left = svc.list(peerId).map((b) => b.id);
    assert.deepEqual(left, [ids[3], ids[2]]);
    assert.equal(fs.readdirSync(bundleDir(peerId)).length, 2);
  });

  it('cleanup drops bundles older than maxAgeDays and orphaned files', async () => {
    const peerId = seedPeer('sb-age');
    const res = await upload(tokenFor(peerId), peerId, bundle());
    const fresh = await upload(tokenFor(peerId), peerId, bundle());
    getDb().prepare("UPDATE support_bundles SET created_at = datetime('now', '-40 days') WHERE id = ?").run(res.body.bundle.id);
    const orphanDir = path.join(config.supportBundles.dir, '999999');
    fs.mkdirSync(orphanDir, { recursive: true });
    fs.writeFileSync(path.join(orphanDir, '20260101T000000Z-deadbeef.json.gz'), 'x');
    fs.writeFileSync(path.join(bundleDir(peerId), 'stray.tmp'), 'x');

    svc.cleanup();

    assert.deepEqual(svc.list(peerId).map((b) => b.id), [fresh.body.bundle.id]);
    assert.equal(fs.readdirSync(bundleDir(peerId)).length, 1);
    assert.ok(!fs.existsSync(orphanDir));
  });

  it('deleting the peer removes rows (cascade) and cleanup the files', async () => {
    const peerId = seedPeer('sb-del-peer');
    await upload(tokenFor(peerId), peerId, bundle());
    getDb().prepare('DELETE FROM api_tokens WHERE peer_id = ?').run(peerId);
    getDb().prepare('DELETE FROM peers WHERE id = ?').run(peerId);
    assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM support_bundles WHERE peer_id = ?').get(peerId).n, 0);
    svc.cleanup();
    assert.ok(!fs.existsSync(bundleDir(peerId)));
  });
});

describe('admin API', () => {
  it('lists, downloads (redacted) and deletes bundles', async () => {
    const peerId = seedPeer('sb-admin');
    const up = await upload(tokenFor(peerId), peerId, bundle());
    const id = up.body.bundle.id;

    const list = await getAgent().get(`/api/v1/peers/${peerId}/support-bundles`);
    assert.equal(list.status, 200);
    assert.equal(list.body.bundles.length, 1);
    assert.equal(list.body.bundles[0].id, id);
    assert.equal(list.body.bundles[0].client_version, '1.24.0');
    assert.ok(list.body.bundles[0].size_bytes > 0);
    assert.equal(list.body.bundles[0].file_name, undefined);
    assert.equal(list.body.requestedAt, null);

    const dl = await getAgent().get(`/api/v1/peers/${peerId}/support-bundles/${id}/download`).buffer(true).parse((res, cb) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    assert.equal(dl.status, 200);
    assert.match(dl.headers['content-type'], /application\/json/);
    assert.match(dl.headers['content-disposition'], /^attachment; filename="support-sb-admin-\d+\.json"$/);
    const text = dl.body.toString('utf8');
    assert.ok(!text.includes(SECRET_PRIV));
    assert.equal(JSON.parse(text).client.version, '1.24.0');

    // Wrong peer → 404 (no cross-peer access by id)
    const other = seedPeer('sb-admin-other');
    assert.equal((await getAgent().get(`/api/v1/peers/${other}/support-bundles/${id}/download`)).status, 404);

    const del = await getAgent().delete(`/api/v1/peers/${peerId}/support-bundles/${id}`).set('X-CSRF-Token', getCsrf());
    assert.equal(del.status, 200);
    assert.equal(svc.list(peerId).length, 0);
    assert.equal(fs.readdirSync(bundleDir(peerId)).length, 0);
    assert.equal((await getAgent().delete(`/api/v1/peers/${peerId}/support-bundles/${id}`).set('X-CSRF-Token', getCsrf())).status, 404);

    const events = getDb().prepare("SELECT event_type FROM activity_log WHERE event_type LIKE 'support_bundle_%' AND details LIKE ?").all(`%"peerId":${peerId}%`).map((r) => r.event_type);
    assert.ok(events.includes('support_bundle_downloaded'));
    assert.ok(events.includes('support_bundle_deleted'));
  });

  it('refuses API tokens, even with full access', async () => {
    const peerId = seedPeer('sb-admin-token');
    const full = tokens.create({ name: `sb-full-${crypto.randomBytes(3).toString('hex')}`, scopes: ['full-access'] }, '127.0.0.1').rawToken;
    const res = await supertest(app).get(`/api/v1/peers/${peerId}/support-bundles`).set('X-API-Token', full);
    assert.equal(res.status, 403);
  });

  it('404 for unknown peers', async () => {
    assert.equal((await getAgent().get('/api/v1/peers/987654/support-bundles')).status, 404);
  });

  it('request flag: heartbeat + peer-info report it, upload clears it', async () => {
    const peerId = seedPeer('sb-request');
    const token = tokenFor(peerId);
    const hb = () => supertest(app).post('/api/v1/client/heartbeat').set('X-API-Token', token).send({ peerId, connected: true });
    const info = () => supertest(app).get(`/api/v1/client/peer-info?peerId=${peerId}`).set('X-API-Token', token);

    assert.equal((await hb()).body.supportBundleRequested, false);

    const req = await getAgent().post(`/api/v1/peers/${peerId}/support-bundles/request`).set('X-CSRF-Token', getCsrf()).send({});
    assert.equal(req.status, 200);
    assert.ok(req.body.requestedAt);
    assert.equal((await hb()).body.supportBundleRequested, true);
    assert.equal((await hb()).body.supportBundleRequestedAt, req.body.requestedAt);
    assert.equal((await info()).body.supportBundleRequested, true);
    assert.equal((await info()).body.supportBundleRequestedAt, req.body.requestedAt);

    const up = await upload(token, peerId, bundle());
    assert.equal(up.status, 201);
    assert.equal(svc.getById(peerId, up.body.bundle.id).reason, 'admin_request');
    assert.equal((await hb()).body.supportBundleRequested, false);

    // withdraw
    await getAgent().post(`/api/v1/peers/${peerId}/support-bundles/request`).set('X-CSRF-Token', getCsrf()).send({});
    await getAgent().delete(`/api/v1/peers/${peerId}/support-bundles/request`).set('X-CSRF-Token', getCsrf());
    assert.equal((await info()).body.supportBundleRequested, false);
  });

  it('gateways cannot be asked for a bundle', async () => {
    const gw = seedPeer('sb-gw', 'gateway');
    const res = await getAgent().post(`/api/v1/peers/${gw}/support-bundles/request`).set('X-CSRF-Token', getCsrf()).send({});
    assert.equal(res.status, 400);
  });

  it('peer edit modal renders the support bundle section', async () => {
    const res = await getAgent().get('/peers');
    assert.equal(res.status, 200);
    assert.match(res.text, /id="edit-peer-support-group"/);
    assert.match(res.text, /\/js\/support-bundles\.js/);
  });
});
