'use strict';

const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const settings = require('./settings');
const backup = require('./backup');
const activity = require('./activity');
const { withTask } = require('../utils/loopStall');
const { ensurePrivateDir, PRIVATE_FILE_MODE } = require('../utils/fileModes');

// Backups carry the full DB content (users with password hashes, API-token
// hashes, peers with encrypted keys, settings) — owner-only: dir 0700,
// files 0600. Node reads them itself for download; nothing else needs them.
// Backups from older versions are tightened at boot (server.js →
// utils/fileModes.restrictSensitiveDataFiles).
// GC_BACKUP_DIR exists for tests only.
const BACKUP_DIR = process.env.GC_BACKUP_DIR || '/data/backups';

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
let startTimer = null;
// the scheduler looks every CHECK_EVERY_MS whether a backup is due, the first time START_DELAY_MS after the start
const CHECK_EVERY_MS = 10 * 60 * 1000;
const START_DELAY_MS = 10 * 60 * 1000;
const RETRY_AFTER_FAIL_MS = 60 * 60 * 1000;

/**
 * Ensure backup directory exists (owner-only, 0700)
 */
function ensureDir() {
  ensurePrivateDir(BACKUP_DIR);
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
 *
 * Afterwards the file is uploaded to every enabled off-site target
 * (services/offsite, docs/feature-release-b.md §7) — asynchronously, the
 * caller never waits for or fails with an upload. { offsite: false } skips
 * that (POST /targets/:id/run uploads to one target itself).
 */
function runBackup(opts) {
  return withTask('backup.auto', () => runBackupNow(opts));
}

async function runBackupNow({ offsite = true } = {}) {
  ensureDir();

  const timestamp = formatTimestamp(new Date());
  const filename = `gatecontrol-${timestamp}.json`;
  const filepath = path.join(BACKUP_DIR, filename);

  // Fresh tmp file + rename: the 0600 mode always applies (a plain
  // writeFileSync would keep the mode of an existing file) and a crash
  // mid-write never leaves a truncated backup under a valid name.
  // Collected and written piece by piece (services/backup.writeBackupFile):
  // a backup with plugin data has up to a few hundred MB — building it with
  // JSON.stringify in one go blocked the event loop for 25+ s on a NAS.
  // The free space of the backup disk is checked first (code NO_SPACE).
  const { incomplete } = await backup.writeBackupFile(filepath, { mode: PRIVATE_FILE_MODE });

  // Update last run time
  settings.set('autobackup_last_run', new Date().toISOString());

  // Enforce retention
  enforceRetention();

  logger.info({ filename }, 'Automatic backup created');
  activity.log('autobackup_created', `Automatic backup created: ${filename}`, {
    source: 'system',
    severity: 'info',
  });
  if (incomplete && incomplete.length) noteIncomplete(filename, incomplete);

  if (offsite) {
    setImmediate(() => {
      // marked: a stall during the upload names it (loopStall)
      withTask('backup.offsite', () => require('./offsite').uploadAfterBackup(filepath))
        .catch((err) => logger.warn({ err: err.message }, 'Off-site upload hook failed'));
    });
  }

  return filename;
}

const PART_TEXT = { code: 'program files', database: 'database', files: 'files', media: 'media', media_areas: 'media areas' };
const REASON_TEXT = { too_large: 'too large for the backup', read_error: 'could not be read', unknown: 'left out' };

/** "Mail (database: too large for the backup)" — the plugins_incomplete list in one line. */
function incompleteLine(list) {
  return (list || []).map((p) => `${p.name || p.id} (${(p.parts || []).map((x) => `${PART_TEXT[x.part] || x.part}: ${REASON_TEXT[x.reason] || REASON_TEXT.unknown}`).join(', ')})`).join('; ');
}

/**
 * A backup in which a plugin part is missing: a warning in the log with the
 * plugin names and an activity entry `autobackup_incomplete` — the
 * notifications of the "Backup-Probleme" row (mail, push, webhooks) come
 * from it like for a failed backup (services/notifications.js).
 */
function noteIncomplete(filename, list) {
  const line = incompleteLine(list);
  logger.warn({ filename, plugins: list.map((p) => p.id) }, `Backup incomplete — not everything of these plugins is in it: ${line}`);
  activity.log('autobackup_incomplete', `Backup ${filename} is incomplete: ${line}`, {
    source: 'system',
    severity: 'warning',
    details: { filename, plugins: list.map((p) => ({ id: p.id, name: p.name, parts: p.parts })) },
  });
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

// plugins_incomplete per file (read from the start of the file), by name + mtime
const incompleteCache = new Map();

/**
 * listBackupFiles() with `incomplete` per file: the plugins of which a part
 * is missing ([] complete, null unknown — a backup from before this was
 * recorded).
 */
async function listBackupFilesWithInfo() {
  const files = listBackupFiles();
  const seen = new Set();
  for (const f of files) {
    const key = `${f.filename}|${f.created}|${f.size}`;
    seen.add(key);
    if (!incompleteCache.has(key)) incompleteCache.set(key, await backup.readIncomplete(path.join(BACKUP_DIR, f.filename)));
    f.incomplete = incompleteCache.get(key);
  }
  for (const k of incompleteCache.keys()) if (!seen.has(k)) incompleteCache.delete(k);
  return files;
}

/** The newest local backup with its `incomplete` (listBackupFilesWithInfo), or null. */
async function latestBackupInfo() {
  const files = await listBackupFilesWithInfo();
  return files[0] || null;
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

  // Due by the time of the last backup (autobackup_last_run), looked at every
  // CHECK_EVERY_MS — not by a timer of the schedule's length: a server that
  // restarts more often than that (automatic updates) never reached it and
  // made the backup as a catch-up right at the start, while every other
  // start job ran (a backup of the plugin data holds the thread for seconds).
  // The first look comes START_DELAY_MS after the start.
  const due = () => {
    try {
      const lastRunIso = settings.get('autobackup_last_run', null);
      const lastRun = lastRunIso ? Date.parse(lastRunIso) : 0;
      return !lastRun || Date.now() - lastRun >= intervalMs;
    } catch (err) {
      logger.warn({ err: err.message }, 'autobackup due check failed');
      return false;
    }
  };
  let running = false;
  let failedAt = 0;
  const check = () => {
    if (running || Date.now() - failedAt < RETRY_AFTER_FAIL_MS || !due()) return;
    running = true;
    runBackup().catch((err) => {
      logger.error({ error: err.message }, 'Automatic backup failed');
      // The mail (if the backup_problem row of the notification events is
      // on) and the webhooks come from activity.log — services/notifications.js.
      activity.log('autobackup_failed', `Automatic backup failed: ${err.message}`, {
        source: 'system',
        severity: 'error',
      });
      // tried again after RETRY_AFTER_FAIL_MS, not at every look
      failedAt = Date.now();
    }).finally(() => { running = false; });
  };
  startTimer = setTimeout(() => {
    startTimer = null;
    check();
    timer = setInterval(check, module.exports._checkEveryMs || CHECK_EVERY_MS);
    if (timer.unref) timer.unref();
  }, module.exports._startDelayMs != null ? module.exports._startDelayMs : START_DELAY_MS);
  if (startTimer.unref) startTimer.unref();

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
  if (startTimer) {
    clearTimeout(startTimer);
    startTimer = null;
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
  listBackupFilesWithInfo,
  latestBackupInfo,
  incompleteLine,
  deleteBackupFile,
  getBackupFilePath,
  startScheduler,
  stopScheduler,
  restartScheduler,
  BACKUP_DIR,
  VALID_SCHEDULES,
  CHECK_EVERY_MS,
  START_DELAY_MS,
  // tests: shorter delays
  _startDelayMs: null,
  _checkEveryMs: null,
};
