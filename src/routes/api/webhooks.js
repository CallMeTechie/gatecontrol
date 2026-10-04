'use strict';

const { Router } = require('express');
const webhooks = require('../../services/webhook');
const logger = require('../../utils/logger');
const resolveError = require('../../utils/resolveError');
const { requireFeature } = require('../../middleware/license');
const { hasFeature } = require('../../services/license');

const router = Router();

/** Map service-layer error messages to i18n keys */
const VALIDATION_ERROR_MAP = {
  'not found': 'error.webhooks.not_found',
  'URL is required': 'error.webhooks.url_required',
  'Invalid webhook URL': 'error.webhooks.url_invalid',
  'must use http': 'error.webhooks.url_protocol',
  'must not target localhost': 'error.webhooks.url_localhost',
  'must not target private': 'error.webhooks.url_private',
  'resolves to a private': 'error.webhooks.url_private',
  'could not be resolved': 'error.webhooks.url_dns',
  'redirect limit': 'error.webhooks.url_redirects',
  'Invalid webhook events': 'error.webhooks.events_invalid',
  'description too long': 'error.webhooks.description_too_long',
};

/**
 * GET /api/webhooks — List all webhooks
 */
router.get('/', (req, res) => {
  try {
    const list = webhooks.getAll();
    res.json({ ok: true, webhooks: list });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to list webhooks');
    res.status(500).json({ ok: false, error: req.t('error.webhooks.list') });
  }
});

/**
 * POST /api/webhooks — Create webhook
 * Body: { url, description?, events?: '*' | [types] | 'a,b', enabled? }
 */
router.post('/', requireFeature('webhooks'), (req, res) => {
  try {
    const { url, events, description, enabled } = req.body;
    const wh = webhooks.create({ url, events, description, enabled });
    res.status(201).json({ ok: true, webhook: wh });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to create webhook');
    const { status, error } = resolveError(req, err, VALIDATION_ERROR_MAP, 'error.webhooks.create');
    res.status(status).json({ ok: false, error });
  }
});

/**
 * PUT /api/webhooks/:id — Update webhook
 * Existing webhooks stay manageable without the licence (events, description,
 * pause, delete — nobody is stuck with a hook after a downgrade). A new target
 * URL is a new webhook in all but name, so changing it needs the licence like
 * POST does.
 */
router.put('/:id', (req, res) => {
  try {
    const { url, events, description, enabled } = req.body;
    const current = webhooks.getById(req.params.id);
    if (current && url !== undefined && String(url).trim() !== current.url && !hasFeature('webhooks')) {
      return res.status(403).json({
        ok: false,
        error: req.t('error.license.feature_not_available'),
        feature: 'webhooks',
        upgrade_url: 'https://callmetechie.de/products/gatecontrol/pricing',
      });
    }
    const wh = webhooks.update(req.params.id, { url, events, description, enabled });
    res.json({ ok: true, webhook: wh });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to update webhook');
    const { status, error } = resolveError(req, err, VALIDATION_ERROR_MAP, 'error.webhooks.update');
    res.status(status).json({ ok: false, error });
  }
});

/**
 * DELETE /api/webhooks/:id — Delete webhook
 */
router.delete('/:id', (req, res) => {
  try {
    webhooks.remove(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to delete webhook');
    const { status, error } = resolveError(req, err, VALIDATION_ERROR_MAP, 'error.webhooks.delete');
    res.status(status).json({ ok: false, error });
  }
});

/**
 * PUT /api/webhooks/:id/toggle — Toggle webhook
 */
router.put('/:id/toggle', (req, res) => {
  try {
    const wh = webhooks.toggle(req.params.id);
    res.json({ ok: true, webhook: wh });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to toggle webhook');
    const { status, error } = resolveError(req, err, VALIDATION_ERROR_MAP, 'error.webhooks.toggle');
    res.status(status).json({ ok: false, error });
  }
});

/**
 * POST /api/webhooks/:id/test — Send a test notification
 */
router.post('/:id/test', async (req, res) => {
  try {
    const wh = webhooks.getById(req.params.id);
    if (!wh) return res.status(404).json({ ok: false, error: req.t('error.webhooks.not_found') });

    const payload = JSON.stringify({
      event: 'webhook_test',
      message: 'This is a test notification from GateControl',
      details: { webhookId: wh.id },
      timestamp: new Date().toISOString(),
    });

    // Same guarded path as regular delivery: DNS pinned to the validated
    // address, redirects re-validated hop by hop, timeout + size limit.
    const response = await webhooks.deliver(wh.url, payload, { timeoutMs: 10000 });

    res.json({ ok: true, status: response.status, statusText: response.statusText });
  } catch (err) {
    logger.error({ error: err.message }, 'Webhook test failed');
    const { status, error } = resolveError(req, err, VALIDATION_ERROR_MAP, 'error.webhooks.test');
    res.status(status).json({ ok: false, error });
  }
});

module.exports = router;
