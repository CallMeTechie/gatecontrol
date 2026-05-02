'use strict';

const { getDb } = require('../db/connection');
const logger = require('../utils/logger');

const VALID_MODES = ['failover', 'load_balancing'];
const VALID_LB_POLICIES = ['round_robin', 'least_conn', 'ip_hash'];

function validateModeAndPolicy(mode, lb_policy) {
  if (!VALID_MODES.includes(mode)) {
    throw new Error(`invalid_mode: must be one of ${VALID_MODES.join(', ')}`);
  }
  if (mode === 'load_balancing') {
    if (!lb_policy) throw new Error('lb_policy required for mode=load_balancing');
    if (!VALID_LB_POLICIES.includes(lb_policy)) {
      throw new Error(`invalid_lb_policy: must be one of ${VALID_LB_POLICIES.join(', ')}`);
    }
  }
  if (mode === 'failover' && lb_policy != null) {
    throw new Error('lb_policy must be null in failover mode');
  }
}

function createPool({ name, mode, lb_policy = null, failback_cooldown_s, outage_message = null }) {
  if (!name || typeof name !== 'string') throw new Error('name required');
  if (!Number.isInteger(failback_cooldown_s) || failback_cooldown_s < 0) {
    throw new Error('failback_cooldown_s must be non-negative integer');
  }
  validateModeAndPolicy(mode, lb_policy);
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO gateway_pools (name, mode, lb_policy, failback_cooldown_s, outage_message)
    VALUES (?, ?, ?, ?, ?)
  `).run(name, mode, lb_policy, failback_cooldown_s, outage_message);
  logger.info({ poolId: result.lastInsertRowid, name, mode }, 'gateway_pool created');
  return result.lastInsertRowid;
}

function getPool(id) {
  return getDb().prepare('SELECT * FROM gateway_pools WHERE id = ?').get(id) || null;
}

function listPools() {
  return getDb().prepare('SELECT * FROM gateway_pools ORDER BY name').all();
}

function updatePool(id, fields) {
  const existing = getPool(id);
  if (!existing) throw new Error('pool_not_found');
  const merged = { ...existing, ...fields };
  validateModeAndPolicy(merged.mode, merged.lb_policy);
  const sets = [];
  const values = [];
  for (const k of ['name', 'mode', 'lb_policy', 'failback_cooldown_s', 'outage_message', 'enabled']) {
    if (fields[k] !== undefined) {
      sets.push(`${k} = ?`);
      values.push(fields[k]);
    }
  }
  if (sets.length === 0) return existing;
  sets.push("updated_at = datetime('now')");
  values.push(id);
  getDb().prepare(`UPDATE gateway_pools SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return getPool(id);
}

function deletePool(id) {
  const inUseHttp = getDb().prepare('SELECT COUNT(*) AS n FROM routes WHERE target_pool_id = ?').get(id).n;
  const inUseRdp = getDb().prepare('SELECT COUNT(*) AS n FROM rdp_routes WHERE gateway_pool_id = ?').get(id).n;
  if (inUseHttp + inUseRdp > 0) {
    throw new Error(`pool_in_use: ${inUseHttp} HTTP routes, ${inUseRdp} RDP routes still reference this pool`);
  }
  getDb().prepare('DELETE FROM gateway_pools WHERE id = ?').run(id);
  logger.info({ poolId: id }, 'gateway_pool deleted');
}

function addMember(poolId, peerId, priority = 100) {
  if (!Number.isInteger(priority)) throw new Error('priority must be integer');
  const db = getDb();
  const peer = db.prepare("SELECT id, peer_type FROM peers WHERE id = ?").get(peerId);
  if (!peer) throw new Error('peer_not_found');
  if (peer.peer_type !== 'gateway') throw new Error('peer_not_gateway');
  if (!getPool(poolId)) throw new Error('pool_not_found');
  db.prepare(`
    INSERT INTO gateway_pool_members (pool_id, peer_id, priority)
    VALUES (?, ?, ?)
  `).run(poolId, peerId, priority);
  logger.info({ poolId, peerId, priority }, 'gateway_pool member added');
}

function removeMember(poolId, peerId) {
  const remaining = getDb().prepare(
    'SELECT COUNT(*) AS n FROM gateway_pool_members WHERE pool_id = ? AND peer_id != ?'
  ).get(poolId, peerId).n;
  if (remaining === 0) {
    const used = getDb().prepare(`
      SELECT (
        (SELECT COUNT(*) FROM routes WHERE target_pool_id = ?) +
        (SELECT COUNT(*) FROM rdp_routes WHERE gateway_pool_id = ?)
      ) AS n
    `).get(poolId, poolId).n;
    if (used > 0) {
      throw new Error(`last_member_in_use: removing this member would leave pool empty while ${used} routes reference it`);
    }
  }
  getDb().prepare('DELETE FROM gateway_pool_members WHERE pool_id = ? AND peer_id = ?').run(poolId, peerId);
  logger.info({ poolId, peerId }, 'gateway_pool member removed');
}

function setMemberPriority(poolId, peerId, priority) {
  if (!Number.isInteger(priority)) throw new Error('priority must be integer');
  const result = getDb().prepare(
    'UPDATE gateway_pool_members SET priority = ? WHERE pool_id = ? AND peer_id = ?'
  ).run(priority, poolId, peerId);
  if (result.changes === 0) throw new Error('member_not_found');
}

// Replace the full member list of a pool atomically. Used by the form submit so
// the UI can build the desired state client-side and ship it in one call —
// otherwise N add/remove/setPriority round-trips each trigger their own
// companion-confirm + Caddy reload, which compounds latency and risks
// timeouts when 3+ gateways are reconfigured at once.
function replaceMembers(poolId, members) {
  if (!Array.isArray(members)) throw new Error('members must be an array');
  if (!getPool(poolId)) throw new Error('pool_not_found');

  const seen = new Set();
  for (const m of members) {
    if (!m || !Number.isInteger(m.peer_id)) throw new Error('peer_id must be integer');
    if (!Number.isInteger(m.priority)) throw new Error('priority must be integer');
    if (seen.has(m.peer_id)) throw new Error(`duplicate_peer: ${m.peer_id}`);
    seen.add(m.peer_id);
  }

  const db = getDb();
  for (const m of members) {
    const peer = db.prepare('SELECT id, peer_type FROM peers WHERE id = ?').get(m.peer_id);
    if (!peer) throw new Error(`peer_not_found: ${m.peer_id}`);
    if (peer.peer_type !== 'gateway') throw new Error(`peer_not_gateway: ${m.peer_id}`);
  }

  if (members.length === 0) {
    const used = db.prepare(`
      SELECT (
        (SELECT COUNT(*) FROM routes WHERE target_pool_id = ?) +
        (SELECT COUNT(*) FROM rdp_routes WHERE gateway_pool_id = ?)
      ) AS n
    `).get(poolId, poolId).n;
    if (used > 0) {
      throw new Error(`last_member_in_use: removing all members would leave pool empty while ${used} routes reference it`);
    }
  }

  const tx = db.transaction(() => {
    db.prepare('DELETE FROM gateway_pool_members WHERE pool_id = ?').run(poolId);
    const insert = db.prepare(
      'INSERT INTO gateway_pool_members (pool_id, peer_id, priority) VALUES (?, ?, ?)'
    );
    for (const m of members) insert.run(poolId, m.peer_id, m.priority);
  });
  tx();

  logger.info({ poolId, count: members.length }, 'gateway_pool members replaced');
  return listMembers(poolId);
}

function listMembers(poolId) {
  return getDb().prepare(`
    SELECT pool_id, peer_id, priority
    FROM gateway_pool_members
    WHERE pool_id = ?
    ORDER BY priority ASC, peer_id ASC
  `).all(poolId);
}

function listPoolsForPeer(peerId) {
  return getDb().prepare(`
    SELECT p.* FROM gateway_pools p
    JOIN gateway_pool_members m ON m.pool_id = p.id
    WHERE m.peer_id = ?
  `).all(peerId);
}

function isPeerInAnyPool(peerId) {
  const row = getDb().prepare(
    'SELECT 1 FROM gateway_pool_members WHERE peer_id = ? LIMIT 1'
  ).get(peerId);
  return !!row;
}

function getMaxCooldownForPeer(peerId) {
  const row = getDb().prepare(`
    SELECT MAX(p.failback_cooldown_s) AS max_cooldown
    FROM gateway_pools p
    JOIN gateway_pool_members m ON m.pool_id = p.id
    WHERE m.peer_id = ?
  `).get(peerId);
  return row?.max_cooldown ?? 0;
}

function resolveActivePeer(poolId, snapshot) {
  const pool = getPool(poolId);
  if (!pool || !pool.enabled) return null;
  const members = listMembers(poolId);
  for (const m of members) {
    if (snapshot[m.peer_id]?.alive) return m.peer_id;
  }
  return null;
}

function resolveActivePeers(poolId, snapshot) {
  const pool = getPool(poolId);
  if (!pool || !pool.enabled) return [];
  return listMembers(poolId)
    .filter(m => snapshot[m.peer_id]?.alive)
    .map(m => m.peer_id);
}

module.exports = {
  createPool, getPool, listPools, updatePool, deletePool,
  addMember, removeMember, setMemberPriority, replaceMembers, listMembers,
  listPoolsForPeer, isPeerInAnyPool, getMaxCooldownForPeer,
  resolveActivePeer, resolveActivePeers,
  VALID_MODES, VALID_LB_POLICIES,
};
