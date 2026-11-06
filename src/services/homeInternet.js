'use strict';

// "Internet zu Hause" of a person (phase 3b, contract §1.3): a plugin with
// permissions.homeInternet (the family plugin's screen time) pauses the
// internet of a person's devices in the home network or suspends the times
// of their DNS profile for a while — always on behalf of a signed-in person
// who is using the plugin right now (hostApi.js checks that; the plugin
// itself checks that this person is a parent).
//
//   home_internet (user × kind)  kind 'pause' = "Internet aus bis" (only
//                                the always-allowed and the profile's allowed
//                                domains answer), 'extend' = "Zeiten
//                                ausgesetzt bis"
//
// Both go to every gateway with the DNS filter on where the person has
// devices (network watch: owner = the person) — features.dns.pauses /
// extensions with their MAC addresses (homeDns.configPayload) — and those
// gateways are told to pull their config at once. Plugins never see a MAC
// address: status() answers with the profile, the times and a count.
//
// Home network (homeNetwork.gatewayHomes(): a failover pool, or the same LAN
// and router): a person's devices on ANY gateway of the home network go into
// the pause of EVERY gateway of it — a failover gateway that has not scanned
// the child's tablet yet still blocks it, otherwise switching over would get
// round the pause. Devices are counted once per home network.

const { getDb } = require('../db/connection');
const logger = require('../utils/logger');

const KINDS = ['pause', 'extend'];
const MINUTE = 60 * 1000;
const MAX_PAUSE_MS = 7 * 24 * 60 * MINUTE;
const MAX_EXTEND_MS = 24 * 60 * MINUTE;

class InternetError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

function db() { return getDb(); }
function iso(ms) { return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null; }

function needUser(userId) {
  const id = Number(userId);
  const u = Number.isSafeInteger(id) && id > 0 ? db().prepare('SELECT id, username, display_name, enabled FROM users WHERE id = ?').get(id) : null;
  if (!u || u.enabled !== 1) throw new InternetError('ERR_INVALID', 'unknown or disabled person');
  return u;
}

function label(u) { return u ? (u.display_name || u.username) : null; }

/** { pause: until ms | null, extend: until ms | null } of a person (only what still runs). */
function current(userId, now = Date.now()) {
  const out = { pause: null, extend: null };
  for (const r of db().prepare('SELECT kind, until_at FROM home_internet WHERE user_id = ? AND until_at > ?').all(userId, now)) {
    if (KINDS.includes(r.kind)) out[r.kind] = r.until_at;
  }
  return out;
}

function homeOf(peerId) {
  try { return require('./homeNetwork').homeOf(peerId); } catch { return [Number(peerId)]; }
}

function macsIn(ids, userId) {
  return db().prepare(`SELECT DISTINCT mac FROM netwatch_devices WHERE owner_user_id = ? AND peer_id IN (${ids.map(() => '?').join(',')}) ORDER BY mac`)
    .all(userId, ...ids).map((r) => r.mac);
}

/** MAC addresses of a person's devices in the home network of a gateway (network watch, owner; every gateway of it). */
function macsOf(peerId, userId) {
  return macsIn(homeOf(peerId), userId);
}

/**
 * features.dns.pauses / .extensions of a gateway: one entry per person with a
 * running pause (extension) and devices in this gateway's home network —
 * `{ macs, until }`, ordered by the first MAC (stable for the config hash).
 */
function entriesFor(peerId, kind, now = Date.now()) {
  const rows = db().prepare('SELECT user_id, until_at FROM home_internet WHERE kind = ? AND until_at > ? ORDER BY user_id').all(kind, now);
  if (!rows.length) return [];
  const ids = homeOf(peerId);
  const out = [];
  for (const r of rows) {
    const macs = macsIn(ids, r.user_id);
    if (macs.length) out.push({ macs, until: iso(r.until_at) });
  }
  return out.sort((a, b) => (a.macs[0] < b.macs[0] ? -1 : a.macs[0] > b.macs[0] ? 1 : 0));
}

/** Gateways with the DNS filter on in a home network where the person has devices (by id). */
function gatewaysOf(userId) {
  const seenOn = db().prepare('SELECT DISTINCT peer_id FROM netwatch_devices WHERE owner_user_id = ?').all(userId).map((r) => r.peer_id);
  if (!seenOn.length) return [];
  let homes;
  try { homes = require('./homeNetwork').homeMap(); } catch { homes = new Map(); }
  const all = [...new Set(seenOn.flatMap((id) => homes.get(id) || [id]))];
  const ids = db().prepare(`SELECT id FROM peers WHERE peer_type = 'gateway' AND enabled = 1 AND id IN (${all.map(() => '?').join(',')}) ORDER BY id`)
    .all(...all).map((r) => r.id);
  const dns = require('./homeDns');
  return ids.filter((id) => dns.get(id).enabled);
}

function push(userId) {
  for (const peerId of gatewaysOf(userId)) require('./gatewayFeatures').notifyGateway(peerId);
}

function actorNames(ids) {
  const list = (ids || []).filter((x) => Number.isSafeInteger(x));
  if (!list.length) return [];
  return db().prepare(`SELECT id, display_name, username FROM users WHERE id IN (${list.map(() => '?').join(',')})`).all(...list).map((u) => u.display_name || u.username);
}

function log(type, message, u, extra) {
  try {
    require('./activity').log(type, message, {
      source: 'plugin', severity: 'info',
      details: { user_id: u.id, user_name: label(u), ...extra },
    });
  } catch (e) { logger.debug({ err: e.message }, 'home internet activity not written'); }
}

function clock(ms) {
  try {
    const tz = require('./notify/router').serverTz();
    return new Intl.DateTimeFormat('de-DE', { timeZone: tz, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms));
  } catch { return iso(ms); }
}

/**
 * The person's state: { profile: { id, name, gateway } | null, paused, extended
 * (ISO | null), nextSchedule: { from, to, block, categories, active } | null,
 * devices: n, filtered: bool }. `filtered` = a gateway with the DNS filter on
 * knows devices of the person (otherwise pause/extend change nothing yet).
 */
function status(userId, now = Date.now()) {
  const u = needUser(userId);
  const cur = current(u.id, now);
  const gws = gatewaysOf(u.id);
  const dns = require('./homeDns');
  let profile = null;
  let next = null;
  // a device of a home network once, not once per gateway
  const macs = new Set();
  for (const peerId of gws) for (const m of macsOf(peerId, u.id)) macs.add(m);
  const devices = macs.size;
  if (gws.length) {
    const p = dns.profileOfUser(gws[0], u.id);
    if (p) {
      profile = { id: p.id, name: p.name, gateway: dns.gatewayName(gws[0]) };
      next = dns.nextSchedule(p, now);
    }
  }
  return { userId: u.id, profile, paused: iso(cur.pause), extended: iso(cur.extend), nextSchedule: next, devices, filtered: gws.length > 0 };
}

function untilFrom(value, now, max) {
  let until;
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 1) throw new InternetError('ERR_INVALID', 'minutes: a whole number ≥ 1');
    until = now + value * MINUTE;
  } else if (typeof value === 'string') {
    until = Date.parse(value);
    if (!Number.isFinite(until)) throw new InternetError('ERR_INVALID', 'until: an ISO time');
  } else {
    throw new InternetError('ERR_INVALID', 'until: an ISO time or minutes');
  }
  if (until <= now) throw new InternetError('ERR_INVALID', 'until lies in the past');
  if (until - now > max) throw new InternetError('ERR_INVALID', `at most ${Math.round(max / MINUTE)} minutes ahead`);
  return until;
}

function store(userId, kind, until, { pluginId, actors }) {
  db().prepare(`INSERT INTO home_internet (user_id, kind, until_at, actor_user_id, plugin_id, created_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, kind) DO UPDATE SET until_at = excluded.until_at, actor_user_id = excluded.actor_user_id,
      plugin_id = excluded.plugin_id, created_at = excluded.created_at`)
    .run(userId, kind, until, (actors && actors[0]) || null, pluginId || null, Date.now());
}

function actorText(actors) {
  const n = actorNames(actors);
  return n.length ? n.join(', ') : '?';
}

/** "Internet aus" until an ISO time or for `minutes` (≤ 7 days). */
function pause(userId, value, { pluginId = null, actors = [], now = Date.now() } = {}) {
  const u = needUser(userId);
  const until = untilFrom(value, now, MAX_PAUSE_MS);
  store(u.id, 'pause', until, { pluginId, actors });
  log('home_internet_paused', `Internet paused for "${label(u)}" until ${clock(until)} (by ${actorText(actors)}${pluginId ? ', plugin ' + pluginId : ''})`, u,
    { until: iso(until), actor_user_ids: actors, actors: actorNames(actors), plugin_id: pluginId });
  push(u.id);
  return status(u.id, now);
}

/** End a pause (the times of the profile apply again; an extension stays). */
function resume(userId, { pluginId = null, actors = [], now = Date.now() } = {}) {
  const u = needUser(userId);
  const had = current(u.id, now).pause;
  db().prepare("DELETE FROM home_internet WHERE user_id = ? AND kind = 'pause'").run(u.id);
  if (had) {
    log('home_internet_resumed', `Internet back on for "${label(u)}" (by ${actorText(actors)}${pluginId ? ', plugin ' + pluginId : ''})`, u,
      { actor_user_ids: actors, actors: actorNames(actors), plugin_id: pluginId });
    push(u.id);
  }
  return status(u.id, now);
}

/**
 * Suspend the times of the person's profile for `minutes` more — counted
 * from the end of a running extension, else from now (≤ 24 h ahead).
 * `minutes` 0 ends a running extension.
 */
function extend(userId, minutes, { pluginId = null, actors = [], now = Date.now() } = {}) {
  const u = needUser(userId);
  if (!Number.isInteger(minutes) || minutes < 0) throw new InternetError('ERR_INVALID', 'minutes: a whole number ≥ 0');
  const cur = current(u.id, now).extend;
  if (minutes === 0) {
    db().prepare("DELETE FROM home_internet WHERE user_id = ? AND kind = 'extend'").run(u.id);
    if (cur) {
      log('home_internet_extended', `Extra time for "${label(u)}" ended (by ${actorText(actors)}${pluginId ? ', plugin ' + pluginId : ''})`, u,
        { until: null, actor_user_ids: actors, actors: actorNames(actors), plugin_id: pluginId });
      push(u.id);
    }
    return status(u.id, now);
  }
  const until = Math.max(now, cur || 0) + minutes * MINUTE;
  if (until - now > MAX_EXTEND_MS) throw new InternetError('ERR_INVALID', 'at most 24 hours ahead');
  store(u.id, 'extend', until, { pluginId, actors });
  log('home_internet_extended', `Extra time for "${label(u)}" until ${clock(until)} (by ${actorText(actors)}${pluginId ? ', plugin ' + pluginId : ''})`, u,
    { until: iso(until), minutes, actor_user_ids: actors, actors: actorNames(actors), plugin_id: pluginId });
  push(u.id);
  return status(u.id, now);
}

/** Running pauses per person for the admin view of a gateway: [{ userId, name, kind, until }]. */
function runningOn(peerId, now = Date.now()) {
  const rows = db().prepare(`SELECT h.user_id, h.kind, h.until_at, u.display_name, u.username FROM home_internet h JOIN users u ON u.id = h.user_id
    WHERE h.until_at > ? ORDER BY h.until_at`).all(now);
  return rows.filter((r) => macsOf(peerId, r.user_id).length).map((r) => ({ userId: r.user_id, name: r.display_name || r.username, kind: r.kind, until: iso(r.until_at) }));
}

/** Drop what ended (ticker; the gateways enforce `until` themselves). */
function cleanup(now = Date.now()) {
  return db().prepare('DELETE FROM home_internet WHERE until_at <= ?').run(now).changes;
}

module.exports = {
  InternetError, KINDS, MAX_PAUSE_MS, MAX_EXTEND_MS,
  current, entriesFor, gatewaysOf, status, pause, resume, extend, runningOn, cleanup, macsOf,
};
