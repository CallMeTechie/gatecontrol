'use strict';

// Lazy-loaded to avoid DB connection at import time (breaks tests)
let tokens;
function getTokens() {
  if (!tokens) tokens = require('../services/tokens');
  return tokens;
}

/**
 * Extract Bearer or X-API-Token from request
 */
function extractToken(req) {
  if (!req.headers) return null;
  // Check Authorization: Bearer gc_xxx
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    if (token.startsWith('gc_')) return token;
  }

  // Check X-API-Token: gc_xxx
  const apiToken = req.headers['x-api-token'];
  if (apiToken && apiToken.startsWith('gc_')) return apiToken;

  // Check X-API-Key: gc_xxx (used by GateControl Windows/Desktop clients)
  const apiKey = req.headers['x-api-key'];
  if (apiKey && apiKey.startsWith('gc_')) return apiKey;

  return null;
}

function requireAuth(req, res, next) {
  // Defensive resets to prevent prototype pollution CSRF bypass
  req.tokenAuth = false;
  req.tokenId = null;
  req.tokenScopes = null;

  // First check session auth
  if (req.session && req.session.userId) {
    return next();
  }

  // Then check API token auth (only for /api/ routes)
  const fullUrl = req.originalUrl || (req.baseUrl + req.path);
  if (fullUrl.startsWith('/api/')) {
    const rawToken = extractToken(req);
    if (rawToken) {
      const tokenRecord = getTokens().authenticate(rawToken);
      if (tokenRecord) {
        // If token is assigned to a user, check user is enabled
        if (tokenRecord.user_id) {
          const users = require('../services/users');
          if (!users.isEnabled(tokenRecord.user_id)) {
            return res.status(403).json({ ok: false, error: 'User account is disabled' });
          }
        }

        // Filter scopes by user role (if assigned)
        let effectiveScopes = tokenRecord.scopes;
        if (tokenRecord.user_id) {
          const users = require('../services/users');
          const user = users.getById(tokenRecord.user_id);
          if (user) {
            effectiveScopes = users.filterScopesForRole(tokenRecord.scopes, user.role);
          }
        }

        // Check scope for this request
        const fullPath = req.baseUrl + req.path;
        if (!getTokens().checkScope(effectiveScopes, fullPath, req.method)) {
          return res.status(403).json({ ok: false, error: 'Token does not have permission for this resource' });
        }

        // Mark request as token-authenticated
        req.tokenAuth = true;
        req.tokenId = tokenRecord.id;
        req.tokenScopes = effectiveScopes;
        req.tokenPeerId = tokenRecord.peer_id || null;
        req.tokenUserId = tokenRecord.user_id || null;
        return next();
      }
    }
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  return res.redirect('/login');
}

function guestOnly(req, res, next) {
  if (req.session && req.session.userId) {
    return res.redirect('/');
  }
  return next();
}

module.exports = { requireAuth, guestOnly };
