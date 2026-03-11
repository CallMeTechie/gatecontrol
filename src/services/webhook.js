'use strict';

const { getDb } = require('../db/connection');
const logger = require('../utils/logger');

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

/**
 * Create a new webhook
 */
function create({ url, events, description }) {
  const db = getDb();

  if (!url || typeof url !== 'string') throw new Error('Webhook URL is required');
  try { new URL(url); } catch { throw new Error('Invalid webhook URL'); }

  const eventsStr = Array.isArray(events) ? events.join(',') : (events || '*');
  const desc = description || null;

  const result = db.prepare(`
    INSERT INTO webhooks (url, events, description, enabled)
    VALUES (?, ?, ?, 1)
  `).run(url.trim(), eventsStr, desc);

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
    if (!data.url) throw new Error('Webhook URL is required');
    try { new URL(data.url); } catch { throw new Error('Invalid webhook URL'); }
  }

  db.prepare(`
    UPDATE webhooks SET
      url = COALESCE(?, url),
      events = COALESCE(?, events),
      description = COALESCE(?, description),
      enabled = COALESCE(?, enabled),
      updated_at = datetime('now')
    WHERE id = ?
  `).run(
    data.url || null,
    data.events !== undefined ? (Array.isArray(data.events) ? data.events.join(',') : data.events) : null,
    data.description !== undefined ? (data.description || null) : null,
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

  const payload = JSON.stringify({
    event: eventType,
    message,
    details,
    timestamp: new Date().toISOString(),
  });

  for (const wh of webhooks) {
    // Check if webhook subscribes to this event
    if (wh.events !== '*') {
      const subscribed = wh.events.split(',').map(e => e.trim());
      if (!subscribed.includes(eventType)) continue;
    }

    // Fire-and-forget — don't block the caller
    fetch(wh.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      signal: AbortSignal.timeout(10000),
    }).then(res => {
      if (!res.ok) {
        logger.warn({ webhookId: wh.id, status: res.status, url: wh.url }, 'Webhook delivery failed');
      }
    }).catch(err => {
      logger.warn({ webhookId: wh.id, error: err.message, url: wh.url }, 'Webhook delivery error');
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
};
