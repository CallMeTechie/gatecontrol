'use strict';

// Server-controlled client updates (routes):
//   - /api/v1/client/update/check picks the release by the channel the
//     SERVER assigns (peer override → global default), never by a client
//     parameter, and adds channel / minVersion / mandatory
//   - the check and the client API record the reported client version
//   - /api/v1/settings/client-updates (admin session only) and the
//     update_channel field on PUT /api/v1/peers/:id
// GitHub is simulated by replacing https.get.

const crypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const supertest = require('supertest');
const { setup, teardown, getAgent, getCsrf } = require('./helpers/setup');

const PRO_REPO = 'CallMeTechie/GateControl-Pro-Client';
const LATEST_URL = `https://api.github.com/repos/${PRO_REPO}/releases/latest`;
const LIST_URL = `https://api.github.com/repos/${PRO_REPO}/releases?per_page=30`;

function rel(tag, { id, prerelease = false, draft = false } = {}) {
  const v = tag.replace(/^v/, '');
  return {
    id: id || Number(v.replace(/\D/g, '')),
    tag_name: tag,
    prerelease,
    draft,
    body: `notes ${tag}`,
    assets: [{
      id: 1, name: `GateControl.Pro.Client.Setup.${v}.exe`, size: 10,
      url: `https://api.github.com/repos/x/releases/assets/${v}`,
      browser_download_url: `https://github.com/${PRO_REPO}/releases/download/${tag}/GateControl.Pro.Client.Setup.${v}.exe`,
    }],
  };
}

let app;
let routes;
let requests;
const realGet = https.get;

function fakeGet(url, opts, cb) {
  const target = String(url);
  requests.push({ url: target, headers: { ...(opts && opts.headers) } });
  const req = new EventEmitter();
  req.destroy = (err) => { if (err) req.emit('error', err); };
  setImmediate(() => {
    const route = routes[target];
    if (!route) return req.emit('error', new Error(`unexpected request ${target}`));
    const res = new PassThrough();
    res.statusCode = route.status || 200;
    res.headers = route.headers || {};
    cb(res);
    res.end(route.body === undefined ? '' : route.body);
  });
  return req;
}

let getDb;
let tokens;
let updateRouter;
let clientUpdates;

function seedPeer(name) {
  return getDb().prepare("INSERT INTO peers (name, public_key, allowed_ips, enabled) VALUES (?, ?, '10.8.0.20/32', 1)")
    .run(name, `PUB_${name}_${crypto.randomBytes(4).toString('hex')}=`).lastInsertRowid;
}
function tokenFor(peerId, scopes = ['client']) {
  return tokens.create({ name: `t-${peerId}-${crypto.randomBytes(3).toString('hex')}`, scopes, peerId }, '127.0.0.1').rawToken;
}
const check = (q, token) => {
  const r = supertest(app).get(`/api/v1/client/update/check?${q}`);
  return token ? r.set('X-API-Token', token) : r;
};

before(async () => {
  const ctx = await setup();
  app = ctx.app;
  getDb = require('../src/db/connection').getDb;
  tokens = require('../src/services/tokens');
  updateRouter = require('../src/routes/api/client/update');
  clientUpdates = require('../src/services/clientUpdates');
});
after(() => teardown());

beforeEach(() => {
  updateRouter._resetCache();
  clientUpdates._resetForTest();
  getDb().prepare("DELETE FROM settings WHERE key LIKE 'client_update.%'").run();
  delete process.env.GC_CLIENT_GITHUB_TOKEN;
  routes = {
    [LATEST_URL]: { body: JSON.stringify(rel('v1.22.0')) },
    [LIST_URL]: {
      body: JSON.stringify([
        rel('v1.24.0', { draft: true }),            // drafts never count
        rel('v1.23.0', { prerelease: true }),
        rel('v1.22.0'),
        rel('v1.23.0-rc.1', { id: 5, prerelease: true }),
      ]),
    },
  };
  requests = [];
  https.get = fakeGet;
});
afterEach(() => {
  https.get = realGet;
  delete process.env.GC_CLIENT_GITHUB_TOKEN;
});

describe('update check: channels', () => {
  it('anonymous request gets the stable channel (releases/latest)', async () => {
    const res = await check('version=1.21.0&platform=windows&client=pro');
    assert.equal(res.status, 200);
    assert.equal(res.body.available, true);
    assert.equal(res.body.version, '1.22.0');
    assert.equal(res.body.channel, 'stable');
    assert.equal(res.body.prerelease, false);
    assert.equal(res.body.mandatory, false);
    assert.equal(res.body.minVersion, null);
    assert.ok(requests.some(r => r.url === LATEST_URL));
    assert.ok(!requests.some(r => r.url === LIST_URL));
  });

  it('a client cannot pick beta itself (query/header are ignored)', async () => {
    const res = await supertest(app)
      .get('/api/v1/client/update/check?version=1.21.0&platform=windows&client=pro&channel=beta')
      .set('X-Update-Channel', 'beta');
    assert.equal(res.body.channel, 'stable');
    assert.equal(res.body.version, '1.22.0');
  });

  it('peer assigned to beta gets the newest release incl. pre-releases, never drafts', async () => {
    const peerId = seedPeer('beta-peer');
    clientUpdates.setPeerChannel(peerId, 'beta');
    const res = await check('version=1.22.0&platform=windows&client=pro', tokenFor(peerId));
    assert.equal(res.body.available, true);
    assert.equal(res.body.channel, 'beta');
    assert.equal(res.body.version, '1.23.0');
    assert.equal(res.body.prerelease, true);
    assert.ok(requests.some(r => r.url === LIST_URL));
  });

  it('global default beta applies to peers without override; a stable override wins', async () => {
    getDb().prepare("INSERT INTO settings (key, value) VALUES ('client_update.default_channel', 'beta')").run();
    const a = seedPeer('default-peer');
    const b = seedPeer('stable-peer');
    clientUpdates.setPeerChannel(b, 'stable');
    const ra = await check('version=1.22.0&platform=windows&client=pro', tokenFor(a));
    assert.equal(ra.body.channel, 'beta');
    assert.equal(ra.body.version, '1.23.0');
    const rb = await check('version=1.22.0&platform=windows&client=pro', tokenFor(b));
    assert.equal(rb.body.channel, 'stable');
    assert.equal(rb.body.available, false);
  });

  it('an unknown or out-of-scope token counts as anonymous', async () => {
    const peerId = seedPeer('scoped');
    clientUpdates.setPeerChannel(peerId, 'beta');
    const unknown = await check('version=1.22.0&platform=windows&client=pro', 'gc_' + 'f'.repeat(40));
    assert.equal(unknown.body.channel, 'stable');
    const noScope = await check('version=1.22.0&platform=windows&client=pro', tokenFor(peerId, ['peers']));
    assert.equal(noScope.body.channel, 'stable');
  });

  it('switching beta → stable never offers a downgrade', async () => {
    const peerId = seedPeer('back-to-stable');
    // client runs the 1.23.0 pre-release, stable latest is 1.22.0
    const res = await check('version=1.23.0&platform=windows&client=pro', tokenFor(peerId));
    assert.equal(res.body.channel, 'stable');
    assert.equal(res.body.available, false);
    assert.equal(res.body.mandatory, false);
  });
});

describe('update check: minimum version', () => {
  it('mandatory when below the product minimum and an update exists', async () => {
    getDb().prepare("INSERT INTO settings (key, value) VALUES ('client_update.min_version.pro', '1.21.5')").run();
    const below = await check('version=1.21.0&platform=windows&client=pro');
    assert.equal(below.body.available, true);
    assert.equal(below.body.minVersion, '1.21.5');
    assert.equal(below.body.mandatory, true);

    const above = await check('version=1.21.5&platform=windows&client=pro');
    assert.equal(above.body.available, true);
    assert.equal(above.body.mandatory, false);
  });

  it('minimum of the other product does not apply; Android never mandatory', async () => {
    getDb().prepare("INSERT INTO settings (key, value) VALUES ('client_update.min_version.community', '9.0.0')").run();
    const res = await check('version=1.21.0&platform=windows&client=pro');
    assert.equal(res.body.minVersion, null);
    assert.equal(res.body.mandatory, false);
  });

  it('no update available → mandatory false even below the minimum', async () => {
    getDb().prepare("INSERT INTO settings (key, value) VALUES ('client_update.min_version.pro', '5.0.0')").run();
    const res = await check('version=1.22.0&platform=windows&client=pro');
    assert.deepEqual(res.body, { ok: true, available: false, channel: 'stable', minVersion: '5.0.0', mandatory: false });
  });
});

describe('download follows the assigned channel', () => {
  it('private repo proxy resolves the beta release for a beta peer', async () => {
    process.env.GC_CLIENT_GITHUB_TOKEN = 'ghp_test';
    const peerId = seedPeer('dl-beta');
    clientUpdates.setPeerChannel(peerId, 'beta');
    const asset = rel('v1.23.0').assets[0];
    routes[asset.url] = { body: '0123456789' }; // asset.size bytes
    const res = await supertest(app)
      .get('/api/v1/client/update/download?client=pro')
      .set('X-API-Token', tokenFor(peerId));
    assert.equal(res.status, 200);
    assert.ok(requests.some(r => r.url === LIST_URL));
    assert.ok(requests.some(r => r.url === asset.url));
  });
});

describe('client version recording', () => {
  it('the update check stores version + product for the token peer', async () => {
    const peerId = seedPeer('rec-check');
    await check('version=1.21.0&platform=windows&client=community', tokenFor(peerId));
    const row = getDb().prepare('SELECT client_version, client_product, client_platform FROM peers WHERE id = ?').get(peerId);
    assert.deepEqual({ ...row }, { client_version: '1.21.0', client_product: 'community', client_platform: 'windows' });
  });

  it('any authenticated client request (heartbeat) stores the X-Client-Version header', async () => {
    const peerId = seedPeer('rec-hb');
    const res = await supertest(app)
      .post('/api/v1/client/heartbeat')
      .set('X-API-Token', tokenFor(peerId))
      .set('X-Client-Version', '1.13.3')
      .set('X-Client-Platform', 'android')
      .send({ peerId, connected: true, rxBytes: 0, txBytes: 0, uptime: 1, hostname: 'phone' });
    assert.equal(res.status, 200);
    const row = getDb().prepare('SELECT client_version, client_product, client_platform FROM peers WHERE id = ?').get(peerId);
    assert.deepEqual({ ...row }, { client_version: '1.13.3', client_product: 'android', client_platform: 'android' });
  });
});

describe('admin API', () => {
  it('GET/PUT /settings/client-updates validates, saves and audits', async () => {
    const agent = getAgent();
    const csrf = getCsrf();
    const get = await agent.get('/api/v1/settings/client-updates').expect(200);
    assert.equal(get.body.data.default_channel, 'stable');
    assert.deepEqual(get.body.data.min_versions, { pro: null, community: null });

    await agent.put('/api/v1/settings/client-updates').set('X-CSRF-Token', csrf)
      .send({ default_channel: 'nightly' }).expect(400);
    await agent.put('/api/v1/settings/client-updates').set('X-CSRF-Token', csrf)
      .send({ min_versions: { pro: '1.2' } }).expect(400);

    const put = await agent.put('/api/v1/settings/client-updates').set('X-CSRF-Token', csrf)
      .send({ default_channel: 'beta', min_versions: { pro: '1.22.0', community: '' } }).expect(200);
    assert.equal(put.body.data.default_channel, 'beta');
    assert.equal(put.body.data.min_versions.pro, '1.22.0');
    assert.ok(put.body.data.overview);

    const log = getDb().prepare("SELECT details FROM activity_log WHERE event_type = 'client_update_policy_updated' ORDER BY id DESC LIMIT 1").get();
    assert.ok(log);
    const details = JSON.parse(log.details);
    assert.deepEqual(details.default_channel, { from: 'stable', to: 'beta' });
    assert.deepEqual(details.min_version_pro, { from: null, to: '1.22.0' });
  });

  it('settings route rejects API tokens (session only)', async () => {
    const raw = tokens.create({ name: 'settings-token', scopes: ['full-access'] }, '127.0.0.1').rawToken;
    await supertest(app).put('/api/v1/settings/client-updates').set('X-API-Token', raw)
      .send({ default_channel: 'beta' }).expect(403);
    assert.equal(clientUpdates.getPolicy().defaultChannel, 'stable');
  });

  it('PUT /peers/:id update_channel: validated, audited, session only', async () => {
    const agent = getAgent();
    const csrf = getCsrf();
    const created = await agent.post('/api/v1/peers').set('X-CSRF-Token', csrf).send({ name: 'chan-peer' }).expect(201);
    const id = created.body.peer.id;

    await agent.put(`/api/v1/peers/${id}`).set('X-CSRF-Token', csrf)
      .send({ name: 'chan-peer', update_channel: 'nightly' }).expect(400);

    const ok = await agent.put(`/api/v1/peers/${id}`).set('X-CSRF-Token', csrf)
      .send({ name: 'chan-peer', update_channel: 'beta' }).expect(200);
    assert.equal(ok.body.peer.update_channel, 'beta');
    assert.equal(ok.body.peer.update_channel_effective, 'beta');
    const log = getDb().prepare("SELECT details FROM activity_log WHERE event_type = 'peer_update_channel_changed' ORDER BY id DESC LIMIT 1").get();
    assert.deepEqual(JSON.parse(log.details), { peerId: id, from: null, to: 'beta' });

    const raw = tokens.create({ name: 'peers-token', scopes: ['full-access'] }, '127.0.0.1').rawToken;
    await supertest(app).put(`/api/v1/peers/${id}`).set('X-API-Token', raw)
      .send({ update_channel: 'stable' }).expect(403);
    assert.equal(getDb().prepare('SELECT update_channel FROM peers WHERE id = ?').get(id).update_channel, 'beta');

    // back to the global default
    const cleared = await agent.put(`/api/v1/peers/${id}`).set('X-CSRF-Token', csrf)
      .send({ name: 'chan-peer', update_channel: null }).expect(200);
    assert.equal(cleared.body.peer.update_channel, null);
    assert.equal(cleared.body.peer.update_channel_effective, 'stable');
  });

  it('GET /peers carries the client fields and the update policy', async () => {
    const agent = getAgent();
    const peerId = seedPeer('listed');
    getDb().prepare("INSERT INTO settings (key, value) VALUES ('client_update.min_version.pro', '1.22.0')").run();
    clientUpdates.recordClientVersion(peerId, { version: '1.20.0', product: 'pro', platform: 'windows' });
    const res = await agent.get('/api/v1/peers').expect(200);
    const row = res.body.peers.find(p => p.id === peerId);
    assert.equal(row.client_version, '1.20.0');
    assert.equal(row.client_product, 'pro');
    assert.equal(row.client_below_min, true);
    assert.equal(row.update_channel_effective, 'stable');
    assert.deepEqual(res.body.update_policy, { default_channel: 'stable', min_versions: { pro: '1.22.0', community: null } });
  });
});
