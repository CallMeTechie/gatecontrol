'use strict';

/**
 * GET /api/v1/client/vpn-cert — certificate and key of the wildcard of the VPN
 * zone for a device the admin allowed it (Einstellungen › VPN & Netzwerk ›
 * Zertifikat für die Namen › "An Geräte weitergeben", off by default).
 *
 * Token only (scope `client`), bound to that device, machine binding as
 * everywhere, and only from the device's own VPN address. Every answer with a
 * key is logged (device, fingerprint — never the key).
 *   200 { ok, wildcard, zone, cert_pem, key_pem, not_after, fingerprint }
 *   404 { ok: false, error: 'not_shared' | 'no_certificate' }
 *   403 { ok: false, error: 'token_required' | 'scope_required' | 'not_registered' | 'not_allowed' | 'not_from_vpn' }
 */

const { Router } = require('express');
const { verifyMachineBinding } = require('./helpers');

const router = Router();

router.get('/vpn-cert', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!req.tokenAuth) return res.status(403).json({ ok: false, error: 'token_required' });
  const scopes = req.tokenScopes || [];
  if (!scopes.includes('client') && !scopes.includes('full-access')) return res.status(403).json({ ok: false, error: 'scope_required' });
  if (!verifyMachineBinding(req, res)) return;
  if (req.tokenPeerId == null) return res.status(403).json({ ok: false, error: 'not_registered' });
  const r = require('../../../services/vpnCert').fetchFor(req.tokenPeerId, { via: 'app', ip: req.ip });
  if (!r.ok) return res.status(r.code === 'not_allowed' || r.code === 'not_from_vpn' ? 403 : 404).json({ ok: false, error: r.code });
  res.json(r);
});

module.exports = router;
