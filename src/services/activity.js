'use strict';

const { getDb } = require('../db/connection');
const webhook = require('./webhook');
const logger = require('../utils/logger');
const eventBus = require('./eventBus');

const IP_V4_REGEX = /^(\d{1,3}\.){3}\d{1,3}$/;
const IP_V6_REGEX = /^[0-9a-fA-F:]+$/;

function sanitizeIp(ip) {
  if (!ip || typeof ip !== 'string') return null;
  const trimmed = ip.trim();
  if (IP_V4_REGEX.test(trimmed) || IP_V6_REGEX.test(trimmed)) return trimmed;
  // Strip IPv6-mapped IPv4 prefix
  if (trimmed.startsWith('::ffff:')) {
    const v4 = trimmed.slice(7);
    if (IP_V4_REGEX.test(v4)) return v4;
  }
  return null;
}

const SEVERITY_COLORS = {
  info: 'blue',
  success: 'green',
  warning: 'amber',
  error: 'red',
};

/**
 * Log an activity event
 */
function log(eventType, message, options = {}) {
  const db = getDb();
  const { details, source, ipAddress, severity } = {
    details: null,
    source: 'system',
    ipAddress: null,
    severity: 'info',
    ...options,
  };

  const info = db.prepare(`
    INSERT INTO activity_log (event_type, message, details, source, ip_address, severity)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    eventType,
    message,
    details ? JSON.stringify(details) : null,
    source,
    sanitizeIp(ipAddress),
    severity
  );

  eventBus.publish('activity', {
    id: info.lastInsertRowid, eventType, message, severity,
    createdAt: new Date().toISOString(),
  });

  // Notification center (services/notify): push to the apps per rule. Runs
  // before the e-mail so a rule with e-mail fallback can claim the mail.
  const notify = require('./notify');
  notify.emit(eventType, message, { details, source, severity });

  // Fire webhook notifications (non-blocking) — unless the rule of this
  // catalogue row switched the webhook channel off.
  if (notify.webhookAllowed(eventType)) webhook.notify(eventType, message, details);

  // Fire email alert if this event type is configured (non-blocking)
  sendEmailAlert(eventType, message, severity, details);
}

/**
 * Check if an event type should trigger an email alert, and send it.
 * Recipient and event list: services/notifications.js. route_down/route_up
 * and the update mails have their own sender and are skipped here.
 */
async function sendEmailAlert(eventType, message, severity, details) {
  try {
    const notifications = require('./notifications');
    if (!notifications.genericMailFor(eventType)) return;
    const alertEmail = notifications.recipient();
    if (!alertEmail) return;

    const { isSmtpConfigured, sendMail } = require('./email');
    if (!isSmtpConfigured()) return;

    const severityLabel = { info: 'Info', success: 'Success', warning: 'Warning', error: 'Alert' };
    const subject = `[GateControl] ${severityLabel[severity] || 'Event'}: ${message}`;
    const body = [
      message,
      '',
      `Event: ${eventType}`,
      `Severity: ${severity}`,
      `Time: ${new Date().toISOString()}`,
      details ? `Details: ${JSON.stringify(details, null, 2)}` : '',
      '',
      '— GateControl',
    ].filter(Boolean).join('\n');

    // Rule with e-mail fallback and an app device to wait for: the
    // notification center sends this mail later, only if no device confirmed.
    if (require('./notify').claimMail(eventType, { subject, text: body })) return;

    await sendMail({ to: alertEmail, subject, text: body });
    logger.debug({ eventType, to: alertEmail }, 'Email alert sent');
  } catch (err) {
    logger.warn({ err: err.message, eventType }, 'Failed to send email alert');
  }
}

/**
 * Get recent activity log entries; `category` (an allow-listed name from
 * services/activityCategories.js) narrows them to its event_type prefixes.
 */
function getRecent(limit = 20, offset = 0, { category = null } = {}) {
  const db = getDb();
  let where = '';
  let args = [];
  if (category) {
    const f = require('./activityCategories').sqlFilter(category);
    where = `WHERE ${f.sql}`;
    args = f.args;
  }
  const rows = db.prepare(`
    SELECT * FROM activity_log
    ${where}
    ORDER BY created_at DESC, id DESC
    LIMIT ? OFFSET ?
  `).all(...args, limit, offset);

  return rows.map(row => ({
    ...row,
    details: row.details ? JSON.parse(row.details) : null,
    color: SEVERITY_COLORS[row.severity] || 'blue',
  }));
}

/**
 * Latest entries that concern one account (Users page, tab "Aktivität"):
 * entries whose details name the user (userId), one of the user's current
 * tokens or owned peers, and the login entries that carry the username in
 * their message. Malformed details never break the query (json_valid).
 */
function getForUser(userId, username, limit = 30) {
  const db = getDb();
  const tokenIds = db.prepare('SELECT id FROM api_tokens WHERE user_id = ?').all(userId).map((r) => r.id);
  const peerIds = db.prepare('SELECT id FROM peers WHERE user_id = ?').all(userId).map((r) => r.id);
  const inList = (ids) => (ids.length ? ids.map(() => '?').join(',') : 'NULL');
  const name = String(username || '');
  const rows = db.prepare(`
    SELECT * FROM activity_log
    WHERE (json_valid(details) AND (
            json_extract(details, '$.userId') = ?
         OR json_extract(details, '$.tokenId') IN (${inList(tokenIds)})
         OR json_extract(details, '$.peerId') IN (${inList(peerIds)})))
       OR message = ? OR message = ? OR message LIKE ? ESCAPE '\\' OR message = ?
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `).all(userId, ...tokenIds, ...peerIds,
    `User ${name} logged in`, `Failed login for user: ${name}`,
    `User ${name.replace(/[\\%_]/g, (c) => '\\' + c)} logged in with passkey %`,
    `Failed second-factor attempt for user: ${name}`, limit);
  return rows.map((row) => ({
    ...row,
    details: row.details ? (() => { try { return JSON.parse(row.details); } catch { return null; } })() : null,
    color: SEVERITY_COLORS[row.severity] || 'blue',
  }));
}

/**
 * Get activity log count
 */
function getCount() {
  const db = getDb();
  const row = db.prepare('SELECT COUNT(*) as count FROM activity_log').get();
  return row.count;
}

/**
 * Get paginated activity log
 */
function getPaginated(page = 1, limit = 50) {
  const offset = (page - 1) * limit;
  const entries = getRecent(limit, offset);
  const total = getCount();

  return {
    entries,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  };
}

/**
 * Clean old log entries (keep last N days)
 */
function cleanup(daysToKeep = 30) {
  const db = getDb();
  const result = db.prepare(`
    DELETE FROM activity_log
    WHERE created_at < datetime('now', '-' || ? || ' days')
  `).run(daysToKeep);

  return result.changes;
}

/**
 * Get all activity log entries (for export, no pagination)
 */
function getAll() {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM activity_log
    ORDER BY created_at DESC, id DESC
  `).all();

  return rows.map(row => ({
    ...row,
    details: row.details ? JSON.parse(row.details) : null,
    color: SEVERITY_COLORS[row.severity] || 'blue',
  }));
}

module.exports = {
  log,
  getRecent,
  getForUser,
  getCount,
  getPaginated,
  getAll,
  cleanup,
};
