'use strict';

// Observability cluster: monitoring schedule, Prometheus metrics flag,
// email alerts, ip2location geo-lookup, data retention.
// Carved out of the legacy 863-LOC settings.js — semantics unchanged.

const { Router } = require('express');
const settings = require('../../../services/settings');
const activity = require('../../../services/activity');
const logger = require('../../../utils/logger');
const { requireFeature } = require('../../../middleware/license');

const router = Router();

/**
 * GET /api/settings/monitoring — Get monitoring settings
 */
router.get('/monitoring', (req, res) => {
  const monitor = require('../../../services/monitor');
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

/**
 * GET /api/settings/ip2location — Get ip2location key status (presence only)
 */
router.get('/ip2location', (req, res) => {
  const key = settings.get('ip2location.api_key', '');
  res.json({ ok: true, data: { has_api_key: !!key } });
});

/**
 * PUT /api/settings/ip2location — Store ip2location API key
 */
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

/**
 * POST /api/settings/ip2location/test — Test geo lookup
 */
router.post('/ip2location/test', async (req, res) => {
  try {
    const { testLookup } = require('../../../services/ipFilter');
    const ip = req.body.ip || req.ip;
    const result = await testLookup(ip.startsWith('::ffff:') ? ip.slice(7) : ip);
    res.json({ ok: true, data: result });
  } catch (err) {
    logger.error({ err: err.message }, 'ip2location test failed');
    res.status(500).json({ ok: false, error: req.t('common.error') });
  }
});

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

module.exports = router;
