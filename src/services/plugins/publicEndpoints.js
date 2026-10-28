'use strict';

// Public endpoints of plugins (docs/plugins.md "Public endpoints", since 1.211.0): requests that reach a plugin
// without a session — no cookies, no CSRF, no login — e.g. an office server (Collabora Online, OnlyOffice) calling
// the plugin's WOPI host. Every request needs a token the plugin minted for one person and one path prefix:
//
//   * plugin.json `permissions.publicEndpoints`: true, or { maxBodyBytes } (needs `media`) — shown at install;
//   * gc.publicEndpoints.token({ user, path, ttlS, data }) → { token, url, expiresAt }: an HMAC-SHA256 token
//     (server secret) over { plugin, user, scope = path, expiry, data } — valid for /plugin-public/<id>/<path> and
//     below it, 60 s … 24 h; gc.publicEndpoints.base() → { url } of the plugin's prefix (GC_BASE_URL);
//   * the route (routes/pluginPublic.js) checks the token (query `access_token` or `Authorization: Bearer`),
//     the person (an enabled account), stores a body as an unclaimed media file of that person (≤ maxBodyBytes)
//     and calls the hook publicRequest({ method, path, query, headers, user, token, body, url, originalUrl, proofUrl })
//     — url and originalUrl without the access_token; proofUrl (the URL as called, token included) only when the request
//     carries X-WOPI-Proof, for checking that signature;
//   * the answer: { status, headers (x-… only), json | text | media (a media id of the plugin) | form } — a form
//     is a small page of this server that posts the fields to an http(s) address (the office editor — never
//     GateControl's own host), with a CSP that allows exactly that address as form-action.
//
// Nothing of a plugin's own HTML ever reaches GateControl's origin; the answers carry nosniff, no-store and a
// sandboxing CSP.

const crypto = require('node:crypto');
const config = require('../../../config/default');

const PREFIX = '/plugin-public/';
const TTL_MIN_S = 60;
const TTL_MAX_S = 24 * 3600;
const TTL_DEFAULT_S = 3600;
const SCOPE_MAX = 200;
const SCOPE_RE = /^[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/;
const DATA_MAX = 256;
const TOKEN_MAX = 1024;
const TOKEN_RE = /^([A-Za-z0-9_-]{16,960})\.([A-Za-z0-9_-]{43})$/;
// request headers handed to the plugin: x-… (minus the proxy's and GateControl's own) and the body's type / length
const REQ_HEADER_RE = /^x-[a-z0-9-]{1,64}$/;
const REQ_HEADER_DENY = new Set(['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-port', 'x-forwarded-prefix',
  'x-real-ip', 'x-api-token', 'x-csrf-token', 'x-gateway-target-domain', 'x-client-ip']);
const REQ_HEADERS_MAX = 40;
const REQ_HEADER_VALUE_MAX = 4096;
// answer headers a plugin may set: x-… only, never one the browser acts on
const RES_HEADER_RE = /^x-[a-z0-9-]{1,64}$/;
const RES_HEADER_DENY = new Set(['x-frame-options', 'x-content-type-options', 'x-xss-protection', 'x-powered-by', 'x-robots-tag',
  'x-dns-prefetch-control', 'x-download-options', 'x-permitted-cross-domain-policies', 'x-ua-compatible']);
const RES_HEADERS_MAX = 20;
const RES_HEADER_VALUE_MAX = 1024;
const TEXT_MAX = 64 * 1024;
const FORM_FIELDS_MAX = 10;
const FORM_FIELD_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const FORM_VALUE_MAX = 8192;
const FORM_ACTION_MAX = 2048;

class EndpointError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

/** The plugin's declaration ({ maxBodyBytes }) or null. */
function declOf(plugin) {
  const pe = plugin && plugin.manifest && plugin.manifest.permissions && plugin.manifest.permissions.publicEndpoints;
  return pe && typeof pe === 'object' ? { maxBodyBytes: Number(pe.maxBodyBytes) || 0 } : null;
}

/** The origin public endpoints are reached on: GC_BASE_URL (http or https), else null. */
function origin() {
  let u;
  try { u = new URL(String(config.app.baseUrl || '')); } catch { return null; }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password) return null;
  return u.origin;
}

/** "https://gc.example.com/plugin-public/<id>/" or null (no GC_BASE_URL). */
function baseOf(pluginId, o = origin()) { return o ? `${o}${PREFIX}${pluginId}/` : null; }

function sign(payload) {
  return crypto.createHmac('sha256', String(config.app.secret)).update('plugin-public:' + payload).digest('base64url');
}

/**
 * gc.publicEndpoints.token({ user, path, ttlS, data }) → { token, url, expiresAt (ms) }. `user`: an enabled account
 * (checked by the caller); `path`: the prefix the token opens (segments of [A-Za-z0-9._~-], ≤ 200); `ttlS`: 60 … 86400
 * (default 3600); `data`: an optional string ≤ 256 the hook gets back (e.g. "write").
 */
function mint(pluginId, { user, path, ttlS, data } = {}, now = Date.now()) {
  if (!Number.isSafeInteger(user) || user <= 0) throw new EndpointError('ERR_INVALID', 'invalid user');
  const scope = typeof path === 'string' ? path.replace(/^\/+|\/+$/g, '') : '';
  if (!scope || scope.length > SCOPE_MAX || !SCOPE_RE.test(scope) || scope.split('/').some((s) => s === '.' || s === '..')) {
    throw new EndpointError('ERR_INVALID', 'invalid path');
  }
  const ttl = ttlS == null ? TTL_DEFAULT_S : ttlS;
  if (!Number.isSafeInteger(ttl) || ttl < TTL_MIN_S || ttl > TTL_MAX_S) throw new EndpointError('ERR_INVALID', 'invalid ttlS');
  if (data != null && (typeof data !== 'string' || data.length > DATA_MAX)) throw new EndpointError('ERR_INVALID', 'invalid data');
  const exp = Math.floor(now / 1000) + ttl;
  const payload = Buffer.from(JSON.stringify({ v: 1, p: pluginId, u: user, s: scope, e: exp, d: data == null ? null : data, n: crypto.randomBytes(6).toString('base64url') })).toString('base64url');
  const token = `${payload}.${sign(payload)}`;
  const base = baseOf(pluginId);
  return { token, url: base ? base + scope : null, expiresAt: exp * 1000 };
}

/** The token of a request: ?access_token=… or Authorization: Bearer …; null when there is none. */
function tokenOf(req) {
  const q = req.query && req.query.access_token;
  if (typeof q === 'string' && q) return q;
  const h = req.headers && req.headers.authorization;
  const m = typeof h === 'string' ? /^Bearer\s+(\S+)$/i.exec(h.trim()) : null;
  return m ? m[1] : null;
}

/**
 * Check `token` for a request of plugin `pluginId` to `path` (without a leading slash) → { user, scope, data,
 * expiresAt } or null (malformed, forged, another plugin, expired, another path).
 */
function verify(pluginId, token, path, now = Date.now()) {
  if (typeof token !== 'string' || token.length > TOKEN_MAX) return null;
  const m = TOKEN_RE.exec(token);
  if (!m) return null;
  const want = Buffer.from(sign(m[1]));
  const got = Buffer.from(m[2]);
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
  let t;
  try { t = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8')); } catch { return null; }
  if (!t || t.v !== 1 || t.p !== pluginId || !Number.isSafeInteger(t.u) || t.u <= 0 || typeof t.s !== 'string' || !Number.isSafeInteger(t.e)) return null;
  const s = Math.floor(now / 1000);
  if (!(s < t.e && t.e <= s + TTL_MAX_S + 60)) return null;
  const p = String(path || '').replace(/^\/+/, '');
  if (!(p === t.s || p.startsWith(t.s + '/'))) return null;
  return { user: t.u, scope: t.s, data: typeof t.d === 'string' ? t.d : null, expiresAt: t.e * 1000 };
}

/** The request headers the plugin gets (lower case): x-… minus the proxy's and GateControl's own, content-type / -length. */
function requestHeaders(headers) {
  const out = {};
  let n = 0;
  for (const [k, v] of Object.entries(headers || {})) {
    const name = k.toLowerCase();
    if (!(name === 'content-type' || name === 'content-length' || (REQ_HEADER_RE.test(name) && !REQ_HEADER_DENY.has(name)))) continue;
    const value = Array.isArray(v) ? v.join(', ') : v;
    if (typeof value !== 'string' || value.length > REQ_HEADER_VALUE_MAX) continue;
    out[name] = value;
    if (++n >= REQ_HEADERS_MAX) break;
  }
  return out;
}

/** `path?query` without the access_token parameter (what the plugin and every log may see). */
function redactUrl(u) {
  const s = String(u || '');
  const q = s.indexOf('?');
  if (q < 0) return s;
  const kept = s.slice(q + 1).split('&').filter((x) => x && !/^access_token(?:=|$)/i.test(x));
  return s.slice(0, q) + (kept.length ? '?' + kept.join('&') : '');
}

/**
 * May a form post to `action`? Never to GateControl itself: not its public origin (GC_BASE_URL) and not the host the
 * request came to (any scheme or port) — a plugin's page on GateControl's origin must not post to its own routes
 * (same origin, with the person's cookies).
 */
function formTargetAllowed(action, requestHost, base = origin()) {
  const host = (h) => String(h || '').toLowerCase().replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  const target = host(action.hostname);
  if (!target) return false;
  if (base) { try { if (host(new URL(base).hostname) === target) return false; } catch { /* no base */ } }
  if (requestHost && host(requestHost) === target) return false;
  return true;
}

/** The plugin's answer headers that may go out: x-… names (not the browser's), single-line values. */
function answerHeaders(h) {
  const out = {};
  if (!h || typeof h !== 'object' || Array.isArray(h)) return out;
  let n = 0;
  for (const [k, v] of Object.entries(h)) {
    const name = String(k).toLowerCase();
    if (!RES_HEADER_RE.test(name) || RES_HEADER_DENY.has(name)) continue;
    const value = typeof v === 'number' && Number.isFinite(v) ? String(v) : v;
    if (typeof value !== 'string' || value.length > RES_HEADER_VALUE_MAX || /[\0-\x1f\x7f]/.test(value)) continue;
    out[name] = value;
    if (++n >= RES_HEADERS_MAX) break;
  }
  return out;
}

/** A form's action: an absolute http(s) URL without credentials, ≤ 2048, or null. */
function formAction(v) {
  if (typeof v !== 'string' || v.length > FORM_ACTION_MAX) return null;
  let u;
  try { u = new URL(v); } catch { return null; }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password) return null;
  return u;
}

/**
 * The hook's answer → { status, headers, kind: 'json'|'text'|'media'|'form'|'empty', json?, text?, mediaId?, form? }
 * or null when it is not a valid one (→ 502).
 */
function answerOf(out) {
  if (!out || typeof out !== 'object') return null;
  const status = out.status == null ? 200 : out.status;
  if (!Number.isInteger(status) || status < 200 || status > 599 || (status >= 300 && status < 400)) return null;
  const headers = answerHeaders(out.headers);
  if (out.form != null) {
    const f = out.form;
    const action = f && typeof f === 'object' ? formAction(f.action) : null;
    const fields = f && f.fields && typeof f.fields === 'object' && !Array.isArray(f.fields) ? Object.entries(f.fields) : null;
    if (!action || !fields || fields.length > FORM_FIELDS_MAX) return null;
    if (fields.some(([k, v]) => !FORM_FIELD_RE.test(k) || (typeof v !== 'string' && typeof v !== 'number') || String(v).length > FORM_VALUE_MAX)) return null;
    return { status: 200, headers, kind: 'form', form: { action, fields: fields.map(([k, v]) => [k, String(v)]) } };
  }
  if (out.media != null) {
    if (typeof out.media !== 'string' || !/^[0-9a-f]{32}$/.test(out.media)) return null;
    return { status: 200, headers, kind: 'media', mediaId: out.media };
  }
  if (out.text != null) {
    if (typeof out.text !== 'string' || Buffer.byteLength(out.text) > TEXT_MAX) return null;
    return { status, headers, kind: 'text', text: out.text };
  }
  if (out.json !== undefined) return { status, headers, kind: 'json', json: out.json };
  return { status, headers, kind: 'empty' };
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** The page of a form answer: the fields posted to the action at once (a button without script). → { html, csp } */
function formPage(form, lang) {
  const nonce = crypto.randomBytes(16).toString('base64');
  const en = lang === 'en';
  const inputs = form.fields.map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('');
  const html = '<!doctype html><html lang="' + (en ? 'en' : 'de') + '"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer">'
    + '<title>' + (en ? 'Opening …' : 'Wird geöffnet …') + '</title>'
    + '<style>body{font:16px system-ui,sans-serif;margin:3rem auto;max-width:28rem;padding:0 1rem;color:#1f2937}button{font:inherit;padding:.5rem 1rem}</style>'
    + '</head><body><form id="f" method="post" action="' + esc(form.action.href) + '">' + inputs
    + '<p>' + (en ? 'Opening …' : 'Wird geöffnet …') + '</p><noscript><button type="submit">' + (en ? 'Continue' : 'Weiter') + '</button></noscript></form>'
    + '<script nonce="' + nonce + '">document.getElementById("f").submit();</script></body></html>';
  const csp = `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; form-action ${form.action.origin}; base-uri 'none'; frame-ancestors 'none'`;
  return { html, csp };
}

module.exports = {
  PREFIX, TTL_MIN_S, TTL_MAX_S, TTL_DEFAULT_S, EndpointError,
  declOf, origin, baseOf, mint, tokenOf, verify, requestHeaders, answerHeaders, answerOf, formPage, redactUrl, formTargetAllowed,
};
