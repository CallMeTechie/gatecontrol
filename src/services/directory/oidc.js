'use strict';

/**
 * "Mit Microsoft anmelden" — OpenID Connect authorization code flow with
 * PKCE against Microsoft Entra ID, built on Node's fetch and crypto (no
 * extra library).
 *
 *   begin(directory, { returnTo }) → { txnId, url }
 *       creates a login transaction { state, nonce, PKCE verifier } (kept
 *       server-side for 10 minutes, single use) and the authorization URL.
 *       The transaction id travels in its own SameSite=Lax cookie (the
 *       session cookie is SameSite=Strict and is not sent when Microsoft
 *       redirects back).
 *   async complete(txnId, query, { directoryId }) → { user, directory, returnTo }
 *       checks state, exchanges the code (with the PKCE verifier and the
 *       client secret), verifies the ID token and maps it to the linked
 *       account by its object id (oid) — never by e-mail. Throws err.code.
 *   async verifyIdToken(token, { issuer, audience, nonce, tenantId, jwksUri, now })
 *       RS256 only; key from the JWKS (cached 1 h, refreshed once when the
 *       kid is unknown); iss, aud, exp, nbf, iat, nonce, tid (= the
 *       configured tenant) and oid are checked.
 *   async discovery(tenantId) → the tenant's OpenID configuration (cached 1 h)
 *
 * Error codes: OIDC_DISABLED, STATE_MISMATCH, TXN_EXPIRED, IDP_ERROR,
 * TOKEN_EXCHANGE, BAD_TOKEN (+ err.reason), NOT_LINKED, ACCOUNT_DISABLED.
 */

const crypto = require('node:crypto');
const { getDb } = require('../../db/connection');
const store = require('./store');
const entra = require('./entra');
const logger = require('../../utils/logger');

const TXN_TTL_MS = 10 * 60 * 1000;
const MAX_TXNS = 2000;
const CACHE_MS = 60 * 60 * 1000;
const JWKS_REFRESH_MIN_MS = 5 * 60 * 1000;
const CLOCK_SKEW_S = 300;

const txns = new Map(); // txnId → { directoryId, state, nonce, verifier, returnTo, at }
const discoveryCache = new Map(); // tenantId → { at, doc }
const jwksCache = new Map(); // uri → { at, keys }

function codedError(code, message, extra) {
  const err = new Error(message || code);
  err.code = code;
  if (extra) Object.assign(err, extra);
  return err;
}

function b64url(buf) { return Buffer.from(buf).toString('base64url'); }
function randomToken(n = 32) { return b64url(crypto.randomBytes(n)); }
function sha256b64url(s) { return b64url(crypto.createHash('sha256').update(s).digest()); }

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

function redirectUriFor(directoryId) { return store.redirectUri(directoryId); }

function purge(now = Date.now()) {
  for (const [k, t] of txns) if (now - t.at > TXN_TTL_MS) txns.delete(k);
  while (txns.size > MAX_TXNS) txns.delete(txns.keys().next().value);
}

async function getJson(url, label) {
  const res = await entra.timedFetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw codedError('IDP_ERROR', `${label} request failed (${res.status})`);
  try { return await res.json(); } catch { throw codedError('IDP_ERROR', `${label} is not JSON`); }
}

async function discovery(tenantId) {
  const hit = discoveryCache.get(tenantId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.doc;
  const doc = await getJson(`${entra.LOGIN}/${tenantId}/v2.0/.well-known/openid-configuration`, 'discovery');
  for (const k of ['issuer', 'authorization_endpoint', 'token_endpoint', 'jwks_uri']) {
    if (typeof doc[k] !== 'string' || !doc[k].startsWith('https://')) throw codedError('IDP_ERROR', `discovery document lacks ${k}`);
  }
  discoveryCache.set(tenantId, { at: Date.now(), doc });
  return doc;
}

async function jwks(uri, { refresh = false } = {}) {
  const hit = jwksCache.get(uri);
  if (hit && !refresh && Date.now() - hit.at < CACHE_MS) return hit.keys;
  if (hit && refresh && Date.now() - hit.at < JWKS_REFRESH_MIN_MS) return hit.keys;
  const doc = await getJson(uri, 'JWKS');
  const keys = Array.isArray(doc.keys) ? doc.keys : [];
  jwksCache.set(uri, { at: Date.now(), keys });
  return keys;
}

function decodePart(part, what) {
  try { return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')); } catch { throw codedError('BAD_TOKEN', `${what} unreadable`, { reason: 'malformed' }); }
}

async function verifyIdToken(token, { issuer, audience, nonce, tenantId, jwksUri, now = Date.now() }) {
  if (typeof token !== 'string' || token.length > 16384) throw codedError('BAD_TOKEN', 'no ID token', { reason: 'malformed' });
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]*$/.test(p))) throw codedError('BAD_TOKEN', 'malformed ID token', { reason: 'malformed' });
  const header = decodePart(parts[0], 'header');
  const claims = decodePart(parts[1], 'payload');
  if (header.alg !== 'RS256') throw codedError('BAD_TOKEN', 'unexpected algorithm', { reason: 'alg' });
  if (typeof header.kid !== 'string' || !header.kid) throw codedError('BAD_TOKEN', 'no key id', { reason: 'kid' });
  let keys = await jwks(jwksUri);
  let jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) {
    keys = await jwks(jwksUri, { refresh: true });
    jwk = keys.find((k) => k.kid === header.kid);
  }
  if (!jwk || jwk.kty !== 'RSA' || (jwk.use && jwk.use !== 'sig')) throw codedError('BAD_TOKEN', 'signing key not found', { reason: 'kid' });
  let key;
  try { key = crypto.createPublicKey({ key: { kty: jwk.kty, n: jwk.n, e: jwk.e }, format: 'jwk' }); } catch {
    throw codedError('BAD_TOKEN', 'signing key unreadable', { reason: 'kid' });
  }
  const ok = crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'));
  if (!ok) throw codedError('BAD_TOKEN', 'signature invalid', { reason: 'signature' });

  const nowS = Math.floor(now / 1000);
  const expectedIss = String(issuer).replace('{tenantid}', tenantId);
  if (claims.iss !== expectedIss) throw codedError('BAD_TOKEN', 'wrong issuer', { reason: 'issuer' });
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(audience)) throw codedError('BAD_TOKEN', 'wrong audience', { reason: 'audience' });
  if (aud.length > 1 && claims.azp !== audience) throw codedError('BAD_TOKEN', 'wrong authorised party', { reason: 'audience' });
  if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_S < nowS) throw codedError('BAD_TOKEN', 'token expired', { reason: 'expired' });
  if (typeof claims.nbf === 'number' && claims.nbf - CLOCK_SKEW_S > nowS) throw codedError('BAD_TOKEN', 'token not yet valid', { reason: 'nbf' });
  if (typeof claims.iat !== 'number' || claims.iat - CLOCK_SKEW_S > nowS) throw codedError('BAD_TOKEN', 'bad issued-at', { reason: 'iat' });
  if (!safeEqual(claims.nonce, nonce)) throw codedError('BAD_TOKEN', 'nonce mismatch', { reason: 'nonce' });
  if (String(claims.tid || '').toLowerCase() !== String(tenantId).toLowerCase()) throw codedError('BAD_TOKEN', 'wrong tenant', { reason: 'tenant' });
  if (!entra.GUID_RE.test(String(claims.oid || ''))) throw codedError('BAD_TOKEN', 'no object id', { reason: 'oid' });
  return claims;
}

/** The Entra directory with sign-in switched on, or OIDC_DISABLED. */
function loginDirectory(directoryId) {
  const dir = store.load(directoryId);
  if (!dir || dir.kind !== 'entra' || dir.enabled !== 1 || dir.login_enabled !== 1) throw codedError('OIDC_DISABLED', 'sign-in with this directory is not available');
  return dir;
}

/** Directories for the login page buttons: [{ id, name }]. */
function loginButtons() {
  try {
    return getDb().prepare("SELECT id, name FROM directories WHERE kind = 'entra' AND enabled = 1 AND login_enabled = 1 ORDER BY id").all();
  } catch { return []; }
}

async function begin(directoryId, { returnTo = '' } = {}) {
  const dir = loginDirectory(directoryId);
  const { tenantId, clientId } = entra.checkConfig(dir.config);
  const doc = await discovery(tenantId);
  purge();
  const txnId = randomToken(24);
  const state = randomToken(32);
  const nonce = randomToken(32);
  const verifier = randomToken(48);
  txns.set(txnId, { directoryId: dir.id, state, nonce, verifier, returnTo: returnTo || '', at: Date.now() });
  const url = new URL(doc.authorization_endpoint);
  url.search = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUriFor(dir.id),
    response_mode: 'query',
    scope: 'openid profile email',
    state,
    nonce,
    code_challenge: sha256b64url(verifier),
    code_challenge_method: 'S256',
    prompt: 'select_account',
  }).toString();
  return { txnId, url: url.toString() };
}

async function complete(txnId, query, { directoryId, now = Date.now() } = {}) {
  const txn = typeof txnId === 'string' ? txns.get(txnId) : null;
  if (txn) txns.delete(txnId); // single use, successful or not
  if (!txn || txn.directoryId !== Number(directoryId)) throw codedError('STATE_MISMATCH', 'no login in progress');
  if (now - txn.at > TXN_TTL_MS) throw codedError('TXN_EXPIRED', 'the login took too long');
  const q = query || {};
  if (!safeEqual(q.state, txn.state)) throw codedError('STATE_MISMATCH', 'state does not match');
  if (q.error) throw codedError('IDP_ERROR', `Microsoft refused the login (${String(q.error).slice(0, 80)})`, { idpError: String(q.error).slice(0, 80) });
  if (typeof q.code !== 'string' || !q.code || q.code.length > 4096) throw codedError('IDP_ERROR', 'no authorization code');

  const dir = loginDirectory(directoryId);
  const { tenantId, clientId } = entra.checkConfig(dir.config);
  const secret = store.secretOf(dir);
  const doc = await discovery(tenantId);
  const res = await entra.timedFetch(doc.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({
      client_id: clientId, client_secret: secret, grant_type: 'authorization_code', code: q.code,
      redirect_uri: redirectUriFor(dir.id), code_verifier: txn.verifier, scope: 'openid profile email',
    }).toString(),
  });
  let json = {};
  try { json = await res.json(); } catch { json = {}; }
  if (!res.ok || typeof json.id_token !== 'string') {
    logger.warn({ directoryId: dir.id, status: res.status, error: json.error }, 'OIDC token exchange failed');
    throw codedError('TOKEN_EXCHANGE', 'the code could not be redeemed');
  }
  const claims = await verifyIdToken(json.id_token, {
    issuer: doc.issuer, audience: clientId, nonce: txn.nonce, tenantId, jwksUri: doc.jwks_uri, now,
  });
  const oid = String(claims.oid).toLowerCase();
  const db = getDb();
  const link = db.prepare('SELECT * FROM directory_links WHERE directory_id = ? AND lower(external_id) = ?').get(dir.id, oid);
  if (!link) throw codedError('NOT_LINKED', 'no GateControl account belongs to this Microsoft account', { oid });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(link.user_id);
  // Administrators never sign in through the directory.
  if (!user || user.role !== 'user') throw codedError('NOT_LINKED', 'this account signs in locally');
  if (user.enabled !== 1) throw codedError('ACCOUNT_DISABLED', 'the account is disabled');
  db.prepare('UPDATE directory_links SET last_seen_at = ? WHERE user_id = ?').run(new Date(now).toISOString(), user.id);
  return { user, directory: dir, returnTo: txn.returnTo, claims };
}

function _reset() { txns.clear(); discoveryCache.clear(); jwksCache.clear(); }

module.exports = {
  begin, complete, verifyIdToken, discovery, loginButtons, loginDirectory, redirectUriFor,
  TXN_TTL_MS, _reset, _txns: txns,
};
