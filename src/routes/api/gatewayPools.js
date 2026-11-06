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

// Routes that aren't behind any pool yet — used by the migrate-routes modal.
// Must come BEFORE the `/:id` route so it isn't shadowed by the param match.
router.get('/migration-candidates', (req, res) => {
  const { getDb } = require('../../db/connection');
  const db = getDb();
  const routes = db.prepare(`
    SELECT r.id, r.domain, r.target_ip, r.target_port, r.target_peer_id,
           r.target_lan_host, r.target_lan_port,
           p.name AS peer_name
    FROM routes r
    JOIN peers p ON p.id = r.target_peer_id
    WHERE r.target_kind = 'gateway'
      AND r.target_pool_id IS NULL
      AND r.target_peer_id IS NOT NULL
      AND p.peer_type = 'gateway'
    ORDER BY p.name, r.domain
  `).all();
  const pools = gatewayPool.listPools().map(p => ({ id: p.id, name: p.name, mode: p.mode }));
  res.json({ routes, pools });
});

// Live state for the gateways page (services/gatewayPoolState.js): who serves
// each pool now, the other members, the reserve check, routes, last switches.
router.get('/state', (req, res) => {
  try {
    const st = require('../../services/gatewayPoolState').state();
    res.json({
      ok: true,
      ...st,
      licensed: { failover: license.hasFeature('gateway_pool_failover'), load_balancing: license.hasFeature('gateway_pool_load_balancing') },
    });
  } catch (err) {
    logger.error({ err: err.message }, 'gateway pool state failed');
    res.status(500).json({ ok: false, error: 'state_failed' });
  }
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
      switched(id);
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

// List members of a pool. Used by the edit modal — without this the
// frontend's GET /:id/members 404s and the modal renders as empty even
// when the DB has members.
router.get('/:id/members', (req, res) => {
  const poolId = parseInt(req.params.id, 10);
  if (!gatewayPool.getPool(poolId)) return res.status(404).json({ error: 'pool_not_found' });
  const { getDb } = require('../../db/connection');
  const members = getDb().prepare(`
    SELECT m.peer_id, m.priority, p.name AS peer_name
    FROM gateway_pool_members m
    JOIN peers p ON p.id = m.peer_id
    WHERE m.pool_id = ?
    ORDER BY m.priority ASC, m.peer_id ASC
  `).all(poolId);
  res.json(members);
});

// Bulk-migrate selected routes onto this pool. Body: { route_ids: [<int>...] }.
// Only updates routes that are still gateway-targeted and not already
// behind a pool. Triggers one caddy resync at the end so the new
// pool-resolution kicks in immediately.
router.post('/:id/migrate-routes', async (req, res) => {
  const poolId = parseInt(req.params.id, 10);
  if (!gatewayPool.getPool(poolId)) return res.status(404).json({ error: 'pool_not_found' });
  const ids = Array.isArray(req.body && req.body.route_ids) ? req.body.route_ids : null;
  if (!ids || ids.length === 0) return res.status(400).json({ error: 'route_ids_required' });
  const numericIds = ids.map((v) => parseInt(v, 10)).filter((v) => Number.isInteger(v));
  if (numericIds.length === 0) return res.status(400).json({ error: 'route_ids_invalid' });

  const { getDb } = require('../../db/connection');
  const placeholders = numericIds.map(() => '?').join(',');
  const result = getDb().prepare(`
    UPDATE routes
    SET target_peer_id = NULL,
        target_pool_id = ?,
        updated_at = datetime('now')
    WHERE id IN (${placeholders})
      AND target_kind = 'gateway'
      AND target_pool_id IS NULL
  `).run(poolId, ...numericIds);

  if (result.changes > 0) {
    try {
      await require('../../services/caddyConfig').syncToCaddy();
    } catch (err) {
      logger.error({ err: err.message, poolId }, 'caddy resync after migrate-routes failed');
      // Don't fail the API call — DB is updated and the next sync will pick up.
    }
  }

  res.json({ ok: true, migrated: result.changes });
});

// The members of a pool form one home network for the network watch and the
// DNS filter (services/homeNetwork.js gatewayHomes()): merge at once instead
// of with the next 5-minute run of gatewayOps.
function homesChanged() {
  try { require('../../services/gatewayOps').reconcileHomes(); } catch { /* the ticker catches up */ }
}

// An administrator changed members, order or mode: "Letzte Wechsel" notes who serves now.
function switched(poolId) {
  require('../../services/gatewayPoolState').recordSafely({ poolId, cause: 'config' });
}

router.post('/:id/members', async (req, res) => {
  const poolId = parseInt(req.params.id, 10);
  const { peer_id, priority } = req.body || {};
  if (!Number.isInteger(peer_id)) return res.status(400).json({ error: 'peer_id_required' });
  try {
    gatewayPool.addMember(poolId, peer_id, priority);
    homesChanged();
    await applyPoolMutationWithSequencing(poolId);
    switched(poolId);
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
    homesChanged();
    await applyPoolMutationWithSequencing(poolId);
    switched(poolId);
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
    homesChanged();
    await applyPoolMutationWithSequencing(poolId);
    switched(poolId);
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
    switched(poolId);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// Dissolve a pool (page "Pool auflösen …"): the routes, RDP routes and domain
// zones that point at it keep working, pinned to `pin_to` (a gateway; needed
// when anything points at the pool), then members and history go with it.
// Plain DELETE /:id stays as it was: refused while routes use the pool.
router.post('/:id/dissolve', async (req, res) => {
  const poolId = parseInt(req.params.id, 10);
  const raw = req.body && req.body.pin_to;
  const pinTo = raw == null || raw === '' ? null : parseInt(raw, 10);
  let r;
  try {
    r = require('../../services/gatewayPoolState').dissolve(poolId, Number.isInteger(pinTo) ? pinTo : null);
  } catch (err) {
    return res.status(err.status || 400).json({ ok: false, error: err.message });
  }
  homesChanged();
  try { await require('../../services/caddyConfig').syncToCaddy(); } catch (err) {
    logger.error({ err: err.message, poolId }, 'caddy resync after dissolving a pool failed');
  }
  const gateways = require('../../services/gateways');
  for (const id of new Set([...r.members, ...(Number.isInteger(pinTo) ? [pinTo] : [])])) {
    gateways.notifyConfigChanged(id).catch((err) => logger.debug({ err: err.message, peerId: id }, 'gateway config push failed (gateway re-polls anyway)'));
  }
  require('../../services/activity').log('gateway_pool_dissolved', `Gateway pool #${poolId} dissolved`,
    { source: 'admin', severity: 'info', details: { poolId, pinTo, routes: r.routes, rdp: r.rdp, zones: r.zones } });
  res.json({ ok: true, pinned: r.routes, rdp: r.rdp, zones: r.zones });
});

module.exports = router;
