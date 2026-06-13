'use strict';

const { Router } = require('express');
const { requireFeature } = require('../../middleware/license');
const pihole = require('../../services/pihole');
const activity = require('../../services/activity');
const logger = require('../../utils/logger');

const router = Router();

router.use(requireFeature('pihole_integration'));

function scopeFilter(req, items) {
  if (req.query.scope === 'self' && req.tokenPeerId) {
    return (items || []).filter(c => c.peerId === req.tokenPeerId);
  }
  return items;
}

router.get('/summary', (req, res) => {
  const cache = pihole.getCache();
  res.json({
    ok: true,
    data: {
      queries: cache.queries,
      gravity: cache.gravity,
      clients: cache.clients,
      blocking: cache.blocking,
      attribution: cache.attribution,
      lastSyncAt: cache.lastSyncAt,
    },
  });
});

router.get('/history', (req, res) => {
  const cache = pihole.getCache();
  res.json({ ok: true, data: cache.history });
});

router.get('/top-domains', (req, res) => {
  const cache = pihole.getCache();
  res.json({ ok: true, data: cache.topDomains });
});

router.get('/top-clients', (req, res) => {
  const cache = pihole.getCache();
  res.json({ ok: true, data: scopeFilter(req, cache.topClients) });
});

router.get('/query-types', (req, res) => {
  const cache = pihole.getCache();
  res.json({ ok: true, data: cache.queryTypes });
});

router.get('/health', (req, res) => {
  res.json({ ok: true, data: pihole.getStatus() });
});

router.post('/blocking', (req, res) => {
  const { enabled, timer } = req.body;
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ ok: false, error: 'enabled must be a boolean' });
  }
  const timerSec = Number.isInteger(timer) && timer >= 1 ? timer : undefined;
  pihole.setBlocking(enabled, timerSec).catch(err => logger.warn({ err: err.message }, 'pihole resync after setBlocking failed'));
  activity.log('pihole_blocking_changed', `Pi-hole blocking set to ${enabled}`, {
    source: req.user?.id || 'api',
    details: { enabled, timer: timerSec },
  });
  res.json({ ok: true });
});

module.exports = router;
