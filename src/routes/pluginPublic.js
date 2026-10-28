'use strict';

// Public endpoints of plugins (docs/plugins.md "Public endpoints", services/plugins/publicEndpoints.js, since
// 1.211.0) — no session, no cookies, no CSRF; mounted in routes/index.js before every authenticated route:
//
//   GET|HEAD|POST|PUT /plugin-public/<plugin id>/<path>?access_token=<token>   (or Authorization: Bearer <token>)
//
// Only plugins that declare permissions.publicEndpoints; only with a token that plugin minted for <path> (or a
// prefix of it), still valid, for an enabled account — else 404 (unknown plugin) / 401 (no or a wrong token), and
// both count in a small bucket per address (pluginPublicFailLimiter). A body (POST / PUT) goes to the media store
// as an unclaimed file of the token's person, up to the plugin's maxBodyBytes (Content-Length required); the hook
// publicRequest gets { method, path, query, headers, user, token, body, url, originalUrl } and answers JSON, text,
// one of its media files (Range works) or a form page (posted to an http(s) address, e.g. an office editor). An
// upload the plugin did not keep (an error, status ≥ 400, not claimed) is deleted at once.

const { Router } = require('express');
const plugins = require('../services/plugins');
const media = require('../services/plugins/media');
const pe = require('../services/plugins/publicEndpoints');
const { ID_RE } = require('../services/plugins/constants');
const { pluginPublicLimiter, pluginPublicFailLimiter } = require('../middleware/rateLimit');
const logger = require('../utils/logger');

const router = Router();
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT']);
const PATH_RE = /^[A-Za-z0-9._~!$&'()*+,;=:@%-]+(?:\/[A-Za-z0-9._~!$&'()*+,;=:@%-]+)*$/;

function db() { return require('../db/connection').getDb(); }

/** Headers of every answer: nothing cached, nothing sniffed or framed, no referrer. */
function baseHeaders(res) {
  res.set('Cache-Control', 'no-store');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
}

function plain(res, status, text) {
  baseHeaders(res);
  res.set('Content-Security-Policy', "default-src 'none'; sandbox");
  return res.status(status).type('text/plain').send(text);
}

/** The query without the token (a plain object of strings, ≤ 50 keys). */
function queryOf(q) {
  const out = {};
  let n = 0;
  for (const [k, v] of Object.entries(q || {})) {
    if (k === 'access_token' || typeof v !== 'string' || k.length > 100 || v.length > 2000) continue;
    out[k] = v;
    if (++n >= 50) break;
  }
  return out;
}

/** Does the request carry a body? (Content-Length > 0, or chunked) */
function hasBody(req) {
  if (req.headers['transfer-encoding']) return true;
  const n = Number(req.headers['content-length']);
  return Number.isFinite(n) && n > 0;
}

/** A body of a public endpoint → an unclaimed media file of `owner`; throws { status, code }. */
async function storeBody(p, decl, req, owner) {
  if (req._body) throw Object.assign(new Error('unsupported_type'), { status: 415, code: 'unsupported_type' }); // parsed as JSON / form already
  if (!decl.maxBodyBytes || !media.declOf(p)) throw Object.assign(new Error('too_large'), { status: 413, code: 'too_large' });
  const length = media.contentLength(req);
  if (length > decl.maxBodyBytes) throw Object.assign(new Error('too_large'), { status: 413, code: 'too_large' });
  const out = await media.storeFromLink(p, req, { mime: 'application/octet-stream', length, owner, name: null });
  const r = media.row(p.id, out.mediaId);
  return { mediaId: out.mediaId, bytes: out.bytes, mime: out.mime, sha256: r ? r.sha256 : null };
}

/** Drop an upload the plugin did not keep. */
function dropUnclaimed(pluginId, upload) {
  if (!upload) return;
  try {
    const r = media.row(pluginId, upload.mediaId);
    if (r && r.ref_count === 0) media.remove(pluginId, upload.mediaId);
  } catch (e) { logger.warn({ plugin: pluginId, err: e.message }, 'public endpoint: dropping an upload failed'); }
}

router.all('/plugin-public/:id/*', pluginPublicFailLimiter, pluginPublicLimiter, async (req, res) => {
  const id = String(req.params.id || '');
  const p = ID_RE.test(id) && id.length <= 64 ? plugins.get(id) : null;
  const decl = p ? pe.declOf(p) : null;
  if (!decl) return plain(res, 404, 'not found');
  if (!METHODS.has(req.method)) return plain(res, 405, 'method not allowed');
  const path = String(req.params[0] || '');
  if (path.length > 1000 || !PATH_RE.test(path) || path.split('/').some((s) => s === '..' || s === '.')) return plain(res, 404, 'not found');
  const tok = pe.verify(p.id, pe.tokenOf(req), path);
  const user = tok ? db().prepare('SELECT id, username, display_name, role FROM users WHERE id = ? AND enabled = 1').get(tok.user) : null;
  if (!tok || !user) return plain(res, 401, 'unauthorized');

  let upload = null;
  if ((req.method === 'POST' || req.method === 'PUT') && hasBody(req)) {
    try { upload = await storeBody(p, decl, req, user.id); } catch (e) {
      const status = e && Number.isInteger(e.status) ? e.status : 500;
      if (status === 500) logger.warn({ plugin: p.id, err: e && e.message }, 'public endpoint: storing the body failed');
      return plain(res, status, (e && e.code) || 'error');
    }
  }

  let ans;
  const base = pe.origin();
  try {
    const out = await plugins.publicRequest(p.id, {
      method: req.method, path: '/' + path, query: queryOf(req.query), headers: pe.requestHeaders(req.headers),
      user: { id: user.id, name: user.display_name || user.username, role: user.role },
      token: { scope: tok.scope, data: tok.data, expiresAt: tok.expiresAt },
      body: upload, url: base ? base + req.originalUrl : null, originalUrl: req.originalUrl,
      lang: /^en\b/i.test(String(req.headers['accept-language'] || '')) ? 'en' : 'de',
    });
    ans = pe.answerOf(out);
  } catch (e) {
    dropUnclaimed(p.id, upload);
    const code = e && e.code;
    return plain(res, code === 'ERR_NOT_RUNNING' ? 503 : (code === 'ERR_TIMEOUT' ? 504 : 502), 'plugin unavailable');
  }
  if (!ans) {
    dropUnclaimed(p.id, upload);
    return plain(res, 502, 'invalid plugin answer');
  }
  if (ans.status >= 400) dropUnclaimed(p.id, upload);

  baseHeaders(res);
  for (const [k, v] of Object.entries(ans.headers)) res.set(k, v);
  if (ans.kind === 'media') {
    const r = media.row(p.id, ans.mediaId);
    if (!r) return plain(res, 404, 'not found');
    return media.send(req, res, r, 'no-store', { attachment: true });
  }
  if (ans.kind === 'form') {
    const page = pe.formPage(ans.form, /^en\b/i.test(String(req.headers['accept-language'] || '')) ? 'en' : 'de');
    res.set('Content-Security-Policy', page.csp);
    res.set('X-Frame-Options', 'DENY');
    return res.status(200).type('text/html').send(page.html);
  }
  res.set('Content-Security-Policy', "default-src 'none'; sandbox");
  if (ans.kind === 'json') return res.status(ans.status).json(ans.json);
  if (ans.kind === 'text') return res.status(ans.status).type('text/plain').send(ans.text);
  return res.status(ans.status).end();
});

module.exports = router;
