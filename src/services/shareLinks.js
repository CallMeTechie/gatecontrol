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

module.exports = { hashToken, generateToken, createShareLink, ensureShareGate, disableSharing };
