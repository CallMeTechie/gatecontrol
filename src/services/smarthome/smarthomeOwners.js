// src/services/smarthome/smarthomeOwners.js
'use strict';

const { getDb } = require('../../db/connection');

const ASSIGNABLE = new Set(['light', 'plug', 'group']);

// Validate-before-write: resource must exist + be assignable; every userId must exist.
// On any failure throw and write nothing. Then replace the owner set atomically.
function setOwners(resourceId, userIds) {
  const db = getDb();
  const r = db.prepare('SELECT id, kind FROM smarthome_resources WHERE id = ?').get(resourceId);
  if (!r) { const e = new Error(`resource ${resourceId} not found`); e.code = 'SMARTHOME_RESOURCE_NOT_FOUND'; throw e; }
  if (!ASSIGNABLE.has(r.kind)) { const e = new Error(`resource ${resourceId} kind ${r.kind} not assignable`); e.code = 'SMARTHOME_NOT_ASSIGNABLE'; throw e; }
  const ids = [...new Set((Array.isArray(userIds) ? userIds : []).map(Number))]
    .filter((n) => Number.isInteger(n) && n > 0);
  for (const uid of ids) {
    if (!db.prepare('SELECT id FROM users WHERE id = ?').get(uid)) {
      const e = new Error(`unknown user ${uid}`); e.code = 'SMARTHOME_OWNER_UNKNOWN_USER'; throw e;
    }
  }
  db.transaction(() => {
    db.prepare('DELETE FROM smarthome_resource_owners WHERE resource_id = ?').run(resourceId);
    const ins = db.prepare('INSERT OR IGNORE INTO smarthome_resource_owners (resource_id, user_id) VALUES (?, ?)');
    for (const uid of ids) ins.run(resourceId, uid);
  })();
  return ownersOf(resourceId);
}

function ownersOf(resourceId) {
  return getDb().prepare(
    `SELECT u.id, u.username
       FROM smarthome_resource_owners o JOIN users u ON u.id = o.user_id
      WHERE o.resource_id = ?
      ORDER BY u.username`,
  ).all(resourceId);
}

// Direct ownership only.
function isOwner(resourceId, userId) {
  return !!getDb().prepare(
    'SELECT 1 FROM smarthome_resource_owners WHERE resource_id = ? AND user_id = ?',
  ).get(resourceId, userId);
}

// Direct-owned light/plug/group ids + scene ids whose group is owned (inheritance, §16).
function resourcesOwnedBy(userId) {
  const db = getDb();
  const owned = db.prepare('SELECT resource_id FROM smarthome_resource_owners WHERE user_id = ?')
    .all(userId).map((r) => r.resource_id);
  if (!owned.length) return [];
  const ph = owned.map(() => '?').join(',');
  const groups = db.prepare(
    `SELECT gateway_id, deconz_id FROM smarthome_resources WHERE id IN (${ph}) AND kind = 'group'`,
  ).all(...owned);
  const out = new Set(owned);
  // TP1 stores scene deconz_id as '<groupDeconzId>/<sceneIdx>'; group deconz_ids are integers → no LIKE wildcards.
  const sceneStmt = db.prepare("SELECT id FROM smarthome_resources WHERE gateway_id = ? AND kind = 'scene' AND enabled = 1 AND deconz_id LIKE ?");
  for (const g of groups) {
    for (const s of sceneStmt.all(g.gateway_id, `${g.deconz_id}/%`)) out.add(s.id);
  }
  return [...out];
}

// Portal control gate: direct ownership OR scene of an owned group.
function canAccess(resourceId, userId) {
  const r = getDb().prepare('SELECT enabled FROM smarthome_resources WHERE id = ?').get(resourceId);
  if (!r || !r.enabled) return false;
  if (isOwner(resourceId, userId)) return true;
  return resourcesOwnedBy(userId).includes(Number(resourceId));
}

// Bare deletes — NO own transaction (callers own the tx boundary).
function removeAllForResource(resourceId) {
  getDb().prepare('DELETE FROM smarthome_resource_owners WHERE resource_id = ?').run(resourceId);
}
function removeAllForUser(userId) {
  getDb().prepare('DELETE FROM smarthome_resource_owners WHERE user_id = ?').run(userId);
}

// For a scene, the "owners" shown read-only are its group's owners (§16 inheritance).
function inheritedOwnersOf(resource) {
  if (!resource || resource.kind !== 'scene') return [];
  const db = getDb();
  const groupDeconzId = String(resource.deconz_id).split('/')[0];
  const grp = db.prepare("SELECT id FROM smarthome_resources WHERE gateway_id = ? AND kind = 'group' AND deconz_id = ?")
    .get(resource.gateway_id, groupDeconzId);
  return grp ? ownersOf(grp.id) : [];
}

module.exports = { setOwners, ownersOf, isOwner, resourcesOwnedBy, canAccess, removeAllForResource, removeAllForUser, inheritedOwnersOf };
