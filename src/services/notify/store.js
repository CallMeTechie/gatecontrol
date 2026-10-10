'use strict';

// Persistence of the notification center: notifications, the per-device
// queue (notification_deliveries) and the device-reported preferences.
// Timestamps are ISO-8601 UTC with milliseconds (lexicographically ordered);
// the device payload carries them without milliseconds (contract).

const { getDb } = require('../../db/connection');

let _clock = () => Date.now();
function now() { return _clock(); }
function iso(ms = now()) { return new Date(ms).toISOString(); }
/** '2026-10-10T21:42:03.120Z' → '2026-10-10T21:42:03Z' (device payload). */
function wire(v) { return v ? String(v).replace(/\.\d{3}Z$/, 'Z') : null; }

function parseJson(v, fallback = null) {
  if (v == null || v === '') return fallback;
  try { return JSON.parse(v); } catch { return fallback; }
}

// ─── Notifications ──────────────────────────────────────────────────────

function createNotification(n) {
  const t = iso();
  const r = getDb().prepare(`INSERT INTO notifications
    (event_id, event_type, topic, source, priority, title, body, data, collapse_key, count, silent, target,
     created_at, updated_at, expires_at, release_at, meta)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`).run(
    n.eventId, n.eventType || null, n.topic, n.source, n.priority, n.title, n.body || null,
    n.data ? JSON.stringify(n.data) : null, n.collapseKey || null, n.silent ? 1 : 0,
    n.target ? JSON.stringify(n.target) : null, t, t, n.expiresAt || null, n.releaseAt || null,
    n.meta ? JSON.stringify(n.meta) : null);
  return Number(r.lastInsertRowid);
}

function getNotification(id) {
  return getDb().prepare('SELECT * FROM notifications WHERE id = ?').get(id) || null;
}

function updateNotification(id, fields) {
  const cols = Object.keys(fields);
  if (!cols.length) return;
  const vals = cols.map((c) => (fields[c] != null && typeof fields[c] === 'object' ? JSON.stringify(fields[c]) : fields[c]));
  getDb().prepare(`UPDATE notifications SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...vals, id);
}

function deleteNotification(id) { getDb().prepare('DELETE FROM notifications WHERE id = ?').run(id); }

/** Newest notification of a collapse key (not revoked), optionally only since `sinceIso`. */
function latestByCollapse(eventId, collapseKey, { sinceIso = null, includeHeld = true } = {}) {
  if (!collapseKey) return null;
  return getDb().prepare(`SELECT * FROM notifications
     WHERE event_id = ? AND collapse_key = ? AND revoked_at IS NULL
       ${sinceIso ? 'AND COALESCE(updated_at, created_at) >= ?' : ''}
       ${includeHeld ? '' : 'AND release_at IS NULL'}
     ORDER BY id DESC LIMIT 1`).get(...[eventId, collapseKey, ...(sinceIso ? [sinceIso] : [])]) || null;
}

// ─── Deliveries ─────────────────────────────────────────────────────────

/** Queue one delivery per target ({ tokenId, userId, silent }); returns the rows. */
function addDeliveries(notificationId, targets) {
  const db = getDb();
  const t = iso();
  const ins = db.prepare(`INSERT OR IGNORE INTO notification_deliveries
    (notification_id, token_id, user_id, state, silent, queued_at) VALUES (?, ?, ?, 'queued', ?, ?)`);
  db.transaction(() => {
    for (const x of targets) ins.run(notificationId, x.tokenId, x.userId == null ? null : x.userId, x.silent ? 1 : 0, t);
  })();
  return deliveriesOf(notificationId);
}

/**
 * Re-queue a notification under new seqs (bundling, resend): the given
 * targets replace the rows of the same devices (a new seq makes the device
 * replace the shown notification — same id and collapse key).
 */
function requeue(notificationId, targets) {
  const db = getDb();
  const del = db.prepare('DELETE FROM notification_deliveries WHERE notification_id = ? AND token_id = ?');
  db.transaction(() => { for (const x of targets) del.run(notificationId, x.tokenId); })();
  return addDeliveries(notificationId, targets);
}

function deliveriesOf(notificationId) {
  return getDb().prepare('SELECT * FROM notification_deliveries WHERE notification_id = ? ORDER BY seq').all(notificationId);
}

function markSent(seq, via) {
  getDb().prepare(`UPDATE notification_deliveries SET state = 'sent', sent_at = ?, via = ?
     WHERE seq = ? AND state = 'queued'`).run(iso(), via || null, seq);
}

const LIVE_SQL = `n.revoked_at IS NULL AND n.release_at IS NULL AND (n.expires_at IS NULL OR n.expires_at > ?)`;

/**
 * What a (re)connecting device still has to get: deliveries in state
 * queued/sent, optionally after `since`, oldest first.
 */
function pendingForToken(tokenId, since = null) {
  return getDb().prepare(`SELECT d.*, n.event_id, n.topic, n.priority, n.title, n.body, n.data, n.collapse_key,
         n.created_at, n.expires_at, n.silent AS n_silent
       FROM notification_deliveries d JOIN notifications n ON n.id = d.notification_id
      WHERE d.token_id = ? AND d.state IN ('queued', 'sent') AND ${LIVE_SQL}
        ${since != null ? 'AND d.seq > ?' : ''}
      ORDER BY d.seq LIMIT 1000`).all(...[tokenId, iso(), ...(since != null ? [since] : [])]);
}

/** One delivery joined with its notification (for the wire payload). */
function deliveryRow(seq) {
  return getDb().prepare(`SELECT d.*, n.event_id, n.topic, n.priority, n.title, n.body, n.data, n.collapse_key,
         n.created_at, n.expires_at, n.silent AS n_silent
       FROM notification_deliveries d JOIN notifications n ON n.id = d.notification_id WHERE d.seq = ?`).get(seq) || null;
}

/** The `notification` event / inbox item of the device contract. */
function payload(row) {
  return {
    seq: row.seq,
    id: row.notification_id,
    event_id: row.event_id,
    topic: row.topic,
    priority: row.priority,
    title: row.title,
    body: row.body || '',
    created_at: wire(row.created_at),
    expires_at: wire(row.expires_at),
    collapse_key: row.collapse_key || null,
    silent: row.silent === 1 || row.n_silent === 1,
    data: parseJson(row.data, null),
  };
}

const ACK_FROM = {
  delivered: ['queued', 'sent'],
  read: ['queued', 'sent', 'delivered'],
  dismissed: ['queued', 'sent', 'delivered', 'read'],
};

/**
 * A device confirms its own deliveries. Returns the rows that changed
 * ({ seq, notification_id, user_id }). `read`/`dismissed` also mark the
 * same person's other deliveries of those notifications as read.
 */
function ack(tokenId, seqs, state, action) {
  const db = getDb();
  const t = iso();
  const from = ACK_FROM[state];
  const list = seqs.length ? seqs : [-1];
  const rows = db.prepare(`SELECT seq, notification_id, user_id, state FROM notification_deliveries
     WHERE token_id = ? AND seq IN (${list.map(() => '?').join(',')})`).all(tokenId, ...list);
  const changed = [];
  db.transaction(() => {
    for (const r of rows) {
      const fields = [];
      const args = [];
      if (from.includes(r.state)) {
        fields.push('state = ?'); args.push(state);
        if (state === 'delivered' || r.state === 'queued' || r.state === 'sent') { fields.push('delivered_at = COALESCE(delivered_at, ?)'); args.push(t); }
        if (state === 'read' || state === 'dismissed') { fields.push('read_at = COALESCE(read_at, ?)'); args.push(t); }
      }
      if (action) { fields.push('action = ?'); args.push(action); }
      if (!fields.length) continue;
      db.prepare(`UPDATE notification_deliveries SET ${fields.join(', ')} WHERE seq = ?`).run(...args, r.seq);
      changed.push({ seq: r.seq, notification_id: r.notification_id, user_id: r.user_id });
    }
  })();
  return changed;
}

/**
 * Mark the deliveries of `notificationIds` of one person as read (read-sync,
 * portal "gelesen"). Returns the token ids whose rows changed, per id.
 */
function markReadForUser(userId, notificationIds, { exceptToken = null } = {}) {
  if (!notificationIds.length) return [];
  const db = getDb();
  const t = iso();
  const ph = notificationIds.map(() => '?').join(',');
  const rows = db.prepare(`SELECT seq, token_id, notification_id FROM notification_deliveries
     WHERE user_id = ? AND notification_id IN (${ph}) AND state IN ('queued', 'sent', 'delivered')
     ${exceptToken != null ? 'AND token_id <> ?' : ''}`).all(...[userId, ...notificationIds, ...(exceptToken != null ? [exceptToken] : [])]);
  const upd = db.prepare(`UPDATE notification_deliveries SET state = 'read', read_at = COALESCE(read_at, ?) WHERE seq = ?`);
  db.transaction(() => { for (const r of rows) upd.run(t, r.seq); })();
  return rows;
}

function inbox(tokenId, { limit = 100, before = null } = {}) {
  const rows = getDb().prepare(`SELECT d.*, n.event_id, n.topic, n.priority, n.title, n.body, n.data, n.collapse_key,
         n.created_at, n.expires_at, n.silent AS n_silent
       FROM notification_deliveries d JOIN notifications n ON n.id = d.notification_id
      WHERE d.token_id = ? AND d.state IN ('queued', 'sent', 'delivered', 'read', 'dismissed') AND ${LIVE_SQL}
        ${before != null ? 'AND d.seq < ?' : ''}
      ORDER BY d.seq DESC LIMIT ?`).all(...[tokenId, iso(), ...(before != null ? [before] : []), limit]);
  return rows.map((r) => ({ ...payload(r), state: r.state === 'read' || r.state === 'dismissed' ? r.state : 'delivered' }));
}

function unreadCount(tokenId) {
  return getDb().prepare(`SELECT COUNT(*) AS n FROM notification_deliveries d JOIN notifications n ON n.id = d.notification_id
     WHERE d.token_id = ? AND d.state IN ('queued', 'sent', 'delivered') AND ${LIVE_SQL}`).get(tokenId, iso()).n;
}

function queuedCount(tokenId) {
  return getDb().prepare(`SELECT COUNT(*) AS n FROM notification_deliveries d JOIN notifications n ON n.id = d.notification_id
     WHERE d.token_id = ? AND d.state = 'queued' AND ${LIVE_SQL}`).get(tokenId, iso()).n;
}

/** Notifications revoked since `sinceIso` that this device has shown (sent/delivered). */
function revokedForToken(tokenId, sinceIso) {
  if (!sinceIso) return [];
  return getDb().prepare(`SELECT DISTINCT n.id FROM notifications n JOIN notification_deliveries d ON d.notification_id = n.id
     WHERE d.token_id = ? AND d.state IN ('sent', 'delivered') AND n.revoked_at IS NOT NULL AND n.revoked_at > ?`)
    .all(tokenId, sinceIso).map((r) => r.id);
}

// ─── Device preferences ─────────────────────────────────────────────────

function devicePrefs(tokenId) {
  const r = getDb().prepare('SELECT * FROM notify_device_prefs WHERE token_id = ?').get(tokenId);
  if (!r) return null;
  return { ...r, muted_topics: parseJson(r.topics, []) || [] };
}

/** Record what the stream headers say about the app (creates the row). */
function touchDevice(tokenId, { platform, clientType, appVersion, via }) {
  const t = iso();
  getDb().prepare(`INSERT INTO notify_device_prefs (token_id, enabled, platform, client_type, app_version, via, last_seen_at, updated_at)
      VALUES (?, 1, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(token_id) DO UPDATE SET
        platform = COALESCE(excluded.platform, platform),
        client_type = COALESCE(excluded.client_type, client_type),
        app_version = COALESCE(excluded.app_version, app_version),
        via = excluded.via, last_seen_at = excluded.last_seen_at`).run(
    tokenId, platform || null, clientType || null, appVersion || null, via || null, t, t);
}

function seen(tokenId) {
  getDb().prepare('UPDATE notify_device_prefs SET last_seen_at = ? WHERE token_id = ?').run(iso(), tokenId);
}

function setDevicePrefs(tokenId, p) {
  const t = iso();
  getDb().prepare(`INSERT INTO notify_device_prefs (token_id, enabled, mode, topics, restricted, updated_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(token_id) DO UPDATE SET enabled = excluded.enabled, mode = excluded.mode, topics = excluded.topics,
        restricted = excluded.restricted, updated_at = excluded.updated_at`).run(
    tokenId, p.enabled ? 1 : 0, p.mode || null, JSON.stringify(p.muted_topics || []), p.restricted ? 1 : 0, t, t);
}

function _setClock(fn) { _clock = fn || (() => Date.now()); }

module.exports = {
  now, iso, wire, parseJson,
  createNotification, getNotification, updateNotification, deleteNotification, latestByCollapse,
  addDeliveries, requeue, deliveriesOf, markSent, pendingForToken, deliveryRow, payload, ack, markReadForUser,
  inbox, unreadCount, queuedCount, revokedForToken,
  devicePrefs, touchDevice, seen, setDevicePrefs,
  _setClock,
};
