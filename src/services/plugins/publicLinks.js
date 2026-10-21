'use strict';

// Public download links of plugins (permissions.publicLinks, docs/plugins.md
// "Public links", since 1.193.0): a plugin shares some of its media files
// with people without a GateControl account — GateDrop's "Link für Externe".
//
//   * gc.publicLinks.create/list/get/revoke (hostApi.js) — only while the
//     plugin declares the permission AND an administrator switched it on
//     for that plugin (setting plugins.public_links.<id>, default off;
//     Einstellungen › Plugins › <Plugin> › Berechtigungen), else
//     ERR_PUBLIC_LINKS_DISABLED; the URL is built on the configured public
//     server URL (GC_BASE_URL, https and a public host name) — none →
//     ERR_NO_PUBLIC_URL;
//   * the token (24 characters base64url, 144 bits) is made here and given
//     to the plugin once; the database keeps its SHA-256 (the row's key) and
//     the token itself only encrypted with GC_ENCRYPTION_KEY (for list());
//   * the core serves the link without a login (routes/publicLinks.js):
//     GET /s/<token> (page), POST /s/<token>/unlock (PIN), GET
//     /s/<token>/f/<n> (one file, Range), GET /s/<token>/zip (all files).
//     Only the files of that link, only while the plugin is installed, may
//     run, still declares the permission and the administrator's switch is
//     on; never after expiresAt (≤ 30 days), revoke(), 5 wrong PINs
//     (locked), the end of a file's downloads (maxDownloads per file), the
//     deletion of one of its media files or of the plugin;
//   * PIN: 4–8 digits, stored as an scrypt hash (random salt); a right PIN
//     sets a signed cookie for that link's path (1 h);
//   * hook publicLinkEvent({ token, event: 'download'|'locked'|'expired', … })
//     of the plugin (optional, in the background) for its notifications.

const crypto = require('node:crypto');
const net = require('node:net');
const { promisify } = require('node:util');
const config = require('../../../config/default');
const logger = require('../../utils/logger');

const scrypt = promisify(crypto.scrypt);

const TOKEN_BYTES = 18;
const TOKEN_RE = /^[A-Za-z0-9_-]{22,64}$/;
const FILES_MAX = 20;
const TITLE_MAX = 120;
const NOTE_MAX = 500;
const TTL_MAX_MS = 30 * 24 * 3600 * 1000;
const TTL_MIN_MS = 60 * 1000;
const MAX_DOWNLOADS_MAX = 1000;
const PIN_RE = /^\d{4,8}$/;
const PIN_FAILURES_MAX = 5;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };
const UNLOCK_TTL_S = 3600;
const UNLOCK_COOKIE = 'gc_pl';
// a download resumed (Range not from 0) within this time is not counted again
const RESUME_WINDOW_MS = 6 * 3600 * 1000;
// rows of ended links (expired, revoked) are kept this long for list()
const KEEP_AFTER_END_MS = 30 * 24 * 3600 * 1000;
const SETTING = 'plugins.public_links.';
const LINKS_PER_PLUGIN_MAX = 5000;
// control characters (C0, DEL, C1) and bidi controls; newlines are kept in the note
const LINE_STRIP_RE = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;
const NOTE_STRIP_RE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;

class LinkError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}
function need(cond, code, msg) { if (!cond) throw new LinkError(code, msg); }

function db() { return require('../../db/connection').getDb(); }
function settings() { return require('../settings'); }

function hashToken(token) { return crypto.createHash('sha256').update(String(token)).digest('hex'); }

// ─── Permission and administrator switch ────────

/** Does the plugin declare permissions.publicLinks? */
function declared(plugin) {
  return !!(plugin && plugin.manifest && plugin.manifest.permissions && plugin.manifest.permissions.publicLinks === true);
}

/** The administrator's switch for a plugin (default off). */
function allowed(pluginId) {
  try { return settings().get(SETTING + pluginId, '0') === '1'; } catch { return false; }
}

function setAllowed(pluginId, on) { settings().set(SETTING + pluginId, on ? '1' : '0'); }

/** May the plugin use public links right now (declared and switched on)? */
function enabled(plugin) { return declared(plugin) && allowed(plugin.id); }

/**
 * The public origin links are built on: GC_BASE_URL when it is https with
 * a public host name (no localhost, no internal suffix, no private address),
 * else null.
 */
function publicBase() {
  let u;
  try { u = new URL(String(config.app.baseUrl || '')); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password) return null;
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || /\.(?:localhost|local|internal|lan|home\.arpa|test|invalid|example)$/.test(host)) return null;
  if (net.isIP(host)) {
    if (require('./netPolicy').classify(host) !== 'public') return null;
  } else if (!host.includes('.')) return null;
  return u.origin;
}

function urlOf(token, base = publicBase()) { return base ? `${base}/s/${token}` : null; }

// ─── Texts ──────────────────────────────────────

function line(v, max) {
  if (v == null) return null;
  const s = Array.from(String(v).replace(LINE_STRIP_RE, ' ').replace(/\s+/g, ' ').trim()).slice(0, max).join('').trim();
  return s || null;
}

function note(v) {
  if (v == null) return null;
  const s = Array.from(String(v).replace(/\r\n?/g, '\n').replace(NOTE_STRIP_RE, '').replace(/\n{3,}/g, '\n\n').trim()).slice(0, NOTE_MAX).join('').trim();
  return s || null;
}

// ─── PIN ────────────────────────────────────────

async function hashPin(pin) {
  const salt = crypto.randomBytes(16);
  const h = await scrypt(String(pin), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${h.toString('base64')}`;
}

async function pinMatches(stored, pin) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  const salt = Buffer.from(parts[4], 'base64');
  const want = Buffer.from(parts[5], 'base64');
  if (!PIN_RE.test(String(pin || ''))) {
    // same work for a malformed PIN: no timing hint about the format check
    await scrypt('0000', salt, want.length || SCRYPT.keylen, { N, r, p }).catch(() => null);
    return false;
  }
  const got = await scrypt(String(pin), salt, want.length, { N, r, p });
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

// ─── Rows and views ─────────────────────────────

function rowByToken(token) {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
  const h = hashToken(token);
  const r = db().prepare('SELECT * FROM plugin_public_links WHERE token_hash = ?').get(h);
  // the key is the hash; compared once more in constant time
  if (!r || !crypto.timingSafeEqual(Buffer.from(r.token_hash, 'hex'), Buffer.from(h, 'hex'))) return null;
  return r;
}

function filesOf(tokenHash) {
  return db().prepare(`SELECT f.idx, f.media_id, f.name, f.downloads, f.last_download_at, m.mime, m.bytes, m.name AS media_name
    FROM plugin_public_link_files f LEFT JOIN plugin_media m ON m.id = f.media_id
    WHERE f.token_hash = ? ORDER BY f.idx`).all(tokenHash);
}

function iso(ms) { return new Date(ms).toISOString(); }

/** Has the file used up its downloads? */
function fileUsedUp(link, f) { return link.max_downloads != null && f.downloads >= link.max_downloads; }

/** 'active' | 'revoked' | 'locked' | 'expired' | 'used' (every file used up) | 'gone' (a file was deleted). */
function stateOf(link, files, now = Date.now()) {
  if (link.revoked_at) return 'revoked';
  if (link.locked_at) return 'locked';
  if (Date.parse(link.expires_at) <= now) return 'expired';
  if (files.some((f) => f.bytes == null)) return 'gone';
  if (files.length && files.every((f) => fileUsedUp(link, f))) return 'used';
  return 'active';
}

function tokenOf(link) {
  try { return require('../../utils/crypto').decrypt(link.token_enc); } catch { return null; }
}

/** What gc.publicLinks.list / get answer for one link. */
function view(link, base = publicBase()) {
  const files = filesOf(link.token_hash);
  const token = tokenOf(link);
  const state = stateOf(link, files);
  return {
    token, url: token ? urlOf(token, base) : null, title: link.title, note: link.note,
    ownerUserId: link.owner_user_id, createdAt: link.created_at, expiresAt: Date.parse(link.expires_at),
    maxDownloads: link.max_downloads, pin: !!link.pin_hash, pinFailures: link.pin_failures,
    state, active: state === 'active', revoked: !!link.revoked_at, locked: !!link.locked_at, expired: state === 'expired',
    downloads: files.reduce((n, f) => n + f.downloads, 0),
    files: files.map((f) => ({ id: String(f.idx), mediaId: f.media_id, name: f.name, mime: f.mime || null, bytes: f.bytes == null ? null : f.bytes,
      downloads: f.downloads, lastDownloadAt: f.last_download_at })),
  };
}

// ─── Plugin API (gc.publicLinks) ────────────────

function needEnabled(plugin) {
  need(declared(plugin), 'ERR_PUBLIC_LINKS_DISABLED', 'plugin.json declares no permissions.publicLinks');
  need(allowed(plugin.id), 'ERR_PUBLIC_LINKS_DISABLED', 'public links are not allowed by an administrator for this plugin');
}

/**
 * gc.publicLinks.create({ title, note, files: [{ mediaId, name }], expiresAt,
 * maxDownloads?, pin?, ownerUserId }) → { token, url, expiresAt }.
 */
async function create(plugin, args, now = Date.now()) {
  needEnabled(plugin);
  const base = publicBase();
  need(base, 'ERR_NO_PUBLIC_URL', 'GateControl has no public https URL (GC_BASE_URL)');
  const a = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  const owner = a.ownerUserId;
  need(Number.isSafeInteger(owner) && owner > 0, 'ERR_INVALID', 'ownerUserId required');
  need(db().prepare('SELECT 1 FROM users WHERE id = ? AND enabled = 1').get(owner), 'ERR_INVALID', 'unknown or disabled owner');
  need(a.title == null || (typeof a.title === 'string' && Array.from(a.title).length <= TITLE_MAX), 'ERR_INVALID', `title must be ≤ ${TITLE_MAX} characters`);
  need(a.note == null || (typeof a.note === 'string' && Array.from(a.note).length <= NOTE_MAX), 'ERR_INVALID', `note must be ≤ ${NOTE_MAX} characters`);
  need(Number.isSafeInteger(a.expiresAt) && a.expiresAt >= now + TTL_MIN_MS && a.expiresAt <= now + TTL_MAX_MS, 'ERR_INVALID', 'expiresAt must lie 1 minute … 30 days ahead (ms)');
  need(a.maxDownloads == null || (Number.isSafeInteger(a.maxDownloads) && a.maxDownloads >= 1 && a.maxDownloads <= MAX_DOWNLOADS_MAX), 'ERR_INVALID', `maxDownloads must be 1 … ${MAX_DOWNLOADS_MAX}`);
  need(a.pin == null || (typeof a.pin === 'string' && PIN_RE.test(a.pin)), 'ERR_INVALID', 'pin must be 4 … 8 digits');
  need(Array.isArray(a.files) && a.files.length >= 1 && a.files.length <= FILES_MAX, 'ERR_INVALID', `files: 1 … ${FILES_MAX}`);
  const media = require('./media');
  const files = [];
  for (const f of a.files) {
    need(f && typeof f === 'object' && typeof f.mediaId === 'string' && media.ID_RE.test(f.mediaId), 'ERR_INVALID', 'invalid media id');
    need(f.name == null || (typeof f.name === 'string' && f.name.length <= 4096), 'ERR_INVALID', 'invalid name');
    const r = media.row(plugin.id, f.mediaId);
    need(r, 'ERR_INVALID', 'unknown media id');
    need(r.ref_count > 0, 'ERR_INVALID', 'the media file must be claimed (gc.media.claim) first');
    files.push({ mediaId: r.id, name: media.cleanName(f.name) || r.name || null });
  }
  const count = db().prepare('SELECT COUNT(*) AS n FROM plugin_public_links WHERE plugin = ?').get(plugin.id).n;
  need(count < LINKS_PER_PLUGIN_MAX, 'ERR_RATE_LIMIT', `too many links (${LINKS_PER_PLUGIN_MAX})`);
  const pinHash = a.pin == null ? null : await hashPin(a.pin);
  const token = crypto.randomBytes(TOKEN_BYTES).toString('base64url');
  const h = hashToken(token);
  const conn = db();
  conn.transaction(() => {
    conn.prepare(`INSERT INTO plugin_public_links (token_hash, token_enc, plugin, owner_user_id, title, note, created_at, expires_at, max_downloads, pin_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(h, require('../../utils/crypto').encrypt(token), plugin.id, owner, line(a.title, TITLE_MAX), note(a.note),
      iso(now), iso(a.expiresAt), a.maxDownloads == null ? null : a.maxDownloads, pinHash);
    const ins = conn.prepare('INSERT INTO plugin_public_link_files (token_hash, idx, media_id, name) VALUES (?, ?, ?, ?)');
    files.forEach((f, i) => ins.run(h, i + 1, f.mediaId, f.name));
  })();
  try {
    require('../activity').log('plugin_public_link', `Plugin "${plugin.name}": public link created (${files.length} file${files.length === 1 ? '' : 's'})`, {
      source: 'plugin', severity: 'info', details: { plugin: plugin.id, userId: owner, files: files.length, pin: !!pinHash, expiresAt: iso(a.expiresAt) },
    });
  } catch { /* the link exists; the log is best-effort */ }
  return { token, url: urlOf(token, base), expiresAt: a.expiresAt };
}

/** gc.publicLinks.list({ ownerUserId? }) → the plugin's links, newest first. */
function list(plugin, args) {
  needEnabled(plugin);
  const a = args && typeof args === 'object' ? args : {};
  need(a.ownerUserId == null || (Number.isSafeInteger(a.ownerUserId) && a.ownerUserId > 0), 'ERR_INVALID', 'invalid ownerUserId');
  const rows = a.ownerUserId == null
    ? db().prepare('SELECT * FROM plugin_public_links WHERE plugin = ? ORDER BY created_at DESC LIMIT 1000').all(plugin.id)
    : db().prepare('SELECT * FROM plugin_public_links WHERE plugin = ? AND owner_user_id = ? ORDER BY created_at DESC LIMIT 1000').all(plugin.id, a.ownerUserId);
  const base = publicBase();
  return rows.map((r) => view(r, base));
}

/** The plugin's own link of a token, or null. */
function ownRow(plugin, token) {
  const r = rowByToken(token);
  return r && r.plugin === plugin.id ? r : null;
}

/** gc.publicLinks.get(token) → the link with its counters, or null. */
function get(plugin, args) {
  needEnabled(plugin);
  const r = ownRow(plugin, args && args.token);
  return r ? view(r) : null;
}

/** gc.publicLinks.revoke(token) → true when the plugin's link was active until now. */
function revoke(plugin, args) {
  need(declared(plugin), 'ERR_PUBLIC_LINKS_DISABLED', 'plugin.json declares no permissions.publicLinks');
  const r = ownRow(plugin, args && args.token);
  if (!r || r.revoked_at) return false;
  db().prepare('UPDATE plugin_public_links SET revoked_at = ? WHERE token_hash = ?').run(iso(Date.now()), r.token_hash);
  return true;
}

// ─── Ending links from the outside ──────────────

/** Media files deleted (media.remove / removeAll / cleanup): their links end. `mediaIds` null = every link of the plugin. */
function revokeForMedia(pluginId, mediaIds) {
  const t = iso(Date.now());
  if (mediaIds == null) {
    db().prepare('UPDATE plugin_public_links SET revoked_at = COALESCE(revoked_at, ?) WHERE plugin = ?').run(t, pluginId);
    return;
  }
  const upd = db().prepare(`UPDATE plugin_public_links SET revoked_at = COALESCE(revoked_at, ?)
    WHERE plugin = ? AND token_hash IN (SELECT token_hash FROM plugin_public_link_files WHERE media_id = ?)`);
  for (const id of mediaIds) upd.run(t, pluginId, id);
}

/** The plugin is uninstalled: its links end (rows go, "Alles löschen" or not). */
function removeAll(pluginId) {
  db().prepare('DELETE FROM plugin_public_links WHERE plugin = ?').run(pluginId);
}

// ─── Serving (routes/publicLinks.js) ────────────

/**
 * The link of a token as the public routes see it → { link, files, plugin,
 * state } or null when there is nothing to serve (unknown token; the plugin
 * gone, not allowed to run, without the permission or the administrator's
 * switch). `state` as stateOf().
 */
function resolve(token, now = Date.now()) {
  const link = rowByToken(token);
  if (!link) return null;
  let plugin = null;
  try { plugin = require('./registry').get(link.plugin); } catch { plugin = null; }
  if (!plugin || !enabled(plugin)) return null;
  try { if (!require('./index').evaluate(plugin).run) return null; } catch { return null; }
  const files = filesOf(link.token_hash);
  return { link, files, plugin, state: stateOf(link, files, now) };
}

/** The sharing person's display name (the page shows it), or null. */
function senderName(link) {
  if (link.owner_user_id == null) return null;
  const u = db().prepare('SELECT username, display_name FROM users WHERE id = ? AND enabled = 1').get(link.owner_user_id);
  return u ? (u.display_name || u.username) : null;
}

function cookieSig(link, exp) {
  return crypto.createHmac('sha256', String(config.app.secret)).update(`public-link:${link.token_hash}:${exp}`).digest('base64url');
}

/** Set-Cookie value after a right PIN: scoped to the link's path, 1 h. */
function unlockCookie(link, token, now = Date.now()) {
  const exp = Math.floor(now / 1000) + UNLOCK_TTL_S;
  const secure = /^https:/i.test(String(config.app.baseUrl || ''));
  return `${UNLOCK_COOKIE}=${exp}.${cookieSig(link, exp)}; Path=/s/${token}; Max-Age=${UNLOCK_TTL_S}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

/** Does the request carry a valid unlock cookie for this link (or does the link have no PIN)? */
function unlocked(req, link, now = Date.now()) {
  if (!link.pin_hash) return true;
  const v = req.cookies && typeof req.cookies[UNLOCK_COOKIE] === 'string' ? req.cookies[UNLOCK_COOKIE] : '';
  const m = /^(\d{1,12})\.([A-Za-z0-9_-]{43})$/.exec(v);
  if (!m) return false;
  const exp = Number(m[1]);
  if (exp <= Math.floor(now / 1000) || exp > Math.floor(now / 1000) + UNLOCK_TTL_S) return false;
  const want = Buffer.from(cookieSig(link, exp));
  const got = Buffer.from(m[2]);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

/**
 * A PIN entered on the page → { ok, locked, left }. The fifth wrong PIN
 * locks the link (hook event 'locked'). Never logs the PIN.
 */
async function tryPin(link, pin) {
  if (!link.pin_hash || link.locked_at) return { ok: false, locked: !!link.locked_at, left: 0 };
  if (await pinMatches(link.pin_hash, pin)) {
    db().prepare('UPDATE plugin_public_links SET pin_failures = 0 WHERE token_hash = ?').run(link.token_hash);
    return { ok: true, locked: false, left: PIN_FAILURES_MAX };
  }
  const conn = db();
  const r = conn.transaction(() => {
    conn.prepare('UPDATE plugin_public_links SET pin_failures = pin_failures + 1 WHERE token_hash = ? AND locked_at IS NULL').run(link.token_hash);
    const cur = conn.prepare('SELECT pin_failures, locked_at FROM plugin_public_links WHERE token_hash = ?').get(link.token_hash);
    if (cur && !cur.locked_at && cur.pin_failures >= PIN_FAILURES_MAX) {
      conn.prepare('UPDATE plugin_public_links SET locked_at = ? WHERE token_hash = ?').run(iso(Date.now()), link.token_hash);
      return { locked: true, left: 0, justLocked: true };
    }
    return { locked: !!(cur && cur.locked_at), left: cur ? Math.max(0, PIN_FAILURES_MAX - cur.pin_failures) : 0 };
  })();
  if (r.justLocked) {
    const token = tokenOf(link);
    if (token) emit(link.plugin, { token, event: 'locked' });
    try {
      require('../activity').log('plugin_public_link', `Public link of plugin "${link.plugin}" locked after ${PIN_FAILURES_MAX} wrong PINs`, {
        source: 'system', severity: 'warning', details: { plugin: link.plugin, userId: link.owner_user_id, locked: true },
      });
    } catch { /* best-effort */ }
  }
  return { ok: false, locked: r.locked, left: r.left };
}

/**
 * May this request download file `f` of the link (state active, unlocked)?
 * `start` is where its Range starts (0 without one): from 0 it is a new
 * download — refused when the file used up its downloads; later it is the
 * continuation of one, allowed within RESUME_WINDOW_MS of the last counted
 * download of that file.
 */
function mayDownload(link, f, start, now = Date.now()) {
  if (start === 0) return !fileUsedUp(link, f);
  return !!f.last_download_at && now - Date.parse(f.last_download_at) < RESUME_WINDOW_MS;
}

/** Count a new download of `files` (one file, or all of them for the ZIP) and tell the plugin. */
function countDownload(link, files, { zip = false } = {}, now = Date.now()) {
  const conn = db();
  const upd = conn.prepare('UPDATE plugin_public_link_files SET downloads = downloads + 1, last_download_at = ? WHERE token_hash = ? AND idx = ?');
  conn.transaction(() => { for (const f of files) upd.run(iso(now), link.token_hash, f.idx); })();
  const token = tokenOf(link);
  const total = conn.prepare('SELECT COALESCE(SUM(downloads), 0) AS n FROM plugin_public_link_files WHERE token_hash = ?').get(link.token_hash).n;
  if (token) {
    emit(link.plugin, {
      token, event: 'download', zip, downloads: total,
      file: zip ? null : { id: String(files[0].idx), name: files[0].name || files[0].media_name || null },
    });
  }
}

// ─── Hook and housekeeping ──────────────────────

/** The plugin's hook publicLinkEvent, in the background (never awaited, errors ignored). */
function emit(pluginId, payload) {
  try {
    const runtime = require('./runtime');
    if (runtime.info(pluginId).state !== 'running') return;
    runtime.call(pluginId, 'publicLinkEvent', payload, 10000).catch((e) => {
      logger.debug({ plugin: pluginId, err: e && e.message }, 'public link: hook publicLinkEvent failed');
    });
  } catch { /* plugin gone */ }
}

/**
 * Hourly (plugins/index.js): links that expired since the last run get
 * expired_at and the plugin the event 'expired'; links ended more than 30
 * days ago (expired or revoked) are deleted. → { expired, deleted }.
 */
function sweep(now = Date.now()) {
  const conn = db();
  const t = iso(now);
  const due = conn.prepare('SELECT * FROM plugin_public_links WHERE expired_at IS NULL AND revoked_at IS NULL AND expires_at <= ?').all(t);
  for (const link of due) {
    conn.prepare('UPDATE plugin_public_links SET expired_at = ? WHERE token_hash = ?').run(t, link.token_hash);
    const token = tokenOf(link);
    if (token) emit(link.plugin, { token, event: 'expired' });
  }
  const cutoff = iso(now - KEEP_AFTER_END_MS);
  const deleted = conn.prepare('DELETE FROM plugin_public_links WHERE expires_at <= ? OR (revoked_at IS NOT NULL AND revoked_at <= ?)').run(cutoff, cutoff).changes;
  return { expired: due.length, deleted };
}

/** Active links of a plugin (the administrator's view). */
function activeCount(pluginId, now = Date.now()) {
  return db().prepare(`SELECT COUNT(*) AS n FROM plugin_public_links
    WHERE plugin = ? AND revoked_at IS NULL AND locked_at IS NULL AND expires_at > ?`).get(pluginId, iso(now)).n;
}

module.exports = {
  LinkError, TOKEN_RE, FILES_MAX, TITLE_MAX, NOTE_MAX, TTL_MAX_MS, PIN_FAILURES_MAX, UNLOCK_COOKIE, RESUME_WINDOW_MS, SETTING,
  declared, allowed, setAllowed, enabled, publicBase, hashToken, create, list, get, revoke, revokeForMedia, removeAll,
  resolve, senderName, unlockCookie, unlocked, tryPin, mayDownload, countDownload, fileUsedUp, sweep, activeCount, stateOf,
};
