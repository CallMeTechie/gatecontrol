'use strict';

/**
 * Admin API of the AI service (docs/plugins.md "AI requests", services/ai/).
 * Admin session only, like the plugin catalogue: API tokens and member
 * sessions get 403. CSRF and the API limiter come from the /api/v1 router.
 * Keys are write-only: answers carry keyHint (last four characters) only.
 *
 *   GET  /api/v1/ai                     settings, providers, budget
 *   PUT  /api/v1/ai/providers/:id       { key?, enabled?, modelText?, modelAudio? }   key '' deletes it
 *   POST /api/v1/ai/providers/:id/test  → { ok, models: [{ id, name, capabilities }] } | { ok: false, code, message }
 *   PUT  /api/v1/ai/settings            { defaultProvider, fallbackProvider, mediaAllowed, budgetCents, eurPerUsd, perHour, priceOverrides }
 *   GET  /api/v1/ai/plugins             plugins with permissions.ai and their policy
 *   PUT  /api/v1/ai/plugins/:id         { allowed, provider }   provider null = the default one
 *   GET  /api/v1/ai/usage?month=2026-10 sums by plugin, provider, day
 *   GET  /api/v1/ai/requests?plugin=&limit=  the log (metadata only)
 *
 * The local AI (phase 3c, step 3 — services/ai/local.js):
 *   GET  /api/v1/ai/local                     setup: gateways (memory, cores, GPU, hint), catalogue with fit, current choice, use
 *   PUT  /api/v1/ai/local                     { source, peerId, model, lanUrl?, lanApi? }   switches it on at that gateway
 *   PUT  /api/v1/ai/local/use                 { use: all | private | fallback }
 *   PUT  /api/v1/ai/local/enabled             { enabled }
 *   GET  /api/v1/ai/local/status?peer=        live from the gateway (models, download, loaded model)
 *   POST /api/v1/ai/local/pull                { peerId, model }   "Modell laden" (progress through status)
 *   POST /api/v1/ai/local/pull/cancel         { peerId }
 *   POST /api/v1/ai/local/delete              { peerId, model }
 *   POST /api/v1/ai/local/test                "Testen: „Fasse diese Mail zusammen“"
 *   POST /api/v1/ai/local/probe               { peerId, lanUrl, lanApi?, lanKey? }   "Verbindung testen" (LAN server, nothing saved)
 */

const express = require('express');
const { requireAdminSession } = require('../../middleware/auth');
const ai = require('../../services/ai');
const logger = require('../../utils/logger');

const router = express.Router();
router.use(requireAdminSession);

function tr(req, key, fallback, params) {
  const s = req.t ? req.t(key, params) : key;
  return s && s !== key ? s : fallback;
}

function body(req) { return req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}; }

function lang(req) { return req.language === 'en' ? 'en' : 'de'; }

function fail(req, res, e) {
  const code = e && e.code;
  if (code === 'ERR_INVALID') {
    const field = String(e.message || '').replace(/[^A-Za-z]/g, '') || null;
    return res.status(400).json({ ok: false, code: 'invalid', field, error: tr(req, `ai.err.field_${field}`, tr(req, 'ai.err.invalid', 'Invalid input')) });
  }
  if (code === 'ERR_NOT_FOUND') return res.status(404).json({ ok: false, code: 'not_found', error: tr(req, 'ai.err.not_found', 'Not found') });
  if (e instanceof ai.local.LocalError) {
    // the local AI: what the gateway said, as a code the page translates
    if (code === 'invalid' || code === 'invalid_host') {
      const field = code === 'invalid_host' ? 'lanUrl' : (String(e.message || '').replace(/[^A-Za-z]/g, '') || null);
      return res.status(400).json({ ok: false, code: 'invalid', field, error: tr(req, `ai.local.err.field_${field}`, tr(req, 'ai.err.invalid', 'Invalid input')) });
    }
    const status = code === 'not_found' ? 404 : (code === 'gateway_unreachable' || code === 'gateway_error' || code === 'failed' ? 502 : 409);
    return res.status(status).json({ ok: false, code, error: tr(req, `ai.local.err.${code}`, String(e.message || code)) });
  }
  logger.warn({ err: e && e.message }, 'ai admin request failed');
  return res.status(500).json({ ok: false, code: 'internal', error: tr(req, 'ai.err.internal', 'Internal error') });
}

router.get('/', (req, res) => {
  try { res.json({ ok: true, ...ai.view() }); } catch (e) { fail(req, res, e); }
});

router.put('/providers/:id', (req, res) => {
  try {
    res.json({ ok: true, provider: ai.setProvider(String(req.params.id), body(req), { ip: req.ip }) });
  } catch (e) { fail(req, res, e); }
});

router.post('/providers/:id/test', async (req, res) => {
  try {
    const r = await ai.testProvider(String(req.params.id));
    if (!r.ok) return res.json({ ok: false, code: r.code, message: r.message, error: tr(req, `ai.test.err_${r.code}`, r.message) });
    res.json({ ok: true, models: r.models, provider: ai.providerView(String(req.params.id)) });
  } catch (e) { fail(req, res, e); }
});

router.put('/settings', (req, res) => {
  try {
    ai.saveSettings(body(req), { ip: req.ip });
    res.json({ ok: true, ...ai.view() });
  } catch (e) { fail(req, res, e); }
});

router.get('/plugins', (req, res) => {
  try { res.json({ ok: true, plugins: ai.pluginsList(lang(req)) }); } catch (e) { fail(req, res, e); }
});

router.put('/plugins/:id', (req, res) => {
  try {
    res.json({ ok: true, plugin: ai.setPolicy(String(req.params.id), body(req), { ip: req.ip, lang: lang(req) }) });
  } catch (e) { fail(req, res, e); }
});

router.get('/usage', (req, res) => {
  try { res.json({ ok: true, usage: ai.usage(typeof req.query.month === 'string' ? req.query.month : undefined) }); } catch (e) { fail(req, res, e); }
});

router.get('/requests', (req, res) => {
  try {
    const plugin = typeof req.query.plugin === 'string' && req.query.plugin ? req.query.plugin.slice(0, 64) : null;
    res.json({ ok: true, requests: ai.requestsLog({ plugin, limit: req.query.limit }) });
  } catch (e) { fail(req, res, e); }
});

// ─── The local AI ───────────────────────────────
const L = () => ai.local;
function who(req) {
  try {
    const u = require('../../services/users').getById(req.session.userId);
    return u ? u.username : null;
  } catch { return null; }
}
const peerOf = (v) => { const n = Number(v); return Number.isSafeInteger(n) && n > 0 ? n : null; };

router.get('/local', (req, res) => {
  try { res.json({ ok: true, ...L().view() }); } catch (e) { fail(req, res, e); }
});

router.put('/local', (req, res) => {
  try {
    const r = L().setup(body(req), { ip: req.ip, user: who(req) });
    res.json({ ok: true, ...r, ...L().view() });
  } catch (e) { fail(req, res, e); }
});

router.put('/local/use', (req, res) => {
  try { L().setUse(body(req).use, { ip: req.ip }); res.json({ ok: true, ...ai.view() }); } catch (e) { fail(req, res, e); }
});

router.put('/local/enabled', (req, res) => {
  try { res.json({ ok: true, provider: L().setEnabled(body(req).enabled, { ip: req.ip }) }); } catch (e) { fail(req, res, e); }
});

router.get('/local/status', async (req, res) => {
  try {
    const id = peerOf(req.query.peer) || L().peerId();
    if (!id) return res.json({ ok: true, status: null });
    const status = await L().liveStatus(id);
    res.json({ ok: true, status, online: !!status });
  } catch (e) { fail(req, res, e); }
});

router.post('/local/pull', async (req, res) => {
  try {
    const b = body(req);
    await L().pull(peerOf(b.peerId), b.model, { ip: req.ip });
    res.status(202).json({ ok: true });
  } catch (e) { fail(req, res, e); }
});

router.post('/local/pull/cancel', async (req, res) => {
  try { await L().cancelPull(peerOf(body(req).peerId), { ip: req.ip }); res.status(202).json({ ok: true }); } catch (e) { fail(req, res, e); }
});

router.post('/local/delete', async (req, res) => {
  try {
    const b = body(req);
    await L().removeModel(peerOf(b.peerId), b.model, { ip: req.ip });
    res.json({ ok: true });
  } catch (e) { fail(req, res, e); }
});

router.post('/local/probe', async (req, res) => {
  try { res.json({ ok: true, probe: await L().probe(body(req)) }); } catch (e) { fail(req, res, e); }
});

router.post('/local/test', async (req, res) => {
  try {
    const r = await ai.testLocal({ lang: lang(req) });
    if (!r.ok) return res.json({ ok: false, code: r.code, error: tr(req, `ai.local.test.err_${r.code}`, r.message) });
    res.json(r);
  } catch (e) { fail(req, res, e); }
});

module.exports = router;
