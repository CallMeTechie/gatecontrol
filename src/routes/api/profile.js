'use strict';

// Own-account two-factor management (docs/feature-admin-2fa.md).
// Session-only (no API tokens), CSRF via the /api/v1 aggregator.

const { Router } = require('express');
const argon2 = require('argon2');
const { getDb } = require('../../db/connection');
const twoFactor = require('../../services/adminTwoFactor');
const { twoFactorSetupLimiter } = require('../../middleware/rateLimit');
const { isRequired } = require('../../middleware/twoFactorPolicy');
const logger = require('../../utils/logger');

const router = Router();

router.use((req, res, next) => {
  if (req.tokenAuth || !req.session || !req.session.userId) {
    return res.status(403).json({ ok: false, error: req.t('two_fa.error_session_required') });
  }
  next();
});

async function passwordMatches(userId, password) {
  if (typeof password !== 'string' || !password) return false;
  const row = getDb().prepare('SELECT password_hash FROM users WHERE id = ?').get(userId);
  if (!row || !row.password_hash || row.password_hash === '!') return false;
  try { return await argon2.verify(row.password_hash, password); } catch { return false; }
}

function fail(res, err, req) {
  const map = { NOT_FOUND: 404, ALREADY_ENABLED: 409, NO_SETUP: 400, NOT_ENABLED: 409 };
  const status = map[err && err.code] || 500;
  if (status === 500) logger.error({ err: err.message }, 'Profile 2FA handler failed');
  return res.status(status).json({ ok: false, error: status === 500 ? req.t('common.error') : err.message, code: err.code || 'ERROR' });
}

/** GET /api/v1/profile/2fa — status for the profile card */
router.get('/2fa', (req, res) => {
  const status = twoFactor.getStatus(req.session.userId);
  if (!status) return res.status(404).json({ ok: false, error: req.t('error.settings.user_not_found') });
  res.json({ ok: true, data: { ...status, required: isRequired() } });
});

/** POST /api/v1/profile/2fa/setup → { secret, otpauth_url } (not active yet) */
router.post('/2fa/setup', twoFactorSetupLimiter, (req, res) => {
  try {
    const data = twoFactor.beginSetup(req.session.userId);
    res.json({ ok: true, data });
  } catch (err) {
    fail(res, err, req);
  }
});

/** POST /api/v1/profile/2fa/confirm { code } → { recovery_codes } (shown once) */
router.post('/2fa/confirm', twoFactorSetupLimiter, async (req, res) => {
  try {
    const code = typeof req.body.code === 'string' ? req.body.code.trim() : '';
    if (!code) return res.status(400).json({ ok: false, error: req.t('two_fa.error_code_required') });
    const result = await twoFactor.confirmSetup(req.session.userId, code, req.ip);
    if (!result.ok) return res.status(400).json({ ok: false, error: req.t('two_fa.error_code_invalid'), code: 'CODE_INVALID' });
    res.json({ ok: true, data: { recovery_codes: result.recovery_codes } });
  } catch (err) {
    fail(res, err, req);
  }
});

/** POST /api/v1/profile/2fa/recovery-codes { password } → fresh codes */
router.post('/2fa/recovery-codes', async (req, res) => {
  try {
    if (!(await passwordMatches(req.session.userId, req.body.password))) {
      return res.status(400).json({ ok: false, error: req.t('error.settings.password_incorrect'), code: 'PASSWORD_INVALID' });
    }
    const recovery_codes = await twoFactor.regenerateRecoveryCodes(req.session.userId, req.ip);
    res.json({ ok: true, data: { recovery_codes } });
  } catch (err) {
    fail(res, err, req);
  }
});

/** POST /api/v1/profile/2fa/disable { password, code } — 409 TWO_FA_REQUIRED under policy */
router.post('/2fa/disable', async (req, res) => {
  try {
    const userId = req.session.userId;
    if (isRequired()) {
      const me = getDb().prepare('SELECT role FROM users WHERE id = ?').get(userId);
      if (me && me.role === 'admin') {
        return res.status(409).json({ ok: false, error: req.t('two_fa.error_required_policy'), code: 'TWO_FA_REQUIRED' });
      }
    }
    if (!twoFactor.isEnabled(userId)) {
      return res.status(409).json({ ok: false, error: req.t('two_fa.error_not_enabled'), code: 'NOT_ENABLED' });
    }
    if (!(await passwordMatches(userId, req.body.password))) {
      return res.status(400).json({ ok: false, error: req.t('error.settings.password_incorrect'), code: 'PASSWORD_INVALID' });
    }
    const code = typeof req.body.code === 'string' ? req.body.code.trim() : '';
    if (!twoFactor.verifyCode(userId, code)) {
      return res.status(400).json({ ok: false, error: req.t('two_fa.error_code_invalid'), code: 'CODE_INVALID' });
    }
    twoFactor.disable(userId, req.ip);
    res.json({ ok: true });
  } catch (err) {
    fail(res, err, req);
  }
});

module.exports = router;
