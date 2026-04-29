'use strict';

// Appearance / app-level settings: getAll() bundle and system default theme.
// Carved out of the legacy 863-LOC settings.js — semantics unchanged.

const { Router } = require('express');
const { getDb } = require('../../../db/connection');
const settings = require('../../../services/settings');
const config = require('../../../../config/default');
const logger = require('../../../utils/logger');

const router = Router();

/**
 * GET /api/settings/app — Get app-level settings
 */
router.get('/app', (req, res) => {
  try {
    const appSettings = settings.getAll();
    res.json({
      ok: true,
      settings: appSettings,
      config: {
        appName: config.app.name,
        defaultLanguage: config.i18n.defaultLanguage,
        availableLanguages: config.i18n.availableLanguages,
        defaultTheme: config.theme.defaultTheme,
        wgHost: config.wireguard.host,
        wgPort: config.wireguard.port,
        wgSubnet: config.wireguard.subnet,
      },
    });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to get app settings');
    res.status(500).json({ ok: false, error: req.t('error.settings.app_get') });
  }
});

/**
 * PUT /api/settings/default-theme — Set system default theme
 */
router.put('/default-theme', (req, res) => {
  try {
    const { theme } = req.body;
    const validThemes = ['default', 'pro'];
    if (!theme || !validThemes.includes(theme)) {
      return res.status(400).json({ ok: false, error: 'Invalid theme. Must be: ' + validThemes.join(', ') });
    }
    settings.set('default_theme', theme);
    // Also update the current user's personal theme so the change is
    // visible immediately (user.theme overrides system default in locals.js)
    if (req.session && req.session.userId) {
      const db = getDb();
      db.prepare('UPDATE users SET theme = ? WHERE id = ?').run(theme, req.session.userId);
    }
    res.json({ ok: true, theme });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to set default theme');
    res.status(500).json({ ok: false, error: 'Failed to save theme setting' });
  }
});

module.exports = router;
