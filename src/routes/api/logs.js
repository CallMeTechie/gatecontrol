'use strict';

const { Router } = require('express');
const activity = require('../../services/activity');
const accessLog = require('../../services/accessLog');

const router = Router();

/**
 * GET /api/logs/activity?page=1&limit=50
 * Returns paginated activity log
 */
router.get('/activity', (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));

    const result = activity.getPaginated(page, limit);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: req.t('error.logs.activity') });
  }
});

/**
 * GET /api/logs/recent?limit=10
 * Returns recent activity entries (for dashboard widget)
 */
router.get('/recent', (req, res) => {
  try {
    const limit = Math.min(20, Math.max(1, parseInt(req.query.limit, 10) || 6));
    const entries = activity.getRecent(limit);
    res.json({ ok: true, entries });
  } catch (err) {
    res.status(500).json({ ok: false, error: req.t('error.logs.recent') });
  }
});

/**
 * GET /api/logs/access?page=1&limit=50&domain=&status=&method=
 * Returns paginated Caddy access log entries
 */
router.get('/access', async (req, res) => {
  try {
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const filters = {
      page: req.query.page || 1,
      domain: req.query.domain || '',
      status: req.query.status || '',
      method: req.query.method || '',
    };

    const result = await accessLog.getRecent(limit, filters);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: req.t('error.logs.access') });
  }
});

module.exports = router;
