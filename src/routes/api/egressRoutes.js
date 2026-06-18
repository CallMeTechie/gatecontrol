'use strict';
const express = require('express');
const { requireFeature } = require('../../middleware/license');
const svc = require('../../services/egressRoutes');
const gateways = require('../../services/gateways');

const router = express.Router();
router.use(requireFeature('gateway_scan_egress'));

const { getDb } = require('../../db/connection');
// notifyConfigChanged(peerId) takes a SINGLE peerId — call once per affected peer
// (near_peer_id + each pool member of near_pool_id).  Fire-and-forget like routes.js.
function pushNear(row) {
  const peers = new Set();
  if (row.near_peer_id) peers.add(row.near_peer_id);
  if (row.near_pool_id) {
    for (const m of getDb().prepare('SELECT peer_id FROM gateway_pool_members WHERE pool_id=?').all(row.near_pool_id))
      peers.add(m.peer_id);
  }
  for (const pid of peers) gateways.notifyConfigChanged(pid).catch(() => {});
}

router.get('/', (req, res) => res.json({ ok: true, data: svc.list() }));

router.post('/', (req, res, next) => {
  try {
    const row = svc.create(req.body);
    pushNear(row);
    res.status(201).json({ ok: true, data: row });
  } catch (e) {
    if (e.status === 400) return res.status(400).json({ ok: false, error: e.message });
    next(e);
  }
});

router.put('/:id', (req, res, next) => {
  try {
    const row = svc.update(Number(req.params.id), req.body);
    pushNear(row);
    res.json({ ok: true, data: row });
  } catch (e) {
    if (e.status === 400) return res.status(400).json({ ok: false, error: e.message });
    next(e);
  }
});

router.delete('/:id', (req, res, next) => {
  try {
    const row = svc.get(Number(req.params.id));
    svc.remove(Number(req.params.id));
    if (row) pushNear(row);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
