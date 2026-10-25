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
 *   • V1 fetches the full member lists on every run (delta queries are a
 *     possible later optimisation; see docs/groups.md).
 *
 * Every URL is built from constants plus the validated GUIDs — no host
 * comes from configuration.
 */

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
    throw codedError(res.status === 401 || res.status === 403 ? 'AUTH_FAILED' : 'GRAPH_ERROR', `Graph request failed (${msg})`, { status: res.status });
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

    async fetch(selected) {
      const users = new Map();
      const groups = [];
      for (const sel of selected || []) {
        const id = String(sel.externalId || '').toLowerCase();
        if (!GUID_RE.test(id)) { groups.push({ externalId: sel.externalId, name: sel.name, found: false, members: [] }); continue; }
        const g = await graphGet(cfg, secret, `/groups/${id}?$select=id,displayName`);
        if (!g) { groups.push({ externalId: id, name: sel.name, found: false, members: [] }); continue; }
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
        groups.push({ externalId: id, name: g.displayName || sel.name, dn: null, found: true, members });
      }
      return { groups, users: [...users.values()] };
    },

    // Entra accounts sign in with "Mit Microsoft anmelden" (OpenID Connect),
    // never with a password typed into GateControl.
    async authenticate() { return { ok: false, reason: 'oidc_only' }; },
  };
}

module.exports = { create, checkConfig, getToken, _setFetch, getFetch, timedFetch, GRAPH, LOGIN, GUID_RE, _tokenCache: tokenCache };
