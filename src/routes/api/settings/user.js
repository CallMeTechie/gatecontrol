'use strict';

// User-account settings: profile, password change, language switch.
// Carved out of the legacy 863-LOC settings.js — semantics unchanged.

const { Router } = require('express');
const argon2 = require('argon2');
const argon2Options = require('../../../utils/argon2Options');
const { rotateCsrfToken } = require('../../../middleware/csrf');
const { getDb } = require('../../../db/connection');
const settings = require('../../../services/settings');
const activity = require('../../../services/activity');
const config = require('../../../../config/default');
const logger = require('../../../utils/logger');

const router = Router();

/**
 * GET /api/settings/profile — Get current user profile
 */
router.get('/profile', (req, res) => {
  try {
    const profile = settings.getUserProfile(req.session.userId);
    if (!profile) return res.status(404).json({ ok: false, error: req.t('error.settings.user_not_found') });
    res.json({ ok: true, profile });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to get profile');
    res.status(500).json({ ok: false, error: req.t('error.settings.profile_get') });
  }
});

/**
 * PUT /api/settings/profile — Update current user profile
 */
router.put('/profile', async (req, res) => {
  try {
    const { display_name, email, language, theme } = req.body;

    if (language && !config.i18n.availableLanguages.includes(language)) {
      return res.status(400).json({ ok: false, error: req.t('error.settings.language_unsupported') });
    }

    const availableThemes = ['default', 'pro'];
    if (theme && !availableThemes.includes(theme)) {
      return res.status(400).json({ ok: false, error: 'Invalid theme' });
    }

    const profile = settings.updateUserProfile(req.session.userId, {
      display_name, email, language, theme,
    });

    if (language) req.session.language = language;

    activity.log('profile_updated', 'Profile updated', {
      source: 'admin',
      ipAddress: req.ip,
      severity: 'info',
    });

    res.json({ ok: true, profile });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to update profile');
    res.status(500).json({ ok: false, error: req.t('error.settings.profile_update') });
  }
});

/**
 * PUT /api/settings/password — Change password
 */
router.put('/password', async (req, res) => {
  try {
    const { current_password, new_password } = req.body;

    if (!current_password || !new_password) {
      return res.status(400).json({ ok: false, error: req.t('error.settings.password_required') });
    }

    if (new_password.length < 8) {
      return res.status(400).json({ ok: false, error: req.t('error.settings.password_min_length') });
    }

    const { validatePasswordComplexity } = require('../../../utils/validate');
    const complexityErrors = validatePasswordComplexity(new_password);
    if (complexityErrors) {
      const msg = complexityErrors.map(e => req.t(e.key).replace('{{min}}', e.params?.min || '')).join(', ');
      return res.status(400).json({ ok: false, error: msg });
    }

    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
    if (!user) return res.status(404).json({ ok: false, error: req.t('error.settings.user_not_found') });

    const valid = await argon2.verify(user.password_hash, current_password);
    if (!valid) {
      return res.status(400).json({ ok: false, error: req.t('error.settings.password_incorrect') });
    }

    const hash = await argon2.hash(new_password, argon2Options);

    db.prepare("UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?")
      .run(hash, req.session.userId);

    activity.log('password_changed', 'Password changed', {
      source: 'admin',
      ipAddress: req.ip,
      severity: 'info',
    });

    logger.info({ userId: req.session.userId }, 'Password changed');

    const newToken = rotateCsrfToken(req);
    res.json({ ok: true, csrfToken: newToken });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to change password');
    res.status(500).json({ ok: false, error: req.t('error.settings.password_change') });
  }
});

/**
 * POST /api/settings/language — Quick language switch
 */
router.post('/language', (req, res) => {
  try {
    const { language } = req.body;
    if (!language || !config.i18n.availableLanguages.includes(language)) {
      return res.status(400).json({ ok: false, error: req.t('error.settings.language_unsupported') });
    }

    req.session.language = language;

    if (req.session.userId) {
      const db = getDb();
      db.prepare("UPDATE users SET language = ?, updated_at = datetime('now') WHERE id = ?")
        .run(language, req.session.userId);
    }

    res.json({ ok: true, language });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to switch language');
    res.status(500).json({ ok: false, error: req.t('error.settings.language_switch') });
  }
});

module.exports = router;
