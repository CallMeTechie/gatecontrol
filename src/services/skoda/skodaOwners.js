'use strict';

const { getDb } = require('../../db/connection');

function err(message, code) { const e = new Error(message); e.code = code; return e; }

function setOwners(vehicleId, userIds) {
  const db = getDb();
  if (!db.prepare('SELECT id FROM skoda_vehicles WHERE id = ?').get(vehicleId)) {
    throw err('vehicle not found', 'SKODA_VEHICLE_NOT_FOUND');
  }
  const ids = [...new Set((userIds || []).map(Number))];
  for (const uid of ids) {
    if (!db.prepare('SELECT id FROM users WHERE id = ?').get(uid)) {
      throw err(`unknown user ${uid}`, 'SKODA_OWNER_UNKNOWN_USER');
    }
  }
  db.transaction(() => {
    db.prepare('DELETE FROM skoda_vehicle_owners WHERE skoda_vehicle_id = ?').run(vehicleId);
    const ins = db.prepare('INSERT INTO skoda_vehicle_owners (skoda_vehicle_id, user_id) VALUES (?, ?)');
    for (const uid of ids) ins.run(vehicleId, uid);
  })();
}

function ownersOf(vehicleId) {
  return getDb().prepare(`SELECT u.id, u.username FROM skoda_vehicle_owners o
    JOIN users u ON u.id = o.user_id WHERE o.skoda_vehicle_id = ? ORDER BY u.username`).all(vehicleId);
}

function vehiclesOwnedBy(userId) {
  return getDb().prepare('SELECT skoda_vehicle_id FROM skoda_vehicle_owners WHERE user_id = ?')
    .all(userId).map((r) => r.skoda_vehicle_id);
}

function isOwner(vehicleId, userId) {
  return Boolean(getDb().prepare('SELECT 1 FROM skoda_vehicle_owners WHERE skoda_vehicle_id = ? AND user_id = ?').get(vehicleId, userId));
}

function removeAllForVehicle(vehicleId) {
  getDb().prepare('DELETE FROM skoda_vehicle_owners WHERE skoda_vehicle_id = ?').run(vehicleId);
}

function removeAllForUser(userId) {
  getDb().prepare('DELETE FROM skoda_vehicle_owners WHERE user_id = ?').run(userId);
}

module.exports = { setOwners, ownersOf, vehiclesOwnedBy, isOwner, removeAllForVehicle, removeAllForUser };
