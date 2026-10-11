'use strict';

// Read models of the admin API (/api/v1/notify): overview, devices, history,
// delivery log. Labels come in the caller's language (`t` = req.t).

const { getDb } = require('../../db/connection');
const store = require('./store');
const stream = require('./stream');
const config = require('./config');
const { ENDPOINT } = require('./constants');

const DONE = "('delivered', 'read', 'dismissed')";

function placeholders(list) { return list.map(() => '?').join(','); }

/** Delivery counts per notification id. */
function statsFor(ids) {
  const out = new Map();
  if (!ids.length) return out;
  const rows = getDb().prepare(`SELECT notification_id AS id, COUNT(*) AS total,
       SUM(CASE WHEN state IN ${DONE} THEN 1 ELSE 0 END) AS delivered,
       SUM(CASE WHEN read_at IS NOT NULL THEN 1 ELSE 0 END) AS read,
       SUM(silent) AS silent,
       SUM(CASE WHEN state IN ('queued', 'sent') THEN 1 ELSE 0 END) AS waiting
     FROM notification_deliveries WHERE notification_id IN (${placeholders(ids)}) GROUP BY notification_id`).all(...ids);
  for (const r of rows) out.set(r.id, r);
  return out;
}

function statusOf(n, st) {
  const live = !n.expires_at || n.expires_at > store.iso();
  if (n.release_at || (live && st && st.waiting > 0)) return 'waiting';
  if (!st || st.delivered === st.total) return 'ok';
  return 'partial';
}

function userNames(ids) {
  if (!ids.length) return new Map();
  return new Map(getDb().prepare(`SELECT id, username, display_name FROM users WHERE id IN (${placeholders(ids)})`).all(...ids)
    .map((u) => [u.id, u.display_name || u.username]));
}

function groupNames(ids) {
  if (!ids.length) return new Map();
  return new Map(getDb().prepare(`SELECT id, name FROM peer_groups WHERE id IN (${placeholders(ids)})`).all(...ids).map((g) => [g.id, g.name]));
}

function namesList(map, ids) {
  const names = ids.map((id) => map.get(id)).filter(Boolean);
  return names.length > 3 ? `${names.slice(0, 3).join(', ')} +${names.length - 3}` : names.join(', ');
}

/** "Alle Admins, Besitzer", "Anna, Ben", "3 Geräte", … */
function recipientsLabel(n, t) {
  const target = store.parseJson(n.target, {}) || {};
  const ids = Array.isArray(target.ids) ? target.ids : [];
  if (target.type === 'all') return t('push.recipients.all');
  if (target.type === 'users') return namesList(userNames(ids), ids) || '—';
  if (target.type === 'groups') return namesList(groupNames(ids), ids) || '—';
  if (target.type === 'devices') return t('push.recipients.devices', { count: String(ids.length) });
  const r = target.recipients || {};
  const parts = [];
  if (r.admins) parts.push(t('push.recipients.admins'));
  if (r.owner) parts.push(t('push.recipients.owner'));
  if (r.subscribers) parts.push(t('push.recipients.subscribers'));
  if (Array.isArray(r.users) && r.users.length) parts.push(namesList(userNames(r.users), r.users));
  if (Array.isArray(r.groups) && r.groups.length) parts.push(namesList(groupNames(r.groups), r.groups));
  return parts.filter(Boolean).join(', ') || '—';
}

function itemOf(n, st, t) {
  const s = st || { total: 0, delivered: 0, read: 0, silent: 0 };
  return {
    id: n.id,
    title: n.title,
    body: n.body || '',
    event_id: n.event_id,
    topic: n.topic,
    priority: n.priority,
    source: n.source,
    created_at: n.created_at,
    recipients_label: recipientsLabel(n, t),
    delivered: s.delivered || 0,
    total: s.total || 0,
    read: s.read || 0,
    silent: n.silent === 1 || (s.total > 0 && s.silent === s.total),
    status: statusOf(n, st),
  };
}

// ─── Overview ───────────────────────────────────────────────────────────

function median(values) {
  if (!values.length) return null;
  const v = [...values].sort((a, b) => a - b);
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : Math.round((v[m - 1] + v[m]) / 2);
}

const SOURCE_IDS = ['security', 'devices', 'services', 'system', 'plugins'];

// ─── Sidebar badge ──────────────────────────────────────────────────────
// Messages waiting for offline devices, for the "Benachrichtigungen" badge
// on every admin page (middleware/locals.js). One indexed COUNT, cached for
// BADGE_TTL_MS so page views never add up; the notifications page itself
// refreshes the badge live from the overview.

const BADGE_TTL_MS = 15 * 1000;
let badgeCache = { at: 0, value: 0 };

function queuedBadge() {
  const t = Date.now();
  if (t - badgeCache.at < BADGE_TTL_MS) return badgeCache.value;
  let value = 0;
  if (config.value('enabled')) {
    value = getDb().prepare(`SELECT COUNT(*) AS n FROM notification_deliveries d JOIN notifications n ON n.id = d.notification_id
       WHERE d.state = 'queued' AND n.revoked_at IS NULL AND (n.expires_at IS NULL OR n.expires_at > ?)`).get(store.iso()).n;
  }
  badgeCache = { at: t, value };
  return value;
}

function _resetBadgeForTest() { badgeCache = { at: 0, value: 0 }; }

function overview(t) {
  const db = getDb();
  const cfg = config.get();
  const nowMs = store.now();
  const day = store.iso(nowMs - 24 * 3600 * 1000);
  const week = store.iso(nowMs - 7 * 24 * 3600 * 1000);
  const nowIso = store.iso(nowMs);
  const conns = stream.list();
  const totalDevices = db.prepare('SELECT COUNT(*) AS n FROM notify_device_prefs dp JOIN api_tokens t ON t.id = dp.token_id').get().n;
  const queued = db.prepare(`SELECT COUNT(*) AS n, COUNT(DISTINCT d.token_id) AS devices FROM notification_deliveries d
     JOIN notifications n ON n.id = d.notification_id
     WHERE d.state = 'queued' AND n.revoked_at IS NULL AND (n.expires_at IS NULL OR n.expires_at > ?)`).get(nowIso);
  const lat = db.prepare(`SELECT queued_at, delivered_at FROM notification_deliveries
     WHERE delivered_at IS NOT NULL AND delivered_at >= ? ORDER BY seq DESC LIMIT 5000`).all(day)
    .map((r) => Date.parse(r.delivered_at) - Date.parse(r.queued_at)).filter((x) => Number.isFinite(x) && x >= 0);

  const recentRows = db.prepare('SELECT * FROM notifications ORDER BY id DESC LIMIT 8').all();
  const st = statsFor(recentRows.map((r) => r.id));
  const recent = recentRows.map((n) => {
    const it = itemOf(n, st.get(n.id), t);
    delete it.body;
    delete it.status;
    return it;
  });

  const srcRows = db.prepare(`SELECT CASE WHEN source LIKE 'plugin:%' THEN 'plugins' ELSE topic END AS src, COUNT(*) AS n
     FROM notifications WHERE created_at >= ? GROUP BY src`).all(week);
  const srcMap = new Map(srcRows.map((r) => [r.src, r.n]));

  return {
    kpis: {
      devices_connected: conns.length,
      devices_total: totalDevices,
      direct: conns.filter((c) => c.via === 'direct').length,
      tunnel: conns.filter((c) => c.via === 'tunnel').length,
      delivered_24h: db.prepare('SELECT COUNT(*) AS n FROM notification_deliveries WHERE delivered_at >= ?').get(day).n,
      read_24h: db.prepare('SELECT COUNT(*) AS n FROM notification_deliveries WHERE read_at >= ?').get(day).n,
      queued: queued.n,
      queued_devices: queued.devices,
      failed_7d: db.prepare(`SELECT COUNT(*) AS n FROM notification_deliveries WHERE state = 'expired' AND queued_at >= ?`).get(week).n,
      median_latency_ms: median(lat),
    },
    recent,
    hub: {
      enabled: cfg.enabled,
      endpoint: ENDPOINT,
      keepalive_s: cfg.keepalive_s,
      retention_h: cfg.retention_h,
      max_queue: cfg.max_queue,
      allow_direct: cfg.allow_direct,
    },
    sources: SOURCE_IDS.map((id) => ({ id, count: srcMap.get(id) || 0 })),
  };
}

// ─── Devices ────────────────────────────────────────────────────────────

function devices() {
  const db = getDb();
  const rows = db.prepare(`SELECT t.id, t.name, t.user_id, t.last_used_at, u.username, u.display_name, u.role,
       dp.token_id AS app, dp.platform, dp.client_type, dp.app_version, dp.restricted, dp.last_seen_at,
       p.client_platform, p.client_product, p.client_version
     FROM api_tokens t
     LEFT JOIN users u ON u.id = t.user_id
     LEFT JOIN notify_device_prefs dp ON dp.token_id = t.id
     LEFT JOIN peers p ON p.id = t.peer_id
     WHERE t.peer_id IS NOT NULL OR t.enrolled = 1 OR dp.token_id IS NOT NULL`).all();
  const nowIso = store.iso();
  const q = new Map(db.prepare(`SELECT d.token_id, COUNT(*) AS n, MIN(n.expires_at) AS until FROM notification_deliveries d
     JOIN notifications n ON n.id = d.notification_id
     WHERE d.state = 'queued' AND n.revoked_at IS NULL AND (n.expires_at IS NULL OR n.expires_at > ?) GROUP BY d.token_id`).all(nowIso)
    .map((r) => [r.token_id, r]));
  const acks = new Map(db.prepare(`SELECT token_id, MAX(COALESCE(read_at, delivered_at)) AS at FROM notification_deliveries
     WHERE delivered_at IS NOT NULL OR read_at IS NOT NULL GROUP BY token_id`).all().map((r) => [r.token_id, r.at]));
  const list = rows.map((r) => {
    const conn = stream.get(r.id);
    let state = 'unsupported';
    if (conn) state = r.restricted === 1 ? 'restricted' : 'connected';
    else if (r.app != null) state = 'offline';
    const product = r.client_type || (['pro', 'community'].includes(r.client_product) ? r.client_product : null);
    const qq = q.get(r.id);
    return {
      token_id: r.id,
      name: r.name,
      user: r.user_id != null && r.username != null ? { id: r.user_id, name: r.display_name || r.username, role: r.role } : null,
      platform: r.platform || r.client_platform || null,
      client_type: product,
      app_version: r.app_version || r.client_version || null,
      state,
      via: conn ? conn.via : null,
      connected_since: conn ? conn.connectedAt : null,
      last_seen: conn ? nowIso : (r.last_seen_at || r.last_used_at || null),
      queued: qq ? qq.n : 0,
      last_ack_at: acks.get(r.id) || null,
      buffer_until: qq ? qq.until : null,
    };
  });
  const order = { connected: 0, restricted: 1, offline: 2, unsupported: 3 };
  return list.sort((a, b) => order[a.state] - order[b.state] || String(a.name).localeCompare(String(b.name)));
}

// ─── History ────────────────────────────────────────────────────────────

const FILTERS = {
  all: '1 = 1',
  important: "n.priority IN ('high', 'critical')",
  undelivered: `(n.release_at IS NOT NULL OR EXISTS (SELECT 1 FROM notification_deliveries d
     WHERE d.notification_id = n.id AND d.state NOT IN ${DONE}))`,
  plugins: "n.source LIKE 'plugin:%'",
  manual: "n.source LIKE 'manual:%'",
};

function history({ filter = 'all', days = 7, before = null, limit = 50 }, t) {
  const where = [FILTERS[filter] || FILTERS.all, 'n.created_at >= ?'];
  const args = [store.iso(store.now() - days * 24 * 3600 * 1000)];
  if (before != null) { where.push('n.id < ?'); args.push(before); }
  const rows = getDb().prepare(`SELECT n.* FROM notifications n WHERE ${where.join(' AND ')} ORDER BY n.id DESC LIMIT ?`).all(...args, limit);
  const st = statsFor(rows.map((r) => r.id));
  const items = rows.map((n) => {
    const it = itemOf(n, st.get(n.id), t);
    delete it.topic;
    return it;
  });
  return { items, next_before: rows.length === limit ? rows[rows.length - 1].id : null };
}

function detail(id, t) {
  const db = getDb();
  const n = store.getNotification(id);
  if (!n) return null;
  const st = statsFor([id]).get(id);
  const rows = db.prepare(`SELECT d.*, tk.name AS token_name, u.username, u.display_name FROM notification_deliveries d
     LEFT JOIN api_tokens tk ON tk.id = d.token_id LEFT JOIN users u ON u.id = d.user_id
     WHERE d.notification_id = ? ORDER BY d.seq`).all(id);
  const deliveries = rows.map((d) => ({
    token_id: d.token_id,
    device_name: d.token_name || null,
    user_name: d.user_id != null ? (d.display_name || d.username || null) : null,
    state: d.state,
    via: d.via || null,
    queued_at: d.queued_at,
    sent_at: d.sent_at,
    delivered_at: d.delivered_at,
    read_at: d.read_at,
    latency_ms: d.delivered_at && d.queued_at ? Math.max(0, Date.parse(d.delivered_at) - Date.parse(d.queued_at)) : null,
    action: d.action || null,
  }));
  const first = (k) => rows.map((r) => r[k]).filter(Boolean).sort()[0] || null;
  const timeline = [{ at: n.created_at, kind: 'created', text: t('push.timeline.created', { count: String(rows.length) }) }];
  if (n.count > 1) timeline.push({ at: n.updated_at, kind: 'bundled', text: t('push.timeline.bundled', { count: String(n.count) }) });
  if (n.release_at) timeline.push({ at: n.release_at, kind: 'held', text: t('push.timeline.held') });
  const firstSent = first('sent_at');
  if (firstSent) timeline.push({ at: firstSent, kind: 'sent', text: t('push.timeline.sent', { count: String(rows.filter((r) => r.sent_at).length) }) });
  const firstDelivered = first('delivered_at');
  if (firstDelivered) timeline.push({ at: firstDelivered, kind: 'delivered', text: t('push.timeline.delivered', { count: String(st ? st.delivered : 0) }) });
  const firstRead = first('read_at');
  if (firstRead) timeline.push({ at: firstRead, kind: 'read', text: t('push.timeline.read', { count: String(st ? st.read : 0) }) });
  if (n.email_state === 'sent' && n.email_sent_at) timeline.push({ at: n.email_sent_at, kind: 'email', text: t('push.timeline.email') });
  if (n.revoked_at) timeline.push({ at: n.revoked_at, kind: 'revoked', text: t('push.timeline.revoked') });
  const expired = rows.filter((r) => r.state === 'expired').length;
  if (expired) timeline.push({ at: n.expires_at, kind: 'expired', text: t('push.timeline.expired', { count: String(expired) }) });
  timeline.sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')));

  const item = itemOf(n, st, t);
  return {
    notification: {
      ...item,
      event_type: n.event_type || null,
      data: store.parseJson(n.data, null),
      collapse_key: n.collapse_key || null,
      count: n.count,
      expires_at: n.expires_at,
      revoked_at: n.revoked_at || null,
    },
    timeline,
    deliveries,
    email: { sent: n.email_state === 'sent', at: n.email_state === 'sent' ? n.email_sent_at : null },
  };
}

module.exports = { overview, devices, history, detail, recipientsLabel, statsFor, statusOf, queuedBadge, _resetBadgeForTest, FILTERS };
