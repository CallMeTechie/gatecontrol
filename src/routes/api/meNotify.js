'use strict';

/**
 * Own notification settings of a signed-in person (notification center) —
 * mounted inside the "me" router (routes/api/me.js), so it exists as
 * /api/v1/me/notify (web session) and /api/v1/portal/me/notify (portal
 * session), always scoped to req.meUserId:
 *
 *   GET  /prefs   { topics:[{id,label,enabled,locked}], quiet_from, quiet_to,
 *                   tz, critical_bypass, devices:[{token_id,name,state,queued}] }
 *   PUT  /prefs   { topics:[{id,enabled}], quiet_from, quiet_to, tz, critical_bypass }
 *   GET  /inbox   ?limit&before=<id> → { items, unread }
 *   POST /read    { ids:[…] } | { all:true } → { ok, updated }
 *   POST /test    { token_id? } → { ok, devices }   (token_id: one own app device)
 *
 * Subscriptions are free (no licence); plugin topics are listed only with the
 * email_alerts licence (they are not delivered without it).
 */

const { Router } = require('express');
const { getDb } = require('../../db/connection');
const { notifySendLimiter } = require('../../middleware/rateLimit');
const hub = require('../../services/notify/hub');
const router_ = require('../../services/notify/router');
const store = require('../../services/notify/store');
const config = require('../../services/notify/config');
const admin = require('../../services/notify/admin');
const { LOCKED_TOPICS } = require('../../services/notify/constants');
const logger = require('../../utils/logger');

function prefsView(userId, lang) {
  const topics = hub.topicsForUser(userId, lang).map((t) => ({
    id: t.id,
    label: t.label,
    enabled: router_.topicOn(userId, t.id),
    locked: LOCKED_TOPICS.has(t.id),
  }));
  const p = router_.userPrefs(userId) || {};
  const devices = admin.devices().filter((d) => d.user && d.user.id === userId)
    .map((d) => ({ token_id: d.token_id, name: d.name, state: d.state, queued: d.queued }));
  return {
    topics,
    quiet_from: p.quiet_from || null,
    quiet_to: p.quiet_to || null,
    tz: p.tz || router_.serverTz(),
    critical_bypass: p.critical_bypass !== 0,
    devices,
  };
}

/** `token_id` of a test request: null (all own devices), an id, or false (invalid). */
function testTokenId(body) {
  const v = body && typeof body === 'object' ? body.token_id : undefined;
  if (v === undefined || v === null) return null;
  const n = typeof v === 'string' && /^\d{1,15}$/.test(v) ? Number(v) : v;
  return Number.isSafeInteger(n) && n > 0 ? n : false;
}

function createRouter() {
  const router = Router();

  router.get('/prefs', (req, res) => {
    try {
      res.json({ ok: true, ...prefsView(req.meUserId, req.language) });
    } catch (err) {
      logger.error({ err: err.message }, 'me/notify prefs failed');
      res.status(500).json({ ok: false, error: req.t('common.error') });
    }
  });

  router.put('/prefs', (req, res) => {
    const uid = req.meUserId;
    const b = req.body || {};
    const fields = {};
    const allowed = new Map(hub.topicsForUser(uid, req.language).map((t) => [t.id, t]));
    const subs = [];
    if (b.topics !== undefined) {
      if (!Array.isArray(b.topics) || b.topics.length > 200) fields.topics = 'invalid';
      else {
        for (const t of b.topics) {
          if (!t || typeof t.id !== 'string' || typeof t.enabled !== 'boolean' || !allowed.has(t.id)) { fields.topics = 'invalid'; break; }
          if (LOCKED_TOPICS.has(t.id)) continue;
          subs.push(t);
        }
      }
    }
    const cur = router_.userPrefs(uid) || { quiet_from: null, quiet_to: null, tz: null, critical_bypass: 1 };
    const next = { ...cur };
    for (const k of ['quiet_from', 'quiet_to']) {
      if (b[k] === undefined) continue;
      if (b[k] === null || b[k] === '') next[k] = null;
      else if (typeof b[k] === 'string' && router_.HHMM_RE.test(b[k])) next[k] = b[k];
      else fields[k] = 'invalid';
    }
    if (b.tz !== undefined) {
      if (b.tz === null || b.tz === '') next.tz = null;
      else if (router_.validTz(b.tz)) next.tz = b.tz;
      else fields.tz = 'invalid';
    }
    if (b.critical_bypass !== undefined) {
      if (typeof b.critical_bypass !== 'boolean') fields.critical_bypass = 'invalid';
      else next.critical_bypass = b.critical_bypass ? 1 : 0;
    }
    if (Object.keys(fields).length) return res.status(400).json({ ok: false, error: req.t('push.error.invalid'), fields });
    try {
      const db = getDb();
      db.transaction(() => {
        const up = db.prepare(`INSERT INTO notify_subscriptions (user_id, topic, enabled) VALUES (?, ?, ?)
          ON CONFLICT(user_id, topic) DO UPDATE SET enabled = excluded.enabled`);
        for (const t of subs) up.run(uid, t.id, t.enabled ? 1 : 0);
        db.prepare(`INSERT INTO notify_user_prefs (user_id, quiet_from, quiet_to, tz, critical_bypass) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(user_id) DO UPDATE SET quiet_from = excluded.quiet_from, quiet_to = excluded.quiet_to,
            tz = excluded.tz, critical_bypass = excluded.critical_bypass`)
          .run(uid, next.quiet_from || null, next.quiet_to || null, next.tz || null, next.critical_bypass === 0 ? 0 : 1);
      })();
      res.json({ ok: true, ...prefsView(uid, req.language) });
    } catch (err) {
      logger.error({ err: err.message }, 'me/notify prefs update failed');
      res.status(500).json({ ok: false, error: req.t('common.error') });
    }
  });

  router.get('/inbox', (req, res) => {
    const uid = req.meUserId;
    const limit = /^\d{1,3}$/.test(String(req.query.limit || '')) ? Math.min(100, Math.max(1, Number(req.query.limit))) : 100;
    const before = /^\d{1,15}$/.test(String(req.query.before || '')) ? Number(req.query.before) : null;
    const nowIso = store.iso();
    const live = 'n.revoked_at IS NULL AND n.release_at IS NULL AND (n.expires_at IS NULL OR n.expires_at > ?)';
    const db = getDb();
    const rows = db.prepare(`SELECT n.*, MAX(CASE WHEN d.state IN ('read', 'dismissed') THEN 1 ELSE 0 END) AS is_read,
         MIN(d.silent) AS d_silent
       FROM notifications n JOIN notification_deliveries d ON d.notification_id = n.id
       WHERE d.user_id = ? AND d.state NOT IN ('expired', 'suppressed') AND ${live} ${before != null ? 'AND n.id < ?' : ''}
       GROUP BY n.id ORDER BY n.id DESC LIMIT ?`).all(...[uid, nowIso, ...(before != null ? [before] : []), limit]);
    const unread = db.prepare(`SELECT COUNT(*) AS n FROM (SELECT n.id FROM notifications n JOIN notification_deliveries d ON d.notification_id = n.id
       WHERE d.user_id = ? AND d.state NOT IN ('expired', 'suppressed') AND ${live}
       GROUP BY n.id HAVING MAX(CASE WHEN d.state IN ('read', 'dismissed') THEN 1 ELSE 0 END) = 0)`).get(uid, nowIso).n;
    res.set('Cache-Control', 'no-store');
    res.json({
      ok: true,
      items: rows.map((n) => ({
        id: n.id,
        event_id: n.event_id,
        topic: n.topic,
        priority: n.priority,
        title: n.title,
        body: n.body || '',
        created_at: store.wire(n.created_at),
        expires_at: store.wire(n.expires_at),
        collapse_key: n.collapse_key || null,
        silent: n.silent === 1 || n.d_silent === 1,
        data: store.parseJson(n.data, null),
        state: n.is_read ? 'read' : 'delivered',
      })),
      unread,
    });
  });

  router.post('/read', (req, res) => {
    const b = req.body || {};
    let ids = null;
    if (b.all !== true) {
      if (!Array.isArray(b.ids) || !b.ids.length || b.ids.length > 500 || !b.ids.every((x) => Number.isSafeInteger(x) && x > 0)) {
        return res.status(400).json({ ok: false, error: req.t('push.error.invalid') });
      }
      ids = [...new Set(b.ids)];
    }
    try {
      res.json({ ok: true, updated: hub.markRead(req.meUserId, ids) });
    } catch (err) {
      logger.error({ err: err.message }, 'me/notify read failed');
      res.status(500).json({ ok: false, error: req.t('common.error') });
    }
  });

  router.post('/test', notifySendLimiter, (req, res) => {
    const tokenId = testTokenId(req.body);
    if (tokenId === false) return res.status(400).json({ ok: false, error: req.t('push.error.invalid'), fields: { token_id: 'invalid' } });
    if (!config.value('enabled')) return res.status(503).json({ ok: false, error: 'push_disabled' });
    // Only an own app device; anything else is "not found" (no probing of other ids).
    if (tokenId != null && !router_.devicesOfUsers([req.meUserId]).some((d) => d.token_id === tokenId)) {
      return res.status(404).json({ ok: false, error: req.t('push.error.device_not_found') });
    }
    try {
      const r = hub.sendTest({ tokenIds: tokenId == null ? null : [tokenId], userId: req.meUserId, source: `manual:${req.meUserId}`, lang: req.language });
      res.json({ ok: true, devices: r.devices });
    } catch (err) {
      logger.error({ err: err.message }, 'me/notify test failed');
      res.status(500).json({ ok: false, error: req.t('common.error') });
    }
  });

  return router;
}

module.exports = { createRouter, testTokenId };
