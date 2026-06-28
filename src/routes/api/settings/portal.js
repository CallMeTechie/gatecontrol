'use strict';

// Portal settings cluster — master switch + per-widget toggles + public host + owner mapping.
// Keys: portal.enabled, portal.widget.{device,traffic,services,pihole}, portal.trust_owner_mapping,
//       portal.base_domain, portal.prefix

const { Router } = require('express');
const settings = require('../../../services/settings');
const portalConfig = require('../../../services/portalConfig');
const { validatePortalHost, effectivePortalHost, isPublicPortalHost } = require('../../../services/portalConfig');
const activity = require('../../../services/activity');
const config = require('../../../../config/default');
const caddySync = require('../../../services/caddySync');
const dns = require('../../../services/dns');
const logger = require('../../../utils/logger');

const router = Router();

/**
 * GET /api/v1/settings/portal — Return current portal settings as booleans + host info
 */
router.get('/portal', (req, res) => {
  res.json({ ok: true, data: Object.assign({}, portalConfig(), {
    autoappear: settings.get('portal.autoappear', '1') !== '0',
    base_domain: settings.get('portal.base_domain', ''),
    prefix: settings.get('portal.prefix', 'home'),
    effectiveHost: effectivePortalHost().host,
    isPublic: isPublicPortalHost(),
    internalHost: `home.${config.dns.domain}`,
  }) });
});

/**
 * PUT /api/v1/settings/portal — Update portal master switch + widget toggles + host + owner mapping
 *
 * Accepts:
 *   { enabled: bool, widgets: { device: bool, traffic: bool, services: bool, pihole: bool },
 *     trust_owner_mapping: bool, base_domain: string, prefix: string }
 */
router.put('/portal', (req, res) => {
  try {
    const body = req.body || {};
    const widgets = body.widgets || {};

    if (body.enabled !== undefined) {
      settings.set('portal.enabled', body.enabled ? '1' : '0');
    }
    if (widgets.device !== undefined) {
      settings.set('portal.widget.device', widgets.device ? '1' : '0');
    }
    if (widgets.traffic !== undefined) {
      settings.set('portal.widget.traffic', widgets.traffic ? '1' : '0');
    }
    if (widgets.services !== undefined) {
      settings.set('portal.widget.services', widgets.services ? '1' : '0');
    }
    if (widgets.pihole !== undefined) {
      settings.set('portal.widget.pihole', widgets.pihole ? '1' : '0');
    }
    if (widgets.midea !== undefined) {
      settings.set('portal.widget.midea', widgets.midea ? '1' : '0');
    }

    if (body.trust_owner_mapping !== undefined) {
      settings.set('portal.trust_owner_mapping', body.trust_owner_mapping ? '1' : '0');
    }
    if (body.autoappear !== undefined) {
      settings.set('portal.autoappear', body.autoappear ? '1' : '0');
    }

    // Host change (base_domain + prefix committed together).
    if (body.base_domain !== undefined || body.prefix !== undefined) {
      const base = String(body.base_domain !== undefined ? body.base_domain : settings.get('portal.base_domain', '') || '').trim().toLowerCase();
      const prefix = String(body.prefix !== undefined ? (body.prefix == null ? '' : body.prefix) : settings.get('portal.prefix', 'home')).trim().toLowerCase();
      const v = validatePortalHost(base, prefix);
      if (!v.ok) return res.status(400).json({ ok: false, error: req.t('settings.portal.host_' + v.error) });
      // NOTE: GC_CADDY_EMAIL is intentionally NOT required. ACME issuance (Let's Encrypt)
      // does not need an account email; when GC_CADDY_EMAIL is empty, buildTlsAutomation
      // emits no explicit tls policy and Caddy's default automation obtains a public cert
      // for the portal host exactly as it already does for every route domain. An email is
      // optional (only used for LE expiry notices, which Caddy's auto-renew makes moot).
      settings.set('portal.base_domain', base);
      settings.set('portal.prefix', prefix);
      // ALWAYS re-sync when a host field was submitted + validated — NO "only when changed"
      // guard: requestCaddySync is coalesced/idempotent and dns.rebuildNow is idempotent, so
      // a failed sync stays RECOVERABLE — re-pressing Apply fires the sync again.
      caddySync.requestCaddySync().catch(e => logger.warn({ err: e.message }, 'portal: caddy sync failed'));
      try { dns.rebuildNow(); } catch (e) { logger.warn({ err: e.message }, 'portal: dns rebuild failed'); }
    }

    activity.log('portal_settings_updated', 'Portal settings updated', {
      source: 'admin', ipAddress: req.ip, severity: 'info',
    });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: req.t('common.error') });
  }
});

module.exports = router;
