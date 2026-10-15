'use strict';

// Profile pictures and favourite colours (docs/feature-avatars.md).
//
// Picture: square PNG, JPEG or WebP, 64…512 px, at most 96 KB, stored as sent
// after validation (only the header is parsed — no decoder, no re-encoding;
// the apps and the browser pages downscale to 256×256 before uploading).
// Animated WebP and APNG are refused. Every change gets a new random
// avatar_id: the picture is served at the capability URL
// /avatars/<avatar_id>.<ext> (routes/index.js, no login — the URL is the
// secret, like the plugin tile assets) and can be cached forever; removing
// the picture deletes the row, so the old URL answers 404.
//
// Favourite colour: one key of PALETTE (red is not offered — the red ring
// means "away"). Unset → derived from the user id (PALETTE[id % 10]), so
// `color` is never null in an answer.
//
// The activity log gets avatar_changed / avatar_removed /
// avatar_color_changed — never the image.

const crypto = require('node:crypto');
const { getDb } = require('../db/connection');
const activity = require('./activity');
const logger = require('../utils/logger');

const PALETTE = Object.freeze([
  Object.freeze({ key: 'blue', hex: '#3B82F6' }),
  Object.freeze({ key: 'teal', hex: '#14B8A6' }),
  Object.freeze({ key: 'green', hex: '#22C55E' }),
  Object.freeze({ key: 'lime', hex: '#84CC16' }),
  Object.freeze({ key: 'yellow', hex: '#EAB308' }),
  Object.freeze({ key: 'orange', hex: '#F97316' }),
  Object.freeze({ key: 'pink', hex: '#EC4899' }),
  Object.freeze({ key: 'purple', hex: '#A855F7' }),
  Object.freeze({ key: 'indigo', hex: '#6366F1' }),
  Object.freeze({ key: 'slate', hex: '#64748B' }),
]);
const HEX_BY_KEY = new Map(PALETTE.map((c) => [c.key, c.hex]));
// Ring colour "unterwegs" (not selectable as a favourite colour).
const AWAY_HEX = '#E5484D';

const MAX_BYTES = 96 * 1024;
const MIN_SIZE = 64;
const MAX_SIZE = 512;
const TYPES = Object.freeze({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' });
// avatar_id: 18 random bytes → 24 url-safe characters (base64url).
const ID_BYTES = 18;
const FILE_RE = /^([A-Za-z0-9_-]{22,64})\.(png|jpg|webp)$/;

function invalid(reason, message) {
  const err = new Error(message || `invalid image: ${reason}`);
  err.code = 'ERR_INVALID';
  err.reason = reason;
  return err;
}

function notFound() {
  const err = new Error('User not found');
  err.code = 'NOT_FOUND';
  return err;
}

// ─── Image header parsing ────────────────────────────────────────────────

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** PNG: IHDR right after the signature; acTL before the first IDAT = APNG. */
function parsePng(buf) {
  if (buf.length < 33 || buf.toString('latin1', 12, 16) !== 'IHDR') throw invalid('format');
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  let off = 8;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    if (type === 'acTL') throw invalid('animated');
    if (type === 'IDAT' || type === 'IEND') break;
    off += 12 + len;
  }
  return { mime: 'image/png', width, height };
}

/** JPEG: walk the marker segments up to the first SOFn (frame header). */
function parseJpeg(buf) {
  let off = 2;
  while (off + 4 <= buf.length) {
    if (buf[off] !== 0xff) throw invalid('format');
    let marker = buf[off + 1];
    // Fill bytes (0xFF 0xFF …) before a marker.
    while (marker === 0xff && off + 2 < buf.length) { off += 1; marker = buf[off + 1]; }
    off += 2;
    // Markers without a length: TEM, RST0–7.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (marker === 0xd9 || marker === 0xda) break; // EOI / SOS before a frame header
    if (off + 2 > buf.length) break;
    const len = buf.readUInt16BE(off);
    if (len < 2) throw invalid('format');
    // SOF0–SOF15 except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (off + 7 > buf.length) break;
      return { mime: 'image/jpeg', height: buf.readUInt16BE(off + 3), width: buf.readUInt16BE(off + 5) };
    }
    off += len;
  }
  throw invalid('format');
}

/** WebP: the first chunk is VP8 (lossy), VP8L (lossless) or VP8X (extended). */
function parseWebp(buf) {
  if (buf.length < 30) throw invalid('format');
  const chunk = buf.toString('latin1', 12, 16);
  if (chunk === 'VP8 ') {
    // Frame tag (3 bytes), start code 9D 01 2A, then 14-bit width / height.
    if (buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) throw invalid('format');
    return { mime: 'image/webp', width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === 'VP8L') {
    if (buf[20] !== 0x2f) throw invalid('format');
    const bits = buf.readUInt32LE(21);
    return { mime: 'image/webp', width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X') {
    if (buf[20] & 0x02) throw invalid('animated');
    return { mime: 'image/webp', width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
  }
  throw invalid('format');
}

/**
 * Check a picture. Returns { mime, ext, size, width, height, bytes } (size =
 * the edge length in pixels) or throws ERR_INVALID with err.reason one of
 * 'empty' | 'too_large' | 'format' | 'animated' | 'not_square' | 'too_small'
 * | 'too_big'.
 */
function validateImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) throw invalid('empty');
  if (buf.length > MAX_BYTES) throw invalid('too_large');
  let info;
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIG)) info = parsePng(buf);
  else if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) info = parseJpeg(buf);
  else if (buf.length >= 16 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') info = parseWebp(buf);
  else throw invalid('format');
  const { width, height } = info;
  if (!width || !height) throw invalid('format');
  if (width !== height) throw invalid('not_square');
  if (width < MIN_SIZE) throw invalid('too_small');
  if (width > MAX_SIZE) throw invalid('too_big');
  return { mime: info.mime, ext: TYPES[info.mime], size: width, width, height, bytes: buf.length };
}

// ─── Colours, initials, URLs ─────────────────────────────────────────────

function isColorKey(key) { return typeof key === 'string' && HEX_BY_KEY.has(key); }

/** The favourite colour of a user row: the stored key, else PALETTE[id % 10]. */
function colorOf(user) {
  if (user && isColorKey(user.avatar_color)) return user.avatar_color;
  const id = Number(user && user.id);
  return PALETTE[(Number.isSafeInteger(id) && id > 0 ? id : 0) % PALETTE.length].key;
}

/** Same rule as profileInitials (routes/index.js) and portalDevices.initials. */
function initialsOf(name) {
  const words = String(name || '').trim().split(/[\s._-]+/).filter(Boolean);
  if (!words.length) return '?';
  const chars = words.length > 1
    ? [Array.from(words[0])[0], Array.from(words[1])[0]]
    : Array.from(words[0]).slice(0, 2);
  return chars.join('').toUpperCase();
}

function urlOf(avatarId, mime) {
  return avatarId && TYPES[mime] ? `/avatars/${avatarId}.${TYPES[mime]}` : null;
}

/**
 * Public fields of a user row (id, username, display_name, avatar_color)
 * plus its picture row ({ avatar_id, mime } or null):
 * { color, colorHex, avatarUrl, initials }.
 */
function fieldsOf(user, pic) {
  const color = colorOf(user);
  return {
    color,
    colorHex: HEX_BY_KEY.get(color),
    avatarUrl: pic ? urlOf(pic.avatar_id, pic.mime) : null,
    initials: initialsOf((user && (user.display_name || user.username)) || ''),
  };
}

function pictureRow(userId) {
  return getDb().prepare('SELECT avatar_id, mime FROM user_avatars WHERE user_id = ?').get(userId) || null;
}

/** { color, colorHex, avatarUrl | null, initials } of a user, null when unknown. */
function info(userId) {
  const user = getDb().prepare('SELECT id, username, display_name, avatar_color FROM users WHERE id = ?').get(userId);
  return user ? fieldsOf(user, pictureRow(user.id)) : null;
}

/** Map userId → fields for many user rows at once (one query for the pictures). */
function infoMany(users) {
  const pics = new Map(getDb().prepare('SELECT user_id, avatar_id, mime FROM user_avatars').all().map((r) => [r.user_id, r]));
  const out = new Map();
  for (const u of users || []) out.set(u.id, fieldsOf(u, pics.get(u.id) || null));
  return out;
}

/**
 * The profile answer of the APIs (client, own profile, portal):
 * { user: { id, name, initials, color, colorHex, avatarUrl }, palette }.
 */
function profileOf(userId) {
  const user = getDb().prepare('SELECT id, username, display_name, avatar_color FROM users WHERE id = ?').get(userId);
  if (!user) return null;
  const f = fieldsOf(user, pictureRow(user.id));
  return {
    user: { id: user.id, name: user.display_name || user.username, initials: f.initials, color: f.color, colorHex: f.colorHex, avatarUrl: f.avatarUrl },
    palette: PALETTE.map((c) => ({ key: c.key, hex: c.hex })),
  };
}

// ─── Changes ─────────────────────────────────────────────────────────────

function userRow(userId) {
  const user = getDb().prepare('SELECT id, username FROM users WHERE id = ?').get(userId);
  if (!user) throw notFound();
  return user;
}

/**
 * Store a new picture (validated) under a new avatar_id. Returns
 * { avatarUrl, mime, size, bytes }. opts: { actorId, ip, source }.
 */
function set(userId, buf, { actorId = null, ip = null, source = 'admin' } = {}) {
  const user = userRow(userId);
  const img = validateImage(buf);
  const avatarId = crypto.randomBytes(ID_BYTES).toString('base64url');
  getDb().prepare(`INSERT INTO user_avatars (user_id, avatar_id, mime, data, updated_at) VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET avatar_id = excluded.avatar_id, mime = excluded.mime, data = excluded.data, updated_at = excluded.updated_at`)
    .run(user.id, avatarId, img.mime, buf);
  activity.log('avatar_changed', `Profile picture of user "${user.username}" changed`, {
    source, ipAddress: ip, severity: 'info',
    details: { userId: user.id, actorId, mime: img.mime, size: img.size, bytes: img.bytes },
  });
  logger.info({ userId: user.id, actorId, mime: img.mime, bytes: img.bytes }, 'Profile picture changed');
  return { avatarUrl: urlOf(avatarId, img.mime), mime: img.mime, size: img.size, bytes: img.bytes };
}

/** Remove the picture (the old URL answers 404). Returns whether one existed. */
function remove(userId, { actorId = null, ip = null, source = 'admin' } = {}) {
  const user = userRow(userId);
  const removed = getDb().prepare('DELETE FROM user_avatars WHERE user_id = ?').run(user.id).changes > 0;
  if (removed) {
    activity.log('avatar_removed', `Profile picture of user "${user.username}" removed`, {
      source, ipAddress: ip, severity: 'info', details: { userId: user.id, actorId },
    });
  }
  return removed;
}

/**
 * Favourite colour: a PALETTE key, or null for the default. Anything else
 * (red included) is ERR_INVALID with reason 'color'. Returns { color, colorHex }.
 */
function setColor(userId, key, { actorId = null, ip = null, source = 'admin' } = {}) {
  if (key !== null && !isColorKey(key)) throw invalid('color', 'color must be one of the palette keys or null');
  const user = userRow(userId);
  getDb().prepare("UPDATE users SET avatar_color = ?, updated_at = datetime('now') WHERE id = ?").run(key, user.id);
  const color = colorOf({ id: user.id, avatar_color: key });
  activity.log('avatar_color_changed', `Favourite colour of user "${user.username}" set to ${key || 'default'}`, {
    source, ipAddress: ip, severity: 'info', details: { userId: user.id, actorId, color: key },
  });
  return { color, colorHex: HEX_BY_KEY.get(color) };
}

/** The picture behind /avatars/<file> ({ mime, data }) or null. */
function getFile(file) {
  const m = FILE_RE.exec(String(file || ''));
  if (!m) return null;
  const row = getDb().prepare('SELECT mime, data FROM user_avatars WHERE avatar_id = ?').get(m[1]);
  if (!row || TYPES[row.mime] !== m[2]) return null;
  return { mime: row.mime, data: row.data };
}

module.exports = {
  PALETTE,
  AWAY_HEX,
  MAX_BYTES,
  MIN_SIZE,
  MAX_SIZE,
  TYPES,
  validateImage,
  isColorKey,
  colorOf,
  initialsOf,
  urlOf,
  fieldsOf,
  info,
  infoMany,
  profileOf,
  set,
  remove,
  setColor,
  getFile,
};
