'use strict';

// Passkey (WebAuthn) login for the admin UI (docs/feature-admin-passkeys.md).
//
// Owns admin_passkeys and users.webauthn_user_id (migration v84). The WebAuthn
// ceremony checks (challenge, origin, RP ID, signature, flags, counter) are
// done by @simplewebauthn/server; this module pins its inputs:
//   * origin and RP ID come ONLY from config.app.baseUrl — never from the
//     request (Host / Origin headers are attacker-influenced);
//   * user verification is REQUIRED: a passkey login replaces password AND
//     second factor, so the authenticator must contribute the "knowledge /
//     inherence" factor (PIN, biometrics) on top of possession;
//   * the sign counter is advanced with a compare-and-set UPDATE, so two
//     concurrent assertions with the same counter cannot both succeed.
// Challenges live in the caller's session (see routes); this module only
// verifies against the value it is handed. Key material, challenges and
// responses are never logged.

const crypto = require('node:crypto');
const net = require('node:net');
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');
const { getDb } = require('../db/connection');
const config = require('../../config/default');
const activity = require('./activity');
const logger = require('../utils/logger');

const RP_NAME = 'GateControl';
const CEREMONY_TIMEOUT_MS = 60 * 1000;
// Session-held challenge lifetime: the browser timeout plus some slack for a
// slow PIN entry. Expired or reused challenges are rejected by the routes.
const CHALLENGE_TTL_MS = 3 * 60 * 1000;
const MAX_PASSKEYS_PER_USER = 20;
const NAME_MAX = 64;
// EdDSA, ES256, RS256 — fixed instead of the library default so the offer
// does not change with the Node version (PQC algorithms on newer runtimes).
const SUPPORTED_ALGS = [-8, -7, -257];

function err(code, message) {
  return Object.assign(new Error(message || code), { code });
}

/**
 * Relying party derived from config.app.baseUrl (GC_BASE_URL). Returns null
 * when passkeys cannot work with that URL: unparsable, an IP address (not a
 * valid RP ID) or plain http on anything but localhost (no secure context).
 */
function getRelyingParty() {
  let u;
  try { u = new URL(String(config.app.baseUrl || '')); } catch { return null; }
  const host = u.hostname.toLowerCase();
  if (!host) return null;
  // IP literals (v4, or v6 in brackets) are not valid RP IDs.
  if (net.isIP(host) || host.startsWith('[') || host.includes(':')) return null;
  const isLocal = host === 'localhost' || host.endsWith('.localhost');
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLocal)) return null;
  return { rpID: host, origin: u.origin, rpName: RP_NAME };
}

function isAvailable() {
  return getRelyingParty() !== null;
}

function requireRp() {
  const rp = getRelyingParty();
  if (!rp) throw err('UNAVAILABLE', 'Passkeys need GC_BASE_URL with https and a host name');
  return rp;
}

function parseTransports(json) {
  if (!json) return undefined;
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr.filter((t) => typeof t === 'string') : undefined;
  } catch {
    return undefined;
  }
}

function publicRow(r) {
  return {
    id: r.id,
    name: r.name,
    created_at: r.created_at,
    last_used_at: r.last_used_at || null,
    device_type: r.device_type || null,
    backed_up: r.backed_up === 1,
    transports: parseTransports(r.transports) || [],
  };
}

function list(userId) {
  return getDb().prepare(
    'SELECT id, name, created_at, last_used_at, device_type, backed_up, transports FROM admin_passkeys WHERE user_id = ? ORDER BY created_at, id'
  ).all(userId).map(publicRow);
}

function count(userId) {
  return getDb().prepare('SELECT COUNT(*) AS n FROM admin_passkeys WHERE user_id = ?').get(userId).n;
}

/** Trimmed, control characters removed, at most NAME_MAX characters; '' if nothing is left. */
function normalizeName(input) {
  // eslint-disable-next-line no-control-regex
  return String(input == null ? '' : input).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, NAME_MAX);
}

/** Stable random user handle for this account (created on first use). */
function ensureUserHandle(userId) {
  const db = getDb();
  const row = db.prepare('SELECT webauthn_user_id FROM users WHERE id = ?').get(userId);
  if (!row) throw err('NOT_FOUND', 'User not found');
  if (row.webauthn_user_id) return row.webauthn_user_id;
  const handle = crypto.randomBytes(32).toString('base64url');
  // Only set when still empty: two parallel first registrations agree on one handle.
  db.prepare('UPDATE users SET webauthn_user_id = ? WHERE id = ? AND webauthn_user_id IS NULL').run(handle, userId);
  return db.prepare('SELECT webauthn_user_id FROM users WHERE id = ?').get(userId).webauthn_user_id;
}

// ── registration ──────────────────────────────────────────────────────

async function beginRegistration(userId) {
  const rp = requireRp();
  const user = getDb().prepare('SELECT id, username, display_name FROM users WHERE id = ? AND enabled = 1').get(userId);
  if (!user) throw err('NOT_FOUND', 'User not found');
  if (count(userId) >= MAX_PASSKEYS_PER_USER) throw err('LIMIT', 'Too many passkeys');
  const handle = ensureUserHandle(userId);
  const existing = getDb().prepare('SELECT credential_id, transports FROM admin_passkeys WHERE user_id = ?').all(userId);

  const options = await generateRegistrationOptions({
    rpName: rp.rpName,
    rpID: rp.rpID,
    userName: user.username,
    userDisplayName: user.display_name || user.username,
    userID: Buffer.from(handle, 'base64url'),
    timeout: CEREMONY_TIMEOUT_MS,
    attestationType: 'none',
    // The same authenticator cannot be registered twice for this account.
    excludeCredentials: existing.map((c) => ({ id: c.credential_id, transports: parseTransports(c.transports) })),
    // Discoverable credential → usernameless login; UV required (see header).
    authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
    supportedAlgorithmIDs: SUPPORTED_ALGS,
  });
  return { options, challenge: options.challenge };
}

async function finishRegistration(userId, { response, expectedChallenge, name, ip }) {
  const rp = requireRp();
  if (!expectedChallenge) throw err('NO_CHALLENGE', 'No registration in progress');
  if (!response || typeof response !== 'object') throw err('INVALID', 'Missing response');
  const user = getDb().prepare('SELECT id, username FROM users WHERE id = ? AND enabled = 1').get(userId);
  if (!user) throw err('NOT_FOUND', 'User not found');
  if (count(userId) >= MAX_PASSKEYS_PER_USER) throw err('LIMIT', 'Too many passkeys');

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpID,
      requireUserPresence: true,
      requireUserVerification: true,
      supportedAlgorithmIDs: SUPPORTED_ALGS,
    });
  } catch (e) {
    // Library messages describe the mismatch (origin, flags…), no secrets.
    logger.warn({ userId, reason: e.message }, 'Passkey registration rejected');
    throw err('VERIFY_FAILED', 'Passkey could not be verified');
  }
  if (!verification.verified || !verification.registrationInfo) throw err('VERIFY_FAILED', 'Passkey could not be verified');

  const info = verification.registrationInfo;
  const cred = info.credential;
  // The id the browser reports must be the one inside the signed
  // authenticator data — the stored id is always the attested one.
  if (response.id !== cred.id) throw err('VERIFY_FAILED', 'Credential id mismatch');
  const transports = Array.isArray(cred.transports) ? cred.transports.filter((t) => typeof t === 'string').slice(0, 8) : [];
  const finalName = normalizeName(name) || `Passkey ${count(userId) + 1}`;

  let id;
  try {
    id = getDb().prepare(`
      INSERT INTO admin_passkeys (user_id, credential_id, public_key, sign_count, transports, name, aaguid, device_type, backed_up)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      userId, cred.id, Buffer.from(cred.publicKey), cred.counter || 0, JSON.stringify(transports),
      finalName, info.aaguid || null, info.credentialDeviceType || null, info.credentialBackedUp ? 1 : 0,
    ).lastInsertRowid;
  } catch (e) {
    if (/UNIQUE/i.test(e.message)) throw err('DUPLICATE', 'This passkey is already registered');
    throw e;
  }

  activity.log('passkey_added', `Passkey "${finalName}" added for user "${user.username}"`, {
    source: 'admin', ipAddress: ip, severity: 'info', details: { userId, passkeyId: Number(id) },
  });
  logger.info({ userId, passkeyId: Number(id) }, 'Passkey added');
  return publicRow(getDb().prepare('SELECT * FROM admin_passkeys WHERE id = ?').get(id));
}

// ── removal ───────────────────────────────────────────────────────────

/**
 * Delete one of the user's own passkeys. Removing the last one is fine:
 * password (+ TOTP) login always stays available.
 */
function remove(userId, passkeyId, ip) {
  const db = getDb();
  const row = db.prepare('SELECT id, name FROM admin_passkeys WHERE id = ? AND user_id = ?').get(passkeyId, userId);
  if (!row) throw err('NOT_FOUND', 'Passkey not found');
  db.prepare('DELETE FROM admin_passkeys WHERE id = ? AND user_id = ?').run(passkeyId, userId);
  const user = db.prepare('SELECT username FROM users WHERE id = ?').get(userId);
  activity.log('passkey_removed', `Passkey "${row.name}" removed for user "${user ? user.username : userId}"`, {
    source: 'admin', ipAddress: ip, severity: 'warning', details: { userId, passkeyId: row.id },
  });
  logger.info({ userId, passkeyId: row.id }, 'Passkey removed');
}

// ── authentication ────────────────────────────────────────────────────

async function beginAuthentication() {
  const rp = requireRp();
  // Empty allowCredentials: discoverable credentials, the authenticator
  // picks the account (usernameless) — and the server reveals nothing about
  // which accounts exist.
  const options = await generateAuthenticationOptions({
    rpID: rp.rpID,
    timeout: CEREMONY_TIMEOUT_MS,
    userVerification: 'required',
  });
  return { options, challenge: options.challenge };
}

/**
 * Verify an assertion. Resolves to { user, passkey } on success; throws
 * { code: 'VERIFY_FAILED' | 'UNKNOWN_CREDENTIAL' | 'USER_DISABLED' |
 * 'COUNTER' | 'NO_CHALLENGE' | 'UNAVAILABLE' } otherwise.
 */
async function finishAuthentication({ response, expectedChallenge }) {
  const rp = requireRp();
  if (!expectedChallenge) throw err('NO_CHALLENGE', 'No login in progress');
  if (!response || typeof response !== 'object' || typeof response.id !== 'string' || !response.id) {
    throw err('VERIFY_FAILED', 'Missing response');
  }
  const db = getDb();
  const row = db.prepare('SELECT * FROM admin_passkeys WHERE credential_id = ?').get(response.id);
  if (!row) throw err('UNKNOWN_CREDENTIAL', 'Unknown passkey');
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id);
  if (!user) throw err('UNKNOWN_CREDENTIAL', 'Unknown passkey');

  // A discoverable credential returns the user handle it was created with;
  // it must name the account the credential belongs to.
  const userHandle = response.response && response.response.userHandle;
  if (!userHandle || !user.webauthn_user_id || userHandle !== user.webauthn_user_id) {
    throw err('VERIFY_FAILED', 'User handle mismatch');
  }

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpID,
      requireUserVerification: true,
      credential: {
        id: row.credential_id,
        publicKey: new Uint8Array(row.public_key),
        counter: row.sign_count,
        transports: parseTransports(row.transports),
      },
    });
  } catch (e) {
    const counter = /counter/i.test(e.message);
    logger.warn({ userId: user.id, passkeyId: row.id, reason: e.message }, 'Passkey assertion rejected');
    throw err(counter ? 'COUNTER' : 'VERIFY_FAILED', 'Passkey could not be verified');
  }
  if (!verification.verified) throw err('VERIFY_FAILED', 'Passkey could not be verified');

  // Disabled accounts are checked after the signature so the answer does not
  // reveal account state to someone without the credential.
  if (user.enabled !== 1) throw err('USER_DISABLED', 'Account disabled');

  const newCounter = verification.authenticationInfo.newCounter;
  // Compare-and-set: only advance from the value we verified against. A
  // concurrent assertion that already moved the counter makes this a no-op
  // → treated as a replay. Authenticators without a counter stay at 0.
  const upd = db.prepare(`
    UPDATE admin_passkeys
       SET sign_count = ?, last_used_at = datetime('now'),
           backed_up = ?
     WHERE id = ? AND sign_count = ? AND (? > sign_count OR (? = 0 AND sign_count = 0))
  `).run(newCounter, verification.authenticationInfo.credentialBackedUp ? 1 : 0, row.id, row.sign_count, newCounter, newCounter);
  if (upd.changes !== 1) {
    logger.warn({ userId: user.id, passkeyId: row.id }, 'Passkey counter race rejected');
    throw err('COUNTER', 'Passkey could not be verified');
  }

  return { user, passkey: publicRow(db.prepare('SELECT * FROM admin_passkeys WHERE id = ?').get(row.id)) };
}

module.exports = {
  getRelyingParty,
  isAvailable,
  list,
  count,
  normalizeName,
  beginRegistration,
  finishRegistration,
  remove,
  beginAuthentication,
  finishAuthentication,
  CHALLENGE_TTL_MS,
  MAX_PASSKEYS_PER_USER,
  NAME_MAX,
};
