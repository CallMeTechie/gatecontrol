'use strict';

const { Router } = require('express');
const argon2 = require('argon2');
const argon2Options = require('../../utils/argon2Options');
const multer = require('multer');
const { rotateCsrfToken } = require('../../middleware/csrf');
const { getDb } = require('../../db/connection');
const settings = require('../../services/settings');
const activity = require('../../services/activity');
const backup = require('../../services/backup');
const config = require('../../../config/default');
const logger = require('../../utils/logger');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

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
    const { display_name, email, language } = req.body;

    if (language && !config.i18n.availableLanguages.includes(language)) {
      return res.status(400).json({ ok: false, error: req.t('error.settings.language_unsupported') });
    }

    const profile = settings.updateUserProfile(req.session.userId, {
      display_name, email, language,
    });

    if (language) {
      req.session.language = language;
    }

    activity.log('profile_updated', `Profile updated`, {
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

    // Check password complexity
    const { validatePasswordComplexity } = require('../../utils/validate');
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
 * POST /api/settings/clear-logs — Clear activity log
 */
router.post('/clear-logs', async (req, res) => {
  try {
    const deleted = activity.cleanup(0);
    activity.log('logs_cleared', 'Activity log cleared', {
      source: 'admin',
      ipAddress: req.ip,
      severity: 'warning',
    });
    res.json({ ok: true, deleted });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to clear logs');
    res.status(500).json({ ok: false, error: req.t('error.settings.logs_clear') });
  }
});

/**
 * GET /api/settings/backup — Download backup as JSON
 */
router.get('/backup', (req, res) => {
  try {
    const data = backup.createBackup();
    const filename = `gatecontrol-backup-${new Date().toISOString().slice(0, 10)}.json`;

    activity.log('backup_created', 'Backup downloaded', {
      source: 'admin',
      ipAddress: req.ip,
      severity: 'info',
    });

    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/json');
    res.json(data);
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to create backup');
    res.status(500).json({ ok: false, error: req.t('error.backup.create') });
  }
});

/**
 * POST /api/settings/restore/preview — Validate and preview backup
 */
router.post('/restore/preview', upload.single('backup'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ ok: false, error: req.t('error.backup.no_file') });
    }

    let data;
    try {
      data = JSON.parse(req.file.buffer.toString('utf-8'));
    } catch {
      return res.status(400).json({ ok: false, error: req.t('error.backup.invalid_json') });
    }

    const errors = backup.validateBackup(data);
    if (errors.length > 0) {
      return res.status(400).json({ ok: false, error: req.t('error.backup.invalid'), errors });
    }

    const summary = backup.getBackupSummary(data);
    res.json({ ok: true, summary });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to preview backup');
    res.status(500).json({ ok: false, error: req.t('error.backup.preview') });
  }
});

/**
 * POST /api/settings/restore — Restore from backup file
 */
router.post('/restore', upload.single('backup'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ ok: false, error: req.t('error.backup.no_file') });
    }

    let data;
    try {
      data = JSON.parse(req.file.buffer.toString('utf-8'));
    } catch {
      return res.status(400).json({ ok: false, error: req.t('error.backup.invalid_json') });
    }

    const result = await backup.restoreBackup(data);

    activity.log('backup_restored', `Backup restored: ${result.peers} peers, ${result.routes} routes`, {
      source: 'admin',
      ipAddress: req.ip,
      severity: 'warning',
    });

    const newToken = rotateCsrfToken(req);
    res.json({ ok: true, restored: result, csrfToken: newToken });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to restore backup');
    res.status(500).json({ ok: false, error: req.t('error.backup.restore') });
  }
});

// ─── Security Settings ─────────────────────────────────

/**
 * GET /api/settings/security — Get security settings
 */
router.get('/security', (req, res) => {
  res.json({
    ok: true,
    data: {
      lockout: {
        enabled: settings.get('security.lockout.enabled', 'true') === 'true',
        max_attempts: parseInt(settings.get('security.lockout.max_attempts', '5'), 10),
        duration: parseInt(settings.get('security.lockout.duration', '15'), 10),
      },
      password: {
        complexity_enabled: settings.get('security.password.complexity_enabled', 'false') === 'true',
        min_length: parseInt(settings.get('security.password.min_length', '8'), 10),
        require_uppercase: settings.get('security.password.require_uppercase', 'true') === 'true',
        require_number: settings.get('security.password.require_number', 'true') === 'true',
        require_special: settings.get('security.password.require_special', 'true') === 'true',
      },
    },
  });
});

/**
 * PUT /api/settings/security — Update security settings
 */
router.put('/security', (req, res) => {
  try {
    const { lockout: lo, password: pw } = req.body;

    if (lo) {
      if (lo.enabled !== undefined) settings.set('security.lockout.enabled', String(lo.enabled));
      if (lo.max_attempts !== undefined) {
        const val = parseInt(lo.max_attempts, 10);
        if (val >= 1 && val <= 100) settings.set('security.lockout.max_attempts', String(val));
      }
      if (lo.duration !== undefined) {
        const val = parseInt(lo.duration, 10);
        if (val >= 1 && val <= 1440) settings.set('security.lockout.duration', String(val));
      }
    }

    if (pw) {
      if (pw.complexity_enabled !== undefined) settings.set('security.password.complexity_enabled', String(pw.complexity_enabled));
      if (pw.min_length !== undefined) {
        const val = parseInt(pw.min_length, 10);
        if (val >= 4 && val <= 128) settings.set('security.password.min_length', String(val));
      }
      if (pw.require_uppercase !== undefined) settings.set('security.password.require_uppercase', String(pw.require_uppercase));
      if (pw.require_number !== undefined) settings.set('security.password.require_number', String(pw.require_number));
      if (pw.require_special !== undefined) settings.set('security.password.require_special', String(pw.require_special));
    }

    activity.log('security_settings_updated', 'Security settings updated', {
      source: 'admin',
      ipAddress: req.ip,
      severity: 'info',
    });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: req.t('common.error') });
  }
});

/**
 * GET /api/settings/lockout — Get currently locked accounts
 */
router.get('/lockout', (req, res) => {
  const lockoutService = require('../../services/lockout');
  res.json({ ok: true, locked: lockoutService.getLockedAccounts() });
});

/**
 * DELETE /api/settings/lockout/:identifier — Unlock an account
 */
router.delete('/lockout/:identifier', (req, res) => {
  const lockoutService = require('../../services/lockout');
  lockoutService.unlockAccount(decodeURIComponent(req.params.identifier));
  activity.log('account_unlocked', `Account unlocked: ${decodeURIComponent(req.params.identifier)}`, {
    source: 'admin',
    ipAddress: req.ip,
    severity: 'info',
  });
  res.json({ ok: true });
});

module.exports = router;
