'use strict';

// Public links of plugins (permissions.publicLinks, docs/plugins.md "Public
// links", since 1.193.0; Links v2 since 1.205.0): a plugin shares media files
// with people without a GateControl account — GateDrop's "Link für Externe",
// Drive's folder and upload links.
//
//   * gc.publicLinks.create/list/get/revoke/events/uploads (hostApi.js) — only
//     while the plugin declares the permission AND an administrator switched
//     it on for that plugin (setting plugins.public_links.<id>, default off;
//     Einstellungen › Plugins › <Plugin> › Berechtigungen), else
//     ERR_PUBLIC_LINKS_DISABLED; the URL is built on the configured public
//     server URL (GC_BASE_URL, https and a public host name) — none →
//     ERR_NO_PUBLIC_URL;
//   * kinds: 'files' (up to 20 files, as before), 'folder' (since 1.205.0:
//     the current content of a folder of a media area — area + path, with
//     its sub folders; plugins with media.areas) and 'upload' (people put
//     files into a folder of an area; limits for count, total size, types;
//     the name they give is kept). Mode 'view' (look only: pictures, videos
//     and sound in the page, no download, no ZIP) or 'download';
//   * expiry 1 minute … 30 days; no end at all only while an administrator
//     allows that for the plugin (setting plugins.public_links_unlimited.<id>;
//     switched off again, such links end);
//   * the token (24 characters base64url, 144 bits) is made here and given
//     to the plugin once; the database keeps its SHA-256 (the row's key) and
//     the token itself only encrypted with GC_ENCRYPTION_KEY (for list());
//   * the core serves the link without a login (routes/publicLinks.js). Only
//     what belongs to the link, only while the plugin is installed, may run,
//     still declares the permission and the administrator's switch is on;
//     never after expiresAt, revoke(), 5 wrong PINs (locked), the end of a
//     file's downloads (maxDownloads per file, kind 'files'), the deletion of
//     one of its media files (kind 'files') or of the plugin;
//   * PIN: 4–8 digits, stored as an scrypt hash (random salt); a right PIN
//     sets a signed cookie for that link's path (1 h);
//   * the log (gc.publicLinks.events): opened (once per visitor and hour),
//     PIN right / wrong, locked, downloads, ZIPs, uploads — with the address
//     shortened (IPv4 /24, IPv6 /48) and a random id per browser, never more;
//   * hook publicLinkEvent({ token, event: 'download'|'locked'|'expired'|'upload', … })
//     of the plugin (optional, in the background) for its notifications.

const crypto = require('node:crypto');
const net = require('node:net');
const { promisify } = require('node:util');
const config = require('../../../config/default');
const logger = require('../../utils/logger');

const scrypt = promisify(crypto.scrypt);

const TOKEN_BYTES = 18;
const TOKEN_RE = /^[A-Za-z0-9_-]{22,64}$/;
const KINDS = ['files', 'folder', 'upload'];
const MODES = ['view', 'download'];
const FILES_MAX = 20;
const TITLE_MAX = 120;
const NOTE_MAX = 500;
const TTL_MAX_MS = 30 * 24 * 3600 * 1000;
const TTL_MIN_MS = 60 * 1000;
// a link without an end: expires_at this far ahead (the column cannot be empty)
const NO_EXPIRY_AT = '9999-12-31T23:59:59.000Z';
const MAX_DOWNLOADS_MAX = 1000;
const PIN_RE = /^\d{4,8}$/;
const PIN_FAILURES_MAX = 5;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };
const UNLOCK_TTL_S = 3600;
const UNLOCK_COOKIE = 'gc_pl';
// a download resumed (Range not from 0) within this time is not counted again —
// only by the client that made the counted download (its resume cookie)
const RESUME_WINDOW_MS = 6 * 3600 * 1000;
const RESUME_COOKIE = 'gc_pr';
// a random id per browser and link: the visitor's own uploads, "opened" once an hour
const VISITOR_COOKIE = 'gc_pv';
const VISITOR_RE = /^[A-Za-z0-9_-]{22}$/;
const VISITOR_TTL_S = 30 * 24 * 3600;
const OPEN_EVERY_MS = 3600 * 1000;
const EVENTS_PER_LINK_MAX = 5000;
// rows of ended links (expired, revoked) are kept this long for list()
const KEEP_AFTER_END_MS = 30 * 24 * 3600 * 1000;
const SETTING = 'plugins.public_links.';
const SETTING_UNLIMITED = 'plugins.public_links_unlimited.';
const LINKS_PER_PLUGIN_MAX = 5000;
// upload links: defaults and limits
const UPLOAD_FILES_DEFAULT = 500;
const UPLOAD_FILES_MAX = 10000;
const UPLOAD_BYTES_DEFAULT = 5 * 1024 ** 3;
const UPLOAD_BYTES_MIN = 1024 * 1024;
const UPLOAD_BYTES_MAX = 1024 ** 4;
const UPLOAD_TYPES_MAX = 32;
const UPLOADER_MAX = 80;
const UPLOAD_TYPE_RE = /^(?:\.[a-z0-9]{1,10}|[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/(?:\*|[a-z0-9][a-z0-9!#$&^_.+-]{0,126}))$/;
const MIME_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;
// a folder link lists at most this many entries per folder, its ZIP at most this many files
const FOLDER_LIST_MAX = 2000;
const FOLDER_ZIP_FILES_MAX = 10000;
// control characters (C0, DEL, C1) and bidi controls; newlines are kept in the note
const LINE_STRIP_RE = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;
const NOTE_STRIP_RE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;

class LinkError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}
function need(cond, code, msg) { if (!cond) throw new LinkError(code, msg); }

function db() { return require('../../db/connection').getDb(); }
function settings() { return require('../settings'); }
function media() { return require('./media'); }
function areas() { return require('./mediaAreas'); }

function hashToken(token) { return crypto.createHash('sha256').update(String(token)).digest('hex'); }

// ─── Permission and administrator switches ──────

/** Does the plugin declare permissions.publicLinks? */
function declared(plugin) {
  return !!(plugin && plugin.manifest && plugin.manifest.permissions && plugin.manifest.permissions.publicLinks === true);
}

/** The administrator's switch for a plugin (default off). */
function allowed(pluginId) {
  try { return settings().get(SETTING + pluginId, '0') === '1'; } catch { return false; }
}

function setAllowed(pluginId, on) { settings().set(SETTING + pluginId, on ? '1' : '0'); }

/** The administrator allows links without an end for this plugin (default off). */
function unlimitedAllowed(pluginId) {
  try { return settings().get(SETTING_UNLIMITED + pluginId, '0') === '1'; } catch { return false; }
}

/** Off: the plugin's links without an end end for good (revoked) — switching it on again brings none back. */
function setUnlimitedAllowed(pluginId, on) {
  settings().set(SETTING_UNLIMITED + pluginId, on ? '1' : '0');
  if (!on) db().prepare('UPDATE plugin_public_links SET revoked_at = COALESCE(revoked_at, ?) WHERE plugin = ? AND no_expiry = 1').run(iso(Date.now()), pluginId);
}

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

/**
 * 'active' | 'revoked' | 'locked' | 'expired' | 'used' (every file used up) |
 * 'gone' (a file was deleted, the link's area is gone).
 */
function stateOf(link, files, now = Date.now()) {
  if (link.revoked_at) return 'revoked';
  if (link.locked_at) return 'locked';
  if (link.no_expiry ? !unlimitedAllowed(link.plugin) : Date.parse(link.expires_at) <= now) return 'expired';
  if (link.kind === 'folder' || link.kind === 'upload') return areas().rowOf(link.plugin, link.area) ? 'active' : 'gone';
  if (files.some((f) => f.bytes == null)) return 'gone';
  if (files.length && files.every((f) => fileUsedUp(link, f))) return 'used';
  return 'active';
}

function tokenOf(link) {
  try { return require('../../utils/crypto').decrypt(link.token_enc); } catch { return null; }
}

function typesOf(link) {
  try { const v = link.upload_types ? JSON.parse(link.upload_types) : null; return Array.isArray(v) ? v : null; } catch { return null; }
}

/** What gc.publicLinks.list / get answer for one link. */
function view(link, base = publicBase()) {
  const files = link.kind === 'files' ? filesOf(link.token_hash) : [];
  const token = tokenOf(link);
  const state = stateOf(link, files);
  const out = {
    token, url: token ? urlOf(token, base) : null, kind: link.kind || 'files', mode: link.mode || 'download', title: link.title, note: link.note,
    ownerUserId: link.owner_user_id, createdAt: link.created_at, expiresAt: link.no_expiry ? null : Date.parse(link.expires_at),
    maxDownloads: link.max_downloads, pin: !!link.pin_hash, pinFailures: link.pin_failures,
    state, active: state === 'active', revoked: !!link.revoked_at, locked: !!link.locked_at, expired: state === 'expired',
    opens: link.opens || 0,
    downloads: link.kind === 'files' ? files.reduce((n, f) => n + f.downloads, 0)
      : db().prepare("SELECT COUNT(*) AS n FROM plugin_public_link_events WHERE token_hash = ? AND kind IN ('download', 'zip')").get(link.token_hash).n,
    files: files.map((f) => ({ id: String(f.idx), mediaId: f.media_id, name: f.name, mime: f.mime || null, bytes: f.bytes == null ? null : f.bytes,
      downloads: f.downloads, lastDownloadAt: f.last_download_at })),
  };
  if (link.kind === 'folder' || link.kind === 'upload') { out.area = link.area; out.path = link.root_path || ''; }
  if (link.kind === 'upload') {
    out.upload = { maxFiles: link.upload_max_files, maxBytes: link.upload_max_bytes, types: typesOf(link), files: link.uploads, bytes: link.upload_bytes };
  }
  return out;
}

// ─── Plugin API (gc.publicLinks) ────────────────

function needEnabled(plugin) {
  need(declared(plugin), 'ERR_PUBLIC_LINKS_DISABLED', 'plugin.json declares no permissions.publicLinks');
  need(allowed(plugin.id), 'ERR_PUBLIC_LINKS_DISABLED', 'public links are not allowed by an administrator for this plugin');
}

/** The checked folder of a folder / upload link: { area, path } ('' = the area's top). */
function folderArg(plugin, a) {
  need(areas().declared(plugin), 'ERR_INVALID', 'folder and upload links need media.areas in plugin.json');
  need(typeof a.area === 'string' && areas().rowOf(plugin.id, a.area), 'ERR_INVALID', 'unknown area');
  let p;
  try { p = areas().cleanPath(a.path == null ? null : String(a.path)); } catch { throw new LinkError('ERR_INVALID', 'invalid path'); }
  return { area: a.area, path: p || '' };
}

/** Upload limits of an upload link → { maxFiles, maxBytes, types }. */
function uploadArgs(a) {
  const maxFiles = a.maxFiles == null ? UPLOAD_FILES_DEFAULT : a.maxFiles;
  const maxBytes = a.maxBytes == null ? UPLOAD_BYTES_DEFAULT : a.maxBytes;
  need(Number.isSafeInteger(maxFiles) && maxFiles >= 1 && maxFiles <= UPLOAD_FILES_MAX, 'ERR_INVALID', `maxFiles must be 1 … ${UPLOAD_FILES_MAX}`);
  need(Number.isSafeInteger(maxBytes) && maxBytes >= UPLOAD_BYTES_MIN && maxBytes <= UPLOAD_BYTES_MAX, 'ERR_INVALID', 'maxBytes must be 1 MB … 1 TB');
  let types = null;
  if (a.types != null) {
    need(Array.isArray(a.types) && a.types.length >= 1 && a.types.length <= UPLOAD_TYPES_MAX, 'ERR_INVALID', `types: 1 … ${UPLOAD_TYPES_MAX} entries`);
    types = [...new Set(a.types.map((t) => String(t).trim().toLowerCase()))];
    need(types.every((t) => UPLOAD_TYPE_RE.test(t)), 'ERR_INVALID', 'types: MIME types ("image/*", "application/pdf") or extensions (".pdf")');
  }
  return { maxFiles, maxBytes, types };
}

/**
 * gc.publicLinks.create({ kind, mode, title, note, files: [{ mediaId, name }]
 * | area + path, expiresAt | null, maxDownloads?, pin?, ownerUserId,
 * maxFiles?, maxBytes?, types? }) → { token, url, expiresAt }.
 */
async function create(plugin, args, now = Date.now()) {
  needEnabled(plugin);
  const base = publicBase();
  need(base, 'ERR_NO_PUBLIC_URL', 'GateControl has no public https URL (GC_BASE_URL)');
  const a = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  const kind = a.kind == null ? 'files' : a.kind;
  need(KINDS.includes(kind), 'ERR_INVALID', `kind: ${KINDS.join(', ')}`);
  const mode = a.mode == null ? 'download' : a.mode;
  need(MODES.includes(mode), 'ERR_INVALID', `mode: ${MODES.join(', ')}`);
  const owner = a.ownerUserId;
  need(Number.isSafeInteger(owner) && owner > 0, 'ERR_INVALID', 'ownerUserId required');
  need(db().prepare('SELECT 1 FROM users WHERE id = ? AND enabled = 1').get(owner), 'ERR_INVALID', 'unknown or disabled owner');
  need(a.title == null || (typeof a.title === 'string' && Array.from(a.title).length <= TITLE_MAX), 'ERR_INVALID', `title must be ≤ ${TITLE_MAX} characters`);
  need(a.note == null || (typeof a.note === 'string' && Array.from(a.note).length <= NOTE_MAX), 'ERR_INVALID', `note must be ≤ ${NOTE_MAX} characters`);
  const noExpiry = a.expiresAt === null;
  if (noExpiry) need(unlimitedAllowed(plugin.id), 'ERR_INVALID', 'links without an end are not allowed by an administrator for this plugin');
  else need(Number.isSafeInteger(a.expiresAt) && a.expiresAt >= now + TTL_MIN_MS && a.expiresAt <= now + TTL_MAX_MS, 'ERR_INVALID', 'expiresAt must lie 1 minute … 30 days ahead (ms), or null');
  need(a.maxDownloads == null || (kind === 'files' && Number.isSafeInteger(a.maxDownloads) && a.maxDownloads >= 1 && a.maxDownloads <= MAX_DOWNLOADS_MAX),
    'ERR_INVALID', `maxDownloads (kind files) must be 1 … ${MAX_DOWNLOADS_MAX}`);
  need(a.pin == null || (typeof a.pin === 'string' && PIN_RE.test(a.pin)), 'ERR_INVALID', 'pin must be 4 … 8 digits');
  const files = [];
  let folder = null;
  let upload = null;
  if (kind === 'files') {
    need(Array.isArray(a.files) && a.files.length >= 1 && a.files.length <= FILES_MAX, 'ERR_INVALID', `files: 1 … ${FILES_MAX}`);
    for (const f of a.files) {
      need(f && typeof f === 'object' && typeof f.mediaId === 'string' && media().ID_RE.test(f.mediaId), 'ERR_INVALID', 'invalid media id');
      need(f.name == null || (typeof f.name === 'string' && f.name.length <= 4096), 'ERR_INVALID', 'invalid name');
      const r = media().row(plugin.id, f.mediaId);
      need(r, 'ERR_INVALID', 'unknown media id');
      need(r.ref_count > 0, 'ERR_INVALID', 'the media file must be claimed (gc.media.claim) first');
      files.push({ mediaId: r.id, name: media().cleanName(f.name) || r.name || null });
    }
  } else {
    need(a.files == null, 'ERR_INVALID', 'files belong to kind "files"');
    folder = folderArg(plugin, a);
    if (kind === 'upload') {
      const decl = media().declOf(plugin);
      need(decl && decl.uploads !== false, 'ERR_INVALID', 'the plugin takes no uploads (media.uploads false)');
      upload = uploadArgs(a);
    }
  }
  const count = db().prepare('SELECT COUNT(*) AS n FROM plugin_public_links WHERE plugin = ?').get(plugin.id).n;
  need(count < LINKS_PER_PLUGIN_MAX, 'ERR_RATE_LIMIT', `too many links (${LINKS_PER_PLUGIN_MAX})`);
  const pinHash = a.pin == null ? null : await hashPin(a.pin);
  const token = crypto.randomBytes(TOKEN_BYTES).toString('base64url');
  const h = hashToken(token);
  const conn = db();
  conn.transaction(() => {
    conn.prepare(`INSERT INTO plugin_public_links (token_hash, token_enc, plugin, owner_user_id, title, note, created_at, expires_at, max_downloads, pin_hash,
      kind, mode, area, root_path, no_expiry, upload_max_files, upload_max_bytes, upload_types)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(h, require('../../utils/crypto').encrypt(token), plugin.id, owner,
      line(a.title, TITLE_MAX), note(a.note), iso(now), noExpiry ? NO_EXPIRY_AT : iso(a.expiresAt), a.maxDownloads == null ? null : a.maxDownloads, pinHash,
      kind, kind === 'upload' ? 'download' : mode, folder ? folder.area : null, folder ? folder.path : null, noExpiry ? 1 : 0,
      upload ? upload.maxFiles : null, upload ? upload.maxBytes : null, upload && upload.types ? JSON.stringify(upload.types) : null);
    const ins = conn.prepare('INSERT INTO plugin_public_link_files (token_hash, idx, media_id, name) VALUES (?, ?, ?, ?)');
    files.forEach((f, i) => ins.run(h, i + 1, f.mediaId, f.name));
  })();
  try {
    const what = kind === 'files' ? `${files.length} file${files.length === 1 ? '' : 's'}` : `${kind} ${folder.area}/${folder.path}`;
    require('../activity').log('plugin_public_link', `Plugin "${plugin.name}": public link created (${what}${mode === 'view' ? ', view only' : ''})`, {
      source: 'plugin', severity: kind === 'upload' || noExpiry ? 'warning' : 'info',
      details: { plugin: plugin.id, userId: owner, kind, mode, files: files.length, pin: !!pinHash, expiresAt: noExpiry ? null : iso(a.expiresAt) },
    });
  } catch { /* the link exists; the log is best-effort */ }
  return { token, url: urlOf(token, base), expiresAt: noExpiry ? null : a.expiresAt };
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

/**
 * gc.publicLinks.events(token, { limit, before }) → the log, newest first:
 * [{ id, at, kind, ip, visitor, name, mediaId, bytes, uploader }] (≤ 500).
 */
function events(plugin, args) {
  needEnabled(plugin);
  const a = args && typeof args === 'object' ? args : {};
  const r = ownRow(plugin, a.token);
  if (!r) return null;
  const limit = Number.isSafeInteger(a.limit) && a.limit > 0 ? Math.min(a.limit, 500) : 100;
  const before = Number.isSafeInteger(a.before) && a.before > 0 ? a.before : Number.MAX_SAFE_INTEGER;
  return db().prepare('SELECT * FROM plugin_public_link_events WHERE token_hash = ? AND id < ? ORDER BY id DESC LIMIT ?').all(r.token_hash, before, limit)
    .map((e) => ({ id: e.id, at: e.at, kind: e.kind, ip: e.ip, visitor: e.visitor, name: e.name, mediaId: e.media_id, bytes: e.bytes, uploader: e.uploader }));
}

/** gc.publicLinks.uploads(token) → the files that came in through an upload link, newest first. */
function uploads(plugin, args) {
  needEnabled(plugin);
  const r = ownRow(plugin, args && args.token);
  if (!r) return null;
  return db().prepare('SELECT * FROM plugin_public_link_uploads WHERE token_hash = ? ORDER BY at DESC LIMIT 10000').all(r.token_hash)
    .map((u) => ({ mediaId: u.media_id, name: u.name, path: u.path, uploader: u.uploader, bytes: u.bytes, at: u.at }));
}

// ─── Ending links from the outside ──────────────

/** Media files deleted (media.remove / removeAll / cleanup): their links (kind 'files') end. `mediaIds` null = every link of the plugin. */
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
  const files = link.kind === 'files' ? filesOf(link.token_hash) : [];
  return { link, files, plugin, state: stateOf(link, files, now) };
}

/** The sharing person's display name (the page shows it), or null. */
function senderName(link) {
  if (link.owner_user_id == null) return null;
  const u = db().prepare('SELECT username, display_name FROM users WHERE id = ? AND enabled = 1').get(link.owner_user_id);
  return u ? (u.display_name || u.username) : null;
}

function secureCookie() { return /^https:/i.test(String(config.app.baseUrl || '')); }

function cookieSig(link, exp) {
  return crypto.createHmac('sha256', String(config.app.secret)).update(`public-link:${link.token_hash}:${exp}`).digest('base64url');
}

/** Set-Cookie value after a right PIN: scoped to the link's path, 1 h. */
function unlockCookie(link, token, now = Date.now()) {
  const exp = Math.floor(now / 1000) + UNLOCK_TTL_S;
  return `${UNLOCK_COOKIE}=${exp}.${cookieSig(link, exp)}; Path=/s/${token}; Max-Age=${UNLOCK_TTL_S}; HttpOnly; SameSite=Lax${secureCookie() ? '; Secure' : ''}`;
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
 * The visitor's random id (cookie of this link's path) → { id, cookie } —
 * `cookie` is the Set-Cookie value when the id is new, else null.
 */
function visitor(req, token) {
  const v = req.cookies && typeof req.cookies[VISITOR_COOKIE] === 'string' ? req.cookies[VISITOR_COOKIE] : '';
  if (VISITOR_RE.test(v)) return { id: v, cookie: null };
  const id = crypto.randomBytes(16).toString('base64url');
  return { id, cookie: `${VISITOR_COOKIE}=${id}; Path=/s/${token}; Max-Age=${VISITOR_TTL_S}; HttpOnly; SameSite=Lax${secureCookie() ? '; Secure' : ''}` };
}

function expandV6(s) {
  const parts = s.split('::');
  if (parts.length > 2) return null;
  const h = parts[0] ? parts[0].split(':') : [];
  if (parts.length === 1) return h.length === 8 ? h : null;
  const t = parts[1] ? parts[1].split(':') : [];
  const fill = 8 - h.length - t.length;
  return fill >= 0 ? h.concat(new Array(fill).fill('0'), t) : null;
}

/** An address for the log: IPv4 /24 ("203.0.113.0"), IPv6 /48 ("2001:db8:1::"), nothing else. */
function shortIp(ip) {
  let s = String(ip || '');
  if (s.startsWith('::ffff:') && net.isIPv4(s.slice(7))) s = s.slice(7);
  if (net.isIPv4(s)) return s.split('.').slice(0, 3).concat('0').join('.');
  if (net.isIPv6(s)) {
    const full = expandV6(s.split('%')[0]);
    return full ? full.slice(0, 3).map((g) => g.replace(/^0+(?=.)/, '').toLowerCase()).join(':') + '::' : null;
  }
  return null;
}

/** One line of the link's log (kept to EVENTS_PER_LINK_MAX). */
function logEvent(link, kind, { req = null, visitorId = null, name = null, mediaId = null, bytes = null, uploader = null } = {}) {
  try {
    const conn = db();
    conn.prepare(`INSERT INTO plugin_public_link_events (token_hash, at, kind, ip, visitor, name, media_id, bytes, uploader)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(link.token_hash, iso(Date.now()), kind, req ? shortIp(req.ip) : null, visitorId, name, mediaId, bytes, uploader);
    const n = conn.prepare('SELECT COUNT(*) AS n FROM plugin_public_link_events WHERE token_hash = ?').get(link.token_hash).n;
    if (n > EVENTS_PER_LINK_MAX) {
      conn.prepare(`DELETE FROM plugin_public_link_events WHERE id IN (SELECT id FROM plugin_public_link_events WHERE token_hash = ?
        ORDER BY id LIMIT ?)`).run(link.token_hash, n - EVENTS_PER_LINK_MAX);
    }
  } catch (e) {
    logger.debug({ err: e.message }, 'public link: log line failed');
  }
}

/** The page was opened: counted, and logged once per visitor and hour. */
function noteOpen(link, req, visitorId, now = Date.now()) {
  db().prepare('UPDATE plugin_public_links SET opens = opens + 1 WHERE token_hash = ?').run(link.token_hash);
  const last = db().prepare("SELECT at FROM plugin_public_link_events WHERE token_hash = ? AND kind = 'open' AND visitor = ? ORDER BY id DESC LIMIT 1")
    .get(link.token_hash, visitorId);
  if (!last || now - Date.parse(last.at) >= OPEN_EVERY_MS) logEvent(link, 'open', { req, visitorId });
}

/**
 * A PIN entered on the page → { ok, locked, left }. The fifth wrong PIN
 * locks the link (hook event 'locked'). Never logs the PIN.
 */
async function tryPin(link, pin, { req = null, visitorId = null } = {}) {
  if (!link.pin_hash || link.locked_at) return { ok: false, locked: !!link.locked_at, left: 0 };
  if (await pinMatches(link.pin_hash, pin)) {
    db().prepare('UPDATE plugin_public_links SET pin_failures = 0 WHERE token_hash = ?').run(link.token_hash);
    logEvent(link, 'unlock', { req, visitorId });
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
  logEvent(link, r.justLocked ? 'locked' : 'pin_failed', { req, visitorId });
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

// ─── Downloads ──────────────────────────────────
//
// A request for a file from byte 0 (no Range, or a Range from 0) is a new
// download: it is counted — refused (410) when the file has used up its
// maxDownloads — and the client gets a resume cookie for that file (HttpOnly,
// Path=/s/<token>/f/<n>, RESUME_WINDOW_MS, HMAC over the link, the file and
// the expiry with the server secret). A Range from later in the file is the
// continuation of a download: free with a valid resume cookie of that file;
// without one it is a new download like above (so a used-up file can never be
// fetched again piece by piece by someone else holding the URL).

function resumeSig(link, idx, exp) {
  return crypto.createHmac('sha256', String(config.app.secret)).update(`public-link-resume:${link.token_hash}:${idx}:${exp}`).digest('base64url');
}

/** Set-Cookie value after a counted download of file `f`: resuming it stays free for RESUME_WINDOW_MS. */
function resumeCookie(link, token, f, now = Date.now()) {
  const ttl = Math.floor(RESUME_WINDOW_MS / 1000);
  const exp = Math.floor(now / 1000) + ttl;
  return `${RESUME_COOKIE}=${exp}.${resumeSig(link, f.idx, exp)}; Path=/s/${token}/f/${f.idx}; Max-Age=${ttl}; HttpOnly; SameSite=Lax${secureCookie() ? '; Secure' : ''}`;
}

/** Does the request carry a valid resume cookie for file `f` of the link? */
function mayResume(req, link, f, now = Date.now()) {
  const v = req.cookies && typeof req.cookies[RESUME_COOKIE] === 'string' ? req.cookies[RESUME_COOKIE] : '';
  const m = /^(\d{1,12})\.([A-Za-z0-9_-]{43})$/.exec(v);
  if (!m) return false;
  const exp = Number(m[1]);
  const s = Math.floor(now / 1000);
  if (exp <= s || exp > s + Math.floor(RESUME_WINDOW_MS / 1000)) return false;
  const want = Buffer.from(resumeSig(link, f.idx, exp));
  const got = Buffer.from(m[2]);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

/**
 * Count a new download of `files` (one file, or all of them for the ZIP) and
 * tell the plugin. Atomic: a file that used up its downloads (also by a
 * parallel request) counts nothing at all → false.
 */
function countDownload(link, files, { zip = false, req = null, visitorId = null } = {}, now = Date.now()) {
  const conn = db();
  const upd = conn.prepare(`UPDATE plugin_public_link_files SET downloads = downloads + 1, last_download_at = ?
    WHERE token_hash = ? AND idx = ? AND (? IS NULL OR downloads < ?)`);
  const max = link.max_downloads == null ? null : link.max_downloads;
  const ok = conn.transaction(() => {
    for (const f of files) {
      if (upd.run(iso(now), link.token_hash, f.idx, max, max).changes !== 1) throw new LinkError('used');
    }
    return true;
  });
  try { ok(); } catch (e) {
    if (e instanceof LinkError) return false;
    throw e;
  }
  const first = files[0];
  logEvent(link, zip ? 'zip' : 'download', { req, visitorId, name: zip ? null : (first.name || first.media_name || null), mediaId: zip ? null : first.media_id,
    bytes: files.reduce((n, f) => n + (f.bytes || 0), 0) });
  const token = tokenOf(link);
  const total = conn.prepare('SELECT COALESCE(SUM(downloads), 0) AS n FROM plugin_public_link_files WHERE token_hash = ?').get(link.token_hash).n;
  if (token) {
    emit(link.plugin, {
      token, event: 'download', zip, downloads: total,
      file: zip ? null : { id: String(first.idx), name: first.name || first.media_name || null },
    });
  }
  return true;
}

/** A download of a folder link (one file, or a ZIP of a folder): logged, and the plugin told. */
function noteFolderDownload(link, { zip = false, req = null, visitorId = null, name = null, mediaId = null, bytes = null, path = null } = {}) {
  logEvent(link, zip ? 'zip' : 'download', { req, visitorId, name, mediaId, bytes });
  const token = tokenOf(link);
  if (token) emit(link.plugin, { token, event: 'download', zip, path, file: zip ? null : { mediaId, name } });
}

// ─── Folder links ───────────────────────────────

/** "a/b" below the link's root, cleaned → the full path in the area ('' = the root itself), or null when invalid. */
function folderPath(link, sub) {
  let rel = '';
  if (sub != null && sub !== '') {
    try { rel = areas().cleanPath(String(sub)) || ''; } catch { return null; }
  }
  const root = link.root_path || '';
  return root && rel ? `${root}/${rel}` : (root || rel);
}

const LIST_COLS = 'id, plugin, area, path, mime, bytes, name, sha256, created_at, key_enc, local, target_id, remote_key, stored_form, nonce_prefix';

/**
 * The content of folder `full` (path in the area) of a folder link: its sub
 * folders (names) and its files (current files, no versions) →
 * { folders: [name], files: [row], more }.
 */
function listFolder(link, full) {
  const prefix = full ? `${full}/` : '';
  const rows = db().prepare(`SELECT ${LIST_COLS} FROM plugin_media
    WHERE plugin = ? AND area = ? AND path IS NOT NULL AND version_of IS NULL AND ref_count > 0 AND substr(path, 1, ?) = ?
    ORDER BY path LIMIT ?`).all(link.plugin, link.area, prefix.length, prefix, 50000);
  const folders = new Set();
  const files = [];
  for (const r of rows) {
    const rest = r.path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash >= 0) folders.add(rest.slice(0, slash));
    else files.push(r);
  }
  const fl = [...folders].sort((x, y) => x.localeCompare(y));
  return { folders: fl.slice(0, FOLDER_LIST_MAX), files: files.slice(0, FOLDER_LIST_MAX), more: fl.length > FOLDER_LIST_MAX || files.length > FOLDER_LIST_MAX };
}

/** Every file below folder `full` (for the ZIP) → [{ row, rel }] (path relative to it), or null when there are too many. */
function filesBelow(link, full) {
  const prefix = full ? `${full}/` : '';
  const rows = db().prepare(`SELECT ${LIST_COLS} FROM plugin_media
    WHERE plugin = ? AND area = ? AND path IS NOT NULL AND version_of IS NULL AND ref_count > 0 AND substr(path, 1, ?) = ?
    ORDER BY path LIMIT ?`).all(link.plugin, link.area, prefix.length, prefix, FOLDER_ZIP_FILES_MAX + 1);
  if (rows.length > FOLDER_ZIP_FILES_MAX) return null;
  return rows.map((r) => ({ row: r, rel: r.path.slice(prefix.length) }));
}

/** A media file of a folder link: in its area, below its root, a current file — or null. */
function folderFile(link, mediaId) {
  const r = media().row(link.plugin, String(mediaId || ''));
  if (!r || r.area !== link.area || r.path == null || r.version_of != null || r.ref_count < 1) return null;
  const root = link.root_path || '';
  if (root && !r.path.startsWith(root + '/')) return null;
  return r;
}

// ─── Upload links ───────────────────────────────

/** Is a file of type `mime` / name `name` allowed by the link's types (null = any)? */
function uploadTypeAllowed(link, mime, name) {
  const types = typesOf(link);
  if (!types) return true;
  const ext = (/\.([a-z0-9]{1,10})$/i.exec(String(name || '')) || [])[1];
  return types.some((t) => {
    if (t.startsWith('.')) return !!ext && t === '.' + ext.toLowerCase();
    if (t.endsWith('/*')) return mime.startsWith(t.slice(0, -1));
    return mime === t;
  });
}

/** "Fotos/a.jpg" taken → "Fotos/a (2).jpg", … */
function freePath(link, p) {
  const taken = (x) => !!db().prepare('SELECT 1 FROM plugin_media WHERE plugin = ? AND area = ? AND path = ? LIMIT 1').get(link.plugin, link.area, x);
  if (!taken(p)) return p;
  const slash = p.lastIndexOf('/');
  const dir = slash >= 0 ? p.slice(0, slash + 1) : '';
  const name = p.slice(slash + 1);
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 2; i < 10000; i++) {
    const c = `${dir}${base} (${i})${ext}`;
    if (!taken(c)) return c;
  }
  throw new LinkError('exists', 'no free name');
}

/**
 * One file into an upload link (the request body): checks the link's limits
 * (count, total size, types) and reserves them atomically, stores the file
 * like the plugin's own uploads (its size limit, quota, the room here),
 * owned by the link's owner, and claims it into the link's folder under the
 * name given (a taken name gets " (2)"). → { mediaId, name (the one it got), path, bytes }.
 * Throws LinkError (limit, type, name) or media's MediaError (too_large, …).
 */
async function upload(r, req, { name, uploader, visitorId }) {
  const link = r.link;
  const M = media();
  const clean = M.cleanName(name);
  need(clean, 'name', 'a file name is needed');
  need(!clean.startsWith('.'), 'name', 'hidden names are not taken');
  const who = line(uploader, UPLOADER_MAX);
  const length = M.contentLength(req);
  let mime = M.baseType(req.headers['content-type']) || 'application/octet-stream';
  if (mime === 'application/octet-stream') mime = areas().mimeOf(clean);
  need(MIME_RE.test(mime), 'type', 'invalid type');
  need(uploadTypeAllowed(link, mime, clean), 'type', 'this type is not taken here');
  need(M.typeAllowed(M.declOf(r.plugin), mime), 'type', 'the plugin takes no files of this type');
  // reserve one file and its bytes (parallel uploads cannot pass the limits)
  const res = db().prepare(`UPDATE plugin_public_links SET uploads = uploads + 1, upload_bytes = upload_bytes + ?
    WHERE token_hash = ? AND uploads < upload_max_files AND upload_bytes + ? <= upload_max_bytes`).run(length, link.token_hash, length);
  need(res.changes === 1, 'limit', 'the upload limit of this link is reached');
  const refund = () => db().prepare('UPDATE plugin_public_links SET uploads = uploads - 1, upload_bytes = upload_bytes - ? WHERE token_hash = ?').run(length, link.token_hash);
  let stored;
  try {
    stored = await M.storeFromLink(r.plugin, req, { mime, length, owner: link.owner_user_id, name: clean });
  } catch (e) { refund(); throw e; }
  let p;
  for (let attempt = 0; ; attempt++) {
    try {
      p = freePath(link, link.root_path ? `${link.root_path}/${clean}` : clean);
      M.claim(link.plugin, stored.mediaId, { area: link.area, path: p });
      break;
    } catch (e) {
      // a parallel upload took the same name in between: the next free one
      if (e && e.code === 'exists' && attempt < 3) continue;
      M.remove(link.plugin, stored.mediaId);
      refund();
      throw e;
    }
  }
  // the name it got ("a (2).jpg" when "a.jpg" was taken)
  const got = p.slice(p.lastIndexOf('/') + 1);
  db().prepare(`INSERT INTO plugin_public_link_uploads (token_hash, media_id, name, path, uploader, visitor, bytes, at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(link.token_hash, stored.mediaId, got, p, who, visitorId, length, iso(Date.now()));
  logEvent(link, 'upload', { req, visitorId, name: got, mediaId: stored.mediaId, bytes: length, uploader: who });
  const token = tokenOf(link);
  if (token) emit(link.plugin, { token, event: 'upload', mediaId: stored.mediaId, name: got, path: p, uploader: who, bytes: length });
  return { mediaId: stored.mediaId, name: got, path: p, bytes: length };
}

/** The visitor's own uploads to a link (names, sizes, when) — what the upload page lists. */
function visitorUploads(link, visitorId) {
  if (!visitorId) return [];
  return db().prepare('SELECT name, bytes, at FROM plugin_public_link_uploads WHERE token_hash = ? AND visitor = ? ORDER BY at DESC LIMIT 500')
    .all(link.token_hash, visitorId);
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
  const unlimited = unlimitedAllowed(pluginId) ? 1 : 0;
  return db().prepare(`SELECT COUNT(*) AS n FROM plugin_public_links
    WHERE plugin = ? AND revoked_at IS NULL AND locked_at IS NULL AND (CASE WHEN no_expiry = 1 THEN ? = 1 ELSE expires_at > ? END)`)
    .get(pluginId, unlimited, iso(now)).n;
}

module.exports = {
  LinkError, TOKEN_RE, KINDS, MODES, FILES_MAX, TITLE_MAX, NOTE_MAX, TTL_MAX_MS, PIN_FAILURES_MAX, UNLOCK_COOKIE, RESUME_COOKIE, VISITOR_COOKIE,
  RESUME_WINDOW_MS, SETTING, SETTING_UNLIMITED, FOLDER_ZIP_FILES_MAX,
  declared, allowed, setAllowed, unlimitedAllowed, setUnlimitedAllowed, enabled, publicBase, hashToken,
  create, list, get, revoke, events, uploads, revokeForMedia, removeAll,
  resolve, senderName, unlockCookie, unlocked, visitor, shortIp, noteOpen, tryPin, resumeCookie, mayResume, countDownload, noteFolderDownload, fileUsedUp,
  folderPath, listFolder, filesBelow, folderFile, upload, uploadTypeAllowed, visitorUploads,
  sweep, activeCount, stateOf,
};
