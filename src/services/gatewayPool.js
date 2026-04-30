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

module.exports = {
  createPool, getPool, listPools, updatePool, deletePool,
  VALID_MODES, VALID_LB_POLICIES,
};
