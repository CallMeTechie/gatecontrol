'use strict';

// The AI service gc.ai (docs/plugins.md "AI requests", src/services/ai/):
// permissions.ai in plugin.json and the install dialog, the policy per
// plugin, the admin API (keys write-only), the host API over the plugin's
// IPC bridge, the four provider adapters against a local HTTP stub (no
// provider is ever contacted in a test run), routing, fallback, schema check
// with a correction round, picture switch, rate limit, budget, the log, and
// that no key ends up in an answer, a log row, a log line or the plugin.

const crypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const supertest = require('supertest');
const sharp = require('sharp');
const { helloPackage, HELLO } = require('./helpers/plugins');
const { setup, teardown, getCsrf } = require('./helpers/setup');
const H = require('./helpers/notify');

const API = '/api/v1/plugins';
const AI = '/api/v1/ai';
const CLIENT = '/api/v1/client/plugins';
const PID = 'hello-ai';
const PLAIN = 'hello-noai';
const TEXTONLY = 'hello-ai-text';
const AREAS = 'hello-ai-areas';
const PROVIDER_IDS = ['openai', 'anthropic', 'gemini', 'openrouter'];
const KEYS = { openai: 'sk-test-openai-0001-SECRET', anthropic: 'sk-ant-test-0002-SECRET', gemini: 'AIza-test-0003-SECRET', openrouter: 'sk-or-test-0004-SECRET' };
const helloManifest = JSON.parse(fs.readFileSync(path.join(HELLO, 'plugin.json'), 'utf8'));
const clone = (v) => JSON.parse(JSON.stringify(v));
const AI_PERM = { purpose: { de: 'Dokumente erkennen', en: 'Recognise documents' }, capabilities: ['text', 'vision'] };
const SCHEMA = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['invoice', 'contract', 'other'] },
    title: { type: 'string', maxLength: 80 },
    amount: { type: 'number', nullable: true, minimum: 0 },
    deadlines: { type: 'array', maxItems: 5, items: { type: 'object', properties: { date: { type: 'string' }, label: { type: 'string' } }, required: ['date'] } },
  },
  required: ['kind', 'title'],
};
const GOOD = { kind: 'invoice', title: 'Stromrechnung', amount: 42.5, deadlines: [{ date: '2026-11-15', label: 'Zahlung' }] };

let app, agent, csrf, ai, logger, anna, annaDev, stub;

// ─── HTTP stub of the four providers ─────────────────────────────────────

function startStub() {
  const s = { calls: [], queue: { openai: [], anthropic: [], gemini: [], openrouter: [] }, answer: GOOD };
  const reply = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const defaults = {
    openai: (m, url) => (m === 'GET' ? { data: [{ id: 'model-a' }, { id: 'text-embed-x' }, { id: 'model-a-mini' }] }
      : { choices: [{ message: { content: JSON.stringify(s.answer) }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20 } }),
    anthropic: (m) => (m === 'GET' ? { data: [{ id: 'model-b', display_name: 'Model B' }] }
      : { content: [{ type: 'tool_use', name: 'result', input: s.answer }], usage: { input_tokens: 120, output_tokens: 30 }, stop_reason: 'tool_use' }),
    gemini: (m) => (m === 'GET' ? { models: [{ name: 'models/model-g', displayName: 'Model G', supportedGenerationMethods: ['generateContent'] }, { name: 'models/embed-g', supportedGenerationMethods: ['embedContent'] }] }
      : { candidates: [{ content: { parts: [{ text: JSON.stringify(s.answer) }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 10 } }),
    openrouter: (m) => (m === 'GET' ? { data: [
      { id: 'vendor/model-r', name: 'Model R', architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] }, supported_parameters: ['structured_outputs'], pricing: { prompt: '0.000003', completion: '0.000015' } },
      { id: 'vendor/model-t', name: 'Model T', architecture: { input_modalities: ['text'], output_modalities: ['text'] }, supported_parameters: [], pricing: { prompt: '0.000001', completion: '0.000002' } },
    ] } : { choices: [{ message: { content: JSON.stringify(s.answer) }, finish_reason: 'stop' }], usage: { prompt_tokens: 80, completion_tokens: 15, cost: 0.0012 } }),
  };
  const handlers = new Map(Object.entries(defaults));
  s.server = http.createServer((req, res) => {
    const parts = [];
    req.on('data', (c) => parts.push(c));
    req.on('end', () => {
      const [, provider, ...rest] = req.url.split('/');
      const raw = Buffer.concat(parts).toString('utf8');
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
      s.calls.push({ provider, method: req.method, path: '/' + rest.join('/'), headers: req.headers, body });
      // only the four known providers (an allowlist), never a name from the address
      const known = PROVIDER_IDS.find((x) => x === provider);
      if (!known) return reply(res, 404, { error: 'no such provider' });
      const handler = handlers.get(known);
      const q = s.queue[known];
      const next = q.shift();
      const send = () => {
        if (next && next.status) return reply(res, next.status, next.body || { error: { message: 'stub error' } });
        if (next && next.answer !== undefined) {
          const saved = s.answer;
          s.answer = next.answer;
          const out = handler(req.method, req.url);
          s.answer = saved;
          return reply(res, 200, out);
        }
        return reply(res, 200, handler(req.method, req.url));
      };
      if (next && next.delayMs) setTimeout(send, next.delayMs); else send();
    });
  });
  return new Promise((resolve) => s.server.listen(0, '127.0.0.1', () => {
    s.base = `http://127.0.0.1:${s.server.address().port}`;
    resolve(s);
  }));
}

function useStub() {
  for (const p of Object.keys(KEYS)) ai._testBase[p] = `${stub.base}/${p}`;
}
function noStub() {
  for (const p of Object.keys(KEYS)) delete ai._testBase[p];
}

// ─── helpers ─────────────────────────────────────────────────────────────

async function install(buf) {
  const r = await agent.post(API + '/inspect').set('X-CSRF-Token', csrf).set('Content-Type', 'application/octet-stream').send(buf).expect(200);
  assert.equal(r.body.canInstall, true, JSON.stringify(r.body.checks));
  await agent.post(API + '/install').set('X-CSRF-Token', csrf).send({ token: r.body.token, accept: true }).expect(200);
  return r.body;
}
const pkg = (id, extra = {}) => {
  const perms = { ...clone(helloManifest.permissions), app: true, ...(extra.permissions || {}) };
  return helloPackage({ overrides: { id, name: { de: id, en: id }, version: extra.version || '1.0.0', permissions: perms,
    media: extra.media || { maxBytes: 20 * 1024 * 1024, types: ['image/*', 'audio/ogg'] } } });
};
const gc = async (plugin, fn, ...args) => (await agent.post(`${API}/${plugin}/api/gc`).set('X-CSRF-Token', csrf).send({ fn, args })).body;
const put = (url, body) => agent.put(url).set('X-CSRF-Token', csrf).send(body);
const post = (url, body) => agent.post(url).set('X-CSRF-Token', csrf).send(body || {});
const extract = (plugin, o = {}) => gc(plugin, 'ai.extract', { task: 'doc_insight', instructions: 'Read the document.', input: [{ type: 'text', label: 'Text', text: 'Stromrechnung über 42,50 €, zahlbar bis 15.11.2026' }], schema: SCHEMA, maxOutputTokens: 500, timeoutMs: 5000, ...o });
const chatCalls = () => stub.calls.filter((c) => c.method === 'POST');

async function setUpProvider(id, model) {
  let r = await put(`${AI}/providers/${id}`, { key: KEYS[id] }).expect(200);
  assert.equal(r.body.provider.keyHint, KEYS[id].slice(-4));
  r = await post(`${AI}/providers/${id}/test`).expect(200);
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  await put(`${AI}/providers/${id}`, { modelText: model }).expect(200);
}

before(async () => {
  ({ app, agent } = await setup());
  csrf = getCsrf();
  ai = require('../src/services/ai');
  logger = require('../src/utils/logger');
  stub = await startStub();
  anna = H.makeUser('ai-anna');
  annaDev = H.makeDevice(anna, { name: 'ai-anna-phone' });
  const runtime = require('../src/services/plugins/runtime');
  const inspected = await install(pkg(PID, { permissions: { ai: AI_PERM } }));
  assert.deepEqual(inspected.plugin.permissions.ai, { purpose: 'Recognise documents', capabilities: ['text', 'vision'] }, 'the install dialog names the AI permission');
  await install(pkg(PLAIN));
  await install(pkg(TEXTONLY, { permissions: { ai: { purpose: 'Texte zusammenfassen', capabilities: ['text'] } } }));
  // like GateControl Drive: files in media areas (media store v2)
  await install(pkg(AREAS, { permissions: { ai: AI_PERM }, media: { maxBytes: 50 * 1024 * 1024, types: ['*/*'], areas: true, quotaDefault: '10GB' } }));
  for (const id of [PID, PLAIN, TEXTONLY, AREAS]) assert.equal(await runtime.waitRunning(id), true, id);
});
after(async () => {
  noStub();
  await new Promise((r) => stub.server.close(r));
  await require('../src/services/plugins').stop();
  teardown();
});
beforeEach(() => {
  stub.calls.length = 0;
  for (const q of Object.values(stub.queue)) q.length = 0;
  ai._resetForTest();
});

// ─── plugin.json ─────────────────────────────────────────────────────────

describe('plugin.json permissions.ai', () => {
  const manifest = require('../src/services/plugins/manifest');
  const check = (ai) => { const m = clone(helloManifest); m.permissions.ai = ai; return manifest.validate(m); };
  it('purpose and capabilities, normalised', () => {
    const r = check({ purpose: 'Rezepte lesen', capabilities: ['vision', 'text'] });
    assert.equal(r.ok, true, r.errors.join());
    assert.deepEqual(r.manifest.permissions.ai, { purpose: { de: 'Rezepte lesen', en: 'Rezepte lesen' }, capabilities: ['text', 'vision'] });
    assert.equal(manifest.validate(clone(helloManifest)).manifest.permissions.ai, null, 'none without the key');
  });
  it('invalid shapes', () => {
    for (const bad of [true, 'yes', {}, { purpose: 'x' }, { purpose: 'x', capabilities: [] }, { purpose: 'x', capabilities: ['smell'] },
      { purpose: 'x', capabilities: ['text', 'text'] }, { purpose: 'x', capabilities: ['text'], extra: 1 }, { purpose: 'x'.repeat(201), capabilities: ['text'] }]) {
      assert.deepEqual(check(bad).errors, ['permissions.ai: invalid'], JSON.stringify(bad));
    }
    assert.deepEqual(check({ purpose: 'x', capabilities: ['vision'] }).errors, ['permissions.ai.capabilities: needs "text"']);
  });
});

// ─── schema subset ───────────────────────────────────────────────────────

describe('schema subset (schema.js)', () => {
  const schema = require('../src/services/ai/schema');
  it('accepts the subset, refuses other keywords', () => {
    assert.doesNotThrow(() => schema.check(SCHEMA));
    assert.throws(() => schema.check({ type: 'array', items: { type: 'string' } }), /root must be/);
    assert.throws(() => schema.check({ type: 'object', properties: { a: { type: 'string', pattern: '^x' } } }), (e) => e.code === 'ERR_INVALID' && /pattern/.test(e.message));
    assert.throws(() => schema.check({ type: 'object', properties: { a: { oneOf: [] } } }), /oneOf/);
    assert.throws(() => schema.check({ type: 'object', properties: { a: { type: 'number', enum: ['1'] } } }), /enum/);
    assert.throws(() => schema.check({ type: 'object', properties: { a: { type: 'string' } }, required: ['b'] }), /required/);
  });
  it('validates, drops unknown properties and optional nulls', () => {
    let v = schema.validate(SCHEMA, { ...GOOD, extra: 1, deadlines: [{ date: 'x', label: null }] });
    assert.equal(v.ok, true, v.errors.join());
    assert.deepEqual(v.value, { kind: 'invoice', title: 'Stromrechnung', amount: 42.5, deadlines: [{ date: 'x' }] });
    v = schema.validate(SCHEMA, { kind: 'bill', title: 'x'.repeat(81), amount: -1, deadlines: [] });
    assert.equal(v.ok, false);
    assert.equal(v.errors.length, 3, v.errors.join());
    assert.equal(schema.validate(SCHEMA, { kind: 'other' }).errors[0], '$.title: missing');
  });
  it('strict form for OpenAI / OpenRouter: closed objects, every property required, optional ones nullable', () => {
    const s = schema.strict(SCHEMA);
    assert.equal(s.additionalProperties, false);
    assert.deepEqual(s.required, ['kind', 'title', 'amount', 'deadlines']);
    assert.deepEqual(s.properties.amount.type, ['number', 'null']);
    assert.deepEqual(s.properties.deadlines.type, ['array', 'null']);
    assert.deepEqual(s.properties.deadlines.items.properties.label.type, ['string', 'null']);
    assert.equal(s.properties.title.maxLength, undefined, 'only keywords every strict mode takes');
  });
});

// ─── install, update, policy ─────────────────────────────────────────────

describe('install dialog and policy', () => {
  it('the consent of the install allows the plugin; the plugin list of the page names it', async () => {
    assert.deepEqual(ai.policyOf(PID), { allowed: true, provider: null });
    assert.deepEqual(ai.policyOf(PLAIN), { allowed: false, provider: null });
    const r = await agent.get(`${AI}/plugins`).expect(200);
    assert.deepEqual(r.body.plugins.map((p) => p.id).sort(), [PID, TEXTONLY, AREAS].sort());
    const p = r.body.plugins.find((x) => x.id === PID);
    assert.equal(p.purpose, 'Recognise documents');
    assert.deepEqual(p.capabilities, ['text', 'vision']);
  });
  it('an update that adds permissions.ai asks for other permissions (no automatic update)', async () => {
    const updates = require('../src/services/plugins/updates');
    const r = await agent.post(API + '/inspect').set('X-CSRF-Token', csrf).set('Content-Type', 'application/octet-stream')
      .send(pkg(PLAIN, { version: '1.1.0', permissions: { ai: AI_PERM } })).expect(200);
    assert.ok(r.body.plugin.permissions.ai);
    assert.equal(r.body.existing.permissions.ai, null);
    assert.equal(updates.samePermissions(r.body), false);
  });
  it('the catalogue symbol "ai" exists in the server list and in the page', () => {
    const ui = require('../public/js/plugins-ui.js');
    assert.ok(ui.DETAIL_ICON_PATHS.ai);
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'plugins', 'catalog.js'), 'utf8');
    assert.match(src, /'cloud', 'ai'\]\)/);
    const perm = { ai: { purpose: 'Dokumente erkennen', capabilities: ['text', 'vision'] }, network: { internet: [], homeTargets: [] } };
    assert.ok(ui.sensitivePerms(perm).includes('plugins.perm.ai'));
    const rows = ui.permRows(perm, (k, p) => k + (p ? JSON.stringify(p) : ''));
    assert.ok(rows.some((x) => x.label === 'plugins.perm.ai' && x.value.includes('Dokumente erkennen')));
  });
  it('blocking: ERR_AI_DENIED; a plugin without the permission: ERR_AI_DENIED, available false', async () => {
    await put(`${AI}/plugins/${PID}`, { allowed: false }).expect(200);
    let r = await extract(PID);
    assert.equal(r.code, 'ERR_AI_DENIED');
    assert.equal((await gc(PID, 'ai.available')).result, false);
    await put(`${AI}/plugins/${PID}`, { allowed: true }).expect(200);
    r = await extract(PLAIN);
    assert.equal(r.code, 'ERR_AI_DENIED');
    assert.equal((await gc(PLAIN, 'ai.available')).result, false);
    assert.deepEqual((await gc(PLAIN, 'ai.status')).result, { available: false, mediaAllowed: false, capabilities: [], budgetLeftCents: null });
    await put(`${AI}/plugins/${PLAIN}`, { allowed: true }).expect(404);
    await put(`${AI}/plugins/${PID}`, { provider: 'grok' }).expect(400);
  });
});

// ─── admin API ───────────────────────────────────────────────────────────

describe('admin API', () => {
  it('nothing set up: available false, ERR_AI_NOT_CONFIGURED', async () => {
    const r = await agent.get(AI).expect(200);
    assert.equal(r.body.enabled, true);
    assert.deepEqual(r.body.providers.map((p) => p.id), ['openai', 'anthropic', 'gemini', 'openrouter']);
    assert.equal(r.body.mediaAllowed, false, 'pictures are off by default');
    assert.equal(r.body.budget.cents, 1000, '10 € by default');
    assert.equal((await gc(PID, 'ai.available')).result, false);
    assert.equal((await extract(PID)).code, 'ERR_AI_NOT_CONFIGURED');
    assert.equal(stub.calls.length, 0);
  });
  it('a test run never reaches a provider: without a stub the test ends before a connection', async () => {
    noStub();
    await put(`${AI}/providers/openai`, { key: KEYS.openai }).expect(200);
    const r = await post(`${AI}/providers/openai/test`).expect(200);
    assert.equal(r.body.ok, false);
    assert.equal(r.body.code, 'test_mode');
    useStub();
  });
  it('keys are write-only: only the last four characters come back; test fills the models', async () => {
    useStub();
    let r = await put(`${AI}/providers/openai`, { key: KEYS.openai }).expect(200);
    assert.equal(JSON.stringify(r.body).includes(KEYS.openai), false);
    assert.equal(r.body.provider.keyHint, 'CRET');
    assert.equal(r.body.provider.enabled, true, 'a new key switches the provider on');
    assert.equal(r.body.provider.configured, false, 'no model yet');
    r = await post(`${AI}/providers/openai/test`).expect(200);
    assert.deepEqual(r.body.models.map((m) => m.id), ['model-a', 'model-a-mini'], 'no embedding models');
    const call = stub.calls.find((c) => c.provider === 'openai');
    assert.equal(call.path, '/v1/models');
    assert.equal(call.headers.authorization, `Bearer ${KEYS.openai}`);
    r = await put(`${AI}/providers/openai`, { modelText: 'model-a' }).expect(200);
    assert.equal(r.body.provider.configured, true);
    r = await agent.get(AI).expect(200);
    assert.equal(JSON.stringify(r.body).includes(KEYS.openai), false);
    const row = require('../src/db/connection').getDb().prepare("SELECT key_encrypted FROM ai_providers WHERE id = 'openai'").get();
    assert.equal(row.key_encrypted.includes(KEYS.openai), false, 'stored encrypted');
    await put(`${AI}/providers/openai`, { key: 'short' }).expect(400);
    await put(`${AI}/providers/grok`, { key: KEYS.openai }).expect(404);
  });
  it('a rejected key: test answers auth, the message carries no key', async () => {
    stub.queue.anthropic.push({ status: 401, body: { error: { type: 'authentication_error', message: `invalid x-api-key ${KEYS.anthropic}` } } });
    await put(`${AI}/providers/anthropic`, { key: KEYS.anthropic }).expect(200);
    const r = await post(`${AI}/providers/anthropic/test`).expect(200);
    assert.equal(r.body.ok, false);
    assert.equal(r.body.code, 'auth');
    assert.equal(JSON.stringify(r.body).includes(KEYS.anthropic), false);
    const view = (await agent.get(AI).expect(200)).body.providers.find((p) => p.id === 'anthropic');
    assert.equal(view.checkError.includes(KEYS.anthropic), false);
    assert.match(view.checkError, /\[REDACTED\]/);
  });
  it('settings: validation, fallback ≠ default, activity log', async () => {
    await put(`${AI}/settings`, { defaultProvider: 'openai', fallbackProvider: 'openai' }).expect(400);
    // no property name from the input: only the four providers, never __proto__ / constructor / prototype
    for (const bad of ['{"__proto__": {"x": {"input": 1, "output": 1}}}', '{"openai": {"__proto__": {"input": 1, "output": 1}}}',
      '{"openai": {"constructor": {"input": 1, "output": 1}}}', '{"grok": {"m": {"input": 1, "output": 1}}}']) {
      await agent.put(`${AI}/settings`).set('X-CSRF-Token', csrf).set('Content-Type', 'application/json').send(`{"priceOverrides": ${bad}}`).expect(400);
    }
    assert.equal({}.input, undefined, 'Object.prototype untouched');
    await put(`${AI}/settings`, { budgetCents: 0 }).expect(400);
    await put(`${AI}/settings`, { priceOverrides: { openai: { 'model-a': { input: 'x' } } } }).expect(400);
    const r = await put(`${AI}/settings`, { defaultProvider: 'openai', budgetCents: 2000, eurPerUsd: 0.9, perHour: 120, priceOverrides: { openai: { 'model-a': { input: 1, output: 2 } } } }).expect(200);
    assert.equal(r.body.defaults.provider, 'openai');
    assert.equal(r.body.budget.cents, 2000);
    const act = require('../src/db/connection').getDb().prepare("SELECT message FROM activity_log WHERE event_type = 'ai_settings_changed' ORDER BY id DESC").get();
    assert.match(act.message, /budgetCents/);
  });
  it('API tokens and members get 403', async () => {
    const user = H.makeDevice(anna, { name: 'ai-anna-token', app: false, scopes: ['full-access'] });
    await supertest(app).get(AI).set('X-API-Token', user.raw).expect(403);
  });
});

// ─── host API over the IPC bridge ────────────────────────────────────────

describe('gc.ai: requests', () => {
  before(async () => {
    useStub();
    await setUpProvider('openai', 'model-a');
    await put(`${AI}/settings`, { defaultProvider: 'openai', fallbackProvider: null, mediaAllowed: false, budgetCents: 2000, eurPerUsd: 0.9, perHour: 120,
      priceOverrides: { openai: { 'model-a': { input: 1, output: 2 } } } }).expect(200);
  });

  it('available / status', async () => {
    assert.equal((await gc(PID, 'ai.available')).result, true);
    assert.equal((await gc(PID, 'ai.available', { capability: 'vision' })).result, false, 'pictures are switched off');
    assert.equal((await gc(PID, 'ai.available', { capability: 'audio' })).result, false, 'no sound in this version');
    const s = (await gc(PID, 'ai.status')).result;
    assert.equal(s.available, true);
    assert.equal(s.mediaAllowed, false);
    assert.deepEqual(s.capabilities, ['text']);
    assert.ok(s.budgetLeftCents > 0 && s.budgetLeftCents <= 2000);
    assert.equal((await gc(PID, 'ai.available', { capability: 'smell' })).code, 'ERR_INVALID');
    assert.equal(stub.calls.length, 0, 'asks no provider');
  });

  it('extract (OpenAI): strict JSON schema, data that fits, usage and cost, log row without content', async () => {
    const r = await extract(PID, { user: anna });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(r.result.data, GOOD);
    assert.equal(r.result.provider, 'openai');
    assert.equal(r.result.model, 'model-a');
    assert.equal(r.result.fallback, false);
    assert.equal(r.result.usage.inputTokens, 100);
    assert.equal(r.result.usage.outputTokens, 20);
    // (100 × 1 + 20 × 2) $ per million × 0.9 €/$ = 0.0126 ct
    assert.equal(r.result.usage.costCents, 0.01);
    const call = chatCalls()[0];
    assert.equal(call.path, '/v1/chat/completions');
    assert.equal(call.body.model, 'model-a');
    assert.equal(call.body.max_completion_tokens, 500);
    assert.equal(call.body.response_format.type, 'json_schema');
    assert.equal(call.body.response_format.json_schema.strict, true);
    assert.equal(call.body.messages[0].role, 'system');
    assert.match(call.body.messages[1].content[0].text, /^Text:\n/);
    const log = (await agent.get(`${AI}/requests?plugin=${PID}`).expect(200)).body.requests[0];
    assert.equal(log.outcome, 'ok');
    assert.equal(log.task, 'doc_insight');
    assert.equal(log.userId, anna);
    assert.equal(log.estimated, false);
    const row = require('../src/db/connection').getDb().prepare('SELECT * FROM ai_requests ORDER BY id DESC LIMIT 1').get();
    assert.equal(JSON.stringify(row).includes('Stromrechnung'), false, 'no content in the log');
  });

  it('generate: free text', async () => {
    stub.queue.openai.push({ answer: 'Kurz gesagt: eine Rechnung.' });
    const r = await gc(TEXTONLY, 'ai.generate', { task: 'summary', instructions: 'Summarise.', input: [{ type: 'text', text: 'lang' }] });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.result.text, '"Kurz gesagt: eine Rechnung."');
    assert.equal(chatCalls()[0].body.response_format, undefined);
    assert.equal((await gc(TEXTONLY, 'ai.generate', { task: 'summary', input: [{ type: 'text', text: 'x' }], schema: SCHEMA })).code, 'ERR_INVALID');
  });

  it('invalid arguments: ERR_INVALID before any provider', async () => {
    for (const o of [{ task: '' }, { task: 'has space' }, { input: [] }, { input: [{ type: 'file' }] }, { schema: { type: 'object', properties: { a: { type: 'string', format: 'date' } } } },
      { timeoutMs: 500 }, { timeoutMs: 200000 }, { maxOutputTokens: 0 }, { user: 999999 }, { input: [{ type: 'text', text: 'x'.repeat(200001) }] },
      { input: [{ type: 'media', mediaId: 'nope' }] }]) {
      assert.equal((await extract(PID, o)).code, 'ERR_INVALID', JSON.stringify(o).slice(0, 80));
    }
    assert.equal(stub.calls.length, 0);
  });

  it('a correction round with the errors; still wrong: ERR_AI_INVALID_OUTPUT', async () => {
    stub.queue.openai.push({ answer: { kind: 'bill', title: 'x' } }, { answer: GOOD });
    let r = await extract(PID);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(chatCalls().length, 2);
    const fix = chatCalls()[1].body.messages[1].content.at(-1).text;
    assert.match(fix, /\$\.kind: must be one of/);
    assert.equal(r.result.usage.inputTokens, 200, 'both calls counted');
    stub.calls.length = 0;
    stub.queue.openai.push({ answer: { kind: 'bill' } }, { answer: 'not json' });
    r = await extract(PID);
    assert.equal(r.code, 'ERR_AI_INVALID_OUTPUT');
    assert.equal(chatCalls().length, 2, 'exactly one correction round');
    const log = (await agent.get(`${AI}/requests?limit=1`).expect(200)).body.requests[0];
    assert.equal(log.outcome, 'ERR_AI_INVALID_OUTPUT');
    assert.equal(log.inputTokens, 200, 'a failed request is booked too');
  });

  it('pictures: switched off → ERR_AI_MEDIA_DISABLED before any provider; on → read and scaled by the host', async () => {
    const big = await sharp({ create: { width: 3000, height: 1500, channels: 3, background: { r: 10, g: 120, b: 200 } } }).png().toBuffer();
    const mediaId = (await supertest(app).put(`${CLIENT}/${PID}/media`).set('X-API-Token', annaDev.raw).set('Content-Type', 'image/png').send(big).expect(200)).body.mediaId;
    const input = [{ type: 'text', text: 'Scan' }, { type: 'media', mediaId }];
    let r = await extract(PID, { input });
    assert.equal(r.code, 'ERR_AI_MEDIA_DISABLED');
    assert.equal(stub.calls.length, 0, 'no provider saw anything');
    await put(`${AI}/settings`, { mediaAllowed: true }).expect(200);
    assert.equal((await gc(PID, 'ai.available', { capability: 'vision' })).result, true);
    r = await extract(PID, { input });
    assert.equal(r.ok, true, JSON.stringify(r));
    const img = chatCalls()[0].body.messages[1].content[1];
    assert.equal(img.type, 'image_url');
    assert.match(img.image_url.url, /^data:image\/jpeg;base64,/);
    const meta = await sharp(Buffer.from(img.image_url.url.split(',')[1], 'base64')).metadata();
    assert.deepEqual([meta.format, meta.width, meta.height], ['jpeg', 2048, 1024]);
    // a text-only plugin may not send pictures
    assert.equal((await extract(TEXTONLY, { input })).code, 'ERR_AI_DENIED');
    // sound is not supported yet
    const ogg = (await supertest(app).put(`${CLIENT}/${PID}/media`).set('X-API-Token', annaDev.raw).set('Content-Type', 'audio/ogg').send(Buffer.from('OggS fake sound data')).expect(200)).body.mediaId;
    assert.equal((await extract(PID, { input: [{ type: 'media', mediaId: ogg }] })).code, 'ERR_AI_CAPABILITY');
    await put(`${AI}/settings`, { mediaAllowed: false }).expect(200);
  });

  it('rate limit per plugin and hour', async () => {
    await put(`${AI}/settings`, { perHour: 2 }).expect(200);
    assert.equal((await extract(PID)).ok, true);
    assert.equal((await extract(PID)).ok, true);
    assert.equal((await extract(PID)).code, 'ERR_RATE_LIMIT');
    assert.equal((await extract(TEXTONLY, { input: [{ type: 'text', text: 'x' }] })).ok, true, 'per plugin');
    assert.equal(chatCalls().length, 3);
    await put(`${AI}/settings`, { perHour: 120 }).expect(200);
  });

  it('budget: the reservation does not fit → ERR_AI_BUDGET, no provider; the admins hear of it once', async () => {
    await put(`${AI}/settings`, { budgetCents: 1, priceOverrides: {} }).expect(200);
    let r = await extract(PID);
    assert.equal(r.code, 'ERR_AI_BUDGET');
    r = await extract(PID);
    assert.equal(r.code, 'ERR_AI_BUDGET');
    assert.equal(stub.calls.length, 0);
    const db = require('../src/db/connection').getDb();
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM activity_log WHERE event_type = 'ai_budget_reached'").get().n, 1, 'once a month');
    await put(`${AI}/settings`, { budgetCents: 2000, priceOverrides: { openai: { 'model-a': { input: 1, output: 2 } } } }).expect(200);
    const n = require('../src/services/notifications');
    assert.ok(n.CATALOGUE.flatMap((g) => g.events).some((e) => e.id === 'ai_budget' && e.types.includes('ai_budget_reached')));
  });

  it('without a price the cost is estimated with the provider default and marked', async () => {
    await put(`${AI}/settings`, { priceOverrides: {} }).expect(200);
    const r = await extract(PID);
    assert.equal(r.ok, true);
    // (100 × 15 + 20 × 60) $ per million × 0.9 = 0.243 ct
    assert.equal(r.result.usage.costCents, 0.24);
    const log = (await agent.get(`${AI}/requests?limit=1`).expect(200)).body.requests[0];
    assert.equal(log.estimated, true);
    await put(`${AI}/settings`, { priceOverrides: { openai: { 'model-a': { input: 1, output: 2 } } } }).expect(200);
  });
});

describe('gc.ai: providers, routing and fallback', () => {
  before(async () => {
    useStub();
    await setUpProvider('anthropic', 'model-b');
    await setUpProvider('gemini', 'model-g');
    await setUpProvider('openrouter', 'vendor/model-r');
  });

  it('Anthropic: a forced tool with the schema; x-api-key header', async () => {
    await put(`${AI}/settings`, { defaultProvider: 'anthropic', fallbackProvider: null }).expect(200);
    const r = await extract(PID);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.result.provider, 'anthropic');
    assert.deepEqual(r.result.data, GOOD);
    const call = chatCalls()[0];
    assert.equal(call.path, '/v1/messages');
    assert.equal(call.headers['x-api-key'], KEYS.anthropic);
    assert.equal(call.headers['anthropic-version'], '2023-06-01');
    assert.deepEqual(call.body.tool_choice, { type: 'tool', name: 'result' });
    assert.deepEqual(call.body.tools[0].input_schema.properties.amount.type, ['number', 'null']);
    assert.equal(call.body.system, 'Read the document.');
  });

  it('Gemini: response schema, key in a header (never in the address)', async () => {
    await put(`${AI}/settings`, { defaultProvider: 'gemini' }).expect(200);
    const r = await extract(PID);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.result.provider, 'gemini');
    const call = chatCalls()[0];
    assert.equal(call.path, '/v1beta/models/model-g:generateContent');
    assert.equal(call.headers['x-goog-api-key'], KEYS.gemini);
    assert.equal(call.body.generationConfig.responseMimeType, 'application/json');
    assert.equal(call.body.generationConfig.responseSchema.type, 'OBJECT');
    assert.equal(call.body.generationConfig.responseSchema.properties.amount.nullable, true);
  });

  it('OpenRouter: the cost comes with the answer; capabilities from its model list', async () => {
    await put(`${AI}/settings`, { defaultProvider: 'openrouter' }).expect(200);
    const view = (await agent.get(AI).expect(200)).body.providers.find((p) => p.id === 'openrouter');
    assert.deepEqual(view.capabilities, ['text', 'vision']);
    const r = await extract(PID);
    assert.equal(r.ok, true, JSON.stringify(r));
    // 0.0012 $ × 0.9 = 0.108 ct
    assert.equal(r.result.usage.costCents, 0.11);
    const call = chatCalls()[0];
    assert.equal(call.path, '/api/v1/chat/completions');
    assert.deepEqual(call.body.usage, { include: true });
    assert.equal(call.body.response_format.json_schema.strict, true);
    // a model without structured outputs gets the schema in the instructions
    await put(`${AI}/providers/openrouter`, { modelText: 'vendor/model-t' }).expect(200);
    stub.calls.length = 0;
    assert.equal((await extract(PID)).ok, true);
    const c2 = chatCalls()[0];
    assert.equal(c2.body.response_format, undefined);
    assert.match(c2.body.messages[0].content, /matching this JSON schema/);
    await put(`${AI}/providers/openrouter`, { modelText: 'vendor/model-r' }).expect(200);
  });

  it('fallback on 5xx / 429 / timeout — exactly one try; never on 401', async () => {
    await put(`${AI}/settings`, { defaultProvider: 'openai', fallbackProvider: 'anthropic' }).expect(200);
    stub.queue.openai.push({ status: 503 });
    let r = await extract(PID);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.result.provider, 'anthropic');
    assert.equal(r.result.fallback, true);
    assert.deepEqual(chatCalls().map((c) => c.provider), ['openai', 'anthropic']);
    stub.calls.length = 0;
    stub.queue.openai.push({ status: 429 });
    stub.queue.anthropic.push({ status: 500 });
    r = await extract(PID);
    assert.equal(r.code, 'ERR_AI_PROVIDER');
    assert.deepEqual(chatCalls().map((c) => c.provider), ['openai', 'anthropic'], 'one try at the fallback only');
    stub.calls.length = 0;
    stub.queue.openai.push({ status: 401, body: { error: { message: `Incorrect API key provided: ${KEYS.openai}` } } });
    r = await extract(PID);
    assert.equal(r.code, 'ERR_AI_PROVIDER');
    assert.equal(r.error.includes(KEYS.openai), false, 'no key in the message');
    assert.deepEqual(chatCalls().map((c) => c.provider), ['openai'], 'no fallback on 401');
    stub.calls.length = 0;
    stub.queue.openai.push({ delayMs: 1500 });
    r = await extract(PID, { timeoutMs: 1000 });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.result.fallback, true);
    await put(`${AI}/settings`, { fallbackProvider: null }).expect(200);
    stub.calls.length = 0;
    stub.queue.openai.push({ delayMs: 1500 });
    r = await extract(PID, { timeoutMs: 1000 });
    assert.equal(r.code, 'ERR_TIMEOUT');
  });

  it('routing: default provider without pictures → the next one that can; fixed provider → no routing', async () => {
    await put(`${AI}/settings`, { defaultProvider: 'openrouter', mediaAllowed: true }).expect(200);
    await put(`${AI}/providers/openrouter`, { modelText: 'vendor/model-t' }).expect(200); // text only
    const png = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#fff' } }).png().toBuffer();
    const mediaId = (await supertest(app).put(`${CLIENT}/${PID}/media`).set('X-API-Token', annaDev.raw).set('Content-Type', 'image/png').send(png).expect(200)).body.mediaId;
    const input = [{ type: 'media', mediaId }];
    let r = await extract(PID, { input });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.notEqual(r.result.provider, 'openrouter');
    await put(`${AI}/plugins/${PID}`, { provider: 'openrouter' }).expect(200);
    r = await extract(PID, { input });
    assert.equal(r.code, 'ERR_AI_CAPABILITY');
    r = await extract(PID);
    assert.equal(r.result.provider, 'openrouter', 'text goes to the fixed provider');
    await put(`${AI}/plugins/${PID}`, { provider: null }).expect(200);
    await put(`${AI}/providers/openrouter`, { modelText: 'vendor/model-r' }).expect(200);
    await put(`${AI}/settings`, { mediaAllowed: false, defaultProvider: 'openai' }).expect(200);
  });

  it('GC_AI=off: nothing offered, no provider', async () => {
    process.env.GC_AI = 'off';
    try {
      assert.equal((await gc(PID, 'ai.available')).result, false);
      assert.equal((await gc(PID, 'ai.status')).result.available, false);
      assert.equal((await extract(PID)).code, 'ERR_AI_NOT_CONFIGURED');
      assert.equal((await agent.get(AI).expect(200)).body.enabled, false);
      assert.equal((await post(`${AI}/providers/openai/test`).expect(200)).body.code, 'ai_disabled');
      assert.equal(stub.calls.length, 0);
    } finally { delete process.env.GC_AI; }
  });

  it('usage of the month by plugin and provider', async () => {
    const r = await agent.get(`${AI}/usage`).expect(200);
    assert.ok(r.body.usage.requests > 5);
    assert.ok(r.body.usage.byPlugin.some((x) => x.plugin === PID));
    assert.ok(r.body.usage.byProvider.some((x) => x.provider === 'anthropic'));
    assert.ok(r.body.usage.byDay.length >= 1);
  });
});

describe('gc.ai as GateControl Drive uses it', () => {
  let fileId, otherId;
  before(async () => {
    useStub();
    await put(`${AI}/settings`, { defaultProvider: 'openai', fallbackProvider: null, mediaAllowed: true, perHour: 120, budgetCents: 2000 }).expect(200);
    const png = await sharp({ create: { width: 900, height: 600, channels: 3, background: { r: 240, g: 240, b: 230 } } }).png().toBuffer();
    assert.equal((await gc(AREAS, 'media.areas.ensure', 'docs', { label: 'Dokumente' })).ok, true);
    fileId = (await supertest(app).put(`${CLIENT}/${AREAS}/media`).set('X-API-Token', annaDev.raw).set('Content-Type', 'image/png').send(png).expect(200)).body.mediaId;
    const claimed = await gc(AREAS, 'media.claim', fileId, { area: 'docs', path: 'Scans/rechnung.png' });
    assert.equal(claimed.ok, true, JSON.stringify(claimed));
    otherId = (await supertest(app).put(`${CLIENT}/${PID}/media`).set('X-API-Token', annaDev.raw).set('Content-Type', 'image/png').send(png).expect(200)).body.mediaId;
  });
  after(async () => { await put(`${AI}/settings`, { mediaAllowed: false }).expect(200); });

  it('available() without argument is a boolean and never throws — with or without the permission', async () => {
    for (const id of [AREAS, PLAIN]) {
      const r = await gc(id, 'ai.available');
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(typeof r.result, 'boolean');
    }
    const s = (await gc(AREAS, 'ai.status')).result;
    for (const k of ['available', 'mediaAllowed', 'capabilities', 'budgetLeftCents']) assert.ok(k in s, k);
  });

  it('extract with a claimed file of a media area: the host reads it', async () => {
    const r = await gc(AREAS, 'ai.extract', { task: 'drive_document', user: anna, instructions: 'Classify the document.',
      input: [{ type: 'text', label: 'Text', text: 'Rechnung' }, { type: 'media', mediaId: fileId }], schema: SCHEMA, maxOutputTokens: 800, timeoutMs: 45000 });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(r.result.data, GOOD);
    const img = chatCalls()[0].body.messages[1].content[1];
    assert.match(img.image_url.url, /^data:image\/jpeg;base64,/);
    const meta = await sharp(Buffer.from(img.image_url.url.split(',')[1], 'base64')).metadata();
    assert.deepEqual([meta.width, meta.height], [900, 600]);
  });

  it('only its own media: a file of another plugin is an unknown mediaId', async () => {
    stub.calls.length = 0;
    let r = await gc(AREAS, 'ai.extract', { task: 'drive_document', input: [{ type: 'media', mediaId: otherId }], schema: SCHEMA });
    assert.equal(r.code, 'ERR_INVALID');
    r = await gc(PID, 'ai.extract', { task: 'drive_document', input: [{ type: 'media', mediaId: fileId }], schema: SCHEMA });
    assert.equal(r.code, 'ERR_INVALID');
    assert.equal(chatCalls().length, 0);
  });

  it('the error codes Drive relies on are named exactly so', async () => {
    assert.equal((await gc(PLAIN, 'ai.extract', { task: 'drive_document', input: [{ type: 'text', text: 'x' }], schema: SCHEMA })).code, 'ERR_AI_DENIED');
    await put(`${AI}/settings`, { perHour: 1 }).expect(200);
    const ask = () => gc(AREAS, 'ai.extract', { task: 'drive_document', input: [{ type: 'text', text: 'x' }], schema: SCHEMA });
    assert.equal((await ask()).ok, true);
    assert.equal((await ask()).code, 'ERR_RATE_LIMIT');
    await put(`${AI}/settings`, { perHour: 120 }).expect(200);
    ai._resetForTest();
    await put(`${AI}/plugins/${AREAS}`, { provider: 'gemini' }).expect(200);
    await put(`${AI}/providers/gemini`, { enabled: false }).expect(200);
    assert.equal((await ask()).code, 'ERR_AI_NOT_CONFIGURED');
    await put(`${AI}/providers/gemini`, { enabled: true }).expect(200);
    await put(`${AI}/plugins/${AREAS}`, { provider: null }).expect(200);
  });
});

describe('no key anywhere', () => {
  it('not in the log rows, not in the activity log, not in plugin answers', async () => {
    const db = require('../src/db/connection').getDb();
    const dump = JSON.stringify(db.prepare('SELECT * FROM ai_requests').all()) + JSON.stringify(db.prepare('SELECT message, details FROM activity_log').all());
    for (const k of Object.values(KEYS)) assert.equal(dump.includes(k), false, k);
    const r = await extract(PID);
    for (const k of Object.values(KEYS)) assert.equal(JSON.stringify(r).includes(k), false);
  });
  it('the logger redacts the provider key headers', () => {
    const paths = logger.REDACT_PATHS;
    for (const h of ['headers.authorization', 'headers["x-api-key"]', 'headers["x-goog-api-key"]', '*.headers.authorization']) assert.ok(paths.includes(h), h);
  });
  it('the log goes after 90 days', () => {
    const db = require('../src/db/connection').getDb();
    db.prepare("INSERT INTO ai_requests (at, plugin_id, kind, outcome) VALUES (?, 'old', 'extract', 'ok')").run(Date.now() - 91 * 86400000);
    assert.ok(ai.prune() >= 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ai_requests WHERE plugin_id = 'old'").get().n, 0);
  });
  it('backup: providers with encrypted keys and the policy, restored', () => {
    const b = ai.exportBackup();
    assert.ok(b.providers.length >= 4);
    assert.equal(JSON.stringify(b).includes(KEYS.openai), false);
    ai.restoreBackup(b);
    assert.equal(ai.providerView('openai').keyState, 'ok');
    assert.equal(ai.policyOf(PID).allowed, true);
    // a key of another server key reads "enter the key again"
    ai.restoreBackup({ providers: [{ ...b.providers.find((p) => p.id === 'openai'), key_encrypted: 'aa:bb:cc' }], policy: b.policy });
    assert.equal(ai.providerView('openai').keyState, 'invalid');
    assert.equal(ai.providerView('openai').configured, false);
    ai.restoreBackup(b);
  });
  it('uninstalling forgets the consent', async () => {
    await agent.post(`${API}/${TEXTONLY}/uninstall`).set('X-CSRF-Token', csrf).send({ mode: 'keep' }).expect(200);
    const left = require('../src/db/connection').getDb().prepare('SELECT COUNT(*) AS n FROM ai_plugin_policy WHERE plugin_id = ?').get(TEXTONLY).n;
    assert.equal(left, 0);
  });
});

describe('settings page KI-Anbieter', () => {
  const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
  const de = JSON.parse(read('src', 'i18n', 'de.json'));
  const en = JSON.parse(read('src', 'i18n', 'en.json'));
  it('a section of the settings page with its own script, strings in both languages', () => {
    const tpl = read('templates', 'aurora', 'pages', 'settings.njk');
    assert.match(tpl, /<section class="st-section" data-section="ki"/);
    assert.match(tpl, /settings-ai\.js/);
    assert.match(tpl, /data-prefixes="[^"]*\bai\."/);
    const js = read('public', 'js', 'settings-ai.js');
    const partial = read('templates', 'aurora', 'partials', 'settings-ai.njk');
    const keys = new Set([...(js + partial + tpl).matchAll(/t\('((?:ai|st\.(?:nav|desc|kw))\.[a-z0-9_.]+)'/g)].map((m) => m[1]));
    for (const m of js.matchAll(/'(ai\.[a-z0-9_.]+)'/g)) if (!m[1].endsWith('.') && m[1] !== 'ai.usage.requests') keys.add(m[1]);
    for (const c of ['text', 'vision', 'audio', 'video']) { keys.add('ai.cap.' + c); keys.add('plugins.perm.ai_cap.' + c); }
    for (const k of ['ai.usage.requests_one', 'ai.usage.requests_other', 'plugins.perm.ai', 'plugins.perm.ai_v', 'st.event.ai_budget', 'push.type.ai_budget_warning', 'push.type.ai_budget_reached']) keys.add(k);
    assert.ok(keys.size > 60, String(keys.size));
    for (const k of keys) if (!k.endsWith('.')) assert.ok(de[k] && en[k], k);
    assert.equal(/innerHTML\s*=|insertAdjacentHTML/.test(js), false, 'DOM only through GCDialog.el / textContent');
  });
  it('the page never gets a key back (API view)', async () => {
    const r = await agent.get(AI).expect(200);
    for (const k of Object.values(KEYS)) assert.equal(JSON.stringify(r.body).includes(k), false);
  });
});

