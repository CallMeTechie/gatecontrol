'use strict';

const { Router } = require('express');
const argon2 = require('argon2');
const multer = require('multer');
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
    if (!profile) return res.status(404).json({ ok: false, error: 'User not found' });
    res.json({ ok: true, profile });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to get profile');
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * PUT /api/settings/profile — Update current user profile
 */
router.put('/profile', async (req, res) => {
  try {
    const { display_name, email, language } = req.body;

    // Validate language
    if (language && !config.i18n.availableLanguages.includes(language)) {
      return res.status(400).json({ ok: false, error: 'Unsupported language' });
    }

    const profile = settings.updateUserProfile(req.session.userId, {
      display_name, email, language,
    });

    // Update session language immediately
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
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * PUT /api/settings/password — Change password
 */
router.put('/password', async (req, res) => {
  try {
    const { current_password, new_password } = req.body;

    if (!current_password || !new_password) {
      return res.status(400).json({ ok: false, error: 'Current and new password are required' });
    }

    if (new_password.length < 8) {
      return res.status(400).json({ ok: false, error: 'New password must be at least 8 characters' });
    }

    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
    if (!user) return res.status(404).json({ ok: false, error: 'User not found' });

    // Verify current password
    const valid = await argon2.verify(user.password_hash, current_password);
    if (!valid) {
      return res.status(400).json({ ok: false, error: 'Current password is incorrect' });
    }

    // Hash new password
    const hash = await argon2.hash(new_password, {
      type: argon2.argon2id,
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 4,
    });

    db.prepare("UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?")
      .run(hash, req.session.userId);

    activity.log('password_changed', 'Password changed', {
      source: 'admin',
      ipAddress: req.ip,
      severity: 'info',
    });

    logger.info({ userId: req.session.userId }, 'Password changed');

    res.json({ ok: true });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to change password');
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * POST /api/settings/language — Quick language switch
 */
router.post('/language', (req, res) => {
  try {
    const { language } = req.body;
    if (!language || !config.i18n.availableLanguages.includes(language)) {
      return res.status(400).json({ ok: false, error: 'Unsupported language' });
    }

    // Update session
    req.session.language = language;

    // Update user record if logged in
    if (req.session.userId) {
      const db = getDb();
      db.prepare("UPDATE users SET language = ?, updated_at = datetime('now') WHERE id = ?")
        .run(language, req.session.userId);
    }

    res.json({ ok: true, language });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to switch language');
    res.status(500).json({ ok: false, error: err.message });
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
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * POST /api/settings/clear-logs — Clear activity log
 */
router.post('/clear-logs', async (req, res) => {
  try {
    const deleted = activity.cleanup(0); // Delete all
    activity.log('logs_cleared', 'Activity log cleared', {
      source: 'admin',
      ipAddress: req.ip,
      severity: 'warning',
    });
    res.json({ ok: true, deleted });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to clear logs');
    res.status(500).json({ ok: false, error: err.message });
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
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * POST /api/settings/restore/preview — Validate and preview backup
 */
router.post('/restore/preview', upload.single('backup'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ ok: false, error: 'No file uploaded' });
    }

    let data;
    try {
      data = JSON.parse(req.file.buffer.toString('utf-8'));
    } catch {
      return res.status(400).json({ ok: false, error: 'Invalid JSON file' });
    }

    const errors = backup.validateBackup(data);
    if (errors.length > 0) {
      return res.status(400).json({ ok: false, error: 'Invalid backup', errors });
    }

    const summary = backup.getBackupSummary(data);
    res.json({ ok: true, summary });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to preview backup');
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * POST /api/settings/restore — Restore from backup file
 */
router.post('/restore', upload.single('backup'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ ok: false, error: 'No file uploaded' });
    }

    let data;
    try {
      data = JSON.parse(req.file.buffer.toString('utf-8'));
    } catch {
      return res.status(400).json({ ok: false, error: 'Invalid JSON file' });
    }

    const result = await backup.restoreBackup(data);

    activity.log('backup_restored', `Backup restored: ${result.peers} peers, ${result.routes} routes`, {
      source: 'admin',
      ipAddress: req.ip,
      severity: 'warning',
    });

    res.json({ ok: true, restored: result });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to restore backup');
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
