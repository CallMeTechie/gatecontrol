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
const gcbk = require('../../../services/offsite/gcbk');

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


// ── Encrypted archives (.gcbk, docs/feature-release-b.md §7) ──────────────
async function openArchive(req) {
  const given = req.body && typeof req.body.passphrase === 'string' && req.body.passphrase !== '' ? req.body.passphrase : null;
  const passphrase = given || require('../../../services/offsite').getPassphrase();
  if (!passphrase) throw new gcbk.GcbkError('PASSPHRASE_REQUIRED', 'passphrase required for an encrypted backup');
  return gcbk.decryptBackup(req.file.buffer, passphrase);
}
function sendArchiveError(res, err) {
  if (err instanceof gcbk.GcbkError) return res.status(400).json({ ok: false, error: err.message, code: err.code });
  logger.error({ error: err.message }, 'Failed to open encrypted backup');
  return res.status(500).json({ ok: false, error: 'could not open the encrypted backup', code: 'DECRYPT_FAILED' });
}

/**
 * POST /api/settings/restore/preview — Validate and preview backup
 */
router.post('/restore/preview', uploadLimiter, upload.single('backup'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ ok: false, error: req.t('error.backup.no_file') });
    }

    let data;
    let archive = null;
    if (gcbk.isGcbk(req.file.buffer)) {
      try {
        archive = await openArchive(req);
      } catch (err) {
        return sendArchiveError(res, err);
      }
      data = archive.payload.backup;
    } else {
      try {
        data = JSON.parse(req.file.buffer.toString('utf-8'));
      } catch {
        return res.status(400).json({ ok: false, error: req.t('error.backup.invalid_json') });
      }
    }

    const errors = backup.validateBackup(data);
    if (errors.length > 0) {
      return res.status(400).json({ ok: false, error: req.t('error.backup.invalid'), errors });
    }

    const summary = backup.getBackupSummary(data);
    res.json({ ok: true, summary, ...(archive ? { encrypted: true, include_key: !!archive.payload.encryption_key, gc_version: archive.header.gc_version || null } : {}) });
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
    if (gcbk.isGcbk(req.file.buffer)) {
      // Encrypted off-site archive (.gcbk): passphrase from the form field, else
      // the configured one (restore on the same installation). With an archived
      // GC_ENCRYPTION_KEY the secrets are re-encrypted to this installation's key.
      let archive;
      try {
        archive = await openArchive(req);
      } catch (err) {
        return sendArchiveError(res, err);
      }
      data = archive.payload.backup;
      const current = require('../../../../config/default').encryption.key;
      if (archive.payload.encryption_key && current && archive.payload.encryption_key.toLowerCase() !== current.toLowerCase()) {
        const { rekeyBackup } = require('../../../services/offsite/rekey');
        const r = rekeyBackup(data, archive.payload.encryption_key, current);
        data = r.backup;
        logger.info({ converted: r.converted }, 'Restore: secrets re-encrypted from the archived key');
      }
    } else {
      try {
        data = JSON.parse(req.file.buffer.toString('utf-8'));
      } catch {
        return res.status(400).json({ ok: false, error: req.t('error.backup.invalid_json') });
      }
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

// ═══ Release B: pre-migration snapshots + off-site backups ═══════════════
// docs/feature-release-b.md §4 / §7. All paths live under /backup/…, which the
// settings aggregator already refuses for token auth (session only); on top
// of that the admin role is required. Off-site changes/transfers need the
// `scheduled_backups` license feature (like autobackup).

function requireAdminSession(req, res, next) {
  if (req.tokenAuth || !req.session || !req.session.userId) {
    return res.status(403).json({ ok: false, error: 'session required', code: 'SESSION_REQUIRED' });
  }
  const user = require('../../../services/users').getById(req.session.userId);
  if (!user || user.role !== 'admin') return res.status(403).json({ ok: false, error: 'admin required', code: 'ADMIN_REQUIRED' });
  next();
}

function sendOffsiteError(res, err, fallback) {
  if (err && err.code === 'TRANSPORT') return res.status(502).json({ ok: false, error: err.message, code: 'TRANSPORT_FAILED' });
  if (err instanceof offsite().OffsiteError) {
    return res.status(err.status).json({ ok: false, error: err.message, code: err.code, ...(err.field ? { field: err.field } : {}) });
  }
  if (err instanceof gcbk.GcbkError) return res.status(400).json({ ok: false, error: err.message, code: err.code });
  logger.error({ error: err && err.message }, fallback);
  return res.status(500).json({ ok: false, error: fallback, code: 'INTERNAL' });
}

const offsite = () => require('../../../services/offsite');
const licensed = requireFeature('scheduled_backups');

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

/**
 * GET/PUT /api/settings/backup/offsite — { passphrase?, include_key } → { passphrase_set, include_key }
 */
router.get('/backup/offsite', requireAdminSession, (req, res) => {
  try { res.json({ ok: true, ...offsite().getOffsiteSettings() }); }
  catch (err) { sendOffsiteError(res, err, 'could not read off-site settings'); }
});

router.put('/backup/offsite', requireAdminSession, licensed, (req, res) => {
  try {
    const r = offsite().updateOffsiteSettings(req.body || {});
    activity.log('offsite_settings_updated', 'Off-site backup settings updated', { source: 'admin', ipAddress: req.ip, severity: 'info' });
    res.json({ ok: true, ...r });
  } catch (err) {
    sendOffsiteError(res, err, 'could not save off-site settings');
  }
});

/**
 * GET/POST /api/settings/backup/ssh-key(/rotate) — public key for SFTP targets
 */
router.get('/backup/ssh-key', requireAdminSession, licensed, (req, res) => {
  try { res.json({ ok: true, public_key: offsite().ensureSshKey() }); }
  catch (err) { sendOffsiteError(res, err, 'could not read the SSH key'); }
});

router.post('/backup/ssh-key/rotate', requireAdminSession, licensed, (req, res) => {
  try {
    const pub = offsite().rotateSshKey();
    activity.log('offsite_ssh_key_rotated', 'Off-site backup SSH key rotated', { source: 'admin', ipAddress: req.ip, severity: 'warning' });
    res.json({ ok: true, public_key: pub });
  } catch (err) {
    sendOffsiteError(res, err, 'could not rotate the SSH key');
  }
});

/**
 * Targets
 */
router.get('/backup/targets', requireAdminSession, (req, res) => {
  try { res.json({ ok: true, targets: offsite().listTargets() }); }
  catch (err) { sendOffsiteError(res, err, 'could not list targets'); }
});

router.get('/backup/targets/l4-candidates', requireAdminSession, (req, res) => {
  try { res.json({ ok: true, routes: offsite().l4Candidates() }); }
  catch (err) { sendOffsiteError(res, err, 'could not list L4 routes'); }
});

router.post('/backup/targets', requireAdminSession, licensed, (req, res) => {
  try {
    const target = offsite().createTarget(req.body || {});
    activity.log('offsite_target_created', `Off-site backup target created: ${target.name} (${target.type})`, { source: 'admin', ipAddress: req.ip, severity: 'info' });
    res.status(201).json({ ok: true, target });
  } catch (err) {
    sendOffsiteError(res, err, 'could not create target');
  }
});

function targetId(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) { res.status(400).json({ ok: false, error: 'invalid id', code: 'INVALID_ID' }); return null; }
  return id;
}

router.put('/backup/targets/:id', requireAdminSession, licensed, async (req, res) => {
  const id = targetId(req, res); if (id === null) return;
  try {
    const target = await offsite().updateTarget(id, req.body || {});
    activity.log('offsite_target_updated', `Off-site backup target updated: ${target.name}`, { source: 'admin', ipAddress: req.ip, severity: 'info' });
    res.json({ ok: true, target });
  } catch (err) {
    sendOffsiteError(res, err, 'could not update target');
  }
});

router.delete('/backup/targets/:id', requireAdminSession, licensed, async (req, res) => {
  const id = targetId(req, res); if (id === null) return;
  try {
    const t = offsite().getTarget(id);
    await offsite().deleteTarget(id);
    activity.log('offsite_target_deleted', `Off-site backup target deleted: ${t ? t.name : id}`, { source: 'admin', ipAddress: req.ip, severity: 'warning' });
    res.json({ ok: true });
  } catch (err) {
    sendOffsiteError(res, err, 'could not delete target');
  }
});

router.post('/backup/targets/:id/test', requireAdminSession, licensed, async (req, res) => {
  const id = targetId(req, res); if (id === null) return;
  try {
    const detail = await offsite().testTarget(id);
    res.json({ ok: true, detail });
  } catch (err) {
    if (err && err.code === 'TRANSPORT') return res.status(502).json({ ok: false, error: err.message, code: 'TRANSPORT_FAILED', detail: err.message });
    sendOffsiteError(res, err, 'test failed');
  }
});

router.post('/backup/targets/:id/run', requireAdminSession, licensed, async (req, res) => {
  const id = targetId(req, res); if (id === null) return;
  try {
    const r = await offsite().runTarget(id);
    res.json({ ok: true, ...r });
  } catch (err) {
    sendOffsiteError(res, err, 'upload failed');
  }
});

/**
 * POST /api/settings/backup/targets/:id/verify — restore test
 * (docs/feature-next-package.md §S2.1). Fetches the newest archive from the
 * target, decrypts it with the stored passphrase and validates it. Nothing is
 * changed — not on the target, not in this installation.
 * 200 { ok, file, size, created_at, gc_version, include_key, counts, warnings }
 * 409 PASSPHRASE_NOT_SET / NO_REMOTE_BACKUP · 400 DECRYPT_FAILED / CORRUPT
 * 502 TRANSPORT_FAILED · 404 NOT_FOUND · 409 CONFIG_UNREADABLE
 */
router.post('/backup/targets/:id/verify', requireAdminSession, licensed, async (req, res) => {
  const id = targetId(req, res); if (id === null) return;
  try {
    const r = await offsite().verifyTarget(id);
    activity.log('offsite_restore_tested', `Restore test passed for off-site target ${id}: ${r.file}`, {
      source: 'admin', ipAddress: req.ip, severity: 'info',
    });
    res.json({ ok: true, ...r });
  } catch (err) {
    sendOffsiteError(res, err, 'restore test failed');
  }
});

router.get('/backup/targets/:id/files', requireAdminSession, licensed, async (req, res) => {
  const id = targetId(req, res); if (id === null) return;
  try {
    res.json({ ok: true, files: await offsite().listRemoteFiles(id) });
  } catch (err) {
    sendOffsiteError(res, err, 'could not list files');
  }
});

module.exports = router;
