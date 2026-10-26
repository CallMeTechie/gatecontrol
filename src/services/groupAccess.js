'use strict';

/**
 * Zugriff per Gruppe (docs/groups.md "Zugriff per Gruppe") — who may reach an
 * HTTP route or an RDP entry. One rule for every entry point: the client API
 * (routes.getForUser, rdp.getForToken / canAccessRoute), the portal tiles,
 * the automatic route login of the apps, "Was sieht <Name>?", the Caddy peer
 * ACL and the admin preview "Darf zugreifen".
 *
 * An entry carries
 *   persons  routes.user_ids / rdp_routes.user_ids  JSON array of user ids
 *   groups   route_group_acl (HTTP routes) / rdp_routes.group_ids (JSON array)
 *   devices  route_peer_acl (HTTP routes only; Caddy, when acl_enabled)
 *   acl_people  routes.acl_people (HTTP routes; Caddy layer only, see below)
 *
 * Rules
 *   • persons AND groups empty → no person restriction (everybody, as before).
 *   • otherwise: the listed persons ∪ the effective members of the listed
 *     groups (subgroups included, archived groups and disabled accounts
 *     skipped — groups.effectiveUserIds). Checked on every access, so leaving
 *     a group takes effect at once.
 *   • A stale id (deleted person, archived group, the NOBODY marker 0 left
 *     behind when the only group of a route was deleted) keeps the entry
 *     restricted — it simply matches nobody. Never "visible for everybody".
 *   • Malformed JSON in user_ids / group_ids counts as "no restriction"
 *     (historic behaviour of rdpAcl / routes.getForUser).
 *   • Caddy peer ACL (acl_enabled): allowed source IPs = the listed devices ∪
 *     — only with acl_people = 1 — the devices (peers owned, peers bound to
 *     their tokens) of the persons and of the effective group members. When
 *     something counts as listed but no IP results, the route fails closed
 *     (aclRanges → configured, no ranges).
 *   • acl_people = 0 ("Geräte der Personen und Gruppen durchlassen" off):
 *     only the listed devices pass, exactly the behaviour before person
 *     groups — persons and groups do not count as listed, so an ACL route
 *     without devices has no peer matcher at all (historic). Migration 111
 *     sets 0 for existing routes with the ACL on and at least one person
 *     (legacyAclPeople), so the update does not widen their access; every
 *     other route, and every new one, has 1. acl_people only touches the
 *     Caddy source-IP layer: who may see / open an entry (client API, portal
 *     visibility, route login, RDP, "Was sieht <Name>?") is decided by
 *     persons and groups either way.
 *
 * API
 *   NOBODY
 *   parseIdList(json) → number[]                       (never null)
 *   isRestricted(persons, groups) → boolean
 *   allows({ persons, groups }, userId, userGroups) → boolean   pure
 *   userGroupSet(userId) → Set<groupId>  groups whose effective member the
 *       account is (incl. ancestors); empty for a disabled/unknown account
 *   routeGroupMap() → Map<routeId, number[]>   routeGroupIds(routeId) → number[]
 *   setRouteGroups(routeId, ids)
 *   canSeeRoute(route, userId, { userGroups, routeGroups }) → boolean
 *   effectiveUsers({ persons, groups }) → Set<userId> (enabled accounts only)
 *   devicesOfUsers(userIds) → [{ peerId, name, allowedIps, userId }]
 *   aclPeopleOn(route) → boolean   acl_people of the row (read from the
 *       database when the object lacks it; unknown route → true)
 *   legacyAclPeople({ acl_enabled, user_ids }) → 0 | 1   value for a route
 *       that predates acl_people (migration 111, restore of an old backup)
 *   aclPeers(route) → [{ peerId, name, allowedIps, userId|null, via }]
 *   aclRanges(route) → { configured, ranges }   for caddyConfig
 *   validateGroupIds(input, { current }) / validateUserIds(input)
 *       → number[]; throws err.code GROUPS_INVALID | GROUP_NOT_FOUND |
 *         GROUP_ARCHIVED | USERS_INVALID
 *   preview({ userIds, groupIds, peerIds, aclPeople }) → { count, people,
 *       devices, groups, personDevices, aclPeople }
 *   aclDependsOnPeople() → boolean  (a route with acl_enabled and acl_people
 *       has persons/groups)
 *   createReloader({ reload, intervalMs, now, setTimer, clearTimer })
 *   startCaddySync() / stopCaddySync()  — rebuild Caddy (≤ 1× per 5 s) when
 *       memberships, devices or accounts change.
 */

const logger = require('../utils/logger');

// Resolved per call: callers (caddyConfig via caddyAcl) may be reloaded with a
// fresh connection module, this module must follow.
function getDb() { return require('../db/connection').getDb(); }

const NOBODY = 0;
const MAX_IDS = 500;
const RELOAD_INTERVAL_MS = 5000;

function codedError(code, message, extra) {
  const err = new Error(message || code);
  err.code = code;
  if (extra) Object.assign(err, extra);
  return err;
}

function toId(v) {
  const n = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** JSON id list → numbers (0 = NOBODY stays); malformed/empty → []. */
function parseIdList(json) {
  if (json == null || json === '') return [];
  let v = json;
  if (typeof json === 'string') {
    try { v = JSON.parse(json); } catch { return []; }
  }
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const x of v) {
    const n = typeof x === 'string' && /^\d+$/.test(x) ? Number(x) : x;
    if (Number.isSafeInteger(n) && n >= 0 && !out.includes(n)) out.push(n);
  }
  return out;
}

function isRestricted(persons, groups) {
  return (persons && persons.length > 0) || (groups && groups.length > 0);
}

/**
 * Pure check: may `userId` reach an entry with these persons/groups?
 * userGroups: Set (or array) of the groups the account effectively belongs
 * to (userGroupSet) — only needed when the entry lists groups.
 */
function allows({ persons = [], groups = [] } = {}, userId, userGroups) {
  if (!isRestricted(persons, groups)) return true;
  const uid = toId(userId);
  if (!uid) return false;
  if (persons.includes(uid)) return true;
  if (!groups.length || !userGroups) return false;
  const set = userGroups instanceof Set ? userGroups : new Set(userGroups);
  return groups.some((g) => set.has(g));
}

/** Groups the account is an effective member of (direct + ancestors, live ones). */
function userGroupSet(userId) {
  const uid = toId(userId);
  if (!uid) return new Set();
  const db = getDb();
  const u = db.prepare('SELECT enabled FROM users WHERE id = ?').get(uid);
  if (!u || u.enabled !== 1) return new Set();
  const groups = require('./groups');
  return new Set(groups.groupsOfUser(uid, { includeInherited: true }).map((g) => g.id));
}

// ─── HTTP routes: route_group_acl ─────────────────────────────────────────

function routeGroupMap() {
  const map = new Map();
  for (const r of getDb().prepare('SELECT route_id, group_id FROM route_group_acl ORDER BY group_id').all()) {
    if (!map.has(r.route_id)) map.set(r.route_id, []);
    map.get(r.route_id).push(r.group_id);
  }
  return map;
}

function routeGroupIds(routeId) {
  const rid = toId(routeId);
  if (!rid) return [];
  return getDb().prepare('SELECT group_id FROM route_group_acl WHERE route_id = ? ORDER BY group_id').all(rid).map((r) => r.group_id);
}

function setRouteGroups(routeId, ids) {
  const db = getDb();
  const rid = toId(routeId);
  if (!rid) return;
  const list = [...new Set((ids || []).map(toId).filter(Boolean))];
  db.transaction(() => {
    db.prepare('DELETE FROM route_group_acl WHERE route_id = ?').run(rid);
    const ins = db.prepare('INSERT OR IGNORE INTO route_group_acl (route_id, group_id) VALUES (?, ?)');
    for (const g of list) ins.run(rid, g);
  })();
}

/**
 * Visibility of one HTTP route row for an account. ctx.routeGroups (a
 * routeGroupMap) and ctx.userGroups (userGroupSet) avoid one query per row.
 */
function canSeeRoute(route, userId, ctx = {}) {
  if (!route) return false;
  const persons = parseIdList(route.user_ids);
  const groups = ctx.routeGroups ? (ctx.routeGroups.get(route.id) || []) : routeGroupIds(route.id);
  if (!isRestricted(persons, groups)) return true;
  const userGroups = groups.length ? (ctx.userGroups || userGroupSet(userId)) : null;
  return allows({ persons, groups }, userId, userGroups);
}

// ─── people and devices ───────────────────────────────────────────────────

/** Enabled accounts reached by persons ∪ effective group members. */
function effectiveUsers({ persons = [], groups = [] } = {}) {
  const out = new Set();
  const ids = persons.map(toId).filter(Boolean);
  if (ids.length) {
    const ph = ids.map(() => '?').join(',');
    for (const r of getDb().prepare(`SELECT id FROM users WHERE enabled = 1 AND id IN (${ph})`).all(...ids)) out.add(r.id);
  }
  if (groups.length) {
    for (const u of require('./groups').effectiveUserIds(groups)) out.add(u);
  }
  return out;
}

/** Devices of these accounts: peers they own + peers bound to their tokens (no gateways). */
function devicesOfUsers(userIds) {
  const ids = [...new Set([...(userIds || [])].map(toId).filter(Boolean))];
  if (!ids.length) return [];
  const db = getDb();
  const ph = ids.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT p.id, p.name, p.allowed_ips, p.user_id AS owner FROM peers p
      WHERE p.user_id IN (${ph}) AND (p.peer_type IS NULL OR p.peer_type = 'regular')
    UNION
    SELECT p.id, p.name, p.allowed_ips, t.user_id AS owner FROM api_tokens t JOIN peers p ON p.id = t.peer_id
      WHERE t.user_id IN (${ph}) AND (p.peer_type IS NULL OR p.peer_type = 'regular')
  `).all(...ids, ...ids);
  const seen = new Map();
  for (const r of rows) {
    if (seen.has(r.id)) continue;
    seen.set(r.id, { peerId: r.id, name: r.name, allowedIps: r.allowed_ips, userId: r.owner });
  }
  return [...seen.values()].sort((a, b) => a.peerId - b.peerId);
}

function flagOn(v) {
  if (v === true) return true;
  if (v === false || v == null || v === '' || v === '0' || v === 'false') return false;
  return Number(v) !== 0;
}

/**
 * Value of acl_people for a route that predates the column (migration 111,
 * restore of a backup without it): ACL on AND at least one person → 0 (only
 * the listed devices pass, as before); everything else → 1.
 */
function legacyAclPeople(row) {
  const r = row || {};
  return flagOn(r.acl_enabled) && parseIdList(r.user_ids).length > 0 ? 0 : 1;
}

/**
 * Do the devices of the route's persons and group members pass its peer ACL?
 * The row's own acl_people when present; otherwise the stored value (a
 * caller may hand a partial object); a route the database does not know → 1.
 */
function aclPeopleOn(route) {
  if (!route) return true;
  if (route.acl_people !== undefined && route.acl_people !== null) return flagOn(route.acl_people);
  const rid = toId(route.id);
  if (!rid) return true;
  try {
    const row = getDb().prepare('SELECT acl_people FROM routes WHERE id = ?').get(rid);
    return row ? flagOn(row.acl_people) : true;
  } catch { return true; } // column not there yet (before migration 111)
}

/**
 * Every peer that may reach an acl_enabled route: the listed devices ∪ —
 * with acl_people — the devices of its persons and group members.
 */
function aclPeers(route) {
  if (!route || route.id == null) return [];
  const db = getDb();
  const out = new Map();
  for (const p of db.prepare(`SELECT p.id, p.name, p.allowed_ips, p.user_id FROM route_peer_acl a
      JOIN peers p ON p.id = a.peer_id WHERE a.route_id = ? ORDER BY p.id`).all(route.id)) {
    out.set(p.id, { peerId: p.id, name: p.name, allowedIps: p.allowed_ips, userId: p.user_id || null, via: 'device' });
  }
  if (!aclPeopleOn(route)) return [...out.values()];
  const persons = parseIdList(route.user_ids);
  const groups = routeGroupIds(route.id);
  if (isRestricted(persons, groups)) {
    for (const d of devicesOfUsers(effectiveUsers({ persons, groups }))) {
      if (!out.has(d.peerId)) out.set(d.peerId, { ...d, via: 'person' });
    }
  }
  return [...out.values()];
}

function ipOf(allowedIps) {
  const ip = String(allowedIps || '').split(',')[0].split('/')[0].trim();
  return ip || null;
}

/**
 * Source ranges of an acl_enabled route. configured = something is listed
 * (devices; with acl_people also persons or groups); a configured route with
 * no ranges must fail closed (caddyConfig), an unconfigured one keeps the
 * historic behaviour (no peer matcher).
 */
function aclRanges(route) {
  const db = getDb();
  const explicit = route && route.id != null
    ? db.prepare('SELECT COUNT(*) AS c FROM route_peer_acl WHERE route_id = ?').get(route.id).c : 0;
  const configured = explicit > 0 || (aclPeopleOn(route)
    && isRestricted(parseIdList(route && route.user_ids), routeGroupIds(route && route.id)));
  const ranges = [...new Set(aclPeers(route).map((p) => ipOf(p.allowedIps)).filter(Boolean).map((ip) => `${ip}/32`))];
  return { configured, ranges };
}

// ─── validation (admin API) ───────────────────────────────────────────────

function normalizeInput(input, code) {
  if (input == null || input === '') return [];
  if (!Array.isArray(input) || input.length > MAX_IDS) throw codedError(code, 'must be an array of ids');
  const out = [];
  for (const v of input) {
    const n = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v;
    if (!Number.isSafeInteger(n) || n < 0) throw codedError(code, 'must be an array of ids');
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

/**
 * Group ids for an entry: new ones must exist and not be archived; ids the
 * entry already carries (`current`) are kept as they are (an archived group
 * keeps the entry closed until the admin removes it).
 */
function validateGroupIds(input, { current = [] } = {}) {
  const ids = normalizeInput(input, 'GROUPS_INVALID');
  const db = getDb();
  const q = db.prepare('SELECT id, archived_at FROM groups WHERE id = ?');
  for (const id of ids) {
    if (current.includes(id)) continue;
    const row = id > 0 ? q.get(id) : null;
    if (!row) throw codedError('GROUP_NOT_FOUND', `group ${id} not found`, { id });
    if (row.archived_at) throw codedError('GROUP_ARCHIVED', `group ${id} is archived`, { id });
  }
  return ids;
}

/**
 * Person ids: an array of ids (shape only, as before — an id of a deleted
 * account keeps the entry closed, see the rules above).
 */
function validateUserIds(input) {
  return normalizeInput(input, 'USERS_INVALID');
}

// ─── preview "Darf zugreifen" ─────────────────────────────────────────────

/**
 * Who would get access with this selection — for the admin dialog.
 *   → { count (enabled people), people: [{ userId, name, username, disabled,
 *       disabledReason, reasons: [{ type: 'person' } | { type: 'group',
 *       groupId, path, role, direct, viaPath } | { type: 'device', peerId,
 *       name, via: 'device' }], ownDevices, visibleOnly }],
 *       devices: [{ peerId, name, ip, userId, owner }],
 *       groups: [{ id, path, archived, missing, kind }], unknownUserIds,
 *       aclPeople, personDevices: [{ peerId, name, ip, userId, owner }] }
 * Devices without an owner appear in `devices` only.
 *
 * aclPeople (HTTP routes with the device ACL, routes.acl_people): true → the
 * devices of the enabled persons reached through a person or group reason
 * pass the ACL too: listed in personDevices (without the listed devices),
 * per person ownDevices = how many of them. false → they do not pass;
 * visibleOnly marks a person who sees the entry but has no listed device.
 * Omitted (RDP) → neither is computed (ownDevices 0, visibleOnly false).
 */
function preview({ userIds = [], groupIds = [], peerIds = [], aclPeople } = {}) {
  const db = getDb();
  const groupsSvc = require('./groups');
  const persons = normalizeInput(userIds, 'USERS_INVALID');
  const gids = normalizeInput(groupIds, 'GROUPS_INVALID');
  const pids = normalizeInput(peerIds, 'PEERS_INVALID');
  const people = new Map();
  const userQ = db.prepare('SELECT id, username, display_name, enabled, disabled_reason FROM users WHERE id = ?');
  const person = (uid) => {
    if (people.has(uid)) return people.get(uid);
    const u = userQ.get(uid);
    if (!u) return null;
    const p = {
      userId: u.id, name: u.display_name || u.username, username: u.username,
      disabled: u.enabled !== 1, disabledReason: u.enabled !== 1 ? (u.disabled_reason || 'admin') : null, reasons: [],
    };
    people.set(uid, p);
    return p;
  };
  const unknownUserIds = [];
  for (const uid of persons) {
    const p = uid > 0 ? person(uid) : null;
    if (!p) { unknownUserIds.push(uid); continue; }
    p.reasons.push({ type: 'person' });
  }
  const groupInfo = [];
  for (const gid of gids) {
    const g = gid > 0 ? groupsSvc.get(gid) : null;
    if (!g) { groupInfo.push({ id: gid, path: null, archived: false, missing: true, kind: null }); continue; }
    groupInfo.push({ id: g.id, path: g.path, archived: g.archived, missing: false, kind: g.kind });
    if (g.archived) continue;
    for (const m of groupsSvc.members(g.id, { nested: true })) {
      const p = person(m.userId);
      if (!p) continue;
      const via = m.direct ? null : (groupsSvc.get(m.groupId) || {}).path || null;
      p.reasons.push({ type: 'group', groupId: g.id, path: g.path, role: m.role, direct: m.direct, viaPath: via });
    }
  }
  const devices = [];
  if (pids.length) {
    const ph = pids.map(() => '?').join(',');
    for (const d of db.prepare(`SELECT id, name, allowed_ips, user_id FROM peers WHERE id IN (${ph}) ORDER BY name`).all(...pids)) {
      const owner = d.user_id ? person(d.user_id) : null;
      devices.push({ peerId: d.id, name: d.name, ip: ipOf(d.allowed_ips), userId: d.user_id || null, owner: owner ? owner.name : null });
      if (owner) owner.reasons.push({ type: 'device', peerId: d.id, name: d.name, via: 'device' });
    }
  }
  const peopleMode = aclPeople === undefined || aclPeople === null ? null : flagOn(aclPeople);
  const personDevices = [];
  const released = [];
  for (const p of people.values()) {
    p.ownDevices = 0;
    p.visibleOnly = false;
    if (p.disabled || !p.reasons.some((r) => r.type !== 'device')) continue;
    released.push(p);
    if (peopleMode === false) p.visibleOnly = !p.reasons.some((r) => r.type === 'device');
  }
  if (peopleMode === true && released.length) {
    for (const d of devicesOfUsers(released.map((p) => p.userId))) {
      const p = people.get(d.userId);
      if (p) p.ownDevices += 1;
      if (pids.includes(d.peerId)) continue;
      personDevices.push({ peerId: d.peerId, name: d.name, ip: ipOf(d.allowedIps), userId: d.userId, owner: p ? p.name : null });
    }
  }
  const list = [...people.values()].filter((p) => p.reasons.length)
    .sort((a, b) => (Number(a.disabled) - Number(b.disabled)) || a.name.localeCompare(b.name));
  return {
    count: list.filter((p) => !p.disabled).length, people: list, devices, groups: groupInfo, unknownUserIds,
    aclPeople: peopleMode, personDevices,
  };
}

// ─── Caddy reload on membership / device changes ──────────────────────────

/**
 * Is there an acl_enabled route whose source IPs depend on persons/groups?
 * Only routes with acl_people = 1 — with 0 only the listed devices count.
 */
function aclDependsOnPeople() {
  try {
    return !!getDb().prepare(`SELECT 1 FROM routes r WHERE r.acl_enabled = 1 AND r.acl_people = 1
      AND (EXISTS (SELECT 1 FROM route_group_acl a WHERE a.route_id = r.id)
           OR (r.user_ids IS NOT NULL AND r.user_ids NOT IN ('', '[]', 'null'))) LIMIT 1`).get();
  } catch { return false; }
}

/**
 * Throttled reload: the first request runs after at most `intervalMs` since
 * the previous reload (immediately-ish when none ran lately), requests
 * meanwhile join the pending one — at most one reload per interval.
 */
function createReloader({ reload, intervalMs = RELOAD_INTERVAL_MS, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let timer = null;
  let last = -Infinity;
  let runs = 0;
  function fire() {
    timer = null;
    last = now();
    runs += 1;
    try {
      const p = reload();
      if (p && typeof p.catch === 'function') p.catch((err) => logger.warn({ err: err && err.message }, 'group access: Caddy reload failed'));
    } catch (err) {
      logger.warn({ err: err && err.message }, 'group access: Caddy reload failed');
    }
  }
  return {
    request() {
      if (timer) return false;
      const wait = Math.max(0, last + intervalMs - now());
      timer = setTimer(fire, wait);
      if (timer && typeof timer.unref === 'function') timer.unref();
      return true;
    },
    pending() { return !!timer; },
    runs() { return runs; },
    cancel() { if (timer) { clearTimer(timer); timer = null; } },
  };
}

// Activity events after which the devices of a person may have changed
// (a new/removed device, a token bound to a peer, an account switched off).
const DEVICE_EVENTS = new Set([
  'peer_created', 'peer_deleted', 'peer_updated', 'peer_expired',
  'token_created', 'token_deleted', 'token_updated',
  'client_registered', 'client_enrollment_redeemed', 'device_usage_changed',
  'user_toggled', 'user_updated', 'user_deleted',
]);

let sync = null;

function startCaddySync({ reload, intervalMs } = {}) {
  if (sync) return sync.reloader;
  const reloader = createReloader({
    reload: reload || (() => require('./caddySync').requestCaddySync()),
    intervalMs,
  });
  const groups = require('./groups');
  const eventBus = require('./eventBus');
  const onGroups = () => { if (aclDependsOnPeople()) reloader.request(); };
  const onActivity = (evt) => { if (aclDependsOnPeople()) reloader.request(); return evt; };
  groups.events.on('change', onGroups);
  eventBus.subscribe(onActivity, (type, payload) => type === 'activity' && payload && DEVICE_EVENTS.has(payload.eventType));
  sync = { reloader, onGroups, onActivity };
  return reloader;
}

function stopCaddySync() {
  if (!sync) return;
  try { require('./groups').events.off('change', sync.onGroups); } catch { /* module gone */ }
  try { require('./eventBus').unsubscribe(sync.onActivity); } catch { /* module gone */ }
  sync.reloader.cancel();
  sync = null;
}

module.exports = {
  NOBODY, RELOAD_INTERVAL_MS, DEVICE_EVENTS,
  parseIdList, isRestricted, allows, userGroupSet,
  routeGroupMap, routeGroupIds, setRouteGroups, canSeeRoute,
  effectiveUsers, devicesOfUsers, aclPeopleOn, legacyAclPeople, aclPeers, aclRanges,
  validateGroupIds, validateUserIds,
  preview,
  aclDependsOnPeople, createReloader, startCaddySync, stopCaddySync,
};
