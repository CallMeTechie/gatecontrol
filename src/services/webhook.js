'use strict';

const { getDb } = require('../db/connection');
const logger = require('../utils/logger');
const outbound = require('../utils/outboundGuard');
const { parseWebhookEvents, webhookReceives } = require('./notifications');

const MAX_PAYLOAD_BYTES = 64 * 1024; // 64 KB
const MAX_RESPONSE_BYTES = 64 * 1024; // Antwort wird nur fürs Logging/Test gelesen

function webhookConfig() {
  const cfg = require('../../config/default');
  return {
    allowPrivate: !!(cfg.webhooks && cfg.webhooks.allowPrivate),
    maxRedirects: cfg.webhooks ? cfg.webhooks.maxRedirects : 3,
    timeoutMs: cfg.timeouts.webhookDelivery,
  };
}

/**
 * Validate webhook URL at save time (no DNS): must be http(s) and not an
 * IP literal / localhost name in a blocked range. Authoritative check is
 * the one at delivery time (deliver()), which resolves DNS, pins the
 * connection to the validated address and re-validates every redirect.
 */
function validateWebhookUrl(urlStr) {
  return outbound.validateUrlSyntax(urlStr, { allowPrivate: webhookConfig().allowPrivate });
}

/**
 * Resolve hostname and verify all IPs are allowed (fails closed on DNS errors).
 */
async function validateResolvedIps(hostname) {
  return outbound.resolveAndValidate(hostname, { allowPrivate: webhookConfig().allowPrivate });
}

/**
 * POST a JSON payload to a webhook URL through the outbound guard.
 * Resolves to { status, statusText, ... }; rejects with OutboundUrlError
 * when the target (or a redirect hop) is not allowed.
 */
async function deliver(url, payload, { timeoutMs } = {}) {
  const cfg = webhookConfig();
  return outbound.safeRequest(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'GateControl-Webhook' },
    body: payload,
    timeoutMs: timeoutMs || cfg.timeoutMs,
    maxBytes: MAX_RESPONSE_BYTES,
    maxRedirects: cfg.maxRedirects,
    allowPrivate: cfg.allowPrivate,
  });
}

/**
 * Get all configured webhooks
 */
function getAll() {
  const db = getDb();
  return db.prepare('SELECT * FROM webhooks ORDER BY created_at ASC').all();
}

/**
 * Get a single webhook by ID
 */
function getById(id) {
  const db = getDb();
  return db.prepare('SELECT * FROM webhooks WHERE id = ?').get(id);
}

const MAX_DESCRIPTION = 255;

function cleanDescription(d) {
  const s = d == null ? '' : String(d).trim();
  if (s.length > MAX_DESCRIPTION) throw new Error('Webhook description too long');
  return s || null;
}

/**
 * Create a new webhook. `events`: '*' / omitted = every event, otherwise a
 * list (array or comma string) of catalogue event types
 * (services/notifications.js) — anything else is rejected.
 */
function create({ url, events, description, enabled }) {
  const db = getDb();

  if (!url || typeof url !== 'string') throw new Error('Webhook URL is required');
  validateWebhookUrl(url);

  const eventsStr = parseWebhookEvents(events === '' ? null : events);
  const desc = cleanDescription(description);

  const result = db.prepare(`
    INSERT INTO webhooks (url, events, description, enabled)
    VALUES (?, ?, ?, ?)
  `).run(url.trim(), eventsStr, desc, enabled === false ? 0 : 1);

  return getById(result.lastInsertRowid);
}

/**
 * Update a webhook
 */
function update(id, data) {
  const db = getDb();
  const webhook = getById(id);
  if (!webhook) throw new Error('Webhook not found');

  if (data.url !== undefined) {
    if (!data.url || typeof data.url !== 'string') throw new Error('Webhook URL is required');
    validateWebhookUrl(data.url);
  }
  const events = data.events !== undefined ? parseWebhookEvents(data.events) : null;
  const description = data.description !== undefined ? cleanDescription(data.description) : undefined;

  // description: '' clears it (a plain COALESCE would keep the old one).
  db.prepare(`
    UPDATE webhooks SET
      url = COALESCE(?, url),
      events = COALESCE(?, events),
      description = CASE WHEN ? = 1 THEN ? ELSE description END,
      enabled = COALESCE(?, enabled),
      updated_at = datetime('now')
    WHERE id = ?
  `).run(
    data.url ? data.url.trim() : null,
    events,
    description !== undefined ? 1 : 0,
    description === undefined ? null : description,
    data.enabled !== undefined ? (data.enabled ? 1 : 0) : null,
    id
  );

  return getById(id);
}

/**
 * Delete a webhook
 */
function remove(id) {
  const db = getDb();
  const webhook = getById(id);
  if (!webhook) throw new Error('Webhook not found');
  db.prepare('DELETE FROM webhooks WHERE id = ?').run(id);
}

/**
 * Toggle webhook enabled/disabled
 */
function toggle(id) {
  const db = getDb();
  const webhook = getById(id);
  if (!webhook) throw new Error('Webhook not found');
  const newState = webhook.enabled ? 0 : 1;
  db.prepare("UPDATE webhooks SET enabled = ?, updated_at = datetime('now') WHERE id = ?").run(newState, id);
  return getById(id);
}

/**
 * Send notification to all matching webhooks (fire-and-forget)
 */
async function notify(eventType, message, details = null) {
  let webhooks;
  try {
    const db = getDb();
    webhooks = db.prepare('SELECT * FROM webhooks WHERE enabled = 1').all();
  } catch {
    return; // DB not ready yet
  }

  if (!webhooks || webhooks.length === 0) return;

  let truncatedDetails = details;
  const payload = JSON.stringify({
    event: eventType,
    message,
    details,
    timestamp: new Date().toISOString(),
  });

  let finalPayload = payload;
  if (Buffer.byteLength(payload, 'utf8') > MAX_PAYLOAD_BYTES) {
    // Truncate details to fit within limit
    truncatedDetails = typeof details === 'object' && details !== null
      ? { _truncated: true, _originalKeys: Object.keys(details) }
      : null;
    finalPayload = JSON.stringify({
      event: eventType,
      message,
      details: truncatedDetails,
      timestamp: new Date().toISOString(),
    });
    logger.warn({ event: eventType, originalSize: Buffer.byteLength(payload, 'utf8') }, 'Webhook payload truncated');
  }

  for (const wh of webhooks) {
    // Only the webhooks that subscribe to this event ('*' = all).
    if (!webhookReceives(wh.events, eventType)) continue;

    // Fire-and-forget — don't block the caller. deliver() validates the
    // URL, resolves + pins DNS and re-checks every redirect hop.
    module.exports.deliver(wh.url, finalPayload).then((res) => {
      if (res.status < 200 || res.status >= 300) {
        logger.warn({ webhookId: wh.id, status: res.status, url: wh.url }, 'Webhook delivery failed');
      }
    }).catch((err) => {
      if (err instanceof outbound.OutboundUrlError) {
        logger.warn({ webhookId: wh.id, url: wh.url, reason: err.message }, 'Webhook blocked by outbound URL guard');
      } else {
        logger.warn({ webhookId: wh.id, error: err.message, url: wh.url }, 'Webhook delivery error');
      }
    });
  }
}

module.exports = {
  getAll,
  getById,
  create,
  update,
  remove,
  toggle,
  notify,
  validateWebhookUrl,
  validateResolvedIps,
  deliver,
};
