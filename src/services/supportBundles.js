'use strict';

/**
 * Support bundles ("Support-Paket per Knopfdruck", docs/feature-support-bundle.md).
 *
 * A client collects a redacted diagnostics bundle (JSON, schema 1) and uploads
 * it after the user confirmed it. The server
 *   - parses the JSON (plain or gzip, with an output cap against zip bombs),
 *   - runs its own redaction pass (utils/supportRedact) over every string,
 *   - stores it gzip-compressed at <dir>/<peerId>/<timestamp>-<rand>.json.gz
 *     (dir 0700, file 0600) with a support_bundles row as index,
 *   - prunes: newest `keepPerPeer` per peer, nothing older than `maxAgeDays`,
 *     files without a row (e.g. after a peer was deleted) are removed.
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const config = require('../../config/default');
const { getDb } = require('../db/connection');
const logger = require('../utils/logger');
const { redactValue } = require('../utils/supportRedact');

const SCHEMA_VERSION = 1;
const FILE_RE = /^\d{8}T\d{6}Z-[a-f0-9]{8}\.json\.gz$/;
const PRODUCTS = new Set(['pro', 'community', 'android']);

function opts() {
  return config.supportBundles;
}

function baseDir() {
  return opts().dir;
}

function peerDir(peerId) {
  return path.join(baseDir(), String(Number(peerId)));
}

class BundleError extends Error {
  constructor(code, status, message) {
    super(message || code);
    this.code = code;
    this.status = status;
  }
}

function shortString(v, max) {
  if (typeof v !== 'string') return null;
  const s = v.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return s ? s.slice(0, max) : null;
}

/**
 * Turn the request body into a bundle object.
 * @param {Buffer|object} body - raw gzip/JSON bytes (Buffer) or an already
 *   parsed JSON object (express.json)
 * @returns {object}
 */
function parseBundle(body) {
  // Only two shapes are accepted: raw bytes (express.raw) or a parsed JSON
  // object (express.json). Arrays and anything else are rejected up front.
  if (Buffer.isBuffer(body)) return checkBundle(parseBytes(body));
  if (Array.isArray(body) || !body || typeof body !== 'object') throw new BundleError('invalid_bundle', 400);
  return checkBundle(body);
}

function parseBytes(bytes) {
  const { maxJsonBytes } = opts();
  let json = bytes;
  if (bytes.byteLength >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    try {
      json = zlib.gunzipSync(bytes, { maxOutputLength: maxJsonBytes });
    } catch (err) {
      if (err && (err.code === 'ERR_BUFFER_TOO_LARGE' || err instanceof RangeError)) {
        throw new BundleError('too_large', 413);
      }
      throw new BundleError('invalid_gzip', 400);
    }
  }
  if (json.byteLength > maxJsonBytes) throw new BundleError('too_large', 413);
  try {
    return JSON.parse(json.toString('utf8'));
  } catch {
    throw new BundleError('invalid_json', 400);
  }
}

function checkBundle(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new BundleError('invalid_bundle', 400);
  if (obj.schema !== SCHEMA_VERSION) throw new BundleError('unsupported_schema', 400);
  return obj;
}

function timestampName() {
  const iso = new Date().toISOString(); // 2026-10-02T12:34:56.789Z
  const stamp = iso.slice(0, 19).replace(/[-:]/g, '') + 'Z';
  return `${stamp}-${crypto.randomBytes(4).toString('hex')}.json.gz`;
}

/** Uploads of this peer within the last hour (rate limit). */
function countRecent(peerId) {
  return getDb().prepare(
    "SELECT COUNT(*) AS n FROM support_bundles WHERE peer_id = ? AND created_at >= datetime('now', '-1 hour')"
  ).get(peerId).n;
}

function isRateLimited(peerId) {
  return countRecent(peerId) >= opts().perHour;
}

/**
 * Store a parsed bundle for a peer.
 * @param {number} peerId
 * @param {object} bundle - result of parseBundle
 * @param {object} [meta] - fallbacks from request headers { version, product, platform }
 * @returns {object} the stored row (list shape)
 */
function store(peerId, bundle, meta = {}) {
  const db = getDb();
  const peer = db.prepare('SELECT id, support_bundle_requested_at FROM peers WHERE id = ?').get(peerId);
  if (!peer) throw new BundleError('peer_not_found', 404);

  const redacted = redactValue(bundle);
  redacted.server = {
    receivedAt: new Date().toISOString(),
    peerId: peer.id,
    redaction: 'server-v1',
  };
  const json = Buffer.from(JSON.stringify(redacted, null, 2), 'utf8');
  if (json.byteLength > opts().maxJsonBytes) throw new BundleError('too_large', 413);
  const gz = zlib.gzipSync(json, { level: 9 });

  const client = (bundle.client && typeof bundle.client === 'object') ? bundle.client : {};
  const productRaw = shortString(client.product, 20) || shortString(meta.product, 20);
  const product = productRaw && PRODUCTS.has(productRaw.toLowerCase()) ? productRaw.toLowerCase() : null;
  const row = {
    client_version: shortString(client.version, 40) || shortString(meta.version, 40),
    client_product: product,
    client_platform: shortString(client.platform, 20) || shortString(meta.platform, 20),
    os: shortString(client.os, 120),
    reason: bundle.reason === 'admin_request' || peer.support_bundle_requested_at ? 'admin_request' : 'user',
  };

  const dir = peerDir(peer.id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(baseDir(), 0o700); } catch { /* best effort */ }
  const fileName = timestampName();
  const file = path.join(dir, fileName);
  fs.writeFileSync(file, gz, { mode: 0o600, flag: 'wx' });

  let id;
  try {
    id = db.transaction(() => {
      const info = db.prepare(`
        INSERT INTO support_bundles (peer_id, file_name, size_bytes, json_bytes, client_version, client_product, client_platform, os, reason)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(peer.id, fileName, gz.byteLength, json.byteLength, row.client_version, row.client_product, row.client_platform, row.os, row.reason);
      // The upload answers an open admin request.
      db.prepare('UPDATE peers SET support_bundle_requested_at = NULL WHERE id = ?').run(peer.id);
      return info.lastInsertRowid;
    })();
  } catch (err) {
    try { fs.unlinkSync(file); } catch { /* ignore */ }
    throw err;
  }

  try { prunePeer(peer.id); } catch (err) { logger.warn({ err: err.message, peerId: peer.id }, 'support bundle prune failed'); }
  return getById(peer.id, id);
}

function toListItem(r) {
  return {
    id: r.id,
    peer_id: r.peer_id,
    created_at: r.created_at,
    size_bytes: r.size_bytes,
    json_bytes: r.json_bytes,
    client_version: r.client_version,
    client_product: r.client_product,
    client_platform: r.client_platform,
    os: r.os,
    reason: r.reason,
  };
}

function list(peerId) {
  return getDb().prepare('SELECT * FROM support_bundles WHERE peer_id = ? ORDER BY created_at DESC, id DESC')
    .all(peerId).map(toListItem);
}

function getRow(peerId, id) {
  return getDb().prepare('SELECT * FROM support_bundles WHERE id = ? AND peer_id = ?').get(id, peerId) || null;
}

function getById(peerId, id) {
  const r = getRow(peerId, id);
  return r ? toListItem(r) : null;
}

function filePath(r) {
  if (!r || !FILE_RE.test(r.file_name)) return null;
  return path.join(peerDir(r.peer_id), r.file_name);
}

/** Decompressed JSON of a bundle (Buffer) or null when missing. */
function readJson(peerId, id) {
  const r = getRow(peerId, id);
  const file = filePath(r);
  if (!file) return null;
  try {
    return zlib.gunzipSync(fs.readFileSync(file));
  } catch (err) {
    logger.warn({ err: err.message, peerId, id }, 'support bundle file unreadable');
    return null;
  }
}

function removeRow(r) {
  const file = filePath(r);
  if (file) {
    try { fs.unlinkSync(file); } catch (err) { if (err.code !== 'ENOENT') logger.warn({ err: err.message }, 'support bundle unlink failed'); }
  }
  getDb().prepare('DELETE FROM support_bundles WHERE id = ?').run(r.id);
}

function remove(peerId, id) {
  const r = getRow(peerId, id);
  if (!r) return false;
  removeRow(r);
  return true;
}

/** Keep the newest keepPerPeer bundles of a peer, drop those older than maxAgeDays. */
function prunePeer(peerId) {
  const { keepPerPeer, maxAgeDays } = opts();
  const db = getDb();
  const rows = db.prepare('SELECT * FROM support_bundles WHERE peer_id = ? ORDER BY created_at DESC, id DESC').all(peerId);
  const cutoff = db.prepare("SELECT datetime('now', ?) AS c").get(`-${Math.max(1, maxAgeDays)} days`).c;
  let removed = 0;
  rows.forEach((r, i) => {
    if (i >= Math.max(1, keepPerPeer) || r.created_at < cutoff) {
      removeRow(r);
      removed++;
    }
  });
  return removed;
}

/**
 * Periodic cleanup: retention for every peer plus files/directories that
 * have no row any more (deleted peers, interrupted writes).
 */
function cleanup() {
  const db = getDb();
  let removed = 0;
  for (const { peer_id: peerId } of db.prepare('SELECT DISTINCT peer_id FROM support_bundles').all()) {
    removed += prunePeer(peerId);
  }

  let entries = [];
  try { entries = fs.readdirSync(baseDir(), { withFileTypes: true }); } catch { return removed; }
  const known = new Set(db.prepare('SELECT peer_id, file_name FROM support_bundles').all().map((r) => `${r.peer_id}/${r.file_name}`));
  for (const ent of entries) {
    if (!ent.isDirectory() || !/^\d+$/.test(ent.name)) continue;
    const dir = path.join(baseDir(), ent.name);
    let files = [];
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (!known.has(`${ent.name}/${f}`)) {
        try { fs.unlinkSync(path.join(dir, f)); removed++; } catch { /* ignore */ }
      }
    }
    try { if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir); } catch { /* ignore */ }
  }
  return removed;
}

// ── Admin request flag ───────────────────────────────────────

function requestBundle(peerId) {
  getDb().prepare("UPDATE peers SET support_bundle_requested_at = datetime('now') WHERE id = ?").run(peerId);
  return getRequest(peerId);
}

function cancelRequest(peerId) {
  getDb().prepare('UPDATE peers SET support_bundle_requested_at = NULL WHERE id = ?').run(peerId);
}

/** ISO-ish UTC timestamp of the open request or null. */
function getRequest(peerId) {
  const r = getDb().prepare('SELECT support_bundle_requested_at AS t FROM peers WHERE id = ?').get(peerId);
  return r ? r.t || null : null;
}

module.exports = {
  SCHEMA_VERSION,
  BundleError,
  parseBundle,
  store,
  list,
  getById,
  readJson,
  remove,
  prunePeer,
  cleanup,
  isRateLimited,
  countRecent,
  requestBundle,
  cancelRequest,
  getRequest,
  peerDir,
};
