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
const { requireFeature } = require('../../middleware/license');
const { hasFeature } = require('../../services/license');

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

// ─── Machine Binding Settings ──────────────────────────

/**
 * GET /api/settings/machine-binding — Get machine binding settings
 */
router.get('/machine-binding', (req, res) => {
  res.json({
    ok: true,
    data: {
      mode: settings.get('machine_binding.mode', 'off'),
    },
  });
});

/**
 * PUT /api/settings/machine-binding — Update machine binding settings
 */
router.put('/machine-binding', requireFeature('machine_binding'), (req, res) => {
  try {
    const { mode } = req.body;

    if (mode !== undefined) {
      if (!['off', 'global', 'individual'].includes(mode)) {
        return res.status(400).json({ ok: false, error: req.t('error.settings.machine_binding_mode_invalid') });
      }
      settings.set('machine_binding.mode', mode);
    }

    activity.log('machine_binding_settings_updated', `Machine binding mode set to "${mode}"`, {
      source: 'admin',
      ipAddress: req.ip,
      severity: 'info',
    });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: req.t('common.error') });
  }
});

// ─── Monitoring Settings ────────────────────────────────

/**
 * GET /api/settings/monitoring — Get monitoring settings
 */
router.get('/monitoring', (req, res) => {
  const monitor = require('../../services/monitor');
  const cfg = monitor.getSettings();
  res.json({ ok: true, data: cfg });
});

/**
 * PUT /api/settings/monitoring — Update monitoring settings
 */
router.put('/monitoring', (req, res) => {
  try {
    const { interval, email_alerts, alert_email } = req.body;
    if (interval !== undefined) {
      const val = parseInt(interval, 10);
      if (val >= 10 && val <= 3600) settings.set('monitoring.interval', String(val));
    }
    if (email_alerts !== undefined) settings.set('monitoring.email_alerts', String(email_alerts));
    if (alert_email !== undefined) settings.set('monitoring.alert_email', String(alert_email));

    activity.log('monitoring_settings_updated', 'Monitoring settings updated', {
      source: 'admin', ipAddress: req.ip, severity: 'info',
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: req.t('common.error') });
  }
});

// ─── Data & Retention Settings ──────────────────────────

/**
 * GET /api/settings/data — Get data retention settings
 */
router.get('/data', (req, res) => {
  res.json({
    ok: true,
    data: {
      retention_traffic_days: parseInt(settings.get('data.retention_traffic_days', '30'), 10),
      retention_activity_days: parseInt(settings.get('data.retention_activity_days', '30'), 10),
      peer_online_timeout: parseInt(settings.get('data.peer_online_timeout', '180'), 10),
    },
  });
});

/**
 * PUT /api/settings/data — Update data retention settings
 */
router.put('/data', (req, res) => {
  try {
    const { retention_traffic_days, retention_activity_days, peer_online_timeout } = req.body;
    if (retention_traffic_days !== undefined) {
      const val = parseInt(retention_traffic_days, 10);
      if (val >= 1 && val <= 365) settings.set('data.retention_traffic_days', String(val));
    }
    if (retention_activity_days !== undefined) {
      const val = parseInt(retention_activity_days, 10);
      if (val >= 1 && val <= 365) settings.set('data.retention_activity_days', String(val));
    }
    if (peer_online_timeout !== undefined) {
      const val = parseInt(peer_online_timeout, 10);
      if (val >= 30 && val <= 600) settings.set('data.peer_online_timeout', String(val));
    }
    activity.log('data_settings_updated', 'Data retention settings updated', {
      source: 'admin', ipAddress: req.ip, severity: 'info',
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: req.t('common.error') });
  }
});

// ─── ip2location Settings ────────────────────────────────

router.get('/ip2location', (req, res) => {
  const key = settings.get('ip2location.api_key', '');
  res.json({ ok: true, data: { has_api_key: !!key } });
});

router.put('/ip2location', (req, res) => {
  try {
    const { api_key } = req.body;
    if (api_key !== undefined) settings.set('ip2location.api_key', String(api_key));
    activity.log('ip2location_settings_updated', 'ip2location API key updated', {
      source: 'admin', ipAddress: req.ip, severity: 'info',
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: req.t('common.error') });
  }
});

router.post('/ip2location/test', async (req, res) => {
  try {
    const { testLookup } = require('../../services/ipFilter');
    const ip = req.body.ip || req.ip;
    const result = await testLookup(ip.startsWith('::ffff:') ? ip.slice(7) : ip);
    res.json({ ok: true, data: result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Email Alert Settings ───────────────────────────────

/**
 * GET /api/settings/alerts — Get email alert settings
 */
router.get('/alerts', (req, res) => {
  res.json({
    ok: true,
    data: {
      email: settings.get('alerts.email', ''),
      email_events: settings.get('alerts.email_events', ''),
      backup_reminder_days: parseInt(settings.get('alerts.backup_reminder_days', '0'), 10),
      resource_cpu_threshold: parseInt(settings.get('alerts.resource_cpu_threshold', '0'), 10),
      resource_ram_threshold: parseInt(settings.get('alerts.resource_ram_threshold', '0'), 10),
    },
  });
});

/**
 * PUT /api/settings/alerts — Update email alert settings
 */
router.put('/alerts', requireFeature('email_alerts'), (req, res) => {
  try {
    const { email, email_events, backup_reminder_days, resource_cpu_threshold, resource_ram_threshold } = req.body;
    if (email !== undefined) settings.set('alerts.email', String(email));
    if (email_events !== undefined) settings.set('alerts.email_events', String(email_events));
    if (backup_reminder_days !== undefined) settings.set('alerts.backup_reminder_days', String(parseInt(backup_reminder_days, 10) || 0));
    if (resource_cpu_threshold !== undefined) settings.set('alerts.resource_cpu_threshold', String(parseInt(resource_cpu_threshold, 10) || 0));
    if (resource_ram_threshold !== undefined) settings.set('alerts.resource_ram_threshold', String(parseInt(resource_ram_threshold, 10) || 0));

    activity.log('alert_settings_updated', 'Email alert settings updated', {
      source: 'admin', ipAddress: req.ip, severity: 'info',
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

// ─── Auto-Backup Settings ───────────────────────────────

/**
 * GET /api/settings/autobackup — Get auto-backup settings
 */
router.get('/autobackup', (req, res) => {
  try {
    const autobackup = require('../../services/autobackup');
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
    const autobackup = require('../../services/autobackup');
    const { enabled, schedule, retention } = req.body;
    autobackup.updateSettings({ enabled, schedule, retention });

    // Restart scheduler with new settings
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
    const autobackup = require('../../services/autobackup');
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
    const autobackup = require('../../services/autobackup');
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
    const autobackup = require('../../services/autobackup');
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
    const autobackup = require('../../services/autobackup');
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

// ─── Prometheus Metrics Settings ─────────────────────

/**
 * GET /api/settings/metrics — Get metrics settings
 */
router.get('/metrics', (req, res) => {
  res.json({
    ok: true,
    data: {
      enabled: settings.get('metrics_enabled', 'false') === 'true',
    },
  });
});

/**
 * PUT /api/settings/metrics — Update metrics settings
 */
router.put('/metrics', (req, res) => {
  try {
    const { enabled } = req.body;
    if (enabled !== undefined) settings.set('metrics_enabled', String(!!enabled));

    activity.log('metrics_settings_updated', 'Prometheus metrics settings updated', {
      source: 'admin',
      ipAddress: req.ip,
      severity: 'info',
    });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: req.t('common.error') });
  }
});

// GET /settings/dns — read custom DNS setting
router.get('/dns', (req, res) => {
  const config = require('../../../config/default');
  res.json({
    ok: true,
    data: {
      dns: settings.get('custom_dns') || config.wireguard.dns.join(','),
      is_custom: !!settings.get('custom_dns'),
      default_dns: config.wireguard.dns.join(','),
    },
  });
});

// PUT /settings/dns — update custom DNS setting
router.put('/dns', requireFeature('custom_dns'), (req, res) => {
  try {
    const { dns } = req.body;
    if (dns !== undefined) {
      const value = String(dns).trim();
      if (value) {
        const ips = value.split(',').map(s => s.trim()).filter(Boolean);
        const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/;
        for (const ip of ips) {
          if (!ipv4Regex.test(ip)) {
            return res.status(400).json({ ok: false, error: 'Invalid IP address: ' + ip });
          }
        }
        settings.set('custom_dns', ips.join(','));
      } else {
        settings.set('custom_dns', '');
      }
    }
    activity.log('dns_settings_updated', 'DNS settings updated', {
      source: 'admin', ipAddress: req.ip, severity: 'info',
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: req.t('common.error') });
  }
});

// ─── Split-Tunnel Preset Settings ──────────────────────

/**
 * GET /api/settings/split-tunnel — Get global split-tunnel preset
 */
router.get('/split-tunnel', (req, res) => {
  try {
    let preset;
    try {
      preset = JSON.parse(settings.get('split_tunnel_preset', '{}'));
    } catch {
      preset = { mode: 'off', networks: [], locked: false };
    }
    const { mode = 'off', networks = [], locked = false } = preset;
    res.json({ ok: true, mode, networks, locked });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to get split-tunnel preset');
    res.status(500).json({ ok: false, error: req.t('common.error') });
  }
});

/**
 * PUT /api/settings/split-tunnel — Update global split-tunnel preset (license-gated)
 */
router.put('/split-tunnel', (req, res) => {
  try {
    if (!hasFeature('split_tunnel_preset')) {
      return res.status(403).json({ ok: false, error: 'Feature not licensed' });
    }

    const { mode, networks, locked } = req.body;

    if (!['off', 'exclude', 'include'].includes(mode)) {
      return res.status(400).json({ ok: false, error: 'Invalid mode. Must be off, exclude, or include.' });
    }

    if (!Array.isArray(networks) || networks.length > 50) {
      return res.status(400).json({ ok: false, error: 'networks must be an array with max 50 entries.' });
    }

    const cidrRegex = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\/\d{1,2}$/;
    for (const net of networks) {
      if (!cidrRegex.test(net.cidr)) {
        return res.status(400).json({ ok: false, error: `Invalid CIDR: ${net.cidr}` });
      }
      const prefix = parseInt(net.cidr.split('/')[1], 10);
      if (prefix < 0 || prefix > 32) {
        return res.status(400).json({ ok: false, error: `Invalid prefix length in ${net.cidr}` });
      }
      if (net.label && (typeof net.label !== 'string' || net.label.length > 100)) {
        return res.status(400).json({ ok: false, error: 'Label must be a string with max 100 characters.' });
      }
    }

    const preset = { mode, networks, locked: !!locked };
    settings.set('split_tunnel_preset', JSON.stringify(preset));

    activity.log('split_tunnel_preset_updated', 'Split-tunnel preset updated', {
      details: preset,
    });

    res.json({ ok: true });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to update split-tunnel preset');
    res.status(500).json({ ok: false, error: req.t('common.error') });
  }
});

module.exports = router;
