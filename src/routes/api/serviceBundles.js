'use strict';

const { Router } = require('express');
const bundles = require('../../services/serviceBundle');
const logger = require('../../utils/logger');
const { evaluateRouteLicense } = require('../../services/routeLicense');

const router = Router();

function deny(res, req, key, extra = {}) {
  return res.status(403).json({
    ok: false,
    error: req.t ? req.t(key) : key,
    upgrade_url: 'https://callmetechie.de/products/gatecontrol/pricing',
    ...extra,
  });
}

// A bundle creates several routes at once, so the per-type route limits
// must be checked COMBINED before anything is inserted — the per-route
// requireLimit middleware can't see how many rows one request will add.
function checkCreateLicense(req, res) {
  const body = req.body || {};
  const l4List = Array.isArray(body.l4) ? body.l4 : [];
  const verdict = evaluateRouteLicense({
    httpCount: body.http ? 1 : 0,
    l4Count: l4List.length,
    targetKind: (body.target || {}).target_kind,
    wol: !!(body.target && body.target.wol_enabled),
    scanEgress: false,
  });
  if (!verdict.ok) { deny(res, req, verdict.key, verdict.extra); return false; }
  return true;
}

function handleError(req, res, err, fallbackKey) {
  if (err.statusCode === 409 && err.conflict) {
    const c = err.conflict;
    const msg = c.suggestedPort
      ? req.t('error.bundles.port_conflict', { port: c.port, suggested: c.suggestedPort })
      : req.t('error.bundles.port_conflict_no_free', { port: c.port });
    return res.status(409).json({ ok: false, error: msg, code: err.code, conflict: c });
  }
  if (err.statusCode === 400) {
    return res.status(400).json({ ok: false, error: err.message });
  }
  if ((err.message || '').includes('Caddy')) {
    return res.status(502).json({ ok: false, error: req.t('error.routes.caddy_unreachable') });
  }
  logger.error({ error: err.message }, 'Service bundle operation failed');
  return res.status(500).json({ ok: false, error: req.t(fallbackKey) });
}

/** GET /api/v1/service-bundles — list bundles with member counts */
router.get('/', (req, res) => {
  try {
    res.json({ ok: true, bundles: bundles.listBundles() });
  } catch (err) {
    handleError(req, res, err, 'error.bundles.list');
  }
});

/** GET /api/v1/service-bundles/:id — bundle incl. member routes */
router.get('/:id', (req, res) => {
  try {
    const bundle = bundles.getBundle(parseInt(req.params.id, 10));
    if (!bundle) return res.status(404).json({ ok: false, error: req.t('error.bundles.not_found') });
    res.json({ ok: true, bundle });
  } catch (err) {
    handleError(req, res, err, 'error.bundles.list');
  }
});

// SSRF protection, same rule as POST /api/v1/routes: direct target_ip must
// not be private/loopback. Skipped for peer-linked targets (IP comes from
// the peer) and gateway targets (LAN host is reached via the WG tunnel).
function checkSsrf(req, res) {
  const target = (req.body && req.body.target) || {};
  if (!target.target_ip || target.peer_id || target.target_kind === 'gateway') return true;
  const parts = String(target.target_ip).split('.').map(Number);
  if (parts[0] === 127 || parts[0] === 10 ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 168) ||
      (parts[0] === 169 && parts[1] === 254) ||
      parts[0] === 0) {
    res.status(400).json({ ok: false, error: req.t('error.routes.private_ip') });
    return false;
  }
  return true;
}

/** POST /api/v1/service-bundles — create bundle + member routes atomically */
router.post('/', async (req, res) => {
  if (!checkCreateLicense(req, res)) return;
  if (!checkSsrf(req, res)) return;
  try {
    const bundle = await bundles.createBundle(req.body || {});
    res.status(201).json({ ok: true, bundle });
  } catch (err) {
    handleError(req, res, err, 'error.bundles.create');
  }
});

/** POST /api/v1/service-bundles/group — group existing routes */
router.post('/group', (req, res) => {
  try {
    const bundle = bundles.groupExisting(req.body || {});
    res.status(201).json({ ok: true, bundle });
  } catch (err) {
    handleError(req, res, err, 'error.bundles.group');
  }
});

/** POST /api/v1/service-bundles/:id/routes — attach existing routes to a bundle */
router.post('/:id/routes', (req, res) => {
  try {
    const bundle = bundles.addRoutesToBundle({
      bundle_id: parseInt(req.params.id, 10),
      route_ids: (req.body && req.body.route_ids) || [],
    });
    res.status(201).json({ ok: true, bundle });
  } catch (err) {
    handleError(req, res, err, 'error.bundles.add_routes');
  }
});

/** PUT /api/v1/service-bundles/:id — rename / re-describe */
router.put('/:id', (req, res) => {
  try {
    const bundle = bundles.updateBundle(parseInt(req.params.id, 10), req.body || {});
    res.json({ ok: true, bundle });
  } catch (err) {
    handleError(req, res, err, 'error.bundles.update');
  }
});

/** PUT /api/v1/service-bundles/:id/toggle — lockstep enable/disable */
router.put('/:id/toggle', async (req, res) => {
  try {
    const enabled = !!(req.body && req.body.enabled);
    const bundle = await bundles.toggleBundle(parseInt(req.params.id, 10), enabled);
    res.json({ ok: true, bundle });
  } catch (err) {
    handleError(req, res, err, 'error.bundles.toggle');
  }
});

/** DELETE /api/v1/service-bundles/:id?delete_routes=false — delete or ungroup */
router.delete('/:id', async (req, res) => {
  try {
    const deleteRoutes = req.query.delete_routes !== 'false';
    await bundles.removeBundle(parseInt(req.params.id, 10), { deleteRoutes });
    res.json({ ok: true });
  } catch (err) {
    handleError(req, res, err, 'error.bundles.delete');
  }
});

module.exports = router;
