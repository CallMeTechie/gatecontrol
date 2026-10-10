'use strict';

/**
 * Admin API of the notification center (docs/feature-notification-center.md),
 * mounted at /api/v1/notify — administrator session only (API tokens are
 * refused), CSRF like every admin API (routes/api/index.js).
 *
 *   GET  /overview                kpis, recent (8), hub, sources (7 days)
 *   GET  /rules                   rules, users, groups, webhooks_count, pro
 *   PUT  /rules/:eventId          partial update → { ok, rule }
 *   GET  /devices                 devices with live presence
 *   POST /send                    manual message (licence email_alerts)
 *   POST /test                    test to the own devices → { ok, devices }
 *   GET  /history                 ?filter&days&before&limit → { items, next_before }
 *   GET  /history/:id             notification, timeline, deliveries, email
 *   POST /history/:id/resend      → { ok }
 *   GET  /settings, PUT /settings
 *
 * Licence: users/groups recipients in rules, /send and plugin topics need the
 * existing feature `email_alerts` (403 with the usual licence shape).
 * Live updates: eventBus `notify` ({ id }) and `push_presence`
 * ({ token_id, state, via }) reach the admin SSE stream (/api/v1/events).
 */

const { Router } = require('express');
const { requireAdminSession } = require('../../middleware/auth');
const { hasFeature } = require('../../services/license');
const { notifySendLimiter } = require('../../middleware/rateLimit');
const { checkRanges, hasErrors, sendFieldErrors } = require('../../utils/settingsValidate');
const { getDb } = require('../../db/connection');
const activity = require('../../services/activity');
const logger = require('../../utils/logger');
const notifications = require('../../services/notifications');
const rules = require('../../services/notify/rules');
const config = require('../../services/notify/config');
const hub = require('../../services/notify/hub');
const admin = require('../../services/notify/admin');
const stream = require('../../services/notify/stream');
const sanitize = require('../../services/notify/sanitize');
const text = require('../../services/notify/text');
const { PRIORITIES } = require('../../services/notify/constants');

const router = Router();
router.use(requireAdminSession);

const FEATURE = 'email_alerts';

function licenseError(req, res) {
  return res.status(403).json({
    ok: false,
    error: req.t('error.license.feature_not_available'),
    feature: FEATURE,
    upgrade_url: 'https://callmetechie.de/products/gatecontrol/pricing',
  });
}

function intParam(v, min, max, def) {
  if (!/^\d{1,9}$/.test(String(v == null ? '' : v))) return def;
  const n = Number(v);
  return n < min ? min : (n > max ? max : n);
}

function ruleView(rule, lang) {
  const pt = rule.plugin_topic || (rules.isPluginEventId(rule.event_id) ? rules.pluginTopic(rule.event_id) : null);
  const core = rules.coreEvent(rule.event_id);
  return {
    event_id: rule.event_id,
    group: core ? core.group : 'plugins',
    label: core ? text.t(lang, `st.event.${core.id}`) : (pt ? text.loc(pt.label, lang) : rule.event_id),
    priority: rule.priority,
    recipients: rule.recipients,
    ch_app: rule.ch_app,
    ch_email: rule.ch_email,
    ch_webhook: rule.ch_webhook,
    email_fallback_s: rule.email_fallback_s,
    delay_s: rule.delay_s,
    bundle_s: rule.bundle_s,
    recovery: rule.recovery,
    enabled: rule.enabled,
    plugin_id: core ? null : (pt ? pt.plugin_id : String(rule.event_id).split(':')[1] || null),
  };
}

// ─── Overview ───────────────────────────────────────────────────────────

router.get('/overview', (req, res) => {
  try {
    res.json({ ok: true, ...admin.overview(req.t) });
  } catch (err) {
    logger.error({ err: err.message }, 'notify overview failed');
    res.status(500).json({ ok: false, error: req.t('common.error') });
  }
});

// ─── Rules ──────────────────────────────────────────────────────────────

router.get('/rules', (req, res) => {
  try {
    const db = getDb();
    const lang = req.language;
    res.json({
      ok: true,
      rules: rules.list().map((r) => ruleView(r, lang)),
      users: db.prepare('SELECT id, username, display_name FROM users WHERE enabled = 1 ORDER BY COALESCE(display_name, username) COLLATE NOCASE')
        .all().map((u) => ({ id: u.id, name: u.display_name || u.username })),
      groups: db.prepare('SELECT id, name FROM peer_groups ORDER BY name COLLATE NOCASE').all().map((g) => ({ id: g.id, name: g.name })),
      webhooks_count: db.prepare('SELECT COUNT(*) AS n FROM webhooks WHERE enabled = 1').get().n,
      pro: hasFeature(FEATURE),
    });
  } catch (err) {
    logger.error({ err: err.message }, 'notify rules failed');
    res.status(500).json({ ok: false, error: req.t('common.error') });
  }
});

router.put('/rules/:eventId', (req, res) => {
  const eventId = String(req.params.eventId || '');
  if (!rules.exists(eventId)) return res.status(404).json({ ok: false, error: req.t('push.error.rule_not_found') });
  const { values, errors } = rules.validatePatch(eventId, req.body);
  if (hasErrors(errors)) {
    return res.status(400).json({ ok: false, error: req.t('push.error.invalid'), fields: errors });
  }
  const licensed = hasFeature(FEATURE);
  const plugin = rules.isPluginEventId(eventId);
  if (!licensed) {
    if (plugin) return licenseError(req, res);
    const r = values.recipients;
    if (r && (r.users.length || r.groups.length)) return licenseError(req, res);
    const core = rules.coreEvent(eventId);
    if (values.ch_email !== undefined && core && !core.free && values.ch_email !== notifications.eventEmailOn(core.id)) {
      return licenseError(req, res);
    }
  }
  try {
    if (plugin) rules.ensurePluginRule(eventId);
    const rule = rules.update(eventId, values);
    activity.log('notify_rule_updated', `Notification rule "${eventId}" updated`, {
      source: 'admin', ipAddress: req.ip, severity: 'info', details: { eventId, fields: Object.keys(values), userId: req.session.userId },
    });
    const full = rules.list().find((x) => x.event_id === eventId) || rule;
    res.json({ ok: true, rule: ruleView(full, req.language) });
  } catch (err) {
    logger.error({ err: err.message, eventId }, 'notify rule update failed');
    res.status(500).json({ ok: false, error: req.t('common.error') });
  }
});

// ─── Devices ────────────────────────────────────────────────────────────

router.get('/devices', (req, res) => {
  try {
    res.json({ ok: true, devices: admin.devices() });
  } catch (err) {
    logger.error({ err: err.message }, 'notify devices failed');
    res.status(500).json({ ok: false, error: req.t('common.error') });
  }
});

// ─── Manual message and test ────────────────────────────────────────────

const TARGET_TYPES = ['all', 'users', 'groups', 'devices'];

router.post('/send', notifySendLimiter, (req, res) => {
  if (!hasFeature(FEATURE)) return licenseError(req, res);
  const b = req.body || {};
  const fields = {};
  const target = b.target && typeof b.target === 'object' ? b.target : null;
  let ids = [];
  if (!target || !TARGET_TYPES.includes(target.type)) fields.target = 'invalid';
  else if (target.type !== 'all') {
    ids = Array.isArray(target.ids) ? [...new Set(target.ids.map((x) => (typeof x === 'number' ? x : (/^\d+$/.test(String(x)) ? Number(x) : NaN))))] : [];
    if (!ids.length || ids.length > 500 || !ids.every((n) => Number.isSafeInteger(n) && n > 0)) fields.target = 'invalid';
  }
  const title = sanitize.title(b.title);
  if (!title) fields.title = 'required';
  const body = sanitize.body(b.body);
  const priority = b.priority === undefined ? 'normal' : b.priority;
  if (!PRIORITIES.includes(priority)) fields.priority = 'invalid';
  const maxTtl = config.value('retention_h') * 3600;
  let ttlS = null;
  if (b.ttl_s !== undefined && b.ttl_s !== null) {
    const n = Number(b.ttl_s);
    if (!Number.isSafeInteger(n) || n < 60 || n > maxTtl) fields.ttl_s = 'invalid'; else ttlS = n;
  }
  if (hasErrors(fields)) return res.status(400).json({ ok: false, error: req.t('push.error.invalid'), fields });
  if (!config.value('enabled')) return res.status(503).json({ ok: false, error: 'push_disabled' });
  try {
    const r = hub.sendManual({ userId: req.session.userId, target: { type: target.type, ids }, title, body, priority, ttlS });
    activity.log('notify_manual_sent', `Notification "${title}" sent to ${target.type}`, {
      source: 'admin', ipAddress: req.ip, severity: 'info',
      details: { notificationId: r.id, target: target.type, ids, priority, userId: req.session.userId, devices: r.devices_now + r.devices_later },
    });
    res.json({ ok: true, notification_id: r.id, devices_now: r.devices_now, devices_later: r.devices_later });
  } catch (err) {
    logger.error({ err: err.message }, 'notify send failed');
    res.status(500).json({ ok: false, error: req.t('common.error') });
  }
});

router.post('/test', notifySendLimiter, (req, res) => {
  if (!config.value('enabled')) return res.status(503).json({ ok: false, error: 'push_disabled' });
  try {
    const r = hub.sendTest({ userId: req.session.userId, source: `manual:${req.session.userId}`, lang: req.language });
    res.json({ ok: true, devices: r.devices });
  } catch (err) {
    logger.error({ err: err.message }, 'notify test failed');
    res.status(500).json({ ok: false, error: req.t('common.error') });
  }
});

// ─── History ────────────────────────────────────────────────────────────

router.get('/history', (req, res) => {
  const filter = Object.prototype.hasOwnProperty.call(admin.FILTERS, req.query.filter) ? req.query.filter : 'all';
  const days = intParam(req.query.days, 1, 365, 7);
  const limit = intParam(req.query.limit, 1, 200, 50);
  const before = /^\d{1,15}$/.test(String(req.query.before || '')) ? Number(req.query.before) : null;
  try {
    res.json({ ok: true, ...admin.history({ filter, days, before, limit }, req.t) });
  } catch (err) {
    logger.error({ err: err.message }, 'notify history failed');
    res.status(500).json({ ok: false, error: req.t('common.error') });
  }
});

function idParam(req) {
  return /^\d{1,15}$/.test(String(req.params.id || '')) ? Number(req.params.id) : null;
}

router.get('/history/:id', (req, res) => {
  const id = idParam(req);
  const d = id == null ? null : admin.detail(id, req.t);
  if (!d) return res.status(404).json({ ok: false, error: req.t('push.error.not_found') });
  res.json({ ok: true, ...d });
});

router.post('/history/:id/resend', notifySendLimiter, (req, res) => {
  const id = idParam(req);
  if (!config.value('enabled')) return res.status(503).json({ ok: false, error: 'push_disabled' });
  const r = id == null ? null : hub.resend(id);
  if (!r) return res.status(404).json({ ok: false, error: req.t('push.error.not_found') });
  if (r.error === 'revoked') return res.status(409).json({ ok: false, error: req.t('push.error.revoked') });
  activity.log('notify_resent', `Notification #${id} sent again`, {
    source: 'admin', ipAddress: req.ip, severity: 'info', details: { notificationId: id, devices: r.devices, userId: req.session.userId },
  });
  res.json({ ok: true });
});

// ─── Settings ───────────────────────────────────────────────────────────

router.get('/settings', (req, res) => {
  res.json({ ok: true, ...config.get() });
});

router.put('/settings', (req, res) => {
  const body = req.body || {};
  const { values, fields } = checkRanges(req, body, config.RANGES);
  for (const k of config.BOOLEANS) {
    if (body[k] === undefined) continue;
    if (typeof body[k] !== 'boolean') fields[k] = req.t('push.error.boolean');
    else values[k] = body[k];
  }
  if (hasErrors(fields)) return sendFieldErrors(req, res, fields);
  const before = config.get();
  const after = config.set(values);
  // Streams follow at once: push off ends all, "no direct" ends direct ones.
  if (before.enabled && !after.enabled) stream.closeAll(() => true, 'push_disabled');
  if (!after.allow_direct) stream.closeAll((c) => c.via === 'direct', 'direct_not_allowed');
  activity.log('notify_settings_updated', 'Notification center settings updated', {
    source: 'admin', ipAddress: req.ip, severity: 'info', details: { fields: Object.keys(values), userId: req.session.userId },
  });
  res.json({ ok: true, ...after });
});

module.exports = router;
