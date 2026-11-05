'use strict';

// Device accounts of a gateway's local MQTT broker (mosquitto, docs/plugins.md
// "Edge part" › "MQTT"). The broker accepts only these accounts (no anonymous
// access); the gateway's edge host writes password_file and acl_file from
// the `state` it gets (services/edge/state.js).
//
// Passwords: generated here, returned ONCE to whoever created the account,
// never stored, never logged. Kept is the mosquitto_passwd hash:
//   $7$<iterations>$<base64 salt (12 bytes)>$<base64 PBKDF2-HMAC-SHA512 (64 bytes)>
// (mosquitto ≥ 2.0, `mosquitto_passwd`, default 101 iterations) — the line
// of the password file is "<user>:<hash>".

const crypto = require('node:crypto');
const { getDb } = require('../../db/connection');
const edgeManifest = require('./manifest');

const HASH_ITERATIONS = 101;
const SALT_BYTES = 12;
const HASH_BYTES = 64;
const HASH_RE = /^\$7\$(\d{1,7})\$([A-Za-z0-9+/]+={0,2})\$([A-Za-z0-9+/]+={0,2})$/;
const USER_RE = /^[a-z0-9][a-z0-9_.-]{1,47}$/;
const ACCESS = new Set(['readwrite', 'read', 'write']);
const ACL_MAX = 16;
const LABEL_MAX = 80;
const ACCOUNTS_PER_GATEWAY = 500;
const ACCOUNTS_PER_PLUGIN = 200;
// user names the edge host keeps for itself (its internal account)
const RESERVED_USERS = new Set(['gc-edge', 'gatecontrol', 'edge', 'admin', 'root']);

class MqttError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

/** mosquitto `$7$` hash of `password` (fresh salt). */
function hashPassword(password, { iterations = HASH_ITERATIONS, salt } = {}) {
  const s = salt ? Buffer.from(salt) : crypto.randomBytes(SALT_BYTES);
  const dk = crypto.pbkdf2Sync(Buffer.from(String(password), 'utf8'), s, iterations, HASH_BYTES, 'sha512');
  return `$7$${iterations}$${s.toString('base64')}$${dk.toString('base64')}`;
}

/** Does `password` match the `$7$` hash (as mosquitto checks it)? */
function verifyPassword(password, hash) {
  const m = HASH_RE.exec(String(hash || ''));
  if (!m) return false;
  const want = Buffer.from(m[3], 'base64');
  const got = crypto.pbkdf2Sync(Buffer.from(String(password), 'utf8'), Buffer.from(m[2], 'base64'), Number(m[1]), want.length, 'sha512');
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

function newPassword() { return crypto.randomBytes(18).toString('base64url'); }

function db() { return getDb(); }

function rowView(r) {
  let acl = [];
  try { acl = JSON.parse(r.acl); } catch { acl = []; }
  return {
    id: r.id, gatewayId: r.peer_id, username: r.username, label: r.label || '', acl, pluginId: r.plugin_id || null,
    locked: r.locked === 1, createdAt: new Date(r.created_at).toISOString(), createdBy: r.created_by || null,
  };
}

/**
 * Normalise an ACL: [{ topic, access }]. Topic rules as plugin.json mqtt
 * topics (no leading wildcard, no $SYS); access readwrite | read | write.
 */
function normaliseAcl(list) {
  if (!Array.isArray(list) || list.length > ACL_MAX) throw new MqttError('invalid', 'topics: up to ' + ACL_MAX + ' entries');
  const out = [];
  for (const e of list) {
    const o = typeof e === 'string' ? { topic: e, access: 'readwrite' } : e;
    if (!o || typeof o !== 'object' || !edgeManifest.topicFilterOk(o.topic)) throw new MqttError('invalid', 'invalid topic');
    const access = o.access == null ? 'readwrite' : o.access;
    if (!ACCESS.has(access)) throw new MqttError('invalid', 'access must be readwrite, read or write');
    if (out.some((x) => x.topic === o.topic)) throw new MqttError('invalid', 'duplicate topic');
    out.push({ access, topic: o.topic });
  }
  return out;
}

function checkUser(username) {
  if (typeof username !== 'string' || !USER_RE.test(username) || RESERVED_USERS.has(username)) {
    throw new MqttError('invalid', 'user name: 2–48 of a-z 0-9 _ . - (starting with a letter or digit)');
  }
}

function labelOf(v) {
  if (v == null) return '';
  if (typeof v !== 'string') throw new MqttError('invalid', 'invalid label');
  return v.replace(/[\0-\x1f\x7f]/g, ' ').trim().slice(0, LABEL_MAX);
}

/**
 * A new account. `topics` empty → devices/<user>/#. `vendorPrefix`
 * (e.g. "shellies") adds <prefix>/<user>/# — devices that put their own
 * name below a fixed vendor topic.
 * @returns {{ account, password }}  the password only here, once
 */
function create(peerId, { username, label, topics, vendorPrefix, pluginId = null, by = null }) {
  checkUser(username);
  let acl = normaliseAcl(topics == null ? [] : topics);
  if (vendorPrefix != null && vendorPrefix !== '') {
    if (typeof vendorPrefix !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(vendorPrefix)) throw new MqttError('invalid', 'invalid vendor prefix');
    const t = `${vendorPrefix}/${username}/#`;
    if (!acl.some((x) => x.topic === t)) acl.push({ access: 'readwrite', topic: t });
  }
  if (!acl.length) acl = [{ access: 'readwrite', topic: `devices/${username}/#` }];
  if (acl.length > ACL_MAX) throw new MqttError('invalid', 'topics: up to ' + ACL_MAX + ' entries');
  const d = db();
  if (d.prepare('SELECT COUNT(*) AS n FROM mqtt_accounts WHERE peer_id = ?').get(peerId).n >= ACCOUNTS_PER_GATEWAY) throw new MqttError('limit', 'too many accounts on this gateway');
  if (pluginId && d.prepare('SELECT COUNT(*) AS n FROM mqtt_accounts WHERE peer_id = ? AND plugin_id = ?').get(peerId, pluginId).n >= ACCOUNTS_PER_PLUGIN) {
    throw new MqttError('limit', 'too many accounts of this plugin on this gateway');
  }
  if (d.prepare('SELECT 1 FROM mqtt_accounts WHERE peer_id = ? AND username = ?').get(peerId, username)) throw new MqttError('exists', 'user name exists already');
  const password = newPassword();
  const info = d.prepare(`INSERT INTO mqtt_accounts (peer_id, username, hash, label, acl, plugin_id, locked, created_at, created_by)
    VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`).run(peerId, username, hashPassword(password), labelOf(label), JSON.stringify(acl), pluginId, Date.now(), by);
  return { account: get(peerId, info.lastInsertRowid), password };
}

function get(peerId, id) {
  const r = db().prepare('SELECT * FROM mqtt_accounts WHERE peer_id = ? AND id = ?').get(peerId, Number(id));
  return r ? rowView(r) : null;
}

function list(peerId, { pluginId } = {}) {
  const rows = pluginId === undefined
    ? db().prepare('SELECT * FROM mqtt_accounts WHERE peer_id = ? ORDER BY username').all(peerId)
    : db().prepare('SELECT * FROM mqtt_accounts WHERE peer_id = ? AND plugin_id IS ? ORDER BY username').all(peerId, pluginId);
  return rows.map(rowView);
}

function setLocked(peerId, id, locked) {
  return db().prepare('UPDATE mqtt_accounts SET locked = ? WHERE peer_id = ? AND id = ?').run(locked ? 1 : 0, peerId, Number(id)).changes > 0;
}

/** A new password (the old one stops working with the next state). */
function resetPassword(peerId, id) {
  const password = newPassword();
  const ok = db().prepare('UPDATE mqtt_accounts SET hash = ? WHERE peer_id = ? AND id = ?').run(hashPassword(password), peerId, Number(id)).changes > 0;
  return ok ? password : null;
}

function remove(peerId, id) {
  return db().prepare('DELETE FROM mqtt_accounts WHERE peer_id = ? AND id = ?').run(peerId, Number(id)).changes > 0;
}

function removePlugin(pluginId) {
  db().prepare('DELETE FROM mqtt_accounts WHERE plugin_id = ?').run(pluginId);
}

/** Accounts for the `state` frame: unlocked ones, with hash and ACL (never a password). */
function forState(peerId) {
  return db().prepare('SELECT username, hash, acl FROM mqtt_accounts WHERE peer_id = ? AND locked = 0 ORDER BY username').all(peerId)
    .map((r) => {
      let acl = [];
      try { acl = JSON.parse(r.acl); } catch { acl = []; }
      return { user: r.username, hash: r.hash, acl };
    });
}

/**
 * Topics a plugin may hand to an account it creates: each must lie below one
 * of its plugin.json edge mqtt topics.
 */
function topicsAllowed(pluginTopics, acl) {
  return acl.every((e) => (pluginTopics || []).some((t) => edgeManifest.filterCovers(t, e.topic)));
}

module.exports = {
  hashPassword, verifyPassword, normaliseAcl, create, get, list, setLocked, resetPassword, remove, removePlugin, forState,
  topicsAllowed, checkUser, MqttError, HASH_ITERATIONS, USER_RE, ACCOUNTS_PER_GATEWAY, ACCOUNTS_PER_PLUGIN,
};
