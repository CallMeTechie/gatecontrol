'use strict';

/**
 * Server-controlled client updates.
 *
 *   - Update channel per peer ('stable' | 'beta'), NULL = global default
 *     (setting client_update.default_channel, itself 'stable' by default).
 *     stable = newest GitHub release that is not a pre-release,
 *     beta   = newest release including pre-releases.
 *   - Minimum client version per Windows product (pro / community). A client
 *     below it gets `mandatory: true` on the update check.
 *   - Last reported client version / product / platform per peer, for the
 *     peers list and the version overview in the settings.
 *
 * Trust model: channel, minVersion and mandatory are UX hints. The Windows
 * clients only install builds whose Ed25519-signed manifest verifies and that
 * are strictly newer than the running version — the server cannot push an
 * unsigned build or a downgrade through any of these fields. The channel is
 * assigned here (admin session only); the client cannot request one.
 */

const { getDb } = require('../db/connection');
const settings = require('./settings');
const logger = require('../utils/logger');

const CHANNELS = Object.freeze(['stable', 'beta']);
const DEFAULT_CHANNEL = 'stable';
const MIN_VERSION_PRODUCTS = Object.freeze(['pro', 'community']);
const PRODUCTS = Object.freeze(['pro', 'community', 'android']);

const KEY_DEFAULT_CHANNEL = 'client_update.default_channel';
const minVersionKey = (product) => `client_update.min_version.${product}`;

// Admin input: plain x.y.z (the signed manifests only carry plain versions).
const MIN_VERSION_RE = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/;
// Client reports / release tags: optional leading v, optional suffix.
const VERSION_RE = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:[-+][0-9A-Za-z.-]{1,32})?$/;
const PLATFORM_RE = /^[a-z0-9_-]{1,16}$/;

// Writes of the reported version are throttled per peer: immediately when
// something changed, otherwise at most every 5 minutes (last-seen refresh).
const RECORD_INTERVAL_MS = 5 * 60 * 1000;
const _recorded = new Map(); // peerId -> { sig, at }

/** [major, minor, patch] or null. Accepts 'v1.2.3' and '1.2.3-beta.1'. */
function parseVersion(v) {
  if (typeof v !== 'string') return null;
  const m = VERSION_RE.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** -1 / 0 / 1, or null when either side is unreadable. Suffixes are ignored. */
function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return 1;
    if (pa[i] < pb[i]) return -1;
  }
  return 0;
}

/** Version string as reported by a client, normalised (no leading v), or null. */
function normalizeReportedVersion(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s || s.length > 48 || !VERSION_RE.test(s)) return null;
  return s.replace(/^v/, '');
}

function normalizeProduct(p) {
  const s = typeof p === 'string' ? p.trim().toLowerCase() : '';
  if (s === 'pro' || s === 'gatecontrol-pro') return 'pro';
  if (s === 'community' || s === 'gatecontrol-community') return 'community';
  if (s === 'android' || s === 'gatecontrol-android') return 'android';
  return null;
}

function normalizePlatform(p) {
  const s = typeof p === 'string' ? p.trim().toLowerCase() : '';
  if (s === 'win32' || s === 'windows') return 'windows';
  return PLATFORM_RE.test(s) ? s : null;
}

function isValidChannel(c) {
  return typeof c === 'string' && CHANNELS.includes(c);
}

/**
 * Current policy. Never throws — a missing/broken settings table (fresh test
 * DB, early boot) yields the defaults, so the update check keeps working.
 */
function getPolicy() {
  const policy = { defaultChannel: DEFAULT_CHANNEL, minVersions: { pro: null, community: null } };
  try {
    const ch = settings.get(KEY_DEFAULT_CHANNEL, DEFAULT_CHANNEL);
    if (isValidChannel(ch)) policy.defaultChannel = ch;
    for (const p of MIN_VERSION_PRODUCTS) {
      const v = settings.get(minVersionKey(p), '');
      policy.minVersions[p] = typeof v === 'string' && MIN_VERSION_RE.test(v) ? v : null;
    }
  } catch (err) {
    logger.debug({ err: err.message }, 'client update policy unavailable, using defaults');
  }
  return policy;
}

/**
 * Validate a policy change. Returns { error } or { changes, next } where
 * `changes` lists what actually differs (for the audit log).
 *   input.default_channel   'stable' | 'beta'
 *   input.min_versions      { pro?, community? } — '' / null clears
 */
function validatePolicyInput(input, current = getPolicy()) {
  const body = input && typeof input === 'object' ? input : {};
  const next = { defaultChannel: current.defaultChannel, minVersions: { ...current.minVersions } };
  const changes = {};

  if (body.default_channel !== undefined) {
    if (!isValidChannel(body.default_channel)) return { error: 'invalid_channel' };
    if (body.default_channel !== current.defaultChannel) {
      changes.default_channel = { from: current.defaultChannel, to: body.default_channel };
      next.defaultChannel = body.default_channel;
    }
  }

  if (body.min_versions !== undefined) {
    const mv = body.min_versions;
    if (!mv || typeof mv !== 'object' || Array.isArray(mv)) return { error: 'invalid_min_version' };
    for (const key of Object.keys(mv)) {
      if (!MIN_VERSION_PRODUCTS.includes(key)) return { error: 'invalid_product' };
    }
    for (const p of MIN_VERSION_PRODUCTS) {
      if (mv[p] === undefined) continue;
      let v = mv[p];
      if (v === null) v = '';
      if (typeof v !== 'string') return { error: 'invalid_min_version' };
      v = v.trim().replace(/^v/, '');
      if (v && !MIN_VERSION_RE.test(v)) return { error: 'invalid_min_version' };
      const value = v || null;
      if (value !== current.minVersions[p]) {
        changes[`min_version_${p}`] = { from: current.minVersions[p], to: value };
        next.minVersions[p] = value;
      }
    }
  }

  return { changes, next };
}

function savePolicy(next) {
  settings.set(KEY_DEFAULT_CHANNEL, next.defaultChannel);
  for (const p of MIN_VERSION_PRODUCTS) {
    settings.set(minVersionKey(p), next.minVersions[p] || '');
  }
}

/** Effective channel of a peer row (NULL / unknown value → default). */
function effectiveChannel(peer, policy = getPolicy()) {
  const own = peer && peer.update_channel;
  return isValidChannel(own) ? own : policy.defaultChannel;
}

/** Minimum version for a product (null when unset / not applicable). */
function minVersionFor(product, policy = getPolicy()) {
  return MIN_VERSION_PRODUCTS.includes(product) ? policy.minVersions[product] || null : null;
}

/** true when version is readable and strictly below the product minimum. */
function isBelowMinimum(product, version, policy = getPolicy()) {
  const min = minVersionFor(product, policy);
  if (!min || !version) return false;
  return compareVersions(version, min) === -1;
}

/**
 * Set or clear (null / '') the per-peer channel override. Returns
 * { changed, from, to } or throws on an invalid channel / unknown peer.
 */
function setPeerChannel(peerId, channel) {
  const value = channel === null || channel === '' ? null : channel;
  if (value !== null && !isValidChannel(value)) throw new Error('invalid channel');
  const db = getDb();
  const row = db.prepare('SELECT update_channel FROM peers WHERE id = ?').get(peerId);
  if (!row) throw new Error('Peer not found');
  const from = row.update_channel || null;
  if (from === value) return { changed: false, from, to: value };
  db.prepare('UPDATE peers SET update_channel = ? WHERE id = ?').run(value, peerId);
  return { changed: true, from, to: value };
}

/**
 * Remember the version a client reported. Unknown product/platform keep the
 * stored value (a Windows heartbeat does not know its edition, the update
 * check does). Never throws.
 */
function recordClientVersion(peerId, { version, product, platform } = {}, now = Date.now()) {
  const id = Number(peerId);
  if (!Number.isInteger(id) || id <= 0) return false;
  const v = normalizeReportedVersion(version);
  if (!v) return false;
  const prod = normalizeProduct(product) || (normalizePlatform(platform) === 'android' ? 'android' : null);
  const plat = normalizePlatform(platform) || (prod === 'android' ? 'android' : prod ? 'windows' : null);

  const sig = `${v}|${prod || ''}|${plat || ''}`;
  const last = _recorded.get(id);
  if (last && last.sig === sig && now - last.at < RECORD_INTERVAL_MS) return false;

  try {
    getDb().prepare(`
      UPDATE peers
         SET client_version = ?,
             client_product = COALESCE(?, client_product),
             client_platform = COALESCE(?, client_platform),
             client_seen_at = datetime('now')
       WHERE id = ?`).run(v, prod, plat, id);
    _recorded.set(id, { sig, at: now });
    return true;
  } catch (err) {
    logger.debug({ err: err.message, peerId: id }, 'recording client version failed');
    return false;
  }
}

/**
 * Version overview for the settings page: per product the number of peers per
 * reported version (newest first), flagged when below the product minimum.
 */
function getOverview(policy = getPolicy()) {
  const rows = getDb().prepare(`
    SELECT client_product AS product, client_version AS version, COUNT(*) AS count, MAX(client_seen_at) AS last_seen
      FROM peers
     WHERE client_version IS NOT NULL AND client_version != ''
     GROUP BY client_product, client_version`).all();

  const byProduct = new Map();
  for (const r of rows) {
    const product = PRODUCTS.includes(r.product) ? r.product : 'unknown';
    if (!byProduct.has(product)) byProduct.set(product, []);
    byProduct.get(product).push({
      version: r.version,
      count: r.count,
      last_seen: r.last_seen,
      below_min: isBelowMinimum(product, r.version, policy),
    });
  }

  const order = [...PRODUCTS, 'unknown'];
  const products = [];
  for (const product of order) {
    const versions = byProduct.get(product);
    if (!versions) continue;
    versions.sort((a, b) => (compareVersions(b.version, a.version) || 0) || a.version.localeCompare(b.version));
    products.push({
      product,
      min_version: minVersionFor(product, policy),
      total: versions.reduce((n, x) => n + x.count, 0),
      below_min: versions.reduce((n, x) => n + (x.below_min ? x.count : 0), 0),
      versions,
    });
  }

  const unreported = getDb().prepare(
    "SELECT COUNT(*) AS n FROM peers WHERE (client_version IS NULL OR client_version = '') AND COALESCE(peer_type, 'client') != 'gateway'"
  ).get().n;

  return { products, unreported };
}

/** Peer row → extra read-only fields for the admin API. */
function decoratePeer(peer, policy = getPolicy()) {
  if (!peer) return peer;
  return {
    ...peer,
    update_channel_effective: effectiveChannel(peer, policy),
    client_min_version: minVersionFor(peer.client_product, policy),
    client_below_min: isBelowMinimum(peer.client_product, peer.client_version, policy),
  };
}

/**
 * Token of a public update request → { peer } (peer may be null for an
 * unbound token), or null when the token is unknown, expired, belongs to a
 * disabled user or lacks the scope for `path` (same rules as requireAuth).
 */
function resolveTokenPeer(rawToken, path) {
  const tokens = require('./tokens');
  const token = tokens.authenticate(rawToken);
  if (!token) return null;
  let scopes = token.scopes;
  if (token.user_id) {
    const users = require('./users');
    if (!users.isEnabled(token.user_id)) return null;
    const user = users.getById(token.user_id);
    if (user) scopes = users.filterScopesForRole(token.scopes, user.role);
  }
  if (!tokens.checkScope(scopes, path, 'GET')) return null;
  if (!token.peer_id) return { peer: null };
  return { peer: getDb().prepare('SELECT * FROM peers WHERE id = ?').get(token.peer_id) || null };
}

function _resetForTest() {
  _recorded.clear();
}

module.exports = {
  CHANNELS,
  DEFAULT_CHANNEL,
  MIN_VERSION_PRODUCTS,
  PRODUCTS,
  KEY_DEFAULT_CHANNEL,
  minVersionKey,
  parseVersion,
  compareVersions,
  normalizeReportedVersion,
  normalizeProduct,
  normalizePlatform,
  isValidChannel,
  getPolicy,
  validatePolicyInput,
  savePolicy,
  effectiveChannel,
  minVersionFor,
  isBelowMinimum,
  setPeerChannel,
  recordClientVersion,
  getOverview,
  decoratePeer,
  resolveTokenPeer,
  _resetForTest,
};
