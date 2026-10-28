'use strict';

// Cloud accounts (docs/cloud-accounts.md): what differs between Google and
// Microsoft — the OAuth endpoints and scopes, redeeming and refreshing
// tokens, the account's name, and an API session that adds the access token
// and refreshes it once when the provider answers 401.
//
// A token is { access, refresh, expiresAt (ms), scope } — kept encrypted by
// the caller (cloud_connections.token_enc, storage_targets.secret_enc),
// never logged, never in an answer.

const crypto = require('node:crypto');
const http = require('./http');

const { CloudError } = http;

const PROVIDERS = ['google', 'microsoft'];

const GOOGLE = {
  authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  revoke: 'https://oauth2.googleapis.com/revoke',
  drive: 'https://www.googleapis.com/drive/v3',
  upload: 'https://www.googleapis.com/upload/drive/v3',
};
const GRAPH = 'https://graph.microsoft.com/v1.0';
const LOGIN = 'https://login.microsoftonline.com';

// import: read the person's files; target: the storage target's own folder
const SCOPES = {
  google: { import: 'https://www.googleapis.com/auth/drive.readonly', target: 'https://www.googleapis.com/auth/drive.file' },
  microsoft: { import: 'Files.Read offline_access openid profile', target: 'Files.ReadWrite offline_access openid profile' },
};

const TENANT_RE = /^(?:common|organizations|consumers|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)$/;
const EARLY_MS = 60 * 1000; // refresh this long before the access token runs out

function tokenUrl(provider, app) {
  return provider === 'google' ? GOOGLE.token : `${LOGIN}/${encodeURIComponent(app.tenant || 'common')}/oauth2/v2.0/token`;
}

/** The provider's authorization address (code flow with PKCE S256). */
function authorizeUrl(provider, app, { purpose, state, challenge, redirectUri }) {
  const scope = SCOPES[provider][purpose === 'target' ? 'target' : 'import'];
  const base = provider === 'google' ? GOOGLE.authorize : `${LOGIN}/${encodeURIComponent(app.tenant || 'common')}/oauth2/v2.0/authorize`;
  const q = new URLSearchParams({
    client_id: app.clientId, response_type: 'code', redirect_uri: redirectUri, scope, state,
    code_challenge: challenge, code_challenge_method: 'S256',
  });
  if (provider === 'google') {
    // a refresh token comes only with offline access, and again only after a fresh consent
    q.set('access_type', 'offline');
    q.set('prompt', 'consent');
    q.set('include_granted_scopes', 'false');
  } else {
    q.set('response_mode', 'query');
    q.set('prompt', 'select_account');
  }
  return `${base}?${q.toString()}`;
}

/** An error answer of the token endpoint → CloudError (never the body's secrets). */
function tokenError(status, json) {
  const err = String((json && json.error) || '').slice(0, 60);
  if (err === 'invalid_client' || err === 'unauthorized_client') return new CloudError('ERR_CLOUD_NOT_CONFIGURED', `the OAuth app was refused (${err})`, { reason: err });
  if (err === 'invalid_grant' || status === 401) return new CloudError('ERR_CLOUD_AUTH', 'the account has to be connected again', { reason: err || 'unauthorized' });
  if (status === 429) return new CloudError('ERR_RATE_LIMIT', 'the provider asks to wait');
  return new CloudError('ERR_CLOUD_PROVIDER', `the provider refused the token request (HTTP ${status}${err ? ', ' + err : ''})`, { status });
}

async function tokenRequest(provider, app, params) {
  const body = new URLSearchParams(Object.assign({ client_id: app.clientId, client_secret: app.clientSecret }, params)).toString();
  const res = await http.request({ method: 'POST', url: tokenUrl(provider, app), headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body });
  const json = await http.readJson(res.stream, 256 * 1024);
  if (res.status !== 200 || typeof json.access_token !== 'string') throw tokenError(res.status, json);
  return json;
}

function tokenOf(json, prev) {
  const ttl = Math.max(60, Math.min(24 * 3600, Number(json.expires_in) || 3600));
  return {
    access: json.access_token,
    // Microsoft hands out a new refresh token on every refresh; Google keeps the old one
    refresh: typeof json.refresh_token === 'string' && json.refresh_token ? json.refresh_token : (prev && prev.refresh) || null,
    expiresAt: Date.now() + ttl * 1000,
    scope: typeof json.scope === 'string' ? json.scope.slice(0, 500) : (prev && prev.scope) || null,
    purpose: (prev && prev.purpose) || 'import',
  };
}

/** Redeem an authorization code → { token, idToken }. */
async function exchange(provider, app, { code, verifier, redirectUri, purpose }) {
  const params = { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirectUri };
  if (provider === 'microsoft') params.scope = SCOPES.microsoft[purpose === 'target' ? 'target' : 'import'];
  const json = await tokenRequest(provider, app, params);
  const token = tokenOf(json, { purpose: purpose === 'target' ? 'target' : 'import' });
  if (!token.refresh) throw new CloudError('ERR_CLOUD_AUTH', 'the provider gave no refresh token');
  return { token, idToken: typeof json.id_token === 'string' ? json.id_token : null };
}

/** A new access token for `tok` → the new token (refresh token kept or replaced). */
async function refresh(provider, app, tok) {
  if (!tok || !tok.refresh) throw new CloudError('ERR_CLOUD_AUTH', 'the account has to be connected again');
  const params = { grant_type: 'refresh_token', refresh_token: tok.refresh };
  // Microsoft: the scopes of the first request again (with offline_access, else no new refresh token)
  if (provider === 'microsoft') params.scope = SCOPES.microsoft[tok.purpose === 'target' ? 'target' : 'import'];
  return tokenOf(await tokenRequest(provider, app, params), tok);
}

/** Best effort: Google forgets the grant (Microsoft has no such endpoint for a single grant). */
async function revoke(provider, tok) {
  if (provider !== 'google' || !tok || !tok.refresh) return;
  try {
    const res = await http.request({ method: 'POST', url: GOOGLE.revoke, headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: tok.refresh }).toString() });
    await http.drain(res.stream);
  } catch { /* the grant stays until the person removes it at Google */ }
}

/** The claims of an ID token straight from the token endpoint (TLS, not stored, only for the account's name). */
function idClaims(idToken) {
  try { return JSON.parse(Buffer.from(String(idToken).split('.')[1] || '', 'base64url').toString('utf8')) || {}; } catch { return {}; }
}

/**
 * An API session for one token: token() → a valid access token (refreshed
 * when needed, once at a time per refresh token), call(opts) → the answer,
 * after one refresh and retry on 401. `save(tok)` keeps a refreshed token.
 */
const inflight = new Map(); // sha256(refresh token) → Promise<token>
function session(provider, appFn, tok, save) {
  let cur = tok;
  async function renew() {
    const key = crypto.createHash('sha256').update(String(cur.refresh || '')).digest('hex');
    let p = inflight.get(key);
    if (!p) {
      p = (async () => refresh(provider, appFn(), cur))();
      inflight.set(key, p);
      p.finally(() => inflight.delete(key)).catch(() => {});
    }
    const next = await p;
    cur = next;
    try { await save(next); } catch { /* used now, saved next time */ }
    return next;
  }
  async function token(force = false) {
    if (!force && cur.access && Number(cur.expiresAt) - EARLY_MS > Date.now()) return cur.access;
    return (await renew()).access;
  }
  /** opts as http.request plus `body` as a function () → body, so a retry can send it again. */
  async function call(opts) {
    for (let attempt = 0; ; attempt++) {
      const headers = Object.assign({}, opts.headers || {}, { authorization: `Bearer ${await token(attempt > 0)}` });
      const body = typeof opts.body === 'function' ? opts.body() : opts.body;
      const res = await http.request(Object.assign({}, opts, { headers, body }));
      if (res.status !== 401 || attempt > 0 || (body && typeof opts.body !== 'function' && !Buffer.isBuffer(body) && typeof body !== 'string')) return res;
      await http.drain(res.stream);
    }
  }
  return { token, call, current: () => cur };
}

/**
 * An error answer of the Drive or Graph API → CloudError: 401 ERR_CLOUD_AUTH,
 * 404 ERR_CLOUD_NOT_FOUND, 429 and Google's rate reasons ERR_RATE_LIMIT,
 * anything else ERR_CLOUD_PROVIDER with `status` and `reason` (e.g.
 * storageQuotaExceeded, insufficientStorage) for the storage drivers.
 */
async function apiError(res, what) {
  let json = {};
  try { json = await http.readJson(res.stream, 64 * 1024); } catch { json = {}; }
  const e = json && json.error && typeof json.error === 'object' ? json.error : {};
  const reason = String((Array.isArray(e.errors) && e.errors[0] && e.errors[0].reason) || e.code || '').slice(0, 60);
  const status = res.status;
  const extra = { status, reason };
  if (status === 401) return new CloudError('ERR_CLOUD_AUTH', `${what}: the account has to be connected again`, extra);
  if (status === 404) return new CloudError('ERR_CLOUD_NOT_FOUND', `${what}: not found`, extra);
  if (status === 429 || /^(?:rateLimitExceeded|userRateLimitExceeded|activityRateLimitExceeded|activityLimitReached|tooManyRequests)$/i.test(reason)) {
    const after = Number(res.headers && res.headers['retry-after']);
    return new CloudError('ERR_RATE_LIMIT', `${what}: the provider asks to wait${Number.isFinite(after) && after > 0 ? ` ${Math.min(3600, Math.round(after))} s` : ''}`, extra);
  }
  return new CloudError('ERR_CLOUD_PROVIDER', `${what}: HTTP ${status}${reason ? ' ' + reason : ''}`, extra);
}

/** The account a token belongs to → { account, accountId } (name / e-mail for people to see). */
async function account(provider, api, idToken) {
  if (provider === 'google') {
    const res = await api.call({ url: `${GOOGLE.drive}/about?fields=user(displayName,emailAddress,permissionId)` });
    if (res.status !== 200) throw await apiError(res, 'account');
    const u = (await http.readJson(res.stream, 64 * 1024)).user || {};
    return { account: String(u.emailAddress || u.displayName || 'Google').slice(0, 200), accountId: String(u.permissionId || u.emailAddress || '').slice(0, 200) || null };
  }
  const c = idClaims(idToken);
  let name = c.preferred_username || c.email || c.name || null;
  let id = c.oid || c.sub || null;
  if (!name) {
    const res = await api.call({ url: `${GRAPH}/me/drive?$select=id,owner` });
    if (res.status !== 200) throw await apiError(res, 'account');
    const d = await http.readJson(res.stream, 64 * 1024);
    const u = (d.owner && d.owner.user) || {};
    name = u.email || u.displayName || 'OneDrive';
    id = id || u.id || d.id || null;
  }
  return { account: String(name).slice(0, 200), accountId: id ? String(id).slice(0, 200) : null };
}

module.exports = {
  PROVIDERS, SCOPES, GOOGLE, GRAPH, LOGIN, TENANT_RE, EARLY_MS,
  authorizeUrl, exchange, refresh, revoke, session, apiError, account, idClaims,
};
