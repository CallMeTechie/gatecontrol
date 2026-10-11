'use strict';

// Recipient resolution: rule recipients → people → devices, then the filters
// (device preferences, subscriptions, quiet hours).
//
// Devices: an api_tokens row with a notify_device_prefs row, i.e. a
// GateControl app (Android / Windows) that opened the push stream at least
// once and told the server its platform. Plain WireGuard peers and tokens
// without such an app are "unsupported" and never get a queue.
//
// Groups: the existing peer groups (peer_groups, peers.group_id). A group
// recipient means the app devices IN that group (tokens bound to a peer of
// the group) — not every device of the people who own a device there.
//
// Topics and subscriptions (one switch per person and topic,
// notify_subscriptions): a missing row means the topic default (core topics
// on; plugin topics their plugin.json default). An explicit "off" removes the
// person from every recipient path of that topic — except `critical`
// messages and `admin_notice` (manual messages, tests). `security` and
// `system` are admin-only: the subscribers path never reaches members there.

const { getDb } = require('../../db/connection');
const { ADMIN_ONLY_TOPICS, LOCKED_TOPICS } = require('./constants');

function enabledUserIds(ids) {
  const list = [...new Set(ids)].filter((n) => Number.isSafeInteger(n));
  if (!list.length) return [];
  return getDb().prepare(`SELECT id FROM users WHERE enabled = 1 AND id IN (${list.map(() => '?').join(',')})`).all(...list).map((r) => r.id);
}

function adminIds() {
  return getDb().prepare("SELECT id FROM users WHERE role = 'admin' AND enabled = 1").all().map((r) => r.id);
}

function isAdmin(userId) {
  return !!getDb().prepare("SELECT 1 FROM users WHERE id = ? AND role = 'admin' AND enabled = 1").get(userId);
}

/** Default of a topic when a person has no row (core on, plugin per manifest). */
function topicDefault(topic) {
  if (!String(topic).startsWith('plugin:')) return true;
  const pt = require('./rules').pluginTopic(topic);
  return pt ? pt.default !== false : true;
}

function subscriptionOf(userId, topic) {
  const r = getDb().prepare('SELECT enabled FROM notify_subscriptions WHERE user_id = ? AND topic = ?').get(userId, topic);
  return r ? r.enabled === 1 : null;
}

/** Is the topic on for this person (row or default)? */
function topicOn(userId, topic) {
  if (LOCKED_TOPICS.has(topic)) return true;
  const s = subscriptionOf(userId, topic);
  return s == null ? topicDefault(topic) : s;
}

/** Everyone the `subscribers` recipient reaches for a topic. */
function subscriberIds(topic) {
  const db = getDb();
  const users = db.prepare('SELECT id, role FROM users WHERE enabled = 1').all();
  const rows = new Map(db.prepare('SELECT user_id, enabled FROM notify_subscriptions WHERE topic = ?').all(topic).map((r) => [r.user_id, r.enabled === 1]));
  const def = topicDefault(topic);
  return users
    .filter((u) => !ADMIN_ONLY_TOPICS.has(topic) || u.role === 'admin')
    .filter((u) => (rows.has(u.id) ? rows.get(u.id) : def))
    .map((u) => u.id);
}

function ownerOf(peerId) {
  if (peerId == null) return null;
  try {
    const info = require('../portalDevices').usageForPeer(Number(peerId));
    return info && info.ownerId != null && info.allowedUserIds.includes(info.ownerId) ? info.ownerId : null;
  } catch { return null; }
}

// ─── Devices ────────────────────────────────────────────────────────────

const DEVICE_SQL = `SELECT t.id AS token_id, t.user_id, t.peer_id, t.name, dp.enabled, dp.topics
  FROM api_tokens t JOIN notify_device_prefs dp ON dp.token_id = t.id`;

function devicesOfUsers(userIds) {
  if (!userIds.length) return [];
  return getDb().prepare(`${DEVICE_SQL} WHERE t.user_id IN (${userIds.map(() => '?').join(',')})`).all(...userIds);
}

function devicesInGroups(groupIds) {
  if (!groupIds.length) return [];
  return getDb().prepare(`${DEVICE_SQL} JOIN peers p ON p.id = t.peer_id
     WHERE p.group_id IN (${groupIds.map(() => '?').join(',')})`).all(...groupIds);
}

function devicesByIds(tokenIds) {
  if (!tokenIds.length) return [];
  return getDb().prepare(`${DEVICE_SQL} WHERE t.id IN (${tokenIds.map(() => '?').join(',')})`).all(...tokenIds);
}

function allDevices() { return getDb().prepare(DEVICE_SQL).all(); }

/** Is the app part of a device (it has a notify_device_prefs row)? */
function isPushDevice(tokenId) {
  return !!getDb().prepare('SELECT 1 FROM notify_device_prefs WHERE token_id = ?').get(tokenId);
}

// ─── Quiet hours ────────────────────────────────────────────────────────

const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function validTz(tz) {
  if (!tz || typeof tz !== 'string' || tz.length > 64) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

function serverTz() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}

/** Minutes since midnight of `ms` in time zone `tz`. */
function localMinutes(ms, tz) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms));
  const h = Number(parts.find((p) => p.type === 'hour').value) % 24;
  const m = Number(parts.find((p) => p.type === 'minute').value);
  return h * 60 + m;
}

/** Is `ms` inside the quiet hours of `prefs` ({ quiet_from, quiet_to, tz })? */
function inQuietHours(prefs, ms) {
  if (!prefs || !HHMM_RE.test(prefs.quiet_from || '') || !HHMM_RE.test(prefs.quiet_to || '')) return false;
  const toMin = (s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
  const from = toMin(prefs.quiet_from);
  const to = toMin(prefs.quiet_to);
  if (from === to) return false;
  const cur = localMinutes(ms, validTz(prefs.tz) ? prefs.tz : serverTz());
  return from < to ? cur >= from && cur < to : cur >= from || cur < to;
}

function userPrefs(userId) {
  return getDb().prepare('SELECT * FROM notify_user_prefs WHERE user_id = ?').get(userId) || null;
}

/**
 * Quiet hours of a person as the devices see them (SSE `hello`, GET
 * /client/push/prefs): { from, to, tz, critical_bypass } or null when none
 * are set (or from = to, which never applies).
 */
function quietOf(userId) {
  if (userId == null) return null;
  const p = userPrefs(userId);
  if (!p || !HHMM_RE.test(p.quiet_from || '') || !HHMM_RE.test(p.quiet_to || '') || p.quiet_from === p.quiet_to) return null;
  return { from: p.quiet_from, to: p.quiet_to, tz: validTz(p.tz) ? p.tz : serverTz(), critical_bypass: p.critical_bypass !== 0 };
}

// ─── Resolution ─────────────────────────────────────────────────────────

/**
 * → [{ tokenId, userId, silent }] for one notification.
 *   input.recipients  rule recipients ({ admins, owner, subscribers, users, groups })
 *   input.users       explicit people (plugin `users`, manual send) — replaces recipients
 *   input.groups / input.tokenIds / input.all   manual send targets
 *   input.peerId      the device an event is about (owner)
 *   input.topic, input.priority
 *   input.licensed    users/groups recipients need the email_alerts licence
 *   input.bypass      test messages: no filters at all
 *   input.now         ms
 */
function resolve(input) {
  const topic = input.topic;
  const critical = input.priority === 'critical';
  const r = input.recipients || {};
  const people = new Set();
  let devices = [];

  if (input.all) {
    devices = allDevices();
  } else if (Array.isArray(input.tokenIds)) {
    devices = devicesByIds(input.tokenIds);
  } else {
    if (Array.isArray(input.users)) {
      for (const id of enabledUserIds(input.users)) people.add(id);
    } else {
      if (r.admins) for (const id of adminIds()) people.add(id);
      if (r.owner) { const o = ownerOf(input.peerId); if (o != null) people.add(o); }
      if (r.subscribers) for (const id of subscriberIds(topic)) people.add(id);
      if (input.licensed && Array.isArray(r.users) && r.users.length) for (const id of enabledUserIds(r.users)) people.add(id);
    }
    devices = devicesOfUsers([...people]);
    const groups = Array.isArray(input.groups) ? input.groups : (input.licensed && Array.isArray(r.groups) ? r.groups : []);
    if (groups.length) devices = devices.concat(devicesInGroups(groups));
  }

  const ms = input.now == null ? Date.now() : input.now;
  const out = [];
  const seenTokens = new Set();
  const enabledCache = new Map();
  const userEnabled = (uid) => {
    if (uid == null) return true;
    if (!enabledCache.has(uid)) enabledCache.set(uid, enabledUserIds([uid]).length === 1);
    return enabledCache.get(uid);
  };
  for (const d of devices) {
    if (seenTokens.has(d.token_id)) continue;
    seenTokens.add(d.token_id);
    if (!userEnabled(d.user_id)) continue;
    if (input.bypass) { out.push({ tokenId: d.token_id, userId: d.user_id, silent: false }); continue; }
    if (d.enabled === 0) continue;
    let muted = [];
    try { muted = JSON.parse(d.topics || '[]') || []; } catch { muted = []; }
    if (!critical && Array.isArray(muted) && muted.includes(topic)) continue;
    if (d.user_id != null && !critical && !topicOn(d.user_id, topic)) continue;
    // admin-only topics never reach a member's device through a group
    if (ADMIN_ONLY_TOPICS.has(topic) && d.user_id != null && !people.has(d.user_id) && !isAdmin(d.user_id)) continue;
    let silent = false;
    if (d.user_id != null) {
      const prefs = userPrefs(d.user_id);
      if (inQuietHours(prefs, ms)) silent = !(critical && (!prefs || prefs.critical_bypass !== 0));
    }
    out.push({ tokenId: d.token_id, userId: d.user_id, silent });
  }
  return out;
}

/** Is the token (and its owner) still valid? The open stream checks it on every keepalive. */
function tokenAlive(tokenId) {
  try {
    const t = require('../tokens').getById(tokenId);
    if (!t) return false;
    if (t.expires_at && new Date(t.expires_at) <= new Date()) return false;
    if (t.user_id) return require('../users').isEnabled(t.user_id);
    return true;
  } catch { return false; }
}

module.exports = {
  resolve, tokenAlive, adminIds, isAdmin, subscriberIds, ownerOf, topicOn, topicDefault, subscriptionOf,
  devicesOfUsers, devicesInGroups, devicesByIds, allDevices, isPushDevice,
  inQuietHours, localMinutes, validTz, serverTz, userPrefs, quietOf, HHMM_RE,
};
