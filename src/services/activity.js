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

// ─── Filtered reads (Logs & Monitoring) ──────────────────────────────────────
// Optional filters of GET /api/v1/logs/activity and its export. Without any
// of them the reads above are unchanged.

const SEVERITIES = ['info', 'success', 'warning', 'error'];
const EVENT_TYPE_RE = /^[A-Za-z0-9_:.-]{1,64}$/;

/** epoch ms → the format of created_at ('YYYY-MM-DD HH:MM:SS', UTC). */
function sqlTime(ms) {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Filter → { sql, args } for a WHERE clause ('' when no filter).
 *   severities ['error', …]  category  (activityCategories name)
 *   eventTypes ['peer_created', …] exact  q  text in message/event_type/source
 *   from/to    epoch ms (inclusive)
 * `skip` leaves out one part (counts per severity ignore the severity filter).
 */
function filterSql(f = {}, { skip = null } = {}) {
  const parts = [];
  const args = [];
  if (skip !== 'severity' && f.severities && f.severities.length) {
    parts.push(`severity IN (${f.severities.map(() => '?').join(',')})`);
    args.push(...f.severities);
  }
  if (f.category) {
    const c = require('./activityCategories').sqlFilter(f.category);
    parts.push(c.sql);
    args.push(...c.args);
  }
  if (f.eventTypes && f.eventTypes.length) {
    parts.push(`event_type IN (${f.eventTypes.map(() => '?').join(',')})`);
    args.push(...f.eventTypes);
  }
  if (f.q) {
    const like = '%' + String(f.q).replace(/[\\%_]/g, (c) => '\\' + c) + '%';
    parts.push("(message LIKE ? ESCAPE '\\' OR event_type LIKE ? ESCAPE '\\' OR source LIKE ? ESCAPE '\\')");
    args.push(like, like, like);
  }
  if (f.from != null) { parts.push('created_at >= ?'); args.push(sqlTime(f.from)); }
  if (f.to != null) { parts.push('created_at <= ?'); args.push(sqlTime(f.to)); }
  return { sql: parts.length ? 'WHERE ' + parts.join(' AND ') : '', args };
}

function mapRow(row) {
  let details = null;
  if (row.details) { try { details = JSON.parse(row.details); } catch { details = null; } }
  return { ...row, details, color: SEVERITY_COLORS[row.severity] || 'blue' };
}

/** Page of filtered entries, newest first (same shape as getPaginated). */
function getFiltered(filter, page = 1, limit = 50) {
  const db = getDb();
  const w = filterSql(filter);
  const offset = (page - 1) * limit;
  const rows = db.prepare(`SELECT * FROM activity_log ${w.sql} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
    .all(...w.args, limit, offset);
  const total = db.prepare(`SELECT COUNT(*) AS c FROM activity_log ${w.sql}`).get(...w.args).c;
  return { entries: rows.map(mapRow), total, page, limit, totalPages: Math.ceil(total / limit) };
}

/** Every filtered entry, newest first (export). */
function getAllFiltered(filter) {
  const w = filterSql(filter);
  return getDb().prepare(`SELECT * FROM activity_log ${w.sql} ORDER BY created_at DESC, id DESC`).all(...w.args).map(mapRow);
}

/**
 * Counts for filter chips and a histogram: per severity (without the
 * severity filter), the event types (top 100) and, with bucketMs, per time
 * bucket and severity.
 */
function getCounts(filter, { bucketMs = null } = {}) {
  const db = getDb();
  const w = filterSql(filter, { skip: 'severity' });
  const counts = { info: 0, success: 0, warning: 0, error: 0, total: 0 };
  for (const r of db.prepare(`SELECT severity, COUNT(*) AS c FROM activity_log ${w.sql} GROUP BY severity`).all(...w.args)) {
    if (Object.prototype.hasOwnProperty.call(counts, r.severity)) counts[r.severity] += r.c;
    counts.total += r.c;
  }
  const all = filterSql(filter);
  const events = db.prepare(`SELECT event_type, COUNT(*) AS count FROM activity_log ${all.sql}
    GROUP BY event_type ORDER BY count DESC, event_type LIMIT 100`).all(...all.args);
  const out = { counts, events };
  if (bucketMs) {
    const sec = Math.max(1, Math.round(bucketMs / 1000));
    const rows = db.prepare(`SELECT (CAST(strftime('%s', created_at) AS INTEGER) / ${sec}) * ${sec} AS b, severity, COUNT(*) AS c
      FROM activity_log ${w.sql} GROUP BY b, severity ORDER BY b LIMIT 5000`).all(...w.args);
    const map = new Map();
    for (const r of rows) {
      const t = r.b * 1000;
      let row = map.get(t);
      if (!row) { row = { t, time: new Date(t).toISOString(), info: 0, success: 0, warning: 0, error: 0 }; map.set(t, row); }
      if (Object.prototype.hasOwnProperty.call(row, r.severity)) row[r.severity] += r.c;
    }
    out.histogram = { bucketMs: sec * 1000, buckets: [...map.values()] };
  }
  return out;
}

module.exports = {
  SEVERITIES,
  EVENT_TYPE_RE,
  filterSql,
  getFiltered,
  getAllFiltered,
  getCounts,
  log,
  getRecent,
  getForUser,
  getCount,
  getPaginated,
  getAll,
  cleanup,
};
