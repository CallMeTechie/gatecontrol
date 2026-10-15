'use strict';

/**
 * Profile picture and favourite colour endpoints (docs/feature-avatars.md),
 * shared by every place that changes them:
 *
 *   /api/v1/client/me/{profile,avatar,color}   the apps (device token)
 *   /api/v1/users/:id/{avatar,color}           administrator (session + CSRF)
 *   /api/v1/profile/{avatar,color}             own account (session + CSRF)
 *   /api/v1/me/{profile,avatar,color}          own account, "Mein Bereich"
 *   /api/v1/portal/me/{profile,avatar,color}   portal session (CSRF; never kiosk)
 *
 *   GET    …/profile → { ok, user: { id, name, initials, color, colorHex, avatarUrl|null }, palette: [{ key, hex }] }
 *   PUT    …/avatar  raw body, Content-Type image/png | image/jpeg | image/webp, ≤ 96 KB → { ok, avatarUrl }
 *   DELETE …/avatar  → { ok }
 *   PUT    …/color   { color: key | null } → { ok, color, colorHex }
 *
 * Errors: { ok: false, code, error[, reason | field] } —
 *   415 UNSUPPORTED_TYPE   other Content-Type
 *   413 TOO_LARGE          body over 96 KB
 *   400 INVALID_IMAGE      reason: empty | format | animated | not_square | too_small | too_big | too_large
 *   400 INVALID_COLOR      field: 'color' (unknown key, red included)
 *   404 NOT_FOUND          unknown user
 * The raw body parser runs only on PUT …/avatar (avatarUpload), after the
 * caller's guard.
 */

const express = require('express');
const avatars = require('../../services/avatars');
const logger = require('../../utils/logger');

const UPLOAD_TYPES = Object.keys(avatars.TYPES);
const rawImage = express.raw({ type: UPLOAD_TYPES, limit: avatars.MAX_BYTES });

function fail(req, res, status, code, key, extra) {
  return res.status(status).json({ ok: false, code, error: req.t ? req.t(key) : code, ...(extra || {}) });
}

/** Raw image body (only on the upload routes): Content-Type and size first. */
function avatarUpload(req, res, next) {
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (!UPLOAD_TYPES.includes(type)) return fail(req, res, 415, 'UNSUPPORTED_TYPE', 'avatar.err.type');
  return rawImage(req, res, (err) => {
    if (err) {
      if (err.type === 'entity.too.large') return fail(req, res, 413, 'TOO_LARGE', 'avatar.err.too_large');
      return fail(req, res, 400, 'INVALID_IMAGE', 'avatar.err.format', { reason: 'format' });
    }
    if (!Buffer.isBuffer(req.body)) return fail(req, res, 400, 'INVALID_IMAGE', 'avatar.err.empty', { reason: 'empty' });
    return next();
  });
}

/** Map a service error to a response. */
function sendError(req, res, err, what) {
  if (err && err.code === 'NOT_FOUND') return fail(req, res, 404, 'NOT_FOUND', 'error.users.not_found');
  if (err && err.code === 'ERR_INVALID') {
    if (err.reason === 'color') return fail(req, res, 400, 'INVALID_COLOR', 'avatar.err.color', { field: 'color' });
    return fail(req, res, 400, 'INVALID_IMAGE', `avatar.err.${err.reason}`, { reason: err.reason });
  }
  logger.error({ err: err && err.message }, `avatar: ${what} failed`);
  return fail(req, res, 500, 'INTERNAL', 'avatar.err.failed');
}

/**
 * Handlers for one way of naming the user: `userIdOf(req)` returns the id
 * (the caller's guard has made sure there is one), `opts(req)` the
 * { actorId, ip, source } of the activity log.
 */
function handlers(userIdOf, opts) {
  return {
    profile(req, res) {
      res.set('Cache-Control', 'no-store');
      const p = avatars.profileOf(userIdOf(req));
      if (!p) return fail(req, res, 404, 'NOT_FOUND', 'error.users.not_found');
      return res.json({ ok: true, ...p });
    },
    putAvatar(req, res) {
      try {
        const r = avatars.set(userIdOf(req), req.body, opts(req));
        return res.json({ ok: true, avatarUrl: r.avatarUrl });
      } catch (err) { return sendError(req, res, err, 'upload'); }
    },
    deleteAvatar(req, res) {
      try {
        avatars.remove(userIdOf(req), opts(req));
        return res.json({ ok: true });
      } catch (err) { return sendError(req, res, err, 'removal'); }
    },
    putColor(req, res) {
      const body = req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body) ? req.body : {};
      if (!Object.prototype.hasOwnProperty.call(body, 'color')) return fail(req, res, 400, 'INVALID_COLOR', 'avatar.err.color', { field: 'color' });
      try {
        const r = avatars.setColor(userIdOf(req), body.color, opts(req));
        return res.json({ ok: true, color: r.color, colorHex: r.colorHex });
      } catch (err) { return sendError(req, res, err, 'colour change'); }
    },
  };
}

module.exports = { avatarUpload, sendError, handlers, UPLOAD_TYPES };
