'use strict';

/**
 * Build the Caddy `apps.tls.automation` block from a flat list of
 * domains coming out of buildCaddyConfig's caddyRoutes map.
 *
 * Public domains (any TLD not in the private list) get an ACME
 * issuer; private domains (`*.local`, `*.lan`, etc.) get the internal
 * issuer so Caddy mints a self-signed cert without bothering Let's
 * Encrypt. When neither kind is present, a catch-all ACME policy is
 * still emitted so newly-created routes get a cert attempt before the
 * next full buildCaddyConfig pass.
 *
 * Returns null when `caddyConfig.email` is not configured — callers
 * skip writing apps.tls in that case.
 */

const NON_PUBLIC_TLDS = new Set([
  'test', 'local', 'invalid', 'internal', 'lan', 'home', 'localhost', 'corp',
]);

function isPublicDomain(domain) {
  if (!domain) return false;
  const parts = String(domain).toLowerCase().split('.');
  const tld = parts[parts.length - 1];
  return !NON_PUBLIC_TLDS.has(tld);
}

function buildTlsAutomation(routeDomains, caddyConfig) {
  if (!caddyConfig || !caddyConfig.email) return null;

  // Listener-only entries like ":443" land in caddyRoutes for the
  // server-block setup but are not domains — skip them so they don't
  // become bogus issuer subjects.
  const allDomains = routeDomains.filter(d => !/^:\d+$/.test(d));
  const publicDomains = allDomains.filter(isPublicDomain);
  const privateDomains = allDomains.filter(d => !isPublicDomain(d));

  const policies = [];

  if (publicDomains.length > 0) {
    const acmePolicy = {
      subjects: publicDomains,
      issuers: [{ module: 'acme', email: caddyConfig.email }],
    };
    if (caddyConfig.acmeCa) acmePolicy.issuers[0].ca = caddyConfig.acmeCa;
    policies.push(acmePolicy);
  }

  if (privateDomains.length > 0) {
    policies.push({
      subjects: privateDomains,
      issuers: [{ module: 'internal' }],
    });
  }

  if (policies.length === 0) {
    // Catch-all so new routes created before the next buildCaddyConfig
    // still get a cert attempt instead of silently waiting.
    const fallback = { issuers: [{ module: 'acme', email: caddyConfig.email }] };
    if (caddyConfig.acmeCa) fallback.issuers[0].ca = caddyConfig.acmeCa;
    policies.push(fallback);
  }

  return { automation: { policies } };
}

module.exports = {
  isPublicDomain,
  buildTlsAutomation,
  NON_PUBLIC_TLDS,
};
