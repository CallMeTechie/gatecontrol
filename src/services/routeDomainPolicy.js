'use strict';
const { isPublicDomain } = require('./caddyTlsAutomation');
const { baseDomain } = require('./domainSeed');
const domains = require('./domains');
const config = require('../../config/default');

function norm(h) { return String(h || '').trim().toLowerCase().replace(/\.$/, ''); }
function managementHost() {
  // Management host = the host GateControl is reached on. Derived from config.app.baseUrl.
  // NOT caddyAdminClient._managementHost() — that needs a live Caddy config object
  // unavailable at policy time (zero-arg → null → guard silently disabled).
  try { return norm(new URL(config.app.baseUrl).hostname); } catch { return null; }
}
function portalHost() {
  // effectivePortalHost() returns { host } as a bare hostname (no port) — use it directly.
  try { return norm(require('./portalConfig').effectivePortalHost().host); } catch { return null; }
}

/**
 * Domain policy for route create/update. Only checks when `domain` is set and
 * actually changed. Public TLDs require a verified registry base; non-public
 * TLDs are carved out (free-text, internal CA). Collision guard applies to all.
 */
// `routeType` is reserved for future L4-vs-HTTP policy differentiation; currently unused by design.
function checkDomainPolicy(domain, { currentDomain = null, routeType = 'http' } = {}) {
  const host = norm(domain);
  if (!host) return { error: null };                          // L4-none etc.
  if (currentDomain && host === norm(currentDomain)) return { error: null }; // grandfathering

  // Collision guard (all domains), normalized both sides.
  const mh = managementHost();
  const ph = portalHost();
  if ((mh && host === mh) || (ph && host === ph)) return { error: 'domain_collision' };
  // the other names of the portal and of the management (home.<legacy>,
  // server./gc-server.<zone> while the wildcard of the VPN zone is served)
  try {
    if (require('./portalConfig').isPortalHost(host)) return { error: 'domain_collision' };
    if (new Set(require('./vpnCert').managementHosts()).has(host)) return { error: 'domain_collision' };
  } catch { /* services unavailable */ }

  // The zone of the device names ("Namen im VPN", services/vpnNames.js)
  // belongs to the devices: the server answers it by itself. A route in it
  // only while its wildcard certificate is in use (services/vpnCert.js) —
  // then a name one level below the zone that is no device name, no fixed
  // name of the server and no portal name, always internal only
  // (routes.create/update force external_enabled = 0). A name a device
  // already has in a zone is never free for a route.
  const vpnNames = require('./vpnNames');
  if (vpnNames.insideDeviceZone(host)) {
    const z = zoneRouteCheck(host);
    if (z.error) return { error: z.error, zone: vpnNames.current().primary };
  }
  const device = vpnNames.deviceAt(host);
  if (device) return { error: 'device_name', device };
  if (vpnNames.insideDeviceZone(host)) return { error: null, internalOnly: true, zone: vpnNames.current().primary };

  // Verified-only for public TLDs; carve-out for non-public.
  if (isPublicDomain(host)) {
    const base = baseDomain(host);
    if (!base || !domains.isVerified(base)) return { error: 'public_domain_use_verified' };
  }
  return { error: null };
}

/**
 * May a route take this name inside the zone of the device names?
 * → { error: null } | { error: 'device_zone' (no wildcard in use) |
 *   'device_zone_level' (not one level below the zone) | 'domain_collision' (reserved name) }
 */
function zoneRouteCheck(host) {
  const vpnNames = require('./vpnNames');
  const zone = vpnNames.current().primary;
  let served = null;
  try { served = require('./vpnCert').servedZone(); } catch { served = null; }
  if (!served || served !== zone) return { error: 'device_zone' };
  const label = host.endsWith('.' + zone) ? host.slice(0, -(zone.length + 1)) : '';
  if (!label || label.includes('.')) return { error: 'device_zone_level' };
  // gateway, server, gc-server, home (portal) … belong to the server
  if (require('./dns').RESERVED_HOSTNAMES.has(label)) return { error: 'domain_collision' };
  return { error: null };
}

/** Routes below the zone of the device names are internal only, always. */
function internalOnlyDomain(domain) {
  const host = norm(domain);
  if (!host) return false;
  try { return require('./vpnNames').insideDeviceZone(host); } catch { return false; }
}

module.exports = { checkDomainPolicy, internalOnlyDomain };
