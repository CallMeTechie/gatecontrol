'use strict';

const { csrfSync } = require('csrf-sync');

const {
  generateToken,
  csrfSynchronisedProtection,
} = csrfSync({
  getTokenFromRequest: (req) => {
    return req.body?._csrf || req.headers['x-csrf-token'];
  },
  getTokenFromState: (req) => {
    return req.session?.csrfToken;
  },
  storeTokenInState: (req, token) => {
    if (req.session) {
      req.session.csrfToken = token;
    }
  },
  size: 64,
});

function injectCsrfToken(req, res, next) {
  // Surface the CSRF token to templates *without* generating one for
  // every fresh visitor. Pre-generating turned every bot probe of
  // `/.git/config`, `/.env`, etc. into a 24h sessions-table row,
  // because csrf-sync writes `req.session.csrfToken` and bypasses
  // express-session's `saveUninitialized: false` short-circuit.
  //
  // Now we only generate when the request already has session state
  // worth protecting (authenticated user, or an existing token). Anon
  // visitors land with `csrfToken=''` — harmless in templates and JS
  // ({{ csrfToken }} renders empty), and routes that *need* a token
  // for the unauthenticated case (login form) call ensureCsrfToken()
  // explicitly before rendering.
  if (!req.session) {
    res.locals.csrfToken = '';
    return next();
  }
  if (req.session.csrfToken) {
    res.locals.csrfToken = req.session.csrfToken;
    return next();
  }
  if (req.session.userId) {
    // Authenticated request without a token yet (legacy session row,
    // or first request after session.regenerate()) — mint one.
    res.locals.csrfToken = generateToken(req, false);
    return next();
  }
  res.locals.csrfToken = '';
  next();
}

/**
 * Explicitly mint a CSRF token and expose it via res.locals — for
 * routes that render a form to anonymous visitors (login page).
 * Without this, an anon GET would render an empty `_csrf` value and
 * the subsequent POST would fail csrfProtection.
 */
function ensureCsrfToken(req, res) {
  if (req.session) {
    res.locals.csrfToken = generateToken(req, false);
  }
}

/**
 * Rotate the CSRF token (invalidates old token, generates new one).
 * Call after sensitive actions like password change or backup restore.
 * Returns the new token so the client can update its stored copy.
 */
function rotateCsrfToken(req) {
  if (!req.session) return '';
  return generateToken(req, true);
}

module.exports = {
  csrfProtection: csrfSynchronisedProtection,
  injectCsrfToken,
  ensureCsrfToken,
  rotateCsrfToken,
};
