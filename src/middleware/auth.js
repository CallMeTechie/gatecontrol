'use strict';

const tokens = require('../services/tokens');

/**
 * Extract Bearer or X-API-Token from request
 */
function extractToken(req) {
  // Check Authorization: Bearer gc_xxx
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    if (token.startsWith('gc_')) return token;
  }

  // Check X-API-Token: gc_xxx
  const apiToken = req.headers['x-api-token'];
  if (apiToken && apiToken.startsWith('gc_')) return apiToken;

  return null;
}

function requireAuth(req, res, next) {
  // First check session auth
  if (req.session && req.session.userId) {
    return next();
  }

  // Then check API token auth (only for /api/ routes)
  if (req.path.startsWith('/api/')) {
    const rawToken = extractToken(req);
    if (rawToken) {
      const tokenRecord = tokens.authenticate(rawToken);
      if (tokenRecord) {
        // Check scope for this request
        const fullPath = req.baseUrl + req.path;
        if (!tokens.checkScope(tokenRecord.scopes, fullPath, req.method)) {
          return res.status(403).json({ ok: false, error: 'Token does not have permission for this resource' });
        }

        // Mark request as token-authenticated
        req.tokenAuth = true;
        req.tokenId = tokenRecord.id;
        req.tokenScopes = tokenRecord.scopes;
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
