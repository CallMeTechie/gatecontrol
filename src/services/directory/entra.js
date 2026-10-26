'use strict';

/**
 * Microsoft Entra ID adapter (Microsoft Graph, the customer's app
 * registration).
 *
 * config: { tenantId (GUID), clientId (GUID) } + the client secret (secret).
 * Application permissions (admin consent): User.Read.All and
 * GroupMember.Read.All.
 *
 *   • Token: client-credentials flow against
 *     https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token, scope
 *     https://graph.microsoft.com/.default; cached until shortly before it
 *     expires.
 *   • Stable ids: the Entra object id of users and groups.
 *   • Members: /groups/<id>/transitiveMembers/microsoft.graph.user — nested
 *     groups are resolved by Graph; only user objects count.
 *   • Disabled: accountEnabled === false.
 *   • Delta (fetchDelta, sync.js "Delta"): Graph delta queries. A full read
 *     first takes the current deltaLinks of /users/delta and /groups/delta
 *     ($deltatoken=latest — no enumeration of the tenant) and remembers the
 *     nested groups of every selected group; a delta run follows both links
 *     (paging via @odata.nextLink up to the new @odata.deltaLink):
 *       users   changed properties of known members (partial objects: only
 *               what is present is taken over; accountEnabled false =
 *               disabled at once), `@removed` = deleted → out of every group
 *       groups  only selected / nested groups count: `@removed` = deleted
 *               (a selected group is then "not found", a nested one makes
 *               its selected group be read again); members@delta of a flat
 *               selected group are applied as added / removed users (a new
 *               person's profile is read with /users/<id>); a change of a
 *               nested group or a group added as member → that selected
 *               group's transitive members are read again.
 *     410 Gone or a resync / sync-state error → FULL_SYNC_REQUIRED (the
 *     engine reads everything in the same run and takes new deltaLinks).
 *
 * Every URL is built from constants plus the validated GUIDs — no host
 * comes from configuration.
 */

const logger = require('../../utils/logger');

const GRAPH = 'https://graph.microsoft.com/v1.0';
const LOGIN = 'https://login.microsoftonline.com';
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIMEOUT_MS = 20000;
const MAX_PAGES = 500;
const USER_SELECT = 'id,displayName,mail,userPrincipalName,accountEnabled';

let fetchImpl = (...args) => globalThis.fetch(...args);
/** Tests replace fetch (Graph, token endpoint, OIDC discovery and JWKS). */
function _setFetch(fn) { fetchImpl = fn || ((...args) => globalThis.fetch(...args)); }
function getFetch() { return fetchImpl; }

const tokenCache = new Map(); // `${tenant}|${client}` → { token, exp }

function codedError(code, message, extra) {
  const err = new Error(message || code);
  err.code = code;
  if (extra) Object.assign(err, extra);
  return err;
}

function checkConfig(cfg) {
  const tenantId = String((cfg && cfg.tenantId) || '').trim().toLowerCase();
  const clientId = String((cfg && cfg.clientId) || '').trim().toLowerCase();
  if (!GUID_RE.test(tenantId)) throw codedError('INVALID_TENANT', 'tenant id must be the directory (tenant) id GUID');
  if (!GUID_RE.test(clientId)) throw codedError('INVALID_CLIENT', 'client id must be the application (client) id GUID');
  return { tenantId, clientId };
}

async function timedFetch(url, init = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  if (typeof t.unref === 'function') t.unref();
  try {
    return await fetchImpl(url, { ...init, signal: ctrl.signal, redirect: 'error' });
  } catch (err) {
    throw codedError('UNREACHABLE', `request failed: ${err.message}`);
  } finally {
    clearTimeout(t);
  }
}

async function getToken(cfg, secret) {
  const { tenantId, clientId } = checkConfig(cfg);
  if (!secret) throw codedError('NO_CREDENTIALS', 'client secret is required');
  const key = `${tenantId}|${clientId}`;
  const hit = tokenCache.get(key);
  if (hit && hit.secret === secret && hit.exp > Date.now() + 60000) return hit.token;
  const body = new URLSearchParams({
    client_id: clientId, client_secret: secret, grant_type: 'client_credentials', scope: 'https://graph.microsoft.com/.default',
  });
  const res = await timedFetch(`${LOGIN}/${tenantId}/oauth2/v2.0/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: body.toString(),
  });
  let json = {};
  try { json = await res.json(); } catch { json = {}; }
  if (!res.ok || !json.access_token) {
    throw codedError('AUTH_FAILED', `token request refused (${res.status}${json.error ? `: ${json.error}` : ''})`, { status: res.status });
  }
  tokenCache.set(key, { token: json.access_token, secret, exp: Date.now() + (Number(json.expires_in) || 3600) * 1000 });
  return json.access_token;
}

function fullSyncRequired(reason, message) {
  return codedError('FULL_SYNC_REQUIRED', message || `full sync required (${reason})`, { reason });
}

async function graphGet(cfg, secret, pathOrUrl, { eventual = false } = {}) {
  const token = await getToken(cfg, secret);
  const url = pathOrUrl.startsWith(GRAPH + '/') ? pathOrUrl : GRAPH + pathOrUrl;
  const headers = { authorization: `Bearer ${token}`, accept: 'application/json' };
  if (eventual) headers.ConsistencyLevel = 'eventual';
  const res = await timedFetch(url, { headers });
  if (res.status === 404) return null;
  let json = {};
  try { json = await res.json(); } catch { json = {}; }
  if (!res.ok) {
    const msg = json && json.error && json.error.code ? json.error.code : String(res.status);
    throw codedError(res.status === 401 || res.status === 403 ? 'AUTH_FAILED' : 'GRAPH_ERROR', `Graph request failed (${msg})`, {
      status: res.status, graphCode: json && json.error && json.error.code ? String(json.error.code) : null,
    });
  }
  return json;
}

/** Every page of a Graph collection (follows @odata.nextLink on graph.microsoft.com only). */
async function graphAll(cfg, secret, path, opts) {
  const out = [];
  let next = path;
  for (let i = 0; next && i < MAX_PAGES; i++) {
    const page = await graphGet(cfg, secret, next, opts);
    if (!page) return null;
    for (const v of page.value || []) out.push(v);
    const link = page['@odata.nextLink'];
    next = typeof link === 'string' && link.startsWith(GRAPH + '/') ? link : null;
  }
  return out;
}

const RESYNC_RE = /resync|syncstate|deltatoken|token.*(expired|invalid)/i;

/**
 * Every page of a delta round from `link` up to the deltaLink →
 * { items, deltaLink }. 410 Gone / an invalid delta token → FULL_SYNC_REQUIRED.
 */
async function deltaRound(cfg, secret, link) {
  const items = [];
  let next = link;
  for (let i = 0; i < MAX_PAGES; i++) {
    if (typeof next !== 'string' || !next.startsWith(GRAPH + '/')) throw fullSyncRequired('resync', 'no valid delta link');
    let page;
    try {
      page = await graphGet(cfg, secret, next);
    } catch (err) {
      if (err.status === 410 || (err.status === 400 && RESYNC_RE.test(err.graphCode || ''))) throw fullSyncRequired('resync', `Graph asks for a full sync (${err.graphCode || err.status})`);
      throw err;
    }
    if (!page) throw fullSyncRequired('resync', 'delta link not found');
    for (const v of page.value || []) items.push(v);
    if (typeof page['@odata.deltaLink'] === 'string' && page['@odata.deltaLink'].startsWith(GRAPH + '/')) return { items, deltaLink: page['@odata.deltaLink'] };
    next = page['@odata.nextLink'];
  }
  throw fullSyncRequired('too_many_changes');
}

/** Only the properties a delta object carries (Graph sends partial objects). */
function partialUser(o) {
  const out = { externalId: String(o.id || '').toLowerCase() };
  if (Object.prototype.hasOwnProperty.call(o, 'userPrincipalName')) { out.loginName = o.userPrincipalName || null; out.upn = o.userPrincipalName || null; }
  if (Object.prototype.hasOwnProperty.call(o, 'mail')) out.email = o.mail || null;
  if (Object.prototype.hasOwnProperty.call(o, 'displayName')) out.displayName = o.displayName || null;
  if (Object.prototype.hasOwnProperty.call(o, 'accountEnabled')) out.enabled = o.accountEnabled !== false;
  return out;
}

function userFrom(o) {
  const upn = o.userPrincipalName || null;
  return {
    externalId: String(o.id || '').toLowerCase(),
    loginName: upn,
    upn,
    dn: null,
    email: o.mail || null,
    displayName: o.displayName || null,
    enabled: o.accountEnabled !== false,
  };
}

function create(directory, { secret } = {}) {
  const cfg = directory.config || {};
  /** The current deltaLinks without enumerating the tenant ($deltatoken=latest). */
  async function latestLinks() {
    const users = await deltaRound(cfg, secret, `${GRAPH}/users/delta?$select=${USER_SELECT}&$deltatoken=latest`);
    const groups = await deltaRound(cfg, secret, `${GRAPH}/groups/delta?$select=displayName,members&$deltatoken=latest`);
    return { users: users.deltaLink, groups: groups.deltaLink };
  }

  /**
   * One selected group with its transitive user members (into `users`);
   * with `nested` also the ids of its nested groups (delta tracking).
   */
  async function readGroup(sel, users, nested) {
    const id = String(sel.externalId || '').toLowerCase();
    if (!GUID_RE.test(id)) return { externalId: sel.externalId, name: sel.name, found: false, members: [] };
    const g = await graphGet(cfg, secret, `/groups/${id}?$select=id,displayName`);
    if (!g) {
      if (nested) delete nested[id];
      return { externalId: id, name: sel.name, found: false, members: [] };
    }
    // OData cast to users (an advanced query: ConsistencyLevel eventual + $count).
    const list = await graphAll(cfg, secret, `/groups/${id}/transitiveMembers/microsoft.graph.user?$select=${USER_SELECT}&$top=999&$count=true`, { eventual: true });
    const members = [];
    for (const o of list || []) {
      if (o['@odata.type'] && o['@odata.type'] !== '#microsoft.graph.user') continue;
      const p = userFrom(o);
      if (!GUID_RE.test(p.externalId)) continue;
      users.set(p.externalId, p);
      members.push(p.externalId);
    }
    if (nested) {
      const subs = await graphAll(cfg, secret, `/groups/${id}/transitiveMembers/microsoft.graph.group?$select=id&$top=999&$count=true`, { eventual: true });
      nested[id] = (subs || []).map((x) => String(x.id || '').toLowerCase()).filter((x) => GUID_RE.test(x));
    }
    return { externalId: id, name: g.displayName || sel.name, dn: null, found: true, members };
  }

  return {
    kind: 'entra',

    async test() {
      const { tenantId } = checkConfig(cfg);
      const res = await graphGet(cfg, secret, '/groups?$top=1&$select=id');
      return { ok: true, details: { tenantId, sampleGroups: res && Array.isArray(res.value) ? res.value.length : 0 } };
    },

    async searchGroups(query, { limit = 50 } = {}) {
      const q = String(query || '').trim().slice(0, 100).replace(/["\\]/g, '');
      const top = Math.max(1, Math.min(limit, 100));
      const path = q
        ? `/groups?$search=${encodeURIComponent(`"displayName:${q}"`)}&$select=id,displayName,description&$top=${top}`
        : `/groups?$select=id,displayName,description&$top=${top}`;
      const res = await graphGet(cfg, secret, path, { eventual: true });
      return ((res && res.value) || []).map((g) => ({
        externalId: String(g.id).toLowerCase(), name: g.displayName || '', dn: null, description: g.description || null,
      })).filter((g) => g.externalId && g.name).sort((a, b) => a.name.localeCompare(b.name));
    },

    async fetch(selected, { cursor = false } = {}) {
      // The deltaLinks first: whatever changes during the read comes again.
      // Without them the full read still works (every run stays full).
      let position = null;
      if (cursor) {
        try { position = await latestLinks(); } catch (err) {
          if (err.code === 'AUTH_FAILED' || err.code === 'UNREACHABLE' || err.code === 'NO_CREDENTIALS') throw err;
          logger.warn({ directoryId: directory.id, err: err.message }, 'entra: no delta links, every sync stays full');
        }
      }
      const users = new Map();
      const groups = [];
      const nested = {};
      for (const sel of selected || []) {
        const g = await readGroup(sel, users, cursor ? nested : null);
        groups.push(g);
      }
      const out = { groups, users: [...users.values()] };
      if (position) out.cursor = { ...position, nested };
      return out;
    },

    async fetchDelta(selected, { cursor, snapshot } = {}) {
      if (!cursor || !cursor.users || !cursor.groups) throw fullSyncRequired('first');
      const userRound = await deltaRound(cfg, secret, cursor.users);
      const groupRound = await deltaRound(cfg, secret, cursor.groups);
      const snapUsers = new Set(((snapshot && snapshot.users) || []).map((p) => String(p.externalId)));
      const snapGroups = new Map(((snapshot && snapshot.groups) || []).map((g) => [String(g.externalId).toLowerCase(), g]));
      const nested = { ...(cursor.nested || {}) };
      // group id → the selected groups it belongs to (itself or as nested group)
      const owners = new Map();
      const own = (gid, sel) => { if (!owners.has(gid)) owners.set(gid, new Set()); owners.get(gid).add(sel); };
      const selIds = (selected || []).map((x) => String(x.externalId || '').toLowerCase());
      for (const sel of selIds) {
        own(sel, sel);
        for (const n of nested[sel] || []) own(String(n).toLowerCase(), sel);
      }

      const users = new Map();
      const removedUsers = new Set();
      for (const o of userRound.items) {
        const id = String(o.id || '').toLowerCase();
        if (!GUID_RE.test(id) || !snapUsers.has(id)) continue; // only people GateControl knows
        if (o['@removed']) { removedUsers.add(id); users.delete(id); continue; }
        users.set(id, partialUser(o));
      }

      const reread = new Set();
      const changes = new Map(); // selected id → { externalId, name?, found?, add, remove }
      const changeOf = (sel) => {
        if (!changes.has(sel)) changes.set(sel, { externalId: sel, add: [], remove: [] });
        return changes.get(sel);
      };
      for (const o of groupRound.items) {
        const gid = String(o.id || '').toLowerCase();
        const sels = owners.get(gid);
        if (!sels) continue;
        for (const sel of sels) {
          const isSel = sel === gid;
          if (o['@removed']) {
            if (isSel) { const c = changeOf(sel); c.found = false; reread.delete(sel); } else reread.add(sel);
            continue;
          }
          if (isSel && typeof o.displayName === 'string' && o.displayName) changeOf(sel).name = o.displayName;
          const md = Array.isArray(o['members@delta']) ? o['members@delta'] : [];
          if (!md.length) continue;
          if (!isSel || (nested[sel] || []).length || !snapGroups.has(sel) || !snapGroups.get(sel).found) { reread.add(sel); continue; }
          for (const m of md) {
            const type = m['@odata.type'];
            if (type === '#microsoft.graph.group') { reread.add(sel); break; }
            if (type && type !== '#microsoft.graph.user') continue; // devices, service principals
            const mid = String(m.id || '').toLowerCase();
            if (!GUID_RE.test(mid)) continue;
            if (m['@removed']) changeOf(sel).remove.push(mid); else changeOf(sel).add.push(mid);
          }
        }
      }

      const groups = [];
      for (const sel of selected || []) {
        const key = String(sel.externalId || '').toLowerCase();
        const c = changes.get(key);
        if (c && c.found === false) { groups.push({ externalId: key, found: false }); continue; }
        if (reread.has(key)) {
          // nested structure changed: the transitive list again, like a full read
          const all = new Map();
          const g = await readGroup(sel, all, nested);
          for (const [id, p] of all) users.set(id, p);
          groups.push(g);
          continue;
        }
        if (!c) continue;
        // new members: their profile (once; at most 100, else the whole list)
        const unknown = [...new Set(c.add)].filter((id) => !snapUsers.has(id) && !users.has(id));
        if (unknown.length > 100) {
          const all = new Map();
          const g = await readGroup(sel, all, nested);
          for (const [id, p] of all) users.set(id, p);
          groups.push(g);
          continue;
        }
        const add = [];
        for (const id of c.add) {
          if (!users.has(id) && !snapUsers.has(id)) {
            const o = await graphGet(cfg, secret, `/users/${id}?$select=${USER_SELECT}`);
            if (!o) continue; // deleted meanwhile
            users.set(id, userFrom(o));
          }
          add.push(id);
        }
        groups.push({ externalId: key, ...(c.name ? { name: c.name } : {}), found: true, add, remove: c.remove });
      }
      return {
        groups, users: [...users.values()], removedUsers: [...removedUsers],
        cursor: { users: userRound.deltaLink, groups: groupRound.deltaLink, nested },
      };
    },

    // Entra accounts sign in with "Mit Microsoft anmelden" (OpenID Connect),
    // never with a password typed into GateControl.
    async authenticate() { return { ok: false, reason: 'oidc_only' }; },
  };
}

module.exports = { create, checkConfig, getToken, _setFetch, getFetch, timedFetch, deltaRound, GRAPH, LOGIN, GUID_RE, _tokenCache: tokenCache };
