'use strict';

/**
 * "Was sieht <Name>?" — what one account reaches through GateControl, with
 * the reason for every entry (Users page tab, GET /api/v1/users/:id/visibility)
 * and the member's own view of it (GET /api/v1/me/services).
 *
 * The rules are the ones the client API applies — nothing is re-implemented:
 *   HTTP routes   routes.getForUser semantics (groupAccess.canSeeRoute): an
 *                 entry restricted to persons and/or groups is visible only
 *                 to those persons and the effective group members, an entry
 *                 without either to everybody (enabled HTTP entries only)
 *   RDP           rdpAcl.canAccessRoute: user_ids / group_ids first, then the
 *                 legacy token_ids list, else everybody
 *   Reasons       'all' | 'picked' (named person, names) | 'group' (member
 *                 of a released group, groups: paths) | 'token'
 *   Pi-hole       per device token: the `pihole` scope after the role cap,
 *                 and the licence feature pihole_integration
 *
 * Never returns credentials: names, hosts and ports only.
 */

const { getDb } = require('../db/connection');
const { canAccessRoute } = require('./rdpAcl');
const groupAccess = require('./groupAccess');

function parseIds(json) {
  if (!json) return null;
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) && v.length ? v : null;
  } catch { return null; }
}

function displayName(u) {
  return (u && (u.display_name || u.username)) || '';
}

function firstName(u) {
  return displayName(u).split(/\s+/)[0] || '';
}

function namesFor(ids, byId) {
  return ids.map((id) => byId.get(id)).filter(Boolean).map(firstName);
}

/** Tokens of the user that count as a device (bound to a peer or enrolled). */
function isDeviceToken(t) {
  return t.peer_id != null || t.enrolled === 1;
}

// Paths of the listed groups the account belongs to (for the reason).
function groupPaths(listed, userGroups, ctx) {
  const ids = listed.filter((g) => userGroups.has(g));
  if (!ids.length) return [];
  if (!ctx.paths) {
    ctx.paths = new Map();
    try { for (const g of require('./groups').list({ includeArchived: true })) ctx.paths.set(g.id, g.path); } catch { /* no groups */ }
  }
  return ids.map((g) => ctx.paths.get(g)).filter(Boolean);
}

function httpEntries(userId, byId, ctx = {}) {
  const db = getDb();
  const rows = db.prepare(`SELECT id, domain, label, user_ids FROM routes
    WHERE enabled = 1 AND (route_type = 'http' OR route_type IS NULL) ORDER BY domain`).all();
  const routeGroups = groupAccess.routeGroupMap();
  const userGroups = ctx.userGroups || groupAccess.userGroupSet(userId);
  const visible = [];
  let hidden = 0;
  for (const r of rows) {
    const ids = parseIds(r.user_ids);
    const groups = routeGroups.get(r.id) || [];
    const name = (r.label && String(r.label).trim()) || r.domain;
    if (!ids && !groups.length) {
      visible.push({ id: r.id, name, host: r.domain, reason: 'all', names: [] });
    } else if (ids && ids.includes(userId)) {
      visible.push({ id: r.id, name, host: r.domain, reason: 'picked', names: namesFor(ids, byId) });
    } else if (groups.some((g) => userGroups.has(g))) {
      visible.push({ id: r.id, name, host: r.domain, reason: 'group', names: [], groups: groupPaths(groups, userGroups, ctx) });
    } else {
      hidden += 1;
    }
  }
  return { visible, hidden, total: rows.length };
}

function rdpEntries(userId, tokenIds, byId, ctx = {}) {
  const db = getDb();
  let rows;
  try {
    rows = db.prepare('SELECT id, name, host, port, user_ids, group_ids, token_ids FROM rdp_routes WHERE enabled = 1 ORDER BY name').all();
  } catch { rows = []; }
  const userGroups = ctx.userGroups || groupAccess.userGroupSet(userId);
  const visible = [];
  let hidden = 0;
  for (const r of rows) {
    const userIds = parseIds(r.user_ids);
    const groups = groupAccess.parseIdList(r.group_ids);
    const personal = !!userIds || groups.length > 0;
    const legacy = !personal ? parseIds(r.token_ids) : null;
    // Same check as the client API: a device sees the entry when the user
    // (directly or through a group, or, legacy, one of the user's tokens) is
    // on its list.
    const reach = personal
      ? canAccessRoute(r, null, userId, { userGroups })
      : (legacy ? tokenIds.some((tid) => canAccessRoute(r, tid, userId)) : true);
    const host = r.host + (r.port ? ':' + r.port : '');
    if (!reach) { hidden += 1; continue; }
    if (userIds && userIds.includes(userId)) visible.push({ id: r.id, name: r.name, host, reason: 'picked', names: namesFor(userIds, byId) });
    else if (personal) visible.push({ id: r.id, name: r.name, host, reason: 'group', names: [], groups: groupPaths(groups, userGroups, ctx) });
    else if (legacy) visible.push({ id: r.id, name: r.name, host, reason: 'token', names: [] });
    else visible.push({ id: r.id, name: r.name, host, reason: 'all', names: [] });
  }
  return { visible, hidden, total: rows.length };
}

/**
 * Full picture for the admin tab.
 * Returns { user, role, web, services, rdp, pihole } — `web` is
 * 'all' (admin), 'self_service' (member with "Mein Bereich") or 'none'.
 */
function forUser(userId) {
  const db = getDb();
  const users = require('./users');
  const license = require('./license');
  const user = users.getById(userId);
  if (!user) return null;
  const all = db.prepare('SELECT id, username, display_name FROM users').all();
  const byId = new Map(all.map((u) => [u.id, u]));
  const tokens = db.prepare('SELECT id, name, scopes, peer_id, enrolled FROM api_tokens WHERE user_id = ? ORDER BY name').all(userId);
  const tokenIds = tokens.map((t) => t.id);
  const ctx = { userGroups: groupAccess.userGroupSet(userId) };

  const piholeLicensed = !!license.hasFeature('pihole_integration');
  const devices = tokens.filter(isDeviceToken).map((t) => {
    let scopes = [];
    try { scopes = JSON.parse(t.scopes) || []; } catch { scopes = []; }
    const effective = users.filterScopesForRole(scopes, user.role);
    return { tokenId: t.id, name: t.name, on: effective.includes('pihole') || effective.includes('full-access') };
  });

  let web = 'none';
  if (user.role === 'admin') web = 'all';
  else if (user.self_service_enabled === 1) web = 'self_service';

  return {
    user: { id: user.id, username: user.username, display_name: user.display_name, role: user.role },
    role: user.role,
    web,
    services: httpEntries(userId, byId, ctx),
    rdp: rdpEntries(userId, tokenIds, byId, ctx),
    pihole: { licensed: piholeLicensed, devices },
  };
}

/**
 * The member's own view (/me): HTTP services and RDP entries, names and
 * hosts only — no reasons naming other users, no counts of hidden entries.
 */
function servicesForSelf(userId) {
  const db = getDb();
  const tokenIds = db.prepare('SELECT id FROM api_tokens WHERE user_id = ?').all(userId).map((t) => t.id);
  const byId = new Map();
  const ctx = { userGroups: groupAccess.userGroupSet(userId) };
  const http = httpEntries(userId, byId, ctx).visible.map((e) => ({ kind: 'http', name: e.name, host: e.host, url: 'https://' + e.host }));
  const rdp = rdpEntries(userId, tokenIds, byId, ctx).visible.map((e) => ({ kind: 'rdp', name: e.name, host: e.host }));
  return http.concat(rdp);
}

module.exports = { forUser, servicesForSelf, isDeviceToken, firstName, displayName };
