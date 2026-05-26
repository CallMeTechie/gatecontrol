'use strict';

const { Router } = require('express');
const { getDb } = require('../../db/connection');
const logger = require('../../utils/logger');
const { requireFeature } = require('../../middleware/license');
const shareLinks = require('../../services/shareLinks');
const { syncToCaddy } = require('../../services/routes');

// Mounted at /api/v1/routes/:id/share-links (mergeParams for :id)
const router = Router({ mergeParams: true });

function getRoute(routeId) {
  return getDb().prepare('SELECT * FROM routes WHERE id = ?').get(routeId);
}

// POST / — create a share link (Pro: share_links)
router.post('/', requireFeature('share_links'), (req, res) => {
  (async () => {
    const routeId = Number(req.params.id);
    const route = getRoute(routeId);
    if (!route || !route.enabled) return res.status(404).json({ ok: false, error: 'not_found' });
    if (route.l4_listen_port) return res.status(409).json({ ok: false, error: 'l4_not_supported' });
    if (route.basic_auth_enabled) return res.status(409).json({ ok: false, error: 'disable_basic_auth' });

    const { expiresInHours, oneTime, label, confirmGate } = req.body || {};
    const hours = Number(expiresInHours);
    if (!Number.isFinite(hours) || hours <= 0 || hours > 8760) {
      return res.status(400).json({ ok: false, error: 'invalid_expiry' });
    }

    const db = getDb();
    const existingAuth = db.prepare('SELECT auth_type FROM route_auth WHERE route_id = ?').get(routeId);
    let gated = false;
    if (!existingAuth) {
      if (!confirmGate) return res.status(409).json({ ok: false, error: 'needs_gate_confirm' });
      gated = shareLinks.ensureShareGate(routeId);
    }

    const { token, expiresAt } = shareLinks.createShareLink(routeId, {
      expiresInHours: hours, oneTime: !!oneTime, label,
      userId: req.session && req.session.userId,
    });

    if (gated) {
      try { await syncToCaddy(); }
      catch (e) { logger.warn({ e: e.message }, 'caddy sync after share gate failed'); }
    }

    const url = `https://${route.domain}/route-auth/share/${token}`;
    res.status(201).json({ ok: true, url, expires_at: expiresAt });
  })().catch((err) => { logger.error({ err: err.message }, 'create share link'); res.status(500).json({ ok: false, error: req.t('common.error') }); });
});

// GET / — list active links (no token)
router.get('/', requireFeature('share_links'), (req, res) => {
  res.json({ ok: true, links: shareLinks.listShareLinks(Number(req.params.id)) });
});

// DELETE /:linkId — revoke
router.delete('/:linkId', requireFeature('share_links'), (req, res) => {
  const ok = shareLinks.revokeShareLink(Number(req.params.id), Number(req.params.linkId));
  if (!ok) return res.status(404).json({ ok: false, error: 'not_found' });
  res.json({ ok: true });
});

// POST /disable — turn sharing off (removes the share gate if present)
router.post('/disable', requireFeature('share_links'), (req, res) => {
  (async () => {
    const removedGate = shareLinks.disableSharing(Number(req.params.id));
    if (removedGate) { try { await syncToCaddy(); } catch (e) { logger.warn({ e: e.message }, 'caddy sync after disable'); } }
    res.json({ ok: true });
  })().catch((err) => res.status(500).json({ ok: false, error: req.t('common.error') }));
});

module.exports = router;
