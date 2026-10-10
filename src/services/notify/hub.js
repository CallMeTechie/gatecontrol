'use strict';

// The hub of the notification center: every message (core event, plugin,
// administrator, test) goes through publish() — rule, recipients, filters,
// queue, immediate delivery to connected devices — see
// docs/feature-notification-center.md "Architektur".
//
//   emitActivity(type, message, opts)  called by activity.log() for every
//                                      catalogue type (and by updateNotify)
//   claimMail(key, mail)               the e-mail senders ask whether the
//                                      mail of the event just emitted waits
//                                      for the fallback (true) or goes now
//   emitPlugin(pluginId, n)            gc.notify() (hostApi)
//   sendManual / sendTest              admin API, devices, portal
//   onAck / markRead                   read-sync between one person's devices
//   tick()                             releases held (delay_s) messages and
//                                      sends due fallback mails
//
// Delay: a held message is stored with release_at and no deliveries; a
// recovery event with the same collapse key inside the delay deletes it and
// nothing is sent at all. Bundling: a new event with the same collapse key
// inside bundle_s updates the existing notification (count, title, body)
// and re-queues it under new seqs — the apps replace the shown one.
// Recovery (gateway/route/resource back): every open alarm of the collapse
// key is revoked (`event: revoke`), then — rule.recovery — a silent
// ('silent') or normal ('normal') "back online" notice follows, or nothing
// ('off'). A recovery without an open alarm sends nothing.

const store = require('./store');
const rules = require('./rules');
const router = require('./router');
const stream = require('./stream');
const config = require('./config');
const text = require('./text');
const sanitize = require('./sanitize');
const { PRIORITY_RANK, CORE_TOPICS, ADMIN_ONLY_TOPICS } = require('./constants');
const eventBus = require('../eventBus');
const logger = require('../../utils/logger');

const MAIL_CLAIM_WINDOW_MS = 5000;
const lastEmit = new Map(); // emit key (event type / plugin topic) → { id, at, devices, held, rule }

function licensed() {
  try { return require('../license').hasFeature('email_alerts'); } catch { return false; }
}

function expiresIso(ttlS) {
  const max = config.value('retention_h') * 3600;
  const s = Number.isSafeInteger(ttlS) && ttlS > 0 ? Math.min(ttlS, max) : max;
  return store.iso(store.now() + s * 1000);
}

function publishBus(id) {
  try { eventBus.publish('notify', { id }); } catch { /* best-effort */ }
}

function remember(key, entry) {
  if (!key) return;
  lastEmit.set(key, { ...entry, at: store.now() });
}

// ─── Core events ────────────────────────────────────────────────────────

const NAMED_TYPES = new Set([
  'account_locked', 'waf_ip_banned', 'peer_connected', 'peer_disconnected', 'peer_created', 'peer_deleted',
  'peer_expired', 'gateway_down', 'gateway_alive', 'gateway_offline', 'gateway_recovered', 'route_down',
  'route_up', 'route_created', 'route_deleted', 'resource_alert', 'resource_recovered',
]);
const ROUTE_FOR_EVENT = {
  gateway_state: 'gateways', peer_connection: 'vpn', peer_lifecycle: 'vpn', peer_expired: 'vpn',
  route_state: 'services', route_lifecycle: 'services',
};
const ALARM_EVENTS = new Set(['gateway_state', 'route_state', 'resources']);

function num(v) {
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** peer id, display name and collapse key of a core event. */
function coreContext(type, details) {
  const d = details && typeof details === 'object' ? details : {};
  const peerId = num(d.peerId != null ? d.peerId : d.peer_id);
  let name = d.peer_name || d.domain || d.identifier || d.ip || null;
  if (!name && peerId) {
    try {
      const row = require('../../db/connection').getDb().prepare('SELECT name FROM peers WHERE id = ?').get(peerId);
      name = row ? row.name : null;
    } catch { name = null; }
  }
  if (!name && d.resource) name = String(d.resource).toUpperCase();
  let collapseKey = null;
  if (type.startsWith('gateway_') && peerId) collapseKey = `gateway:${peerId}`;
  else if ((type === 'route_down' || type === 'route_up') && num(d.routeId)) collapseKey = `route:${num(d.routeId)}`;
  else if (type.startsWith('resource_') && d.resource) collapseKey = `resource:${sanitize.line(d.resource, 20)}`;
  else if (['login_failed', 'login_2fa_failed', 'passkey_login_failed'].includes(type)) collapseKey = 'login_failed';
  else if (type === 'waf_ip_banned') collapseKey = 'waf_ban';
  else if ((type === 'peer_connected' || type === 'peer_disconnected') && peerId) collapseKey = `peer:${peerId}`;
  else if (type === 'backup_reminder' || type === 'autobackup_failed') collapseKey = 'backup';
  return { peerId, name: name ? sanitize.line(name, 80) : null, collapseKey };
}

function coreTitle(lang, type, name) {
  if (name && NAMED_TYPES.has(type) && text.has(lang, `push.named.${type}`)) {
    return sanitize.title(text.t(lang, `push.named.${type}`, { name }));
  }
  if (text.has(lang, `push.type.${type}`)) return sanitize.title(text.t(lang, `push.type.${type}`));
  return null;
}

function coreData(lang, eventId, alarm) {
  const route = ROUTE_FOR_EVENT[eventId] || 'inbox';
  const data = { route };
  if (alarm) {
    data.actions = [
      { id: 'details', label: text.t(lang, 'push.action.details'), type: 'open_app_route', target: route },
      { id: 'mute_1h', label: text.t(lang, 'push.action.mute_1h'), type: 'mute_1h' },
    ];
  }
  return sanitize.data(data).data;
}

/**
 * Hook of activity.log(): a catalogue event becomes a notification when its
 * rule is enabled with the app channel. Returns { id, devices, held } or null.
 * Never throws (the caller logs and goes on).
 */
function emitActivity(type, message, opts = {}) {
  const ev = rules.eventForType(type);
  if (!ev) return null;
  if (!config.value('enabled')) return null;
  const rule = rules.get(ev.eventId);
  if (!rule || !rule.enabled || !rule.ch_app) return null;
  const ctx = coreContext(type, opts.details);
  const lang = text.serverLang();
  const title = coreTitle(lang, type, ctx.name) || sanitize.title(message) || type;
  const body = sanitize.body(message);
  if (rules.RECOVERY_TYPES.has(type)) return recover({ type, ev, rule, ctx, lang, title, body });
  return publish({
    eventId: ev.eventId, eventType: type, topic: ev.topic, source: 'system', priority: rule.priority,
    title, body, data: coreData(lang, ev.eventId, ALARM_EVENTS.has(ev.eventId)), collapseKey: ctx.collapseKey,
    target: { recipients: rule.recipients },
  }, { rule, route: { recipients: rule.recipients, peerId: ctx.peerId }, emitKey: type });
}

/** Should the generic webhook go out for this activity type (rule ch_webhook)? */
function webhookAllowed(type) {
  try {
    const ev = rules.eventForType(type);
    if (!ev) return true;
    const rule = rules.get(ev.eventId);
    return !rule || rule.ch_webhook;
  } catch { return true; }
}

// ─── Publishing ─────────────────────────────────────────────────────────

/**
 * n: { eventId, eventType, topic, source, priority, title, body, data,
 *      collapseKey, silent, target, ttlS }
 * o: { rule (delay/bundle; null = none), route (router.resolve input),
 *      emitKey (for claimMail) }
 */
function publish(n, o = {}) {
  const rule = o.rule || null;
  const route = o.route || {};
  const delayS = rule ? rule.delay_s : 0;
  const bundleS = rule ? rule.bundle_s : 0;
  const t0 = store.now();

  if (bundleS > 0 && n.collapseKey) {
    const prev = store.latestByCollapse(n.eventId, n.collapseKey, { sinceIso: store.iso(t0 - bundleS * 1000) });
    if (prev && !rules.RECOVERY_TYPES.has(prev.event_type)) return bundle(prev, n, o);
  }

  const held = delayS > 0 && !!n.collapseKey;
  const id = store.createNotification({
    ...n,
    expiresAt: expiresIso(n.ttlS),
    releaseAt: held ? store.iso(t0 + delayS * 1000) : null,
    meta: { base_title: n.title, route, ttl_s: n.ttlS || null },
  });
  publishBus(id);
  if (held) {
    remember(o.emitKey, { id, held: true, devices: 0, rule });
    return { id, held: true, devices: 0, now: 0, later: 0 };
  }
  const r = deliverNew(id, route);
  remember(o.emitKey, { id, held: false, devices: r.devices, rule });
  return { id, held: false, ...r };
}

function resolveFor(notif, route) {
  return router.resolve({ ...route, topic: notif.topic, priority: notif.priority, licensed: licensed(), now: store.now() });
}

function deliverNew(id, route) {
  const notif = store.getNotification(id);
  const targets = resolveFor(notif, route);
  const rows = store.addDeliveries(id, targets);
  return { devices: rows.length, ...pushRows(rows) };
}

/** Write queued rows to their connected streams. → { now, later } */
function pushRows(rows) {
  let now = 0;
  let later = 0;
  for (const row of rows) {
    if (row.state !== 'queued') continue;
    const conn = stream.get(row.token_id);
    if (conn && writeDelivery(conn, row.seq)) now++;
    else later++;
  }
  return { now, later };
}

/** One delivery to an open stream; marks it sent. */
function writeDelivery(conn, seq) {
  const full = store.deliveryRow(seq);
  if (!full) return false;
  if (!stream.writeEvent(conn, 'notification', store.payload(full), seq)) return false;
  store.markSent(seq, conn.via);
  return true;
}

function bundle(prev, n, o) {
  const meta = store.parseJson(prev.meta, {}) || {};
  const count = (prev.count || 1) + 1;
  const lang = text.serverLang();
  const title = sanitize.title(text.t(lang, 'push.bundle', { count: String(count), title: meta.base_title || n.title }));
  store.updateNotification(prev.id, { count, title, body: n.body || null, updated_at: store.iso(), expires_at: expiresIso(n.ttlS) });
  publishBus(prev.id);
  if (prev.release_at) {
    remember(o.emitKey, { id: prev.id, held: true, devices: 0, rule: o.rule });
    return { id: prev.id, held: true, bundled: true, devices: 0, now: 0, later: 0 };
  }
  const notif = store.getNotification(prev.id);
  const targets = resolveFor(notif, meta.route || o.route || {});
  const rows = store.requeue(prev.id, targets);
  const r = pushRows(rows);
  remember(o.emitKey, { id: prev.id, held: false, devices: rows.length, rule: o.rule });
  return { id: prev.id, held: false, bundled: true, devices: rows.length, ...r };
}

/** Open alarms (not revoked, not themselves recovery notices) of a collapse key. */
function openAlarms(eventId, collapseKey) {
  const db = require('../../db/connection').getDb();
  return db.prepare(`SELECT * FROM notifications WHERE event_id = ? AND collapse_key = ? AND revoked_at IS NULL ORDER BY id`)
    .all(eventId, collapseKey).filter((r) => !rules.RECOVERY_TYPES.has(r.event_type));
}

function recover({ type, ev, rule, ctx, title, body }) {
  if (!ctx.collapseKey) return null;
  const alarms = openAlarms(ev.eventId, ctx.collapseKey);
  if (!alarms.length) return null;
  const held = alarms.filter((a) => a.release_at);
  const shown = alarms.filter((a) => !a.release_at);
  // The "back" mail only follows an alarm mail that actually went out.
  const alarmMailed = alarms.some((a) => a.email_state === 'sent');
  for (const a of held) { store.deleteNotification(a.id); publishBus(a.id); }
  if (!shown.length) {
    remember(type, { id: null, dropMail: true });
    return { id: null, cancelled: held.map((a) => a.id) };
  }
  for (const a of shown) revoke(a.id);
  if (rule.recovery === 'off') {
    remember(type, { id: null, dropMail: !alarmMailed });
    return { id: null, revoked: shown.map((a) => a.id) };
  }
  const meta = store.parseJson(shown[shown.length - 1].meta, {}) || {};
  const silent = rule.recovery === 'silent';
  const r = publish({
    eventId: ev.eventId, eventType: type, topic: ev.topic, source: 'system', priority: silent ? 'info' : 'normal',
    title, body, data: coreData(text.serverLang(), ev.eventId, false), collapseKey: ctx.collapseKey, silent,
    target: { recipients: rule.recipients },
  }, { rule: null, route: meta.route || { recipients: rule.recipients, peerId: ctx.peerId }, emitKey: type });
  if (!alarmMailed) lastEmit.set(type, { ...lastEmit.get(type), dropMail: true });
  return r;
}

/**
 * Withdraw a notification: queued copies expire, devices that show it get
 * `event: revoke` now (or on their next connect, store.revokedForToken).
 */
function revoke(id) {
  const t = store.iso();
  store.updateNotification(id, { revoked_at: t });
  const db = require('../../db/connection').getDb();
  db.prepare("UPDATE notification_deliveries SET state = 'expired' WHERE notification_id = ? AND state = 'queued'").run(id);
  for (const row of store.deliveriesOf(id)) {
    if (row.state === 'sent' || row.state === 'delivered') stream.send(row.token_id, 'revoke', { ids: [id] });
  }
  publishBus(id);
}

// ─── E-mail ─────────────────────────────────────────────────────────────

/**
 * Called by the e-mail senders right after the event was emitted (same
 * tick). true = the hub keeps the mail and sends it only if no device
 * confirmed `delivered` within the rule's email_fallback_s; false = send now
 * (rule without fallback, push off, or no app device to wait for).
 */
function claimMail(key, mail) {
  const e = lastEmit.get(key);
  lastEmit.delete(key);
  if (!e || store.now() - e.at > MAIL_CLAIM_WINDOW_MS) return false;
  if (e.dropMail) {
    if (e.id) store.updateNotification(e.id, { email_state: 'skipped' });
    return true;
  }
  const n = store.getNotification(e.id);
  if (!n) return false;
  const rule = e.rule;
  if (!rule || rule.email_fallback_s == null || (!e.held && !e.devices)) {
    // the caller mails right away — shown in the delivery log
    store.updateNotification(n.id, { email_state: 'sent', email_sent_at: store.iso() });
    return false;
  }
  const meta = store.parseJson(n.meta, {}) || {};
  meta.mail = { subject: String(mail.subject || '').slice(0, 300), text: String(mail.text || '').slice(0, 20000) };
  if (mail.monitoring) meta.mail.monitoring = mail.monitoring;
  const base = n.release_at ? Date.parse(n.release_at) : store.now();
  store.updateNotification(n.id, { meta, email_state: 'pending', email_due_at: store.iso(base + rule.email_fallback_s * 1000) });
  return true;
}

async function sendMailNow(mail) {
  const notifications = require('../notifications');
  const to = notifications.recipient();
  if (!to) return false;
  const email = require('../email');
  if (!email.isSmtpConfigured()) return false;
  // route_down/route_up keep their own mail (target, response time)
  if (mail.monitoring) await email.sendMonitoringAlert({ to, ...mail.monitoring });
  else await email.sendMail({ to, subject: mail.subject, text: mail.text });
  return true;
}

/** Fallback mails that are due: sent unless a device confirmed in time. */
function sweepEmail() {
  const db = require('../../db/connection').getDb();
  const due = db.prepare(`SELECT * FROM notifications WHERE email_state = 'pending' AND email_due_at <= ? AND release_at IS NULL`).all(store.iso());
  const jobs = [];
  for (const n of due) {
    const confirmed = db.prepare(`SELECT 1 FROM notification_deliveries WHERE notification_id = ? AND state IN ('delivered', 'read', 'dismissed') LIMIT 1`).get(n.id);
    const meta = store.parseJson(n.meta, {}) || {};
    if (confirmed || n.revoked_at || !meta.mail) {
      store.updateNotification(n.id, { email_state: 'skipped' });
      continue;
    }
    store.updateNotification(n.id, { email_state: 'sent', email_sent_at: store.iso() });
    jobs.push(sendMailNow(meta.mail).then((sent) => {
      if (!sent) store.updateNotification(n.id, { email_state: 'skipped', email_sent_at: null });
      return sent;
    }).catch((err) => {
      logger.warn({ err: err.message, id: n.id }, 'notification fallback mail failed');
      store.updateNotification(n.id, { email_state: 'failed' });
    }));
  }
  return Promise.all(jobs);
}

/** Held messages whose delay is over are delivered now. */
function releaseHeld() {
  const db = require('../../db/connection').getDb();
  const due = db.prepare('SELECT * FROM notifications WHERE release_at IS NOT NULL AND release_at <= ?').all(store.iso());
  for (const n of due) {
    store.updateNotification(n.id, { release_at: null });
    const meta = store.parseJson(n.meta, {}) || {};
    deliverNew(n.id, meta.route || {});
    publishBus(n.id);
  }
  return due.length;
}

function tick() {
  try { releaseHeld(); } catch (err) { logger.warn({ err: err.message }, 'notify: releasing held messages failed'); }
  return sweepEmail().catch((err) => logger.warn({ err: err.message }, 'notify: e-mail sweep failed'));
}

// ─── Plugins ────────────────────────────────────────────────────────────

/**
 * A plugin message (already validated by hostApi): { topic, title, body,
 * priority, users, collapseKey, ttl, data }. Needs the email_alerts licence
 * ("plugin topics"); without it only the activity row is written.
 */
function emitPlugin(pluginId, n) {
  if (!config.value('enabled')) return { pushed: false, reason: 'disabled' };
  if (!licensed()) return { pushed: false, reason: 'unlicensed' };
  const eventId = `plugin:${pluginId}:${n.topic}`;
  const rule = rules.ensurePluginRule(eventId);
  if (!rule || !rule.enabled) return { pushed: false, reason: 'rule_disabled' };
  let r = null;
  if (rule.ch_app) {
    let priority = n.priority || rule.priority;
    if (PRIORITY_RANK[priority] > PRIORITY_RANK.high) priority = 'high';
    const users = Array.isArray(n.users) && n.users.length ? n.users : null;
    r = publish({
      eventId, eventType: 'plugin_notice', topic: eventId, source: `plugin:${pluginId}`, priority,
      title: n.title, body: n.body, data: n.data, collapseKey: n.collapseKey ? sanitize.collapseKey(`plugin:${pluginId}:${n.collapseKey}`) : null,
      ttlS: n.ttl, target: users ? { type: 'users', ids: users } : { recipients: rule.recipients },
    }, { rule, route: users ? { users } : { recipients: rule.recipients }, emitKey: eventId });
  }
  if (rule.ch_email) {
    const mail = { subject: `[GateControl] ${n.title}`, text: [n.title, '', n.body || '', '', '— GateControl'].join('\n') };
    if (!r || !claimMail(eventId, mail)) sendMailNow(mail).catch((err) => logger.warn({ err: err.message, pluginId }, 'plugin notification mail failed'));
  }
  return { pushed: !!r, id: r ? r.id : null };
}

// ─── Manual messages and tests ──────────────────────────────────────────

/**
 * Admin "Nachricht senden". target: { type: 'all'|'users'|'groups'|'devices', ids }.
 * → { id, devices_now, devices_later }
 */
function sendManual({ userId, target, title, body, priority, ttlS }) {
  const ids = Array.isArray(target.ids) ? target.ids : [];
  let route;
  if (target.type === 'all') route = { all: true };
  else if (target.type === 'users') route = { users: ids };
  else if (target.type === 'groups') route = { users: [], groups: ids };
  else route = { tokenIds: ids };
  const r = publish({
    eventId: 'manual', eventType: null, topic: 'admin_notice', source: `manual:${userId}`, priority,
    title, body, data: { route: 'inbox' }, collapseKey: null, ttlS, target: { type: target.type, ids },
  }, { rule: null, route });
  return { id: r.id, devices_now: r.now, devices_later: r.later };
}

/**
 * A test message, no filters (quiet hours, mutes): to one device
 * ({ tokenIds }) or to every app device of a person ({ userId }).
 */
function sendTest({ tokenIds = null, userId = null, source = 'system', lang = null }) {
  let ids = tokenIds;
  if (!ids) ids = router.devicesOfUsers([userId]).map((d) => d.token_id);
  const l = lang || text.userLang(userId);
  const r = publish({
    eventId: 'test', eventType: null, topic: 'admin_notice', source, priority: 'info',
    title: sanitize.title(text.t(l, 'push.test.title')), body: sanitize.body(text.t(l, 'push.test.body')),
    data: { route: 'inbox' }, collapseKey: null, target: tokenIds ? { type: 'devices', ids: tokenIds } : { type: 'users', ids: [userId] },
  }, { rule: null, route: { tokenIds: ids, bypass: true } });
  return { id: r.id, devices: r.devices, now: r.now, later: r.later };
}

/** Resend: undelivered copies of a notification get new seqs. */
function resend(id) {
  const n = store.getNotification(id);
  if (!n) return null;
  if (n.revoked_at) return { error: 'revoked' };
  const rows = store.deliveriesOf(id).filter((d) => !['delivered', 'read', 'dismissed'].includes(d.state));
  if (!n.expires_at || n.expires_at <= store.iso()) store.updateNotification(id, { expires_at: expiresIso(null) });
  const fresh = store.requeue(id, rows.map((d) => ({ tokenId: d.token_id, userId: d.user_id, silent: d.silent === 1 })));
  const r = pushRows(fresh.filter((f) => rows.some((d) => d.token_id === f.token_id)));
  publishBus(id);
  return { devices: rows.length, ...r };
}

// ─── Read-sync ──────────────────────────────────────────────────────────

/** Send `event: read` to the person's other open streams. */
function syncRead(userId, ids, exceptToken = null) {
  if (userId == null || !ids.length) return;
  for (const c of stream.list()) {
    if (c.userId === userId && c.tokenId !== exceptToken) stream.writeEvent(c, 'read', { ids });
  }
}

/** After a device ack: read/dismissed reach the person's other devices. */
function onAck(tokenId, userId, changed, state) {
  if (state !== 'read' && state !== 'dismissed') return;
  const ids = [...new Set(changed.map((c) => c.notification_id))];
  if (!ids.length || userId == null) return;
  store.markReadForUser(userId, ids, { exceptToken: tokenId });
  syncRead(userId, ids, tokenId);
}

/** Portal "gelesen": every device of the person. ids null = all. */
function markRead(userId, ids) {
  const db = require('../../db/connection').getDb();
  const list = ids || db.prepare(`SELECT DISTINCT notification_id AS id FROM notification_deliveries
     WHERE user_id = ? AND state IN ('queued', 'sent', 'delivered')`).all(userId).map((r) => r.id);
  const rows = store.markReadForUser(userId, list);
  const changedIds = [...new Set(rows.map((r) => r.notification_id))];
  syncRead(userId, changedIds);
  return changedIds.length;
}

// ─── Topics ─────────────────────────────────────────────────────────────

/** Topics a person can get: [{ id, label }] in `lang`. */
function topicsForUser(userId, lang) {
  const admin = userId != null && router.isAdmin(userId);
  const out = CORE_TOPICS.filter((t) => admin || !ADMIN_ONLY_TOPICS.has(t)).map((id) => ({ id, label: text.topicLabel(id, lang) }));
  if (licensed()) {
    for (const pt of rules.pluginTopics()) out.push({ id: pt.topic, label: text.topicLabel(pt.topic, lang) });
  }
  return out;
}

function _resetForTest() { lastEmit.clear(); }

module.exports = {
  emitActivity, webhookAllowed, publish, claimMail, sweepEmail, releaseHeld, tick, revoke, emitPlugin,
  sendManual, sendTest, resend, onAck, markRead, syncRead, topicsForUser, writeDelivery, pushRows, licensed,
  coreContext, coreTitle, sendMailNow, _resetForTest,
};
