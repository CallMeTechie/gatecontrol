'use strict';

/**
 * The own profile (docs/feature-user-profile.md, services/profile.js), shared by every place a person keeps it:
 *
 *   /api/v1/me/profile…          web session (administrators and "Mein Bereich")
 *   /api/v1/portal/me/profile…   portal session — also members without "Mein Bereich" (never a kiosk device)
 *   /api/v1/client/me/profile…   the apps (device token, scope client)
 *
 * Always the signed-in person; no user id from the request.
 *
 *   GET    …/profile                       { ok, user, palette, profile }   (user/palette: picture and colour as before)
 *   PATCH  …/profile                       { displayName?, firstName?, lastName?, about?, birthday?, email?, language?,
 *                                            timezone?, visibility?, recognition? } → { ok, profile }
 *   POST   …/profile/phones                { kind, number, visibility?, useForRecognition? } → { ok, phone, profile }
 *   PATCH  …/profile/phones/:id            { kind?, number?, visibility?, useForRecognition? } → { ok, phone, profile }
 *   DELETE …/profile/phones/:id            → { ok, profile }
 *   POST   …/profile/emails                { address } → { ok, email, codeSent, profile }
 *   POST   …/profile/emails/:id/confirm    { code } → { ok, email, profile }
 *   POST   …/profile/emails/:id/resend     → { ok, email, codeSent, profile }
 *   DELETE …/profile/emails/:id            → { ok, profile }
 *   GET    …/profile/export                the JSON file "Meine Daten" (Content-Disposition: attachment)
 *
 * "Meine Orte" (services/places.js, docs/feature-user-profile.md "Meine Orte"):
 *   GET    …/profile/places[?shared=1]     { ok, places, family, limits, options, search[, shared] }
 *   POST   …/profile/places                { name, lat, lon, icon?, radiusM?, address?, visibility? } → 201 { ok, place }
 *   GET    …/profile/places/:id            { ok, place }
 *   PATCH  …/profile/places/:id            the same fields, each optional (lat and lon together) → { ok, place }
 *   DELETE …/profile/places/:id[?force=1]  → { ok, deleted: true, id } | 409 IN_USE { usedBy } without force
 *   POST   …/profile/places/:id/used       → { ok, place } (lastUsedAt now)
 *   GET    …/places/search?q=&near=lat,lon → { ok, results: [{ name, address, lat, lon, source, distanceM? }], attribution }
 *
 * Errors { ok: false, code, error[, field] }: 400 INVALID (field), 400 WRONG_CODE, 403 PHONES_OFF | SEARCH_OFF,
 * 404 NOT_FOUND, 409 LIMIT | DUPLICATE (field) | LOCKED (field, from the directory) | NO_MAIL | IN_USE (usedBy),
 * 410 CODE_EXPIRED, 429 RATE_LIMITED (retryAfter for the search), 503 SEARCH_UNAVAILABLE.
 */

const profile = require('../../services/profile');
const places = require('../../services/places');
const placeSearch = require('../../services/placeSearch');
const avatars = require('../../services/avatars');
const logger = require('../../utils/logger');

const CODES = {
  ERR_INVALID: [400, 'INVALID', 'myprofile.err.invalid'],
  ERR_CODE: [400, 'WRONG_CODE', 'myprofile.err.wrong_code'],
  ERR_PHONES_OFF: [403, 'PHONES_OFF', 'myprofile.err.phones_off'],
  ERR_NOT_FOUND: [404, 'NOT_FOUND', 'myprofile.err.not_found'],
  ERR_LIMIT: [409, 'LIMIT', 'myprofile.err.limit'],
  ERR_DUPLICATE: [409, 'DUPLICATE', 'myprofile.err.duplicate'],
  ERR_LOCKED: [409, 'LOCKED', 'myprofile.err.locked'],
  ERR_NO_MAIL: [409, 'NO_MAIL', 'myprofile.err.no_mail'],
  ERR_CODE_EXPIRED: [410, 'CODE_EXPIRED', 'myprofile.err.code_expired'],
  ERR_RATE_LIMIT: [429, 'RATE_LIMITED', 'myprofile.err.rate_limited'],
  // "Meine Orte"
  ERR_IN_USE: [409, 'IN_USE', 'myprofile.places.err.in_use'],
  ERR_SEARCH_OFF: [403, 'SEARCH_OFF', 'myprofile.places.err.search_off'],
  ERR_UNAVAILABLE: [503, 'SEARCH_UNAVAILABLE', 'myprofile.places.err.search_unavailable'],
};

function sendError(req, res, err, what) {
  const m = err && CODES[err.code];
  if (m) {
    // "Meine Orte" and its search have texts of their own (myprofile.places.err.*), else the profile's
    const pre = err.i18nPrefix || null;
    const tries = [];
    if (pre && err.code === 'ERR_INVALID' && err.field) tries.push(`${pre}invalid_${err.field}`);
    if (pre) tries.push(`${pre}${m[1].toLowerCase()}`);
    if (!pre && err.code === 'ERR_INVALID' && err.field) tries.push(`myprofile.err.invalid_${err.field}`);
    tries.push(m[2]);
    let msg = m[1];
    if (req.t) {
      for (const k of tries) { const v = req.t(k); if (v !== k) { msg = v; break; } }
    }
    if (err.retryAfter) res.set('Retry-After', String(err.retryAfter));
    return res.status(m[0]).json({
      ok: false, code: m[1], error: msg, ...(err.field ? { field: err.field } : {}),
      ...(Array.isArray(err.usedBy) ? { usedBy: err.usedBy } : {}), ...(err.retryAfter ? { retryAfter: err.retryAfter } : {}),
    });
  }
  logger.error({ err: err && err.message }, `profile: ${what} failed`);
  return res.status(500).json({ ok: false, code: 'INTERNAL', error: req.t ? req.t('myprofile.err.failed') : 'failed' });
}

function body(req) { return req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body) ? req.body : {}; }

/** Before the own view: what the person's own linked messenger login says now (kept 10 minutes; never blocks long). */
async function refreshOwn(userId) {
  try {
    const br = require('../../services/bridges');
    // stage 7a: every network of the bridges (WhatsApp, Signal)
    if (typeof br.refreshOwnNumbers === 'function') for (const n of br.NETWORKS || ['whatsapp']) await br.refreshOwnNumbers(userId, n);
  } catch { /* the bridge is not there — the stored state stays */ }
}

/**
 * Handlers for one way of naming the person: `userIdOf(req)` (the caller's guard made sure there is one), `opts(req)`
 * the { ip, source, actorId } of the activity log.
 */
function handlers(userIdOf, opts) {
  const ctx = (req) => ({ ...opts(req), lang: req.language === 'en' ? 'en' : 'de' });
  const view = (req) => profile.ownView(userIdOf(req));
  return {
    async get(req, res) {
      res.set('Cache-Control', 'no-store');
      try {
        const uid = userIdOf(req);
        await refreshOwn(uid);
        const look = avatars.profileOf(uid);
        if (!look) return sendError(req, res, new profile.ProfileError('ERR_NOT_FOUND'), 'read');
        return res.json({ ok: true, ...look, profile: profile.ownView(uid) });
      } catch (err) { return sendError(req, res, err, 'read'); }
    },
    patch(req, res) {
      try { return res.json({ ok: true, profile: profile.update(userIdOf(req), body(req), ctx(req)) }); } catch (err) { return sendError(req, res, err, 'update'); }
    },
    addPhone(req, res) {
      try {
        const phone = profile.addPhone(userIdOf(req), body(req), ctx(req));
        return res.status(201).json({ ok: true, phone, profile: view(req) });
      } catch (err) { return sendError(req, res, err, 'adding a number'); }
    },
    updatePhone(req, res) {
      try {
        const phone = profile.updatePhone(userIdOf(req), req.params.id, body(req), ctx(req));
        return res.json({ ok: true, phone, profile: view(req) });
      } catch (err) { return sendError(req, res, err, 'changing a number'); }
    },
    removePhone(req, res) {
      try { profile.removePhone(userIdOf(req), req.params.id, ctx(req)); return res.json({ ok: true, profile: view(req) }); } catch (err) { return sendError(req, res, err, 'removing a number'); }
    },
    async addEmail(req, res) {
      try {
        const r = await profile.addEmail(userIdOf(req), body(req), ctx(req));
        return res.status(201).json({ ok: true, ...r, profile: view(req) });
      } catch (err) { return sendError(req, res, err, 'adding an address'); }
    },
    confirmEmail(req, res) {
      try {
        const email = profile.confirmEmail(userIdOf(req), req.params.id, body(req).code, ctx(req));
        return res.json({ ok: true, email, profile: view(req) });
      } catch (err) { return sendError(req, res, err, 'confirming an address'); }
    },
    async resendEmail(req, res) {
      try {
        const r = await profile.resendCode(userIdOf(req), req.params.id, ctx(req));
        return res.json({ ok: true, ...r, profile: view(req) });
      } catch (err) { return sendError(req, res, err, 'sending a code'); }
    },
    removeEmail(req, res) {
      try { profile.removeEmail(userIdOf(req), req.params.id, ctx(req)); return res.json({ ok: true, profile: view(req) }); } catch (err) { return sendError(req, res, err, 'removing an address'); }
    },
    async exportData(req, res) {
      try {
        const data = await profile.exportFor(userIdOf(req), ctx(req));
        const day = new Date().toISOString().slice(0, 10);
        res.set('Cache-Control', 'no-store');
        res.set('Content-Type', 'application/json; charset=utf-8');
        res.set('Content-Disposition', `attachment; filename="gatecontrol-meine-daten-${day}.json"`);
        return res.send(JSON.stringify(data, null, 2));
      } catch (err) { return sendError(req, res, err, 'export'); }
    },
    // ── "Meine Orte" ──
    listPlaces(req, res) {
      res.set('Cache-Control', 'no-store');
      try {
        const uid = userIdOf(req);
        const c = ctx(req);
        const out = { ok: true, ...places.listOwn(uid, c), search: placeSearch.available() };
        if (req.query && (req.query.shared === '1' || req.query.shared === 'true')) {
          out.shared = places.visibleTo(uid, { lang: c.lang }).filter((p) => !p.own);
        }
        return res.json(out);
      } catch (err) { return sendError(req, res, err, 'listing places'); }
    },
    getPlace(req, res) {
      res.set('Cache-Control', 'no-store');
      try { return res.json({ ok: true, place: places.getOwn(userIdOf(req), req.params.id, ctx(req)) }); } catch (err) { return sendError(req, res, err, 'reading a place'); }
    },
    addPlace(req, res) {
      try { return res.status(201).json({ ok: true, place: places.create(userIdOf(req), body(req), ctx(req)) }); } catch (err) { return sendError(req, res, err, 'adding a place'); }
    },
    updatePlace(req, res) {
      try { return res.json({ ok: true, place: places.update(userIdOf(req), req.params.id, body(req), ctx(req)) }); } catch (err) { return sendError(req, res, err, 'changing a place'); }
    },
    removePlace(req, res) {
      try {
        const force = req.query && (req.query.force === '1' || req.query.force === 'true');
        const r = places.remove(userIdOf(req), req.params.id, { force }, ctx(req));
        return res.json({ ok: true, deleted: true, id: r.id });
      } catch (err) { return sendError(req, res, err, 'removing a place'); }
    },
    usedPlace(req, res) {
      try { return res.json({ ok: true, place: places.markUsed(userIdOf(req), req.params.id, ctx(req)) }); } catch (err) { return sendError(req, res, err, 'marking a place used'); }
    },
    async searchPlaces(req, res) {
      res.set('Cache-Control', 'no-store');
      try {
        const q = typeof req.query.q === 'string' ? req.query.q : '';
        const near = typeof req.query.near === 'string' ? req.query.near : null;
        const r = await placeSearch.search({ q, near, lang: ctx(req).lang, userId: userIdOf(req) });
        return res.json({ ok: true, results: r.results, attribution: r.attribution });
      } catch (err) { return sendError(req, res, err, 'searching an address'); }
    },
  };
}

/**
 * Mount the endpoints on `router` (GET /profile is the caller's — it already serves picture and colour). `write`
 * before every changing request (and the export), `read` before the reading ones of "Meine Orte" and the search.
 */
function mount(router, h, { write = [], guard = [], read = [] } = {}) {
  const w = [...write, ...guard];
  const r = [...read, ...guard];
  router.patch('/profile', ...w, h.patch);
  router.post('/profile/phones', ...w, h.addPhone);
  router.patch('/profile/phones/:id', ...w, h.updatePhone);
  router.delete('/profile/phones/:id', ...w, h.removePhone);
  router.post('/profile/emails', ...w, h.addEmail);
  router.post('/profile/emails/:id/confirm', ...w, h.confirmEmail);
  router.post('/profile/emails/:id/resend', ...w, h.resendEmail);
  router.delete('/profile/emails/:id', ...w, h.removeEmail);
  router.get('/profile/export', ...w, h.exportData);
  router.get('/profile/places', ...r, h.listPlaces);
  router.post('/profile/places', ...w, h.addPlace);
  router.get('/profile/places/:id', ...r, h.getPlace);
  router.patch('/profile/places/:id', ...w, h.updatePlace);
  router.delete('/profile/places/:id', ...w, h.removePlace);
  router.post('/profile/places/:id/used', ...w, h.usedPlace);
  router.get('/places/search', ...r, h.searchPlaces);
}

module.exports = { handlers, mount, sendError };
