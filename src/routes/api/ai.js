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

module.exports = router;
