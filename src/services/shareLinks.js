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

module.exports = { hashToken, generateToken, createShareLink };
