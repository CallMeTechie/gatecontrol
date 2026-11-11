'use strict';

// The local AI (phase 3c, step 3 — services/ai/local.js, the gateway's
// docs/local-ai.md): the setup (gateways with their memory, the catalogue
// with the fit per gateway, the LAN server address checked), features.ai in
// the config pull, the management calls, the provider adapter streaming
// through a fake gateway (a real HTTP server on 127.0.0.1 — the gateway's
// tunnel address points there), the three modes in the request routing of
// gc.ai (Für alles / Nur private Inhalte / Nur als Ausweich) with a cloud
// stub, the test button, the row "Lokale KI" + memory, the compose download
// with the service ki, and the time a plugin may wait.

const crypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const supertest = require('supertest');
const { helloPackage, HELLO } = require('./helpers/plugins');
const { setup, teardown, getCsrf } = require('./helpers/setup');

const AI = '/api/v1/ai';
const API = '/api/v1/plugins';
const OTHER = 'hello-ai-local';      // an ordinary plugin
const MAIL = 'gatecontrol-mail';     // a private one (documents, mails)
const KEY = 'sk-test-openai-0001-SECRET';
const helloManifest = JSON.parse(fs.readFileSync(path.join(HELLO, 'plugin.json'), 'utf8'));
const clone = (v) => JSON.parse(JSON.stringify(v));
const AI_PERM = { purpose: { de: 'Zusammenfassen', en: 'Summarise' }, capabilities: ['text', 'vision'] };
const SCHEMA = { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] };
const GB = 1024 ** 3;

let app, agent, csrf, db, ai, local, gateways, nas, pi, fakeGw, cloud;

// ─── a fake gateway management API (the AI part) ─────────────────────────

function startFakeGateway() {
  const g = { calls: [], mode: 'ok', words: ['{"summary":', '"Rechnung bis Freitag bezahlen."}'], status: null, token: null, cert: null };
  g.server = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', async () => {
      let body = null;
      try { body = JSON.parse(b || 'null'); } catch { body = null; }
      g.calls.push({ path: req.url, body, token: req.headers['x-gateway-token'] });
      const json = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (g.token && req.headers['x-gateway-token'] !== g.token) return json(403, { error: 'forbidden' });
      if (req.url === '/api/ai/status') return json(200, { ai: g.status });
      if (req.url === '/api/ai/pull') return json(202, { accepted: true });
      if (req.url === '/api/ai/pull/cancel') return json(409, { error: 'no_pull' });
      if (req.url === '/api/ai/delete') return json(200, { deleted: true });
      if (req.url === '/api/ai/probe') {
        // an https server with a self-signed certificate (g.cert): only with exactly its fingerprint as the pin
        if (g.cert && /^https:/.test(body.url) && body.pin !== g.cert.sha256) {
          return json(200, { probe: { reachable: false, url: body.url, api: body.api, version: null, models: [], auth: !!body.key, pinned: !!body.pin, certificate: g.cert,
            error: { code: body.pin ? 'tls_pin_mismatch' : 'tls_untrusted', message: 'the certificate of the AI server is not trusted (DEPTH_ZERO_SELF_SIGNED_CERT)' } } });
        }
        return json(200, { probe: { reachable: true, url: body.url, api: body.api, version: '0.40.8', models: [{ name: 'qwen2.5:14b', size: 9e9 }, { name: '../bad name', size: 1 }], auth: !!body.key, error: null } });
      }
      if (req.url === '/api/ai/chat') {
        if (g.mode === 'busy') return json(429, { error: 'busy' });
        if (g.mode === 'not_running') return json(409, { error: 'not_running' });
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        res.write(JSON.stringify({ wait: 1 }) + '\n');
        if (g.mode === 'error_line') { res.end(JSON.stringify({ error: 'unreachable', message: 'connect ECONNREFUSED' }) + '\n'); return; }
        if (g.mode === 'missing') { res.end(JSON.stringify({ error: 'model_missing', message: 'model not on this server' }) + '\n'); return; }
        if (g.mode === 'stall') return; // never ends: the server's idle limit
        if (g.mode === 'huge') { for (let i = 0; i < 70; i++) res.write(JSON.stringify({ d: 'x'.repeat(4096) }) + '\n'); res.end(JSON.stringify({ done: true }) + '\n'); return; }
        for (const w of g.words) { res.write(JSON.stringify({ d: w }) + '\n'); await new Promise((r) => setTimeout(r, 2)); }
        res.end(JSON.stringify({ done: true, model: body && body.model, inputTokens: 300, outputTokens: 12, finish: 'stop', ms: 5000 }) + '\n');
        return;
      }
      json(404, { error: 'not_found' });
    });
  });
  return new Promise((r) => g.server.listen(0, '127.0.0.1', () => r(g)));
}

// ─── a cloud stub (OpenAI) ───────────────────────────────────────────────

function startCloud() {
  const s = { calls: [] };
  s.server = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => {
      s.calls.push({ method: req.method, url: req.url });
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.method === 'GET') return res.end(JSON.stringify({ data: [{ id: 'model-a' }] }));
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ summary: 'aus der Cloud' }) }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20 } }));
    });
  });
  return new Promise((r) => s.server.listen(0, '127.0.0.1', () => { s.base = `http://127.0.0.1:${s.server.address().port}`; r(s); }));
}

function aiTel(extra = {}) {
  return {
    enabled: true, source: 'service', service: 'managed', state: 'running', version: '0.40.8',
    models: [{ name: 'llama3.2:3b', size: 2019393189 }], loaded: [{ name: 'llama3.2:3b', size: 2.6 * GB, vram: 0 }],
    pull: null, host: { memTotal: 15.5 * GB, cores: 4, arch: 'x64', gpu: [] }, lan: null, error: null, ...extra,
  };
}
const CAPS = ['netwatch', 'inetq', 'presence', 'ups', 'dns', 'cache', 'print', 'radio'];
function setTel(g, { caps = CAPS.concat('ai'), version = '1.26.0', ai: a = aiTel(), mem = 15.5 * GB, cores = 4, alive = 1 } = {}) {
  const t = { gateway_version: version, capabilities: caps, hardware: { model: 'DS918+', mem_total: mem, cpu_cores: cores, arch: 'x64' }, features: a ? { ai: a } : {} };
  db.prepare('UPDATE gateway_meta SET last_health = ?, alive = ?, last_seen_at = ? WHERE peer_id = ?').run(JSON.stringify({ telemetry: t }), alive, Date.now(), g.peer.id);
}

const put = (url, body) => agent.put(url).set('X-CSRF-Token', csrf).send(body);
const post = (url, body) => agent.post(url).set('X-CSRF-Token', csrf).send(body || {});
const gc = async (plugin, fn, ...args) => (await agent.post(`${API}/${plugin}/api/gc`).set('X-CSRF-Token', csrf).send({ fn, args })).body;
const extract = (plugin, o = {}) => gc(plugin, 'ai.extract', { task: 'mail_assist', instructions: 'Fasse zusammen.', input: [{ type: 'text', label: 'Mail', text: 'Bitte die Rechnung bis Freitag bezahlen.' }], schema: SCHEMA, maxOutputTokens: 300, timeoutMs: 5000, ...o });
const lastRow = () => db.prepare('SELECT * FROM ai_requests ORDER BY id DESC LIMIT 1').get();
const chats = () => fakeGw.calls.filter((c) => c.path === '/api/ai/chat');
const cloudChats = () => cloud.calls.filter((c) => c.method === 'POST');

async function install(id) {
  const perms = { ...clone(helloManifest.permissions), app: true, ai: AI_PERM };
  const buf = helloPackage({ overrides: { id, name: { de: id, en: id }, version: '1.0.0', permissions: perms, media: { maxBytes: 20 * 1024 * 1024, types: ['image/*'] } } });
  const r = await agent.post(API + '/inspect').set('X-CSRF-Token', csrf).set('Content-Type', 'application/octet-stream').send(buf).expect(200);
  assert.equal(r.body.canInstall, true, JSON.stringify(r.body.checks));
  await agent.post(API + '/install').set('X-CSRF-Token', csrf).send({ token: r.body.token, accept: true }).expect(200);
}

before(async () => {
  ({ app, agent } = await setup());
  csrf = getCsrf();
  db = require('../src/db/connection').getDb();
  ai = require('../src/services/ai');
  local = require('../src/services/ai/local');
  require('../src/services/license')._overrideForTest({ gateway_peers: 10 });
  gateways = require('../src/services/gateways');
  gateways.notifyConfigChanged = async () => {};
  fakeGw = await startFakeGateway();
  cloud = await startCloud();
  ai._testBase.openai = cloud.base;
  nas = await gateways.createGateway({ name: 'DS918 Gateway' });
  pi = await gateways.createGateway({ name: 'Pi Keller' });
  fakeGw.token = nas.pushToken;
  // the tunnel address of the NAS gateway is the fake gateway
  db.prepare("UPDATE peers SET allowed_ips = '127.0.0.1/32' WHERE id = ?").run(nas.peer.id);
  db.prepare('UPDATE gateway_meta SET api_port = ? WHERE peer_id = ?').run(fakeGw.server.address().port, nas.peer.id);
  setTel(nas);
  setTel(pi, { mem: 1 * GB, cores: 4, ai: aiTel({ enabled: false, state: 'off', host: { memTotal: 1 * GB, cores: 4, arch: 'arm64', gpu: [] } }) });
  fakeGw.status = aiTel();
  const runtime = require('../src/services/plugins/runtime');
  await install(OTHER);
  await install(MAIL);
  for (const id of [OTHER, MAIL]) assert.equal(await runtime.waitRunning(id), true, id);
  // the cloud: OpenAI set up as before
  await put(`${AI}/providers/openai`, { key: KEY }).expect(200);
  await post(`${AI}/providers/openai/test`).expect(200);
  await put(`${AI}/providers/openai`, { modelText: 'model-a' }).expect(200);
});
after(async () => {
  delete ai._testBase.openai;
  await new Promise((r) => fakeGw.server.close(r));
  await new Promise((r) => cloud.server.close(r));
  await require('../src/services/plugins').stop();
  teardown();
});
beforeEach(() => {
  fakeGw.calls.length = 0;
  fakeGw.mode = 'ok';
  cloud.calls.length = 0;
  ai._resetForTest();
});

// ─── setup ───────────────────────────────────────────────────────────────

describe('setup "Lokale KI einrichten"', () => {
  it('gateways with memory and a hint; the catalogue fits per gateway (hints, never a ban)', async () => {
    const v = (await agent.get(AI + '/local').expect(200)).body;
    assert.equal(v.provider.id, 'local');
    assert.equal(v.provider.configured, false);
    assert.equal(v.use, 'all');
    const n = v.gateways.find((g) => g.id === nas.peer.id);
    const p = v.gateways.find((g) => g.id === pi.peer.id);
    assert.equal(n.supported, true);
    assert.equal(n.hint, null);
    assert.equal(n.cores, 4);
    assert.ok(n.memMb > 15000);
    assert.equal(p.hint, 'memory', 'Pi Keller – 1 GB RAM, zu wenig für ein Modell (a hint, it can still be chosen)');
    const fit = (id) => Object.fromEntries(v.catalogue.find((c) => c.peerId === id).models.map((m) => [m.id, m.fit]));
    assert.deepEqual(fit(nas.peer.id), { 'llama3.2:1b': 'fits', 'llama3.2:3b': 'recommended', 'qwen2.5:7b': 'fits', 'gemma2:9b': 'not_recommended', 'qwen2.5:14b': 'not_recommended', 'qwen2.5:32b': 'not_recommended' });
    assert.equal(v.catalogue.find((c) => c.peerId === nas.peer.id).models.find((m) => m.id === 'gemma2:9b').reason, 'slow');
    assert.ok(Object.values(fit(pi.peer.id)).every((f) => f === 'not_recommended'));
    assert.deepEqual(local.fitList({ memMb: 8192, cores: 4, arch: 'arm64', gpu: [] }).map((m) => m.fit), ['recommended', 'fits', 'not_recommended', 'not_recommended', 'not_recommended', 'not_recommended'], 'Pi 5 (8 GB): the 1B model');
    // a card that is there but not used ("Grafikkarte nutzen" off) changes nothing
    assert.deepEqual(local.fitList({ memMb: 32768, cores: 8, arch: 'x64', gpu: [{ vendor: 'nvidia' }] }).map((m) => m.fit), local.fitList({ memMb: 32768, cores: 8, arch: 'x64', gpu: [] }).map((m) => m.fit));
    // 12 GB graphics memory: everything up to Qwen 2.5 14B fits into it (fast), 32B only partly
    const g12 = local.fitList({ memMb: 32768, cores: 8, arch: 'x64', gpu: [{ vendor: 'nvidia' }] }, 0, { on: true, vramMb: 12288 });
    assert.deepEqual(g12.map((m) => [m.id, m.fit, m.vram]), [['llama3.2:1b', 'fits', 'full'], ['llama3.2:3b', 'fits', 'full'], ['qwen2.5:7b', 'fits', 'full'], ['gemma2:9b', 'fits', 'full'],
      ['qwen2.5:14b', 'recommended', 'full'], ['qwen2.5:32b', 'not_recommended', 'partial']]);
    // in graphics memory a model needs little main memory: an 8-GB box with a 24-GB card takes the 14B one
    assert.equal(local.fitList({ memMb: 8192, cores: 4, arch: 'x64', gpu: [] }, 0, { on: true, vramMb: 24576 }).find((m) => m.id === 'qwen2.5:14b').fit, 'fits');
  });

  it('validation: model, LAN address (private addresses or a name), too old a gateway', async () => {
    for (const [b, field] of [[{ source: 'service', peerId: nas.peer.id, model: 'Llama 3' }, 'model'], [{ source: 'x', peerId: nas.peer.id, model: 'llama3.2:3b' }, 'source'],
      [{ source: 'service', peerId: 99999, model: 'llama3.2:3b' }, 'peerId'],
      [{ source: 'lan', peerId: nas.peer.id, model: 'llama3.2', lanUrl: 'http://8.8.8.8:11434' }, 'lanUrl'],
      [{ source: 'lan', peerId: nas.peer.id, model: 'llama3.2', lanUrl: 'http://[2001:db8::1]:11434' }, 'lanUrl'],
      [{ source: 'lan', peerId: nas.peer.id, model: 'llama3.2', lanUrl: 'http://localhost:11434' }, 'lanUrl'],
      [{ source: 'lan', peerId: nas.peer.id, model: 'llama3.2', lanUrl: 'http://127.0.0.1:11434' }, 'lanUrl'],
      [{ source: 'lan', peerId: nas.peer.id, model: 'llama3.2', lanUrl: 'http://192.168.1.20:11434', lanKey: 'with space' }, 'lanKey'],
      [{ source: 'service', peerId: nas.peer.id, model: 'llama3.2:3b', gpu: 'voodoo' }, 'gpu'],
      [{ source: 'lan', peerId: nas.peer.id, model: 'llama3.2', lanUrl: 'http://user:pw@192.168.1.20:11434' }, 'lanUrl']]) {
      const r = await put(AI + '/local', b);
      assert.equal(r.status, 400, JSON.stringify(b));
      assert.equal(r.body.field, field, JSON.stringify(b));
    }
    setTel(pi, { caps: CAPS, version: '1.25.0', mem: 1 * GB, ai: null });
    const old = await put(AI + '/local', { source: 'service', peerId: pi.peer.id, model: 'llama3.2:1b' });
    assert.equal(old.status, 409);
    assert.equal(old.body.code, 'gateway_unsupported');
    setTel(pi, { mem: 1 * GB, ai: aiTel({ enabled: false, state: 'off', host: { memTotal: 1 * GB, cores: 4, arch: 'arm64', gpu: [] } }) });
    assert.equal(local.lanUrl('http://192.168.1.20:1234/v1'), 'http://192.168.1.20:1234');
    assert.equal(local.lanUrl('https://10.0.0.2'), 'https://10.0.0.2:443');
  });

  it('on a gateway: features.ai in the config pull, provider switched on, activity log', async () => {
    const r = (await put(AI + '/local', { source: 'service', peerId: nas.peer.id, model: 'llama3.2:3b' }).expect(200)).body;
    assert.equal(r.startPull, true);
    assert.equal(r.provider.configured, true);
    assert.equal(r.provider.gateway.name, 'DS918 Gateway');
    const cfg = (await supertest(app).get('/api/v1/gateway/config').set('Authorization', 'Bearer ' + nas.apiToken).expect(200)).body;
    assert.deepEqual(cfg.features.ai, { enabled: true, source: 'service', lan: null });
    assert.equal(cfg.config_hash, gateways.computeConfigHash(nas.peer.id));
    const other = (await supertest(app).get('/api/v1/gateway/config').set('Authorization', 'Bearer ' + pi.apiToken).expect(200)).body;
    assert.deepEqual(other.features.ai, { enabled: false, source: 'service', lan: null });
    const act = db.prepare("SELECT * FROM activity_log WHERE event_type = 'ai_local_setup' ORDER BY id DESC LIMIT 1").get();
    assert.ok(act, 'activity log');
    assert.match(act.message, /llama3\.2:3b/);
    const view = (await agent.get(AI).expect(200)).body;
    assert.equal(view.providers[0].id, 'local');
    assert.equal(view.providers[0].modelText, 'llama3.2:3b');
  });

  it('management calls go to the gateway: status, pull, cancel (its answer as a code), delete', async () => {
    const s = (await agent.get(AI + '/local/status').expect(200)).body;
    assert.equal(s.status.state, 'running');
    assert.equal(s.status.models[0].name, 'llama3.2:3b');
    await post(AI + '/local/pull', { peerId: nas.peer.id, model: 'qwen2.5:7b' }).expect(202);
    assert.deepEqual(fakeGw.calls.find((c) => c.path === '/api/ai/pull').body, { model: 'qwen2.5:7b' });
    assert.equal(fakeGw.calls[0].token, nas.pushToken, 'with the push token of the gateway');
    const c = await post(AI + '/local/pull/cancel', { peerId: nas.peer.id });
    assert.equal(c.status, 409);
    assert.equal(c.body.code, 'no_pull');
    assert.equal((await post(AI + '/local/pull', { peerId: nas.peer.id, model: '../etc' })).status, 400);
    await post(AI + '/local/delete', { peerId: nas.peer.id, model: 'qwen2.5:7b' }).expect(200);
    assert.ok(db.prepare("SELECT 1 FROM activity_log WHERE event_type = 'ai_local_model_pull'").get());
  });
});

// ─── routing ─────────────────────────────────────────────────────────────

describe('gc.ai with the local AI', () => {
  before(async () => {
    await put(AI + '/local', { source: 'service', peerId: nas.peer.id, model: 'llama3.2:3b' }).expect(200);
  });

  it('"Für alles": local first, 0 €, logged with the route; the schema reaches the model', async () => {
    await put(AI + '/local/use', { use: 'all' }).expect(200);
    const r = (await extract(OTHER)).result;
    assert.deepEqual(r.data, { summary: 'Rechnung bis Freitag bezahlen.' });
    assert.equal(r.provider, 'local');
    assert.equal(r.usage.costCents, 0);
    assert.equal(r.fallback, false);
    assert.equal(cloudChats().length, 0, 'nothing went to the cloud');
    const sent = chats()[0].body;
    assert.equal(sent.model, 'llama3.2:3b');
    assert.equal(sent.messages[0].role, 'user');
    assert.match(sent.messages[0].content, /Rechnung bis Freitag/);
    assert.match(sent.system, /JSON schema/);
    assert.deepEqual(sent.schema, SCHEMA);
    assert.ok(sent.timeoutMs >= 4.5 * 60 * 1000, 'a local answer gets minutes (minus a little for a cloud fallback)');
    assert.ok(sent.numCtx >= 4096 && sent.numCtx <= 16384);
    const row = lastRow();
    assert.equal(row.provider, 'local');
    assert.equal(row.route, 'local');
    assert.equal(row.cost_microcents, 0);
    assert.equal(row.input_tokens, 300);
    const st = (await gc(OTHER, 'ai.status')).result;
    assert.equal(st.available, true);
  });

  it('"Für alles": the gateway does not answer / is busy / misses the model → one try at the cloud', async () => {
    for (const mode of ['error_line', 'busy', 'not_running', 'missing']) {
      fakeGw.mode = mode;
      cloud.calls.length = 0;
      const r = (await extract(OTHER)).result;
      assert.equal(r.provider, 'openai', mode);
      assert.equal(r.fallback, true, mode);
      assert.deepEqual(r.data, { summary: 'aus der Cloud' });
      assert.equal(cloudChats().length, 1, mode);
    }
    assert.ok(db.prepare("SELECT 1 FROM activity_log WHERE event_type = 'ai_local_unreachable'").get(), 'the admins hear of it (once an hour)');
    // offline (no heartbeat): the cloud right away, no connection to the gateway
    db.prepare('UPDATE gateway_meta SET alive = 0 WHERE peer_id = ?').run(nas.peer.id);
    fakeGw.calls.length = 0;
    const r = (await extract(OTHER)).result;
    assert.equal(r.provider, 'openai');
    assert.equal(chats().length, 0);
    db.prepare('UPDATE gateway_meta SET alive = 1 WHERE peer_id = ?').run(nas.peer.id);
  });

  it('"Für alles": a picture must be understood → the cloud', async () => {
    await put(`${AI}/settings`, { mediaAllowed: true }).expect(200);
    const tiny = await require('sharp')({ create: { width: 4, height: 4, channels: 3, background: '#ff0000' } }).png().toBuffer();
    const up = (await agent.put(`${API}/${OTHER}/media`).set('X-CSRF-Token', csrf).set('Content-Type', 'image/png').set('X-Filename', 'a.png').send(tiny)).body;
    if (up && up.mediaId) {
      const r = (await extract(OTHER, { input: [{ type: 'text', text: 'Was ist das?' }, { type: 'media', mediaId: up.mediaId }] })).result;
      assert.equal(r.provider, 'openai');
      assert.equal(chats().length, 0);
    } else {
      // no media route for the test plugin: the routing decision itself
      const pl = require('../src/services/plugins/registry').get(OTHER);
      assert.notEqual(ai.local.ready(), null);
      assert.equal(require('../src/services/ai').available(pl, { capability: 'vision' }), true);
    }
    await put(`${AI}/settings`, { mediaAllowed: false }).expect(200);
  });

  it('"Nur für private Inhalte": Mail local and never to the cloud, other plugins as before', async () => {
    await put(AI + '/local/use', { use: 'private' }).expect(200);
    let r = (await extract(MAIL)).result;
    assert.equal(r.provider, 'local');
    assert.equal(lastRow().route, 'private');
    r = (await extract(OTHER)).result;
    assert.equal(r.provider, 'openai');
    assert.equal(lastRow().route, 'cloud');
    fakeGw.mode = 'error_line';
    cloud.calls.length = 0;
    const e = await extract(MAIL);
    assert.equal(e.error && e.error.code ? e.error.code : e.code, 'ERR_AI_PROVIDER', JSON.stringify(e));
    assert.equal(cloudChats().length, 0, 'private content never goes to the cloud');
  });

  it('"Nur als Ausweich": the cloud as before; local once the budget is used up', async () => {
    await put(AI + '/local/use', { use: 'fallback' }).expect(200);
    let r = (await extract(OTHER)).result;
    assert.equal(r.provider, 'openai');
    await put(`${AI}/settings`, { budgetCents: 1 }).expect(200);
    // spend the cent
    db.prepare(`INSERT INTO ai_requests (at, plugin_id, provider, kind, cost_microcents, outcome) VALUES (?, ?, 'openai', 'extract', ?, 'ok')`).run(Date.now(), OTHER, 2e6);
    cloud.calls.length = 0;
    r = (await extract(OTHER)).result;
    assert.equal(r.provider, 'local');
    assert.equal(lastRow().route, 'budget');
    assert.equal(cloudChats().length, 0);
    await put(`${AI}/settings`, { budgetCents: 1000 }).expect(200);
    db.prepare("DELETE FROM ai_requests WHERE cost_microcents = 2000000").run();
  });

  it('a plugin fixed to the local AI: only there; the provider switched off: the cloud', async () => {
    await put(AI + '/local/use', { use: 'fallback' }).expect(200);
    await put(`${AI}/plugins/${OTHER}`, { provider: 'local' }).expect(200);
    let r = (await extract(OTHER)).result;
    assert.equal(r.provider, 'local');
    assert.equal(lastRow().route, 'fixed');
    await put(`${AI}/plugins/${OTHER}`, { provider: null }).expect(200);
    await put(AI + '/local/use', { use: 'all' }).expect(200);
    await put(AI + '/local/enabled', { enabled: false }).expect(200);
    r = (await extract(OTHER)).result;
    assert.equal(r.provider, 'openai');
    await put(AI + '/local/enabled', { enabled: true }).expect(200);
  });

  it('the switch in "Funktionen" off → the local AI is not used', async () => {
    await agent.put(`/api/v1/gateways/${nas.peer.id}/features`).set('X-CSRF-Token', csrf).send({ ai: { enabled: false } }).expect(200);
    assert.equal(local.ready(), null);
    const r = (await extract(OTHER)).result;
    assert.equal(r.provider, 'openai');
    await agent.put(`/api/v1/gateways/${nas.peer.id}/features`).set('X-CSRF-Token', csrf).send({ ai: { enabled: true } }).expect(200);
    assert.notEqual(local.ready(), null);
  });

  it('test button: "Fasse diese Mail zusammen" through the local AI, logged as GateControl', async () => {
    fakeGw.words = ['Am 14. November ', 'kommt der Ablesedienst.'];
    const r = (await post(AI + '/local/test').expect(200)).body;
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.text, 'Am 14. November kommt der Ablesedienst.');
    assert.equal(r.model, 'llama3.2:3b');
    const row = lastRow();
    assert.equal(row.plugin_id, 'gatecontrol');
    assert.equal(row.route, 'test');
    fakeGw.mode = 'not_running';
    const bad = (await post(AI + '/local/test').expect(200)).body;
    assert.equal(bad.ok, false);
    assert.equal(bad.code, 'network');
    fakeGw.words = ['{"summary":', '"Rechnung bis Freitag bezahlen."}'];
  });
});

// ─── the streamed management call ────────────────────────────────────────

describe('gateways.mgmtStream (the proxy between server and gateway)', () => {
  it('idle limit, answer too large, no gateway, the gateway refuses', async () => {
    fakeGw.mode = 'stall';
    await assert.rejects(gateways.mgmtStream(nas.peer.id, '/api/ai/chat', {}, { idleMs: 200, onLine: () => {} }), (e) => e.code === 'timeout');
    fakeGw.mode = 'huge';
    await assert.rejects(gateways.mgmtStream(nas.peer.id, '/api/ai/chat', {}, { maxBytes: 64 * 1024, onLine: () => {} }), (e) => e.code === 'too_large');
    fakeGw.mode = 'busy';
    assert.deepEqual(await gateways.mgmtStream(nas.peer.id, '/api/ai/chat', {}, { onLine: () => {} }), { status: 429, body: { error: 'busy' } });
    await assert.rejects(gateways.mgmtStream(999999, '/api/ai/chat', {}, { onLine: () => {} }), (e) => e.code === 'unreachable');
    // the answer of the local adapter is capped as well
    fakeGw.mode = 'huge';
    await assert.rejects(local.complete({ model: 'llama3.2:3b', instructions: 'x', parts: [{ type: 'text', text: 'y' }], maxOutputTokens: 10, timeoutMs: 10000, peerId: nas.peer.id }),
      (e) => e.kind === 'invalid');
  });

  it('a long input is shortened in the middle to the context, never silently cut at the start', () => {
    const t = 'A'.repeat(50000) + 'Z'.repeat(50000);
    const f = local.fitText(t, 10000);
    assert.equal(f.cut, true);
    assert.ok(f.text.startsWith('AAAA') && f.text.endsWith('ZZZZ'));
    assert.ok(f.text.length <= 10000);
  });

  it('a plugin may wait minutes for gc.ai (host and child)', () => {
    const host = require('../src/services/plugins/hostApi');
    assert.ok(host.callTimeout('ai.generate', { timeoutMs: 20000 }) >= 5 * 60 * 1000);
    assert.equal(host.callTimeout('ai.generate', { timeoutMs: 180000 }), 2 * 180000 + 15000);
  });
});

// ─── gateway features, compose ───────────────────────────────────────────

describe('gateway › Funktionen: the row "Lokale KI" and the memory', () => {
  it('row, model, memory part drawn blue (the model in memory)', async () => {
    const v = (await agent.get(`/api/v1/gateways/${nas.peer.id}/features`).expect(200)).body.gateway;
    assert.equal(v.ai.enabled, true);
    assert.equal(v.ai.chosen, true);
    assert.equal(v.ai.model.id, 'llama3.2:3b');
    assert.equal(v.ai.model.present, true);
    assert.equal(v.ai.state.state, 'running');
    assert.equal(v.support.ai, true);
    const part = v.memory.parts.find((p) => p.key === 'ai');
    assert.equal(part.kind, 'ai');
    assert.equal(part.loaded, true);
    assert.ok(part.mb > 2600 && part.mb < 2800);
    assert.equal(v.memory.level, 'ok');
    // the Pi: too little memory → a hint, the switch stays
    const p = (await agent.get(`/api/v1/gateways/${pi.peer.id}/features`).expect(200)).body.gateway;
    assert.equal(p.ai.hint, 'memory');
    assert.equal(p.ai.enabled, false);
    const bad = await agent.put(`/api/v1/gateways/${pi.peer.id}/features`).set('X-CSRF-Token', csrf).send({ ai: { lanUrl: 'http://1.1.1.1:80' } });
    assert.equal(bad.status, 400);
    assert.equal((await agent.put(`/api/v1/gateways/${pi.peer.id}/features`).set('X-CSRF-Token', csrf).send({ ai: { source: 'cloud' } })).status, 400);
  });

  it('compose hint: Synology without the service → "compose"; the download brings the service ki', async () => {
    setTel(nas, { ai: aiTel({ service: 'missing', state: 'service_missing', loaded: [] }) });
    db.prepare("UPDATE gateway_meta SET platform = 'synology' WHERE peer_id = ?").run(nas.peer.id);
    const v = (await agent.get(`/api/v1/gateways/${nas.peer.id}/features`).expect(200)).body.gateway;
    assert.equal(v.ai.compose, 'compose');
    assert.equal(v.memory.parts.find((p) => p.key === 'ai').loaded, false, 'not loaded: the expected size of the model');
    const kit = require('../public/js/gateway-kit');
    const text = (await agent.post(`/api/v1/gateways/${nas.peer.id}/compose`).set('X-CSRF-Token', csrf).send({ platform: 'synology' }).expect(200)).text;
    assert.equal(text, kit.buildCompose({ platform: 'synology', network: 'host', ai: true }));
    assert.match(text, /\n {2}ki:\n/);
    assert.doesNotMatch(text, /profiles:/);
    const off = (await agent.post(`/api/v1/gateways/${pi.peer.id}/compose`).set('X-CSRF-Token', csrf).send({ platform: 'linux' }).expect(200)).text;
    assert.doesNotMatch(off, /\n {2}ki:\n/);
    setTel(nas);
  });

  it('switching the gateway of the local AI switches the old one off', async () => {
    await put(AI + '/local', { source: 'lan', peerId: pi.peer.id, model: 'qwen2.5-7b-instruct', lanUrl: 'http://192.168.1.20:1234/v1', lanApi: 'openai' }).expect(200);
    const cfg = (await supertest(app).get('/api/v1/gateway/config').set('Authorization', 'Bearer ' + pi.apiToken).expect(200)).body;
    assert.deepEqual(cfg.features.ai, { enabled: true, source: 'lan', lan: { url: 'http://192.168.1.20:1234', api: 'openai' } });
    const old = (await supertest(app).get('/api/v1/gateway/config').set('Authorization', 'Bearer ' + nas.apiToken).expect(200)).body;
    assert.equal(old.features.ai.enabled, false);
    assert.equal(local.peerId(), pi.peer.id);
  });
});

// ─── the open items of phase 3c: names/IPv6, API key, connection test, graphics card ──

const SUPPORTS = ['gpu', 'lanKey', 'lanHost', 'probe'];
const LAN_KEY = 'sk-lan-SECRET-4711-abcd';

describe('LAN server: names and IPv6, the API key, "Verbindung testen"', () => {
  it('names (resolved by the gateway) and private IPv6 addresses; nothing that leaves the home network', () => {
    assert.equal(local.lanUrl('http://KI-PC.local:11434'), 'http://ki-pc.local:11434');
    assert.equal(local.lanUrl('https://llm.fritz.box/v1'), 'https://llm.fritz.box:443');
    assert.equal(local.lanUrl('http://[fd00:0:0::20]:11434'), 'http://[fd00::20]:11434');
    for (const bad of ['http://[::1]:11434', 'http://[fe80::1]:11434', 'http://[2001:db8::1]/', 'http://localhost/', 'http://a.localhost/', 'http://8.8.8.8/',
      'http://169.254.169.254/', 'http://nas_1/', 'http://1.2.3/', 'http://[::ffff:192.168.1.2]/']) assert.equal(local.lanUrl(bad), null, bad);
  });

  it('the key: stored encrypted, only its revision in the config pull, fetched only by the forwarding gateway, never shown', async () => {
    await put(AI + '/local', { source: 'lan', peerId: pi.peer.id, model: 'qwen2.5-7b-instruct', lanUrl: 'http://llm.fritz.box:8000/v1', lanApi: 'openai', lanKey: LAN_KEY }).expect(200);
    const row = db.prepare("SELECT key_encrypted, key_hint FROM ai_providers WHERE id = 'local'").get();
    assert.ok(row.key_encrypted && !row.key_encrypted.includes(LAN_KEY), 'encrypted at rest');
    assert.equal(row.key_hint, 'abcd');
    const cfg = (await supertest(app).get('/api/v1/gateway/config').set('Authorization', 'Bearer ' + pi.apiToken).expect(200)).body;
    assert.equal(cfg.features.ai.lan.url, 'http://llm.fritz.box:8000');
    assert.match(cfg.features.ai.lan.keyRev, /^[0-9a-f]{16}$/);
    assert.ok(!JSON.stringify(cfg).includes(LAN_KEY), 'never in the config pull');
    const cred = (await supertest(app).get('/api/v1/gateway/ai/credentials').set('Authorization', 'Bearer ' + pi.apiToken).expect(200));
    assert.equal(cred.headers['cache-control'], 'no-store');
    assert.deepEqual(cred.body, { rev: cfg.features.ai.lan.keyRev, key: LAN_KEY });
    // the other gateway gets nothing
    assert.deepEqual((await supertest(app).get('/api/v1/gateway/ai/credentials').set('Authorization', 'Bearer ' + nas.apiToken).expect(200)).body, { rev: null, key: null });
    assert.equal((await supertest(app).get('/api/v1/gateway/config').set('Authorization', 'Bearer ' + nas.apiToken).expect(200)).body.features.ai.lan, null);
    await supertest(app).get('/api/v1/gateway/ai/credentials').expect(401);
    // the admin pages show only that a key is there
    const v = (await agent.get(AI + '/local').expect(200)).body;
    assert.equal(v.current.keySet, true);
    assert.equal(v.current.keyHint, 'abcd');
    assert.ok(!JSON.stringify(v).includes(LAN_KEY));
    const all = (await agent.get(AI).expect(200)).body;
    assert.equal(all.providers.find((p) => p.id === 'local').keySet, true);
    assert.ok(!JSON.stringify(all).includes(LAN_KEY));
    const f = (await agent.get(`/api/v1/gateways/${pi.peer.id}/features`).expect(200)).body.gateway;
    assert.equal(f.ai.lanKey, true);
    assert.ok(!JSON.stringify(f).includes(LAN_KEY));
    const logs = db.prepare("SELECT message, details FROM activity_log WHERE event_type LIKE 'ai_local%' OR event_type = 'gateway_features_changed'").all();
    assert.ok(logs.some((l) => /API key of the AI server saved/.test(l.message)));
    assert.ok(!JSON.stringify(logs).includes(LAN_KEY), 'never in the activity log');
    // saving without lanKey keeps it (same revision); a new key → a new revision
    await put(AI + '/local', { source: 'lan', peerId: pi.peer.id, model: 'qwen2.5-7b-instruct', lanUrl: 'http://llm.fritz.box:8000/v1', lanApi: 'openai' }).expect(200);
    const rev1 = local.credentialsFor(pi.peer.id).rev;
    assert.equal(rev1, cfg.features.ai.lan.keyRev);
    await put(AI + '/local', { source: 'lan', peerId: pi.peer.id, model: 'qwen2.5-7b-instruct', lanUrl: 'http://llm.fritz.box:8000/v1', lanApi: 'openai', lanKey: 'sk-new-0000' }).expect(200);
    const c2 = local.credentialsFor(pi.peer.id);
    assert.notEqual(c2.rev, rev1);
    assert.equal(c2.key, 'sk-new-0000');
    // removed: no revision, the gateway forgets it
    await put(AI + '/local', { source: 'lan', peerId: pi.peer.id, model: 'qwen2.5-7b-instruct', lanUrl: 'http://llm.fritz.box:8000/v1', lanApi: 'openai', lanKey: null }).expect(200);
    assert.deepEqual(local.credentialsFor(pi.peer.id), { rev: null, key: null });
    assert.equal(((await supertest(app).get('/api/v1/gateway/config').set('Authorization', 'Bearer ' + pi.apiToken).expect(200)).body.features.ai.lan.keyRev), undefined);
    assert.equal((await agent.get(AI + '/local').expect(200)).body.current.keySet, false);
  });

  it('"Verbindung testen": the gateway asks the server (nothing saved), with the typed key or the stored one for the saved address', async () => {
    setTel(nas, { ai: aiTel({ supports: SUPPORTS }) });
    const r = (await post(AI + '/local/probe', { peerId: nas.peer.id, lanUrl: 'http://[fd00::20]:11434', lanApi: 'ollama', lanKey: 'sk-typed' }).expect(200)).body;
    assert.deepEqual(r.probe, { reachable: true, url: 'http://[fd00::20]:11434', api: 'ollama', version: '0.40.8', models: [{ name: 'qwen2.5:14b', size: 9e9 }], auth: true,
      pinned: false, pin: null, pinSupported: false, certificate: null, error: null });
    assert.deepEqual(fakeGw.calls.find((c) => c.path === '/api/ai/probe').body, { url: 'http://[fd00::20]:11434', api: 'ollama', key: 'sk-typed' });
    assert.equal(fakeGw.calls[0].token, nas.pushToken);
    // no typed key: the stored one goes along — to the saved address only
    await put(AI + '/local', { source: 'lan', peerId: pi.peer.id, model: 'qwen2.5-7b-instruct', lanUrl: 'http://llm.fritz.box:8000', lanApi: 'openai', lanKey: LAN_KEY }).expect(200);
    fakeGw.calls.length = 0;
    await post(AI + '/local/probe', { peerId: nas.peer.id, lanUrl: 'http://llm.fritz.box:8000/v1' }).expect(200);
    assert.equal(fakeGw.calls[0].body.key, LAN_KEY);
    // … but never to another address typed for the test
    fakeGw.calls.length = 0;
    await post(AI + '/local/probe', { peerId: nas.peer.id, lanUrl: 'http://ki-pc.local:11434' }).expect(200);
    assert.equal(fakeGw.calls[0].body.key, undefined);
    // checked before: the address, the key, a gateway that cannot do it
    assert.equal((await post(AI + '/local/probe', { peerId: nas.peer.id, lanUrl: 'http://8.8.8.8:11434' })).body.field, 'lanUrl');
    assert.equal((await post(AI + '/local/probe', { peerId: nas.peer.id, lanUrl: 'http://10.0.0.2:1', lanKey: 'a b' })).body.field, 'lanKey');
    setTel(nas);
    const old = await post(AI + '/local/probe', { peerId: nas.peer.id, lanUrl: 'http://10.0.0.2:11434' });
    assert.equal(old.status, 409);
    assert.equal(old.body.code, 'gateway_unsupported_ext');
    // an unauthorized server: the gateway's error code reaches the provider as a client error
    assert.equal(local.errorKind('unauthorized'), 'client');
    assert.equal(local.errorKind('not_private'), 'network');
  });
});

describe('graphics card ("Grafikkarte nutzen")', () => {
  const NV = { vendor: 'nvidia', driver: 'nvidia', vramMb: null, integrated: false, name: 'NVIDIA GeForce RTX 3060' };
  const host = (extra) => ({ memTotal: 31 * GB, cores: 8, arch: 'x64', gpu: [NV], nvidiaDriver: '550.54.14', kfd: false, render: true, ...extra });
  const facts = (h) => local.factsOf({ features: { ai: { host: h } } });
  const view = (h, gpu, s = 'nvidia', o = {}) => local.gpuView(facts(h), { source: 'service', gpu }, { gpu: s }, { supports: SUPPORTS, ...o });

  it('hints from the hardware report: driver, toolkit, ROCm, compose file — never a ban', () => {
    assert.deepEqual(view(host(), null, 'off').hints, ['available'], 'a usable card: suggested, not switched on');
    assert.equal(view(host(), null, 'off').suggest, 'nvidia');
    assert.deepEqual(view(host({ gpu: [{ ...NV, driver: 'nouveau' }], nvidiaDriver: null }), null).hints, ['nvidia_driver']);
    assert.deepEqual(view(host({ nvidiaDriver: '535.183.01' }), null).hints, ['nvidia_old']);
    // the compose file still gives the service no GPU / the container does not see it (toolkit)
    assert.deepEqual(view(host(), { mode: 'none', devices: [], access: null, cards: [], used: false }).hints, ['compose']);
    const tk = view(host(), { mode: 'nvidia', devices: [], access: false, cards: [], used: false });
    assert.deepEqual([tk.hints, tk.state], [['toolkit'], 'waiting']);
    const ok = view(host(), { mode: 'nvidia', devices: ['nvidia'], access: true, cards: [{ name: 'NVIDIA GeForce RTX 3060', vramMb: 12288, driver: '550.54.14' }], used: true });
    assert.deepEqual([ok.hints, ok.state, ok.vramMb, ok.card.name], [[], 'in_use', 12288, 'NVIDIA GeForce RTX 3060']);
    // AMD: ROCm needs /dev/kfd and amd64; the memory comes from sysfs
    const amd = view(host({ gpu: [{ vendor: 'amd', driver: 'amdgpu', vramMb: 16384, integrated: false, name: null }], nvidiaDriver: null, kfd: false, arch: 'arm64' }), null, 'amd');
    assert.deepEqual([amd.hints, amd.vramMb], [['rocm', 'arch'], 16384]);
    // Intel: experimental; no card at all
    assert.deepEqual(view(host({ gpu: [], render: false }), null, 'intel').hints, ['no_card', 'dri', 'experimental']);
    // a gateway older than 1.31.0 / the Pi image
    assert.deepEqual(local.gpuView(facts(host()), null, { gpu: 'off' }, { supports: [] }).hints, ['unsupported']);
    assert.deepEqual(view(host(), null, 'nvidia', { platform: 'rpi' }).hints, ['rpi']);
  });

  it('chosen in the setup → the compose file gets the card; the catalogue fits by graphics memory', async () => {
    db.prepare("UPDATE gateway_meta SET platform = 'linux' WHERE peer_id = ?").run(nas.peer.id);
    const smi = { mode: 'nvidia', devices: ['nvidia'], access: true, cards: [{ name: 'NVIDIA GeForce RTX 3060', vramMb: 12288, driver: '550.54.14' }], used: false };
    setTel(nas, { mem: 31 * GB, cores: 8, ai: aiTel({ supports: SUPPORTS, host: host(), gpu: { ...smi, mode: 'none', access: null, devices: [], cards: [] } }) });
    let v = (await agent.get(AI + '/local').expect(200)).body;
    let g = v.gateways.find((x) => x.id === nas.peer.id);
    assert.deepEqual([g.gpuView.choice, g.gpuView.suggest, g.gpuView.hints], ['off', 'nvidia', ['available']]);
    const cat = v.catalogue.find((c) => c.peerId === nas.peer.id);
    assert.deepEqual(Object.keys(cat.byGpu), ['off', 'nvidia', 'amd', 'intel'], 'the fit per choice, for the page to switch live');
    assert.deepEqual(g.gpuOptions.amd.hints, ['no_card', 'rocm', 'compose'], 'what AMD would mean here, before saving');
    await put(AI + '/local', { source: 'service', peerId: nas.peer.id, model: 'qwen2.5:14b', gpu: 'nvidia' }).expect(200);
    assert.equal(db.prepare('SELECT settings FROM gateway_features WHERE peer_id = ?').get(nas.peer.id).settings.includes('"gpu":"nvidia"'), true);
    // the running service has no GPU yet: download the compose file again
    let f = (await agent.get(`/api/v1/gateways/${nas.peer.id}/features`).expect(200)).body.gateway;
    assert.equal(f.ai.compose, 'compose_gpu');
    assert.deepEqual(f.ai.gpu.hints, ['compose']);
    const kit = require('../public/js/gateway-kit');
    const text = (await agent.post(`/api/v1/gateways/${nas.peer.id}/compose`).set('X-CSRF-Token', csrf).send({}).expect(200)).text;
    assert.equal(text, kit.buildCompose({ platform: 'linux', network: 'host', ai: true, aiGpu: 'nvidia' }));
    assert.match(text, /- driver: nvidia\n {14}count: all\n {14}capabilities: \[gpu\]/);
    assert.match(text, /- GC_KI_GPU=nvidia/);
    // after the new compose file: the service sees the card; 12 GB → Qwen 2.5 14B fits into it
    setTel(nas, { mem: 31 * GB, cores: 8, ai: aiTel({ supports: SUPPORTS, host: host(), gpu: smi }) });
    f = (await agent.get(`/api/v1/gateways/${nas.peer.id}/features`).expect(200)).body.gateway;
    assert.equal(f.ai.compose, null);
    assert.deepEqual([f.ai.gpu.state, f.ai.gpu.vramMb], ['ready', 12288]);
    v = (await agent.get(AI + '/local').expect(200)).body;
    const m = v.catalogue.find((c) => c.peerId === nas.peer.id).models.find((x) => x.id === 'qwen2.5:14b');
    assert.deepEqual([m.fit, m.vram], ['recommended', 'full']);
    assert.equal(v.current.gpu, 'nvidia');
    // AMD: the ROCm image with the devices
    await put(`/api/v1/gateways/${nas.peer.id}/features`, { ai: { gpu: 'amd' } }).expect(200);
    const amd = (await agent.post(`/api/v1/gateways/${nas.peer.id}/compose`).set('X-CSRF-Token', csrf).send({}).expect(200)).text;
    assert.match(amd, /image: ollama\/ollama:[0-9.]+-rocm@sha256:[0-9a-f]{64}/);
    assert.match(amd, /devices:\n {6}- \/dev\/kfd\n {6}- \/dev\/dri/);
    // the Raspberry Pi image: never a GPU in its compose
    db.prepare("UPDATE gateway_meta SET platform = 'rpi' WHERE peer_id = ?").run(nas.peer.id);
    assert.equal(local.composeGpu(nas.peer.id), null);
    assert.equal((await put(`/api/v1/gateways/${nas.peer.id}/features`, { ai: { gpu: 'cuda' } })).status, 400);
    await put(`/api/v1/gateways/${nas.peer.id}/features`, { ai: { gpu: 'off' } }).expect(200);
    db.prepare("UPDATE gateway_meta SET platform = 'synology' WHERE peer_id = ?").run(nas.peer.id);
    setTel(nas);
  });
});

// ─── https with a self-signed certificate: pinned, never unchecked ───────

describe('LAN server with https and a self-signed certificate: the certificate is pinned', () => {
  const FP = 'a1b2c3d4'.repeat(8);
  const FP2 = '0f1e2d3c'.repeat(8);
  const COLONS = FP.toUpperCase().match(/../g).join(':');
  const URL_TLS = 'https://192.168.1.20:11434';
  const certOf = (sha256) => ({ sha256, subject: 'CN=ki-pc', issuer: 'CN=ki-pc', validTo: '2035-01-01T00:00:00.000Z', selfSigned: true, extra: 'dropped' });
  const PIN = SUPPORTS.concat('lanPin');
  const probes = () => fakeGw.calls.filter((c) => c.path === '/api/ai/probe');
  const pinLogs = () => db.prepare("SELECT event_type, details FROM activity_log WHERE event_type LIKE 'ai_local_pin%' ORDER BY id").all();
  // lan of the config pull, without the key revision (a key may be stored from the tests above)
  const cfgLan = async () => {
    const { keyRev: _rev, ...lan } = (await supertest(app).get('/api/v1/gateway/config').set('Authorization', 'Bearer ' + nas.apiToken).expect(200)).body.features.ai.lan;
    return lan;
  };

  before(() => { fakeGw.cert = certOf(FP); });
  after(() => { fakeGw.cert = null; });

  it('a fingerprint in any usual spelling; only with https; settings and config pull', () => {
    assert.equal(local.pinOf(FP), FP);
    assert.equal(local.pinOf(COLONS), FP);
    assert.equal(local.pinOf('sha256:' + FP.toUpperCase()), FP);
    for (const bad of ['', 'abc', FP + '00', FP.slice(2), 'zz'.repeat(32), null, 7, 'x'.repeat(300)]) assert.equal(local.pinOf(bad), null, String(bad));
    assert.equal(local.normalizeSettings({ source: 'lan', lanUrl: URL_TLS, lanPin: COLONS }).lanPin, FP);
    assert.equal(local.normalizeSettings({ source: 'lan', lanUrl: 'http://192.168.1.20:11434', lanPin: FP }).lanPin, null, 'no TLS, nothing to pin');
    assert.equal(local.normalizeSettings({}).lanPin, null);
    assert.equal(local.patchField('lanPin', COLONS), FP);
    assert.equal(local.patchField('lanPin', ''), null);
    assert.throws(() => local.patchField('lanPin', 'nope'), (e) => e.code === 'invalid');
    // the gateway's report
    const t = local.telemetryAi({ features: { ai: aiTel({ source: 'lan', supports: PIN.concat('evil'), lan: { url: URL_TLS, api: 'ollama', reachable: true, auth: false, pinned: true } }) } });
    assert.deepEqual(t.supports, PIN);
    assert.equal(t.lan.pinned, true);
  });

  it('"Verbindung testen" shows the certificate to confirm — nothing is stored, the check is never switched off', async () => {
    setTel(nas, { ai: aiTel({ supports: PIN }) });
    let r = (await post(AI + '/local/probe', { peerId: nas.peer.id, lanUrl: URL_TLS, lanApi: 'ollama', lanPin: null }).expect(200)).body.probe;
    assert.equal(r.reachable, false);
    assert.equal(r.error.code, 'tls_untrusted');
    assert.equal(r.pinned, false);
    assert.equal(r.pinSupported, true);
    assert.deepEqual(r.certificate, { sha256: FP, subject: 'CN=ki-pc', issuer: 'CN=ki-pc', validTo: '2035-01-01T00:00:00.000Z', selfSigned: true });
    assert.deepEqual(probes()[0].body, { url: URL_TLS, api: 'ollama' }, 'no pin, and nothing that switches the check off');
    // the admin confirmed the fingerprint on the page: the test runs against exactly that certificate
    r = (await post(AI + '/local/probe', { peerId: nas.peer.id, lanUrl: URL_TLS, lanApi: 'ollama', lanPin: COLONS }).expect(200)).body.probe;
    assert.equal(probes()[1].body.pin, FP);
    assert.equal(r.reachable, true);
    assert.equal(r.pinned, true);
    assert.equal(r.pin, FP);
    assert.equal(r.certificate, null);
    assert.equal((await agent.get(`/api/v1/gateways/${nas.peer.id}/features`).expect(200)).body.gateway.ai.lanPinned, false, 'nothing stored by a test');
    // not a fingerprint
    const bad = await post(AI + '/local/probe', { peerId: nas.peer.id, lanUrl: URL_TLS, lanPin: 'kein-fingerabdruck' });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.field, 'lanPin');
    // http: there is nothing to pin, the pin does not go along
    fakeGw.calls.length = 0;
    await post(AI + '/local/probe', { peerId: nas.peer.id, lanUrl: 'http://192.168.1.20:11434', lanPin: FP }).expect(200);
    assert.equal(probes()[0].body.pin, undefined);
  });

  it('"Speichern" stores the confirmed fingerprint: config pull lan.pin, shown in the setup, logged', async () => {
    setTel(nas, { ai: aiTel({ supports: PIN }) });
    const saved = (await put(AI + '/local', { source: 'lan', peerId: nas.peer.id, model: 'qwen2.5:14b', lanUrl: URL_TLS, lanApi: 'ollama', lanPin: COLONS }).expect(200)).body;
    assert.equal(saved.current.lanPin, FP);
    assert.deepEqual(await cfgLan(), { url: URL_TLS, api: 'ollama', pin: FP });
    assert.equal(require('../src/services/gatewayFeatures').get(nas.peer.id).ai.lanPin, FP);
    assert.equal((await agent.get(`/api/v1/gateways/${nas.peer.id}/features`).expect(200)).body.gateway.ai.lanPinned, true);
    const log = pinLogs().pop();
    assert.equal(log.event_type, 'ai_local_pin_set');
    assert.equal(JSON.parse(log.details).sha256, FP);
    // saving again without lanPin keeps it; no second log row
    const n = pinLogs().length;
    await put(AI + '/local', { source: 'lan', peerId: nas.peer.id, model: 'qwen2.5:14b', lanUrl: URL_TLS, lanApi: 'ollama' }).expect(200);
    assert.equal((await cfgLan()).pin, FP);
    assert.equal(pinLogs().length, n);
  });

  it('the stored pin goes along with a test of the saved address only; a changed certificate is shown, not accepted', async () => {
    setTel(nas, { ai: aiTel({ supports: PIN }) });
    await post(AI + '/local/probe', { peerId: nas.peer.id, lanUrl: URL_TLS }).expect(200);
    assert.equal(probes()[0].body.pin, FP);
    await post(AI + '/local/probe', { peerId: nas.peer.id, lanUrl: 'https://192.168.1.21:11434' }).expect(200);
    assert.equal(probes()[1].body.pin, undefined, 'never for another address');
    await post(AI + '/local/probe', { peerId: nas.peer.id, lanUrl: URL_TLS, lanPin: null }).expect(200);
    assert.equal(probes()[2].body.pin, undefined, 'the page dropped the pin: none');
    // the server now presents another certificate (renewed — or somebody else answers)
    fakeGw.cert = certOf(FP2);
    const r = (await post(AI + '/local/probe', { peerId: nas.peer.id, lanUrl: URL_TLS }).expect(200)).body.probe;
    assert.equal(r.reachable, false);
    assert.equal(r.error.code, 'tls_pin_mismatch');
    assert.equal(r.pinned, true);
    assert.equal(r.certificate.sha256, FP2);
    assert.equal((await cfgLan()).pin, FP, 'the stored pin stays until the admin confirms the new one');
    // "Neuem Zertifikat vertrauen" + "Speichern"
    await put(AI + '/local', { source: 'lan', peerId: nas.peer.id, model: 'qwen2.5:14b', lanUrl: URL_TLS, lanApi: 'ollama', lanPin: FP2 }).expect(200);
    assert.equal((await cfgLan()).pin, FP2);
    const log = pinLogs().pop();
    assert.deepEqual([log.event_type, JSON.parse(log.details).sha256, JSON.parse(log.details).before], ['ai_local_pin_set', FP2, FP]);
    fakeGw.cert = certOf(FP);
  });

  it('a new address forgets the pin; "Entfernen" removes it; a pin without https is refused', async () => {
    setTel(nas, { ai: aiTel({ supports: PIN }) });
    // another server: the old fingerprint would say nothing about it
    await put(AI + '/local', { source: 'lan', peerId: nas.peer.id, model: 'qwen2.5:14b', lanUrl: 'https://192.168.1.21:11434', lanApi: 'ollama' }).expect(200);
    assert.deepEqual(await cfgLan(), { url: 'https://192.168.1.21:11434', api: 'ollama' });
    assert.equal(pinLogs().pop().event_type, 'ai_local_pin_removed');
    // … also through the features API
    await put(AI + '/local', { source: 'lan', peerId: nas.peer.id, model: 'qwen2.5:14b', lanUrl: URL_TLS, lanApi: 'ollama', lanPin: FP }).expect(200);
    await put(`/api/v1/gateways/${nas.peer.id}/features`, { ai: { lanUrl: 'https://192.168.1.22:11434' } }).expect(200);
    assert.equal((await cfgLan()).pin, undefined);
    await put(`/api/v1/gateways/${nas.peer.id}/features`, { ai: { lanUrl: URL_TLS, lanPin: COLONS } }).expect(200);
    assert.equal((await cfgLan()).pin, FP, 'address and pin together');
    assert.equal((await put(`/api/v1/gateways/${nas.peer.id}/features`, { ai: { lanPin: 'nope' } })).status, 400);
    // "Entfernen" + "Speichern"
    await put(AI + '/local', { source: 'lan', peerId: nas.peer.id, model: 'qwen2.5:14b', lanUrl: URL_TLS, lanApi: 'ollama', lanPin: null }).expect(200);
    assert.equal((await cfgLan()).pin, undefined);
    assert.equal((await agent.get(AI + '/local').expect(200)).body.current.lanPin, null);
    // refused: not a fingerprint, or nothing to pin (http)
    for (const b of [{ lanUrl: URL_TLS, lanPin: 'abc' }, { lanUrl: 'http://192.168.1.20:11434', lanPin: FP }]) {
      const bad = await put(AI + '/local', { source: 'lan', peerId: nas.peer.id, model: 'qwen2.5:14b', lanApi: 'ollama', ...b });
      assert.equal(bad.status, 400, JSON.stringify(b));
      assert.equal(bad.body.field, 'lanPin');
    }
  });

  it('a gateway that cannot pin yet: "Gateway-Update nötig" — never a connection without the check', async () => {
    setTel(nas, { ai: aiTel({ supports: SUPPORTS }) });
    const r = (await post(AI + '/local/probe', { peerId: nas.peer.id, lanUrl: URL_TLS, lanPin: null }).expect(200)).body.probe;
    assert.equal(r.pinSupported, false);
    assert.equal(r.error.code, 'tls_untrusted');
    const p = await post(AI + '/local/probe', { peerId: nas.peer.id, lanUrl: URL_TLS, lanPin: FP });
    assert.deepEqual([p.status, p.body.code], [409, 'gateway_unsupported_pin']);
    assert.match(p.body.error, /Gateway/);
    const s = await put(AI + '/local', { source: 'lan', peerId: nas.peer.id, model: 'qwen2.5:14b', lanUrl: URL_TLS, lanApi: 'ollama', lanPin: FP });
    assert.deepEqual([s.status, s.body.code], [409, 'gateway_unsupported_pin']);
    assert.equal((await cfgLan()).pin, undefined);
  });
});
