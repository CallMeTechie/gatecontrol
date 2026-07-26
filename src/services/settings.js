'use strict';

const { getDb } = require('../db/connection');
const logger = require('../utils/logger');

/**
 * Get a setting value by key
 */
function get(key, defaultValue = null) {
  const db = getDb();
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : defaultValue;
}

/**
 * Set a setting value
 */
function set(key, value) {
  const db = getDb();
  db.prepare(`
    INSERT INTO settings (key, value, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `).run(key, String(value));
}

/**
 * Get all settings as key-value object.
 *
 * DANGER: this returns EVERYTHING, including secrets (ip2location.api_key,
 * license_key, license_signing_key_encrypted), the security policy and the
 * operator's contact addresses. Never hand the result to a client — use
 * getPublic() for anything that leaves the server.
 */
function getAll() {
  const db = getDb();
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const result = {};
  for (const row of rows) {
    result[row.key] = row.value;
  }
  return result;
}

// Settings that may leave the server. Deliberately an ALLOWLIST, not a
// denylist: a new setting stays private until someone classifies it once.
// A denylist is how the previous leak happened — GET /settings/app returned
// getAll() unfiltered and handed out ip2location.api_key in cleartext, while
// the dedicated GET /settings/ip2location route deliberately answers with
// has_api_key only.
//
// Deliberately NOT listed, with reason:
//   ip2location.api_key, license_key, license_signing_key_encrypted → secrets
//   alert_email, alerts.email, monitoring.alert_email, caddy.acme_email → operator PII
//   security.lockout.*, security.password.*  → lets an attacker tune brute force
//   custom_dns, server.public_ip, server.verify_resolver → infrastructure
//   portal.base_domain, portal.prefix → internal naming
//   route_external_block_body → operator-authored HTML, may carry internal detail
const PUBLIC_KEYS = new Set([
  'default_theme',
  'metrics_enabled',
  'gateway_down_threshold_s',
  'data.peer_online_timeout',
  'data.retention_activity_days',
  'data.retention_traffic_days',
  'autobackup_enabled',
  'autobackup_retention',
  'autobackup_schedule',
  'autobackup_last_run',
  'auto_update.mode',
  'auto_update.mode_changed_at',
  'auto_update.last_trigger_at',
  'auto_update.stale_after_min',
  'monitoring.interval',
  'monitoring.email_alerts',
  'email_alerts_enabled',
  'alerts.email_events',
  'alerts.resource_cpu_threshold',
  'alerts.resource_ram_threshold',
  'alerts.backup_reminder_days',
  'portal.enabled',
  'portal.autoappear',
  'portal.trust_owner_mapping',
  'portal.widget.device',
  'portal.widget.midea',
  'portal.widget.pihole',
  'portal.widget.services',
  'portal.widget.skoda',
  'portal.widget.smarthome',
  'portal.widget.traffic',
  'machine_binding.mode',
  'split_tunnel_preset',
  'skoda_poll_interval_min',
  'domains.server_ip_warning',
  'route_external_block_action',
  'route_external_block_redirect_url',
]);

/**
 * Settings that are safe to send to a client. Anything not on the allowlist
 * is omitted — including keys added after this list was written.
 */
function getPublic() {
  const all = getAll();
  const result = {};
  for (const key of Object.keys(all)) {
    if (PUBLIC_KEYS.has(key)) result[key] = all[key];
  }
  return result;
}

/**
 * Update user profile (display name, email, language)
 */
function updateUserProfile(userId, data) {
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) throw new Error('User not found');

  // Cap string lengths so a misuse or crafted payload can't bloat the DB
  // with a multi-MB value in display_name/email.
  if (data.display_name !== undefined && data.display_name !== null) {
    if (typeof data.display_name !== 'string' || data.display_name.length > 100) {
      throw new Error('display_name must be a string of at most 100 characters');
    }
  }
  if (data.email !== undefined && data.email !== null) {
    if (typeof data.email !== 'string' || data.email.length > 255) {
      throw new Error('email must be a string of at most 255 characters');
    }
  }

  db.prepare(`
    UPDATE users SET
      display_name = COALESCE(?, display_name),
      email = COALESCE(?, email),
      language = COALESCE(?, language),
      theme = COALESCE(?, theme),
      updated_at = datetime('now')
    WHERE id = ?
  `).run(
    data.display_name !== undefined ? data.display_name : null,
    data.email !== undefined ? data.email : null,
    data.language !== undefined ? data.language : null,
    data.theme !== undefined ? data.theme : null,
    userId
  );

  logger.info({ userId, changes: Object.keys(data) }, 'User profile updated');
  return db.prepare('SELECT id, username, display_name, email, role, language, theme, last_login_at, created_at FROM users WHERE id = ?').get(userId);
}

/**
 * Get user profile (safe fields)
 */
function getUserProfile(userId) {
  const db = getDb();
  return db.prepare('SELECT id, username, display_name, email, role, language, theme, last_login_at, created_at FROM users WHERE id = ?').get(userId);
}

module.exports = {
  get,
  set,
  getAll,
  getPublic,
  PUBLIC_KEYS,
  updateUserProfile,
  getUserProfile,
};
