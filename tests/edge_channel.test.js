'use strict';

// Edge parts end to end (docs/plugins.md "Edge part"): the WebSocket of the
// gateways (auth, subprotocol, frames, limits, ping), the `state` (switches,
// assignments, update_pending, unsigned), the package endpoint, the admin API
// (session, CSRF), MQTT accounts, the activity log — and gc.edge in a real
// plugin process against the test edge host (scripts/plugin-edge-host.js).

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const supertest = require('supertest');
const WebSocket = require('ws');
const { edgePackage } = require('./helpers/plugins');
const { setup, teardown, getCsrf } = require('./helpers/setup');
const { createEdgeHost, NO_REPLY } = require('../scripts/plugin-edge-host');

let app, agent, csrf, server, baseUrl, hub, runtime, plugins, db;
let gwA, gwB; // { peer, apiToken }
const hosts = [];

const API = '/api/v1/edge';
const P = 'edge-demo';
const CAPS = ['http.lan', 'mqtt.topic:shellies/#', 'udp.multicast:224.0.1.187', 'udp.port:5683'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function installPkg(buf) {
  const r = await agent.post('/api/v1/plugins/inspect').set('X-CSRF-Token', csrf).set('Content-Type', 'application/octet-stream').send(buf);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.canInstall, true, JSON.stringify(r.body.checks));
  const res = await agent.post('/api/v1/plugins/install').set('X-CSRF-Token', csrf).send({ token: r.body.token, accept: true });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body;
}

/** POST to the plugin's own API (its server part, gc.edge inside). */
async function pluginApi(path, body, id = P) {
  const r = await agent.post(`/api/v1/plugins/${id}/api${path}`).set('X-CSRF-Token', csrf).send(body || {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}

const put = (p, body) => agent.put(API + p).set('X-CSRF-Token', csrf).send(body);
const post = (p, body) => agent.post(API + p).set('X-CSRF-Token', csrf).send(body || {});

async function host(gw, extra) {
  const h = await createEdgeHost({ serverUrl: baseUrl, apiToken: gw.apiToken, ...extra });
  hosts.push(h);
  return h;
}

/** A raw WebSocket attempt → { status } (refused) or { ws } (open). */
function rawConnect({ token, protocols = ['gc-edge.v1'], opts = {} } = {}) {
  return new Promise((resolve) => {
    const headers = token ? { Authorization: 'Bearer ' + token } : {};
    const ws = new WebSocket(baseUrl.replace('http', 'ws') + '/api/v1/gateway/edge/ws', protocols, { headers, ...opts });
    ws.on('unexpected-response', (_req, res) => { res.resume(); resolve({ status: res.statusCode }); });
    ws.on('open', () => resolve({ ws }));
    ws.on('error', (e) => resolve({ error: e.message }));
  });
}

function closed(ws) {
  return new Promise((resolve) => ws.on('close', (code) => resolve(code)));
}

const hello = { t: 'hello', v: 1, gw: { version: '1.20.0', edgeHost: '1.0.0', mqtt: { available: true } } };

function activities(type) {
  return db.prepare('SELECT event_type, message, details FROM activity_log WHERE event_type = ? ORDER BY id').all(type);
}

before(async () => {
  ({ app, agent } = await setup());
  csrf = getCsrf();
  require('../src/services/license')._overrideForTest({ gateway_peers: 10 });
  const gateways = require('../src/services/gateways');
  gwA = await gateways.createGateway({ name: 'gw-a' });
  gwB = await gateways.createGateway({ name: 'gw-b' });
  hub = require('../src/services/edge/hub');
  runtime = require('../src/services/plugins/runtime');
  plugins = require('../src/services/plugins');
  db = require('../src/db/connection').getDb();
  runtime._setBackoffForTest([150]);
  server = http.createServer(app).listen(0);
  hub.attach(server);
  await new Promise((r) => server.once('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  await installPkg(edgePackage());
  assert.equal(await runtime.waitRunning(P), true);
});

after(async () => {
  for (const h of hosts) await h.close();
  hub._setForTest({ deliver: null, limits: null });
  hub._resetForTest();
  await plugins.stop();
  await new Promise((r) => server.close(r));
  teardown();
});

describe('WebSocket: authentication and subprotocol', () => {
  it('without a token → 401', async () => {
    assert.equal((await rawConnect()).status, 401);
  });
  it('a wrong gateway token → 403, a token of another kind → 401', async () => {
    assert.equal((await rawConnect({ token: 'gc_gw_' + 'a'.repeat(64) })).status, 403);
    assert.equal((await rawConnect({ token: 'gc_' + 'a'.repeat(40) })).status, 401);
  });
  it('the subprotocol gc-edge.v1 is required', async () => {
    assert.equal((await rawConnect({ token: gwA.apiToken, protocols: ['other'] })).status, 400);
    assert.equal((await rawConnect({ token: gwA.apiToken, protocols: [] })).status, 400);
  });
  it('a disabled gateway peer is refused', async () => {
    db.prepare('UPDATE peers SET enabled = 0 WHERE id = ?').run(gwB.peer.id);
    try {
      assert.equal((await rawConnect({ token: gwB.apiToken })).status, 403);
    } finally { db.prepare('UPDATE peers SET enabled = 1 WHERE id = ?').run(gwB.peer.id); }
  });
  it('the right token and subprotocol → open, protocol gc-edge.v1', async () => {
    const { ws } = await rawConnect({ token: gwB.apiToken });
    assert.equal(ws.protocol, 'gc-edge.v1');
    ws.close();
    await closed(ws);
  });
});

describe('WebSocket: frames and limits', () => {
  it('anything before hello closes the connection (1008)', async () => {
    const { ws } = await rawConnect({ token: gwB.apiToken });
    const c = closed(ws);
    ws.send(JSON.stringify({ t: 'status', plugins: [] }));
    assert.equal(await c, 1008);
  });
  it('no hello in time → 1008', async () => {
    hub._setForTest({ limits: { helloMs: 150 } });
    try {
      const { ws } = await rawConnect({ token: gwB.apiToken });
      assert.equal(await closed(ws), 1008);
    } finally { hub._setForTest({ limits: null }); }
  });
  it('binary frames → 1003, invalid JSON → 1007, a frame over 64 KB → 1009', async () => {
    let { ws } = await rawConnect({ token: gwB.apiToken });
    let c = closed(ws);
    ws.send(Buffer.from('{}'), { binary: true });
    assert.equal(await c, 1003);
    ({ ws } = await rawConnect({ token: gwB.apiToken }));
    c = closed(ws);
    ws.send('{not json');
    assert.equal(await c, 1007);
    ({ ws } = await rawConnect({ token: gwB.apiToken }));
    c = closed(ws);
    ws.send(JSON.stringify({ ...hello, pad: 'x'.repeat(64 * 1024) }));
    assert.equal(await c, 1009);
  });
  it('an invalid hello → 1008', async () => {
    const { ws } = await rawConnect({ token: gwB.apiToken });
    const c = closed(ws);
    ws.send(JSON.stringify({ t: 'hello', v: 2, gw: { version: '1.20.0' } }));
    assert.equal(await c, 1008);
  });
  it('ping: a gateway that answers stays, a silent one is dropped after the dead time', async () => {
    hub._setForTest({ limits: { pingMs: 50, deadMs: 300 } });
    try {
      const alive = await rawConnect({ token: gwB.apiToken });
      alive.ws.send(JSON.stringify(hello));
      const silent = await rawConnect({ token: gwA.apiToken, opts: { autoPong: false } });
      silent.ws.send(JSON.stringify(hello));
      let pings = 0;
      alive.ws.on('ping', () => { pings++; });
      const code = await closed(silent.ws);
      assert.equal(code, 1006, 'terminated');
      assert.equal(alive.ws.readyState, WebSocket.OPEN);
      assert.ok(pings >= 3, 'the server pings: ' + pings);
      alive.ws.close();
      await closed(alive.ws);
    } finally { hub._setForTest({ limits: null }); }
  });
  it('a second connection of the same gateway replaces the first (4000)', async () => {
    const first = await host(gwB);
    const second = await host(gwB);
    const c = await first.waitForClose(2000);
    assert.equal(c.code, 4000);
    assert.equal(second.closed, null);
    await second.close();
  });
});

describe('state, switches and the admin API', () => {
  let h;
  before(async () => { h = await host(gwA); });

  it('after hello: the full target state, nothing switched on yet', () => {
    assert.deepEqual(h.state, { t: 'state', edgeEnabled: false, allowUnsigned: false, plugins: [], mqtt: { enabled: false, tls: false, accounts: [], pluginTopics: {} } });
  });

  it('the admin API needs a session: API tokens are refused, writes need the CSRF token', async () => {
    const tokens = require('../src/services/tokens');
    const { rawToken } = tokens.create({ name: 'edge-tok', scopes: ['full-access'] }, '127.0.0.1');
    const anon = supertest(app);
    assert.equal((await anon.get(`${API}/gateways`).set('Authorization', 'Bearer ' + rawToken)).status, 403);
    assert.equal((await anon.put(`${API}/gateways/${gwA.peer.id}/settings`).set('Authorization', 'Bearer ' + rawToken).send({ edgeEnabled: true })).status, 403);
    assert.equal((await anon.get(`${API}/gateways`)).status, 401);
    const noCsrf = await agent.put(`${API}/gateways/${gwA.peer.id}/settings`).send({ edgeEnabled: true });
    assert.equal(noCsrf.status, 403);
    assert.equal(h.state.edgeEnabled, false);
  });

  it('gateway overview lists the plugin with its capabilities, not assigned', async () => {
    const r = await agent.get(`${API}/gateways/${gwA.peer.id}`).expect(200);
    assert.equal(r.body.gateway.connection.online, true);
    assert.equal(r.body.gateway.gateway.version, '1.20.0');
    const p = r.body.gateway.plugins.find((x) => x.id === P);
    assert.deepEqual(p.edge.capabilities.map((x) => x.key), CAPS);
    assert.equal(p.assignment, null);
    assert.deepEqual(r.body.gateway.support, { gatewayVersion: '1.20.0', edgeSupported: true, edgeMinGateway: '1.19.0', edgeMode: null, isolatedSupported: false, isolatedMinGateway: '1.23.0' });
    assert.equal(r.body.gateway.gateway.isolation, null, 'older gateway: no isolation in hello');
    const list = await agent.get(`${API}/gateways`).expect(200);
    assert.deepEqual(list.body.gateways.map((g) => g.name), ['gw-a', 'gw-b']);
    // gw-b never connected: its version comes from the heartbeat — older than the first release with edge
    db.prepare('UPDATE gateway_meta SET last_health = ? WHERE peer_id = ?').run(JSON.stringify({ telemetry: { gateway_version: '1.18.0' } }), gwB.peer.id);
    db.prepare('DELETE FROM gateway_edge WHERE peer_id = ?').run(gwB.peer.id);
    const b = (await agent.get(`${API}/gateways`).expect(200)).body.gateways.find((g) => g.id === gwB.peer.id);
    assert.deepEqual(b.support, { gatewayVersion: '1.18.0', edgeSupported: false, edgeMinGateway: '1.19.0', edgeMode: null, isolatedSupported: false, isolatedMinGateway: '1.23.0' });
  });

  it('edge on → new state; enabling needs exactly the shown capability list', async () => {
    await put(`/gateways/${gwA.peer.id}/settings`, { edgeEnabled: true }).expect(200);
    await h.waitForState((s) => s.edgeEnabled === true);
    const bad = await post(`/gateways/${gwA.peer.id}/plugins/${P}/enable`, { capabilities: CAPS.slice(1) });
    assert.equal(bad.status, 409);
    assert.equal(bad.body.code, 'caps_mismatch');
    assert.deepEqual(bad.body.capabilities, CAPS);
    assert.equal((await post(`/gateways/${gwA.peer.id}/plugins/${P}/enable`, {})).status, 409);
    const ok = await post(`/gateways/${gwA.peer.id}/plugins/${P}/enable`, { capabilities: CAPS.slice().reverse() });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const st = await h.waitForState((s) => s.plugins.some((p) => p.id === P && p.enabled));
    const entry = st.plugins.find((p) => p.id === P);
    assert.equal(entry.version, '1.0.0');
    assert.match(entry.sha256, /^[0-9a-f]{64}$/);
    assert.equal(entry.memoryMb, 48);
    assert.deepEqual(entry.caps, { udp: { ports: [5683], multicast: ['224.0.1.187'] }, http: { lan: true }, mqtt: { topics: ['shellies/#'] } });
    assert.equal('reason' in entry, false);
    // the plugin's MQTT topics only reach the broker while MQTT is on
    assert.deepEqual(st.mqtt.pluginTopics, {});
    const types = db.prepare("SELECT event_type FROM activity_log WHERE event_type LIKE 'gateway_edge_%'").all().map((x) => x.event_type);
    assert.ok(types.includes('gateway_edge_enabled'));
    assert.ok(types.includes('gateway_edge_plugin_enabled'));
    assert.ok(types.includes('gateway_edge_caps_approved'));
    assert.deepEqual(JSON.parse(activities('gateway_edge_plugin_enabled')[0].details).capabilities, CAPS);
  });

  it('an install or approval from before with http.selfSigned: the state never carries it', () => {
    const before = db.prepare('SELECT manifest FROM plugins WHERE id = ?').get(P).manifest;
    const beforeCaps = db.prepare('SELECT caps FROM edge_assignments WHERE plugin_id = ? AND peer_id = ?').get(P, gwA.peer.id).caps;
    try {
      const m = JSON.parse(before);
      m.edge.capabilities.http = { lan: true, selfSigned: true };
      db.prepare('UPDATE plugins SET manifest = ? WHERE id = ?').run(JSON.stringify(m), P);
      const c = JSON.parse(beforeCaps);
      c.http = { lan: true, selfSigned: true };
      db.prepare('UPDATE edge_assignments SET caps = ? WHERE plugin_id = ? AND peer_id = ?').run(JSON.stringify(c), P, gwA.peer.id);
      const state = require('../src/services/edge/state');
      const on = state.compute(gwA.peer.id).plugins.find((x) => x.id === P);
      assert.equal(on.enabled, true, 'still runs — the capability list did not grow');
      assert.deepEqual(on.caps.http, { lan: true });
      db.prepare('UPDATE edge_assignments SET enabled = 0 WHERE plugin_id = ? AND peer_id = ?').run(P, gwA.peer.id);
      const off = state.compute(gwA.peer.id).plugins.find((x) => x.id === P);
      assert.equal(off.reason, 'disabled');
      assert.deepEqual(off.caps.http, { lan: true }, 'the approval snapshot is cleaned too');
    } finally {
      db.prepare('UPDATE plugins SET manifest = ? WHERE id = ?').run(before, P);
      db.prepare('UPDATE edge_assignments SET caps = ?, enabled = 1 WHERE plugin_id = ? AND peer_id = ?').run(beforeCaps, P, gwA.peer.id);
    }
  });

  it('a plugin unknown or without an edge part cannot be enabled', async () => {
    assert.equal((await post(`/gateways/${gwA.peer.id}/plugins/nope/enable`, { capabilities: [] })).status, 404);
    assert.equal((await post('/gateways/999999/plugins/' + P + '/enable', { capabilities: CAPS })).status, 404);
  });

  it('the plugin view shows it on every gateway', async () => {
    const r = await agent.get(`${API}/plugins/${P}`).expect(200);
    const a = r.body.plugin.gateways.find((g) => g.id === gwA.peer.id);
    assert.equal(a.assignment.enabled, true);
    assert.deepEqual(a.assignment.approved.capabilities, CAPS);
    assert.equal(r.body.plugin.gateways.find((g) => g.id === gwB.peer.id).assignment, null);
  });
});

describe('package endpoint', () => {
  const pkgUrl = (v = '1.0.0') => `/api/v1/gateway/edge/packages/${P}/${v}`;
  it('the switched-on gateway gets the signed package; its sha256 is the one of the state', async () => {
    const h = hosts.find((x) => !x.closed && x.o.apiToken === gwA.apiToken);
    const r = await supertest(app).get(pkgUrl()).set('Authorization', 'Bearer ' + gwA.apiToken).buffer(true)
      .parse((res, cb) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });
    assert.equal(r.status, 200);
    const sha = crypto.createHash('sha256').update(r.body).digest('hex');
    assert.equal(sha, h.state.plugins.find((p) => p.id === P).sha256);
    assert.equal(r.headers['x-content-sha256'], sha);
    const files = require('../src/services/plugins/package').decode(r.body);
    assert.equal(require('../src/services/plugins/signature').verify(files).status, 'trusted');
    assert.ok(files.has('edge/index.js'));
  });
  it('another gateway, a wrong version, no token → refused', async () => {
    const anon = supertest(app);
    const b = await anon.get(pkgUrl()).set('Authorization', 'Bearer ' + gwB.apiToken);
    assert.equal(b.status, 403);
    assert.equal(b.body.reason, 'not_assigned');
    assert.equal((await anon.get(pkgUrl('0.9.0')).set('Authorization', 'Bearer ' + gwA.apiToken)).status, 404);
    assert.equal((await anon.get(pkgUrl())).status, 401);
    assert.equal((await anon.get('/api/v1/gateway/edge/packages/hello/1.0.0').set('Authorization', 'Bearer ' + gwA.apiToken)).status, 403);
  });
  it('package files: paths stay inside the plugin folder, only the matching package is kept', () => {
    const packages = require('../src/services/edge/packages');
    for (const v of ['..', '../hello', '1.0.0/../../x', '', '.hidden']) assert.throws(() => packages.pathOf(P, v, packages.FILE), /invalid version|outside/, v);
    assert.throws(() => packages.pathOf('../x', '1.0.0', packages.FILE));
    assert.throws(() => packages.save(P, '1.0.0', edgePackage({ overrides: { version: '9.9.9' } })), /does not match/);
    assert.throws(() => packages.save(P, '1.0.0', Buffer.from('not a package')));
  });
  it('a package missing on disk (older install, restore) is rebuilt with the same signature', async () => {
    const packages = require('../src/services/edge/packages');
    const fs = require('node:fs');
    const file = packages.pathOf(P, '1.0.0', packages.FILE);
    fs.unlinkSync(file);
    packages._clearCacheForTest();
    assert.match(packages.info(P, '1.0.0').sha256, /^[0-9a-f]{64}$/);
    const files = require('../src/services/plugins/package').decode(fs.readFileSync(file));
    assert.equal(require('../src/services/plugins/signature').verify(files).status, 'trusted');
  });
});

describe('gc.edge in the plugin process', () => {
  let h;
  before(async () => {
    h = hosts.find((x) => !x.closed && x.o.apiToken === gwA.apiToken);
    h.handle(P, 'ping', async (params) => ({ pong: params }));
    h.handle(P, 'fail', async () => { throw Object.assign(new Error('device unreachable'), { code: 'EHOSTUNREACH' }); });
    h.handle(P, 'deny', async () => { throw Object.assign(new Error('capability missing'), { code: 'denied' }); });
    h.handle(P, 'slow', () => new Promise((r) => setTimeout(() => r('late'), 2000)));
    h.handle(P, 'silent', () => NO_REPLY);
  });

  it('the plugin has gc.edge and gc.mqtt (edge part with MQTT topics)', async () => {
    assert.deepEqual(await pluginApi('/features'), { ok: true, edge: true, mqtt: true });
  });

  it('gateways(): the gateways it is set up for, with state and version', async () => {
    const r = await pluginApi('/gateways');
    assert.equal(r.ok, true);
    assert.deepEqual(r.result, [{ id: gwA.peer.id, name: 'gw-a', state: 'running', online: true, version: '1.20.0', reason: null }]);
  });

  it('call(): the edge part answers', async () => {
    const r = await pluginApi('/call', { gatewayId: gwA.peer.id, method: 'ping', params: { n: 1 } });
    assert.deepEqual(r, { ok: true, result: { pong: { n: 1 } } });
  });

  it('call(): errors of the edge part → edge_error, denied stays denied', async () => {
    const f = await pluginApi('/call', { gatewayId: gwA.peer.id, method: 'fail' });
    assert.equal(f.code, 'edge_error');
    assert.equal(f.error, 'EHOSTUNREACH: device unreachable', 'the edge part\'s own code in front');
    assert.equal((await pluginApi('/call', { gatewayId: gwA.peer.id, method: 'deny' })).code, 'denied');
    assert.equal((await pluginApi('/call', { gatewayId: gwA.peer.id, method: 'unknown' })).code, 'edge_error');
  });

  it('call(): timeouts — the gateway reports one, or never answers', async () => {
    const t = await pluginApi('/call', { gatewayId: gwA.peer.id, method: 'slow', timeoutMs: 200 });
    assert.equal(t.code, 'timeout');
    const started = Date.now();
    const s = await pluginApi('/call', { gatewayId: gwA.peer.id, method: 'silent', timeoutMs: 100 });
    assert.equal(s.code, 'timeout');
    assert.ok(Date.now() - started >= 2000, 'the server waits timeoutMs + 2 s');
  });

  it('call(): not switched on there → not_enabled; invalid arguments → ERR_INVALID', async () => {
    assert.equal((await pluginApi('/call', { gatewayId: gwB.peer.id, method: 'ping' })).code, 'not_enabled');
    assert.equal((await pluginApi('/call', { gatewayId: 'x', method: 'ping' })).code, 'ERR_INVALID');
    assert.equal((await pluginApi('/call', { gatewayId: gwA.peer.id, method: 'bad method!' })).code, 'ERR_INVALID');
  });

  it('configure(): reaches the edge part, is never stored on the server', async () => {
    const r = await pluginApi('/configure', { gatewayId: gwA.peer.id, data: { apiKey: 'conf-secret-4711', devices: ['lamp'] } });
    assert.deepEqual(r, { ok: true, result: { sent: true } });
    assert.deepEqual(await h.waitForConfig(P), { apiKey: 'conf-secret-4711', devices: ['lamp'] });
    for (const t of ['gateway_edge', 'edge_assignments', 'edge_logs', 'activity_log', 'settings']) {
      const rows = JSON.stringify(db.prepare(`SELECT * FROM ${t}`).all());
      assert.equal(rows.includes('conf-secret-4711'), false, t);
    }
  });

  it('events: delivered to gc.edge.on, acknowledged after the handlers ran', async () => {
    const seq = h.emit(P, 'device.found', { id: 'lamp' });
    await h.waitForAck(P, seq);
    const ev = (await pluginApi('/events')).events;
    assert.ok(ev.some((e) => e.name === 'device.found' && e.seq === seq && e.data.id === 'lamp' && e.gatewayId === gwA.peer.id));
    // a slow handler: no ack before it finished
    const s2 = h.emit(P, 'slow', {});
    await sleep(300);
    assert.ok((h.acks.get(P) ?? -1) < s2, 'not acknowledged while the handler runs');
    await pluginApi('/release');
    await h.waitForAck(P, s2);
    // a handler that throws: handed over all the same (the error is in the plugin's log)
    const s3 = h.emit(P, 'boom', {});
    await h.waitForAck(P, s3);
  });

  it('events: a repeated seq is acknowledged again, not delivered twice', async () => {
    const seq = h.emit(P, 'dup', { n: 1 });
    await h.waitForAck(P, seq);
    h.emit(P, 'dup', { n: 1 }, { seq });
    await sleep(200);
    const ev = (await pluginApi('/events')).events.filter((e) => e.name === 'dup');
    assert.equal(ev.length, 1);
  });

  it('events: a failed delivery is tried again; nothing after it is acknowledged first', async () => {
    hub._setForTest({ limits: { retryMs: 100, retryMaxMs: 200 }, deliver: () => Promise.reject(Object.assign(new Error('not running'), { code: 'ERR_NOT_RUNNING' })) });
    try {
      const a = h.emit(P, 'retry', { n: 1 });
      h.emit(P, 'retry', { n: 2 });
      await sleep(350);
      assert.ok((h.acks.get(P) ?? -1) < a, 'nothing acknowledged while the plugin cannot take it');
      hub._setForTest({ deliver: null });
      await h.waitForAck(P, h.seqs.get(P), 3000);
      assert.deepEqual((await pluginApi('/events')).events.filter((e) => e.name === 'retry').map((e) => e.data.n), [1, 2]);
      const logs = (await agent.get(`${API}/gateways/${gwA.peer.id}/logs?plugin=${P}&kind=system`).expect(200)).body.entries;
      assert.ok(logs.some((l) => /retry #\d+ not delivered \(ERR_NOT_RUNNING\) — trying again/.test(l.message)));
    } finally { hub._setForTest({ limits: null, deliver: null }); }
  });

  it('events: a full queue drops the newest unacknowledged (throttled); sent again they arrive', async () => {
    hub._setForTest({ limits: { queueMax: 3 } });
    try {
      const slow = h.emit(P, 'slow', {}); // blocks the queue in the plugin's handler
      await sleep(200);
      const seqs = [];
      for (let i = 0; i < 6; i++) seqs.push(h.emit(P, 'burst', { i }));
      await sleep(200);
      assert.equal(activities('gateway_edge_plugin_throttled').length, 1);
      await pluginApi('/release');
      // the queue held the event being delivered and two more
      await h.waitForAck(P, seqs[1]);
      await sleep(200);
      assert.ok((h.acks.get(P) ?? -1) < seqs[2], 'the dropped ones are not acknowledged');
      assert.deepEqual((await pluginApi('/events')).events.filter((e) => e.name === 'burst').map((e) => e.data.i), [0, 1]);
      assert.ok(slow < seqs[0]);
      // sent again (a gateway does that after a reconnect): three fit, the fourth comes with the next round
      h.resend(P);
      await h.waitForAck(P, seqs[4]);
      h.resend(P);
      await h.waitForAck(P, seqs[5]);
      assert.deepEqual((await pluginApi('/events')).events.filter((e) => e.name === 'burst').map((e) => e.data.i), [0, 1, 2, 3, 4, 5]);
    } finally { hub._setForTest({ limits: null }); }
  });

  it('built-in event $started reached the plugin when its edge part ran (no seq, no ack)', async () => {
    const ev = (await pluginApi('/events')).events.find((e) => e.name === '$started');
    assert.deepEqual(ev, { gatewayId: gwA.peer.id, name: '$started', seq: null });
  });

  it('log lines go to the ring buffer (≤ 20/s, ≤ 2 KB)', async () => {
    for (let i = 0; i < 30; i++) h.log(P, i === 0 ? 'warn' : 'info', 'line ' + i + (i === 1 ? 'y'.repeat(3000) : ''));
    await sleep(200);
    const logs = (await agent.get(`${API}/gateways/${gwA.peer.id}/logs?plugin=${P}&kind=log&limit=100`).expect(200)).body.entries;
    assert.equal(logs.length, 20);
    assert.equal(logs[logs.length - 1].level, 'warn');
    assert.ok(logs.every((l) => l.message.length <= 2048));
  });

  it('status: a crash is kept with restarts and error and goes to the activity log once', async () => {
    h.reportStatus({ plugins: [{ id: P, version: '1.0.0', state: 'crashed', rssMb: 30, restarts: 1, lastError: 'TypeError: x is undefined' }] });
    await sleep(150);
    h.reportStatus({ plugins: [{ id: P, version: '1.0.0', state: 'crashed', rssMb: 30, restarts: 2, lastError: 'TypeError: x is undefined' }] });
    await sleep(150);
    const r = await agent.get(`${API}/gateways/${gwA.peer.id}`).expect(200);
    const a = r.body.gateway.plugins.find((x) => x.id === P).assignment;
    assert.equal(a.state, 'crashed');
    assert.equal(a.status.restarts, 2);
    assert.equal(a.status.lastError, 'TypeError: x is undefined');
    assert.equal(activities('gateway_edge_plugin_crashed').length, 1, 'once per 10 minutes');
    h.reportStatus();
    await sleep(100);
  });

  it('a pending call fails with gateway_offline when the gateway goes away; then calls fail at once', async () => {
    const pending = pluginApi('/call', { gatewayId: gwA.peer.id, method: 'silent', timeoutMs: 20000 });
    await sleep(200);
    await h.close();
    const r = await pending;
    assert.equal(r.code, 'gateway_offline');
    assert.equal((await pluginApi('/call', { gatewayId: gwA.peer.id, method: 'ping' })).code, 'gateway_offline');
    assert.equal((await pluginApi('/configure', { gatewayId: gwA.peer.id, data: {} })).code, 'gateway_offline');
    const gws = (await pluginApi('/gateways')).result;
    assert.equal(gws[0].online, false);
    assert.equal(gws[0].state, 'offline');
  });

  it('offline: the reason comes from the heartbeat (state stays offline for older plugins)', async () => {
    const meta = db.prepare('SELECT last_seen_at, last_health FROM gateway_meta WHERE peer_id = ?').get(gwA.peer.id);
    const beat = (edge, seenAt = Date.now()) => db.prepare('UPDATE gateway_meta SET last_seen_at = ?, last_health = ? WHERE peer_id = ?')
      .run(seenAt, JSON.stringify({ telemetry: { gateway_version: '1.22.0', edge } }), gwA.peer.id);
    const view = async () => {
      const g = (await agent.get(`${API}/gateways/${gwA.peer.id}`).expect(200)).body.gateway;
      const host = (await pluginApi('/gateways')).result.find((x) => x.id === gwA.peer.id);
      return { g, a: g.plugins.find((x) => x.id === P).assignment, host };
    };
    try {
      beat(null);
      let v = await view();
      assert.equal(v.g.connection.online, false);
      assert.equal(v.g.connection.reason, 'edge_missing');
      assert.equal(v.a.state, 'offline');
      assert.equal(v.a.reason, 'edge_missing');
      assert.equal(v.host.state, 'offline');
      assert.equal(v.host.reason, 'edge_missing');

      beat({ deployed: true, error: null, fence: { active: false, backend: null, error: 'iptables owner match: no such match' },
        host: { at: new Date().toISOString(), stale: false, connected: false } });
      v = await view();
      assert.equal(v.a.reason, 'edge_fence');
      assert.equal(v.g.connection.detail, 'iptables owner match: no such match');

      // gateway >= 1.23.0: an older compose (edge in the host network) without fence → compose_outdated;
      // edge without network → the fence does not count; support carries the mode
      beat({ deployed: true, error: null, mode: 'fence', fence: { active: false, backend: null, error: 'iptables owner match: no such match' },
        host: { at: new Date().toISOString(), stale: false, connected: false } });
      v = await view();
      assert.equal(v.a.reason, 'compose_outdated');
      assert.equal(v.g.support.edgeMode, 'fence');
      assert.equal(v.g.support.isolatedMinGateway, '1.23.0');
      beat({ deployed: true, error: null, mode: 'isolated', fence: { active: false, backend: null, error: 'x' },
        host: { at: new Date().toISOString(), stale: false, connected: false } });
      v = await view();
      assert.equal(v.a.reason, 'edge_not_connected');
      assert.equal(v.g.support.edgeMode, 'isolated');

      beat(null, Date.now() - 10 * 60 * 1000);
      v = await view();
      assert.equal(v.host.reason, 'gateway_offline');
      const list = (await agent.get(`${API}/gateways`).expect(200)).body.gateways.find((x) => x.id === gwA.peer.id);
      assert.equal(list.connection.reason, 'gateway_offline');
    } finally {
      db.prepare('UPDATE gateway_meta SET last_seen_at = ?, last_health = ? WHERE peer_id = ?').run(meta.last_seen_at, meta.last_health, gwA.peer.id);
    }
  });
});

describe('updates, unsigned plugins, disabling', () => {
  let h;
  before(async () => {
    h = await host(gwA);
    h.handle(P, 'ping', async () => 'pong');
  });

  it('$offline and $online reach the plugin when its gateway leaves and comes back', async () => {
    const names = (await pluginApi('/events')).events.map((e) => e.name);
    assert.ok(names.includes('$offline'));
    assert.ok(names.includes('$online'));
  });

  it('an update with fewer capabilities keeps it on', async () => {
    const pj = require('./fixtures/plugins/edge-demo/plugin.json');
    await installPkg(edgePackage({ overrides: { version: '1.0.1', edge: { ...pj.edge, capabilities: { udp: { ports: [5683] } } } } }));
    const st = await h.waitForState((s) => s.plugins.some((p) => p.id === P && p.version === '1.0.1'));
    const e = st.plugins.find((p) => p.id === P);
    assert.equal(e.enabled, true);
    assert.deepEqual(e.caps, { udp: { ports: [5683], multicast: [] } });
  });

  it('an update with new capabilities stays off (update_pending) until confirmed again', async () => {
    const pj = require('./fixtures/plugins/edge-demo/plugin.json');
    const caps = { ...pj.edge.capabilities, udp: { ports: [5683, 6000], multicast: ['224.0.1.187'] } };
    await installPkg(edgePackage({ overrides: { version: '1.1.0', edge: { ...pj.edge, capabilities: caps } } }));
    assert.equal(await runtime.waitRunning(P), true);
    const st = await h.waitForState((s) => s.plugins.some((p) => p.id === P && p.version === '1.1.0'));
    const e = st.plugins.find((p) => p.id === P);
    assert.equal(e.enabled, false);
    assert.equal(e.reason, 'update_pending');
    assert.deepEqual(e.caps.udp, { ports: [5683], multicast: ['224.0.1.187'] }, 'the approved snapshot, not the new one');
    const pend = activities('gateway_edge_update_pending');
    assert.equal(pend.length, 1);
    assert.deepEqual(JSON.parse(pend[0].details).capabilities, ['udp.port:6000']);
    const ov = await agent.get(`${API}/gateways/${gwA.peer.id}`).expect(200);
    const a = ov.body.gateway.plugins.find((x) => x.id === P).assignment;
    assert.equal(a.state, 'update_pending');
    assert.deepEqual(a.newCapabilities.map((x) => x.key), ['udp.port:6000']);
    assert.equal((await pluginApi('/call', { gatewayId: gwA.peer.id, method: 'ping' })).code, 'not_enabled');
    // the gateway may not download the version it must not run
    assert.equal((await supertest(app).get(`/api/v1/gateway/edge/packages/${P}/1.1.0`).set('Authorization', 'Bearer ' + gwA.apiToken)).status, 403);

    const list = [...CAPS, 'udp.port:6000'];
    await post(`/gateways/${gwA.peer.id}/plugins/${P}/enable`, { capabilities: list }).expect(200);
    const on = await h.waitForState((s) => s.plugins.some((p) => p.id === P && p.version === '1.1.0' && p.enabled));
    assert.deepEqual(on.plugins.find((p) => p.id === P).caps.udp.ports, [5683, 6000]);
    const appr = activities('gateway_edge_caps_approved');
    assert.deepEqual(JSON.parse(appr[appr.length - 1].details).capabilities, ['udp.port:6000']);
    assert.deepEqual(await pluginApi('/call', { gatewayId: gwA.peer.id, method: 'ping' }), { ok: true, result: 'pong' });
  });

  it('minGateway: an older gateway gets the plugin switched off (gateway_too_old)', async () => {
    const old = await host(gwB, { version: '1.19.0' });
    await put(`/gateways/${gwB.peer.id}/settings`, { edgeEnabled: true }).expect(200);
    await post(`/gateways/${gwB.peer.id}/plugins/${P}/enable`, { capabilities: [...CAPS, 'udp.port:6000'] }).expect(200);
    const st = await old.waitForState((s) => s.plugins.some((p) => p.id === P));
    assert.equal(st.plugins.find((p) => p.id === P).reason, 'gateway_too_old');
    await post(`/gateways/${gwB.peer.id}/plugins/${P}/disable`).expect(200);
    await old.close();
  });

  it('unsigned plugins: only with allowUnsignedEdge (confirmed with ERLAUBEN) on that gateway', async () => {
    await agent.put('/api/v1/plugins/policy').set('X-CSRF-Token', csrf).send({ allowUnsigned: true, confirm: 'ERLAUBEN' }).expect(200);
    await installPkg(edgePackage({ sign: false, overrides: { id: 'edge-raw', name: 'Edge raw' } }));
    const rawCaps = CAPS;
    const blocked = await post(`/gateways/${gwA.peer.id}/plugins/edge-raw/enable`, { capabilities: rawCaps });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.code, 'unsigned_blocked');
    const noConfirm = await put(`/gateways/${gwA.peer.id}/settings`, { allowUnsignedEdge: true });
    assert.equal(noConfirm.status, 400);
    assert.equal(noConfirm.body.code, 'confirm_mismatch');
    await put(`/gateways/${gwA.peer.id}/settings`, { allowUnsignedEdge: true, confirm: 'ERLAUBEN' }).expect(200);
    assert.equal(activities('gateway_edge_unsigned_allowed').length, 1);
    await post(`/gateways/${gwA.peer.id}/plugins/edge-raw/enable`, { capabilities: rawCaps }).expect(200);
    let st = await h.waitForState((s) => s.allowUnsigned && s.plugins.some((p) => p.id === 'edge-raw' && p.enabled));
    assert.ok(st);
    await put(`/gateways/${gwA.peer.id}/settings`, { allowUnsignedEdge: false }).expect(200);
    st = await h.waitForState((s) => !s.allowUnsigned);
    assert.equal(st.plugins.find((p) => p.id === 'edge-raw').reason, 'unsigned');
    assert.equal(st.plugins.find((p) => p.id === P).enabled, true, 'signed ones are not affected');
  });

  it('disable → off in the state, logged', async () => {
    await post(`/gateways/${gwA.peer.id}/plugins/edge-raw/disable`).expect(200);
    const st = await h.waitForState((s) => s.plugins.some((p) => p.id === 'edge-raw' && p.reason === 'disabled'));
    assert.ok(st);
    assert.equal(activities('gateway_edge_plugin_disabled').length >= 1, true);
    assert.equal((await post(`/gateways/${gwA.peer.id}/plugins/hello/disable`)).status, 404);
  });

  it('a plugin switched off on the server stops on the gateway too (plugin_off)', async () => {
    await agent.post('/api/v1/plugins/edge-raw/disable').set('X-CSRF-Token', csrf).expect(200);
    await post(`/gateways/${gwA.peer.id}/plugins/edge-raw/enable`, { capabilities: CAPS }).expect(409); // unsigned is blocked again
    await put(`/gateways/${gwA.peer.id}/settings`, { allowUnsignedEdge: true, confirm: 'ALLOW' }).expect(200);
    await post(`/gateways/${gwA.peer.id}/plugins/edge-raw/enable`, { capabilities: CAPS }).expect(200);
    const st = await h.waitForState((s) => s.plugins.some((p) => p.id === 'edge-raw' && p.reason === 'plugin_off'));
    assert.ok(st);
  });

  it('uninstall with "wipe" forgets the approvals', async () => {
    await agent.post('/api/v1/plugins/edge-raw/uninstall').set('X-CSRF-Token', csrf).send({ mode: 'wipe', confirm: 'Edge raw' }).expect(200);
    await h.waitForState((s) => !s.plugins.some((p) => p.id === 'edge-raw'));
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM edge_assignments WHERE plugin_id = 'edge-raw'").get().n, 0);
  });
});

describe('MQTT accounts', () => {
  let h;
  before(() => { h = hosts.find((x) => !x.closed && x.o.apiToken === gwA.apiToken); });

  it('broker on: accounts with hash + ACL and the plugin topics in the state', async () => {
    await put(`/gateways/${gwA.peer.id}/settings`, { mqttEnabled: true, mqttTls: true }).expect(200);
    const created = await post(`/gateways/${gwA.peer.id}/mqtt/accounts`, { username: 'shelly-kitchen', label: 'Küche', vendorPrefix: 'shellies' });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const pw = created.body.password;
    assert.match(pw, /^[A-Za-z0-9_-]{24}$/);
    assert.equal(created.headers['cache-control'], 'no-store');
    const st = await h.waitForState((s) => s.mqtt.accounts.some((a) => a.user === 'shelly-kitchen'));
    assert.equal(st.mqtt.enabled, true);
    assert.equal(st.mqtt.tls, true);
    const acc = st.mqtt.accounts.find((a) => a.user === 'shelly-kitchen');
    assert.deepEqual(acc.acl, [{ access: 'readwrite', topic: 'shellies/shelly-kitchen/#' }]);
    assert.equal(require('../src/services/edge/mqtt').verifyPassword(pw, acc.hash), true);
    assert.deepEqual(st.mqtt.pluginTopics, { [P]: ['shellies/#'] });
    const list = await agent.get(`${API}/gateways/${gwA.peer.id}/mqtt/accounts`).expect(200);
    const text = JSON.stringify(list.body);
    assert.equal(text.includes(pw), false);
    assert.equal(text.includes('$7$'), false, 'no hash in the admin API');
    for (const t of ['activity_log', 'edge_logs']) assert.equal(JSON.stringify(db.prepare(`SELECT * FROM ${t}`).all()).includes(pw), false, t);
    assert.equal(activities('gateway_mqtt_account_created').length, 1);
  });

  it('lock removes it from the state, a new password replaces the hash, delete removes it', async () => {
    const id = (await agent.get(`${API}/gateways/${gwA.peer.id}/mqtt/accounts`)).body.accounts.find((a) => a.username === 'shelly-kitchen').id;
    await agent.put(`${API}/gateways/${gwA.peer.id}/mqtt/accounts/${id}`).set('X-CSRF-Token', csrf).send({ locked: true }).expect(200);
    await h.waitForState((s) => !s.mqtt.accounts.some((a) => a.user === 'shelly-kitchen'));
    await agent.put(`${API}/gateways/${gwA.peer.id}/mqtt/accounts/${id}`).set('X-CSRF-Token', csrf).send({ locked: false }).expect(200);
    const r = await post(`/gateways/${gwA.peer.id}/mqtt/accounts/${id}/password`).expect(200);
    const st = await h.waitForState((s) => s.mqtt.accounts.some((a) => a.user === 'shelly-kitchen' && require('../src/services/edge/mqtt').verifyPassword(r.body.password, a.hash)));
    assert.ok(st);
    await agent.delete(`${API}/gateways/${gwA.peer.id}/mqtt/accounts/${id}`).set('X-CSRF-Token', csrf).expect(200);
    await h.waitForState((s) => !s.mqtt.accounts.some((a) => a.user === 'shelly-kitchen'));
    assert.equal((await agent.delete(`${API}/gateways/${gwA.peer.id}/mqtt/accounts/${id}`).set('X-CSRF-Token', csrf)).status, 404);
    assert.equal((await post(`/gateways/${gwA.peer.id}/mqtt/accounts`, { username: 'x', topics: ['#'] })).status, 400);
  });

  it('plugins create accounts for their devices only below their own topics', async () => {
    const ok = await pluginApi('/mqtt/create', { gatewayId: gwA.peer.id, opts: { label: 'Kitchen plug', name: 'kitchen', topics: ['shellies/kitchen/#'] } });
    assert.equal(ok.ok, true, JSON.stringify(ok));
    assert.equal(ok.result.username, `${P}-kitchen`);
    assert.match(ok.result.password, /^[A-Za-z0-9_-]{24}$/);
    const denied = await pluginApi('/mqtt/create', { gatewayId: gwA.peer.id, opts: { topics: ['tasmota/#'] } });
    assert.equal(denied.code, 'denied');
    assert.equal((await pluginApi('/mqtt/create', { gatewayId: gwB.peer.id, opts: { topics: ['shellies/x/#'] } })).code, 'not_enabled');
    const list = await pluginApi('/mqtt/list', { gatewayId: gwA.peer.id });
    assert.deepEqual(list.result.map((a) => a.username), [`${P}-kitchen`]);
    assert.equal(JSON.stringify(list.result).includes('$7$'), false);
    await h.waitForState((s) => s.mqtt.accounts.some((a) => a.user === `${P}-kitchen`));
    assert.deepEqual((await pluginApi('/mqtt/remove', { gatewayId: gwA.peer.id, username: `${P}-kitchen` })).result, true);
    await h.waitForState((s) => !s.mqtt.accounts.some((a) => a.user === `${P}-kitchen`));
  });

  it('MQTT status of the gateway is kept', async () => {
    h.reportStatus({ plugins: [], mqtt: { running: true, clients: 2, accounts: [{ user: 'a', connected: true, lastSeen: '2026-11-05T10:00:00Z' }] } });
    await sleep(150);
    const r = await agent.get(`${API}/gateways/${gwA.peer.id}`).expect(200);
    assert.deepEqual(r.body.gateway.mqtt.status, { running: true, tls: null, clients: 2, accounts: [{ user: 'a', connected: true, lastSeen: '2026-11-05T10:00:00Z' }] });
  });
});

describe('no secrets in the logs', () => {
  it('neither the gateway token nor MQTT hashes end up in the activity log or the ring buffer', () => {
    for (const t of ['activity_log', 'edge_logs']) {
      const rows = JSON.stringify(db.prepare(`SELECT * FROM ${t}`).all());
      assert.equal(rows.includes(gwA.apiToken), false, t);
      assert.equal(rows.includes('$7$'), false, t);
    }
  });
});
