'use strict';

const { getDb } = require('../../db/connection');

// Validate-before-write: every userId must be an existing user. On a single
// unknown id, throw and write nothing. Then replace the owner set atomically.
function setOwners(deviceId, userIds) {
  const db = getDb();
  // Defense-in-depth: the device must exist (Sub-B may call this without the
  // API's 404 guard). Phantom owner rows for a non-existent device are refused.
  if (!db.prepare('SELECT id FROM midea_devices WHERE id = ?').get(deviceId)) {
    const e = new Error(`device ${deviceId} not found`);
    e.code = 'MIDEA_DEVICE_NOT_FOUND';
    throw e;
  }
  // Tolerate a non-array; coerce to positive integers (Number(null)→0 excluded).
  const ids = [...new Set((Array.isArray(userIds) ? userIds : []).map(Number))]
    .filter((n) => Number.isInteger(n) && n > 0);
  for (const uid of ids) {
    if (!db.prepare('SELECT id FROM users WHERE id = ?').get(uid)) {
      const e = new Error(`unknown user ${uid}`);
      e.code = 'MIDEA_OWNER_UNKNOWN_USER';
      throw e;
    }
  }
  db.transaction(() => {
    db.prepare('DELETE FROM midea_device_owners WHERE midea_device_id = ?').run(deviceId);
    const ins = db.prepare('INSERT OR IGNORE INTO midea_device_owners (midea_device_id, user_id) VALUES (?, ?)');
    for (const uid of ids) ins.run(deviceId, uid);
  })();
  return ownersOf(deviceId);
}

function ownersOf(deviceId) {
  return getDb().prepare(
    `SELECT u.id, u.username
       FROM midea_device_owners o JOIN users u ON u.id = o.user_id
      WHERE o.midea_device_id = ?
      ORDER BY u.username`,
  ).all(deviceId);
}

function devicesOwnedBy(userId) {
  return getDb().prepare(
    'SELECT midea_device_id FROM midea_device_owners WHERE user_id = ? ORDER BY midea_device_id',
  ).all(userId).map((r) => r.midea_device_id);
}

function isOwner(deviceId, userId) {
  return !!getDb().prepare(
    'SELECT 1 FROM midea_device_owners WHERE midea_device_id = ? AND user_id = ?',
  ).get(deviceId, userId);
}

// Plain single-statement deletes — NO own transaction (callers own the tx boundary).
function removeAllForDevice(deviceId) {
  getDb().prepare('DELETE FROM midea_device_owners WHERE midea_device_id = ?').run(deviceId);
}
function removeAllForUser(userId) {
  getDb().prepare('DELETE FROM midea_device_owners WHERE user_id = ?').run(userId);
}

module.exports = { setOwners, ownersOf, devicesOwnedBy, isOwner, removeAllForDevice, removeAllForUser };
