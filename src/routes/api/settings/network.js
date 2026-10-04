'use strict';

// Network-level settings: custom DNS resolvers and the global split-tunnel
// preset. Carved out of the legacy 863-LOC settings.js — semantics unchanged.

const { Router } = require('express');
const settings = require('../../../services/settings');
const activity = require('../../../services/activity');
const logger = require('../../../utils/logger');
const caddySync = require('../../../services/caddySync');
const { requireFeature } = require('../../../middleware/license');
const { hasFeature } = require('../../../services/license');
const config = require('../../../../config/default');

const router = Router();

/**
 * GET /api/settings/dns — Read custom DNS setting
 */
router.get('/dns', (req, res) => {
  res.json({
    ok: true,
    data: {
      dns: settings.get('custom_dns') || config.wireguard.dns.join(','),
      is_custom: !!settings.get('custom_dns'),
      default_dns: config.wireguard.dns.join(','),
    },
  });
});

/**
 * PUT /api/settings/dns — Update custom DNS setting
 */
router.put('/dns', requireFeature('custom_dns'), (req, res) => {
  try {
    const { dns } = req.body;
    if (dns !== undefined) {
      const value = String(dns).trim();
      if (value) {
        const ips = value.split(',').map(s => s.trim()).filter(Boolean);
        const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/;
        for (const ip of ips) {
          if (!ipv4Regex.test(ip)) {
            return res.status(400).json({ ok: false, error: req.t('error.settings.dns_invalid_ip', { ip }), fields: { dns: req.t('error.settings.dns_invalid_ip', { ip }) } });
          }
        }
        settings.set('custom_dns', ips.join(','));
      } else {
        settings.set('custom_dns', '');
      }
    }
    activity.log('dns_settings_updated', 'DNS settings updated', {
      source: 'admin', ipAddress: req.ip, severity: 'info',
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: req.t('common.error') });
  }
});

/**
 * GET /api/settings/split-tunnel — Get global split-tunnel preset
 */
router.get('/split-tunnel', (req, res) => {
  try {
    let preset;
    try {
      preset = JSON.parse(settings.get('split_tunnel_preset', '{}'));
    } catch {
      preset = { mode: 'off', networks: [], locked: false };
    }
    const { mode = 'off', networks = [], locked = false } = preset;
    res.json({ ok: true, mode, networks, locked });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to get split-tunnel preset');
    res.status(500).json({ ok: false, error: req.t('common.error') });
  }
});

/**
 * PUT /api/settings/split-tunnel — Update global split-tunnel preset (license-gated)
 */
router.put('/split-tunnel', (req, res) => {
  try {
    if (!hasFeature('split_tunnel_preset')) {
      return res.status(403).json({ ok: false, error: req.t('error.license.feature_not_available'), feature: 'split_tunnel_preset' });
    }

    const { mode, networks, locked } = req.body;

    if (!['off', 'exclude', 'include'].includes(mode)) {
      return res.status(400).json({ ok: false, error: req.t('error.settings.split_mode_invalid'), fields: { mode: req.t('error.settings.split_mode_invalid') } });
    }

    if (!Array.isArray(networks) || networks.length > 50) {
      return res.status(400).json({ ok: false, error: req.t('error.settings.split_networks_invalid'), fields: { networks: req.t('error.settings.split_networks_invalid') } });
    }

    const cidrRegex = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\/\d{1,2}$/;
    for (const net of networks) {
      const cidr = net && typeof net.cidr === 'string' ? net.cidr : '';
      const badCidr = () => res.status(400).json({
        ok: false, error: req.t('error.settings.split_cidr_invalid', { cidr }), fields: { networks: req.t('error.settings.split_cidr_invalid', { cidr }) },
      });
      if (!cidrRegex.test(cidr)) return badCidr();
      const prefix = parseInt(cidr.split('/')[1], 10);
      if (prefix < 0 || prefix > 32 || cidr.split('/')[0].split('.').some((o) => Number(o) > 255)) return badCidr();
      if (net.label && (typeof net.label !== 'string' || net.label.length > 100)) {
        return res.status(400).json({ ok: false, error: req.t('error.settings.split_label_invalid'), fields: { networks: req.t('error.settings.split_label_invalid') } });
      }
    }

    const preset = { mode, networks, locked: !!locked };
    settings.set('split_tunnel_preset', JSON.stringify(preset));

    activity.log('split_tunnel_preset_updated', 'Split-tunnel preset updated', {
      details: preset,
    });

    res.json({ ok: true });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to update split-tunnel preset');
    res.status(500).json({ ok: false, error: req.t('common.error') });
  }
});

const EB_ACTIONS = ['not_found', 'custom', 'redirect', 'empty'];
const EB_BODY_MAX = 16384;

/**
 * GET /api/settings/route-block-default — Read global external-block defaults
 */
router.get('/route-block-default', (req, res) => {
  res.json({
    ok: true,
    data: {
      action: settings.get('route_external_block_action', 'not_found'),
      body: settings.get('route_external_block_body', ''),
      redirect_url: settings.get('route_external_block_redirect_url', ''),
    },
  });
});

/**
 * PUT /api/settings/route-block-default — Update global external-block defaults
 */
router.put('/route-block-default', (req, res) => {
  try {
    const { action, body, redirect_url } = req.body;
    if (action !== undefined && !EB_ACTIONS.includes(action)) {
      return res.status(400).json({ ok: false, error: req.t('error.settings.block_action_invalid'), fields: { action: req.t('error.settings.block_action_invalid') } });
    }
    if (action === 'custom') {
      if (!body || !String(body).trim()) return res.status(400).json({ ok: false, error: req.t('error.settings.block_body_required'), fields: { body: req.t('error.settings.block_body_required') } });
      if (Buffer.byteLength(String(body), 'utf8') > EB_BODY_MAX) return res.status(400).json({ ok: false, error: req.t('error.settings.block_body_too_large'), fields: { body: req.t('error.settings.block_body_too_large') } });
    }
    if (action === 'redirect') {
      try {
        const u = new URL(String(redirect_url || '').trim());
        if (!/^https?:$/.test(u.protocol)) throw new Error('proto');
      } catch { return res.status(400).json({ ok: false, error: req.t('error.settings.block_redirect_invalid'), fields: { redirect_url: req.t('error.settings.block_redirect_invalid') } }); }
    }

    // Only trigger a Caddy rebuild when one of the three keys actually changes
    // (settings holds ALL settings — an SMTP save must NOT rebuild Caddy).
    let changed = false;
    const apply = (key, val) => {
      if (val === undefined) return;
      const next = String(val);
      if (settings.get(key, '') !== next) { settings.set(key, next); changed = true; }
    };
    apply('route_external_block_action', action);
    apply('route_external_block_body', body);
    apply('route_external_block_redirect_url', redirect_url);

    if (changed) {
      caddySync.requestCaddySync().catch(err => logger.warn({ err: err.message }, 'Caddy sync after route-block-default change failed'));
      activity.log('route_block_default_updated', 'Route external-block default updated', {
        source: 'admin', ipAddress: req.ip, severity: 'info',
      });
    }
    res.json({ ok: true });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to update route-block default');
    res.status(500).json({ ok: false, error: req.t('common.error') });
  }
});

module.exports = router;
