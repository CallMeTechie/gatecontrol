'use strict';

const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const settings = require('./settings');
const backup = require('./backup');
const activity = require('./activity');

const BACKUP_DIR = '/data/backups';

// Schedule interval mapping (in milliseconds)
const SCHEDULE_MS = {
  '6h': 6 * 60 * 60 * 1000,
  '12h': 12 * 60 * 60 * 1000,
  'daily': 24 * 60 * 60 * 1000,
  '3d': 3 * 24 * 60 * 60 * 1000,
  'weekly': 7 * 24 * 60 * 60 * 1000,
};

const VALID_SCHEDULES = Object.keys(SCHEDULE_MS);
const FILENAME_REGEX = /^gatecontrol-\d{8}-\d{6}\.json$/;

let timer = null;

/**
 * Ensure backup directory exists
 */
function ensureDir() {
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }
}

/**
 * Get auto-backup settings
 */
function getSettings() {
  return {
    enabled: settings.get('autobackup_enabled', 'false') === 'true',
    schedule: settings.get('autobackup_schedule', 'daily'),
    retention: parseInt(settings.get('autobackup_retention', '5'), 10) || 5,
    lastRun: settings.get('autobackup_last_run', null),
  };
}

/**
 * Update auto-backup settings
 */
function updateSettings(data) {
  if (data.enabled !== undefined) {
    settings.set('autobackup_enabled', String(data.enabled));
  }
  if (data.schedule !== undefined && VALID_SCHEDULES.includes(data.schedule)) {
    settings.set('autobackup_schedule', data.schedule);
  }
  if (data.retention !== undefined) {
    const val = parseInt(data.retention, 10);
    if (val >= 1 && val <= 100) {
      settings.set('autobackup_retention', String(val));
    }
  }
}

/**
 * Format date as YYYYMMDD-HHmmss
 */
function formatTimestamp(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const h = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  const s = String(date.getSeconds()).padStart(2, '0');
  return `${y}${m}${d}-${h}${min}${s}`;
}

/**
 * Run a backup now. Returns the filename.
 */
function runBackup() {
  ensureDir();

  const data = backup.createBackup();
  const timestamp = formatTimestamp(new Date());
  const filename = `gatecontrol-${timestamp}.json`;
  const filepath = path.join(BACKUP_DIR, filename);

  fs.writeFileSync(filepath, JSON.stringify(data, null, 2), 'utf-8');

  // Update last run time
  settings.set('autobackup_last_run', new Date().toISOString());

  // Enforce retention
  enforceRetention();

  logger.info({ filename }, 'Automatic backup created');
  activity.log('autobackup_created', `Automatic backup created: ${filename}`, {
    source: 'system',
    severity: 'info',
  });

  return filename;
}

/**
 * Enforce retention limit — delete oldest files exceeding the limit
 */
function enforceRetention() {
  const cfg = getSettings();
  const files = listBackupFiles();

  if (files.length > cfg.retention) {
    // files are sorted newest first, so remove from the end
    const toDelete = files.slice(cfg.retention);
    for (const f of toDelete) {
      try {
        fs.unlinkSync(path.join(BACKUP_DIR, f.filename));
        logger.info({ filename: f.filename }, 'Old backup deleted (retention)');
      } catch (err) {
        logger.warn({ filename: f.filename, error: err.message }, 'Failed to delete old backup');
      }
    }
  }
}

/**
 * List backup files sorted by modification time (newest first)
 */
function listBackupFiles() {
  ensureDir();

  try {
    const entries = fs.readdirSync(BACKUP_DIR);
    const files = entries
      .filter(f => FILENAME_REGEX.test(f))
      .map(f => {
        const stat = fs.statSync(path.join(BACKUP_DIR, f));
        return {
          filename: f,
          size: stat.size,
          created: stat.mtime.toISOString(),
        };
      })
      .sort((a, b) => new Date(b.created) - new Date(a.created));

    return files;
  } catch (err) {
    logger.warn({ error: err.message }, 'Failed to list backup files');
    return [];
  }
}

/**
 * Delete a specific backup file
 */
function deleteBackupFile(filename) {
  if (!FILENAME_REGEX.test(filename)) {
    throw new Error('Invalid filename');
  }

  const filepath = path.join(BACKUP_DIR, filename);
  if (!fs.existsSync(filepath)) {
    throw new Error('File not found');
  }

  fs.unlinkSync(filepath);
  logger.info({ filename }, 'Backup file deleted');
}

/**
 * Get the full path for a backup file (for download)
 */
function getBackupFilePath(filename) {
  if (!FILENAME_REGEX.test(filename)) {
    return null;
  }

  const filepath = path.join(BACKUP_DIR, filename);
  if (!fs.existsSync(filepath)) {
    return null;
  }

  return filepath;
}

/**
 * Start the auto-backup scheduler
 */
function startScheduler() {
  stopScheduler();

  const cfg = getSettings();
  if (!cfg.enabled) {
    logger.info('Auto-backup is disabled');
    return;
  }

  const intervalMs = SCHEDULE_MS[cfg.schedule] || SCHEDULE_MS.daily;

  // Catch-up on start: if the container restarted and the scheduled
  // window already elapsed, run immediately instead of silently missing
  // a backup until the next interval tick. A weekly schedule with a
  // 6-day reboot cycle would otherwise never produce a backup.
  try {
    const lastRunIso = settings.get('autobackup_last_run', null);
    const lastRun = lastRunIso ? Date.parse(lastRunIso) : 0;
    if (!lastRun || Date.now() - lastRun >= intervalMs) {
      setImmediate(() => { try { runBackup(); } catch (err) { logger.warn({ err: err.message }, 'catch-up autobackup failed'); } });
    }
  } catch {}

  timer = setInterval(() => {
    try {
      runBackup();
    } catch (err) {
      logger.error({ error: err.message }, 'Automatic backup failed');
      activity.log('autobackup_failed', `Automatic backup failed: ${err.message}`, {
        source: 'system',
        severity: 'error',
      });

      // Send email alert on failure
      try {
        const alertEmail = settings.get('alerts.email', '');
        if (alertEmail) {
          const { isSmtpConfigured, sendMail } = require('./email');
          if (isSmtpConfigured()) {
            sendMail({
              to: alertEmail,
              subject: '[GateControl] Automatic backup failed',
              text: `Automatic backup failed at ${new Date().toISOString()}\n\nError: ${err.message}\n\n-- GateControl`,
            }).catch(mailErr => {
              logger.warn({ error: mailErr.message }, 'Failed to send backup failure email alert');
            });
          }
        }
      } catch (emailErr) {
        logger.warn({ error: emailErr.message }, 'Failed to send backup failure email alert');
      }
    }
  }, intervalMs);

  logger.info({ schedule: cfg.schedule, intervalMs }, 'Auto-backup scheduler started');
}

/**
 * Stop the auto-backup scheduler
 */
function stopScheduler() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/**
 * Restart scheduler (call after settings change)
 */
function restartScheduler() {
  stopScheduler();
  startScheduler();
}

module.exports = {
  getSettings,
  updateSettings,
  runBackup,
  listBackupFiles,
  deleteBackupFile,
  getBackupFilePath,
  startScheduler,
  stopScheduler,
  restartScheduler,
  BACKUP_DIR,
  VALID_SCHEDULES,
};
