'use strict';

const dns = require('node:dns');
const { getDb } = require('../db/connection');
const logger = require('../utils/logger');

const MAX_PAYLOAD_BYTES = 64 * 1024; // 64 KB

/**
 * Validate webhook URL: must be http(s) and not target private/internal networks
 */
function validateWebhookUrl(urlStr) {
  let parsed;
  try { parsed = new URL(urlStr); } catch { throw new Error('Invalid webhook URL'); }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Webhook URL must use http or https');
  }

  const hostname = parsed.hostname.toLowerCase();

  // Block loopback
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1') {
    throw new Error('Webhook URL must not target localhost');
  }

  // Block private/reserved IPv6 ranges
  const bare = hostname.replace(/^\[|\]$/g, '');
  if (bare.startsWith('fc') || bare.startsWith('fd') ||    // fc00::/7 ULA
      bare.startsWith('fe80') ||                            // fe80::/10 link-local
      bare.startsWith('::ffff:')) {                         // IPv4-mapped IPv6
    throw new Error('Webhook URL must not target private or reserved IP addresses');
  }

  // Block private/reserved IPv4 ranges
  const ipv4Match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const [, a, b] = ipv4Match.map(Number);
    if (a === 10 ||                          // 10.0.0.0/8
        (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12
        (a === 192 && b === 168) ||           // 192.168.0.0/16
        (a === 169 && b === 254) ||           // 169.254.0.0/16 (link-local, cloud metadata)
        (a === 100 && b >= 64 && b <= 127) || // 100.64.0.0/10 (CGNAT / shared address space)
        a === 127 ||                          // 127.0.0.0/8
        a === 0) {                            // 0.0.0.0/8
      throw new Error('Webhook URL must not target private or reserved IP addresses');
    }
  }

  return parsed;
}

/**
 * Check if an IP address is private/reserved (used for DNS rebinding protection)
 */
function isPrivateIp(ip) {
  const match = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (match) {
    const [, a, b] = match.map(Number);
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
           (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127) ||
           a === 127 || a === 0;
  }
  // IPv6 private ranges
  const bare = ip.toLowerCase().replace(/^\[|\]$/g, '');
  return bare === '::1' || bare.startsWith('fc') || bare.startsWith('fd') ||
         bare.startsWith('fe80') || bare.startsWith('::ffff:');
}

/**
 * Resolve hostname and verify all IPs are public (DNS rebinding protection)
 */
async function validateResolvedIps(hostname) {
  // Skip validation for direct IP addresses (already checked by validateWebhookUrl)
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) return;
  if (hostname.startsWith('[') || hostname === '::1') return;

  try {
    const addresses = await dns.promises.resolve4(hostname).catch(() => []);
    const addresses6 = await dns.promises.resolve6(hostname).catch(() => []);
    const allAddresses = [...addresses, ...addresses6];

    for (const addr of allAddresses) {
      if (isPrivateIp(addr)) {
        throw new Error('Webhook URL resolves to a private or reserved IP address');
      }
    }
  } catch (err) {
    if (err.message.includes('private or reserved')) throw err;
    // DNS resolution failure — allow the request (may be a temporary DNS issue)
  }
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

/**
 * Create a new webhook
 */
function create({ url, events, description }) {
  const db = getDb();

  if (!url || typeof url !== 'string') throw new Error('Webhook URL is required');
  validateWebhookUrl(url);

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
    validateWebhookUrl(data.url);
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
    // Check if webhook subscribes to this event
    if (wh.events !== '*') {
      const subscribed = wh.events.split(',').map(e => e.trim());
      if (!subscribed.includes(eventType)) continue;
    }

    // Validate URL before making request (guards against pre-existing unsafe URLs)
    try { validateWebhookUrl(wh.url); } catch { continue; }

    // DNS rebinding protection: re-validate resolved IPs at request time
    try { await validateResolvedIps(new URL(wh.url).hostname); } catch {
      logger.warn({ webhookId: wh.id, url: wh.url }, 'Webhook blocked: DNS resolves to private IP');
      continue;
    }

    // Fire-and-forget — don't block the caller
    fetch(wh.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: finalPayload,
      signal: AbortSignal.timeout(require('../../config/default').timeouts.webhookDelivery),
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
  validateWebhookUrl,
};
