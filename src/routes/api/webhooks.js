'use strict';

const { Router } = require('express');
const webhooks = require('../../services/webhook');
const logger = require('../../utils/logger');

const router = Router();

/**
 * GET /api/webhooks — List all webhooks
 */
router.get('/', (req, res) => {
  try {
    const list = webhooks.getAll();
    res.json({ ok: true, webhooks: list });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to list webhooks');
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * POST /api/webhooks — Create webhook
 */
router.post('/', (req, res) => {
  try {
    const { url, events, description } = req.body;
    const wh = webhooks.create({ url, events, description });
    res.status(201).json({ ok: true, webhook: wh });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to create webhook');
    const status = err.message.includes('required') || err.message.includes('Invalid') ? 400 : 500;
    res.status(status).json({ ok: false, error: err.message });
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
    const status = err.message.includes('not found') ? 404 : err.message.includes('required') || err.message.includes('Invalid') ? 400 : 500;
    res.status(status).json({ ok: false, error: err.message });
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
    const status = err.message.includes('not found') ? 404 : 500;
    res.status(status).json({ ok: false, error: err.message });
  }
});

/**
 * POST /api/webhooks/:id/toggle — Toggle webhook
 */
router.post('/:id/toggle', (req, res) => {
  try {
    const wh = webhooks.toggle(req.params.id);
    res.json({ ok: true, webhook: wh });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to toggle webhook');
    const status = err.message.includes('not found') ? 404 : 500;
    res.status(status).json({ ok: false, error: err.message });
  }
});

/**
 * POST /api/webhooks/:id/test — Send a test notification
 */
router.post('/:id/test', async (req, res) => {
  try {
    const wh = webhooks.getById(req.params.id);
    if (!wh) return res.status(404).json({ ok: false, error: 'Webhook not found' });

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
    res.status(502).json({ ok: false, error: err.message });
  }
});

module.exports = router;
