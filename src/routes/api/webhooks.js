'use strict';

const { Router } = require('express');
const webhooks = require('../../services/webhook');
const { validateWebhookUrl, validateResolvedIps } = webhooks;
const logger = require('../../utils/logger');
const resolveError = require('../../utils/resolveError');
const { requireFeature } = require('../../middleware/license');

const router = Router();

/** Map service-layer error messages to i18n keys */
const VALIDATION_ERROR_MAP = {
  'not found': 'error.webhooks.not_found',
  'URL is required': 'error.webhooks.url_required',
  'Invalid webhook URL': 'error.webhooks.url_invalid',
  'must use http': 'error.webhooks.url_protocol',
  'must not target localhost': 'error.webhooks.url_localhost',
  'must not target private': 'error.webhooks.url_private',
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
 */
router.post('/', requireFeature('webhooks'), (req, res) => {
  try {
    const { url, events, description } = req.body;
    const wh = webhooks.create({ url, events, description });
    res.status(201).json({ ok: true, webhook: wh });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to create webhook');
    const { status, error } = resolveError(req, err, VALIDATION_ERROR_MAP, 'error.webhooks.create');
    res.status(status).json({ ok: false, error });
  }
});

/**
 * PUT /api/webhooks/:id — Update webhook
 */
router.put('/:id', (req, res) => {
  try {
    const { url, events, description, enabled } = req.body;
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

    validateWebhookUrl(wh.url);
    // Block SSRF / DNS-rebinding: the regular notify() path calls
    // validateResolvedIps before fetch, but the test endpoint had
    // skipped this, so an admin-created webhook pointing at evil.com
    // could resolve to 127.0.0.1 and POST into local services.
    await validateResolvedIps(new URL(wh.url).hostname);

    const payload = JSON.stringify({
      event: 'webhook_test',
      message: 'This is a test notification from GateControl',
      details: { webhookId: wh.id },
      timestamp: new Date().toISOString(),
    });

    const response = await fetch(wh.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      signal: AbortSignal.timeout(10000),
    });

    res.json({ ok: true, status: response.status, statusText: response.statusText });
  } catch (err) {
    logger.error({ error: err.message }, 'Webhook test failed');
    const { status, error } = resolveError(req, err, VALIDATION_ERROR_MAP, 'error.webhooks.test');
    res.status(status).json({ ok: false, error });
  }
});

module.exports = router;
