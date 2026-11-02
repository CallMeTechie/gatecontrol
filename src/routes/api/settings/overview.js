'use strict';

// GET /api/v1/settings/overview — the start page of the settings
// (services/settingsOverview.js): tiles, "Braucht deine Aufmerksamkeit" and
// the current state of every section. Read only; texts come from the page.

const { Router } = require('express');
const overview = require('../../../services/settingsOverview');
const logger = require('../../../utils/logger');

const router = Router();

router.get('/overview', (req, res) => {
  try {
    res.json({ ok: true, data: overview.build({ lang: req.language === 'en' ? 'en' : 'de' }) });
  } catch (err) {
    logger.warn({ err: err.message }, 'GET /settings/overview failed');
    res.status(500).json({ ok: false, error: req.t('common.error') });
  }
});

module.exports = router;
