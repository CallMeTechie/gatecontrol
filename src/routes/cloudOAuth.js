'use strict';

/**
 * Cloud accounts: connecting Google Drive / OneDrive (docs/cloud-accounts.md,
 * services/cloudAccounts/). Both on GC_BASE_URL — the callback is the
 * redirect URI the administrator registers at Google and Microsoft.
 *
 *   GET /oauth/cloud/start?flow=<id>
 *       a person's connection (gc.cloud.connectUrl): a page that says who
 *       connects which provider for which plugin, with "Weiter"; the link is
 *       single use and valid for 10 minutes. A storage target's connection
 *       (the administrator's own) goes on at once — only for the
 *       administrator who started it.
 *   GET /oauth/cloud/start?flow=<id>&go=1
 *       starts the flow (once): binds it to this browser with the cookie
 *       gc.cloud (HttpOnly, SameSite=Lax, path /oauth/cloud, 10 minutes) and
 *       sends it to the provider (state, PKCE S256).
 *   GET /oauth/cloud/callback?state=…&code=… | &error=…
 *       checks state, the cookie and the age, redeems the code, stores the
 *       connection (or the storage target's draft) and moves on with a page
 *       (meta refresh): the person to returnTo with ?cloud=connected |
 *       ?cloud=error&cloudError=<code>, the administrator to
 *       /settings/plugins/storage?cloudDraft=<id> (or the error).
 *
 * The session cookie is SameSite=Strict and not sent on the redirect back
 * from the provider: the callback relies on state + the Lax cookie only.
 * Codes, tokens and states are never logged.
 */

const config = require('../../config/default');
const cloud = require('../services/cloudAccounts');
const logger = require('../utils/logger');
const activity = require('../services/activity');

const COOKIE = 'gc.cloud';
const COOKIE_PATH = '/oauth/cloud';
const NAMES = { google: 'Google Drive', microsoft: 'OneDrive' };

function cookieOpts() {
  return { httpOnly: true, secure: String(config.app.baseUrl || '').startsWith('https'), sameSite: 'lax', path: COOKIE_PATH, maxAge: cloud.FLOW_TTL_MS };
}

function page(res, status, o) {
  res.set('Cache-Control', 'no-store');
  res.set('Referrer-Policy', 'no-referrer');
  return res.status(status).render(`${res.locals.theme}/pages/cloud-connect.njk`, Object.assign({ layout: false, title: res.locals.t('cloud.connect.title'), target: null }, o));
}

function invalid(res) {
  return page(res, 400, { mode: 'invalid', message: res.locals.t('cloud.connect.invalid_text') });
}

function personName(uid) {
  try {
    const u = require('../db/connection').getDb().prepare('SELECT username, display_name FROM users WHERE id = ?').get(uid);
    return u ? (u.display_name || u.username) : '';
  } catch { return ''; }
}

function pluginName(id, lang) {
  try {
    const p = require('../services/plugins/registry').get(id);
    const n = p && p.manifest && p.manifest.name;
    return n ? (typeof n === 'string' ? n : (lang === 'en' ? n.en : n.de) || n.de || n.en) : id;
  } catch { return id; }
}

function isSessionAdmin(req, uid) {
  if (!req.session || req.session.userId !== uid) return false;
  try { return require('../middleware/auth').isAdminSession(req); } catch { return false; }
}

function start(req, res) {
  const q = req.query || {};
  const f = cloud.pendingFlow(typeof q.flow === 'string' ? q.flow : '');
  if (!f) return invalid(res);
  if (f.purpose === 'target' && !isSessionAdmin(req, f.userId)) return invalid(res);
  if (f.purpose === 'import' && q.go !== '1') {
    const lang = res.locals.language === 'en' ? 'en' : 'de';
    return page(res, 200, {
      mode: 'confirm', provider: f.provider,
      message: res.locals.t('cloud.connect.confirm_text', { provider: NAMES[f.provider], person: personName(f.userId), plugin: pluginName(f.pluginId, lang) }),
      next: `/oauth/cloud/start?flow=${encodeURIComponent(f.id)}&go=1`,
      providerName: NAMES[f.provider],
    });
  }
  let b;
  try { b = cloud.begin(f.id); } catch (e) {
    logger.warn({ code: e.code, provider: f.provider }, 'cloud connection could not start');
    return invalid(res);
  }
  res.cookie(COOKIE, b.binding, cookieOpts());
  res.set('Cache-Control', 'no-store');
  res.set('Referrer-Policy', 'no-referrer');
  return res.redirect(b.url);
}

async function callback(req, res) {
  const q = req.query || {};
  const binding = req.cookies ? req.cookies[COOKIE] : null;
  res.clearCookie(COOKIE, { path: COOKIE_PATH });
  const str = (v) => (typeof v === 'string' ? v : '');
  try {
    const r = await cloud.complete({ state: str(q.state), code: str(q.code), error: str(q.error), binding: str(binding) });
    const f = r.flow;
    if (f.purpose === 'target') {
      return page(res, 200, { mode: 'done', message: res.locals.t('cloud.connect.done_admin', { provider: NAMES[f.provider] }), target: `/settings/plugins/storage?cloudDraft=${encodeURIComponent(r.draft)}` });
    }
    try {
      activity.log('cloud_connected', `${NAMES[f.provider]} connected for ${f.pluginId}`, { source: 'system', ipAddress: req.ip, severity: 'info',
        details: { provider: f.provider, plugin: f.pluginId, userId: f.userId } });
    } catch { /* logging must not break the answer */ }
    return page(res, 200, { mode: 'done', message: res.locals.t('cloud.connect.done_text', { provider: NAMES[f.provider] }), target: cloud.returnUrl(f.returnTo, { ok: true }) });
  } catch (e) {
    const f = e && e.flow;
    logger.warn({ code: e && e.code, reason: e && e.reason, provider: f ? f.provider : null, purpose: f ? f.purpose : null }, 'cloud connection failed');
    if (!f) return invalid(res);
    const code = String((e && e.code) || 'ERR_CLOUD_PROVIDER');
    const msgKey = `cloud.connect.error.${code}`;
    const msg = res.locals.t(msgKey);
    const message = msg && msg !== msgKey ? msg : res.locals.t('cloud.connect.error.failed');
    const target = f.purpose === 'target' ? `/settings/plugins/storage?cloud=error&cloudError=${encodeURIComponent(code)}` : cloud.returnUrl(f.returnTo, { ok: false, code });
    return page(res, 200, { mode: 'error', message, target });
  }
}

module.exports = { start, callback, COOKIE, COOKIE_PATH };
