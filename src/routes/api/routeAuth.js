'use strict';

const { Router } = require('express');
const { getDb } = require('../../db/connection');
const { syncToCaddy } = require('../../services/routes');
const {
  getAuthForRoute,
  createOrUpdateAuth,
  deleteAuth,
  generateTotpSecret,
  verifyTotp,
} = require('../../services/routeAuth');
const { isSmtpConfigured } = require('../../services/email');
const { encrypt } = require('../../utils/crypto');
const { requireFeature } = require('../../middleware/license');

// Mounted at /api/routes/:id/auth with mergeParams: true
const router = Router({ mergeParams: true });

// GET /api/routes/:id/auth — return auth config (no secrets)
router.get('/', (req, res) => {
  (async () => {
    const routeId = req.params.id;
    const auth = getAuthForRoute(routeId);

    if (!auth) {
      return res.json({ ok: true, data: null });
    }

    const { password_hash, totp_secret_encrypted, ...rest } = auth;
    res.json({
      ok: true,
      data: {
        ...rest,
        has_password: !!password_hash,
        has_totp: !!totp_secret_encrypted,
      },
    });
  })().catch((err) => res.status(500).json({ ok: false, error: err.message }));
});

// POST /api/routes/:id/auth — create or update auth config
router.post('/', requireFeature('route_auth'), (req, res) => {
  (async () => {
    const routeId = req.params.id;
    const db = getDb();

    // Validate route exists and is http type
    const route = db.prepare('SELECT id, route_type FROM routes WHERE id = ?').get(routeId);
    if (!route) {
      return res.status(404).json({ ok: false, error: req.t('route_auth.route_not_found') });
    }
    if (route.route_type !== 'http') {
      return res.status(400).json({ ok: false, error: req.t('route_auth.http_only') });
    }

    const {
      auth_type,
      two_factor_enabled,
      two_factor_method,
      email,
      password,
      totp_secret,
      session_max_age,
    } = req.body;

    // Validate auth_type
    const validAuthTypes = ['email_password', 'email_code', 'totp'];
    if (!auth_type || !validAuthTypes.includes(auth_type)) {
      return res.status(400).json({ ok: false, error: req.t('route_auth.invalid_auth_type') });
    }

    // Email required for email-based auth types
    if (['email_password', 'email_code'].includes(auth_type) && !email) {
      return res.status(400).json({ ok: false, error: req.t('route_auth.email_required') });
    }

    // Password required for password-based auth
    const existing = getAuthForRoute(routeId);
    if (auth_type === 'email_password' && !password && !(existing && existing.password_hash)) {
      return res.status(400).json({ ok: false, error: req.t('route_auth.password_required') });
    }

    // Check password complexity if a new password is being set
    if (password) {
      const { validatePasswordComplexity } = require('../../utils/validate');
      const complexityErrors = validatePasswordComplexity(password);
      if (complexityErrors) {
        const msg = complexityErrors.map(e => req.t(e.key).replace('{{min}}', e.params?.min || '')).join(', ');
        return res.status(400).json({ ok: false, error: msg });
      }
    }

    // SMTP required for email_code
    if (auth_type === 'email_code' && !isSmtpConfigured()) {
      return res.status(400).json({ ok: false, error: req.t('route_auth.smtp_required') });
    }

    // Validate 2FA method if 2FA enabled
    if (two_factor_enabled) {
      const validTwoFactorMethods = ['email_code', 'totp'];
      if (!two_factor_method || !validTwoFactorMethods.includes(two_factor_method)) {
        return res.status(400).json({ ok: false, error: req.t('route_auth.invalid_2fa_method') });
      }
      // SMTP required for email_code 2FA
      if (two_factor_method === 'email_code' && !isSmtpConfigured()) {
        return res.status(400).json({ ok: false, error: req.t('route_auth.smtp_required') });
      }
    }

    const result = await createOrUpdateAuth(
      routeId,
      {
        auth_type,
        two_factor_enabled,
        two_factor_method,
        email,
        password,
        totp_secret,
        session_max_age,
      },
      req.ip
    );

    // Sync Caddy config to apply forward auth
    try {
      await syncToCaddy();
    } catch (syncErr) {
      // Auth config saved but Caddy sync failed — log but don't fail
      require('../../utils/logger').warn({ err: syncErr }, 'Caddy sync failed after route auth update');
    }

    const { password_hash, totp_secret_encrypted, ...rest } = result;
    res.json({
      ok: true,
      data: {
        ...rest,
        has_password: !!password_hash,
        has_totp: !!totp_secret_encrypted,
      },
    });
  })().catch((err) => res.status(500).json({ ok: false, error: err.message }));
});

// DELETE /api/routes/:id/auth — delete auth config
router.delete('/', (req, res) => {
  (async () => {
    const routeId = req.params.id;
    deleteAuth(routeId, req.ip);
    try {
      await syncToCaddy();
    } catch (syncErr) {
      require('../../utils/logger').warn({ err: syncErr }, 'Caddy sync failed after route auth delete');
    }
    res.json({ ok: true });
  })().catch((err) => res.status(500).json({ ok: false, error: err.message }));
});

// POST /api/routes/:id/auth/totp-setup — generate a new TOTP secret
router.post('/totp-setup', (req, res) => {
  (async () => {
    const db = getDb();
    const routeId = req.params.id;

    const route = db.prepare('SELECT domain FROM routes WHERE id = ?').get(routeId);
    if (!route) {
      return res.status(404).json({ ok: false, error: req.t('route_auth.route_not_found') });
    }

    const { secret, uri } = generateTotpSecret(route.domain);
    res.json({ ok: true, data: { secret, uri } });
  })().catch((err) => res.status(500).json({ ok: false, error: err.message }));
});

// POST /api/routes/:id/auth/totp-verify — verify a TOTP token against a plain secret
router.post('/totp-verify', (req, res) => {
  (async () => {
    const { secret, token } = req.body;

    if (!secret || !token) {
      return res.status(400).json({ ok: false, error: req.t('route_auth.secret_and_token_required') });
    }

    // Encrypt the plain secret for verification
    const encryptedSecret = encrypt(secret);
    const valid = verifyTotp(encryptedSecret, token);
    res.json({ ok: true, data: { valid } });
  })().catch((err) => res.status(500).json({ ok: false, error: err.message }));
});

module.exports = router;
