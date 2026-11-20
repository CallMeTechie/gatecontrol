'use strict';

const { Router } = require('express');
const { hasFeature } = require('../../../services/license');
const portalConfig = require('../../../services/portalConfig');
const settings = require('../../../services/settings');
const peers = require('../../../services/peers');
const clientPolicy = require('../../../services/clientPolicy');

const router = Router();

function vpnDnsInfo() {
  try { return require('../../../services/vpnDns').clientInfo(); } catch { return null; }
}

function dnsProtectionInfo() {
  try { return require('../../../services/vpnDns').clientPlugin(); } catch { return null; }
}

// GET /api/v1/client/ping — health check, confirms auth works.
router.get('/ping', (req, res) => {
  const { version } = require('../../../../package.json');
  res.json({ ok: true, version, timestamp: new Date().toISOString() });
});

// GET /api/v1/client/permissions — scopes/permissions of the current token.
router.get('/permissions', (req, res) => {
  const scopes = req.tokenScopes || [];
  const hasScope = (s) => scopes.includes('full-access') || scopes.includes(s);

  const enabled = portalConfig().enabled;
  // home.<zone> only for apps that resolve the zone of the device names (portalConfig.resolvesZone)
  const portalUrl = enabled ? `https://${portalConfig.portalHostFor(req)}` : null;
  const autoOpenPortal = enabled && settings.get('portal.autoappear', '1') !== '0';

  res.json({
    ok: true,
    portalUrl,
    autoOpenPortal,
    permissions: {
      services: hasScope('client:services'),
      traffic: hasScope('client:traffic'),
      dns: hasScope('client:dns'),
      rdp: hasScope('client:rdp') && hasFeature('remote_desktop'),
    },
    scopes,
    // DNS protection of the VPN devices: null, or the plugin that serves the apps
    // (GET/POST /api/v1/client/plugins/<plugin>/api/…) and the state of the filter.
    vpnDns: vpnDnsInfo(),
    // The same plugin also while the protection is switched off: null = no plugin that serves the apps, else
    // { plugin, enabled, state: 'off' | 'starting' | 'filtering' | 'fallback' }. `vpnDns` above is unchanged —
    // apps that only know that field keep their behaviour (docs/plugins.md "DNS protection").
    dnsProtection: dnsProtectionInfo(),
    // "Zertifikat für die Namen" passed on to this device (off by default): { wildcard, fingerprint, not_after }
    // or null — the app fetches certificate and key itself (GET /api/v1/client/vpn-cert)
    vpnCert: req.tokenPeerId != null ? (() => { try { return require('../../../services/vpnCert').shareSummary(req.tokenPeerId); } catch { return null; } })() : null,
    // Client policy version (see GET /api/v1/client/policy)
    policyVersion: clientPolicy.versionFor(
      req.tokenPeerId != null ? (peers.getById(req.tokenPeerId) || null) : null,
      { tokenId: req.tokenAuth ? req.tokenId : null },
    ),
  });
});

module.exports = router;
