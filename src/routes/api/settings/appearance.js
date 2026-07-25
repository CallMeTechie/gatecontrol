'use strict';

// Appearance / app-level settings: getAll() bundle and system default theme.
// Carved out of the legacy 863-LOC settings.js — semantics unchanged.

const { Router } = require('express');
const { getDb } = require('../../../db/connection');
const settings = require('../../../services/settings');
const config = require('../../../../config/default');
const logger = require('../../../utils/logger');
const { validateEmail } = require('../../../utils/validate');
const activity = require('../../../services/activity');

const router = Router();

/**
 * GET /api/settings/app — Get app-level settings
 */
router.get('/app', (req, res) => {
  try {
    const appSettings = settings.getAll();
    res.json({
      ok: true,
      settings: appSettings,
      config: {
        appName: config.app.name,
        defaultLanguage: config.i18n.defaultLanguage,
        availableLanguages: config.i18n.availableLanguages,
        defaultTheme: config.theme.defaultTheme,
        wgHost: config.wireguard.host,
        wgPort: config.wireguard.port,
        wgSubnet: config.wireguard.subnet,
      },
    });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to get app settings');
    res.status(500).json({ ok: false, error: req.t('error.settings.app_get') });
  }
});

/**
 * PUT /api/settings/default-theme — Set system default theme
 */
router.put('/default-theme', (req, res) => {
  try {
    const { theme } = req.body;
    const validThemes = ['default', 'pro', 'aurora'];
    if (!theme || !validThemes.includes(theme)) {
      return res.status(400).json({ ok: false, error: 'Invalid theme. Must be: ' + validThemes.join(', ') });
    }
    settings.set('default_theme', theme);
    // Also update the current user's personal theme so the change is
    // visible immediately (user.theme overrides system default in locals.js)
    if (req.session && req.session.userId) {
      const db = getDb();
      db.prepare('UPDATE users SET theme = ? WHERE id = ?').run(theme, req.session.userId);
    }
    res.json({ ok: true, theme });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to set default theme');
    res.status(500).json({ ok: false, error: 'Failed to save theme setting' });
  }
});

/**
 * PUT /api/settings/acme-email — Kontaktadresse für Let's Encrypt.
 *
 * Zugriffsschutz: requireAuth vom API-Router plus der TOKEN_FORBIDDEN-Eintrag
 * in settings/index.js. Das ist KEINE Administratorprüfung — der gesamte
 * Settings-Baum hat heute keine Rollenprüfung (middleware/auth.js:33).
 * Bewusst Status quo; ein einzelner Rollen-Guard hier würde Schutz suggerieren,
 * den die Nachbarrouten nicht haben.
 */
router.put('/acme-email', async (req, res) => {
  try {
    const raw = req.body ? req.body.email : undefined;
    // Ein fehlendes Feld ist ein Client-Fehler, KEIN Löschbefehl. Der Rohwert
    // darf deshalb nicht über String(raw || '') normalisiert werden — das ließe
    // {} still eine gültige Konfiguration löschen.
    if (typeof raw !== 'string') {
      return res.status(400).json({ ok: false, error: req.t('error.settings.acme_email_invalid') });
    }
    const trimmed = raw.trim();
    if (trimmed && validateEmail(trimmed)) {
      return res.status(400).json({ ok: false, error: req.t('error.settings.acme_email_invalid') });
    }

    if (settings.get('caddy.acme_email', '') !== trimmed) {
      settings.set('caddy.acme_email', trimmed);
      activity.log('acme_email_updated',
        trimmed ? 'ACME contact email updated' : 'ACME contact email cleared (falls back to .env)',
        { source: 'admin', ipAddress: req.ip, severity: 'info' });
    }

    // Der Push läuft AUCH bei unverändertem Wert — bewusst anders als der
    // changed-Guard in network.js:176. Nach einem gescheiterten Push liegt der
    // Wert schon in der DB; ein Retry mit derselben Adresse muss ihn erneut
    // ausliefern, sonst quittiert die Oberfläche einen Erfolg, den es nie gab.
    //
    // syncToCaddy signalisiert Misserfolg auf ZWEI Wegen: es wirft (Caddy nicht
    // erreichbar) oder liefert false, wenn der Ownership-Guard das /load
    // verweigert (caddyConfig.js:962/:969). Unter NODE_ENV=test kehrt es sofort
    // zurück und liefert undefined — das zählt als Erfolg, weil es nicht false ist.
    // Nebenläufigkeit ist gedeckt: syncToCaddy serialisiert global über _syncChain
    // (:925-929) und baut die Config erst beim Ausführen des Kettenglieds, liest
    // also immer den dann aktuellen DB-Wert.
    let pushed = true;
    try {
      pushed = (await require('../../../services/caddyConfig').syncToCaddy()) !== false;
    } catch (e) {
      logger.error({ error: e.message }, 'ACME email saved but Caddy push failed');
      pushed = false;
    }
    res.json(pushed ? { ok: true } : { ok: true, warning: 'settings.acme_email.push_failed' });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to set ACME contact email');
    res.status(500).json({ ok: false, error: req.t('error.settings.acme_email_save') });
  }
});

module.exports = router;
