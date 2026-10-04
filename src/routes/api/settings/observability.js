'use strict';

// Observability cluster: monitoring schedule, Prometheus metrics flag,
// email alerts, ip2location geo-lookup, data retention.
// Carved out of the legacy 863-LOC settings.js — semantics unchanged.

const { Router } = require('express');
const settings = require('../../../services/settings');
const activity = require('../../../services/activity');
const logger = require('../../../utils/logger');
const { hasFeature } = require('../../../services/license');
const notifications = require('../../../services/notifications');
const { validateEmail } = require('../../../utils/validate');
const { checkRanges, hasErrors, sendFieldErrors } = require('../../../utils/settingsValidate');

const router = Router();

const MONITORING_RANGES = { interval: [10, 3600] };
const DATA_RANGES = {
  retention_traffic_days: [1, 365],
  retention_activity_days: [1, 365],
  retention_waf_days: [1, 365],
  peer_online_timeout: [30, 600],
};
const ALERT_RANGES = {
  backup_reminder_days: [0, 365],
  resource_cpu_threshold: [0, 100],
  resource_ram_threshold: [0, 100],
  resource_disk_threshold: [0, 100],
};
const ALERT_KEYS = {
  backup_reminder_days: 'alerts.backup_reminder_days',
  resource_cpu_threshold: 'alerts.resource_cpu_threshold',
  resource_ram_threshold: 'alerts.resource_ram_threshold',
  resource_disk_threshold: 'alerts.resource_disk_threshold',
};

/** '' or one/several addresses, comma separated → message or null. */
function recipientError(req, value) {
  if (typeof value !== 'string') return req.t('error.settings.recipient_invalid');
  const list = notifications.recipientList(value);
  if (list.length > 10 || list.some((a) => validateEmail(a))) return req.t('error.settings.recipient_invalid');
  return null;
}

function licenseError(req, res, feature) {
  return res.status(403).json({
    ok: false,
    error: req.t('error.license.feature_not_available'),
    feature,
    upgrade_url: 'https://callmetechie.de/products/gatecontrol/pricing',
  });
}

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
 * { interval: 10–3600, email_alerts: bool (the route_state row of the
 * notification events), alert_email: the notification recipient }
 */
router.put('/monitoring', (req, res) => {
  try {
    const body = req.body || {};
    const { values, fields } = checkRanges(req, body, MONITORING_RANGES);
    if (body.alert_email !== undefined) {
      const err = recipientError(req, body.alert_email);
      if (err) fields.alert_email = err;
    }
    if (hasErrors(fields)) return sendFieldErrors(req, res, fields);

    if (values.interval !== undefined) settings.set('monitoring.interval', String(values.interval));
    if (body.email_alerts !== undefined) notifications.setEventEmail('route_state', body.email_alerts === true || body.email_alerts === 'true');
    if (body.alert_email !== undefined) notifications.setRecipient(body.alert_email);

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
      // WAF events (docs/feature-waf.md), cleaned with the other retention runs.
      retention_waf_days: parseInt(settings.get('data.retention_waf_days', '14'), 10),
      peer_online_timeout: parseInt(settings.get('data.peer_online_timeout', '180'), 10),
    },
  });
});

/**
 * PUT /api/settings/data — Update data retention settings (400 with
 * per-field messages when a value is out of range)
 */
router.put('/data', (req, res) => {
  try {
    const { values, fields } = checkRanges(req, req.body || {}, DATA_RANGES);
    if (hasErrors(fields)) return sendFieldErrors(req, res, fields);
    for (const [k, v] of Object.entries(values)) settings.set('data.' + k, String(v));
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
    const { api_key, clear } = req.body;
    const oldKey = settings.get('ip2location.api_key', '');

    // Determine effective new value (mirrors the write logic below).
    let newKey;
    if (clear === true) {
      newKey = '';
    } else if (api_key !== undefined && String(api_key) !== '') {
      newKey = String(api_key);
    } else {
      // empty api_key without clear → no change → skip write and audit
      return res.json({ ok: true });
    }

    // Only write and log when the value actually changed.
    if (newKey !== oldKey) {
      settings.set('ip2location.api_key', newKey);
      activity.log('ip2location_settings_updated', 'ip2location API key updated', {
        source: 'admin', ipAddress: req.ip, severity: 'info',
      });
    }

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
 * GET /api/settings/alerts — notification settings: the one recipient, the
 * mailed event types (CSV, as stored) and the catalogue rows they tick
 * (`events`), the periodic checks and whether SMTP is set up.
 */
router.get('/alerts', (req, res) => {
  const email = require('../../../services/email');
  const smtp = email.getSmtpSettings();
  const types = notifications.emailTypes();
  res.json({
    ok: true,
    data: {
      email: notifications.recipient(),
      email_events: types.join(','),
      events: notifications.eventsFromTypes(types),
      backup_reminder_days: parseInt(settings.get('alerts.backup_reminder_days', '0'), 10) || 0,
      resource_cpu_threshold: parseInt(settings.get('alerts.resource_cpu_threshold', '0'), 10) || 0,
      resource_ram_threshold: parseInt(settings.get('alerts.resource_ram_threshold', '0'), 10) || 0,
      resource_disk_threshold: parseInt(settings.get('alerts.resource_disk_threshold', '0'), 10) || 0,
      smtp: { configured: email.isSmtpConfigured(), host: smtp.host || '' },
    },
  });
});

/**
 * PUT /api/settings/alerts — Update notification settings.
 *   email                 recipient ('' = none; several comma separated)
 *   events                catalogue row ids that are mailed (settings page) …
 *   email_events          … or the event types themselves (CSV or array;
 *                         older clients). Unknown names → 400.
 *   backup_reminder_days  0–365, resource_{cpu,ram,disk}_threshold 0–100
 * Licence email_alerts: needed for the periodic checks and for every event
 * row except the two that had their own unlicensed switch before (route
 * state, update mails). The recipient is free (update mails use it too).
 */
router.put('/alerts', (req, res) => {
  try {
    const body = req.body || {};
    const { values, fields } = checkRanges(req, body, ALERT_RANGES);
    if (body.email !== undefined) {
      const err = recipientError(req, body.email);
      if (err) fields.email = err;
    }
    let types = null;
    if (body.events !== undefined) {
      const ids = notifications.parseList(body.events);
      const known = new Set(notifications.EVENTS.map((e) => e.id));
      const bad = ids.filter((id) => !known.has(id));
      if (bad.length) fields.events = req.t('error.settings.events_invalid', { names: bad.join(', ') });
      else types = notifications.typesFromEvents(ids);
    } else if (body.email_events !== undefined) {
      const bad = notifications.unknownTypes(body.email_events);
      if (bad.length) fields.email_events = req.t('error.settings.events_invalid', { names: bad.join(', ') });
      else types = notifications.parseList(body.email_events);
    }
    if (hasErrors(fields)) return sendFieldErrors(req, res, fields);

    if (!hasFeature('email_alerts')) {
      const checksChanged = Object.entries(values).some(([k, v]) => String(v) !== String(parseInt(settings.get(ALERT_KEYS[k], '0'), 10) || 0));
      if (checksChanged || (types && notifications.licensedChanges(notifications.emailTypes(), types).length)) {
        return licenseError(req, res, 'email_alerts');
      }
    }

    if (body.email !== undefined) notifications.setRecipient(body.email);
    if (types) notifications.setEmailTypes(types);
    for (const [k, v] of Object.entries(values)) settings.set(ALERT_KEYS[k], String(v));

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
