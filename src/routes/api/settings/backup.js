'use strict';

// Backup, restore, autobackup and activity-log housekeeping endpoints.
// Carved out of the legacy 863-LOC settings.js — semantics unchanged.

const { Router } = require('express');
const multer = require('multer');
const { rotateCsrfToken } = require('../../../middleware/csrf');
const activity = require('../../../services/activity');
const backup = require('../../../services/backup');
const logger = require('../../../utils/logger');
const { requireFeature } = require('../../../middleware/license');
const { uploadLimiter } = require('../../../middleware/rateLimit');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const router = Router();

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
router.post('/restore/preview', uploadLimiter, upload.single('backup'), (req, res) => {
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
router.post('/restore', uploadLimiter, upload.single('backup'), async (req, res) => {
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

/**
 * GET /api/settings/autobackup — Get auto-backup settings
 */
router.get('/autobackup', (req, res) => {
  try {
    const autobackup = require('../../../services/autobackup');
    const cfg = autobackup.getSettings();
    res.json({ ok: true, data: cfg });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to get auto-backup settings');
    res.status(500).json({ ok: false, error: req.t('error.autobackup.get') });
  }
});

/**
 * PUT /api/settings/autobackup — Update auto-backup settings
 */
router.put('/autobackup', requireFeature('scheduled_backups'), (req, res) => {
  try {
    const autobackup = require('../../../services/autobackup');
    const { enabled, schedule, retention } = req.body;
    autobackup.updateSettings({ enabled, schedule, retention });

    autobackup.restartScheduler();

    activity.log('autobackup_settings_updated', 'Auto-backup settings updated', {
      source: 'admin',
      ipAddress: req.ip,
      severity: 'info',
    });

    res.json({ ok: true });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to update auto-backup settings');
    res.status(500).json({ ok: false, error: req.t('error.autobackup.save') });
  }
});

/**
 * POST /api/settings/autobackup/run — Trigger immediate backup
 */
router.post('/autobackup/run', requireFeature('scheduled_backups'), (req, res) => {
  try {
    const autobackup = require('../../../services/autobackup');
    const filename = autobackup.runBackup();
    res.json({ ok: true, filename });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to run auto-backup');
    res.status(500).json({ ok: false, error: req.t('error.autobackup.run') });
  }
});

/**
 * GET /api/settings/autobackup/list — List existing backup files
 */
router.get('/autobackup/list', (req, res) => {
  try {
    const autobackup = require('../../../services/autobackup');
    const files = autobackup.listBackupFiles();
    res.json({ ok: true, files });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to list backup files');
    res.status(500).json({ ok: false, error: req.t('error.autobackup.list') });
  }
});

/**
 * GET /api/settings/autobackup/download/:filename — Download a backup file
 */
router.get('/autobackup/download/:filename', (req, res) => {
  try {
    const autobackup = require('../../../services/autobackup');
    const filepath = autobackup.getBackupFilePath(req.params.filename);
    if (!filepath) {
      return res.status(404).json({ ok: false, error: req.t('error.autobackup.not_found') });
    }
    res.setHeader('Content-Disposition', `attachment; filename="${req.params.filename}"`);
    res.setHeader('Content-Type', 'application/json');
    res.sendFile(filepath);
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to download backup file');
    res.status(500).json({ ok: false, error: req.t('error.autobackup.download') });
  }
});

/**
 * DELETE /api/settings/autobackup/:filename — Delete a backup file
 */
router.delete('/autobackup/:filename', (req, res) => {
  try {
    const autobackup = require('../../../services/autobackup');
    autobackup.deleteBackupFile(req.params.filename);

    activity.log('autobackup_file_deleted', `Backup file deleted: ${req.params.filename}`, {
      source: 'admin',
      ipAddress: req.ip,
      severity: 'info',
    });

    res.json({ ok: true });
  } catch (err) {
    if (err.message === 'Invalid filename') {
      return res.status(400).json({ ok: false, error: req.t('error.autobackup.invalid_filename') });
    }
    if (err.message === 'File not found') {
      return res.status(404).json({ ok: false, error: req.t('error.autobackup.not_found') });
    }
    logger.error({ error: err.message }, 'Failed to delete backup file');
    res.status(500).json({ ok: false, error: req.t('error.autobackup.delete') });
  }
});

// ═══ Release B: pre-migration snapshots ══════════════════════════════════
// docs/feature-release-b.md §4. All paths live under /backup/…, which the
// settings aggregator already refuses for token auth (session only); on top
// of that the admin role is required.

function requireAdminSession(req, res, next) {
  if (req.tokenAuth || !req.session || !req.session.userId) {
    return res.status(403).json({ ok: false, error: 'session required', code: 'SESSION_REQUIRED' });
  }
  const user = require('../../../services/users').getById(req.session.userId);
  if (!user || user.role !== 'admin') return res.status(403).json({ ok: false, error: 'admin required', code: 'ADMIN_REQUIRED' });
  next();
}

function sendOffsiteError(res, err, fallback) {
  logger.error({ error: err && err.message }, fallback);
  return res.status(500).json({ ok: false, error: fallback, code: 'INTERNAL' });
}

/**
 * GET /api/settings/backup/pre-migration — snapshots taken before migrations
 */
router.get('/backup/pre-migration', requireAdminSession, (req, res) => {
  try {
    const { listSnapshots } = require('../../../db/preMigrationBackup');
    const dbPath = require('../../../db/connection').getDb().name;
    res.json({ ok: true, files: listSnapshots(dbPath) });
  } catch (err) {
    sendOffsiteError(res, err, 'could not list pre-migration backups');
  }
});

/**
 * GET /api/settings/backup/pre-migration/:name — download one snapshot
 */
router.get('/backup/pre-migration/:name', requireAdminSession, (req, res) => {
  try {
    const { snapshotPath, parseName } = require('../../../db/preMigrationBackup');
    const name = req.params.name;
    if (!parseName(name)) return res.status(400).json({ ok: false, error: 'invalid file name', code: 'INVALID_NAME' });
    const p = snapshotPath(require('../../../db/connection').getDb().name, name);
    if (!p) return res.status(404).json({ ok: false, error: 'not found', code: 'NOT_FOUND' });
    activity.log('pre_migration_backup_downloaded', `Pre-migration backup downloaded: ${name}`, {
      source: 'admin', ipAddress: req.ip, severity: 'warning',
    });
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.setHeader('Content-Type', 'application/vnd.sqlite3');
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(p);
  } catch (err) {
    sendOffsiteError(res, err, 'download failed');
  }
});

module.exports = router;
