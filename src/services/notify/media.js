'use strict';

// Pictures of plugin pushes (docs/plugins.md "Notifications"):
//
//   gc.notify({ …, image: { data: '<base64>', mime: 'image/jpeg' } })
//
// PNG, JPEG or WebP, at most 300 KB decoded, any aspect ratio, each side
// 32…2560 px, no animation — only the header is parsed (the parsers of
// services/avatars.js), the picture is stored as sent. Each picture gets a
// random id (24 url-safe characters) and is served without login at the
// capability URL /notify-media/<id>.<ext> (routes/index.js, like
// /avatars/) until it expires: the push's ttl, 24 h by default, 7 days at
// most. Expired pictures answer 404; the hourly clean-up of the notification
// center (retention.js) deletes them. The activity log never gets the image.

const crypto = require('node:crypto');
const { getDb } = require('../../db/connection');
const store = require('./store');

const MAX_BYTES = 300 * 1024;
const MIN_SIDE = 32;
const MAX_SIDE = 2560;
const DEFAULT_TTL_S = 24 * 3600;
const MAX_TTL_S = 7 * 24 * 3600;
const TYPES = Object.freeze({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' });
// id: 18 random bytes → 24 url-safe characters (base64url).
const ID_BYTES = 18;
const FILE_RE = /^([A-Za-z0-9_-]{22,64})\.(png|jpg|webp)$/;
const PATH = '/notify-media/';
// base64 (standard or url-safe alphabet, optional padding), whitespace allowed
const B64_RE = /^[A-Za-z0-9+/_\-\s]*={0,2}\s*$/;

function invalid(reason) {
  const err = new Error(`invalid image: ${reason}`);
  err.code = 'ERR_INVALID';
  err.reason = reason;
  return err;
}

/**
 * Check `image` of a gc.notify() call: { data: base64 string, mime }. Returns
 * { mime, ext, width, height, bytes, buf } or throws ERR_INVALID with
 * err.reason one of 'invalid' | 'mime' | 'empty' | 'too_large' | 'format' |
 * 'animated' | 'mime_mismatch' | 'too_small' | 'too_big'.
 */
function validate(image) {
  if (!image || typeof image !== 'object' || Array.isArray(image)) throw invalid('invalid');
  const { data, mime } = image;
  if (typeof mime !== 'string' || !Object.prototype.hasOwnProperty.call(TYPES, mime)) throw invalid('mime');
  if (typeof data !== 'string' || !data.length) throw invalid('empty');
  // a data: URL of the same type is accepted too
  const prefix = `data:${mime};base64,`;
  const b64 = data.startsWith(prefix) ? data.slice(prefix.length) : data;
  // 4 base64 characters carry 3 bytes — refuse the obviously too large before decoding
  if (b64.length > Math.ceil(MAX_BYTES / 3) * 4 + 4096) throw invalid('too_large');
  if (!B64_RE.test(b64)) throw invalid('format');
  const buf = Buffer.from(b64, 'base64');
  if (!buf.length) throw invalid('empty');
  if (buf.length > MAX_BYTES) throw invalid('too_large');
  const info = require('../avatars').parseImage(buf);
  if (info.mime !== mime) throw invalid('mime_mismatch');
  if (info.width < MIN_SIDE || info.height < MIN_SIDE) throw invalid('too_small');
  if (info.width > MAX_SIDE || info.height > MAX_SIDE) throw invalid('too_big');
  return { mime: info.mime, ext: TYPES[info.mime], width: info.width, height: info.height, bytes: buf.length, buf };
}

function urlOf(id, mime) {
  return id && TYPES[mime] ? `${PATH}${id}.${TYPES[mime]}` : null;
}

/** Lifetime of a picture in seconds: the push's ttl, else 24 h; at most 7 days. */
function ttlOf(ttlS) {
  return Number.isSafeInteger(ttlS) && ttlS > 0 ? Math.min(ttlS, MAX_TTL_S) : DEFAULT_TTL_S;
}

/**
 * Store a validated picture (validate()'s result). Returns
 * { id, url, expiresAt } — expiresAt ISO UTC like the notifications.
 */
function save(img, ttlS) {
  const id = crypto.randomBytes(ID_BYTES).toString('base64url');
  const createdAt = store.iso();
  const expiresAt = store.iso(store.now() + ttlOf(ttlS) * 1000);
  getDb().prepare('INSERT INTO notify_media (id, mime, data, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, img.mime, img.buf, createdAt, expiresAt);
  return { id, url: urlOf(id, img.mime), expiresAt };
}

/**
 * The picture behind /notify-media/<file> ({ mime, data, expiresAt, maxAge
 * (seconds left) }) or null (unknown, expired).
 */
function getFile(file) {
  const m = FILE_RE.exec(String(file || ''));
  if (!m) return null;
  const row = getDb().prepare('SELECT mime, data, expires_at FROM notify_media WHERE id = ?').get(m[1]);
  if (!row || TYPES[row.mime] !== m[2] || !(row.expires_at > store.iso())) return null;
  const maxAge = Math.max(0, Math.floor((Date.parse(row.expires_at) - store.now()) / 1000));
  return { mime: row.mime, data: row.data, expiresAt: row.expires_at, maxAge };
}

/** Delete expired pictures. → number of rows removed. */
function cleanup() {
  return getDb().prepare('DELETE FROM notify_media WHERE expires_at <= ?').run(store.iso()).changes;
}

module.exports = {
  MAX_BYTES, MIN_SIDE, MAX_SIDE, DEFAULT_TTL_S, MAX_TTL_S, TYPES, PATH,
  validate, urlOf, ttlOf, save, getFile, cleanup,
};
