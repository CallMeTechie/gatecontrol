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

  // Verified-only for public TLDs; carve-out for non-public.
  if (isPublicDomain(host)) {
    const base = baseDomain(host);
    if (!base || !domains.isVerified(base)) return { error: 'public_domain_use_verified' };
  }
  return { error: null };
}

module.exports = { checkDomainPolicy };
