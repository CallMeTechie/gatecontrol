'use strict';

const { getDb } = require('../db/connection');
const webhook = require('./webhook');

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

  db.prepare(`
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

  // Fire webhook notifications (non-blocking)
  webhook.notify(eventType, message, details);
}

/**
 * Get recent activity log entries
 */
function getRecent(limit = 20, offset = 0) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM activity_log
    ORDER BY created_at DESC, id DESC
    LIMIT ? OFFSET ?
  `).all(limit, offset);

  return rows.map(row => ({
    ...row,
    details: row.details ? JSON.parse(row.details) : null,
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

module.exports = {
  log,
  getRecent,
  getCount,
  getPaginated,
  cleanup,
};
