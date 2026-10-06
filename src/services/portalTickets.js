'use strict';

/**
 * One-time portal login tickets (automatic portal login on connect).
 *
 * The apps call POST /api/v1/client/portal-link right after the tunnel is
 * up and open `<portal>/auto?t=<ticket>` instead of the bare portal URL.
 *
 *   * 32 random bytes, base64url — only the SHA-256 is stored
 *   * valid for TTL_MS (60 s), single use (consumed atomically)
 *   * bound to the token's peer and the token's owner at creation time
 *   * never logged: neither here nor in the routes (only ids are)
 */

const crypto = require('node:crypto');
const { getDb } = require('../db/connection');

const TTL_MS = 60 * 1000;
const TICKET_RE = /^[A-Za-z0-9_-]{43}$/;

function hashTicket(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex');
}

/** Drop tickets that can no longer be used (expired or consumed a while ago). */
function cleanup(now = Date.now()) {
  getDb().prepare('DELETE FROM portal_tickets WHERE expires_at < ?').run(now - TTL_MS);
}

/**
 * Create a ticket for a device. Returns { ticket, expiresIn } — the raw
 * ticket leaves this function exactly once and is never stored.
 */
function create({ tokenId, peerId, userId }) {
  if (peerId == null) throw Object.assign(new Error('Token is not bound to a peer'), { code: 'NOT_REGISTERED' });
  const now = Date.now();
  cleanup(now);
  const ticket = crypto.randomBytes(32).toString('base64url');
  getDb().prepare(`INSERT INTO portal_tickets (ticket_hash, token_id, peer_id, user_id, expires_at)
    VALUES (?, ?, ?, ?, ?)`).run(hashTicket(ticket), tokenId == null ? null : tokenId, peerId, userId == null ? null : userId, now + TTL_MS);
  return { ticket, expiresIn: Math.round(TTL_MS / 1000) };
}

/**
 * Validate and consume a ticket. Returns { tokenId, peerId, userId } or
 * null (unknown, malformed, expired or already used). The UPDATE only
 * matches an unused, unexpired row, so two requests can never both win.
 */
function consume(raw) {
  if (typeof raw !== 'string' || !TICKET_RE.test(raw)) return null;
  const db = getDb();
  const now = Date.now();
  const hash = hashTicket(raw);
  const used = db.prepare('UPDATE portal_tickets SET used_at = ? WHERE ticket_hash = ? AND used_at IS NULL AND expires_at > ?')
    .run(now, hash, now);
  if (used.changes !== 1) return null;
  const row = db.prepare('SELECT token_id, peer_id, user_id FROM portal_tickets WHERE ticket_hash = ?').get(hash);
  if (!row) return null;
  return { tokenId: row.token_id, peerId: row.peer_id, userId: row.user_id };
}

module.exports = { create, consume, cleanup, hashTicket, TTL_MS };
