'use strict';

// The AI service of GateControl (docs/plugins.md "AI requests"): one place
// that talks to the AI providers (OpenAI, Anthropic, Google Gemini,
// OpenRouter) for every plugin. Plugins ask through gc.ai (host API, the
// plugin process never sees a key or the bytes of a picture); the
// administrator sets keys, models, default and fallback provider, the
// picture switch, the monthly budget and which plugin may ask
// (Einstellungen › KI-Anbieter, routes/api/ai.js).
//
// A request: permission + switches → rate limit → provider → budget
// (reserved) → pictures read by the host → call with time limit (on a
// timeout, 429, 5xx or no connection exactly one try at the fallback
// provider) → schema check (one correction round) → cost booked, log row
// (metadata only, 90 days).
//
// GC_AI=off switches the service off completely. A test run (NODE_ENV=test)
// never reaches a provider (providers/http.js).

const { getDb } = require('../../db/connection');
const logger = require('../../utils/logger');
const schemaLib = require('./schema');
const providers = require('./providers');
const http = require('./providers/http');

const OFF_WORDS = new Set(['off', '0', 'false', 'no', 'disabled']);
const KINDS = new Set(['extract', 'generate']);
// what a request can use in this version (gc.ai.transcribe and video come later)
const SUPPORTED_CAPS = Object.freeze(['text', 'vision']);
const ALL_CAPS = Object.freeze(['text', 'vision', 'audio', 'video']);

const LIMITS = Object.freeze({
  textChars: 200000,          // instructions + every text input together
  inputs: 64,                 // entries of input[]
  labelChars: 100,
  images: 8,                  // pictures per request
  imageBytes: 10 * 1024 * 1024,
  imagePx: 2048,              // the host scales pictures down to at most this per side
  answerBytes: 64 * 1024,     // JSON of data / the text of generate
  timeoutMinMs: 1000,
  timeoutMaxMs: 180000,
  timeoutDefaultMs: 60000,
  outputTokensMax: 32000,
  outputTokensDefault: 4000,
  perHourDefault: 120,
  perHourMax: 10000,
  budgetCentsDefault: 1000,   // 10 €
  budgetCentsMax: 100000000,
  logDays: 90,
  modelsTtlMs: 60 * 60 * 1000,
});
const EUR_PER_USD_DEFAULT = 0.92;
// rough input estimate of a picture (tokens) for the reservation
const IMAGE_TOKENS_ESTIMATE = 1600;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const TASK_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,39}$/;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;

const K = Object.freeze({
  defaultProvider: 'ai.default_provider',
  fallbackProvider: 'ai.fallback_provider',
  mediaAllowed: 'ai.media_allowed',
  budgetCents: 'ai.budget_cents',
  eurPerUsd: 'ai.eur_per_usd',
  priceOverrides: 'ai.price_overrides',
  perHour: 'ai.per_hour',
  budgetNotified: 'ai.budget_notified',
});

class AiError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

function fail(code, message) { throw new AiError(code, message); }
function db() { return getDb(); }
function settings() { return require('../settings'); }
function activity() { return require('../activity'); }
function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

// ─── Configuration ──────────────────────────────

/** GC_AI=off switches the AI service off completely: no provider, no request, nothing offered. */
function enabled() {
  return !OFF_WORDS.has(String(process.env.GC_AI || '').trim().toLowerCase());
}

function intSetting(key, def, min, max) {
  const n = Number(settings().get(key, null));
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : def;
}

function config() {
  const s = settings();
  let overrides = {};
  try { overrides = JSON.parse(s.get(K.priceOverrides, '{}') || '{}'); } catch { overrides = {}; }
  const rate = Number(s.get(K.eurPerUsd, null));
  const def = s.get(K.defaultProvider, '') || null;
  const fb = s.get(K.fallbackProvider, '') || null;
  return {
    defaultProvider: providers.IDS.includes(def) ? def : null,
    fallbackProvider: providers.IDS.includes(fb) ? fb : null,
    mediaAllowed: s.get(K.mediaAllowed, '0') === '1',
    budgetCents: intSetting(K.budgetCents, LIMITS.budgetCentsDefault, 1, LIMITS.budgetCentsMax),
    eurPerUsd: Number.isFinite(rate) && rate > 0 && rate < 100 ? rate : EUR_PER_USD_DEFAULT,
    priceOverrides: isObj(overrides) ? overrides : {},
    perHour: intSetting(K.perHour, LIMITS.perHourDefault, 1, LIMITS.perHourMax),
  };
}

// never a property name taken from input
const RESERVED_NAMES = new Set(['__proto__', 'constructor', 'prototype']);

/** Price overrides: { <provider>: { <model>: { input, output } } } in US dollars per million tokens. */
function cleanOverrides(v) {
  if (v == null) return Object.create(null);
  if (!isObj(v)) fail('ERR_INVALID', 'priceOverrides');
  const out = Object.create(null);
  for (const [p, models] of Object.entries(v)) {
    // only the four provider ids (an allowlist) become keys
    const provider = providers.IDS.find((id) => id === p);
    if (!provider || !isObj(models)) fail('ERR_INVALID', 'priceOverrides');
    const m = Object.create(null);
    for (const [model, price] of Object.entries(models)) {
      const ok = MODEL_RE.test(model) && !RESERVED_NAMES.has(model) && isObj(price) && Object.keys(price).every((k) => k === 'input' || k === 'output')
        && [price.input, price.output].every((x) => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 100000);
      if (!ok) fail('ERR_INVALID', 'priceOverrides');
      m[model] = { input: price.input, output: price.output };
    }
    if (Object.keys(m).length > 200) fail('ERR_INVALID', 'priceOverrides');
    if (Object.keys(m).length) out[provider] = m;
  }
  return out;
}

/**
 * Save the general settings (PUT /api/v1/ai/settings). Every key optional.
 * @returns the new config
 */
function saveSettings(b, { ip } = {}) {
  const s = settings();
  const before = config();
  const has = (k) => Object.prototype.hasOwnProperty.call(b, k);
  const prov = (v) => {
    if (v === null || v === '') return '';
    if (!providers.IDS.includes(v)) fail('ERR_INVALID', 'provider');
    return v;
  };
  const writes = [];
  if (has('defaultProvider')) writes.push([K.defaultProvider, prov(b.defaultProvider)]);
  if (has('fallbackProvider')) writes.push([K.fallbackProvider, prov(b.fallbackProvider)]);
  if (has('mediaAllowed')) {
    if (typeof b.mediaAllowed !== 'boolean') fail('ERR_INVALID', 'mediaAllowed');
    writes.push([K.mediaAllowed, b.mediaAllowed ? '1' : '0']);
  }
  if (has('budgetCents')) {
    if (!Number.isSafeInteger(b.budgetCents) || b.budgetCents < 1 || b.budgetCents > LIMITS.budgetCentsMax) fail('ERR_INVALID', 'budgetCents');
    writes.push([K.budgetCents, String(b.budgetCents)]);
  }
  if (has('eurPerUsd')) {
    if (typeof b.eurPerUsd !== 'number' || !Number.isFinite(b.eurPerUsd) || b.eurPerUsd <= 0 || b.eurPerUsd >= 100) fail('ERR_INVALID', 'eurPerUsd');
    writes.push([K.eurPerUsd, String(b.eurPerUsd)]);
  }
  if (has('perHour')) {
    if (!Number.isSafeInteger(b.perHour) || b.perHour < 1 || b.perHour > LIMITS.perHourMax) fail('ERR_INVALID', 'perHour');
    writes.push([K.perHour, String(b.perHour)]);
  }
  if (has('priceOverrides')) writes.push([K.priceOverrides, JSON.stringify(cleanOverrides(b.priceOverrides))]);
  const next = {};
  for (const [k, v] of writes) next[k] = v;
  const def = K.defaultProvider in next ? next[K.defaultProvider] : (before.defaultProvider || '');
  const fb = K.fallbackProvider in next ? next[K.fallbackProvider] : (before.fallbackProvider || '');
  if (def && fb && def === fb) fail('ERR_INVALID', 'fallbackProvider');
  for (const [k, v] of writes) s.set(k, v);
  const after = config();
  const changed = Object.keys(after).filter((k) => JSON.stringify(after[k]) !== JSON.stringify(before[k]));
  if (changed.length) {
    activity().log('ai_settings_changed', `AI settings changed: ${changed.join(', ')}`, {
      source: 'admin', ipAddress: ip, severity: 'info',
      details: { changed, ...(changed.includes('budgetCents') ? { budgetCents: after.budgetCents } : {}),
        ...(changed.includes('mediaAllowed') ? { mediaAllowed: after.mediaAllowed } : {}) },
    });
  }
  return after;
}

// ─── Providers ──────────────────────────────────

const modelCache = new Map(); // provider id → { at, models }

function providerRow(id) {
  return db().prepare('SELECT * FROM ai_providers WHERE id = ?').get(id) || null;
}

function ensureRow(id) {
  db().prepare('INSERT OR IGNORE INTO ai_providers (id, enabled) VALUES (?, 0)').run(id);
}

/** The decrypted key, null without one; 'invalid' when it cannot be decrypted (other server key). */
function keyOf(row) {
  if (!row || !row.key_encrypted) return null;
  try { return require('../../utils/crypto').decrypt(row.key_encrypted); } catch { return 'invalid'; }
}

function parseCaps(v) {
  try {
    const a = JSON.parse(v || 'null');
    return Array.isArray(a) ? a.filter((x) => ALL_CAPS.includes(x)) : null;
  } catch { return null; }
}

/** Capabilities of a provider with its chosen model (OpenRouter: of that model). */
function capsOf(id, row) {
  const stored = row ? parseCaps(row.capabilities) : null;
  if (stored && stored.length) return stored;
  return providers.CAPABILITIES[id].slice();
}

function cachedModels(id) {
  const c = modelCache.get(id);
  return c && Date.now() - c.at < LIMITS.modelsTtlMs ? c.models : null;
}

/** Ready for requests: switched on, a usable key, a model. */
function configured(row) {
  if (!row || !row.enabled || !row.model_text) return false;
  const key = keyOf(row);
  return !!key && key !== 'invalid';
}

function providerView(id) {
  const row = providerRow(id);
  const key = keyOf(row);
  return {
    id,
    name: providers.NAMES[id],
    enabled: !!(row && row.enabled),
    configured: configured(row),
    keySet: !!key,
    keyState: !key ? 'none' : (key === 'invalid' ? 'invalid' : 'ok'),
    keyHint: row && key && key !== 'invalid' ? row.key_hint : null,
    modelText: row ? row.model_text || null : null,
    modelAudio: row ? row.model_audio || null : null,
    capabilities: capsOf(id, row),
    checkedAt: row && row.checked_at ? new Date(row.checked_at).toISOString() : null,
    checkError: row ? row.check_error || null : null,
    models: cachedModels(id),
  };
}

function needProvider(id) {
  if (!providers.IDS.includes(id)) fail('ERR_NOT_FOUND', 'unknown provider');
}

function modelCaps(id, model) {
  if (id !== 'openrouter') return providers.CAPABILITIES[id].slice();
  const m = (cachedModels(id) || []).find((x) => x.id === model);
  return m ? m.capabilities.slice() : null;
}

/** What the model list said of a model, kept with the provider: { structured?, price? } (null when not listed). */
function modelInfo(id, model) {
  const m = (cachedModels(id) || []).find((x) => x.id === model);
  if (!m) return null;
  return { ...(m.structured === false ? { structured: false } : {}), ...(m.price ? { price: m.price } : {}) };
}

function storedInfo(row) {
  try {
    const v = JSON.parse((row && row.model_info) || 'null');
    return isObj(v) ? v : {};
  } catch { return {}; }
}

/**
 * Change a provider (PUT /api/v1/ai/providers/:id): { key?, enabled?, modelText?, modelAudio? }.
 * key '' deletes the key; a new key replaces the old one (it is never read back).
 */
function setProvider(id, b, { ip } = {}) {
  needProvider(id);
  if (!isObj(b)) fail('ERR_INVALID', 'body');
  const has = (k) => Object.prototype.hasOwnProperty.call(b, k);
  if (has('key') && (typeof b.key !== 'string' || b.key.length > 500 || /\s/.test(b.key.trim()) || (b.key && b.key.trim().length < 8))) fail('ERR_INVALID', 'key');
  if (has('enabled') && typeof b.enabled !== 'boolean') fail('ERR_INVALID', 'enabled');
  for (const k of ['modelText', 'modelAudio']) if (has(k) && b[k] !== null && b[k] !== '' && (typeof b[k] !== 'string' || !MODEL_RE.test(b[k]))) fail('ERR_INVALID', k);
  ensureRow(id);
  const q = db();
  if (has('key')) {
    const key = b.key.trim();
    if (key) {
      // a new key is meant to be used: the provider is switched on with it
      q.prepare('UPDATE ai_providers SET key_encrypted = ?, key_hint = ?, enabled = 1, checked_at = NULL, check_error = NULL WHERE id = ?')
        .run(require('../../utils/crypto').encrypt(key), key.slice(-4), id);
      modelCache.delete(id);
      activity().log('ai_provider_key_set', `AI provider "${providers.NAMES[id]}": API key set`, { source: 'admin', ipAddress: ip, severity: 'info', details: { provider: id } });
    } else {
      q.prepare('UPDATE ai_providers SET key_encrypted = NULL, key_hint = NULL, enabled = 0, checked_at = NULL, check_error = NULL WHERE id = ?').run(id);
      modelCache.delete(id);
      activity().log('ai_provider_key_removed', `AI provider "${providers.NAMES[id]}": API key removed`, { source: 'admin', ipAddress: ip, severity: 'warning', details: { provider: id } });
    }
  }
  if (has('modelText')) {
    const model = b.modelText || null;
    const caps = model ? modelCaps(id, model) : null;
    const info = model ? modelInfo(id, model) : null;
    q.prepare('UPDATE ai_providers SET model_text = ?, capabilities = COALESCE(?, capabilities), model_info = ? WHERE id = ?')
      .run(model, caps ? JSON.stringify(caps) : null, info ? JSON.stringify(info) : null, id);
  }
  if (has('modelAudio')) q.prepare('UPDATE ai_providers SET model_audio = ? WHERE id = ?').run(b.modelAudio || null, id);
  if (has('enabled')) {
    const row = providerRow(id);
    if (b.enabled && !keyOf(row)) fail('ERR_INVALID', 'key');
    q.prepare('UPDATE ai_providers SET enabled = ? WHERE id = ?').run(b.enabled ? 1 : 0, id);
  }
  return providerView(id);
}

/**
 * Test a provider (POST …/test): fetch its model list — checks the key at
 * no cost and fills the model choice (kept an hour). The first test of a
 * provider without a model picks none: the administrator chooses.
 * → { ok, models } | { ok: false, code, message }
 */
async function testProvider(id, { key: unsavedKey } = {}) {
  needProvider(id);
  if (!enabled()) return { ok: false, code: 'ai_disabled', message: 'GC_AI=off' };
  const row = providerRow(id);
  const key = typeof unsavedKey === 'string' && unsavedKey.trim() ? unsavedKey.trim() : keyOf(row);
  if (!key) return { ok: false, code: 'no_key', message: 'no API key' };
  if (key === 'invalid') return { ok: false, code: 'key_unreadable', message: 'the stored key cannot be read on this server — enter it again' };
  let models;
  try {
    models = await providers.adapter(id).listModels(key, { timeoutMs: 15000 });
  } catch (e) {
    const message = http.scrub(e && e.message, [key]);
    const code = e instanceof http.ProviderError ? (e.kind === 'auth' ? 'auth' : (e.kind === 'test_mode' ? 'test_mode' : 'provider')) : 'provider';
    if (row && !unsavedKey) db().prepare('UPDATE ai_providers SET checked_at = ?, check_error = ? WHERE id = ?').run(Date.now(), message, id);
    return { ok: false, code, message };
  }
  const list = models.map((m) => ({ id: m.id, name: m.name, capabilities: m.capabilities || providers.CAPABILITIES[id].slice(),
    ...(m.structured === false ? { structured: false } : {}), ...(m.price ? { price: m.price } : {}) }));
  modelCache.set(id, { at: Date.now(), models: list });
  if (row && !unsavedKey) {
    const chosen = row.model_text ? list.find((m) => m.id === row.model_text) : null;
    const caps = chosen ? chosen.capabilities : (id === 'openrouter' ? null : providers.CAPABILITIES[id].slice());
    const info = chosen ? modelInfo(id, chosen.id) : null;
    db().prepare('UPDATE ai_providers SET checked_at = ?, check_error = NULL, capabilities = COALESCE(?, capabilities), model_info = COALESCE(?, model_info) WHERE id = ?')
      .run(Date.now(), caps ? JSON.stringify(caps) : null, info ? JSON.stringify(info) : null, id);
  }
  return { ok: true, models: list };
}

// ─── Policy per plugin ──────────────────────────

function declOf(plugin) {
  const p = plugin && plugin.manifest && plugin.manifest.permissions;
  return p && p.ai ? p.ai : null;
}

function policyOf(pluginId) {
  const r = db().prepare('SELECT allowed, provider FROM ai_plugin_policy WHERE plugin_id = ?').get(pluginId);
  return { allowed: !!(r && r.allowed), provider: r && providers.IDS.includes(r.provider) ? r.provider : null };
}

/**
 * Install / update (plugins/index.js install(), the administrator accepted
 * the permissions): a plugin that asks for permissions.ai for the first time
 * is allowed now; an update keeps what the administrator set.
 */
function onInstalled(manifest, previous) {
  if (!manifest || !manifest.permissions || !manifest.permissions.ai) return;
  const had = !!(previous && previous.permissions && previous.permissions.ai);
  const row = db().prepare('SELECT plugin_id FROM ai_plugin_policy WHERE plugin_id = ?').get(manifest.id);
  if (!row) db().prepare('INSERT INTO ai_plugin_policy (plugin_id, allowed, provider) VALUES (?, 1, NULL)').run(manifest.id);
  else if (!had) db().prepare('UPDATE ai_plugin_policy SET allowed = 1 WHERE plugin_id = ?').run(manifest.id);
}

/** Uninstalled: the consent ends with it (a new install asks again). */
function forgetPlugin(pluginId) {
  try { db().prepare('DELETE FROM ai_plugin_policy WHERE plugin_id = ?').run(pluginId); } catch { /* table missing in old tests */ }
  windows.delete(pluginId);
}

function pluginsList(lang) {
  const { loc } = require('../plugins/manifest');
  return require('../plugins/registry').list().filter((p) => declOf(p)).map((p) => {
    const d = declOf(p);
    const pol = policyOf(p.id);
    return { id: p.id, name: loc(p.manifest.name, lang), purpose: loc(d.purpose, lang), capabilities: d.capabilities.slice(), allowed: pol.allowed, provider: pol.provider, enabled: !!p.enabled };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

/** PUT /api/v1/ai/plugins/:id { allowed?, provider? } (provider null = the default one). */
function setPolicy(pluginId, b, { ip, lang } = {}) {
  const p = require('../plugins/registry').get(pluginId);
  if (!p || !declOf(p)) fail('ERR_NOT_FOUND', 'plugin');
  if (!isObj(b)) fail('ERR_INVALID', 'body');
  const has = (k) => Object.prototype.hasOwnProperty.call(b, k);
  if (has('allowed') && typeof b.allowed !== 'boolean') fail('ERR_INVALID', 'allowed');
  if (has('provider') && b.provider !== null && !providers.IDS.includes(b.provider)) fail('ERR_INVALID', 'provider');
  const before = policyOf(pluginId);
  const allowed = has('allowed') ? b.allowed : before.allowed;
  const provider = has('provider') ? b.provider : before.provider;
  db().prepare(`INSERT INTO ai_plugin_policy (plugin_id, allowed, provider) VALUES (?, ?, ?)
    ON CONFLICT(plugin_id) DO UPDATE SET allowed = excluded.allowed, provider = excluded.provider`).run(pluginId, allowed ? 1 : 0, provider);
  if (allowed !== before.allowed) {
    activity().log(allowed ? 'ai_plugin_allowed' : 'ai_plugin_blocked', `Plugin "${p.name}" ${allowed ? 'may' : 'may no longer'} send AI requests`, {
      source: 'admin', ipAddress: ip, severity: allowed ? 'info' : 'warning', details: { plugin: pluginId },
    });
  }
  return pluginsList(lang).find((x) => x.id === pluginId);
}

// ─── Routing ────────────────────────────────────

/** Providers ready for requests, in the order: default, fallback, the rest. */
function readyProviders(cfg) {
  const order = [cfg.defaultProvider, cfg.fallbackProvider, ...providers.IDS].filter((x, i, a) => x && a.indexOf(x) === i);
  const out = [];
  for (const id of order) {
    const row = providerRow(id);
    if (configured(row)) out.push({ id, row, caps: capsOf(id, row) });
  }
  return out;
}

/**
 * The provider of a request and its fallback.
 * Fixed provider of the plugin: that one, no routing, no fallback.
 * Otherwise the default provider when it can do it, else the next one that can.
 */
function route(plugin, need, cfg) {
  const ready = readyProviders(cfg);
  const pol = policyOf(plugin.id);
  const can = (x) => need.every((c) => x.caps.includes(c));
  if (pol.provider) {
    const fixed = ready.find((x) => x.id === pol.provider);
    if (!fixed) fail('ERR_AI_NOT_CONFIGURED', 'the provider of this plugin is not set up');
    if (!can(fixed)) fail('ERR_AI_CAPABILITY', `the provider of this plugin cannot do ${need.join(' + ')}`);
    return { primary: fixed, fallback: null };
  }
  if (!ready.length) fail('ERR_AI_NOT_CONFIGURED', 'no AI provider is set up');
  const able = ready.filter(can);
  if (!able.length) fail('ERR_AI_CAPABILITY', `no provider can do ${need.join(' + ')}`);
  const primary = able[0];
  const fb = cfg.fallbackProvider ? able.find((x) => x.id === cfg.fallbackProvider && x.id !== primary.id) : null;
  return { primary, fallback: fb || null };
}

// ─── Rate limit, budget, prices ─────────────────

const windows = new Map(); // plugin id → [timestamps of the last hour]
const reservations = new Map(); // seq → microcents
let reservationSeq = 0;

function takeRate(pluginId, perHour) {
  const now = Date.now();
  const list = (windows.get(pluginId) || []).filter((t) => now - t < 3600000);
  if (list.length >= perHour) { windows.set(pluginId, list); return false; }
  list.push(now);
  windows.set(pluginId, list);
  return true;
}

/** Start of the month (the server's time zone) of `now`. */
function monthStart(now = Date.now()) {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}

function monthKey(now = Date.now()) {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function usedMicro(now = Date.now()) {
  const r = db().prepare('SELECT COALESCE(SUM(cost_microcents), 0) AS s FROM ai_requests WHERE at >= ?').get(monthStart(now));
  return Number(r.s) || 0;
}

function reservedMicro() {
  let s = 0;
  for (const v of reservations.values()) s += v;
  return s;
}

/** US dollars per million tokens of a provider's chosen model: { input, output, estimated }. */
function priceOf(id, row, cfg) {
  const model = row.model_text;
  const own = (o, k) => isObj(o) && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : null;
  const o = own(own(cfg.priceOverrides, id), model);
  if (o) return { input: o.input, output: o.output, estimated: false };
  // OpenRouter lists the prices of its models
  const listed = storedInfo(row).price;
  if (listed && Number.isFinite(listed.input) && Number.isFinite(listed.output)) return { input: listed.input, output: listed.output, estimated: false };
  const d = providers.DEFAULT_PRICES[id];
  return { input: d.input, output: d.output, estimated: true };
}

/** Tokens × US dollars per million → millionths of a euro cent. */
function microOf(tokensIn, tokensOut, price, eurPerUsd) {
  return Math.ceil((tokensIn * price.input + tokensOut * price.output) * eurPerUsd * 100);
}

function usdToMicro(usd, eurPerUsd) { return Math.ceil(usd * eurPerUsd * 100 * 1e6); }

function centsOf(micro) { return Math.round(micro / 1e4) / 100; }

/** The administrators hear of 80 % and of 100 % of the budget, each once a month. */
function budgetNotice(cfg, reachedNow = false) {
  const budget = cfg.budgetCents * 1e6;
  const used = usedMicro();
  const month = monthKey();
  let notified = {};
  try { notified = JSON.parse(settings().get(K.budgetNotified, '{}') || '{}'); } catch { notified = {}; }
  if (notified.month !== month) notified = { month };
  const pct = Math.floor((used / budget) * 100);
  const say = (level, type, severity) => {
    if (notified[level]) return;
    notified[level] = true;
    settings().set(K.budgetNotified, JSON.stringify(notified));
    activity().log(type, level === 'full'
      ? `AI budget of this month reached (${centsOf(used).toFixed(2)} € of ${(cfg.budgetCents / 100).toFixed(2)} €) — further AI requests are refused`
      : `AI budget of this month at ${pct} % (${centsOf(used).toFixed(2)} € of ${(cfg.budgetCents / 100).toFixed(2)} €)`, {
      source: 'system', severity, details: { month, usedCents: centsOf(used), budgetCents: cfg.budgetCents },
    });
  };
  if (reachedNow || used >= budget) say('full', 'ai_budget_reached', 'warning');
  else if (used >= budget * 0.8) say('warn', 'ai_budget_warning', 'info');
}

// ─── Log ────────────────────────────────────────

function book(row) {
  try {
    db().prepare(`INSERT INTO ai_requests (at, plugin_id, user_id, task, provider, model, kind, input_tokens, output_tokens, media_count,
      cost_microcents, duration_ms, outcome, fallback, estimated) VALUES (@at, @plugin, @user, @task, @provider, @model, @kind, @inputTokens,
      @outputTokens, @mediaCount, @micro, @durationMs, @outcome, @fallback, @estimated)`).run({
      at: Date.now(), plugin: row.plugin, user: row.user || null, task: row.task || null, provider: row.provider || null, model: row.model || null,
      kind: row.kind, inputTokens: row.inputTokens || 0, outputTokens: row.outputTokens || 0, mediaCount: row.mediaCount || 0,
      micro: row.micro || 0, durationMs: row.durationMs || 0, outcome: row.outcome, fallback: row.fallback ? 1 : 0, estimated: row.estimated ? 1 : 0,
    });
  } catch (e) { logger.warn({ err: e.message }, 'ai: log row not written'); }
}

/** Rows older than 90 days go. */
function prune(now = Date.now()) {
  try { return db().prepare('DELETE FROM ai_requests WHERE at < ?').run(now - LIMITS.logDays * 86400000).changes; } catch { return 0; }
}

function requestsLog({ plugin, limit } = {}) {
  const n = Math.max(1, Math.min(500, Number(limit) || 100));
  const rows = plugin
    ? db().prepare('SELECT * FROM ai_requests WHERE plugin_id = ? ORDER BY id DESC LIMIT ?').all(String(plugin), n)
    : db().prepare('SELECT * FROM ai_requests ORDER BY id DESC LIMIT ?').all(n);
  return rows.map((r) => ({
    id: r.id, at: new Date(r.at).toISOString(), plugin: r.plugin_id, userId: r.user_id, task: r.task, provider: r.provider, model: r.model, kind: r.kind,
    inputTokens: r.input_tokens, outputTokens: r.output_tokens, mediaCount: r.media_count, costCents: centsOf(r.cost_microcents),
    durationMs: r.duration_ms, outcome: r.outcome, fallback: !!r.fallback, estimated: !!r.estimated,
  }));
}

/** Sums of a month ('YYYY-MM', default this one) by plugin, provider and day. */
function usage(month) {
  const m = typeof month === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(month) ? month : monthKey();
  const [y, mo] = m.split('-').map(Number);
  const from = new Date(y, mo - 1, 1).getTime();
  const to = new Date(y, mo, 1).getTime();
  const q = (col) => db().prepare(`SELECT ${col} AS k, COUNT(*) AS n, COALESCE(SUM(cost_microcents), 0) AS micro,
    COALESCE(SUM(input_tokens), 0) AS tin, COALESCE(SUM(output_tokens), 0) AS tout
    FROM ai_requests WHERE at >= ? AND at < ? GROUP BY k ORDER BY micro DESC`).all(from, to)
    .map((r) => ({ key: r.k, requests: r.n, costCents: centsOf(r.micro), inputTokens: r.tin, outputTokens: r.tout }));
  const total = db().prepare('SELECT COUNT(*) AS n, COALESCE(SUM(cost_microcents), 0) AS micro, COALESCE(SUM(estimated), 0) AS est FROM ai_requests WHERE at >= ? AND at < ?').get(from, to);
  const cfg = config();
  const byDay = db().prepare(`SELECT at, cost_microcents AS micro FROM ai_requests WHERE at >= ? AND at < ?`).all(from, to);
  const days = new Map();
  for (const r of byDay) {
    const d = new Date(r.at);
    const k = `${m}-${String(d.getDate()).padStart(2, '0')}`;
    const e = days.get(k) || { day: k, requests: 0, micro: 0 };
    e.requests++;
    e.micro += r.micro;
    days.set(k, e);
  }
  return {
    month: m,
    requests: total.n,
    costCents: centsOf(total.micro),
    estimated: total.est > 0,
    budgetCents: cfg.budgetCents,
    byPlugin: q('plugin_id').map((r) => ({ plugin: r.key, ...r, key: undefined })),
    byProvider: q('provider').map((r) => ({ provider: r.key, ...r, key: undefined })),
    byDay: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)).map((e) => ({ day: e.day, requests: e.requests, costCents: centsOf(e.micro) })),
  };
}

// ─── Host API (gc.ai) ───────────────────────────

/** Is the plugin allowed to ask at all (permission, consent, capability declared)? */
function permitted(plugin, need) {
  const d = declOf(plugin);
  if (!d) return { ok: false, why: 'this plugin has no ai permission' };
  if (!policyOf(plugin.id).allowed) return { ok: false, why: 'the administrator has not allowed AI requests for this plugin' };
  const missing = need.filter((c) => !d.capabilities.includes(c));
  if (missing.length) return { ok: false, why: `capability not declared in permissions.ai: ${missing.join(', ')}` };
  return { ok: true };
}

/** gc.ai.available({ capability }) — asks no provider, costs nothing. */
function available(plugin, args) {
  const a = isObj(args) ? args : {};
  const cap = a.capability == null ? 'text' : a.capability;
  if (!ALL_CAPS.includes(cap)) fail('ERR_INVALID', 'invalid capability');
  if (!enabled() || !SUPPORTED_CAPS.includes(cap)) return false;
  const need = cap === 'text' ? ['text'] : ['text', cap];
  if (!permitted(plugin, need).ok) return false;
  const cfg = config();
  if (cap === 'vision' && !cfg.mediaAllowed) return false;
  try { route(plugin, need, cfg); return true; } catch { return false; }
}

/** gc.ai.status() → { available, mediaAllowed, capabilities, budgetLeftCents } */
function status(plugin) {
  const off = { available: false, mediaAllowed: false, capabilities: [], budgetLeftCents: null };
  if (!enabled() || !permitted(plugin, ['text']).ok) return off;
  const cfg = config();
  const caps = [];
  for (const cap of SUPPORTED_CAPS) {
    const need = cap === 'text' ? ['text'] : ['text', cap];
    if (!permitted(plugin, need).ok || (cap === 'vision' && !cfg.mediaAllowed)) continue;
    try { route(plugin, need, cfg); caps.push(cap); } catch { /* not this one */ }
  }
  if (!caps.includes('text')) return { ...off, mediaAllowed: cfg.mediaAllowed };
  const left = Math.max(0, cfg.budgetCents * 1e6 - usedMicro() - reservedMicro());
  return { available: true, mediaAllowed: cfg.mediaAllowed, capabilities: caps, budgetLeftCents: centsOf(left) };
}

/** Arguments of extract / generate, checked (ERR_INVALID). */
function parseArgs(kind, args) {
  if (!isObj(args)) fail('ERR_INVALID', 'invalid request');
  const task = args.task;
  if (typeof task !== 'string' || !TASK_RE.test(task)) fail('ERR_INVALID', 'invalid task');
  let user = null;
  if (args.user != null) {
    user = Number(args.user);
    if (!Number.isSafeInteger(user) || user < 1) fail('ERR_INVALID', 'invalid user');
    if (!db().prepare('SELECT id FROM users WHERE id = ? AND enabled = 1').get(user)) fail('ERR_INVALID', 'invalid user');
  }
  const instructions = args.instructions == null ? '' : args.instructions;
  if (typeof instructions !== 'string') fail('ERR_INVALID', 'invalid instructions');
  if (!Array.isArray(args.input) || !args.input.length || args.input.length > LIMITS.inputs) fail('ERR_INVALID', 'invalid input');
  let chars = instructions.length;
  const input = [];
  let images = 0;
  for (const it of args.input) {
    if (!isObj(it)) fail('ERR_INVALID', 'invalid input');
    if (it.type === 'text') {
      if (typeof it.text !== 'string') fail('ERR_INVALID', 'invalid input text');
      if (it.label != null && (typeof it.label !== 'string' || it.label.length > LIMITS.labelChars)) fail('ERR_INVALID', 'invalid input label');
      chars += it.text.length + (it.label ? it.label.length : 0);
      if (it.text.length) input.push({ type: 'text', label: it.label || null, text: it.text });
    } else if (it.type === 'media') {
      if (typeof it.mediaId !== 'string' || !/^[0-9a-f]{32}$/.test(it.mediaId)) fail('ERR_INVALID', 'invalid mediaId');
      images++;
      input.push({ type: 'media', mediaId: it.mediaId });
    } else fail('ERR_INVALID', 'invalid input type');
  }
  if (chars > LIMITS.textChars) fail('ERR_INVALID', `input too long (more than ${LIMITS.textChars} characters)`);
  if (images > LIMITS.images) fail('ERR_INVALID', `more than ${LIMITS.images} pictures`);
  if (!input.length) fail('ERR_INVALID', 'empty input');
  const max = args.maxOutputTokens == null ? LIMITS.outputTokensDefault : args.maxOutputTokens;
  if (!Number.isSafeInteger(max) || max < 1 || max > LIMITS.outputTokensMax) fail('ERR_INVALID', 'invalid maxOutputTokens');
  const t = args.timeoutMs == null ? LIMITS.timeoutDefaultMs : args.timeoutMs;
  if (!Number.isFinite(t) || t < LIMITS.timeoutMinMs || t > LIMITS.timeoutMaxMs) fail('ERR_INVALID', 'invalid timeoutMs');
  let schema = null;
  if (kind === 'extract') {
    if (args.schema == null) fail('ERR_INVALID', 'schema required');
    try { schema = schemaLib.check(args.schema); } catch (e) { fail('ERR_INVALID', e.message); }
  } else if (args.schema != null) fail('ERR_INVALID', 'generate takes no schema');
  return { task, user, instructions, input, images, chars, maxOutputTokens: max, timeoutMs: Math.round(t), schema };
}

/** A picture of the plugin's media, read and scaled down by the host → { type: 'image', mime, data }. */
async function imagePart(plugin, mediaId) {
  const media = require('../plugins/media');
  if (!media.declOf(plugin)) fail('ERR_INVALID', 'plugin.json declares no media');
  const r = media.row(plugin.id, mediaId);
  if (!r) fail('ERR_INVALID', 'unknown mediaId');
  const mime = String(r.mime || '').toLowerCase();
  if (mime.startsWith('audio/') || mime.startsWith('video/')) fail('ERR_AI_CAPABILITY', 'sound and video are not supported yet');
  if (!IMAGE_TYPES.has(mime)) fail('ERR_INVALID', 'the media file is not a picture (JPEG, PNG, WebP, GIF)');
  if (r.bytes > LIMITS.imageBytes) fail('ERR_INVALID', 'picture larger than 10 MB');
  const parts = [];
  try {
    for await (const part of media.readRange(r, 0, r.bytes - 1)) parts.push(part);
  } catch { fail('ERR_INVALID', 'media file unreadable'); }
  let out;
  try {
    out = await require('sharp')(Buffer.concat(parts), { limitInputPixels: 100e6 })
      .rotate()
      .resize({ width: LIMITS.imagePx, height: LIMITS.imagePx, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 85 })
      .toBuffer();
  } catch { fail('ERR_INVALID', 'the picture cannot be read'); }
  return { type: 'image', mime: 'image/jpeg', data: out.toString('base64') };
}

/** JSON of an answer: as sent, or from a ```json block. */
function parseJson(text) {
  const s = String(text || '').trim();
  try { return { ok: true, value: JSON.parse(s) }; } catch { /* try a fenced block */ }
  const m = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  if (m) { try { return { ok: true, value: JSON.parse(m[1]) }; } catch { /* below */ } }
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return { ok: true, value: JSON.parse(s.slice(a, b + 1)) }; } catch { /* below */ } }
  return { ok: false };
}

/** Map a provider failure to the code of gc.ai. */
function providerFailure(e) {
  if (e instanceof AiError) return e;
  if (e instanceof http.ProviderError) {
    if (e.kind === 'timeout') return new AiError('ERR_TIMEOUT', 'the AI provider did not answer in time');
    return new AiError('ERR_AI_PROVIDER', e.message);
  }
  logger.warn({ err: e && e.message }, 'ai: request failed');
  return new AiError('ERR_AI_PROVIDER', 'the AI request failed');
}

/**
 * One provider: the call, for extract the schema check with one correction
 * round. → { text | data, usage, micro, estimated }; throws ProviderError / AiError.
 */
async function attempt(prov, req, parts, deadline, cfg) {
  const ad = providers.adapter(prov.id);
  const key = keyOf(prov.row);
  const model = prov.row.model_text;
  const price = priceOf(prov.id, prov.row, cfg);
  const structured = storedInfo(prov.row).structured !== false;
  const acc = { inputTokens: 0, outputTokens: 0, micro: 0, estimated: false };
  const once = async (extraParts) => {
    const left = deadline - Date.now();
    if (left <= 0) throw new http.ProviderError('timeout', 'no time left');
    const r = await ad.complete({ key, model, instructions: req.instructions || 'Follow the input.', parts: extraParts ? parts.concat(extraParts) : parts,
      schema: req.schema, maxOutputTokens: req.maxOutputTokens, timeoutMs: Math.min(req.timeoutMs, left), structured });
    acc.inputTokens += r.usage.inputTokens;
    acc.outputTokens += r.usage.outputTokens;
    if (r.costUsd != null) acc.micro += usdToMicro(r.costUsd, cfg.eurPerUsd);
    else {
      acc.micro += microOf(r.usage.inputTokens, r.usage.outputTokens, price, cfg.eurPerUsd);
      if (price.estimated) acc.estimated = true;
    }
    return r;
  };
  try {
    let r = await once(null);
    if (!req.schema) {
      if (Buffer.byteLength(r.text || '') > LIMITS.answerBytes) throw new AiError('ERR_AI_INVALID_OUTPUT', 'the answer is larger than 64 KB');
      return { text: r.text || '', ...acc };
    }
    for (let round = 0; round < 2; round++) {
      const j = parseJson(r.text);
      const v = j.ok ? schemaLib.validate(req.schema, j.value) : { ok: false, errors: [r.finish === 'length' ? 'the answer was cut off (maxOutputTokens)' : 'the answer is no JSON'] };
      if (v.ok) {
        if (Buffer.byteLength(JSON.stringify(v.value)) > LIMITS.answerBytes) throw new AiError('ERR_AI_INVALID_OUTPUT', 'the answer is larger than 64 KB');
        return { data: v.value, ...acc };
      }
      if (round === 1) throw new AiError('ERR_AI_INVALID_OUTPUT', `the answer did not match the schema: ${v.errors.slice(0, 3).join('; ')}`);
      r = await once([{ type: 'text', label: 'Correction',
        text: `Your previous answer did not match the JSON schema:\n- ${v.errors.join('\n- ')}\n\nPrevious answer:\n${String(r.text || '').slice(0, 20000)}\n\nAnswer again with corrected JSON only.` }]);
    }
    throw new AiError('ERR_AI_INVALID_OUTPUT', 'the answer did not match the schema');
  } catch (e) {
    e.usage = acc; // what the failed attempt cost is booked as well
    throw e;
  }
}

/**
 * gc.ai.extract / gc.ai.generate.
 * → extract { ok, data, provider, model, usage: { inputTokens, outputTokens, costCents }, fallback }
 *   generate { ok, text, provider, model, usage, fallback }
 */
async function request(plugin, kind, args) {
  if (!KINDS.has(kind)) fail('ERR_INVALID', 'unknown kind');
  const req = parseArgs(kind, args);
  const need = req.images ? ['text', 'vision'] : ['text'];
  const allowed = permitted(plugin, need);
  if (!allowed.ok) fail('ERR_AI_DENIED', allowed.why);
  if (!enabled()) fail('ERR_AI_NOT_CONFIGURED', 'the AI service is switched off on this server');
  const started = Date.now();
  const base = { plugin: plugin.id, user: req.user, task: req.task, kind, mediaCount: req.images };
  const refuse = (code, message, extra) => { book({ ...base, ...extra, outcome: code, durationMs: Date.now() - started }); fail(code, message); };
  const cfg = config();
  if (req.images && !cfg.mediaAllowed) refuse('ERR_AI_MEDIA_DISABLED', 'sending pictures to the AI provider is switched off');
  if (!takeRate(plugin.id, cfg.perHour)) refuse('ERR_RATE_LIMIT', `more than ${cfg.perHour} AI requests in an hour`);
  let r;
  try { r = route(plugin, need, cfg); } catch (e) { refuse(e.code, e.message); }
  const parts = [];
  for (const it of req.input) parts.push(it.type === 'media' ? await imagePart(plugin, it.mediaId) : it);
  // reserve: input ≈ characters ÷ 4 (+ pictures) plus maxOutputTokens, at the dearer of the two providers
  const tokensIn = Math.ceil(req.chars / 4) + req.images * IMAGE_TOKENS_ESTIMATE;
  const estimate = Math.max(...[r.primary, r.fallback].filter(Boolean)
    .map((p) => microOf(tokensIn, req.maxOutputTokens, priceOf(p.id, p.row, cfg), cfg.eurPerUsd)));
  if (usedMicro() + reservedMicro() + estimate > cfg.budgetCents * 1e6) {
    budgetNotice(cfg, true);
    refuse('ERR_AI_BUDGET', 'the monthly AI budget of this server is used up', { provider: r.primary.id, model: r.primary.row.model_text });
  }
  const rid = ++reservationSeq;
  reservations.set(rid, estimate);
  const deadline = started + 2 * req.timeoutMs;
  let used = r.primary;
  let fallback = false;
  let spent = { inputTokens: 0, outputTokens: 0, micro: 0, estimated: false };
  const add = (u) => {
    if (!u) return;
    spent = { inputTokens: spent.inputTokens + u.inputTokens, outputTokens: spent.outputTokens + u.outputTokens, micro: spent.micro + u.micro, estimated: spent.estimated || u.estimated };
  };
  try {
    let out;
    try {
      out = await attempt(r.primary, req, parts, deadline, cfg);
    } catch (e) {
      add(e.usage);
      e.usageBooked = true;
      if (!(e instanceof http.ProviderError) || !e.retryable || !r.fallback) throw e;
      used = r.fallback;
      fallback = true;
      out = await attempt(r.fallback, req, parts, deadline, cfg);
    }
    add(out);
    const result = {
      ok: true,
      ...(kind === 'extract' ? { data: out.data } : { text: out.text }),
      provider: used.id,
      model: used.row.model_text,
      usage: { inputTokens: spent.inputTokens, outputTokens: spent.outputTokens, costCents: centsOf(spent.micro) },
      fallback,
    };
    book({ ...base, provider: used.id, model: used.row.model_text, ...spent, outcome: 'ok', fallback, durationMs: Date.now() - started });
    return result;
  } catch (e) {
    if (!e.usageBooked) add(e.usage);
    const err = providerFailure(e);
    book({ ...base, provider: used.id, model: used.row.model_text, ...spent, outcome: err.code, fallback, durationMs: Date.now() - started });
    throw err;
  } finally {
    reservations.delete(rid);
    try { budgetNotice(config()); } catch (e) { logger.warn({ err: e.message }, 'ai: budget notice failed'); }
  }
}

// ─── Admin view ─────────────────────────────────

function view() {
  const cfg = config();
  return {
    enabled: enabled(),
    providers: providers.IDS.map(providerView),
    defaults: { provider: cfg.defaultProvider, fallback: cfg.fallbackProvider },
    mediaAllowed: cfg.mediaAllowed,
    perHour: cfg.perHour,
    eurPerUsd: cfg.eurPerUsd,
    priceOverrides: cfg.priceOverrides,
    budget: { cents: cfg.budgetCents, usedCents: centsOf(usedMicro()), month: monthKey() },
  };
}

// ─── Backup (services/backup.js) ────────────────

/** Providers (keys stay encrypted, as stored) and the plugin policy. */
function exportBackup() {
  try {
    return {
      providers: db().prepare('SELECT * FROM ai_providers ORDER BY id').all(),
      policy: db().prepare('SELECT * FROM ai_plugin_policy ORDER BY plugin_id').all(),
    };
  } catch { return null; }
}

/** Restore inside the restore transaction. A key of another server key reads "enter the key again". */
function restoreBackup(d) {
  if (!isObj(d)) return 0;
  const q = db();
  q.prepare('DELETE FROM ai_providers').run();
  q.prepare('DELETE FROM ai_plugin_policy').run();
  let n = 0;
  const insP = q.prepare(`INSERT INTO ai_providers (id, enabled, key_encrypted, key_hint, model_text, model_audio, capabilities, model_info, checked_at, check_error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const p of Array.isArray(d.providers) ? d.providers : []) {
    if (!p || !providers.IDS.includes(p.id)) continue;
    const str = (v, max) => (typeof v === 'string' && v.length <= max ? v : null);
    insP.run(p.id, p.enabled ? 1 : 0, str(p.key_encrypted, 2000), str(p.key_hint, 8), str(p.model_text, 200), str(p.model_audio, 200),
      str(p.capabilities, 200), str(p.model_info, 1000), Number.isSafeInteger(p.checked_at) ? p.checked_at : null, str(p.check_error, 300));
    n++;
  }
  const insQ = q.prepare('INSERT INTO ai_plugin_policy (plugin_id, allowed, provider) VALUES (?, ?, ?)');
  for (const p of Array.isArray(d.policy) ? d.policy : []) {
    if (!p || typeof p.plugin_id !== 'string' || p.plugin_id.length > 64) continue;
    insQ.run(p.plugin_id, p.allowed ? 1 : 0, providers.IDS.includes(p.provider) ? p.provider : null);
    n++;
  }
  modelCache.clear();
  return n;
}

// ─── Lifecycle ──────────────────────────────────

let timer = null;

function start() {
  if (timer) return;
  prune();
  timer = setInterval(() => prune(), 6 * 3600000);
  timer.unref();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

function _resetForTest() {
  if (process.env.NODE_ENV !== 'test') return;
  windows.clear();
  reservations.clear();
}

module.exports = {
  enabled, config, saveSettings, view, providerView, setProvider, testProvider, pluginsList, setPolicy, policyOf, onInstalled, forgetPlugin,
  available, status, request, usage, requestsLog, prune, start, stop, exportBackup, restoreBackup, monthStart, cleanOverrides,
  AiError, LIMITS, SUPPORTED_CAPS, ALL_CAPS, K, _resetForTest, _testBase: http.testBase,
};
