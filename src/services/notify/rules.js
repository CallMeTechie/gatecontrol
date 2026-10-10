'use strict';

// Rules of the notification center: one per CATALOGUE row (services/
// notifications.js) and one per plugin topic ('plugin:<id>:<topic>').
//
// Core rows are seeded lazily on the first read: recipients "all admins",
// app on, webhooks on, e-mail exactly where alerts.email_events mails the row
// today. alerts.email_events stays the source of truth for e-mail of core
// rows — ch_email is read from it and a rule change writes it back
// (notifications.setEventEmail), so the old settings matrix and the rules
// never disagree.

const { getDb } = require('../../db/connection');
const notifications = require('../notifications');
const config = require('./config');
const { PRIORITIES, PRIORITY_RANK, GROUP_TOPIC, RECOVERY_MODES, PLUGIN_TOPIC_ID_RE } = require('./constants');

// Defaults per catalogue row: priority, bundle window, collapse key builder.
const CORE_DEFAULTS = {
  login_failed: { priority: 'high', bundle_s: 300 },
  account_locked: { priority: 'critical' },
  password_changed: { priority: 'high' },
  waf_ip_banned: { priority: 'high', bundle_s: 300 },
  // Every device connect/disconnect would ping every admin's phone: listed
  // in the inbox only, app push off until an admin turns it on.
  peer_connection: { priority: 'info', app: false },
  peer_lifecycle: { priority: 'info' },
  peer_expired: { priority: 'normal' },
  gateway_state: { priority: 'critical' },
  route_state: { priority: 'high' },
  route_lifecycle: { priority: 'info' },
  system_restart: { priority: 'info' },
  backup_restored: { priority: 'normal' },
  backup_problem: { priority: 'high' },
  update: { priority: 'info' },
  resources: { priority: 'high' },
};

// Event types that end an alarm of their row (same collapse key).
const RECOVERY_TYPES = new Set(['gateway_alive', 'gateway_recovered', 'route_up', 'resource_recovered']);

const BY_TYPE = new Map();
for (const ev of notifications.EVENTS) for (const t of ev.types) BY_TYPE.set(t, ev);

/** Raw activity type → { eventId, group, topic } (null for types outside the catalogue). */
function eventForType(type) {
  const ev = BY_TYPE.get(type);
  return ev ? { eventId: ev.id, group: ev.group, topic: GROUP_TOPIC[ev.group] } : null;
}

function coreEvent(eventId) { return notifications.EVENTS.find((e) => e.id === eventId) || null; }

function isPluginEventId(id) { return /^plugin:[a-z0-9]+(?:-[a-z0-9]+)*:[a-z][a-z0-9_-]{0,31}$/.test(String(id || '')); }

function parseRecipients(raw) {
  let r = {};
  try { r = typeof raw === 'string' ? JSON.parse(raw) : (raw || {}); } catch { r = {}; }
  const ids = (v) => (Array.isArray(v) ? [...new Set(v.map(Number).filter((n) => Number.isSafeInteger(n) && n > 0))] : []);
  return { admins: !!r.admins, owner: !!r.owner, subscribers: !!r.subscribers, users: ids(r.users), groups: ids(r.groups) };
}

function rowToRule(row) {
  if (!row) return null;
  const core = coreEvent(row.event_id);
  return {
    event_id: row.event_id,
    priority: PRIORITIES.includes(row.priority) ? row.priority : 'normal',
    recipients: parseRecipients(row.recipients),
    ch_app: row.ch_app === 1,
    // core rows: alerts.email_events is the source of truth
    ch_email: core ? notifications.eventEmailOn(core.id) : row.ch_email === 1,
    ch_webhook: row.ch_webhook === 1,
    email_fallback_s: row.email_fallback_s == null ? null : row.email_fallback_s,
    delay_s: row.delay_s || 0,
    bundle_s: row.bundle_s || 0,
    recovery: RECOVERY_MODES.includes(row.recovery) ? row.recovery : 'silent',
    enabled: row.enabled === 1,
    updated_at: row.updated_at || null,
  };
}

let _seededDb = null;

/** Insert the rows of catalogue events that have no rule yet (idempotent). */
function ensureSeeded() {
  const db = getDb();
  if (_seededDb === db) return;
  const fallback = config.value('email_fallback_s');
  const ins = db.prepare(`INSERT OR IGNORE INTO notify_rules
    (event_id, priority, recipients, ch_app, ch_email, ch_webhook, email_fallback_s, delay_s, bundle_s, recovery, enabled, updated_at)
    VALUES (?, ?, '{"admins":true}', ?, ?, 1, ?, 0, ?, 'silent', 1, NULL)`);
  db.transaction(() => {
    for (const ev of notifications.EVENTS) {
      const d = CORE_DEFAULTS[ev.id] || { priority: 'normal' };
      const important = PRIORITY_RANK[d.priority] >= PRIORITY_RANK.high;
      ins.run(ev.id, d.priority, d.app === false ? 0 : 1, notifications.eventEmailOn(ev.id) ? 1 : 0, important ? fallback : null, d.bundle_s || 0);
    }
  })();
  _seededDb = db;
}

function get(eventId) {
  ensureSeeded();
  return rowToRule(getDb().prepare('SELECT * FROM notify_rules WHERE event_id = ?').get(String(eventId)));
}

/** Rule of a plugin topic, created with its defaults on first use. */
function ensurePluginRule(eventId) {
  if (!isPluginEventId(eventId)) return null;
  getDb().prepare(`INSERT OR IGNORE INTO notify_rules
    (event_id, priority, recipients, ch_app, ch_email, ch_webhook, email_fallback_s, delay_s, bundle_s, recovery, enabled)
    VALUES (?, 'normal', '{"subscribers":true}', 1, 0, 1, NULL, 0, 0, 'off', 1)`).run(eventId);
  return rowToRule(getDb().prepare('SELECT * FROM notify_rules WHERE event_id = ?').get(eventId));
}

// ─── Plugin topics ──────────────────────────────────────────────────────

/**
 * Topics of the installed plugins with the notify permission:
 * [{ topic, plugin_id, plugin_name, id, label:{de,en}, default }].
 * Every such plugin has 'default' (gc.notify(message)) plus its notifyTopics.
 */
function pluginTopics() {
  let list = [];
  try { list = require('../plugins/registry').list(); } catch { list = []; }
  const out = [];
  for (const p of list) {
    const m = p.manifest || {};
    if (!m.permissions || !m.permissions.notify) continue;
    const name = m.name || { de: p.name, en: p.name };
    const declared = Array.isArray(m.notifyTopics) ? m.notifyTopics : [];
    if (!declared.some((t) => t && t.id === 'default')) {
      out.push({ topic: `plugin:${p.id}:default`, plugin_id: p.id, plugin_name: name, id: 'default', label: name, default: true, enabled: p.enabled });
    }
    for (const t of declared) {
      if (!t || !PLUGIN_TOPIC_ID_RE.test(String(t.id))) continue;
      out.push({ topic: `plugin:${p.id}:${t.id}`, plugin_id: p.id, plugin_name: name, id: t.id, label: t.label || { de: t.id, en: t.id }, default: t.default !== false, enabled: p.enabled });
    }
  }
  return out;
}

function pluginTopic(topic) { return pluginTopics().find((t) => t.topic === topic) || null; }

/** Every rule: catalogue order, then the plugin topics. */
function list() {
  ensureSeeded();
  const db = getDb();
  const rows = new Map(db.prepare('SELECT * FROM notify_rules').all().map((r) => [r.event_id, r]));
  const out = [];
  for (const ev of notifications.EVENTS) {
    const rule = rowToRule(rows.get(ev.id));
    if (rule) out.push({ ...rule, group: ev.group, plugin_id: null });
  }
  for (const t of pluginTopics()) {
    const rule = rows.has(t.topic) ? rowToRule(rows.get(t.topic)) : ensurePluginRule(t.topic);
    if (rule) out.push({ ...rule, group: 'plugins', plugin_id: t.plugin_id, plugin_topic: t });
  }
  return out;
}

// ─── Updates ────────────────────────────────────────────────────────────

const INT_RANGES = { delay_s: [0, 86400], bundle_s: [0, 86400], email_fallback_s: [0, 86400] };

function asBool(v) {
  if (v === true || v === 1 || v === '1' || v === 'true') return true;
  if (v === false || v === 0 || v === '0' || v === 'false') return false;
  return undefined;
}

function asIdList(v) {
  if (!Array.isArray(v) || v.length > 500) return null;
  const out = [];
  for (const x of v) {
    const n = typeof x === 'number' ? x : (/^\d+$/.test(String(x)) ? Number(x) : NaN);
    if (!Number.isSafeInteger(n) || n <= 0) return null;
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

/**
 * Validate a partial update. → { values, errors: { field: code } }
 * codes: invalid | unknown_user | unknown_group | priority_capped
 */
function validatePatch(eventId, body) {
  const values = {};
  const errors = {};
  const b = body && typeof body === 'object' ? body : {};
  const plugin = isPluginEventId(eventId);
  const db = getDb();
  if (b.priority !== undefined) {
    if (!PRIORITIES.includes(b.priority)) errors.priority = 'invalid';
    else if (plugin && b.priority === 'critical') errors.priority = 'priority_capped';
    else values.priority = b.priority;
  }
  if (b.recipients !== undefined) {
    const r = b.recipients;
    if (!r || typeof r !== 'object' || Array.isArray(r)) errors.recipients = 'invalid';
    else {
      const out = {};
      for (const k of ['admins', 'owner', 'subscribers']) {
        if (r[k] === undefined) { out[k] = false; continue; }
        const v = asBool(r[k]);
        if (v === undefined) errors.recipients = 'invalid'; else out[k] = v;
      }
      for (const k of ['users', 'groups']) {
        if (r[k] === undefined) { out[k] = []; continue; }
        const ids = asIdList(r[k]);
        if (!ids) { errors.recipients = 'invalid'; continue; }
        out[k] = ids;
      }
      if (!errors.recipients && out.users.length) {
        const known = new Set(db.prepare(`SELECT id FROM users WHERE id IN (${out.users.map(() => '?').join(',')})`).all(...out.users).map((x) => x.id));
        if (out.users.some((id) => !known.has(id))) errors.recipients = 'unknown_user';
      }
      if (!errors.recipients && out.groups.length) {
        const known = new Set(db.prepare(`SELECT id FROM peer_groups WHERE id IN (${out.groups.map(() => '?').join(',')})`).all(...out.groups).map((x) => x.id));
        if (out.groups.some((id) => !known.has(id))) errors.recipients = 'unknown_group';
      }
      if (!errors.recipients) values.recipients = out;
    }
  }
  for (const k of ['ch_app', 'ch_email', 'ch_webhook', 'enabled']) {
    if (b[k] === undefined) continue;
    const v = asBool(b[k]);
    if (v === undefined) errors[k] = 'invalid'; else values[k] = v;
  }
  for (const [k, [min, max]] of Object.entries(INT_RANGES)) {
    if (b[k] === undefined) continue;
    if (k === 'email_fallback_s' && b[k] === null) { values[k] = null; continue; }
    const n = typeof b[k] === 'number' ? b[k] : (/^\d+$/.test(String(b[k])) ? Number(b[k]) : NaN);
    if (!Number.isSafeInteger(n) || n < min || n > max) errors[k] = 'invalid'; else values[k] = n;
  }
  if (b.recovery !== undefined) {
    if (!RECOVERY_MODES.includes(b.recovery)) errors.recovery = 'invalid'; else values.recovery = b.recovery;
  }
  return { values, errors };
}

/** Apply validated values. Returns the updated rule. */
function update(eventId, values) {
  ensureSeeded();
  const db = getDb();
  const cur = db.prepare('SELECT * FROM notify_rules WHERE event_id = ?').get(eventId);
  if (!cur) return null;
  const sets = [];
  const args = [];
  const col = (c, v) => { sets.push(`${c} = ?`); args.push(v); };
  if (values.priority !== undefined) col('priority', values.priority);
  if (values.recipients !== undefined) col('recipients', JSON.stringify(values.recipients));
  for (const k of ['ch_app', 'ch_email', 'ch_webhook', 'enabled']) if (values[k] !== undefined) col(k, values[k] ? 1 : 0);
  for (const k of ['delay_s', 'bundle_s', 'email_fallback_s', 'recovery']) if (values[k] !== undefined) col(k, values[k]);
  col('updated_at', new Date().toISOString());
  db.prepare(`UPDATE notify_rules SET ${sets.join(', ')} WHERE event_id = ?`).run(...args, eventId);
  const core = coreEvent(eventId);
  if (core && values.ch_email !== undefined && values.ch_email !== notifications.eventEmailOn(core.id)) {
    notifications.setEventEmail(core.id, values.ch_email);
  }
  return get(eventId);
}

/** Does a rule (as stored) exist for this event id? Core rows always do. */
function exists(eventId) {
  if (coreEvent(eventId)) return true;
  return isPluginEventId(eventId) && !!pluginTopic(eventId);
}

function _resetForTest() { _seededDb = null; }

module.exports = {
  CORE_DEFAULTS, RECOVERY_TYPES, eventForType, coreEvent, isPluginEventId, parseRecipients,
  ensureSeeded, get, list, ensurePluginRule, pluginTopics, pluginTopic, validatePatch, update, exists, _resetForTest,
};
