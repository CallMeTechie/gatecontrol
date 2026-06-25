'use strict';
const crypto = require('crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
process.env.GC_CADDY_EMAIL = 'admin@example.com';   // TLS policies only emit when email set
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown } = require('./helpers/setup');

let buildCaddyConfig, settings, getDb;
beforeEach(async () => {
  await setup();
  buildCaddyConfig = require('../src/services/caddyConfig').buildCaddyConfig;
  settings = require('../src/services/settings');
  getDb = require('../src/db/connection').getDb;
});
afterEach(teardown);

function policies(cfg) { return ((cfg.apps.tls || {}).automation || {}).policies || []; }
function acmeSubjects(cfg) { return policies(cfg).filter(p => p.issuers.some(i => i.module === 'acme')).flatMap(p => p.subjects || []); }
function internalSubjects(cfg) { return policies(cfg).filter(p => p.issuers.some(i => i.module === 'internal')).flatMap(p => p.subjects || []); }

test('internal default host uses the internal issuer', async () => {
  const cfg = await buildCaddyConfig();
  assert.ok(internalSubjects(cfg).some(s => /^home\./.test(s)));
});

const PORTAL_HOST = 'home.domaincaster.com';

// Collect every route object in the config (deep), preserving array order.
function allRoutes(cfg) {
  const out = [];
  (function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (Array.isArray(node.match) || Array.isArray(node.handle)) out.push(node);
    Object.values(node).forEach(walk);
  })(cfg);
  return out;
}
function hostMatches(r, host) {
  return (r.match || []).some(m => Array.isArray(m.host) && m.host.includes(host));
}
// SCOPE TO THE PORTAL HOST. caddyConfig ALWAYS writes apps.http.servers.srv0.routes
// (there is no host-keyed server). The distinction is WITHIN srv0: single-route
// vhosts are fast-path folded with a `host` matcher; MULTI-route vhosts (which the
// portal becomes once it has acme/gate/404) are wrapped in a `subroute`. So the
// portal's routes live inside a subroute handler's `routes` array. We find them by
// the portal host matcher; the fallback walks to the inner array that has the gate
// + 404. (Verify the exact shape in Task 3 Step 4 against caddyConfig_contract.test.js.)
function findPortalRoutes(cfg) {
  const byHostMatcher = allRoutes(cfg).filter(r => hostMatches(r, PORTAL_HOST));
  if (byHostMatcher.length >= 2) return byHostMatcher;          // host-matcher path
  // Fallback: the inner subroute array containing the gate + 404 routes.
  let found = null;
  (function walk(node) {
    if (found || !node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      // Guard: arrays like ['http.log.access'] contain strings — 'str'.match is
      // String.prototype.match (truthy function), so we must check typeof first.
      const has404 = node.some(r => r && typeof r === 'object' && (r.handle || []).some(h => h.handler === 'static_response' && h.status_code === 404));
      const hasGate = node.some(r => r && typeof r === 'object' && (r.match || []).some(m => m.remote_ip));
      if (has404 && hasGate) { found = node; return; }
      node.forEach(walk);
    } else { Object.values(node).forEach(walk); }
  })(cfg);
  return found;
}

test('verified public portal host uses ACME (not forced-internal)', async () => {
  getDb().prepare("INSERT INTO domains (domain, status) VALUES ('domaincaster.com','verified')").run();
  settings.set('portal.base_domain', 'domaincaster.com');
  settings.set('portal.prefix', 'home');
  const cfg = await buildCaddyConfig();
  assert.ok(acmeSubjects(cfg).includes('home.domaincaster.com'), 'portal host should be ACME');
  assert.ok(!internalSubjects(cfg).includes('home.domaincaster.com'), 'must not be forced-internal');

  const routes = findPortalRoutes(cfg);
  assert.ok(routes, 'portal vhost routes present');
  // Ordering: ACME-challenge route FIRST, then internal remote_ip → portal, then 404.
  const acmeIdx = routes.findIndex(r => (r.match || []).some(m => Array.isArray(m.path) && m.path.some(p => /acme-challenge/.test(p)))
    && !(r.handle || []).some(h => h.handler === 'static_response'));
  const gateIdx = routes.findIndex(r => (r.match || []).some(m => m.remote_ip));
  const idx404 = routes.findIndex(r => (r.handle || []).some(h => h.handler === 'static_response' && h.status_code === 404));
  assert.ok(acmeIdx > -1, 'explicit acme-challenge route present');
  assert.ok(acmeIdx < gateIdx && gateIdx < idx404, 'order: acme(0) < remote_ip < 404');
  // The internal route reverse-proxies and sets the identity header from the TCP source.
  const gate = routes[gateIdx];
  assert.ok(gate.handle.some(h => h.handler === 'reverse_proxy'), 'internal route proxies to Node');
  // The 404 route MUST exclude /.well-known/acme-challenge/* (else ACME issuance breaks).
  const r404 = routes[idx404];
  const notMatch = (r404.match || []).find(m => Array.isArray(m.not));
  assert.ok(notMatch, '404 route uses a `not` matcher');
  const excludedPaths = notMatch.not.flatMap(n => n.path || []);
  assert.ok(excludedPaths.some(p => /acme-challenge/.test(p)), '404 route excludes the acme-challenge path');
});
