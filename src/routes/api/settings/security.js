'use strict';

// Security policy settings: lockout / password complexity, machine binding,
// and the locked-account list. Carved out of the legacy 863-LOC settings.js.

const { Router } = require('express');
const settings = require('../../../services/settings');
const activity = require('../../../services/activity');
const { requireFeature } = require('../../../middleware/license');

const router = Router();

/**
 * GET /api/settings/security — Get security settings
 */
router.get('/security', (req, res) => {
  res.json({
    ok: true,
    data: {
      lockout: {
        enabled: settings.get('security.lockout.enabled', 'true') === 'true',
        max_attempts: parseInt(settings.get('security.lockout.max_attempts', '5'), 10),
        duration: parseInt(settings.get('security.lockout.duration', '15'), 10),
      },
      password: {
        complexity_enabled: settings.get('security.password.complexity_enabled', 'false') === 'true',
        min_length: parseInt(settings.get('security.password.min_length', '8'), 10),
        require_uppercase: settings.get('security.password.require_uppercase', 'true') === 'true',
        require_number: settings.get('security.password.require_number', 'true') === 'true',
        require_special: settings.get('security.password.require_special', 'true') === 'true',
      },
    },
  });
});

/**
 * PUT /api/settings/security — Update security settings
 */
router.put('/security', (req, res) => {
  try {
    const { lockout: lo, password: pw } = req.body;

    if (lo) {
      if (lo.enabled !== undefined) settings.set('security.lockout.enabled', String(lo.enabled));
      if (lo.max_attempts !== undefined) {
        const val = parseInt(lo.max_attempts, 10);
        if (val >= 1 && val <= 100) settings.set('security.lockout.max_attempts', String(val));
      }
      if (lo.duration !== undefined) {
        const val = parseInt(lo.duration, 10);
        if (val >= 1 && val <= 1440) settings.set('security.lockout.duration', String(val));
      }
    }

    if (pw) {
      if (pw.complexity_enabled !== undefined) settings.set('security.password.complexity_enabled', String(pw.complexity_enabled));
      if (pw.min_length !== undefined) {
        const val = parseInt(pw.min_length, 10);
        if (val >= 4 && val <= 128) settings.set('security.password.min_length', String(val));
      }
      if (pw.require_uppercase !== undefined) settings.set('security.password.require_uppercase', String(pw.require_uppercase));
      if (pw.require_number !== undefined) settings.set('security.password.require_number', String(pw.require_number));
      if (pw.require_special !== undefined) settings.set('security.password.require_special', String(pw.require_special));
    }

    activity.log('security_settings_updated', 'Security settings updated', {
      source: 'admin',
      ipAddress: req.ip,
      severity: 'info',
    });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: req.t('common.error') });
  }
});

/**
 * GET /api/settings/machine-binding — Get machine binding settings
 */
router.get('/machine-binding', (req, res) => {
  res.json({
    ok: true,
    data: {
      mode: settings.get('machine_binding.mode', 'off'),
    },
  });
});

/**
 * PUT /api/settings/machine-binding — Update machine binding settings
 */
router.put('/machine-binding', requireFeature('machine_binding'), (req, res) => {
  try {
    const { mode } = req.body;

    if (mode !== undefined) {
      if (!['off', 'global', 'individual'].includes(mode)) {
        return res.status(400).json({ ok: false, error: req.t('error.settings.machine_binding_mode_invalid') });
      }
      settings.set('machine_binding.mode', mode);
    }

    activity.log('machine_binding_settings_updated', `Machine binding mode set to "${mode}"`, {
      source: 'admin',
      ipAddress: req.ip,
      severity: 'info',
    });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: req.t('common.error') });
  }
});

/**
 * GET /api/settings/lockout — Get currently locked accounts
 */
router.get('/lockout', (req, res) => {
  const lockoutService = require('../../../services/lockout');
  res.json({ ok: true, locked: lockoutService.getLockedAccounts() });
});

/**
 * DELETE /api/settings/lockout/:identifier — Unlock an account
 */
router.delete('/lockout/:identifier', (req, res) => {
  const lockoutService = require('../../../services/lockout');
  lockoutService.unlockAccount(decodeURIComponent(req.params.identifier));
  activity.log('account_unlocked', `Account unlocked: ${decodeURIComponent(req.params.identifier)}`, {
    source: 'admin',
    ipAddress: req.ip,
    severity: 'info',
  });
  res.json({ ok: true });
});

module.exports = router;
