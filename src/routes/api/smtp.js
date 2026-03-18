'use strict';

const { Router } = require('express');
const { getSmtpSettings, saveSmtpSettings, sendTestEmail } = require('../../services/email');

const router = Router();

// GET /api/smtp/settings — return SMTP settings (never expose encrypted password)
router.get('/settings', (req, res) => {
  (async () => {
    const settings = getSmtpSettings();
    res.json({
      ok: true,
      data: {
        host: settings.host,
        port: settings.port,
        user: settings.user,
        from: settings.from,
        secure: settings.secure,
        hasPassword: !!settings.passwordEncrypted,
      },
    });
  })().catch((err) => res.status(500).json({ ok: false, error: err.message }));
});

// PUT /api/smtp/settings — save SMTP settings
router.put('/settings', (req, res) => {
  (async () => {
    const { host, port, user, password, from, secure } = req.body;

    if (!host) {
      return res.status(400).json({ ok: false, error: req.t('smtp.error.host_required') });
    }
    if (!port) {
      return res.status(400).json({ ok: false, error: req.t('smtp.error.port_required') });
    }
    if (!from) {
      return res.status(400).json({ ok: false, error: req.t('smtp.error.from_required') });
    }

    const portNum = parseInt(port, 10);
    if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
      return res.status(400).json({ ok: false, error: req.t('smtp.error.port_invalid') });
    }

    saveSmtpSettings({ host, port: portNum, user, password, from, secure });
    res.json({ ok: true });
  })().catch((err) => res.status(500).json({ ok: false, error: err.message }));
});

// POST /api/smtp/test — send a test email
router.post('/test', (req, res) => {
  (async () => {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ ok: false, error: req.t('smtp.error.email_required') });
    }

    await sendTestEmail(email);
    res.json({ ok: true });
  })().catch((err) => res.status(500).json({ ok: false, error: err.message }));
});

module.exports = router;
