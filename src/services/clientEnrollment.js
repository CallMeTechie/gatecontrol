'use strict';

/**
 * One-scan app setup for the Android client.
 *
 * Before: the admin created a peer (QR = bare WireGuard config, VPN only),
 * then minted a 96-char API token under /users and the user typed it into
 * the app. The token was not bound to the peer, so peer-scoped endpoints
 * (traffic, peer-info, config/check) stayed dark.
 *
 * Now: the admin issues an enrollment code for a peer (or for a user, then
 * the peer is created on redeem). The app scans
 *   gatecontrol://enroll?url=<server>&code=XXXX-XXXX-XXXX-XXXX
 * and POSTs the code to /api/v1/client/enroll. The redeem mints an API token
 * that is already bound to the peer (and to the device fingerprint when
 * machine binding is active) and returns it together with the WG config.
 * The raw token never appears on screen.
 *
 * Storage mirrors gateway pairing codes: only the SHA-256 hash at rest,
 * single-active per peer, 10-minute TTL, consumed atomically.
 *
 * Two kinds of code:
 *   device  (createCode)      app setup for a peer or a new device; client
 *                             scopes only, token bound to the peer
 *   token   (createTokenCode) the token wizard: any scopes incl. full-access,
 *                             expiry, optional peer, split-tunnel preset —
 *                             for Windows clients, scripts and automation.
 *                             The raw token is only ever handed to whoever
 *                             redeems the code.
 */

const crypto = require('node:crypto');
const { getDb } = require('../db/connection');
const peers = require('./peers');
const tokens = require('./tokens');
const users = require('./users');
const settings = require('./settings');
const activity = require('./activity');
const license = require('./license');
const logger = require('../utils/logger');
const { validatePeerName } = require('../utils/validate');

const CODE_TTL_MS = 10 * 60 * 1000;
const FINGERPRINT_RE = /^[a-f0-9]{64}$/;

// Scopes the app can use. Admin scopes (peers, routes, settings, …) and
// full-access are deliberately not enrollable — a phone never needs them.
const ENROLLABLE_SCOPES = [
  'client', 'client:services', 'client:traffic', 'client:dns', 'client:rdp',
  'pihole', 'pihole:control',
];
const DEFAULT_SCOPES = [
  'client', 'client:services', 'client:traffic', 'client:dns', 'client:rdp', 'pihole',
];
const TOKEN_NAME_PREFIX = 'App: ';

function _generateCode() {
  const hex = crypto.randomBytes(8).toString('hex').toUpperCase();
  return `${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}`;
}

function _hashCode(code) {
  return crypto.createHash('sha256').update(code).digest('hex');
}

/**
 * Accepts the code as typed by a human: lower case, spaces, missing dashes.
 * Returns the canonical XXXX-XXXX-XXXX-XXXX form or null.
 */
function normalizeCode(raw) {
  if (typeof raw !== 'string') return null;
  const hex = raw.toUpperCase().replace(/[^A-F0-9]/g, '');
  if (hex.length !== 16) return null;
  return `${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}`;
}

function _error(code, message) {
  const err = new Error(message || code);
  err.code = code;
  return err;
}

/**
 * Resolve the scopes a token gets: enrollable subset, 'client' always
 * present (register/config/ping need it), capped by the owner's role.
 */
function resolveScopes(requested, userId) {
  const base = Array.isArray(requested) && requested.length ? requested : DEFAULT_SCOPES;
  let scopes = [...new Set(['client', ...base])].filter((s) => ENROLLABLE_SCOPES.includes(s));
  if (userId != null) {
    const user = users.getById(userId);
    if (!user) throw _error('user_not_found');
    scopes = users.filterScopesForRole(scopes, user.role);
  }
  if (!scopes.includes('client')) throw _error('no_valid_scopes');
  return scopes;
}

function _bindingActive(tokenRow) {
  if (!license.hasFeature('machine_binding')) return false;
  const mode = settings.get('machine_binding.mode', 'off');
  if (mode === 'global') return true;
  if (mode === 'individual') return !!(tokenRow && tokenRow.machine_binding_enabled);
  return false;
}

/**
 * Issue an enrollment code.
 *   peerId   existing peer the app takes over (keeps IP + config); or null
 *            together with userId → a new peer is created on redeem
 *   userId   owner; defaults to the peer's owner. Caps the scopes by role.
 *   scopes   optional subset of ENROLLABLE_SCOPES (default DEFAULT_SCOPES)
 *   machineBinding  bind the token to the device fingerprint on redeem
 *                   (effective when machine binding is licensed + enabled)
 * Returns { code, expiresAt, scopes, peerId, userId } — cleartext code once.
 */
function createCode({ peerId = null, userId, scopes, machineBinding = false } = {}) {
  const db = getDb();
  let peer = null;
  if (peerId != null) {
    peer = peers.getById(Number(peerId));
    if (!peer) throw _error('peer_not_found');
    if (peer.peer_type && peer.peer_type !== 'regular') throw _error('peer_not_client');
  }

  const ownerId = userId !== undefined && userId !== null
    ? Number(userId)
    : (peer && peer.user_id != null ? Number(peer.user_id) : null);
  if (peer == null && ownerId == null) throw _error('target_required');

  const resolvedScopes = resolveScopes(scopes, ownerId);

  db.prepare('DELETE FROM client_enrollment_codes WHERE expires_at <= ?').run(Date.now());
  if (peer) {
    // Single active code per peer — regenerate revokes the previous one.
    db.prepare('DELETE FROM client_enrollment_codes WHERE peer_id = ? AND consumed_at IS NULL').run(peer.id);
  }

  const code = _generateCode();
  const expiresAt = Date.now() + CODE_TTL_MS;
  db.prepare(`
    INSERT INTO client_enrollment_codes (code_hash, peer_id, user_id, scopes, machine_binding, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(_hashCode(code), peer ? peer.id : null, ownerId, JSON.stringify(resolvedScopes),
    machineBinding ? 1 : 0, expiresAt);

  try {
    activity.log('client_enrollment_created',
      peer ? `App setup code created for peer "${peer.name}"` : 'App setup code created for a new device',
      { source: 'admin', severity: 'info', details: { peerId: peer ? peer.id : null, userId: ownerId, scopes: resolvedScopes, expiresAt } });
  } catch (err) { logger.warn({ err: err.message }, 'activity log write failed (client_enrollment_created)'); }

  return { code, expiresAt, scopes: resolvedScopes, peerId: peer ? peer.id : null, userId: ownerId };
}

/**
 * Issue a code for a token as the wizard defines it (kind 'token').
 *   name, scopes (any valid scopes incl. full-access), userId (owner, caps
 *   scopes by role), peerId (optional binding), expiresAt (ISO, optional),
 *   machineBinding, splitTunnelOverride (validated preset object, optional).
 * Returns { code, expiresAt, scopes } — cleartext code once.
 */
function createTokenCode({ name, scopes, userId = null, peerId = null, expiresAt = null,
  machineBinding = false, splitTunnelOverride = null } = {}) {
  const db = getDb();
  if (!name || typeof name !== 'string' || !name.trim()) throw _error('name_required');
  if (name.trim().length > 100) throw _error('name_too_long');
  const ownerId = userId != null ? Number(userId) : null;
  const resolvedScopes = resolveTokenScopes(scopes, ownerId);
  if (peerId != null && !peers.getById(Number(peerId))) throw _error('peer_not_found');
  if (expiresAt) {
    const d = new Date(expiresAt);
    if (isNaN(d.getTime()) || d <= new Date()) throw _error('expiry_in_past');
  }

  db.prepare('DELETE FROM client_enrollment_codes WHERE expires_at <= ?').run(Date.now());
  const code = _generateCode();
  const codeExpiresAt = Date.now() + CODE_TTL_MS;
  db.prepare(`
    INSERT INTO client_enrollment_codes
      (code_hash, kind, peer_id, user_id, scopes, machine_binding, expires_at,
       token_name, token_expires_at, split_tunnel_override)
    VALUES (?, 'token', ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(_hashCode(code), peerId != null ? Number(peerId) : null, ownerId,
    JSON.stringify(resolvedScopes), machineBinding ? 1 : 0, codeExpiresAt,
    name.trim(), expiresAt || null,
    splitTunnelOverride ? JSON.stringify(splitTunnelOverride) : null);

  try {
    activity.log('client_enrollment_created', `Setup code created for token "${name.trim()}"`,
      { source: 'admin', severity: 'info', details: { userId: ownerId, peerId, scopes: resolvedScopes, expiresAt: codeExpiresAt } });
  } catch (err) { logger.warn({ err: err.message }, 'activity log write failed (client_enrollment_created)'); }

  return { code, expiresAt: codeExpiresAt, scopes: resolvedScopes };
}

/** Wizard scopes: any valid scope (full-access included), capped by the owner's role. */
function resolveTokenScopes(requested, userId) {
  if (!Array.isArray(requested) || !requested.length || tokens.validateScopes(requested)) {
    throw _error('no_valid_scopes');
  }
  let scopes = [...new Set(requested)];
  if (userId != null) {
    const user = users.getById(userId);
    if (!user) throw _error('user_not_found');
    scopes = users.filterScopesForRole(scopes, user.role);
  }
  if (!scopes.length) throw _error('no_valid_scopes');
  return scopes;
}

function _uniquePeerName(hostname) {
  const db = getDb();
  const baseName = String(hostname || '').replace(/[^\w.\-]/g, '_').substring(0, 50) || 'device';
  if (validatePeerName(baseName)) throw _error('invalid_hostname');
  let name = baseName;
  for (let suffix = 2; db.prepare('SELECT 1 FROM peers WHERE name = ?').get(name); suffix++) {
    const tail = `-${suffix}`;
    name = `${baseName.substring(0, 63 - tail.length)}${tail}`;
  }
  return name;
}

function _isAndroid(platform) {
  return String(platform || '').toLowerCase() === 'android';
}

function _clientLabel(platform, clientVersion) {
  const p = String(platform || 'unknown').substring(0, 20);
  const label = _isAndroid(p) ? 'Android Client'
    : /^win/i.test(p) ? 'Desktop Client' : 'Client';
  return `${label} (${p}, v${String(clientVersion || '?').substring(0, 20)})`;
}

// Same hash the client routes use (routes/api/client/helpers.js hashConfig).
function _hashConfig(config) {
  return crypto.createHash('sha256').update(config).digest('hex');
}

/**
 * Redeem a code. Throws Error with .code:
 *   invalid_or_expired  unknown, expired or already used (never says which)
 *   fingerprint_required  binding is active but no valid fingerprint sent
 *   user_disabled, limit_reached, invalid_hostname, peer_not_found
 * On success returns { kind, token, peerId, peerName, config, hash, scopes };
 * a 'token' code without a peer returns peerId/config null — the client then
 * registers with the token as before.
 */
async function redeemCode(rawCode, { hostname, platform, clientVersion, fingerprint } = {}, sourceIp = null) {
  const code = normalizeCode(rawCode);
  if (!code) throw _error('invalid_or_expired');
  const db = getDb();
  const codeHash = _hashCode(code);
  const now = Date.now();

  // Atomic mark-consumed: two devices racing on one code cannot both win.
  const update = db.prepare(`
    UPDATE client_enrollment_codes SET consumed_at = ?, consumed_from_ip = ?
    WHERE code_hash = ? AND consumed_at IS NULL AND expires_at > ?
  `).run(now, sourceIp, codeHash, now);
  if (update.changes === 0) throw _error('invalid_or_expired');

  const row = db.prepare('SELECT * FROM client_enrollment_codes WHERE code_hash = ?').get(codeHash);

  // Any failure below hands the code back, so a transient error (peer limit,
  // bad fingerprint) does not force the admin to issue a new one.
  const release = () => {
    try {
      db.prepare('UPDATE client_enrollment_codes SET consumed_at = NULL, consumed_from_ip = NULL WHERE code_hash = ? AND token_id IS NULL')
        .run(codeHash);
    } catch (err) { logger.warn({ err: err.message }, 'enrollment: releasing setup code failed'); }
  };

  let createdPeerId = null;
  let createdTokenId = null;
  try {
    if (row.user_id != null) {
      const owner = users.getById(row.user_id);
      if (!owner) throw _error('user_not_found');
      if (!users.isEnabled(row.user_id)) throw _error('user_disabled');
    }
    const isTokenCode = row.kind === 'token';
    const scopes = isTokenCode
      ? resolveTokenScopes(JSON.parse(row.scopes), row.user_id)
      : resolveScopes(JSON.parse(row.scopes), row.user_id);

    const fp = typeof fingerprint === 'string' ? fingerprint.trim().toLowerCase() : '';
    const bindingWanted = _bindingActive({ machine_binding_enabled: row.machine_binding === 1 });
    if (bindingWanted && !FINGERPRINT_RE.test(fp)) throw _error('fingerprint_required');

    if (isTokenCode) {
      // Wizard token: minted exactly as the wizard defined it. No peer is
      // created here — without a peer the client registers afterwards.
      const boundPeer = row.peer_id != null ? peers.getById(row.peer_id) : null;
      if (row.peer_id != null && !boundPeer) throw _error('peer_not_found');
      const created = tokens.create({
        name: row.token_name,
        scopes,
        expiresAt: row.token_expires_at || null,
        machineBindingEnabled: row.machine_binding === 1,
        userId: row.user_id,
        peerId: row.peer_id,
        splitTunnelOverride: row.split_tunnel_override || null,
      }, sourceIp);
      createdTokenId = created.token.id;
      db.prepare('UPDATE client_enrollment_codes SET token_id = ? WHERE code_hash = ?').run(created.token.id, codeHash);
      if (bindingWanted) tokens.bindMachineFingerprint(created.token.id, fp);
      const tokenConfig = boundPeer ? await peers.getClientConfig(boundPeer.id) : null;

      try {
        activity.log('client_enrollment_redeemed',
          `Setup code redeemed for token "${row.token_name}"${sourceIp ? ` from ${sourceIp}` : ''}`,
          { source: 'api', severity: 'info', details: { tokenId: created.token.id, peerId: row.peer_id, platform, clientVersion } });
      } catch (err) { logger.warn({ err: err.message }, 'activity log write failed (client_enrollment_redeemed)'); }
      logger.info({ tokenId: created.token.id }, 'Token setup code redeemed');

      return {
        kind: 'token',
        token: created.rawToken,
        peerId: boundPeer ? boundPeer.id : null,
        peerName: boundPeer ? boundPeer.name : null,
        config: tokenConfig,
        hash: tokenConfig ? _hashConfig(tokenConfig) : null,
        scopes,
      };
    }

    let peer;
    if (row.peer_id != null) {
      peer = peers.getById(row.peer_id);
      if (!peer) throw _error('peer_not_found');
    } else {
      const count = db.prepare('SELECT COUNT(*) AS c FROM peers').get().c;
      if (!license.isWithinLimit('vpn_peers', count)) throw _error('limit_reached');
      peer = await peers.create({
        name: _uniquePeerName(hostname),
        description: _clientLabel(platform, clientVersion),
        tags: _isAndroid(platform) ? 'mobile-client' : 'desktop-client',
        userId: row.user_id,
      });
      createdPeerId = peer.id;
    }

    const created = tokens.create({
      name: `${TOKEN_NAME_PREFIX}${peer.name}`.substring(0, 100),
      scopes,
      machineBindingEnabled: row.machine_binding === 1,
      userId: row.user_id,
      peerId: peer.id,
    }, sourceIp);
    createdTokenId = created.token.id;
    db.prepare('UPDATE api_tokens SET enrolled = 1 WHERE id = ?').run(created.token.id);
    db.prepare('UPDATE client_enrollment_codes SET token_id = ? WHERE code_hash = ?').run(created.token.id, codeHash);

    if (bindingWanted) tokens.bindMachineFingerprint(created.token.id, fp);

    // Last step that can fail — before anything irreversible happens.
    const config = await peers.getClientConfig(peer.id);

    // A device re-enrolled for the same peer replaces its predecessor: the
    // old app token is revoked, hand-made tokens stay untouched. Runs after
    // the new token exists so a failure never leaves the peer without one.
    const previous = db.prepare('SELECT id FROM api_tokens WHERE peer_id = ? AND enrolled = 1 AND id != ?')
      .all(peer.id, created.token.id);
    for (const t of previous) {
      try { tokens.revoke(t.id, sourceIp); } catch (err) { logger.warn({ err: err.message, tokenId: t.id }, 'enrollment: revoking previous app token failed'); }
    }

    if (row.peer_id != null) {
      try {
        db.prepare("UPDATE peers SET description = ?, updated_at = datetime('now') WHERE id = ?")
          .run(_clientLabel(platform, clientVersion), peer.id);
      } catch (err) { logger.debug({ err: err.message, peerId: peer.id }, 'enrollment: updating peer description failed'); }
    }

    try {
      activity.log('client_enrollment_redeemed',
        `App set up for peer "${peer.name}"${sourceIp ? ` from ${sourceIp}` : ''}`,
        { source: 'api', severity: 'info', details: { peerId: peer.id, tokenId: created.token.id, platform, clientVersion, newPeer: createdPeerId != null } });
    } catch (err) { logger.warn({ err: err.message }, 'activity log write failed (client_enrollment_redeemed)'); }
    logger.info({ peerId: peer.id, tokenId: created.token.id }, 'Client enrollment redeemed');

    return {
      kind: 'device',
      token: created.rawToken,
      peerId: peer.id,
      peerName: peer.name,
      config,
      hash: _hashConfig(config),
      scopes,
    };
  } catch (err) {
    // Neither the token nor a peer minted by this redeem may outlive it.
    if (createdTokenId != null) {
      try {
        db.prepare('DELETE FROM api_tokens WHERE id = ?').run(createdTokenId);
        db.prepare('UPDATE client_enrollment_codes SET token_id = NULL WHERE code_hash = ?').run(codeHash);
      } catch (cleanupErr) { logger.warn({ err: cleanupErr.message, tokenId: createdTokenId }, 'enrollment rollback: removing token failed'); }
    }
    if (createdPeerId != null) {
      try { await peers.remove(createdPeerId); } catch (cleanupErr) { logger.warn({ err: cleanupErr.message, peerId: createdPeerId }, 'enrollment rollback: removing peer failed'); }
    }
    release();
    throw err;
  }
}

module.exports = {
  createCode,
  createTokenCode,
  resolveTokenScopes,
  redeemCode,
  normalizeCode,
  resolveScopes,
  ENROLLABLE_SCOPES,
  DEFAULT_SCOPES,
  CODE_TTL_MS,
};
