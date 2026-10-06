'use strict';

/**
 * Invitations to "Mein Bereich" (member self-service area).
 *
 * An admin invites a member: the member's self_service_enabled flag is set
 * and a one-time link /invite/<token> is created. The token is 32 random
 * bytes (base64url); only its SHA-256 is stored. It is valid for 72 hours
 * and can be used once: whoever opens it sets the member's password (the
 * password policy applies) and can then log in. A new invitation replaces
 * the open ones of the same member; switching "Mein Bereich" off, disabling,
 * demoting or deleting the account removes them (services/users.js).
 */

const crypto = require('node:crypto');
const argon2 = require('argon2');
const { getDb } = require('../db/connection');
const activity = require('./activity');
const logger = require('../utils/logger');
const argon2Options = require('../utils/argon2Options');

const INVITE_TTL_MS = 72 * 60 * 60 * 1000;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

function hashToken(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex');
}

function codedError(code, message) {
  const err = new Error(message || code);
  err.code = code;
  return err;
}

/**
 * Create an invitation for member `userId`. Returns { token, expiresAt } —
 * the raw token exists only in this return value.
 */
function create(userId, { actorId = null, ip = null } = {}) {
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) throw codedError('NOT_FOUND', 'User not found');
  if (user.role !== 'user') throw codedError('NOT_MEMBER', 'Only members are invited');
  if (user.enabled !== 1) throw codedError('DISABLED', 'User is disabled');
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = Date.now() + INVITE_TTL_MS;
  db.transaction(() => {
    db.prepare('DELETE FROM user_invites WHERE user_id = ? AND used_at IS NULL').run(userId);
    db.prepare('INSERT INTO user_invites (user_id, token_hash, expires_at, created_by) VALUES (?, ?, ?, ?)')
      .run(userId, hashToken(token), expiresAt, actorId);
    db.prepare("UPDATE users SET self_service_enabled = 1, updated_at = datetime('now') WHERE id = ?").run(userId);
  })();
  activity.log('user_invited', `Invitation to "Mein Bereich" created for user "${user.username}"`, {
    source: 'admin', ipAddress: ip, severity: 'info', details: { userId, actorId, expiresAt },
  });
  return { token, expiresAt };
}

/** The open invitation behind a raw token, with its member — or null. */
function lookup(raw) {
  if (typeof raw !== 'string' || !TOKEN_RE.test(raw)) return null;
  const db = getDb();
  const row = db.prepare(`SELECT i.id, i.user_id, i.expires_at, u.username, u.display_name, u.role, u.enabled, u.self_service_enabled
    FROM user_invites i JOIN users u ON u.id = i.user_id
    WHERE i.token_hash = ? AND i.used_at IS NULL AND i.expires_at > ?`).get(hashToken(raw), Date.now());
  if (!row || row.role !== 'user' || row.enabled !== 1 || row.self_service_enabled !== 1) return null;
  return row;
}

/**
 * Redeem: set the password and consume the invitation (atomic — two tabs
 * cannot both use it). Throws INVALID (unknown/used/expired) or
 * PASSWORD_POLICY (err.policy lists the violated rules).
 */
async function accept(raw, password, { ip = null } = {}) {
  const users = require('./users');
  const invite = lookup(raw);
  if (!invite) throw codedError('INVALID', 'Invitation invalid or expired');
  const policy = users.passwordPolicyErrors(password);
  if (policy.length) {
    const err = codedError('PASSWORD_POLICY', 'Password does not meet the policy');
    err.policy = policy;
    throw err;
  }
  const hash = await argon2.hash(password, argon2Options);
  const db = getDb();
  const ok = db.transaction(() => {
    const used = db.prepare('UPDATE user_invites SET used_at = ? WHERE id = ? AND used_at IS NULL AND expires_at > ?')
      .run(Date.now(), invite.id, Date.now());
    if (used.changes === 0) return false;
    db.prepare(`UPDATE users SET password_hash = ?, must_change_password = 0, password_changed_at = datetime('now'),
        updated_at = datetime('now') WHERE id = ? AND role = 'user' AND enabled = 1 AND self_service_enabled = 1`).run(hash, invite.user_id);
    db.prepare('DELETE FROM user_invites WHERE user_id = ? AND used_at IS NULL').run(invite.user_id);
    return true;
  })();
  if (!ok) throw codedError('INVALID', 'Invitation invalid or expired');
  activity.log('user_invite_accepted', `User "${invite.username}" accepted the invitation and set a password`, {
    source: 'user', ipAddress: ip, severity: 'info', details: { userId: invite.user_id },
  });
  logger.info({ userId: invite.user_id }, 'Invitation accepted');
  return { userId: invite.user_id, username: invite.username };
}

/** Open (unused, unexpired) invitation of a user: { expiresAt } or null. */
function openFor(userId) {
  const row = getDb().prepare('SELECT expires_at FROM user_invites WHERE user_id = ? AND used_at IS NULL AND expires_at > ? ORDER BY id DESC')
    .get(userId, Date.now());
  return row ? { expiresAt: row.expires_at } : null;
}

/**
 * Send the link by mail when SMTP is set up and the member has an address.
 * Resolves true when a mail went out; never throws.
 */
async function sendMail({ to, link, name, expiresAt, t }) {
  try {
    const email = require('./email');
    if (!to || !email.isSmtpConfigured()) return false;
    const date = new Date(expiresAt).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
    await email.sendMail({
      to,
      subject: t('invite.mail_subject'),
      text: t('invite.mail_body').replace('{{name}}', name).replace('{{link}}', link).replace('{{date}}', date),
    });
    return true;
  } catch (err) {
    logger.warn({ err: err.message }, 'Invitation mail could not be sent');
    return false;
  }
}

module.exports = { create, lookup, accept, openFor, sendMail, hashToken, INVITE_TTL_MS };
