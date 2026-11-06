'use strict';

// Presence over the home network (phase 3a, contract §3).
//
// A device of the network watch (netwatch_devices) that belongs to a person
// and "counts for presence" is watched by the gateway — but only when the
// person agreed themselves (presence_consent, switched through a plugin with
// permissions.homePresence: gc.homeNetwork.presence.setConsent, only inside a
// request of that very person — plugins/personContext.js). Then its MAC goes
// into features.presence.macs of the gateway's config pull (macsFor).
//
// The gateway reports transitions (POST /api/v1/gateway/presence, the
// hysteresis — "away" after 10 minutes without a sign — is the gateway's);
// ingest() keeps the state per device and derives the state per person:
// home = any counting device of the person online on any gateway. A change
// goes to every running plugin with the permission (hook homePresence →
// gc.homeNetwork.presence.on) — { userId, home, since, source: 'wifi' }.
// Plugins never get MAC or IP addresses.
//
// Gateways in one home network (homeNetwork.gatewayHomes(), e.g. a failover
// pair) both watch the same phone: its rows carry the same owner / counts
// (netwatch.js keeps them equal), the state per person takes each MAC once —
// a gateway that is down (gateway_meta.alive = 0) does not keep a person
// "home" with its last report while another gateway of the home network
// still reports — and devices() lists a phone once.

const { getDb } = require('../db/connection');
const logger = require('../utils/logger');

const MAX_MACS = 256;
const MAX_EVENTS = 256;
const HOOK_MS = 10000;
const MAC_RE = /^[0-9a-f]{2}(?::[0-9a-f]{2}){5}$/;

class PresenceError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

function db() { return getDb(); }
function iso(ms) { return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null; }

/** 'AA-BB-…' / 'aa:bb:…' → 'aa:bb:cc:dd:ee:ff' | null */
function normMac(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase().replace(/-/g, ':');
  return MAC_RE.test(s) ? s : null;
}

/** Epoch ms or ISO text → epoch ms (seconds below 1e12; the future clamped to now) | null */
function normTime(v, now = Date.now()) {
  let ms = null;
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) ms = v < 1e12 ? v * 1000 : v;
  else if (typeof v === 'string' && v.length <= 40) { const t = Date.parse(v); if (Number.isFinite(t) && t > 0) ms = t; }
  if (ms == null) return null;
  ms = Math.round(ms);
  return ms > now + 5 * 60 * 1000 ? now : ms;
}

// ─── Consent ───────────────────────────────────────────────────────────

function consentRow(userId) {
  return db().prepare('SELECT enabled, updated_at FROM presence_consent WHERE user_id = ?').get(userId) || null;
}

function consentOf(userId) {
  const r = consentRow(userId);
  return r ? r.enabled === 1 : false;
}

function needUser(userId) {
  if (!Number.isSafeInteger(userId) || userId <= 0) throw new PresenceError('ERR_INVALID', 'invalid user id');
  const u = db().prepare('SELECT id FROM users WHERE id = ? AND enabled = 1').get(userId);
  if (!u) throw new PresenceError('ERR_INVALID', 'unknown or disabled user');
  return u;
}

/** Gateways with a counting device of this person (their presence MACs change with the consent). */
function gatewaysOfUser(userId) {
  return db().prepare('SELECT DISTINCT peer_id FROM netwatch_devices WHERE owner_user_id = ? AND presence = 1').all(userId).map((r) => r.peer_id);
}

function pushConfig(peerIds) {
  for (const id of new Set(peerIds)) {
    try { require('./gateways').notifyConfigChanged(id).catch(() => {}); } catch { /* best-effort */ }
  }
}

/** The person switched "my phone in the Wi-Fi" on or off. */
function setConsent(userId, enabled, { pluginId = null } = {}) {
  needUser(userId);
  if (typeof enabled !== 'boolean') throw new PresenceError('ERR_INVALID', 'enabled must be true or false');
  const before = consentOf(userId);
  db().prepare(`INSERT INTO presence_consent (user_id, enabled, plugin_id, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET enabled = excluded.enabled, plugin_id = excluded.plugin_id, updated_at = excluded.updated_at`)
    .run(userId, enabled ? 1 : 0, pluginId, Date.now());
  if (before !== enabled) {
    try {
      require('./activity').log(enabled ? 'presence_consent_on' : 'presence_consent_off',
        `Presence over the home network ${enabled ? 'switched on' : 'switched off'} by the person themselves`,
        { source: 'user', userId, severity: 'info', details: { user_id: userId, plugin: pluginId } });
    } catch { /* best-effort */ }
    pushConfig(gatewaysOfUser(userId));
    recompute(userId, Date.now());
  }
  return { consent: enabled };
}

// ─── What goes to the gateway ──────────────────────────────────────────

/** MACs the gateway `peerId` watches for presence: counting devices of people who agreed. */
function macsFor(peerId) {
  return db().prepare(`SELECT d.mac FROM netwatch_devices d
      JOIN presence_consent c ON c.user_id = d.owner_user_id AND c.enabled = 1
      JOIN users u ON u.id = d.owner_user_id AND u.enabled = 1
    WHERE d.peer_id = ? AND d.presence = 1 ORDER BY d.mac LIMIT ?`).all(peerId, MAX_MACS).map((r) => r.mac);
}

// ─── Reports of the gateway ────────────────────────────────────────────

/**
 * POST /api/v1/gateway/presence — { events: [{ mac, online, at }] }.
 * Unknown MACs (not watched for presence) are ignored.
 */
function ingest(peerId, body) {
  const events = body && Array.isArray(body.events) ? body.events : null;
  if (!events) throw new PresenceError('invalid', 'events must be an array');
  if (events.length > MAX_EVENTS) throw new PresenceError('invalid', `at most ${MAX_EVENTS} events`);
  const now = Date.now();
  const parsed = [];
  for (const e of events) {
    const mac = normMac(e && e.mac);
    if (!mac || typeof e.online !== 'boolean') throw new PresenceError('invalid', 'event: { mac, online, at }');
    parsed.push({ mac, online: e.online, at: normTime(e.at, now) || now });
  }
  parsed.sort((a, b) => a.at - b.at);
  const watched = new Set(macsFor(peerId));
  const find = db().prepare('SELECT id, owner_user_id, presence_at FROM netwatch_devices WHERE peer_id = ? AND mac = ?');
  const upd = db().prepare('UPDATE netwatch_devices SET presence_online = ?, presence_at = ?, last_seen = MAX(last_seen, ?) WHERE id = ?');
  const touched = new Map(); // userId → latest at
  db().transaction(() => {
    for (const e of parsed) {
      if (!watched.has(e.mac)) continue;
      const d = find.get(peerId, e.mac);
      if (!d || !d.owner_user_id) continue;
      if (d.presence_at && e.at < d.presence_at) continue; // an older report than what we have
      upd.run(e.online ? 1 : 0, e.at, e.online ? e.at : 0, d.id);
      touched.set(d.owner_user_id, Math.max(touched.get(d.owner_user_id) || 0, e.at));
    }
  })();
  for (const [userId, at] of touched) recompute(userId, at);
  return { accepted: touched.size };
}

// ─── State per person ──────────────────────────────────────────────────

function stateRow(userId) {
  return db().prepare('SELECT home, since FROM presence_state WHERE user_id = ?').get(userId) || null;
}

/** Derive the person's state from their counting devices; a change goes to the plugins. */
function recompute(userId, at) {
  const prev = stateRow(userId);
  let next = null;
  if (consentOf(userId)) {
    const rowsAll = db().prepare(`SELECT d.mac, d.presence_online, d.presence_at, COALESCE(gm.alive, 1) AS alive FROM netwatch_devices d
      LEFT JOIN gateway_meta gm ON gm.peer_id = d.peer_id
      WHERE d.owner_user_id = ? AND d.presence = 1 AND d.presence_online IS NOT NULL`).all(userId);
    if (rowsAll.length) {
      const byMac = new Map();
      for (const r of rowsAll) { if (!byMac.has(r.mac)) byMac.set(r.mac, []); byMac.get(r.mac).push(r); }
      next = [...byMac.values()].some((rows) => {
        // one phone seen by several gateways: the reports of gateways that are up; none up → the latest report
        const up = rows.filter((r) => r.alive === 1);
        if (up.length) return up.some((r) => r.presence_online === 1);
        return rows.reduce((a, b) => ((b.presence_at || 0) > (a.presence_at || 0) ? b : a)).presence_online === 1;
      });
    }
  }
  if (next === null) {
    if (prev) {
      db().prepare('DELETE FROM presence_state WHERE user_id = ?').run(userId);
      emit({ userId, home: null, since: iso(at || Date.now()), source: 'wifi' });
    }
    return null;
  }
  if (prev && (prev.home === 1) === next) return { home: next, since: prev.since };
  const since = at || Date.now();
  db().prepare(`INSERT INTO presence_state (user_id, home, since, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET home = excluded.home, since = excluded.since, updated_at = excluded.updated_at`)
    .run(userId, next ? 1 : 0, since, Date.now());
  emit({ userId, home: next, since: iso(since), source: 'wifi' });
  return { home: next, since };
}

// ─── Plugins (gc.homeNetwork.presence) ─────────────────────────────────

function hasPermission(p) {
  return !!(p && p.manifest && p.manifest.permissions && p.manifest.permissions.homePresence === true);
}

function presencePlugins() {
  try {
    const registry = require('./plugins/registry');
    const runtime = require('./plugins/runtime');
    const plugins = require('./plugins');
    return registry.list().filter(hasPermission).filter((p) => {
      try { return plugins.evaluate(p).run && runtime.info(p.id).state === 'running'; } catch { return false; }
    });
  } catch { return []; }
}

/** A person's state changed → hook homePresence of every running plugin with the permission (never awaited). */
function emit(ev) {
  const payload = { userId: ev.userId, home: ev.home, since: ev.since, source: ev.source };
  for (const p of presencePlugins()) {
    try {
      require('./plugins/runtime').call(p.id, 'homePresence', payload, module.exports._hookMs || HOOK_MS).catch((e) => {
        try { require('./plugins/registry').addLog(p.id, e && e.stopped ? 'debug' : 'warn', 'homePresence failed: ' + String((e && e.message) || e).slice(0, 200)); } catch { /* db closed */ }
      });
    } catch (e) { logger.debug({ err: e.message }, 'homePresence hook not delivered'); }
  }
  try { require('./eventBus').publish('home_presence', { user_id: ev.userId, home: ev.home }); } catch { /* best-effort */ }
}

/** gc.homeNetwork.presence.list() → people who agreed and have a known state. */
function list() {
  return db().prepare(`SELECT s.user_id, s.home, s.since FROM presence_state s
      JOIN presence_consent c ON c.user_id = s.user_id AND c.enabled = 1
      JOIN users u ON u.id = s.user_id AND u.enabled = 1
    ORDER BY s.user_id`).all()
    .map((r) => ({ userId: r.user_id, home: r.home === 1, since: iso(r.since), source: 'wifi' }));
}

/** gc.homeNetwork.presence.consent(userId) → { consent, since } (whether, not which devices). */
function consentInfo(userId) {
  needUser(userId);
  const r = consentRow(userId);
  return { consent: r ? r.enabled === 1 : false, since: r ? iso(r.updated_at) : null };
}

function homeMap() {
  try { return require('./homeNetwork').homeMap(); } catch { return new Map(); }
}

/**
 * gc.homeNetwork.presence.devices(userId) — the person's own devices: names
 * and times, no addresses. A device that several gateways of one home
 * network see is listed once (gateway: their names, "A / B").
 */
function devices(userId) {
  needUser(userId);
  const homes = homeMap();
  const out = new Map();
  const rows = db().prepare(`SELECT d.id, d.peer_id, d.mac, d.name, d.hostname, d.vendor, d.last_seen, d.presence, d.presence_online, d.presence_at, p.name AS gateway
      FROM netwatch_devices d JOIN peers p ON p.id = d.peer_id
    WHERE d.owner_user_id = ? ORDER BY lower(COALESCE(d.name, d.hostname, d.vendor, '')) , d.id`).all(userId);
  for (const r of rows) {
    const key = (homes.get(r.peer_id) || [r.peer_id])[0] + '|' + r.mac;
    const seen = Math.max(r.last_seen || 0, r.presence_online === 1 ? (r.presence_at || 0) : 0);
    const cur = out.get(key);
    if (cur) {
      cur.seen = Math.max(cur.seen, seen);
      cur.counts = cur.counts || r.presence === 1;
      if (!cur.gateways.includes(r.gateway)) cur.gateways.push(r.gateway);
      continue;
    }
    out.set(key, { id: r.id, name: r.name || r.hostname || r.vendor || null, seen, counts: r.presence === 1, gateways: [r.gateway] });
  }
  return [...out.values()].map((d) => ({ id: d.id, name: d.name, lastSeen: iso(d.seen), counts: d.counts, gateway: d.gateways.join(' / ') }));
}

/** gc.homeNetwork.presence.setCounts(userId, deviceId, counts) — only a device of that person. */
function setCounts(userId, deviceId, counts) {
  needUser(userId);
  if (!Number.isSafeInteger(deviceId) || deviceId <= 0) throw new PresenceError('ERR_INVALID', 'invalid device id');
  if (typeof counts !== 'boolean') throw new PresenceError('ERR_INVALID', 'counts must be true or false');
  const d = db().prepare('SELECT id, peer_id, mac, presence FROM netwatch_devices WHERE id = ? AND owner_user_id = ?').get(deviceId, userId);
  if (!d) throw new PresenceError('ERR_NOT_FOUND', 'no such device of this person');
  // the same phone on every gateway of the home network
  const ids = (homeMap().get(d.peer_id) || [d.peer_id]);
  const rows = db().prepare(`SELECT id, peer_id, presence FROM netwatch_devices WHERE mac = ? AND owner_user_id = ? AND peer_id IN (${ids.map(() => '?').join(',')})`)
    .all(d.mac, userId, ...ids);
  if (!rows.some((r) => r.id === d.id)) rows.push(d);
  const change = rows.filter((r) => (r.presence === 1) !== counts);
  if (change.length) {
    const now = Date.now();
    const upd = db().prepare('UPDATE netwatch_devices SET presence = ?, presence_online = CASE WHEN ? = 1 THEN presence_online ELSE NULL END, decided_at = ?, updated_at = ? WHERE id = ?');
    db().transaction(() => { for (const r of change) upd.run(counts ? 1 : 0, counts ? 1 : 0, now, now, r.id); })();
    pushConfig(change.map((r) => r.peer_id));
    recompute(userId, now);
  }
  return { counts };
}

/** A device's owner or its presence flag changed (admin UI, merge of a home network) → state and gateway config. */
function onDeviceChanged(peerIds, userIds) {
  pushConfig(Array.isArray(peerIds) ? peerIds : [peerIds]);
  for (const u of new Set((userIds || []).filter((x) => Number.isSafeInteger(x) && x > 0))) recompute(u, Date.now());
}

module.exports = {
  PresenceError, MAX_MACS, normMac, normTime, consentOf, setConsent, macsFor, ingest, recompute, list, consentInfo,
  devices, setCounts, onDeviceChanged, hasPermission, emit, _hookMs: null,
};
