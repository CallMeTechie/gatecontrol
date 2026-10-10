'use strict';

// Notification center (docs/feature-notification-center.md) — entry points
// for the rest of the server. The parts:
//   hub.js        emit(), rules applied, delay/bundle/recovery, e-mail fallback
//   rules.js      notify_rules (seeded lazily from CATALOGUE)
//   router.js     recipients → people → devices, filters, quiet hours
//   store.js      notifications, per-device queue, device preferences
//   stream.js     open SSE streams (one per device token)
//   retention.js  hourly clean-up + ticker
//   admin.js      queries of the admin API

const hub = require('./hub');

/**
 * activity.log() hook: never throws, never blocks the log entry.
 */
function emit(eventType, message, opts) {
  try { return hub.emitActivity(eventType, message, opts || {}); } catch (err) {
    require('../../utils/logger').warn({ err: err.message, eventType }, 'notification emit failed');
    return null;
  }
}

function claimMail(key, mail) {
  try { return hub.claimMail(key, mail); } catch { return false; }
}

function webhookAllowed(type) { return hub.webhookAllowed(type); }

/** A token was revoked/deleted: its stream ends at once, its queue expires. */
function onTokenRevoked(tokenId) {
  try {
    require('./stream').closeToken(Number(tokenId), 'revoked');
    const { getDb } = require('../../db/connection');
    getDb().prepare("UPDATE notification_deliveries SET state = 'expired' WHERE token_id = ? AND state IN ('queued', 'sent')").run(tokenId);
    getDb().prepare('DELETE FROM notify_device_prefs WHERE token_id = ?').run(tokenId);
  } catch { /* best-effort */ }
}

module.exports = {
  emit,
  claimMail,
  webhookAllowed,
  onTokenRevoked,
  start: () => require('./retention').start(),
  stop: () => require('./retention').stop(),
};
