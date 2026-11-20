'use strict';

const settings = require('./settings');

/**
 * Returns the current VPN landing portal configuration derived from settings.
 * All values default to enabled ('1') unless explicitly set to '0'.
 * trustOwnerMapping ("Geräte-Besitzer automatisch erkennen") defaults to on too
 * since the portal redesign (migration 90).
 *
 * @returns {{ enabled: boolean, widgets: { device: boolean, traffic: boolean, services: boolean }, trustOwnerMapping: boolean }}
 */
const on = (key) => settings.get(key, '1') !== '0';

function portalConfig() {
  return {
    enabled: on('portal.enabled'),
    widgets: {
      device:   on('portal.widget.device'),
      traffic:  on('portal.widget.traffic'),
      services: on('portal.widget.services'),
    },
    trustOwnerMapping: settings.get('portal.trust_owner_mapping', '1') !== '0',
  };
}

const config = require('../../config/default');
const { getDb } = require('../db/connection');

/**
 * The host(s) of the portal.
 *   public portal domain set → { host: <prefix>.<base>, public: true }
 *   wildcard certificate of the VPN zone in use (services/vpnCert.js
 *   servedZone) → { host: home.<zone>, vpn: true, legacyHost: home.<legacy> }:
 *   the portal answers under both names, home.<legacy> stays for good
 *   otherwise → { host: home.<legacy> }
 * `hosts` lists every name the portal answers; `compatHost` is the one every
 * device resolves (for apps that do not know the zone of the device names).
 * `linkHost` is where links opened anywhere point (invitations, kiosk pairing,
 * the member menu, the way back of the cloud accounts): `compatHost`, or
 * home.<zone> while the admin switched "Links auf die neue Adresse" on
 * (services/vpnCert.js linksNew) and the wildcard is in use.
 */
function effectivePortalHost() {
  const base = String(settings.get('portal.base_domain', '') || '').trim().toLowerCase();
  const prefix = String(settings.get('portal.prefix', 'home') || '').trim().toLowerCase();
  if (base) {
    const host = prefix ? `${prefix}.${base}` : base;
    return { host, public: true, vpn: false, legacyHost: null, compatHost: host, linkHost: host, hosts: [host] };
  }
  const legacy = `home.${config.dns.domain}`;
  let zone = null;
  let linksNew = false;
  try {
    const vpnCert = require('./vpnCert');
    zone = vpnCert.servedZone();
    linksNew = !!zone && vpnCert.linksNew();
  } catch { zone = null; }
  if (zone) {
    const host = `home.${zone}`;
    return { host, public: false, vpn: true, legacyHost: legacy, compatHost: legacy, linkHost: linksNew ? host : legacy, hosts: [host, legacy] };
  }
  return { host: legacy, public: false, vpn: false, legacyHost: null, compatHost: legacy, linkHost: legacy, hosts: [legacy] };
}
function isPublicPortalHost() { return effectivePortalHost().public; }

/** Does the portal answer under this host name? */
function isPortalHost(hostname) {
  const h = String(hostname || '').trim().toLowerCase().replace(/\.$/, '');
  // the whole name: equal to one of the portal's names, never a part of one
  try { return !!h && new Set(effectivePortalHost().hosts).has(h); } catch { return false; }
}

// Apps that resolve the zone of the device names ("Namen im VPN"): the
// Android app (all versions), GateControl Pro from 1.85.0, Community from
// 1.49.0 — they get home.<zone>; every other caller the name every device
// resolves (home.<legacy>).
const ZONE_APPS = { pro: '1.85.0', community: '1.49.0' };
function resolvesZone(req) {
  const h = (req && req.headers) || {};
  const type = String(h['x-client-type'] || '').trim().toLowerCase().replace(/^gatecontrol-/, '');
  const platform = String(h['x-client-platform'] || '').trim().toLowerCase();
  if (type === 'android' || platform === 'android') return true;
  const min = ZONE_APPS[type];
  if (!min) return false;
  const v = String(h['x-client-version'] || '').trim();
  if (!/^v?\d{1,6}\.\d{1,6}\.\d{1,6}/.test(v)) return false;
  return require('../utils/version').compareVersions(v, min) >= 0;
}

/** The portal host for a request of an app (see resolvesZone). */
function portalHostFor(req) {
  const p = effectivePortalHost();
  return p.vpn && !resolvesZone(req) ? p.compatHost : p.host;
}

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
  if (rows.some(r => `${String(r.hostname).trim().toLowerCase()}.${config.dns.domain}` === host)) return true;
  // … and the zone chosen under "Namen im VPN" belongs to the devices alone
  // (services/vpnNames.js): the server answers it by itself.
  return require('./vpnNames').insideDeviceZone(host);
}
async function validatePortalHost(base, prefix) {
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
  // The apex being verified says NOTHING about <prefix>.<apex>. Committing an
  // unresolvable host hands it to buildTlsAutomation, and Caddy then retries ACME
  // against the production CA for max_duration = 30 days (burning Let's Encrypt's
  // 5 failed-validations/hour/hostname budget). So resolve the composed host too.
  if (host !== base) {
    const v = await domains.verify(host);
    // 'pending' = our resolver is unreachable — can't decide, so don't block.
    if (v.status === 'failed') return { ok: false, error: 'unresolved' };
  }
  return { ok: true };
}

module.exports = portalConfig;
module.exports.effectivePortalHost = effectivePortalHost;
module.exports.isPublicPortalHost = isPublicPortalHost;
module.exports.isPortalHost = isPortalHost;
module.exports.resolvesZone = resolvesZone;
module.exports.portalHostFor = portalHostFor;
module.exports.validatePortalHost = validatePortalHost;
