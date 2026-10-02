'use strict';

const { safeLocalPath } = require('../utils/safePath');

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

// Cheap per-request account lookup for session auth. The statement is
// prepared lazily (the DB is not open at import time in tests) and cached per
// connection object so a closed/reopened test DB gets a fresh statement.
let _userStmt = null;
let _userStmtDb = null;
function loadSessionUser(userId) {
  const db = require('../db/connection').getDb();
  if (!_userStmt || _userStmtDb !== db) {
    _userStmt = db.prepare('SELECT id, role, enabled FROM users WHERE id = ?');
    _userStmtDb = db;
  }
  return _userStmt.get(userId) || null;
}

// Session belongs to a user that no longer exists or was disabled: drop it
// and answer like an expired session.
function rejectSession(req, res) {
  const fullUrl = req.originalUrl || (req.baseUrl + req.path);
  const respond = () => {
    if (fullUrl.startsWith('/api/')) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }
    return res.redirect('/login');
  };
  if (req.session && typeof req.session.destroy === 'function') {
    return req.session.destroy(() => respond());
  }
  return respond();
}

function requireAuth(req, res, next) {
  req.sessionUser = null;
  // Defensive resets to prevent prototype pollution CSRF bypass
  req.tokenAuth = false;
  req.tokenId = null;
  req.tokenScopes = null;

  // First check session auth. The session only stores the userId, so the
  // account is re-checked on every request: a deleted or disabled user must
  // not keep working with a session that was issued before the change.
  if (req.session && req.session.userId) {
    const sessionUser = loadSessionUser(req.session.userId);
    if (sessionUser && sessionUser.enabled === 1) {
      req.sessionUser = sessionUser;
      return next();
    }
    return rejectSession(req, res);
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

// Validate a post-login `returnTo` target. Internal-only and deliberately
// restricted to the portal path so a portal login returns to the portal —
// never an open redirect. The generic checks (protocol-relative `//host`,
// backslash tricks, control characters) live in utils/safePath and are shared
// with the route-auth login; any non-portal path falls back to the admin
// default.
function safeReturnTo(v) {
  const p = safeLocalPath(v);
  if (!p) return null;
  return /^\/portal(?:[/?#]|$)/.test(p) ? p : null;
}

// Paths below /api/v1 that a session WITHOUT the admin role may still use:
// its own profile, password, language and 2FA, plus the session probe.
// Everything else under /api/v1 is the admin API. Token requests are not
// affected — they are governed by their scopes (services/tokens.checkScope).
// The client API (/api/v1/client/*) is token-only and gateway/portal/public
// endpoints are mounted outside this router.
const SELF_SERVICE_PATHS = [
  /^\/ping$/,
  /^\/profile(?:\/|$)/,
  /^\/settings\/(?:profile|password|language)$/,
];

function isAdminSession(req) {
  const u = req.sessionUser
    || (req.session && req.session.userId ? loadSessionUser(req.session.userId) : null);
  return !!(u && u.enabled === 1 && u.role === 'admin');
}

function forbidden(req, res, key, fallback) {
  const msg = typeof req.t === 'function' ? req.t(key) : fallback;
  return res.status(403).json({ ok: false, error: msg });
}

/**
 * Central role gate for the admin API (mounted after requireAuth on
 * /api/v1). Session requests need role 'admin' except for the
 * SELF_SERVICE_PATHS; token requests pass through (scopes decide).
 */
function requireAdmin(req, res, next) {
  if (req.tokenAuth) return next();
  if (isAdminSession(req)) return next();
  // Express matches case-insensitively and ignores a trailing slash —
  // normalise the same way before consulting the allow-list.
  const p = String(req.path || '').toLowerCase().replace(/\/+$/, '') || '/';
  if (SELF_SERVICE_PATHS.some((rx) => rx.test(p))) return next();
  return forbidden(req, res, 'error.users.admin_required', 'Admin role required');
}

/**
 * Router guard for session-only admin areas (users, enrollment, integrations):
 * API tokens are refused outright, a session needs the admin role.
 */
function requireAdminSession(req, res, next) {
  if (req.tokenAuth) {
    return forbidden(req, res, 'error.users.session_required', 'Session authentication required');
  }
  if (!req.session || !req.session.userId) {
    const msg = typeof req.t === 'function' ? req.t('error.users.unauthorized') : 'Unauthorized';
    return res.status(401).json({ ok: false, error: msg });
  }
  if (!isAdminSession(req)) {
    return forbidden(req, res, 'error.users.admin_required', 'Admin role required');
  }
  return next();
}

function guestOnly(req, res, next) {
  if (req.session && req.session.userId) {
    return res.redirect(safeReturnTo(req.query && req.query.returnTo) || '/');
  }
  return next();
}

module.exports = { requireAuth, requireAdmin, requireAdminSession, guestOnly, safeReturnTo, SELF_SERVICE_PATHS, extractToken };
