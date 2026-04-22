'use strict';

const { Router } = require('express');
const argon2 = require('argon2');
const { getDb } = require('../../db/connection');
const wg = require('../../services/wireguard');
const activity = require('../../services/activity');

const router = Router();

/**
 * GET /api/wg/status
 */
router.get('/status', async (req, res) => {
  try {
    const status = await wg.getStatus();
    res.json({ ok: true, ...status });
  } catch (err) {
    res.status(500).json({ ok: false, error: req.t('error.wireguard.status') });
  }
});

/**
 * POST /api/wg/restart
 * Token auth is rejected here: a stolen `system`-scoped token could otherwise
 * loop-kick the WG interface and DoS every peer. Admin session only.
 * Session users additionally get a 1/min rate-limit key so a compromised
 * session cannot spam-restart.
 */
const _wgRestartWindow = new Map();
router.post('/restart', async (req, res) => {
  try {
    if (req.tokenAuth) {
      return res.status(403).json({ ok: false, error: req.t('error.wireguard.restart') });
    }
    const key = `session:${req.session?.userId || req.ip}`;
    const now = Date.now();
    const last = _wgRestartWindow.get(key) || 0;
    if (now - last < 60 * 1000) {
      return res.status(429).json({ ok: false, error: req.t('error.wireguard.restart') });
    }
    _wgRestartWindow.set(key, now);

    const success = await wg.restart();
    activity.log('wg_restart', 'WireGuard interface restarted', {
      source: 'admin',
      ipAddress: req.ip,
      severity: success ? 'info' : 'error',
    });
    res.json({ ok: true, success });
  } catch (err) {
    res.status(500).json({ ok: false, error: req.t('error.wireguard.restart') });
  }
});

/**
 * POST /api/wg/stop
 * Requires admin password confirmation (destructive action — disconnects all peers)
 */
router.post('/stop', async (req, res) => {
  try {
    const { password } = req.body || {};
    if (!password) {
      return res.status(400).json({ ok: false, error: req.t('error.wireguard.password_required') });
    }

    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
    if (!user) {
      return res.status(401).json({ ok: false, error: req.t('error.settings.user_not_found') });
    }

    const valid = await argon2.verify(user.password_hash, password);
    if (!valid) {
      return res.status(403).json({ ok: false, error: req.t('error.wireguard.password_incorrect') });
    }

    const success = await wg.stop();
    activity.log('wg_stop', 'WireGuard interface stopped (password confirmed)', {
      source: 'admin',
      ipAddress: req.ip,
      severity: 'warning',
    });
    res.json({ ok: true, success });
  } catch (err) {
    res.status(500).json({ ok: false, error: req.t('error.wireguard.stop') });
  }
});

module.exports = router;
