'use strict';

/**
 * Who uses a device in the portal ("Wer nutzt dieses Gerät?").
 *
 *   single  (default) the portal shows the device owner right away — via the
 *           one-time login link of the app or, without one, via the device's
 *           VPN address (setting portal.trust_owner_mapping)
 *   multi   a shared device: the portal asks "Wer bist du?"; the owner and
 *           the people on device_users pick themselves and confirm with
 *           their portal PIN. Never any IP trust.
 *
 * The setting lives on the access (api_tokens.device_usage); the portal sees
 * a peer, so a peer counts as shared when any of its accesses is.
 */

const { getDb } = require('../db/connection');
const activity = require('./activity');

const USAGES = ['single', 'multi'];

function initials(name) {
  const words = String(name || '').trim().split(/[\s._-]+/).filter(Boolean);
  if (!words.length) return '?';
  const chars = words.length > 1
    ? [Array.from(words[0])[0], Array.from(words[1])[0]]
    : Array.from(words[0]).slice(0, 2);
  return chars.join('').toUpperCase();
}

function displayName(u) {
  return (u && (u.display_name || u.username)) || '';
}

function firstName(u) {
  return displayName(u).split(/\s+/)[0] || '';
}

/** User ids listed for one access (without the owner, who is always allowed). */
function listForToken(tokenId) {
  return getDb().prepare('SELECT user_id FROM device_users WHERE token_id = ? ORDER BY user_id').all(tokenId).map((r) => r.user_id);
}

/**
 * The portal view of a peer: { peerId, name, mode, ownerId, allowedUserIds }.
 * allowedUserIds only lists enabled accounts. null for an unknown peer.
 */
function usageForPeer(peerId) {
  if (peerId == null) return null;
  const db = getDb();
  const peer = db.prepare('SELECT id, name, user_id FROM peers WHERE id = ?').get(peerId);
  if (!peer) return null;
  const tokens = db.prepare('SELECT id, user_id, device_usage FROM api_tokens WHERE peer_id = ? ORDER BY id').all(peerId);
  const multi = tokens.filter((t) => t.device_usage === 'multi');
  const mode = multi.length ? 'multi' : 'single';
  const ownerId = peer.user_id != null ? peer.user_id : ((tokens.find((t) => t.user_id != null) || {}).user_id ?? null);
  const ids = new Set();
  if (ownerId != null) ids.add(ownerId);
  for (const t of tokens) if (t.user_id != null) ids.add(t.user_id);
  if (mode === 'multi') {
    for (const t of multi) for (const uid of listForToken(t.id)) ids.add(uid);
  }
  const enabled = ids.size
    ? db.prepare(`SELECT id FROM users WHERE enabled = 1 AND id IN (${[...ids].map(() => '?').join(',')})`).all(...ids).map((r) => r.id)
    : [];
  return { peerId: peer.id, name: peer.name, mode, ownerId, allowedUserIds: enabled };
}

/**
 * The people the picker shows on a shared device: first name and initials
 * only (no username, no e-mail), owner first, then by name.
 */
function peopleForPicker(peerId) {
  const info = usageForPeer(peerId);
  if (!info || info.mode !== 'multi' || !info.allowedUserIds.length) return [];
  const ids = info.allowedUserIds;
  const rows = getDb().prepare(`SELECT id, username, display_name FROM users WHERE enabled = 1 AND id IN (${ids.map(() => '?').join(',')})`).all(...ids);
  return rows
    .map((u) => ({ id: u.id, name: firstName(u), initials: initials(displayName(u)), owner: u.id === info.ownerId }))
    .sort((a, b) => (a.owner === b.owner ? a.name.localeCompare(b.name) : (a.owner ? -1 : 1)));
}

/**
 * May this account use the portal on this device right now? Single-person
 * device: only its owner. Shared device: the owner and the listed people.
 */
function userMayUseDevice(userId, peerId) {
  if (userId == null || peerId == null) return false;
  const info = usageForPeer(peerId);
  if (!info) return false;
  if (info.mode === 'multi') return info.allowedUserIds.includes(userId);
  if (info.ownerId === userId) return info.allowedUserIds.includes(userId);
  // A single-person device with several accesses of different owners: any of them.
  const row = getDb().prepare('SELECT 1 FROM api_tokens t JOIN users u ON u.id = t.user_id WHERE t.peer_id = ? AND t.user_id = ? AND u.enabled = 1').get(peerId, userId);
  return !!row;
}

/**
 * Validate a list of user ids for device_users (no writes): numbers of
 * existing accounts, deduplicated, without the owner. Throws INVALID_USERS
 * or USER_NOT_FOUND.
 */
function checkUsers(userIds, ownerId = null) {
  if (!Array.isArray(userIds) || userIds.length > 200) throw Object.assign(new Error('Invalid user list'), { code: 'INVALID_USERS' });
  let ids = [...new Set(userIds.map((v) => Number(v)))];
  if (ids.some((v) => !Number.isSafeInteger(v) || v <= 0)) throw Object.assign(new Error('Invalid user list'), { code: 'INVALID_USERS' });
  ids = ids.filter((v) => v !== ownerId);
  if (ids.length) {
    const found = getDb().prepare(`SELECT COUNT(*) AS c FROM users WHERE id IN (${ids.map(() => '?').join(',')})`).get(...ids).c;
    if (found !== ids.length) throw Object.assign(new Error('Unknown user'), { code: 'USER_NOT_FOUND' });
  }
  return ids;
}

/**
 * Admin: set who uses an access. `userIds` only matters for 'multi'; the
 * owner is never stored (always allowed). Unknown ids are refused.
 * Returns { usage, users }.
 */
function setUsage(tokenId, { usage, userIds }, { actorId = null, ip = null } = {}) {
  const db = getDb();
  const token = db.prepare('SELECT id, name, user_id, device_usage FROM api_tokens WHERE id = ?').get(tokenId);
  if (!token) throw Object.assign(new Error('Token not found'), { code: 'NOT_FOUND' });
  const next = usage === undefined ? token.device_usage : usage;
  if (!USAGES.includes(next)) throw Object.assign(new Error('Invalid device usage'), { code: 'INVALID_USAGE' });
  const ids = userIds === undefined ? null : checkUsers(userIds, token.user_id);
  db.transaction(() => {
    db.prepare('UPDATE api_tokens SET device_usage = ? WHERE id = ?').run(next, tokenId);
    if (ids) {
      db.prepare('DELETE FROM device_users WHERE token_id = ?').run(tokenId);
      const ins = db.prepare('INSERT INTO device_users (token_id, user_id) VALUES (?, ?)');
      for (const uid of ids) ins.run(tokenId, uid);
    }
  })();
  const users = listForToken(tokenId);
  activity.log('device_usage_changed', `Access "${token.name}" is used by ${next === 'multi' ? 'several people' : 'its owner only'}`, {
    source: 'admin', ipAddress: ip, severity: 'info', details: { tokenId, usage: next, users, actorId },
  });
  return { usage: next, users };
}

module.exports = { usageForPeer, peopleForPicker, userMayUseDevice, setUsage, checkUsers, listForToken, initials, firstName, displayName, USAGES };
