'use strict';

/**
 * Support bundle inbox (docs/feature-support-bundle.md "Admin-Oberfläche"):
 * every bundle of every device for the page System › Support-Pakete. Mounted
 * at /api/v1/support-bundles — admin sessions only (API tokens are refused,
 * like the per-peer routes in ./supportBundles.js).
 *
 *   GET / ?peerId=&status=new|viewed&limit=1..200&offset=
 *       → { ok, bundles, total, limit, offset, unviewed, peers }
 *
 * bundles: list shape plus peer_name, user_name (sender, else device owner),
 * viewed_by_name; peers: devices that have bundles (filter), with counts.
 */

const { Router } = require('express');
const { requireAdminSession } = require('../../middleware/auth');
const supportBundles = require('../../services/supportBundles');

const router = Router();

router.use(requireAdminSession);

function intParam(v, { min, max, def }) {
  if (v === undefined || v === '') return def;
  if (!/^\d{1,9}$/.test(String(v))) return NaN;
  const n = Number(v);
  return n < min || n > max ? NaN : n;
}

router.get('/', (req, res) => {
  const q = req.query || {};
  const peerId = intParam(q.peerId, { min: 1, max: 1e9, def: null });
  const limit = intParam(q.limit, { min: 1, max: 200, def: 50 });
  const offset = intParam(q.offset, { min: 0, max: 1e9, def: 0 });
  const status = q.status === undefined || q.status === '' || q.status === 'all' ? null : String(q.status);
  if (Number.isNaN(peerId) || Number.isNaN(limit) || Number.isNaN(offset) || (status && !supportBundles.STATUSES.has(status))) {
    return res.status(400).json({ ok: false, error: req.t('support_bundles.error_query') });
  }
  const { bundles, total } = supportBundles.listAll({ peerId, status, limit, offset });
  res.set('Cache-Control', 'no-store');
  res.json({
    ok: true,
    bundles,
    total,
    limit,
    offset,
    unviewed: supportBundles.unviewedCount(),
    peers: supportBundles.peersWithBundles(),
  });
});

module.exports = router;
