'use strict';

const { Router } = require('express');
const system = require('../../services/system');

const router = Router();

/**
 * GET /api/system/resources
 * Returns CPU, RAM, uptime, disk usage
 */
router.get('/resources', async (req, res) => {
  try {
    const resources = await system.getResources();
    res.json(resources);
  } catch (err) {
    res.status(500).json({ error: req.t('error.system.resources') });
  }
});

module.exports = router;
