'use strict';

const { getDb } = require('../db/connection');
const gatewayPool = require('./gatewayPool');
const logger = require('../utils/logger');

const CONFIRM_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 500;

function _peerIp(allowedIps) {
  return (allowedIps || '').split('/')[0].split(',')[0].trim();
}

async function applyPoolMutationWithSequencing(poolId) {
  const db = getDb();
  const members = gatewayPool.listMembers(poolId);

  const onlineMembers = [];
  const offlineMembers = [];
  for (const m of members) {
    const row = db.prepare(`
      SELECT gm.alive, gm.api_port, p.allowed_ips
      FROM gateway_meta gm JOIN peers p ON p.id = gm.peer_id
      WHERE gm.peer_id = ?
    `).get(m.peer_id);
    if (!row) continue;
    if (row.alive === 1) {
      onlineMembers.push({ ...m, ip: _peerIp(row.allowed_ips), api_port: row.api_port });
    } else {
      offlineMembers.push(m);
    }
  }

  if (offlineMembers.length > 0) {
    require('./activity').log(
      'pool_mutation_committed_with_offline_member',
      `Pool ${poolId} mutation applied while ${offlineMembers.length} member(s) offline`,
      { source: 'system', severity: 'info', details: { poolId, offline_peer_ids: offlineMembers.map(m => m.peer_id) } },
    );
  }

  if (onlineMembers.length === 0) {
    await require('./caddyConfig').syncToCaddy();
    return;
  }

  const confirms = await Promise.all(onlineMembers.map(m => _pushAndConfirm(m)));
  const failed = confirms.filter(c => !c.ok);
  if (failed.length > 0) {
    require('./activity').log(
      'pool_mutation_failed_companion_unreachable',
      `Pool ${poolId} mutation: ${failed.length} member(s) did not confirm`,
      { source: 'system', severity: 'error', details: { poolId, peer_ids: failed.map(f => f.peer_id) } },
    );
    throw new Error(`pool_mutation_companion_confirm_timeout: ${failed.map(f => f.peer_id).join(',')}`);
  }
  await require('./caddyConfig').syncToCaddy();
}

async function _pushAndConfirm(member) {
  const gateways = require('./gateways');
  const expectedHash = gateways.computeConfigHash(member.peer_id);

  await gateways.notifyConfigChanged(member.peer_id);

  const deadline = Date.now() + CONFIRM_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const row = getDb().prepare('SELECT last_config_hash FROM gateway_meta WHERE peer_id = ?').get(member.peer_id);
    if (row?.last_config_hash === expectedHash) {
      return { ok: true, peer_id: member.peer_id };
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
  return { ok: false, peer_id: member.peer_id };
}

module.exports = { applyPoolMutationWithSequencing };
