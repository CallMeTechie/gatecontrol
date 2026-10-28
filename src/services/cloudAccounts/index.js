'use strict';

// Cloud accounts (docs/cloud-accounts.md): Google Drive and OneDrive.
//
//   * The administrator enters one OAuth app per provider (Einstellungen ›
//     Plugins › Cloud-Konten): client id, client secret (encrypted with
//     GC_ENCRYPTION_KEY, utils/crypto, setting `cloud.<provider>.client_secret_encrypted`),
//     for Microsoft the tenant (default `common`). The redirect URI is
//     <GC_BASE_URL>/oauth/cloud/callback.
//   * A connection is made with the authorization code flow, `state` against
//     CSRF and PKCE (S256): createFlow() keeps the flow server-side for 10
//     minutes and hands out /oauth/cloud/start?flow=<id> (routes/cloudOAuth.js);
//     begin() marks it started (single use) and binds it to the browser with
//     a cookie; complete() checks state, binding and age and redeems the code.
//   * purpose 'import' (gc.cloud, permissions.cloudImport): the connection
//     belongs to exactly one person and one plugin (cloud_connections, the
//     token encrypted in token_enc). purpose 'target' (an administrator's
//     storage target "Google Drive" / "OneDrive"): the token becomes a draft
//     (in memory, 30 minutes) the storage target takes into its own secret.
//   * Tokens and secrets never appear in an answer or a log line.

const crypto = require('node:crypto');
const { getDb } = require('../../db/connection');
const { encrypt, decrypt } = require('../../utils/crypto');
const settings = require('../settings');
const logger = require('../../utils/logger');
const providers = require('./providers');
const { CloudError } = require('./http');

const PROVIDERS = providers.PROVIDERS;
const FLOW_TTL_MS = 10 * 60 * 1000;
const DRAFT_TTL_MS = 30 * 60 * 1000;
const MAX_FLOWS = 1000;
const MAX_DRAFTS = 50;
const MAX_CONNECTIONS = 10; // per person and plugin
const CLIENT_ID_RE = /^[A-Za-z0-9._-]{8,200}$/;
const CONNECTION_RE = /^[0-9a-f]{24}$/;
const RETURN_MAX = 300;
const PORTAL_RETURN_RE = /^\/portal(?:\/[A-Za-z0-9._~!$&'()*+,;=:@%-]*)*(?:\?[A-Za-z0-9._~!$&'()*+,;=:@%/?-]*)?(?:#[A-Za-z0-9._~!$&'()*+,;=:@%/?-]*)?$/;
const APP_RETURN_RE = /^gatecontrol:\/\/[a-z0-9-]{1,40}(?:\/[A-Za-z0-9._~%-]*)*(?:\?[A-Za-z0-9._~!$&'()*+,;=:@%/?-]*)?$/;

function db() { return getDb(); }
function fail(code, message, extra) { throw new CloudError(code, message, extra); }

// ─── OAuth apps ─────────────────────────────────

function key(provider, k) { return `cloud.${provider}.${k}`; }

function checkProvider(p) {
  if (!PROVIDERS.includes(p)) fail('ERR_INVALID', "provider must be 'google' or 'microsoft'");
  return p;
}

/** The OAuth app of `provider` with its secret → { clientId, clientSecret, tenant } | null (not set up / not decryptable). */
function app(provider) {
  if (!PROVIDERS.includes(provider)) return null;
  const clientId = settings.get(key(provider, 'client_id'), '') || '';
  const enc = settings.get(key(provider, 'client_secret_encrypted'), '') || '';
  if (!clientId || !enc) return null;
  let clientSecret;
  try { clientSecret = decrypt(String(enc)); } catch { return null; }
  if (!clientSecret) return null;
  return { clientId, clientSecret, tenant: provider === 'microsoft' ? (settings.get(key(provider, 'tenant'), '') || 'common') : null };
}

function configured(provider) { return !!app(provider); }

/** gc.cloud.available() → { google, microsoft }: is an OAuth app entered (and usable)? */
function available() { return { google: configured('google'), microsoft: configured('microsoft') }; }

/** <GC_BASE_URL>/oauth/cloud/callback — what the administrator registers at Google and Microsoft. */
function redirectUri() {
  let base = '';
  try { base = new URL(require('../../../config/default').app.baseUrl).origin; } catch { base = ''; }
  return `${base}/oauth/cloud/callback`;
}

function startUrl(flowId) { return `${redirectUri().replace(/\/callback$/, '/start')}?flow=${flowId}`; }

/** The administrator's view: never the secret, only whether it is set. */
function appsView() {
  const out = {};
  for (const p of PROVIDERS) {
    const enc = settings.get(key(p, 'client_secret_encrypted'), '') || '';
    let readable = false;
    if (enc) { try { readable = !!decrypt(String(enc)); } catch { readable = false; } }
    out[p] = {
      clientId: settings.get(key(p, 'client_id'), '') || '',
      secretSet: !!enc,
      // a secret from another GC_ENCRYPTION_KEY (a restored backup): enter it again
      needsSecret: !!enc && !readable,
      configured: configured(p),
      scopes: providers.SCOPES[p],
      ...(p === 'microsoft' ? { tenant: settings.get(key(p, 'tenant'), '') || 'common' } : {}),
      updatedAt: settings.get(key(p, 'updated_at'), null),
    };
  }
  return out;
}

/** Administrator: enter or change an app (a secret left empty keeps the stored one). */
function setApp(provider, input) {
  checkProvider(provider);
  const i = input && typeof input === 'object' ? input : {};
  const clientId = String(i.clientId == null ? '' : i.clientId).trim();
  if (!CLIENT_ID_RE.test(clientId)) fail('ERR_INVALID', 'invalid client id', { field: 'clientId' });
  const secret = i.clientSecret == null ? '' : String(i.clientSecret);
  if (secret && (secret.length > 512 || /[\u0000-\u001f]/.test(secret))) fail('ERR_INVALID', 'invalid client secret', { field: 'clientSecret' });
  const hasSecret = !!settings.get(key(provider, 'client_secret_encrypted'), '');
  if (!secret && !hasSecret) fail('ERR_INVALID', 'the client secret is required', { field: 'clientSecret' });
  let tenant = null;
  if (provider === 'microsoft') {
    tenant = String(i.tenant == null || i.tenant === '' ? 'common' : i.tenant).trim().toLowerCase();
    if (!providers.TENANT_RE.test(tenant)) fail('ERR_INVALID', 'invalid tenant', { field: 'tenant' });
  }
  settings.set(key(provider, 'client_id'), clientId);
  if (secret) settings.set(key(provider, 'client_secret_encrypted'), encrypt(secret));
  if (tenant) settings.set(key(provider, 'tenant'), tenant);
  settings.set(key(provider, 'updated_at'), new Date().toISOString());
  return appsView()[provider];
}

/** Administrator: remove an app. Connections stay (they work again once an app is entered); storage targets refuse it. */
function removeApp(provider) {
  checkProvider(provider);
  const kind = provider === 'google' ? 'gdrive' : 'onedrive';
  if (db().prepare('SELECT 1 FROM storage_targets WHERE kind = ? LIMIT 1').get(kind)) fail('ERR_IN_USE', 'a storage target uses this app');
  db().prepare("DELETE FROM settings WHERE key IN (?, ?, ?, ?)").run(key(provider, 'client_id'), key(provider, 'client_secret_encrypted'), key(provider, 'tenant'), key(provider, 'updated_at'));
}

function needApp(provider) {
  const a = app(checkProvider(provider));
  if (!a) fail('ERR_CLOUD_NOT_CONFIGURED', `no OAuth app for ${provider} is set up (Einstellungen › Plugins › Cloud-Konten)`);
  return a;
}

// ─── Where to go afterwards ─────────────────────

/**
 * gc.cloud.connectUrl returnTo → { kind: 'portal' | 'app', path } or null:
 * a path of the portal ('/portal…', the portal host is added) or an address
 * of the apps (gatecontrol://…). Nothing else — never another host.
 */
function checkReturnTo(v) {
  if (typeof v !== 'string' || !v || v.length > RETURN_MAX || /[\s\\]/.test(v) || v.includes('//', v.startsWith('gatecontrol://') ? 14 : 0)) return null;
  if (PORTAL_RETURN_RE.test(v)) return { kind: 'portal', path: v };
  if (APP_RETURN_RE.test(v)) return { kind: 'app', path: v };
  return null;
}

/** The address to send the browser to after the callback, with ?cloud=connected | error (&cloudError=<code>). */
function returnUrl(rt, outcome) {
  const params = outcome.ok ? 'cloud=connected' : `cloud=error&cloudError=${encodeURIComponent(outcome.code || 'failed')}`;
  const add = (p) => {
    const hash = p.indexOf('#');
    const head = hash >= 0 ? p.slice(0, hash) : p;
    const tail = hash >= 0 ? p.slice(hash) : '';
    return head + (head.includes('?') ? '&' : '?') + params + tail;
  };
  if (rt.kind === 'admin') return add(rt.path);
  if (rt.kind === 'app') return add(rt.path);
  let host;
  try { host = require('../portalConfig').effectivePortalHost().host; } catch { host = null; }
  return host ? `https://${host}${add(rt.path)}` : add(rt.path);
}

// ─── Flows ──────────────────────────────────────

const flows = new Map();   // flow id → flow
const byState = new Map(); // state → flow id

function b64url(buf) { return Buffer.from(buf).toString('base64url'); }
function sha256(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }
function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

function purgeFlows(now = Date.now()) {
  for (const [id, f] of flows) if (now - f.at > FLOW_TTL_MS) { flows.delete(id); byState.delete(f.state); }
  while (flows.size > MAX_FLOWS) {
    const [id, f] = flows.entries().next().value;
    flows.delete(id);
    byState.delete(f.state);
  }
}

/**
 * A new connection flow → { id, url }. purpose 'import': for person `userId`
 * in plugin `pluginId`, back to `returnTo` (checkReturnTo); purpose 'target':
 * an administrator (`userId`) connects an account for a storage target
 * (`targetId` when it reconnects one), back to the storage page.
 */
function createFlow({ provider, purpose, userId, pluginId = null, returnTo = null, targetId = null }) {
  needApp(provider);
  purgeFlows();
  const id = b64url(crypto.randomBytes(24));
  const state = b64url(crypto.randomBytes(32));
  const verifier = b64url(crypto.randomBytes(48));
  const rt = purpose === 'target' ? { kind: 'admin', path: '/settings/plugins/storage' } : returnTo;
  flows.set(id, { id, provider, purpose: purpose === 'target' ? 'target' : 'import', userId, pluginId, returnTo: rt, targetId, state, verifier, binding: null, at: Date.now() });
  byState.set(state, id);
  return { id, url: startUrl(id) };
}

/** A flow not started yet (for the start page) or null. */
function pendingFlow(id) {
  if (typeof id !== 'string' || id.length > 64) return null;
  const f = flows.get(id);
  if (!f || f.binding || Date.now() - f.at > FLOW_TTL_MS) return null;
  return f;
}

/** Start it (once): → { binding (the cookie value), url (the provider's authorization address) }. */
function begin(id) {
  const f = pendingFlow(id);
  if (!f) fail('ERR_CLOUD_FLOW', 'this connection link is used up or expired');
  const a = needApp(f.provider);
  const binding = b64url(crypto.randomBytes(24));
  f.binding = sha256(binding);
  const url = providers.authorizeUrl(f.provider, a, { purpose: f.purpose, state: f.state, challenge: b64url(crypto.createHash('sha256').update(f.verifier).digest()), redirectUri: redirectUri() });
  return { binding, url };
}

/**
 * The callback: { state, code, error } of the query and the browser's
 * binding cookie → { flow, connection | draft }. Single use; throws CloudError
 * (ERR_CLOUD_FLOW unknown / expired / other browser, ERR_CLOUD_DENIED the
 * person said no, ERR_CLOUD_AUTH / _PROVIDER / _NOT_CONFIGURED) with err.flow
 * once the flow is known (to send the browser back).
 */
async function complete({ state, code, error, binding }) {
  const id = typeof state === 'string' && state.length <= 100 ? byState.get(state) : null;
  const f = id ? flows.get(id) : null;
  if (f) { flows.delete(id); byState.delete(f.state); }
  if (!f || !f.binding) fail('ERR_CLOUD_FLOW', 'no connection in progress');
  try {
    if (Date.now() - f.at > FLOW_TTL_MS) fail('ERR_CLOUD_FLOW', 'the connection took too long');
    if (!safeEqual(sha256(binding || ''), f.binding)) fail('ERR_CLOUD_FLOW', 'the connection was started in another browser');
    if (error) fail('ERR_CLOUD_DENIED', 'the provider refused or the person cancelled', { reason: String(error).slice(0, 60) });
    if (typeof code !== 'string' || !code || code.length > 4096) fail('ERR_CLOUD_PROVIDER', 'no authorization code');
    const a = needApp(f.provider);
    const { token, idToken } = await providers.exchange(f.provider, a, { code, verifier: f.verifier, redirectUri: redirectUri(), purpose: f.purpose });
    let saved = token;
    const api = providers.session(f.provider, () => needApp(f.provider), token, (t) => { saved = t; });
    const who = await providers.account(f.provider, api, idToken);
    if (f.purpose === 'target') return { flow: f, draft: putDraft({ provider: f.provider, token: saved, ...who, targetId: f.targetId, userId: f.userId }) };
    return { flow: f, connection: storeConnection(f, saved, who) };
  } catch (e) {
    const err = e instanceof CloudError ? e : new CloudError('ERR_CLOUD_PROVIDER', (e && e.message) || 'failed');
    err.flow = f;
    throw err;
  }
}

// ─── Connections of people (gc.cloud) ───────────

function userEnabled(uid) {
  return Number.isSafeInteger(uid) && uid > 0 && !!db().prepare('SELECT 1 FROM users WHERE id = ? AND enabled = 1').get(uid);
}

function storeConnection(f, token, who) {
  if (!userEnabled(f.userId)) fail('ERR_CLOUD_FLOW', 'the account is gone or disabled');
  const enc = encrypt(JSON.stringify(token));
  // the same account again for the same person and plugin: new tokens, same id
  const same = who.accountId ? db().prepare('SELECT id FROM cloud_connections WHERE plugin = ? AND user_id = ? AND provider = ? AND account_id = ?')
    .get(f.pluginId, f.userId, f.provider, who.accountId) : null;
  if (same) {
    db().prepare("UPDATE cloud_connections SET token_enc = ?, account = ?, error = NULL, connected_at = datetime('now') WHERE id = ?").run(enc, who.account, same.id);
    return same.id;
  }
  const n = db().prepare('SELECT COUNT(*) AS n FROM cloud_connections WHERE plugin = ? AND user_id = ?').get(f.pluginId, f.userId).n;
  if (n >= MAX_CONNECTIONS) fail('ERR_CLOUD_LIMIT', `at most ${MAX_CONNECTIONS} connections per person`);
  const id = crypto.randomBytes(12).toString('hex');
  db().prepare(`INSERT INTO cloud_connections (id, provider, plugin, user_id, account, account_id, token_enc)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, f.provider, f.pluginId, f.userId, who.account, who.accountId, enc);
  return id;
}

function connView(r) {
  return { id: r.id, provider: r.provider, account: r.account || null, connectedAt: isoOf(r.connected_at), ...(r.error ? { error: r.error } : {}) };
}
function isoOf(sqlTime) { return sqlTime ? new Date(String(sqlTime).replace(' ', 'T') + (String(sqlTime).endsWith('Z') ? '' : 'Z')).toISOString() : null; }

/** gc.cloud.connections → [{ id, provider, account, connectedAt, error? }] of this person in this plugin. */
function connections(pluginId, userId) {
  return db().prepare('SELECT * FROM cloud_connections WHERE plugin = ? AND user_id = ? ORDER BY connected_at, id').all(pluginId, userId).map(connView);
}

/** The row of connection `id` — only when it belongs to this plugin and person. */
function connectionRow(pluginId, userId, id) {
  if (typeof id !== 'string' || !CONNECTION_RE.test(id)) return null;
  return db().prepare('SELECT * FROM cloud_connections WHERE id = ? AND plugin = ? AND user_id = ?').get(id, pluginId, userId) || null;
}

/** An API session of a connection; refreshed tokens are written back, ERR_CLOUD_AUTH is noted on the row. */
function connectionApi(row) {
  let tok;
  try { tok = JSON.parse(decrypt(String(row.token_enc))); } catch { fail('ERR_CLOUD_AUTH', 'the connection cannot be read (another server key) — connect again'); }
  const api = providers.session(row.provider, () => needApp(row.provider), tok, (t) => {
    db().prepare('UPDATE cloud_connections SET token_enc = ?, error = NULL WHERE id = ?').run(encrypt(JSON.stringify(t)), row.id);
  });
  const call = api.call;
  api.call = async (opts) => {
    try { return await call(opts); } catch (e) {
      if (e && e.code === 'ERR_CLOUD_AUTH') db().prepare('UPDATE cloud_connections SET error = ? WHERE id = ?').run('auth', row.id);
      throw e;
    }
  };
  db().prepare("UPDATE cloud_connections SET used_at = datetime('now') WHERE id = ?").run(row.id);
  return api;
}

/** Remove a connection (the person's, in this plugin); Google is asked to forget the grant. → removed? */
async function disconnect(pluginId, userId, id) {
  const row = connectionRow(pluginId, userId, id);
  if (!row) return false;
  db().prepare('DELETE FROM cloud_connections WHERE id = ?').run(row.id);
  await revokeRow(row);
  return true;
}

async function revokeRow(row) {
  try { await providers.revoke(row.provider, JSON.parse(decrypt(String(row.token_enc)))); } catch { /* best effort */ }
}

/** A plugin was uninstalled: its connections go. */
function removePlugin(pluginId) {
  try { db().prepare('DELETE FROM cloud_connections WHERE plugin = ?').run(pluginId); } catch (e) { logger.warn({ err: e.message }, 'cloud connections: cleanup failed'); }
}

/** Administrator: every person's connection (without tokens). */
function adminConnections() {
  return db().prepare(`SELECT c.*, u.username, u.display_name FROM cloud_connections c LEFT JOIN users u ON u.id = c.user_id
    ORDER BY c.plugin, u.display_name COLLATE NOCASE, c.connected_at`).all().map((r) => ({
    ...connView(r), plugin: r.plugin, user: { id: r.user_id, name: r.display_name || r.username || `#${r.user_id}` }, usedAt: isoOf(r.used_at),
  }));
}

/** Administrator: remove any connection. → the removed row's view or null. */
async function adminRemove(id) {
  if (typeof id !== 'string' || !CONNECTION_RE.test(id)) return null;
  const row = db().prepare('SELECT * FROM cloud_connections WHERE id = ?').get(id);
  if (!row) return null;
  db().prepare('DELETE FROM cloud_connections WHERE id = ?').run(id);
  await revokeRow(row);
  return { id: row.id, provider: row.provider, plugin: row.plugin, userId: row.user_id };
}

// ─── Drafts of storage targets ──────────────────

const drafts = new Map(); // draft id → { id, provider, token, account, accountId, targetId, userId, at }

function putDraft(d) {
  const now = Date.now();
  for (const [k, v] of drafts) if (now - v.at > DRAFT_TTL_MS) drafts.delete(k);
  while (drafts.size >= MAX_DRAFTS) drafts.delete(drafts.keys().next().value);
  const id = b64url(crypto.randomBytes(18));
  drafts.set(id, { ...d, id, at: now });
  return id;
}

/** A draft (a connected account a storage target has not taken yet) or null. */
function draft(id) {
  if (typeof id !== 'string' || id.length > 64) return null;
  const d = drafts.get(id);
  if (!d || Date.now() - d.at > DRAFT_TTL_MS) { drafts.delete(id); return null; }
  return d;
}

function dropDraft(id) { drafts.delete(id); }

/** What the page may see of a draft. */
function draftView(d) {
  return { id: d.id, provider: d.provider, kind: d.provider === 'google' ? 'gdrive' : 'onedrive', account: d.account, targetId: d.targetId || null };
}

/** An API session on a draft's token (refreshed tokens stay in the draft). */
function draftApi(d) {
  return providers.session(d.provider, () => needApp(d.provider), d.token, (t) => { d.token = t; });
}

function _resetForTest() {
  if (process.env.NODE_ENV !== 'test') return;
  flows.clear();
  byState.clear();
  drafts.clear();
}

module.exports = {
  PROVIDERS, FLOW_TTL_MS, MAX_CONNECTIONS, CONNECTION_RE, CloudError,
  app, needApp, configured, available, redirectUri, appsView, setApp, removeApp, checkReturnTo, returnUrl,
  createFlow, pendingFlow, begin, complete,
  userEnabled, connections, connectionRow, connectionApi, disconnect, removePlugin, adminConnections, adminRemove,
  draft, dropDraft, draftView, draftApi, putDraft,
  _resetForTest,
};
