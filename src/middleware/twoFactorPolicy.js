'use strict';

// security.require_2fa (docs/feature-admin-2fa.md): every admin account must
// have 2FA. An admin who logged in without it may only reach the profile
// page (to set it up), the endpoints the setup needs, and logout. Everything
// else redirects to the setup (pages) or answers 403 TWO_FA_REQUIRED (API).
// Token-authenticated API calls, the desktop client, gateways and the portal
// carry no session userId and are therefore never affected.

const settings = require('../services/settings');
const { getDb } = require('../db/connection');

const SETUP_REDIRECT = '/profile?setup2fa=1';

const ALLOWED_PAGE = /^\/(profile|logout)\/?$/;
const ALLOWED_API = /^\/api\/v1\/(profile\/2fa(\/|$)|settings\/(profile|language|password)\/?$|ping\/?$|events\/?$)/;

function isRequired() {
  return settings.get('security.require_2fa', 'false') === 'true';
}

function twoFactorPolicy(req, res, next) {
  if (!req.session || !req.session.userId) return next();
  if (!isRequired()) return next();

  const path = req.path;
  if (ALLOWED_PAGE.test(path) || ALLOWED_API.test(path)) return next();

  let user;
  try {
    user = getDb().prepare('SELECT role, totp_enabled FROM users WHERE id = ?').get(req.session.userId);
  } catch {
    return next();
  }
  if (!user || user.role !== 'admin' || user.totp_enabled === 1) return next();

  if (path.startsWith('/api/')) {
    return res.status(403).json({
      ok: false,
      error: req.t ? req.t('two_fa.error_setup_required') : 'Two-factor authentication required',
      code: 'TWO_FA_REQUIRED',
    });
  }
  return res.redirect(SETUP_REDIRECT);
}

module.exports = { twoFactorPolicy, isRequired, SETUP_REDIRECT };
