'use strict';

const express = require('express');
const gatewayPool = require('../../services/gatewayPool');
const license = require('../../services/license');
const { requireAuth } = require('../../middleware/auth');
const { requireFeature, requireFeatureField } = require('../../middleware/license');
const { applyPoolMutationWithSequencing } = require('../../services/gatewayPoolSync');
const logger = require('../../utils/logger');

const router = express.Router();

router.use(requireAuth);
router.use(requireFeature('gateway_pools'));

router.get('/', (req, res) => {
  const pools = gatewayPool.listPools();
  for (const p of pools) p.members = gatewayPool.listMembers(p.id);
  res.json(pools);
});

router.get('/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const pool = gatewayPool.getPool(id);
  if (!pool) return res.status(404).json({ error: 'pool_not_found' });
  pool.members = gatewayPool.listMembers(id);
  res.json(pool);
});

router.post('/',
  requireFeatureField('mode', 'gateway_pool_load_balancing', { onlyValue: 'load_balancing' }),
  (req, res) => {
    const limit = license.getFeatureLimit('gateway_pools_limit');
    const current = gatewayPool.listPools().length;
    if (limit > 0 && current >= limit) {
      return res.status(403).json({ ok: false, error: `gateway_pools_limit reached (${limit})` });
    }
    const { name, mode, lb_policy, failback_cooldown_s, outage_message } = req.body || {};
    if (!name) return res.status(400).json({ ok: false, error: 'name_required' });
    if (mode === 'failover' && !license.hasFeature('gateway_pool_failover')) {
      return res.status(403).json({ ok: false, error: 'feature_locked: gateway_pool_failover' });
    }
    try {
      const id = gatewayPool.createPool({ name, mode, lb_policy, failback_cooldown_s, outage_message });
      const pool = gatewayPool.getPool(id);
      pool.members = [];
      res.status(201).json(pool);
    } catch (err) {
      logger.warn({ err: err.message, body: req.body }, 'pool create failed');
      const status = /UNIQUE/.test(err.message) ? 409 : 400;
      res.status(status).json({ ok: false, error: err.message });
    }
  },
);

router.put('/:id',
  requireFeatureField('mode', 'gateway_pool_load_balancing', { onlyValue: 'load_balancing' }),
  async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!gatewayPool.getPool(id)) return res.status(404).json({ error: 'pool_not_found' });
    try {
      const updated = gatewayPool.updatePool(id, req.body || {});
      await applyPoolMutationWithSequencing(id);
      updated.members = gatewayPool.listMembers(id);
      res.json(updated);
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  },
);

router.delete('/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    gatewayPool.deletePool(id);
    res.status(204).send();
  } catch (err) {
    const status = /pool_in_use/.test(err.message) ? 409 : 400;
    res.status(status).json({ ok: false, error: err.message });
  }
});

router.post('/:id/members', async (req, res) => {
  const poolId = parseInt(req.params.id, 10);
  const { peer_id, priority } = req.body || {};
  if (!Number.isInteger(peer_id)) return res.status(400).json({ error: 'peer_id_required' });
  try {
    gatewayPool.addMember(poolId, peer_id, priority);
    await applyPoolMutationWithSequencing(poolId);
    res.status(201).json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

router.delete('/:id/members/:peerId', async (req, res) => {
  const poolId = parseInt(req.params.id, 10);
  const peerId = parseInt(req.params.peerId, 10);
  try {
    gatewayPool.removeMember(poolId, peerId);
    await applyPoolMutationWithSequencing(poolId);
    res.status(204).send();
  } catch (err) {
    const status = /last_member_in_use/.test(err.message) ? 409 : 400;
    res.status(status).json({ ok: false, error: err.message });
  }
});

// Bulk replace all members of a pool in one shot. Form submit uses this
// instead of N add/remove/setPriority calls so we trigger only one
// companion-confirm + caddy sync at the end (otherwise reconfiguring a
// 3-gateway pool means 3× the 10-second confirm window).
router.put('/:id/members', async (req, res) => {
  const poolId = parseInt(req.params.id, 10);
  if (!gatewayPool.getPool(poolId)) return res.status(404).json({ error: 'pool_not_found' });
  const members = Array.isArray(req.body) ? req.body : (req.body && req.body.members);
  if (!Array.isArray(members)) return res.status(400).json({ error: 'members_array_required' });
  try {
    const updated = gatewayPool.replaceMembers(poolId, members);
    await applyPoolMutationWithSequencing(poolId);
    res.json(updated);
  } catch (err) {
    const status = /last_member_in_use/.test(err.message) ? 409
      : /not_found|not_gateway/.test(err.message) ? 400
      : 400;
    res.status(status).json({ ok: false, error: err.message });
  }
});

router.put('/:id/members/:peerId', async (req, res) => {
  const poolId = parseInt(req.params.id, 10);
  const peerId = parseInt(req.params.peerId, 10);
  const { priority } = req.body || {};
  try {
    gatewayPool.setMemberPriority(poolId, peerId, priority);
    await applyPoolMutationWithSequencing(poolId);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

module.exports = router;
