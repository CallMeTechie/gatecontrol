'use strict';

/**
 * One-time tickets for opening a route from the apps with automatic login
 * ("Anmeldung aus den GateControl-Apps erlauben", route_auth.app_login).
 *
 * The apps call POST /api/v1/client/services/:id/open and open
 * `https://<route domain>/route-auth/app/<ticket>`; GET /route-auth/app/:ticket
 * (routes/routeAuth.js) consumes the ticket and sets the route-auth session
 * cookie on the route's own domain.
 *
 *   * 32 random bytes, base64url — only the SHA-256 is stored
 *   * valid for TTL_MS (60 s), single use (consumed atomically)
 *   * bound to the route and to the token / token owner at creation time
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
  getDb().prepare('DELETE FROM route_app_tickets WHERE expires_at < ?').run(now - TTL_MS);
}

/**
 * Create a ticket for a route. Returns { ticket, expiresIn } — the raw ticket
 * leaves this function exactly once and is never stored.
 */
function create({ routeId, tokenId, userId }) {
  if (routeId == null) throw Object.assign(new Error('routeId required'), { code: 'ROUTE_REQUIRED' });
  const now = Date.now();
  cleanup(now);
  const ticket = crypto.randomBytes(32).toString('base64url');
  getDb().prepare(`INSERT INTO route_app_tickets (ticket_hash, route_id, token_id, user_id, expires_at)
    VALUES (?, ?, ?, ?, ?)`).run(hashTicket(ticket), Number(routeId), tokenId == null ? null : tokenId, userId == null ? null : userId, now + TTL_MS);
  return { ticket, expiresIn: Math.round(TTL_MS / 1000) };
}

/**
 * Validate and consume a ticket. Returns { routeId, tokenId, userId } or null
 * (unknown, malformed, expired or already used). The UPDATE only matches an
 * unused, unexpired row, so two requests can never both win.
 */
function consume(raw) {
  if (typeof raw !== 'string' || !TICKET_RE.test(raw)) return null;
  const db = getDb();
  const now = Date.now();
  const hash = hashTicket(raw);
  const used = db.prepare('UPDATE route_app_tickets SET used_at = ? WHERE ticket_hash = ? AND used_at IS NULL AND expires_at > ?')
    .run(now, hash, now);
  if (used.changes !== 1) return null;
  const row = db.prepare('SELECT route_id, token_id, user_id FROM route_app_tickets WHERE ticket_hash = ?').get(hash);
  if (!row) return null;
  return { routeId: row.route_id, tokenId: row.token_id, userId: row.user_id };
}

module.exports = { create, consume, cleanup, hashTicket, TTL_MS };
