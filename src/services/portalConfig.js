'use strict';

const settings = require('./settings');

/**
 * Returns the current VPN landing portal configuration derived from settings.
 * All values default to enabled ('1') unless explicitly set to '0'.
 *
 * @returns {{ enabled: boolean, widgets: { device: boolean, traffic: boolean, services: boolean, pihole: boolean } }}
 */
const on = (key) => settings.get(key, '1') !== '0';

function portalConfig() {
  return {
    enabled: on('portal.enabled'),
    widgets: {
      device:   on('portal.widget.device'),
      traffic:  on('portal.widget.traffic'),
      services: on('portal.widget.services'),
      pihole:   on('portal.widget.pihole'),
    },
  };
}

const config = require('../../config/default');
const { getDb } = require('../db/connection');

function effectivePortalHost() {
  const base = String(settings.get('portal.base_domain', '') || '').trim().toLowerCase();
  const prefix = String(settings.get('portal.prefix', 'home') || '').trim().toLowerCase();
  if (base) return { host: prefix ? `${prefix}.${base}` : base, public: true };
  return { host: `home.${config.dns.domain}`, public: false };
}
function isPublicPortalHost() { return effectivePortalHost().public; }

function validPrefix(prefix) {
  if (prefix === '') return true;                          // apex allowed
  return prefix.split('.').every(l => /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(l));
}
function collidesWithGateControl(host) {
  try { return host === new URL(config.app.baseUrl).hostname.toLowerCase(); } catch { return false; }
}
function collidesWithRoute(host) {
  const rows = getDb().prepare('SELECT DISTINCT domain FROM routes WHERE domain IS NOT NULL').all();
  return rows.some(r => String(r.domain || '').trim().toLowerCase() === host);
}
function collidesWithPeer(host) {
  // dnsmasq publishes each peer as `<hostname>.<dns.domain>` (see dns.js). A
  // portal host must not shadow a peer FQDN (its → gateway-IP entry would hijack it).
  const rows = getDb().prepare("SELECT hostname FROM peers WHERE hostname IS NOT NULL AND hostname != ''").all();
  return rows.some(r => `${String(r.hostname).trim().toLowerCase()}.${config.dns.domain}` === host);
}
function validatePortalHost(base, prefix) {
  base = String(base || '').trim().toLowerCase();
  prefix = String(prefix == null ? 'home' : prefix).trim().toLowerCase();
  if (!base) return { ok: true };                          // internal default
  const domains = require('./domains');                    // lazy (from sub-project A)
  if (!domains.isVerified(base)) return { ok: false, error: 'not_verified' };
  if (!validPrefix(prefix)) return { ok: false, error: 'invalid_prefix' };
  const host = prefix ? `${prefix}.${base}` : base;
  if (collidesWithGateControl(host) || collidesWithRoute(host) || collidesWithPeer(host)) {
    return { ok: false, error: 'collision' };
  }
  return { ok: true };
}

module.exports = portalConfig;
module.exports.effectivePortalHost = effectivePortalHost;
module.exports.isPublicPortalHost = isPublicPortalHost;
module.exports.validatePortalHost = validatePortalHost;
