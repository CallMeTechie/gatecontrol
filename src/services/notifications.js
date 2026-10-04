'use strict';

// Notifications: one recipient for every notification mail, the catalogue of
// events a notification can be sent for, and which of them go out by e-mail.
//
// Storage (settings table):
//   notifications.email   the recipient — one address or several, comma
//                         separated. Replaces alerts.email and
//                         monitoring.alert_email (migration 87 merges them;
//                         recipient() still reads the old keys once when a
//                         backup from before the migration is restored).
//   alerts.email_events   comma-separated EVENT TYPES that are mailed. The
//                         settings page shows one row per catalogue event and
//                         writes all types of a ticked row; old lists written
//                         per group (security, peers, routes, system) keep
//                         working because a row counts as ticked when any of
//                         its types is in the list.
//
// Two rows are not mailed by the generic activity mail but by their own
// sender, from the same list: route_down / route_up (services/monitor.js,
// with target and response time) and the update mails
// (services/updateNotify.js). Both used to have their own switch
// (monitoring.email_alerts, notify.update_email) — migration 87 folds them in.
//
// Webhooks use the same catalogue as allow-list for their event selection
// (`webhooks.events`: '*' or a list of types, see parseWebhookEvents).

const settings = require('./settings');

const K_RECIPIENT = 'notifications.email';
const K_EVENTS = 'alerts.email_events';
const LEGACY_RECIPIENT_KEYS = ['alerts.email', 'monitoring.alert_email'];

// Rows of the event matrix. `id` is the row (i18n st.event.<id>), `types` the
// event types it stands for. `free`: mailing it does not need the
// email_alerts licence (it had its own unlicensed switch before).
const CATALOGUE = [
  { id: 'security', events: [
    { id: 'login_failed', types: ['login_failed', 'login_2fa_failed', 'passkey_login_failed'] },
    { id: 'account_locked', types: ['account_locked'] },
    { id: 'password_changed', types: ['password_changed'] },
    { id: 'waf_ip_banned', types: ['waf_ip_banned'] },
  ] },
  { id: 'peers', events: [
    { id: 'peer_connection', types: ['peer_connected', 'peer_disconnected'] },
    { id: 'peer_lifecycle', types: ['peer_created', 'peer_deleted'] },
    { id: 'peer_expired', types: ['peer_expired'] },
    { id: 'gateway_state', types: ['gateway_down', 'gateway_alive', 'gateway_offline', 'gateway_recovered'] },
  ] },
  { id: 'routes', events: [
    { id: 'route_state', types: ['route_down', 'route_up'], free: true },
    { id: 'route_lifecycle', types: ['route_created', 'route_deleted'] },
  ] },
  { id: 'system', events: [
    { id: 'system_restart', types: ['system_start', 'wg_restart'] },
    { id: 'backup_restored', types: ['backup_restored'] },
    { id: 'backup_problem', types: ['backup_reminder', 'autobackup_failed'] },
    { id: 'update', types: ['update_installed', 'update_rolled_back', 'update_failed'], free: true },
    { id: 'resources', types: ['resource_alert', 'resource_recovered'] },
  ] },
];

const EVENTS = [];
for (const g of CATALOGUE) for (const e of g.events) EVENTS.push({ ...e, group: g.id });
const ALLOWED_TYPES = new Set(EVENTS.flatMap((e) => e.types));
const FREE_TYPES = new Set(EVENTS.filter((e) => e.free).flatMap((e) => e.types));
// Mailed by their own sender (monitor.js / updateNotify.js), never by the
// generic activity mail — otherwise a route outage would arrive twice.
const DEDICATED_MAIL_TYPES = new Set(['route_down', 'route_up', 'update_installed', 'update_rolled_back', 'update_failed']);

// ─── Lists of event types ────────────────────────────────────────────────

/** 'a, b,,a' / ['a','b'] → ['a','b'] (trimmed, deduplicated, order kept). */
function parseList(value) {
  const raw = Array.isArray(value) ? value : String(value == null ? '' : value).split(',');
  const out = [];
  for (const v of raw) {
    const s = String(v == null ? '' : v).trim();
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

/** Catalogue order (unknown types last, in their own order). */
function sortTypes(types) {
  const order = [...ALLOWED_TYPES];
  return [...types].sort((a, b) => {
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    return (ia < 0 ? 1e6 : ia) - (ib < 0 ? 1e6 : ib);
  });
}

/** Row ids whose types appear in `types` (any of them — old group lists). */
function eventsFromTypes(types) {
  const set = new Set(parseList(types));
  return EVENTS.filter((e) => e.types.some((t) => set.has(t))).map((e) => e.id);
}

/** Row ids → every type of those rows. Unknown ids are ignored. */
function typesFromEvents(ids) {
  const want = new Set(parseList(ids));
  return EVENTS.filter((e) => want.has(e.id)).flatMap((e) => e.types);
}

/** The unknown entries of a type list (for a 400). */
function unknownTypes(types) {
  return parseList(types).filter((t) => !ALLOWED_TYPES.has(t));
}

// ─── Recipient ────────────────────────────────────────────────────────────

function joinRecipients(values) {
  const out = [];
  for (const v of values) {
    for (const part of String(v == null ? '' : v).split(',')) {
      const s = part.trim();
      if (s && !out.some((o) => o.toLowerCase() === s.toLowerCase())) out.push(s);
    }
  }
  return out.join(', ');
}

/**
 * The recipient of every notification mail ('' = none). The first read after
 * a restore of a pre-migration backup (key missing, old keys present) moves
 * the old addresses over and drops the old keys — that is the one fallback.
 */
function recipient() {
  const v = settings.get(K_RECIPIENT, null);
  if (v !== null) return String(v).trim();
  const legacy = joinRecipients(LEGACY_RECIPIENT_KEYS.map((k) => settings.get(k, '')));
  settings.set(K_RECIPIENT, legacy);
  try {
    const { getDb } = require('../db/connection');
    getDb().prepare(`DELETE FROM settings WHERE key IN (${LEGACY_RECIPIENT_KEYS.map(() => '?').join(',')})`).run(...LEGACY_RECIPIENT_KEYS);
  } catch { /* the value is stored; the old keys are only read once more */ }
  return legacy;
}

function setRecipient(value) {
  const v = joinRecipients([value]);
  settings.set(K_RECIPIENT, v);
  return v;
}

/** Each address of a recipient string ('' → []). */
function recipientList(value) {
  return parseList(value);
}

// ─── Which events are mailed ─────────────────────────────────────────────

function emailTypes() { return parseList(settings.get(K_EVENTS, '')); }

function setEmailTypes(types) {
  const list = sortTypes(parseList(types));
  settings.set(K_EVENTS, list.join(','));
  return list;
}

function wantsEmail(type) { return emailTypes().includes(type); }

/** Add or remove every type of a catalogue row. */
function setEventEmail(eventId, on) {
  const ev = EVENTS.find((e) => e.id === eventId);
  if (!ev) throw new Error('unknown event ' + eventId);
  const cur = emailTypes().filter((t) => !ev.types.includes(t));
  return setEmailTypes(on ? cur.concat(ev.types) : cur);
}

function eventEmailOn(eventId) {
  const ev = EVENTS.find((e) => e.id === eventId);
  return !!ev && eventsFromTypes(emailTypes()).includes(eventId);
}

/** Types that changed between two lists and need the email_alerts licence. */
function licensedChanges(before, after) {
  const a = new Set(parseList(before).filter((t) => !FREE_TYPES.has(t)));
  const b = new Set(parseList(after).filter((t) => !FREE_TYPES.has(t)));
  return [...new Set([...a, ...b])].filter((t) => a.has(t) !== b.has(t));
}

/** Should the generic activity mail go out for this type? */
function genericMailFor(type) {
  return !DEDICATED_MAIL_TYPES.has(type) && wantsEmail(type);
}

// ─── Webhook event selection ─────────────────────────────────────────────

class EventListError extends Error {
  constructor(message, invalid) {
    super(message);
    this.invalid = invalid || [];
  }
}

/**
 * The `events` of a webhook as stored: '*' (all events, including those
 * outside the catalogue) or a comma list of catalogue types. `undefined`
 * → '*' (create without a selection). An empty selection or an unknown type
 * throws EventListError ("Invalid webhook events: …").
 */
function parseWebhookEvents(input) {
  if (input === undefined || input === null) return '*';
  const list = parseList(input);
  if (list.includes('*')) return '*';
  if (!list.length) throw new EventListError('Invalid webhook events: empty selection');
  const bad = list.filter((t) => !ALLOWED_TYPES.has(t));
  if (bad.length) throw new EventListError('Invalid webhook events: ' + bad.join(', '), bad);
  return sortTypes(list).join(',');
}

/** Does a webhook with this `events` value receive `type`? */
function webhookReceives(events, type) {
  const v = String(events == null ? '' : events).trim();
  if (v === '*') return true;
  return parseList(v).includes(type);
}

module.exports = {
  CATALOGUE,
  EVENTS,
  ALLOWED_TYPES,
  FREE_TYPES,
  DEDICATED_MAIL_TYPES,
  K_RECIPIENT,
  K_EVENTS,
  LEGACY_RECIPIENT_KEYS,
  parseList,
  sortTypes,
  eventsFromTypes,
  typesFromEvents,
  unknownTypes,
  joinRecipients,
  recipient,
  setRecipient,
  recipientList,
  emailTypes,
  setEmailTypes,
  wantsEmail,
  setEventEmail,
  eventEmailOn,
  licensedChanges,
  genericMailFor,
  EventListError,
  parseWebhookEvents,
  webhookReceives,
};
