'use strict';

// The local AI (phase 3c, step 3 — the gateway's docs/local-ai.md): a model in
// the home network instead of the cloud. Either the service `ki` (Ollama) on
// a gateway — GateControl downloads and starts the model — or an existing AI
// server in the home network (Ollama or an OpenAI-compatible one such as LM
// Studio) that a gateway in the same network forwards to. Documents and mails
// stay at home, nothing costs money; it is slower and can do less than the
// big cloud models (text only — a picture still needs the cloud).
//
//   provider        ai_providers row 'local' (enabled, model_text) — the fifth
//                   provider next to the four cloud ones (services/ai/index.js)
//   which gateway   setting ai.local_peer
//   what for        setting ai.local_use: all | private | fallback (routing in index.js)
//   per gateway     gateway_features.settings.ai { enabled, source, lanUrl, lanApi }
//                   → features.ai of the config pull
//   live            management calls /api/ai/status, /pull, /pull/cancel, /delete
//                   and the streamed /api/ai/chat (gateways.mgmtStream)
//
// The server never connects to the LAN server itself: it only stores the
// address (a private IPv4 address and a port, checked here and again by the
// gateway) — the gateway connects to exactly that one, nothing else.

const { getDb } = require('../../db/connection');
const logger = require('../../utils/logger');
const { isPrivateIpv4 } = require('../../utils/validate');
const http = require('./providers/http');

const ID = 'local';
const NAME = 'Lokale KI';
const MIN_GATEWAY = '1.26.0';
const USES = Object.freeze(['all', 'private', 'fallback']);
const USE_DEFAULT = 'all';
const SOURCES = Object.freeze(['service', 'lan']);
const APIS = Object.freeze(['ollama', 'openai']);
// the plugins whose requests are private content (documents, mails) — the
// mode "Nur für private Inhalte" keeps their text requests at home
const PRIVATE_PLUGINS = Object.freeze(['gatecontrol-drive', 'gatecontrol-mail']);
const MODEL_RE = /^[a-z0-9][a-z0-9._-]{0,63}(\/[a-z0-9][a-z0-9._-]{0,63})?(:[A-Za-z0-9._-]{1,64})?$/;
// an OpenAI-compatible server names its models freely (LM Studio: "qwen2.5-7b-instruct", "lmstudio-community/…")
const LAN_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;
const K = Object.freeze({ peer: 'ai.local_peer', use: 'ai.local_use' });

// What the gateway hears: the time limits of a local answer (CPU inference is
// slow — minutes, not seconds), the context of the model and the answer length.
const LIMITS = Object.freeze({
  minTimeoutMs: 5 * 60 * 1000,
  maxTimeoutMs: 15 * 60 * 1000,
  idleMs: 120 * 1000,
  ctxMin: 4096,
  ctxMax: 16384,
  outputMax: 4096,
  charsPerToken: 3,
  answerBytes: 256 * 1024,
});

// The models GateControl offers for a gateway (Ollama tags). downloadMb as
// listed by Ollama, ramMb ≈ the model in memory with an 8k context; params in
// billions — with the cores of the gateway it says how slow it gets without a GPU.
const CATALOGUE = Object.freeze([
  Object.freeze({ id: 'llama3.2:1b', name: 'Llama 3.2 1B', params: 1.2, downloadMb: 1300, ramMb: 1900 }),
  Object.freeze({ id: 'llama3.2:3b', name: 'Llama 3.2 3B', params: 3.2, downloadMb: 2000, ramMb: 2500 }),
  Object.freeze({ id: 'qwen2.5:7b', name: 'Qwen 2.5 7B', params: 7.6, downloadMb: 4700, ramMb: 5500 }),
  Object.freeze({ id: 'gemma2:9b', name: 'Gemma 2 9B', params: 9.2, downloadMb: 5400, ramMb: 6800 }),
]);
const RESERVE_MB = 1024;          // operating system + Docker
const SERVICE_MB = 60;            // Ollama without a model
const MEM_SMALLEST = CATALOGUE[0].ramMb;

class LocalError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

function db() { return getDb(); }
function settings() { return require('../settings'); }
function activity() { return require('../activity'); }
function features() { return require('../gatewayFeatures'); }
function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

/** Text without control characters, trimmed, at most n characters ('' for a non-string). */
function clean(v, n) {
  if (typeof v !== 'string') return '';
  let out = '';
  for (const ch of v) { const c = ch.codePointAt(0); out += c < 32 || c === 127 ? ' ' : ch; }
  return out.trim().replace(/\s+/g, ' ').slice(0, n);
}
const num = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : 0);
function isoOrNull(v) {
  if (typeof v !== 'string' || v.length > 40) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

const validModel = (m) => typeof m === 'string' && MODEL_RE.test(m);
const validLanModel = (m) => typeof m === 'string' && LAN_MODEL_RE.test(m);

/**
 * The base URL of an AI server in the home network → 'http://192.168.1.20:11434' or null.
 * Only http/https, the host only as a private IPv4 address (RFC 1918), a port,
 * no path (but '/v1'), no credentials — as the gateway checks it.
 */
function lanUrl(raw) {
  if (typeof raw !== 'string' || raw.length > 200) return null;
  let u;
  try { u = new URL(raw.trim()); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password || u.search || u.hash) return null;
  if (!['', '/', '/v1', '/v1/'].includes(u.pathname)) return null;
  if (!isPrivateIpv4(u.hostname)) return null;
  const port = u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80);
  return `${u.protocol}//${u.hostname}:${port}`;
}

// ─── Settings of a gateway (part of its features) ──────────────────────

/** gateway_features.settings.ai (any shape) → { enabled, source, lanUrl, lanApi } */
function normalizeSettings(raw) {
  const r = isObj(raw) ? raw : {};
  return {
    enabled: r.enabled === true,
    source: SOURCES.includes(r.source) ? r.source : 'service',
    lanUrl: lanUrl(r.lanUrl),
    lanApi: APIS.includes(r.lanApi) ? r.lanApi : 'ollama',
  };
}

/** A change of the admin API (gatewayFeatures.applyPatch): field → checked value; throws { code, message }. */
function patchField(f, val) {
  if (f === 'enabled') {
    if (typeof val !== 'boolean') throw new LocalError('invalid', 'ai.enabled: must be true or false');
    return val;
  }
  if (f === 'source') {
    if (!SOURCES.includes(val)) throw new LocalError('invalid', 'ai.source: service or lan');
    return val;
  }
  if (f === 'lanApi') {
    if (!APIS.includes(val)) throw new LocalError('invalid', 'ai.lanApi: ollama or openai');
    return val;
  }
  if (f === 'lanUrl') {
    if (val === null || val === '') return null;
    const u = lanUrl(val);
    if (!u) throw new LocalError('invalid_host', 'ai.lanUrl: http(s)://<private IPv4 address>:<port>');
    return u;
  }
  throw new LocalError('invalid', `ai.${f}: unknown`);
}

function settingsOf(peerId) { return features().get(peerId).ai; }

/** features.ai of the config pull */
function configPayload(peerId) {
  const s = settingsOf(peerId);
  const lan = s.source === 'lan' && s.lanUrl ? { url: s.lanUrl, api: s.lanApi } : null;
  return { enabled: s.enabled && (s.source === 'service' || !!lan), source: s.source, lan };
}

// ─── Telemetry (features.ai of the heartbeat, input of the gateway) ────

const STATES = ['off', 'service_missing', 'starting', 'running', 'unreachable', 'error'];
const SERVICES = ['managed', 'absent', 'missing'];
const PULL_STATES = ['pulling', 'done', 'error', 'cancelled'];

function cleanModels(list, max) {
  return (Array.isArray(list) ? list : []).slice(0, max).filter((m) => isObj(m) && typeof m.name === 'string' && LAN_MODEL_RE.test(m.name.slice(0, 200)))
    .map((m) => ({
      name: m.name.slice(0, 200), size: num(m.size),
      ...(m.params !== undefined ? { params: clean(m.params, 16) || null, quant: clean(m.quant, 16) || null, family: clean(m.family, 32) || null } : {}),
      ...(m.vram !== undefined ? { vram: num(m.vram) } : {}),
    }));
}

/** telemetry.features.ai (or the answer of /api/ai/status), checked and cut → the view or null. */
function telemetryAi(tel, { maxModels = 12 } = {}) {
  const a = tel && tel.features && tel.features.ai;
  if (!isObj(a)) return null;
  const h = isObj(a.host) ? a.host : {};
  const p = isObj(a.pull) ? a.pull : null;
  const lan = isObj(a.lan) ? a.lan : null;
  const err = isObj(a.error) ? a.error : null;
  return {
    enabled: a.enabled === true,
    source: a.source === 'lan' ? 'lan' : 'service',
    service: SERVICES.includes(a.service) ? a.service : 'missing',
    state: STATES.includes(a.state) ? a.state : 'off',
    version: typeof a.version === 'string' && /^[0-9A-Za-z.+-]{1,32}$/.test(a.version) ? a.version : null,
    models: cleanModels(a.models, maxModels),
    loaded: cleanModels(a.loaded, 2),
    pull: p && validLanModel(p.model) ? {
      model: p.model, state: PULL_STATES.includes(p.state) ? p.state : 'error', completed: num(p.completed), total: num(p.total),
      error: isObj(p.error) ? { code: clean(p.error.code, 32) || 'error', message: clean(p.error.message, 160) } : null,
    } : null,
    host: {
      memTotal: num(h.memTotal) || null, cores: Number.isInteger(h.cores) && h.cores > 0 && h.cores < 1024 ? h.cores : null,
      arch: typeof h.arch === 'string' && /^[a-z0-9_]{1,16}$/.test(h.arch) ? h.arch : null,
      gpu: (Array.isArray(h.gpu) ? h.gpu : []).slice(0, 4).filter(isObj).map((g) => ({ vendor: ['nvidia', 'amd', 'intel'].includes(g.vendor) ? g.vendor : 'other' })),
    },
    lan: lan ? { url: lanUrl(lan.url), api: APIS.includes(lan.api) ? lan.api : 'ollama', reachable: lan.reachable === true } : null,
    error: err ? { code: clean(err.code, 32) || 'error', message: clean(err.message, 160) || null } : null,
  };
}

function supported(tel) {
  return !!(tel && Array.isArray(tel.capabilities) && tel.capabilities.includes('ai'));
}

/** What a gateway offers a model: memory (MB), cores, arch, GPUs — the gateway's own report, else the telemetry. */
function factsOf(tel) {
  const t = telemetryAi(tel);
  const hw = tel && isObj(tel.hardware) ? tel.hardware : {};
  const mem = (t && t.host.memTotal) || num(hw.mem_total) || num(tel && tel.mem_total);
  const cores = (t && t.host.cores) || (Number.isInteger(hw.cpu_cores) ? hw.cpu_cores : (Number.isInteger(tel && tel.cpu_cores) ? tel.cpu_cores : null));
  const arch = (t && t.host.arch) || (typeof hw.arch === 'string' ? hw.arch : (tel && typeof tel.arch === 'string' ? tel.arch : null));
  return { memMb: mem ? Math.round(mem / 1048576) : null, cores, arch, gpu: t ? t.host.gpu : [] };
}

// ─── Model fit (hints, never a ban) ────────────────────────────────────

/**
 * How well a model of the catalogue suits a gateway:
 *   not_recommended  more memory than is free (reason memory) or too slow
 *                    without a GPU for the cores (reason slow)
 *   recommended      the best one that is fast enough (exactly one)
 *   fits             the rest
 * otherMb: what the other features of the gateway need.
 */
function fitList(facts, otherMb = 0) {
  const free = facts.memMb ? facts.memMb - RESERVE_MB - otherMb : null;
  const cores = facts.cores || 2;
  const gpu = (facts.gpu || []).length > 0;
  const arm = facts.arch === 'arm64' || facts.arch === 'arm';
  // billions of parameters per core still OK without a GPU (ARM boards are slower per core)
  const quick = arm ? 0.35 : 0.85;
  const slow = arm ? 0.9 : 2.0;
  const rows = CATALOGUE.map((m) => {
    const ratio = m.params / cores;
    let fit = 'fits';
    let reason = null;
    if (free !== null && m.ramMb > free) { fit = 'not_recommended'; reason = 'memory'; } else if (!gpu && ratio > slow) { fit = 'not_recommended'; reason = 'slow'; }
    return { ...m, fit, reason, quick: gpu || ratio <= quick };
  });
  const able = rows.filter((r) => r.fit === 'fits');
  const best = able.filter((r) => r.quick).pop() || able[0] || null;
  if (best) best.fit = 'recommended';
  return rows.map(({ quick, ...r }) => r);
}

/** A hint for the gateway choice: null | 'memory' (too little for any model — a server in the home network helps). */
function gatewayHint(facts, otherMb = 0) {
  if (!facts.memMb) return null;
  return facts.memMb - RESERVE_MB - otherMb < MEM_SMALLEST ? 'memory' : null;
}

function catalogueEntry(model) { return CATALOGUE.find((m) => m.id === model) || null; }

// ─── Provider configuration ────────────────────────────────────────────

function providerRow() {
  return db().prepare('SELECT * FROM ai_providers WHERE id = ?').get(ID) || null;
}

function peerId() {
  const n = Number(settings().get(K.peer, null));
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function use() {
  const u = settings().get(K.use, USE_DEFAULT);
  return USES.includes(u) ? u : USE_DEFAULT;
}

function gatewayOf(id) {
  const g = id ? features().gatewayPeer(id) : null;
  return g || null;
}

/**
 * The local provider when it can take requests (switched on, a model, its
 * gateway with the function switched on and the capability) — else null.
 * Whether the gateway is online is found out by the request (it fails fast).
 */
function ready() {
  const row = providerRow();
  if (!row || !row.enabled || !row.model_text) return null;
  const id = peerId();
  const g = gatewayOf(id);
  if (!g) return null;
  const s = settingsOf(g.id);
  if (!s.enabled || (s.source === 'lan' && !s.lanUrl)) return null;
  if (!supported(features().telemetryOf(g))) return null;
  return { id: ID, row, caps: ['text'], peerId: g.id };
}

function aliveOf(id) {
  try { const r = db().prepare('SELECT alive FROM gateway_meta WHERE peer_id = ?').get(id); return !!(r && r.alive === 1); } catch { return false; }
}

/** The provider row of the admin view (GET /api/v1/ai). */
function providerView() {
  const row = providerRow();
  const id = peerId();
  const g = gatewayOf(id);
  const tel = g ? features().telemetryOf(g) : null;
  const t = telemetryAi(tel);
  const s = g ? settingsOf(g.id) : null;
  return {
    id: ID,
    name: NAME,
    local: true,
    enabled: !!(row && row.enabled),
    configured: !!ready(),
    keySet: false,
    keyState: 'none',
    keyHint: null,
    modelText: row ? row.model_text || null : null,
    modelAudio: null,
    capabilities: ['text'],
    checkedAt: null,
    checkError: null,
    models: null,
    use: use(),
    gateway: g ? {
      id: g.id, name: g.name, online: aliveOf(g.id), supported: supported(tel), source: s.source,
      enabled: s.enabled, lanUrl: s.lanUrl, lanApi: s.lanApi, state: t ? t.state : null,
    } : null,
  };
}

// ─── Gateways for the setup ────────────────────────────────────────────

function otherFeaturesMb(id, tel) {
  try {
    const m = features().memoryEstimate(id, features().get(id), tel);
    return m.parts.filter((p) => p.key !== 'ai').reduce((a, p) => a + p.mb, 0);
  } catch { return 0; }
}

/** Every gateway with what it offers a model, its state and a hint. */
function gateways() {
  const rows = db().prepare(`SELECT p.id FROM peers p JOIN gateway_meta gm ON gm.peer_id = p.id
    WHERE p.peer_type = 'gateway' AND p.enabled = 1 ORDER BY p.name COLLATE NOCASE`).all();
  const chosen = peerId();
  return rows.map((r) => {
    const g = features().gatewayPeer(r.id);
    if (!g) return null;
    const tel = features().telemetryOf(g);
    const facts = factsOf(tel);
    const other = otherFeaturesMb(g.id, tel);
    const t = telemetryAi(tel);
    return {
      id: g.id, name: g.name, online: aliveOf(g.id), supported: supported(tel),
      version: typeof tel.gateway_version === 'string' ? tel.gateway_version : null,
      memMb: facts.memMb, cores: facts.cores, arch: facts.arch, gpu: facts.gpu,
      otherMb: other, hint: gatewayHint(facts, other), chosen: g.id === chosen, platform: require('../homeRadio').platformOf(g.id, tel),
      settings: settingsOf(g.id), state: t ? t.state : null,
    };
  }).filter(Boolean);
}

// ─── Management calls (server → gateway) ───────────────────────────────

function gw() { return require('../gateways'); }

function needGateway(id) {
  const g = gatewayOf(id);
  if (!g) throw new LocalError('not_found', 'gateway not found');
  if (!supported(features().telemetryOf(g))) throw new LocalError('gateway_unsupported', 'the gateway is too old for the local AI (from ' + MIN_GATEWAY + ')');
  return g;
}

/** The live state of the local AI on a gateway (null when it does not answer). */
async function liveStatus(id) {
  const g = gatewayOf(id);
  // an unknown, too old or offline gateway has nothing to say (no call, no waiting)
  if (!g || !supported(features().telemetryOf(g)) || !aliveOf(g.id)) return null;
  const r = await gw().mgmtCall(g.id, '/api/ai/status', {}, 8000, { maxBytes: 128 * 1024 });
  if (!r || r.status !== 200 || !r.body || !isObj(r.body.ai)) return null;
  const t = telemetryAi({ features: { ai: r.body.ai } }, { maxModels: 48 });
  return { ...t, memFree: num(r.body.ai.memFree) || null };
}

const ANSWERS = { not_running: 'not_running', pull_running: 'pull_running', lan_source: 'lan_source', no_pull: 'no_pull', invalid_model: 'invalid', not_found: 'not_found', feature_disabled: 'unavailable', ai_failed: 'failed' };

async function call(id, path, body) {
  const g = needGateway(id);
  const r = await gw().mgmtCall(g.id, path, body, 10000);
  if (!r) throw new LocalError('gateway_unreachable', 'the gateway does not answer');
  if (r.status === 202 || r.status === 200) return { ok: true, ...(r.body && typeof r.body === 'object' ? r.body : {}) };
  const e = r.body && typeof r.body.error === 'string' ? r.body.error : null;
  throw new LocalError(ANSWERS[e] || 'gateway_error', e || ('gateway answered ' + r.status));
}

/** "Modell laden": the gateway downloads the model (progress through liveStatus). */
async function pull(id, model, { ip } = {}) {
  if (!validModel(model)) throw new LocalError('invalid', 'model');
  const r = await call(id, '/api/ai/pull', { model });
  const g = gatewayOf(id);
  activity().log('ai_local_model_pull', `Local AI: download of model "${model}" started on "${g.name}"`, {
    source: 'admin', ipAddress: ip, severity: 'info', details: { peer_id: g.id, model, size_mb: (catalogueEntry(model) || {}).downloadMb || null },
  });
  return r;
}

async function cancelPull(id, { ip } = {}) {
  const r = await call(id, '/api/ai/pull/cancel', {});
  const g = gatewayOf(id);
  activity().log('ai_local_model_pull_cancelled', `Local AI: model download cancelled on "${g.name}"`, { source: 'admin', ipAddress: ip, severity: 'info', details: { peer_id: g.id } });
  return r;
}

async function removeModel(id, model, { ip } = {}) {
  if (!validModel(model)) throw new LocalError('invalid', 'model');
  const r = await call(id, '/api/ai/delete', { model });
  const g = gatewayOf(id);
  activity().log('ai_local_model_deleted', `Local AI: model "${model}" deleted on "${g.name}"`, { source: 'admin', ipAddress: ip, severity: 'warning', details: { peer_id: g.id, model } });
  return r;
}

// ─── Setup (Einstellungen › KI-Anbieter › Lokale KI einrichten) ─────────

/**
 * Save the setup: { source, peerId, model, lanUrl?, lanApi? }.
 * Switches the function on on that gateway (and off on the one before, if it
 * served the local AI), chooses the model, switches the provider on.
 * → { provider, startPull } (startPull: the gateway should download the model now)
 */
function setup(b, { ip, user } = {}) {
  if (!isObj(b)) throw new LocalError('invalid', 'body');
  const source = b.source;
  if (!SOURCES.includes(source)) throw new LocalError('invalid', 'source');
  const id = Number(b.peerId);
  const g = gatewayOf(id);
  if (!g) throw new LocalError('invalid', 'peerId');
  if (!supported(features().telemetryOf(g))) throw new LocalError('gateway_unsupported', 'the gateway is too old for the local AI (from ' + MIN_GATEWAY + ')');
  const model = b.model;
  if (source === 'service' ? !validModel(model) : !validLanModel(model)) throw new LocalError('invalid', 'model');
  const patch = { enabled: true, source };
  if (source === 'lan') {
    const u = lanUrl(b.lanUrl);
    if (!u) throw new LocalError('invalid_host', 'lanUrl');
    if (b.lanApi !== undefined && !APIS.includes(b.lanApi)) throw new LocalError('invalid', 'lanApi');
    patch.lanUrl = u;
    patch.lanApi = b.lanApi || 'ollama';
  }
  const before = peerId();
  const prev = providerRow();
  features().set(g.id, { ai: patch }, { ip, user });
  if (before && before !== g.id && gatewayOf(before) && settingsOf(before).enabled) {
    try { features().set(before, { ai: { enabled: false } }, { ip, user }); } catch (e) { logger.warn({ err: e.message }, 'ai: local AI of the previous gateway not switched off'); }
  }
  settings().set(K.peer, String(g.id));
  db().prepare('INSERT OR IGNORE INTO ai_providers (id, enabled) VALUES (?, 0)').run(ID);
  db().prepare('UPDATE ai_providers SET enabled = 1, model_text = ?, capabilities = ?, checked_at = NULL, check_error = NULL WHERE id = ?').run(model, JSON.stringify(['text']), ID);
  if (!prev || prev.model_text !== model || before !== g.id || !prev.enabled) {
    activity().log('ai_local_setup', `Local AI set up: "${model}" ${source === 'lan' ? `on the AI server ${patch.lanUrl} through` : 'on'} "${g.name}"`, {
      source: 'admin', ipAddress: ip, severity: 'info', details: { peer_id: g.id, source, model, ...(source === 'lan' ? { lan_url: patch.lanUrl, lan_api: patch.lanApi } : {}) },
    });
  }
  return { provider: providerView(), startPull: source === 'service' };
}

/** The provider off (the gateways keep their switch — the row "Lokale KI" in Funktionen). */
function setEnabled(on, { ip } = {}) {
  if (typeof on !== 'boolean') throw new LocalError('invalid', 'enabled');
  const row = providerRow();
  if (on && !(row && row.model_text && peerId())) throw new LocalError('invalid', 'model');
  db().prepare('INSERT OR IGNORE INTO ai_providers (id, enabled) VALUES (?, 0)').run(ID);
  db().prepare('UPDATE ai_providers SET enabled = ? WHERE id = ?').run(on ? 1 : 0, ID);
  if (!!(row && row.enabled) !== on) {
    activity().log(on ? 'ai_local_enabled' : 'ai_local_disabled', `Local AI ${on ? 'switched on' : 'switched off'}`, { source: 'admin', ipAddress: ip, severity: on ? 'info' : 'warning', details: {} });
  }
  return providerView();
}

/** "Wofür die lokale KI?": all | private | fallback */
function setUse(u, { ip } = {}) {
  if (!USES.includes(u)) throw new LocalError('invalid', 'use');
  const before = use();
  settings().set(K.use, u);
  if (before !== u) {
    activity().log('ai_local_use_changed', `Local AI used for: ${u} (before: ${before})`, { source: 'admin', ipAddress: ip, severity: 'info', details: { use: u, before } });
  }
  return u;
}

/** Everything the card "Lokale KI einrichten" needs (GET /api/v1/ai/local). */
function view() {
  const id = peerId();
  const list = gateways();
  const cur = list.find((x) => x.id === id) || null;
  const row = providerRow();
  return {
    provider: providerView(),
    use: use(),
    minGateway: MIN_GATEWAY,
    gateways: list,
    catalogue: list.map((g) => ({ peerId: g.id, models: fitList({ memMb: g.memMb, cores: g.cores, arch: g.arch, gpu: g.gpu }, g.otherMb) })),
    current: cur ? { peerId: cur.id, source: cur.settings.source, lanUrl: cur.settings.lanUrl, lanApi: cur.settings.lanApi, model: row ? row.model_text || null : null } : null,
    privatePlugins: PRIVATE_PLUGINS.slice(),
  };
}

// ─── Features of a gateway (row "Lokale KI", memory bar) ───────────────

/** Does the compose file of this gateway need the service ki? */
function composeWantsAi(id) {
  try { const s = settingsOf(id); return s.enabled && s.source === 'service'; } catch { return false; }
}

/** What needs one step outside: the compose file (Synology/Linux) when the service ki is missing. */
function composeHint(t, s, platform) {
  if (!s || !s.enabled || s.source !== 'service') return null;
  const service = t ? t.service : 'missing';
  if (service === 'managed') return null;
  if (platform === 'rpi') return service === 'absent' ? null : 'image';
  return 'compose';
}

/** The part of the memory estimate (gatewayFeatures.memoryEstimate): the model in memory, else the expected one. */
function memoryPart(id, s, tel) {
  const a = s && s.ai;
  if (!a || !a.enabled || a.source !== 'service') return null;
  const t = telemetryAi(tel);
  const loaded = t && t.loaded.length ? t.loaded.reduce((x, m) => x + m.size, 0) : 0;
  if (loaded) return { key: 'ai', mb: SERVICE_MB + Math.round(loaded / 1048576), kind: 'ai', loaded: true };
  const row = peerId() === id ? providerRow() : null;
  const m = row && row.model_text ? catalogueEntry(row.model_text) : null;
  return { key: 'ai', mb: SERVICE_MB + (m ? m.ramMb : 0), kind: 'ai', loaded: false };
}

/** The row "Lokale KI" of the tab "Funktionen". */
function overview(id) {
  const g = features().needGateway(id);
  const tel = features().telemetryOf(g);
  const s = settingsOf(g.id);
  const t = telemetryAi(tel);
  const facts = factsOf(tel);
  const chosen = peerId() === g.id;
  const row = chosen ? providerRow() : null;
  const model = row && row.model_text ? row.model_text : null;
  const entry = model ? catalogueEntry(model) : null;
  const platform = require('../homeRadio').platformOf(g.id, tel);
  return {
    enabled: s.enabled,
    source: s.source,
    lanUrl: s.lanUrl,
    supported: supported(tel),
    minGateway: MIN_GATEWAY,
    chosen,
    providerEnabled: !!(row && row.enabled),
    model: model ? { id: model, name: entry ? entry.name : model, downloadMb: entry ? entry.downloadMb : null, ramMb: entry ? entry.ramMb : null,
      present: !!(t && t.models.some((m) => m.name === model || m.name === model + ':latest')) } : null,
    state: t ? { state: t.state, service: t.service, version: t.version, loaded: t.loaded, pull: t.pull } : null,
    hint: gatewayHint(facts, otherFeaturesMb(g.id, tel)),
    platform,
    compose: composeHint(t, s, platform),
  };
}

// ─── The adapter (services/ai/index.js attempt()) ──────────────────────

/** Gateway error codes → ProviderError kinds (retryable: one try at a cloud fallback). */
function errorKind(code) {
  if (code === 'timeout') return 'timeout';
  if (code === 'busy') return 'rate';
  if (code === 'invalid_request' || code === 'invalid') return 'client';
  if (code === 'too_large' || code === 'bad_response') return 'invalid';
  if (code === 'unreachable' || code === 'not_running' || code === 'feature_disabled' || code === 'disabled' || code === 'aborted') return 'network';
  return 'server'; // model_missing, model_error, http_5xx …
}

const MESSAGES = {
  timeout: 'the local AI did not answer in time', rate: 'the local AI is busy', network: 'the local AI is not reachable',
  client: 'the local AI refused the request', invalid: 'the local AI sent an unusable answer', server: 'the local AI failed',
};

function pow2(n) { let p = 1; while (p < n) p *= 2; return p; }

/** The text of the parts for a model with a context of ctx tokens (cut in the middle when it is too long). */
function fitText(text, budgetChars) {
  if (text.length <= budgetChars) return { text, cut: false };
  const head = Math.floor(budgetChars * 0.7);
  const tail = budgetChars - head - 40;
  return { text: text.slice(0, head) + '\n\n[… gekürzt / shortened …]\n\n' + text.slice(text.length - Math.max(0, tail)), cut: true };
}

/**
 * One request through the gateway — the same interface as the cloud adapters:
 * o: { model, instructions, parts, schema?, maxOutputTokens, timeoutMs, peerId } → { text, finish, usage, costUsd: 0, cut }
 */
async function complete(o) {
  if (o.parts.some((p) => p.type !== 'text')) throw new http.ProviderError('client', 'the local AI reads no pictures');
  if (!aliveOf(o.peerId)) throw new http.ProviderError('network', 'the gateway of the local AI is offline');
  const maxTokens = Math.max(1, Math.min(LIMITS.outputMax, o.maxOutputTokens));
  let system = o.instructions || 'Follow the input.';
  if (o.schema) system += '\n\nAnswer with JSON only, matching this JSON schema:\n' + JSON.stringify(o.schema);
  const joined = o.parts.map((p) => http.textOf(p)).join('\n\n');
  const need = Math.ceil((system.length + joined.length) / LIMITS.charsPerToken) + maxTokens + 256;
  const numCtx = Math.max(LIMITS.ctxMin, Math.min(LIMITS.ctxMax, pow2(need)));
  const fitted = fitText(joined, Math.max(1000, (numCtx - maxTokens - 256) * LIMITS.charsPerToken - system.length));
  const body = {
    model: o.model, system, messages: [{ role: 'user', content: fitted.text }], schema: o.schema || null,
    maxTokens, numCtx, temperature: o.schema ? 0 : 0.3,
    timeoutMs: Math.max(5000, Math.min(LIMITS.maxTimeoutMs, o.timeoutMs)),
  };
  let text = '';
  let bytes = 0;
  let end = null;
  let lineError = null;
  let r;
  try {
    r = await gw().mgmtStream(o.peerId, '/api/ai/chat', body, {
      totalMs: body.timeoutMs + 15000, idleMs: LIMITS.idleMs, maxBytes: 2 * LIMITS.answerBytes + 64 * 1024,
      onLine: (l) => {
        if (typeof l.d === 'string') {
          bytes += Buffer.byteLength(l.d);
          if (bytes > LIMITS.answerBytes) throw Object.assign(new Error('answer too large'), { code: 'too_large' });
          text += l.d;
        } else if (l.done === true) end = l;
        else if (typeof l.error === 'string') lineError = l;
      },
    });
  } catch (e) {
    const kind = errorKind(e && e.code);
    throw new http.ProviderError(kind, MESSAGES[kind]);
  }
  if (r.status !== 200) {
    const code = r.body && typeof r.body.error === 'string' ? r.body.error : (r.status === 429 ? 'busy' : 'unreachable');
    const kind = errorKind(code);
    throw new http.ProviderError(kind, MESSAGES[kind] + ` (${code})`, r.status);
  }
  if (lineError || !end) {
    const code = lineError ? lineError.error : 'bad_response';
    const kind = errorKind(code);
    throw new http.ProviderError(kind, MESSAGES[kind] + ` (${clean(code, 32)})`);
  }
  return {
    text,
    finish: end.finish === 'length' ? 'length' : 'stop',
    usage: { inputTokens: num(end.inputTokens), outputTokens: num(end.outputTokens) },
    costUsd: 0,
    cut: fitted.cut,
  };
}

/** Is this request private content (mode "Nur für private Inhalte")? */
function isPrivate(pluginId) { return PRIVATE_PLUGINS.includes(pluginId); }

module.exports = {
  ID, NAME, MIN_GATEWAY, USES, SOURCES, APIS, PRIVATE_PLUGINS, CATALOGUE, LIMITS, K, LocalError,
  lanUrl, validModel, validLanModel, normalizeSettings, patchField, configPayload, telemetryAi, supported, factsOf, fitList, gatewayHint, catalogueEntry,
  providerRow, peerId, use, ready, providerView, gateways, liveStatus, pull, cancelPull, removeModel, setup, setEnabled, setUse, view,
  composeWantsAi, composeHint, memoryPart, overview, complete, errorKind, isPrivate, fitText,
};
