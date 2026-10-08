'use strict';

/**
 * "Was sieht <Name>?" — what one account reaches through GateControl, with
 * the reason for every entry (Users page tab, GET /api/v1/users/:id/visibility)
 * and the member's own view of it (GET /api/v1/me/services).
 *
 * The rules are the ones the client API applies — nothing is re-implemented:
 *   HTTP routes   routes.getForUser semantics: an entry with a non-empty
 *                 user_ids list is visible only to those users, an entry
 *                 without one to everybody (enabled HTTP entries only)
 *   RDP           rdpAcl.canAccessRoute: user_ids first, then the legacy
 *                 token_ids list, else everybody
 *   Portal        the owner tables of the integrations
 *   Pi-hole       per device token: the `pihole` scope after the role cap,
 *                 and the licence feature pihole_integration
 *
 * Never returns credentials: names, hosts and ports only.
 */

const { getDb } = require('../db/connection');
const { canAccessRoute } = require('./rdpAcl');

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

function httpEntries(userId, byId) {
  const db = getDb();
  const rows = db.prepare(`SELECT id, domain, label, user_ids FROM routes
    WHERE enabled = 1 AND (route_type = 'http' OR route_type IS NULL) ORDER BY domain`).all();
  const visible = [];
  let hidden = 0;
  for (const r of rows) {
    const ids = parseIds(r.user_ids);
    const name = (r.label && String(r.label).trim()) || r.domain;
    if (!ids) {
      visible.push({ id: r.id, name, host: r.domain, reason: 'all', names: [] });
    } else if (ids.includes(userId)) {
      visible.push({ id: r.id, name, host: r.domain, reason: 'picked', names: namesFor(ids, byId) });
    } else {
      hidden += 1;
    }
  }
  return { visible, hidden, total: rows.length };
}

function rdpEntries(userId, tokenIds, byId) {
  const db = getDb();
  let rows;
  try {
    rows = db.prepare('SELECT id, name, host, port, user_ids, token_ids FROM rdp_routes WHERE enabled = 1 ORDER BY name').all();
  } catch { rows = []; }
  const visible = [];
  let hidden = 0;
  for (const r of rows) {
    const userIds = parseIds(r.user_ids);
    const legacy = !userIds ? parseIds(r.token_ids) : null;
    // Same check as the client API: a device sees the entry when the user
    // (or, legacy, one of the user's tokens) is on its list.
    const reach = userIds
      ? canAccessRoute(r, null, userId)
      : (legacy ? tokenIds.some((tid) => canAccessRoute(r, tid, userId)) : true);
    const host = r.host + (r.port ? ':' + r.port : '');
    if (!reach) { hidden += 1; continue; }
    if (userIds) visible.push({ id: r.id, name: r.name, host, reason: 'picked', names: namesFor(userIds, byId) });
    else if (legacy) visible.push({ id: r.id, name: r.name, host, reason: 'token', names: [] });
    else visible.push({ id: r.id, name: r.name, host, reason: 'all', names: [] });
  }
  return { visible, hidden, total: rows.length };
}

function portalEntries(userId) {
  const db = getDb();
  const out = [];
  const add = (sql, kind) => {
    try { for (const r of db.prepare(sql).all(userId)) out.push({ kind, id: r.id, name: r.name || '' }); } catch { /* integration table missing */ }
  };
  add(`SELECT d.id, d.name FROM midea_device_owners o JOIN midea_devices d ON d.id = o.midea_device_id
    WHERE o.user_id = ? ORDER BY d.name`, 'midea');
  // the built-in Smart Home is off while the gatecontrol-smarthome plugin replaces it
  let smarthomeReplaced = false;
  try { smarthomeReplaced = require('./plugins/legacy').replaced('smarthome'); } catch { smarthomeReplaced = false; }
  if (!smarthomeReplaced) {
    add(`SELECT r.id, COALESCE(r.name, r.deconz_id) AS name FROM smarthome_resource_owners o JOIN smarthome_resources r ON r.id = o.resource_id
      WHERE o.user_id = ? ORDER BY r.name`, 'smarthome');
  }
  // the built-in Fahrzeuge are off while the gatecontrol-skoda plugin replaces them
  let skodaReplaced = false;
  try { skodaReplaced = require('./plugins/legacy').replaced('skoda'); } catch { skodaReplaced = false; }
  if (!skodaReplaced) {
    add(`SELECT v.id, COALESCE(v.name, v.model, v.vin) AS name FROM skoda_vehicle_owners o JOIN skoda_vehicles v ON v.id = o.skoda_vehicle_id
      WHERE o.user_id = ? ORDER BY v.name`, 'skoda');
  }
  return out;
}

/**
 * Full picture for the admin tab.
 * Returns { user, role, web, services, rdp, portal, pihole } — `web` is
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
    services: httpEntries(userId, byId),
    rdp: rdpEntries(userId, tokenIds, byId),
    portal: portalEntries(userId),
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
  const http = httpEntries(userId, byId).visible.map((e) => ({ kind: 'http', name: e.name, host: e.host, url: 'https://' + e.host }));
  const rdp = rdpEntries(userId, tokenIds, byId).visible.map((e) => ({ kind: 'rdp', name: e.name, host: e.host }));
  return http.concat(rdp);
}

module.exports = { forUser, servicesForSelf, isDeviceToken, firstName, displayName };
