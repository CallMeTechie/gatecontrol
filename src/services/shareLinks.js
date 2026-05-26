'use strict';

const crypto = require('node:crypto');
const { getDb } = require('../db/connection');
const activity = require('./activity');

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function generateToken() {
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * Create a share link for a route. Returns { id, token, expiresAt }; the
 * plaintext token is returned ONCE and never stored (only its sha256).
 */
function createShareLink(routeId, { expiresInHours, oneTime, label, userId } = {}) {
  const db = getDb();
  const token = generateToken();
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + Number(expiresInHours) * 3600 * 1000).toISOString();
  const info = db.prepare(`
    INSERT INTO route_auth_share_links
      (route_id, token_hash, label, created_by_user_id, one_time, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(routeId, tokenHash, label || null, userId || null, oneTime ? 1 : 0, expiresAt);
  return { id: Number(info.lastInsertRowid), token, expiresAt };
}

/**
 * Make a route share-gated by inserting an auth_type='share' route_auth row,
 * idempotently. Returns true ONLY if it just enabled sharing (caller must then
 * regenerate Caddy). No-op (false) if the route already has any route_auth row.
 * Does NOT touch basic_auth (basic-auth routes are rejected at the API layer).
 */
function ensureShareGate(routeId) {
  const db = getDb();
  const info = db.prepare(`
    INSERT INTO route_auth (route_id, auth_type)
    VALUES (?, 'share')
    ON CONFLICT(route_id) DO NOTHING
  `).run(routeId);
  if (info.changes > 0) {
    activity.log('share_enabled', `Sharing enabled for route ${routeId}`, {
      details: { routeId }, source: 'admin', severity: 'info',
    });
    return true;
  }
  return false;
}

/**
 * Turn sharing off. Always deletes the route's share links + share guest
 * sessions. If the route's auth is the 'share' type (not real auth), also
 * removes the gate row → returns true so the caller regenerates Caddy.
 * Never removes a real (email/otp/totp) route_auth row.
 */
function disableSharing(routeId) {
  const db = getDb();
  const tx = db.transaction(() => {
    const auth = db.prepare('SELECT auth_type FROM route_auth WHERE route_id = ?').get(routeId);
    db.prepare('DELETE FROM route_auth_share_links WHERE route_id = ?').run(routeId);
    if (auth && auth.auth_type === 'share') {
      db.prepare('DELETE FROM route_auth_sessions WHERE route_id = ?').run(routeId);
      db.prepare("DELETE FROM route_auth WHERE route_id = ? AND auth_type = 'share'").run(routeId);
      activity.log('share_disabled', `Sharing disabled for route ${routeId}`, {
        details: { routeId }, source: 'admin', severity: 'info',
      });
      return true;
    }
    db.prepare('DELETE FROM route_auth_sessions WHERE route_id = ? AND share_link_id IS NOT NULL').run(routeId);
    return false;
  });
  return tx();
}

/**
 * Atomically redeem a token: validate, bump redeemed_count, create a guest
 * route_auth_session bound to the link with expiry = link expiry. Returns
 * { sessionId, expiresAt, routeId } or null if the token is invalid/expired/
 * revoked/already-used (one_time).
 */
function redeemShareLink(token, ip) {
  const db = getDb();
  const tokenHash = hashToken(token);
  const tx = db.transaction(() => {
    const link = db.prepare(`
      SELECT * FROM route_auth_share_links
      WHERE token_hash = ?
        AND revoked_at IS NULL
        AND expires_at > datetime('now')
        AND (one_time = 0 OR redeemed_count = 0)
    `).get(tokenHash);
    if (!link) return null;
    db.prepare(`
      UPDATE route_auth_share_links
      SET redeemed_count = redeemed_count + 1,
          last_redeemed_at = datetime('now'),
          last_redeemed_ip = ?
      WHERE id = ?
    `).run(ip || null, link.id);
    const sessionId = crypto.randomUUID();
    db.prepare(`
      INSERT INTO route_auth_sessions
        (id, route_id, email, ip_address, two_factor_pending, expires_at, share_link_id)
      VALUES (?, ?, 'share', ?, 0, ?, ?)
    `).run(sessionId, link.route_id, ip || null, link.expires_at, link.id);
    return { sessionId, expiresAt: link.expires_at, routeId: link.route_id };
  });
  return tx();
}

/** Active (non-revoked, non-expired) links for a route. Never returns the token. */
function listShareLinks(routeId) {
  const db = getDb();
  return db.prepare(`
    SELECT id, label, one_time, expires_at, redeemed_count, last_redeemed_at, created_at
    FROM route_auth_share_links
    WHERE route_id = ? AND revoked_at IS NULL AND expires_at > datetime('now')
    ORDER BY created_at DESC
  `).all(routeId);
}

/** Revoke a link and delete its guest sessions. Returns false if not found / already revoked. */
function revokeShareLink(routeId, linkId) {
  const db = getDb();
  const tx = db.transaction(() => {
    const r = db.prepare(`
      UPDATE route_auth_share_links SET revoked_at = datetime('now')
      WHERE id = ? AND route_id = ? AND revoked_at IS NULL
    `).run(linkId, routeId);
    if (r.changes === 0) return false;
    db.prepare('DELETE FROM route_auth_sessions WHERE share_link_id = ?').run(linkId);
    return true;
  });
  return tx();
}

module.exports = { hashToken, generateToken, createShareLink, ensureShareGate, disableSharing, redeemShareLink, listShareLinks, revokeShareLink };
