'use strict';

const { Router } = require('express');
const activity = require('../../services/activity');

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
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch activity log' });
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
    res.json({ entries });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch recent activity' });
  }
});

module.exports = router;
