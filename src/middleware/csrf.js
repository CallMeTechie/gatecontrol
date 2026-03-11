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
  if (req.session) {
    // Generate token if none exists, reuse existing token otherwise
    const token = generateToken(req, false);
    res.locals.csrfToken = token;
  } else {
    res.locals.csrfToken = '';
  }
  next();
}

module.exports = {
  csrfProtection: csrfSynchronisedProtection,
  injectCsrfToken,
};
