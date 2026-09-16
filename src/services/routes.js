'use strict';

const { getDb } = require('../db/connection');
const config = require('../../config/default');
const { validateDomain, validatePort, validateLanHost, validateDescription, validateBasicAuthUser, validateBasicAuthPassword, validateIp, sanitize, validateL4Protocol, validateL4ListenPort, validateL4TlsMode, isPortBlocked, isLoopbackHost, parsePortRange } = require('../utils/validate');
const bcrypt = require('bcryptjs');
const { syncToCaddy, buildCaddyConfig, caddyApi, getAclPeers, setAclPeers } = require('./caddyConfig');
const { restoreRouteRow, reinsertRouteRow } = require('./routesRollback');
const { validateIfProvided, validateBrandingFields, validateBotBlockerConfig, resolveHstsFields, hasHstsInput, hstsDefaultToFields, parseHstsDefault, resolveSecurityFields, resolveWafFields, hasWafInput, wafModeChanged, parseWafDefault, wafDefaultToFields, resolveBackendFingerprint, normalizeLabel, onDemandFlag } = require('./routesValidation');
const { withCaddySync } = require('./routesSync');
const activity = require('./activity');
const logger = require('../utils/logger');
const dns = require('./dns');

// ─── Target Exclusivity Validation ──────────────────────

function validateTargetExclusivity(data) {
  if (data.target_peer_id != null && data.target_pool_id != null) {
    throw new Error('conflicting_target: route cannot have both target_peer_id and target_pool_id');
  }
  if (data.target_pool_id != null) {
    const gatewayPool = require('./gatewayPool');
    const pool = gatewayPool.getPool(data.target_pool_id);
    if (!pool) throw new Error('target_pool_not_found');
    if (gatewayPool.listMembers(data.target_pool_id).length === 0) {
      throw new Error('target_pool_empty');
    }
  }
}

// ─── Domain availability ────────────────────────────────
//
// A domain may be shared between an HTTP route and L4 routes for the same
// host (e.g. a web UI plus an SSH port-forward — the service-bundle case).
// Real conflicts are only:
//   - HTTP ↔ HTTP: one virtual host per domain.
//   - L4-SNI ↔ L4-SNI on the same listener: Caddy cannot disambiguate two
//     identical SNI matchers on one port (cross-port SNI reuse is fine,
//     and tls_mode='none' rows carry the domain purely as a label).
function assertDomainAvailable(db, { domain, routeType, tlsMode, listenPort, excludeId = null }) {
  const rows = db.prepare(
    'SELECT id, route_type, l4_tls_mode, l4_listen_port FROM routes WHERE domain = ? AND id != ?'
  ).all(domain, excludeId == null ? -1 : excludeId);
  if (rows.length === 0) return;

  if (routeType !== 'l4') {
    const httpDup = rows.find((r) => r.route_type !== 'l4');
    if (httpDup) throw new Error('A route with this domain already exists');
    return;
  }

  if (!tlsMode || tlsMode === 'none') return;
  const sniDup = rows.find(
    (r) => r.route_type === 'l4'
      && r.l4_tls_mode && r.l4_tls_mode !== 'none'
      && String(r.l4_listen_port) === String(listenPort)
  );
  if (sniDup) throw new Error('An L4 route with this domain already listens on this port (ambiguous SNI)');
}

// Drop bundle rows whose last member was just deleted. Scoped to the
// touched ids (not a global sweep) so a bundle that is mid-creation —
// row inserted, members not yet — can't be garbage-collected by an
// unrelated delete.
function cleanupEmptyBundles(db, bundleIds) {
  const ids = [...new Set(bundleIds)].filter((id) => id != null);
  for (const bundleId of ids) {
    const member = db.prepare('SELECT id FROM routes WHERE bundle_id = ? LIMIT 1').get(bundleId);
    if (!member) {
      // A dissolving host takes its alias tls_status rows with it (§A).
      const bundle = db.prepare('SELECT domain, aliases FROM service_bundles WHERE id = ?').get(bundleId);
      db.prepare('DELETE FROM service_bundles WHERE id = ?').run(bundleId);
      if (bundle && bundle.aliases) {
        try {
          const { parseAliases, aliasFqdns } = require('./domainZones');
          require('./tlsGuard').forgetHosts(aliasFqdns(bundle.domain, parseAliases(bundle.aliases)));
        } catch (err) {
          logger.warn({ err: err?.message ?? String(err), bundleId }, 'tls: alias rows not removed');
        }
      }
    }
  }
}

// Every route has a host (domain zones): after a route was created, or its
// domain changed, it joins the host of the same fqdn in its zone, otherwise a
// host of its own is created (hosts.assignRoute). RDP-owned L4 routes stay out.
// Metadata-only (bundle_id) and best-effort — runs AFTER the Caddy sync so a
// sync rollback can never strand a half-formed host, and any failure here is
// TLS guard preflight (services/tlsGuard.js): never throws, never blocks the
// write; the API answer carries the compact result as `tls`.
async function guardTls(host) {
  const r = await require('./tlsGuard').guardHost(host);
  return { state: r.state, code: r.code, detail: r.detail };
}
function withTls(row, tls) {
  if (row && tls) row.tls = tls;
  return row;
}

// HSTS (docs/feature-hsts.md): the zone default of the entry's domain
// (domains.hsts_default via the longest-suffix zone match). Best-effort —
// a missing zone or a broken JSON simply means "no default".
function zoneHstsDefault(db, domain) {
  try {
    const zone = require('./domainZones').resolveZone(domain, db);
    if (!zone) return null;
    const row = db.prepare('SELECT hsts_default FROM domains WHERE id = ?').get(zone.domain_id);
    return row ? parseHstsDefault(row.hsts_default) : null;
  } catch (err) {
    logger.warn({ err: err?.message ?? String(err), domain }, 'HSTS zone default lookup failed');
    return null;
  }
}

// WAF (release B §2): the zone default of the entry's domain
// (domains.waf_default, longest-suffix zone match). Only an enabled default
// counts, and only while the licence carries `waf` — the route API gates an
// explicit waf_enabled the same way. Best-effort like zoneHstsDefault.
function zoneWafDefault(db, domain) {
  try {
    if (!require('./license').hasFeature('waf')) return null;
    const zone = require('./domainZones').resolveZone(domain, db);
    if (!zone) return null;
    const row = db.prepare('SELECT waf_default FROM domains WHERE id = ?').get(zone.domain_id);
    const def = row ? parseWafDefault(row.waf_default) : null;
    return def && def.enabled ? def : null;
  } catch (err) {
    logger.warn({ err: err?.message ?? String(err), domain }, 'WAF zone default lookup failed');
    return null;
  }
}

// logged, never propagated (it must not roll back an already-synced route).
// Hosts dissolve only at 0 members (cleanupEmptyBundles in remove()/batch()).
function assignHost(routeId, opts) {
  try {
    require('./hosts').assignRoute(routeId, opts);
  } catch (err) {
    logger.warn({ err: err?.message ?? String(err), routeId }, 'Host assignment failed');
  }
}

// Realtime: one `routes` event per touched host so the zones page reloads
// only what changed. Payload { domain_id, host_id }; host_id is null for
// routes without a host (RDP-owned). Best-effort, never throws.
function hostRefs(db, bundleIds) {
  const refs = [];
  const seen = new Set();
  try {
    for (const id of bundleIds) {
      const key = id == null ? 'null' : String(id);
      if (seen.has(key)) continue;
      seen.add(key);
      if (id == null) { refs.push({ domain_id: null, host_id: null }); continue; }
      const row = db.prepare('SELECT domain_id FROM service_bundles WHERE id = ?').get(id);
      refs.push({ domain_id: row ? row.domain_id : null, host_id: id });
    }
  } catch (err) {
    logger.warn({ err: err?.message ?? String(err) }, 'routes event refs failed');
  }
  return refs;
}

function publishRoutesEvent(refs) {
  try {
    const eventBus = require('./eventBus');
    for (const ref of refs) eventBus.publish('routes', ref);
  } catch (err) {
    logger.warn({ err: err?.message ?? String(err) }, 'routes event publish failed');
  }
}

function publishForRoutes(db, routeIds) {
  try {
    const placeholders = routeIds.map(() => '?').join(',');
    const rows = routeIds.length
      ? db.prepare(`SELECT bundle_id FROM routes WHERE id IN (${placeholders})`).all(...routeIds)
      : [];
    publishRoutesEvent(hostRefs(db, rows.map((r) => r.bundle_id)));
  } catch (err) {
    logger.warn({ err: err?.message ?? String(err) }, 'routes event publish failed');
  }
}

// GET /api/routes row shape, shared with GET /api/v1/zones (entries): strips
// the basic-auth hash and adds the domain-registry flags. The registry read is
// guarded — a better-sqlite3 throw must not turn the list into a 500; the
// fallback (empty set) only suppresses the "base unverified" nudge.
function toApiRows(list) {
  const stripFields = require('../utils/stripFields');
  const { isPublicDomain } = require('./caddyTlsAutomation');
  const { baseDomain } = require('./domainSeed');
  let verifiedSet;
  try { verifiedSet = new Set(require('./domains').baseDomains()); }
  catch (err) { logger.warn({ err: err.message }, 'routes list: baseDomains() failed; suppressing nudge'); verifiedSet = new Set(); }
  return list.map((row) => {
    const r = stripFields(row, ['basic_auth_password_hash']);
    const isPub = !!(r.domain && isPublicDomain(r.domain));
    return {
      ...r,
      domainIsPublic: isPub,                                   // drives edit-modal path detection
      baseUnverified: !!(isPub && !verifiedSet.has(baseDomain(r.domain))),
    };
  });
}

// ─── CRUD Operations ────────────────────────────────────

/**
 * Get all routes with peer info
 */
function getAll({ limit = 250, offset = 0, type = null } = {}) {
  const db = getDb();
  let query = `SELECT r.*, p.name as peer_name, p.enabled as peer_enabled, p.allowed_ips as peer_ip,
    gp.name AS target_peer_name, gp.allowed_ips AS target_peer_ip, gp.enabled AS target_peer_enabled,
    ra.auth_type as route_auth_type, ra.two_factor_enabled as route_auth_2fa,
    ra.two_factor_method as route_auth_2fa_method, ra.session_max_age as route_auth_session_max_age,
    CASE WHEN ra.id IS NOT NULL THEN 1 ELSE 0 END as route_auth_enabled,
    sb.name AS bundle_name, sb.domain AS bundle_domain
    FROM routes r
    LEFT JOIN peers p ON r.peer_id = p.id
    LEFT JOIN peers gp ON gp.id = r.target_peer_id
    LEFT JOIN route_auth ra ON ra.route_id = r.id
    LEFT JOIN service_bundles sb ON sb.id = r.bundle_id`;
  const params = [];
  if (type) {
    query += ' WHERE r.route_type = ?';
    params.push(type);
  }
  query += ' ORDER BY r.route_type, r.domain ASC LIMIT ? OFFSET ?';
  params.push(limit, offset);
  return db.prepare(query).all(...params);
}

/**
 * Get a single route by ID
 */
function getById(id) {
  const db = getDb();
  const route = db.prepare(`
    SELECT r.*, p.name AS peer_name, p.allowed_ips AS peer_ip,
           gp.name AS target_peer_name, gp.allowed_ips AS target_peer_ip
    FROM routes r
    LEFT JOIN peers p ON r.peer_id = p.id
    LEFT JOIN peers gp ON gp.id = r.target_peer_id
    WHERE r.id = ?
  `).get(id);
  if (route) {
    route.acl_peers = getAclPeers(id).map(p => p.peer_id);
  }
  return route;
}

/**
 * Create a new route.
 *
 * opts.skipSync: skip the Caddy sync and gateway push at the end — used by
 * orchestrators (service bundles) that create several rows and want a single
 * sync with their own compensating rollback. Callers own cleanup on failure.
 */
async function create(data, opts = {}) {
  const routeType = data.route_type || 'http';

  if (routeType === 'l4') {
    const protoErr = validateL4Protocol(data.l4_protocol);
    if (protoErr) throw new Error(protoErr);
    const portErr = validateL4ListenPort(data.l4_listen_port);
    if (portErr) throw new Error(portErr);
    const tlsErr = validateL4TlsMode(data.l4_tls_mode);
    if (tlsErr) throw new Error(tlsErr);
    if (data.l4_tls_mode !== 'none') {
      if (!data.domain) throw new Error('TLS mode requires a domain for SNI');
      if (data.l4_protocol !== 'tcp') throw new Error('TLS requires TCP protocol');
    }
    const range = parsePortRange(data.l4_listen_port);
    for (let p = range.start; p <= range.end; p++) {
      if (isPortBlocked(p)) throw new Error('Port ' + p + ' is reserved');
    }
  }

  if (routeType === 'http' || data.domain) {
    const domainErr = validateDomain(data.domain);
    if (domainErr) throw new Error(domainErr);
  }

  const portErr = validatePort(data.target_port);
  if (portErr) throw new Error(portErr);

  const lanHostErr = validateLanHost(data.target_lan_host);
  if (lanHostErr) throw new Error(lanHostErr);

  if (data.description) {
    const descErr = validateDescription(data.description);
    if (descErr) throw new Error(descErr);
  }

  validateBrandingFields(data);

  const db = getDb();
  const domain = data.domain ? sanitize(data.domain).toLowerCase() : null;

  // Check for duplicate domain (HTTP↔HTTP and same-listener SNI only —
  // an HTTP route and an L4 port-forward may share one domain)
  if (domain) {
    assertDomainAvailable(db, {
      domain,
      routeType,
      tlsMode: data.l4_tls_mode,
      listenPort: data.l4_listen_port,
    });
  }

  // Validate basic auth credentials when enabled
  let basicAuthUser = null;
  let basicAuthPasswordHash = null;
  if (data.basic_auth_enabled) {
    const userErr = validateBasicAuthUser(data.basic_auth_user);
    if (userErr) throw new Error(userErr);

    const passErr = validateBasicAuthPassword(data.basic_auth_password);
    if (passErr) throw new Error(passErr);

    basicAuthUser = sanitize(data.basic_auth_user);
    basicAuthPasswordHash = await bcrypt.hash(data.basic_auth_password, 10);
  }

  // Determine target_ip: from peer or direct input
  let targetIp = '127.0.0.1';
  if (data.peer_id) {
    const peer = db.prepare('SELECT allowed_ips FROM peers WHERE id = ?').get(data.peer_id);
    if (!peer) throw new Error('Selected peer not found');
    targetIp = peer.allowed_ips.split('/')[0];
  } else if (data.target_ip) {
    const ipErr = validateIp(data.target_ip);
    if (ipErr) throw new Error(ipErr);
    targetIp = sanitize(data.target_ip);
  }

  // Block reverse-proxying public traffic to the host's own privileged
  // loopback services: :2019 (Caddy admin API), :3000 (GateControl), and
  // :80/:443 (the public listener → proxy loop). Only loopback targets are
  // restricted — a peer or LAN target on these ports stays valid. Gateway
  // routes are exempt: their target_ip is a legacy '127.0.0.1' placeholder,
  // the real destination is target_lan_host behind the WG tunnel.
  if ((data.target_kind || 'peer') !== 'gateway'
      && isLoopbackHost(targetIp) && isPortBlocked(parseInt(data.target_port, 10))) {
    throw new Error('Target port ' + data.target_port + ' is reserved for loopback targets');
  }

  // Validate and serialize custom_headers
  const customHeaders = data.custom_headers
    ? (typeof data.custom_headers === 'string' ? data.custom_headers : JSON.stringify(data.custom_headers))
    : null;

  // Validate and serialize backends
  const backendsJson = data.backends
    ? (typeof data.backends === 'string' ? data.backends : JSON.stringify(data.backends))
    : null;

  // Validate and serialize mirror_targets
  const mirrorTargetsJson = data.mirror_targets
    ? (typeof data.mirror_targets === 'string' ? data.mirror_targets : JSON.stringify(data.mirror_targets))
    : null;

  validateBotBlockerConfig(data);

  validateTargetExclusivity(data);

  const targetKind = data.target_kind || 'peer';
  const targetPeerId = targetKind === 'gateway' ? (data.target_peer_id || null) : null;
  const targetPoolId = targetKind === 'gateway'
    ? (data.target_pool_id != null ? parseInt(data.target_pool_id, 10) : null)
    : null;
  const targetLanHost = targetKind === 'gateway' ? (data.target_lan_host || null) : null;
  const targetLanPort = targetKind === 'gateway' && data.target_lan_port
    ? parseInt(data.target_lan_port, 10)
    : null;
  const wolEnabled = (targetKind === 'gateway' && data.wol_enabled) ? 1 : 0;
  const wolMac = targetKind === 'gateway' ? (data.wol_mac || null) : null;

  // TLS guard: a hostname that gets HTTPS (or SNI) is preflighted BEFORE the
  // insert and the sync, so a paused host is skipped from the first sync on.
  // Orchestrators (skipSync) run the guard themselves.
  const httpsEnabled = data.https_enabled !== undefined ? !!data.https_enabled : true;
  const wantsTls = !!domain && (routeType === 'l4' ? (!!data.l4_tls_mode && data.l4_tls_mode !== 'none') : httpsEnabled);
  const tls = (!opts.skipSync && wantsTls) ? await guardTls(domain) : null;

  // HSTS: explicit hsts_* fields win; an HTTPS entry created without any of
  // them inherits the zone default. Validation throws HSTS_* (400).
  const hstsSeed = (routeType === 'http' && httpsEnabled && domain && !hasHstsInput(data))
    ? zoneHstsDefault(db, domain)
    : null;
  const hsts = resolveHstsFields(data, hstsSeed ? hstsDefaultToFields(hstsSeed) : null, {
    route_type: routeType, https_enabled: httpsEnabled,
  });
  // Security options (docs/feature-security-options.md §B/§D/§F): backend TLS
  // verification, body limit, mTLS. Validation throws coded 400 errors.
  const sec = resolveSecurityFields(data, null, { route_type: routeType, https_enabled: httpsEnabled });
  // Web Application Firewall (docs/feature-waf.md): HTTP routes only. An
  // HTTP entry created without any waf_* field inherits the zone default.
  const wafSeed = (routeType === 'http' && domain && !hasWafInput(data)) ? zoneWafDefault(db, domain) : null;
  const waf = resolveWafFields(data, wafSeed ? wafDefaultToFields(wafSeed) : null, { route_type: routeType });
  const wafChangedAt = waf.waf_enabled ? new Date().toISOString() : null;
  // Gateway backend TLS fingerprint (release B §13b).
  const backendFingerprint = resolveBackendFingerprint(data, null, {
    route_type: routeType, target_kind: targetKind, backend_https: !!data.backend_https,
  });
  // Entry name + "nur bei Bedarf" (docs/feature-next-package.md S3 §2/§3).
  const entryLabel = normalizeLabel(data.label);
  const onDemand = onDemandFlag(data.on_demand);

  const result = db.prepare(`
    INSERT INTO routes (domain, target_ip, target_port, description, peer_id,
                        https_enabled, backend_https, basic_auth_enabled, basic_auth_user, basic_auth_password_hash,
                        route_type, l4_protocol, l4_listen_port, l4_tls_mode, monitoring_enabled,
                        ip_filter_enabled, ip_filter_mode, ip_filter_rules,
                        branding_title, branding_text, branding_color, branding_bg, acl_enabled, compress_enabled,
                        custom_headers, rate_limit_enabled, rate_limit_requests, rate_limit_window,
                        retry_enabled, retry_count, retry_match_status,
                        backends, sticky_enabled, sticky_cookie_name, sticky_cookie_ttl,
                        circuit_breaker_enabled, circuit_breaker_threshold, circuit_breaker_timeout,
                        mirror_enabled, mirror_targets, debug_enabled, bot_blocker_enabled, bot_blocker_mode, bot_blocker_config, user_ids,
                        external_enabled,
                        external_block_action, external_block_body, external_block_redirect_url,
                        target_kind, target_peer_id, target_pool_id, target_lan_host, target_lan_port, wol_enabled, wol_mac,
                        hsts_enabled, hsts_max_age, hsts_subdomains, hsts_preload,
                        backend_tls_verify, backend_tls_server_name, backend_tls_ca_pem, max_body_mb,
                        mtls_enabled, mtls_ca_pem, mtls_mode,
                        waf_enabled, waf_mode, waf_paranoia, waf_mode_changed_at, backend_tls_fingerprint,
                        label, on_demand,
                        enabled)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `).run(
    domain,
    targetIp,
    parseInt(data.target_port, 10),
    sanitize(data.description) || null,
    data.peer_id || null,
    data.https_enabled !== undefined ? (data.https_enabled ? 1 : 0) : 1,
    data.backend_https ? 1 : 0,
    data.basic_auth_enabled ? 1 : 0,
    basicAuthUser,
    basicAuthPasswordHash,
    routeType,
    // L4-only fields are NULL on http routes regardless of input — a
    // stale 'tcp' on an http row breaks getGatewayConfig's Zod schema
    // and silently 500s the gateway-config endpoint.
    routeType === 'l4' ? (data.l4_protocol || null) : null,
    routeType === 'l4' ? (data.l4_listen_port || null) : null,
    routeType === 'l4' ? (data.l4_tls_mode || null) : null,
    data.monitoring_enabled ? 1 : 0,
    data.ip_filter_enabled ? 1 : 0,
    data.ip_filter_mode || null,
    data.ip_filter_rules ? (typeof data.ip_filter_rules === 'string' ? data.ip_filter_rules : JSON.stringify(data.ip_filter_rules)) : null,
    data.branding_title || null,
    data.branding_text || null,
    data.branding_color || null,
    data.branding_bg || null,
    data.acl_enabled ? 1 : 0,
    data.compress_enabled ? 1 : 0,
    customHeaders,
    data.rate_limit_enabled ? 1 : 0,
    data.rate_limit_requests ? parseInt(data.rate_limit_requests, 10) : 100,
    data.rate_limit_window || '1m',
    data.retry_enabled ? 1 : 0,
    data.retry_count ? parseInt(data.retry_count, 10) : 3,
    data.retry_match_status || '502,503,504',
    backendsJson,
    data.sticky_enabled ? 1 : 0,
    data.sticky_cookie_name || 'gc_sticky',
    data.sticky_cookie_ttl || '3600',
    data.circuit_breaker_enabled ? 1 : 0,
    data.circuit_breaker_threshold ? parseInt(data.circuit_breaker_threshold, 10) : 5,
    data.circuit_breaker_timeout ? parseInt(data.circuit_breaker_timeout, 10) : 30,
    data.mirror_enabled ? 1 : 0,
    mirrorTargetsJson,
    data.debug_enabled ? 1 : 0,
    data.bot_blocker_enabled ? 1 : 0, data.bot_blocker_mode || 'block', data.bot_blocker_config || null,
    data.user_ids ? JSON.stringify(data.user_ids) : null,
    data.external_enabled ? 1 : 0,
    data.external_block_action || 'inherit',
    data.external_block_body != null ? String(data.external_block_body) : null,
    data.external_block_redirect_url != null ? String(data.external_block_redirect_url) : null,
    targetKind,
    targetPeerId,
    targetPoolId,
    targetLanHost,
    targetLanPort,
    wolEnabled,
    wolMac,
    hsts.hsts_enabled,
    hsts.hsts_max_age,
    hsts.hsts_subdomains,
    hsts.hsts_preload,
    sec.backend_tls_verify,
    sec.backend_tls_server_name,
    sec.backend_tls_ca_pem,
    sec.max_body_mb,
    sec.mtls_enabled,
    sec.mtls_ca_pem,
    sec.mtls_mode,
    waf.waf_enabled,
    waf.waf_mode,
    waf.waf_paranoia,
    wafChangedAt,
    backendFingerprint,
    entryLabel,
    onDemand,
  );

  const routeId = result.lastInsertRowid;

  // Set ACL peers if provided
  if (data.acl_enabled && Array.isArray(data.acl_peers)) {
    setAclPeers(routeId, data.acl_peers);
  }

  // Sync to Caddy — rollback DB insert on failure. Orchestrators creating
  // several rows pass skipSync and run one sync (plus their own rollback)
  // at the end instead.
  if (!opts.skipSync) {
    await withCaddySync(syncToCaddy, () => {
      db.prepare('DELETE FROM route_peer_acl WHERE route_id = ?').run(routeId);
      db.prepare('DELETE FROM routes WHERE id = ?').run(routeId);
    }, 'route create');
  }

  if (!opts.skipSync) {
    // Refresh internal DNS so the new route resolves to the gateway for VPN
    // clients. Best-effort: a DNS failure must not fail route creation.
    try { dns.rebuildNow(); } catch (err) { logger.warn({ err: err?.message ?? String(err) }, 'DNS rebuild after route create failed'); }
  }

  activity.log('route_created', `Route "${domain}" created → ${targetIp}:${data.target_port}`, {
    source: 'admin',
    severity: 'success',
    details: { routeId, domain, targetIp, targetPort: data.target_port },
  });

  if (data.acl_enabled) {
    activity.log('route_acl_toggled', `Route "${domain}" ACL enabled`, {
      source: 'admin',
      severity: 'info',
      details: { routeId, acl_enabled: true, acl_peers: data.acl_peers || [] },
    });
  }

  logger.info({ routeId, domain }, 'Route created');

  // Fire-and-forget push-notification for gateway peers
  if (!opts.skipSync && targetKind === 'gateway' && targetPeerId) {
    try {
      const gateways = require('./gateways');
      gateways.notifyConfigChanged(targetPeerId).catch(() => {});
    } catch { /* fallback when module load fails */ }
  }

  // Give the route a host (join the host of its fqdn or create one).
  // Skipped for orchestrators (hosts, service bundles) — they own their
  // hosts and publish their own realtime event.
  if (!opts.skipSync) {
    assignHost(routeId);
    publishForRoutes(db, [routeId]);
  }

  return withTls(getById(routeId), tls);
}

/**
 * Update a route
 */
async function update(id, data) {
  const db = getDb();
  const route = db.prepare('SELECT * FROM routes WHERE id = ?').get(id);
  if (!route) throw new Error('Route not found');

  // Snapshot for rollback
  const snapshot = { ...route };

  const routeType = data.route_type || route.route_type || 'http';

  if (routeType === 'l4') {
    validateIfProvided(data, 'l4_protocol', validateL4Protocol);
    validateIfProvided(data, 'l4_listen_port', validateL4ListenPort);
    validateIfProvided(data, 'l4_tls_mode', validateL4TlsMode);
    const tlsMode = data.l4_tls_mode !== undefined ? data.l4_tls_mode : route.l4_tls_mode;
    if (tlsMode && tlsMode !== 'none') {
      const domain = data.domain !== undefined ? data.domain : route.domain;
      if (!domain) throw new Error('TLS mode requires a domain for SNI');
      const proto = data.l4_protocol !== undefined ? data.l4_protocol : route.l4_protocol;
      if (proto !== 'tcp') throw new Error('TLS requires TCP protocol');
    }
    const listenPort = data.l4_listen_port !== undefined ? data.l4_listen_port : route.l4_listen_port;
    if (listenPort) {
      const range = parsePortRange(listenPort);
      if (range) {
        for (let p = range.start; p <= range.end; p++) {
          if (isPortBlocked(p)) throw new Error('Port ' + p + ' is reserved');
        }
      }
    }
  }

  if (data.domain !== undefined && (routeType === 'http' || data.domain)) {
    const domainErr = validateDomain(data.domain);
    if (domainErr) throw new Error(domainErr);

    const domain = sanitize(data.domain).toLowerCase();
    assertDomainAvailable(db, {
      domain,
      routeType,
      tlsMode: data.l4_tls_mode !== undefined ? data.l4_tls_mode : route.l4_tls_mode,
      listenPort: data.l4_listen_port !== undefined ? data.l4_listen_port : route.l4_listen_port,
      excludeId: id,
    });
  }

  validateIfProvided(data, 'target_port', validatePort);
  validateIfProvided(data, 'target_lan_host', validateLanHost);
  validateIfProvided(data, 'description', validateDescription);

  validateBrandingFields(data);

  // Validate and hash basic auth credentials when enabled
  let basicAuthUser = route.basic_auth_user;
  let basicAuthPasswordHash = route.basic_auth_password_hash;
  const authEnabled = data.basic_auth_enabled !== undefined ? data.basic_auth_enabled : route.basic_auth_enabled;

  if (authEnabled) {
    // User provided new credentials
    if (data.basic_auth_user !== undefined) {
      const userErr = validateBasicAuthUser(data.basic_auth_user);
      if (userErr) throw new Error(userErr);
      basicAuthUser = sanitize(data.basic_auth_user);
    }
    if (data.basic_auth_password) {
      const passErr = validateBasicAuthPassword(data.basic_auth_password);
      if (passErr) throw new Error(passErr);
      basicAuthPasswordHash = await bcrypt.hash(data.basic_auth_password, 10);
    }
    // Ensure credentials exist when enabling auth
    if (!basicAuthUser || !basicAuthPasswordHash) {
      throw new Error('Basic auth username and password are required when auth is enabled');
    }
  } else {
    // Auth disabled — clear credentials
    basicAuthUser = null;
    basicAuthPasswordHash = null;
  }

  // Determine target_ip
  let targetIp = route.target_ip;
  if (data.peer_id !== undefined) {
    if (data.peer_id) {
      const peer = db.prepare('SELECT allowed_ips, enabled FROM peers WHERE id = ?').get(data.peer_id);
      if (!peer) throw new Error('Selected peer not found');
      if (!peer.enabled) throw new Error('Selected peer is disabled');
      targetIp = peer.allowed_ips.split('/')[0];
    } else if (data.target_ip) {
      const ipErr = validateIp(data.target_ip);
      if (ipErr) throw new Error(ipErr);
      targetIp = sanitize(data.target_ip);
    }
  } else if (route.peer_id) {
    // Verify existing peer still exists
    const existingPeer = db.prepare('SELECT allowed_ips FROM peers WHERE id = ?').get(route.peer_id);
    if (!existingPeer) {
      logger.warn({ routeId: id, peerId: route.peer_id }, 'Linked peer no longer exists, unlinking');
      data.peer_id = null;
    }
  }

  // Block reverse-proxying public traffic to the host's own privileged
  // loopback services (Caddy admin :2019, GateControl :3000, public listener
  // :80/:443). Mirrors the create() guard; uses the effective port (incoming
  // override or stored value). Only loopback targets are restricted; gateway
  // routes are exempt (their target_ip is a legacy '127.0.0.1' placeholder —
  // the real destination is target_lan_host behind the WG tunnel).
  const effectiveTargetPort = data.target_port !== undefined
    ? parseInt(data.target_port, 10)
    : route.target_port;
  const effectiveTargetKind = data.target_kind !== undefined
    ? data.target_kind
    : (route.target_kind || 'peer');
  if (effectiveTargetKind !== 'gateway'
      && isLoopbackHost(targetIp) && isPortBlocked(effectiveTargetPort)) {
    throw new Error('Target port ' + effectiveTargetPort + ' is reserved for loopback targets');
  }

  // Serialize custom_headers for update
  const updateCustomHeaders = data.custom_headers !== undefined
    ? (data.custom_headers ? (typeof data.custom_headers === 'string' ? data.custom_headers : JSON.stringify(data.custom_headers)) : null)
    : route.custom_headers;

  // Serialize backends for update
  const updateBackends = data.backends !== undefined
    ? (data.backends ? (typeof data.backends === 'string' ? data.backends : JSON.stringify(data.backends)) : null)
    : route.backends;

  // Serialize mirror_targets for update
  const updateMirrorTargets = data.mirror_targets !== undefined
    ? (data.mirror_targets ? (typeof data.mirror_targets === 'string' ? data.mirror_targets : JSON.stringify(data.mirror_targets)) : null)
    : route.mirror_targets;

  validateBotBlockerConfig(data);

  validateTargetExclusivity(data);

  // TLS guard: preflight when this update turns the route into an HTTPS route
  // or an SNI L4 entry, or renames one. Network lookups happen here, before
  // the write; the sync below then already carries the skip entry.
  const nextDomain = data.domain !== undefined ? (data.domain ? sanitize(data.domain).toLowerCase() : null) : (route.domain || null);
  const nextTls = routeType === 'l4'
    ? (() => { const m = data.l4_tls_mode !== undefined ? data.l4_tls_mode : route.l4_tls_mode; return !!m && m !== 'none'; })()
    : (data.https_enabled !== undefined ? !!data.https_enabled : !!route.https_enabled);
  const prevTls = (route.route_type || 'http') === 'l4'
    ? (!!route.l4_tls_mode && route.l4_tls_mode !== 'none')
    : !!route.https_enabled;
  const tlsBecomes = !!nextDomain && nextTls && (!prevTls || nextDomain !== (route.domain || null));

  // HSTS: effective state after this patch. Turning HTTPS off clears an
  // inherited hsts_enabled; an explicit hsts_enabled without HTTPS → 400.
  const hsts = resolveHstsFields(data, route, {
    route_type: routeType, https_enabled: routeType === 'l4' ? false : nextTls,
  });
  // Security options: same PATCH semantics (absent field = keep stored value;
  // HTTPS off clears an inherited mtls_enabled, explicit one → 400).
  const sec = resolveSecurityFields(data, route, {
    route_type: routeType, https_enabled: routeType === 'l4' ? false : nextTls,
  });
  // WAF: same PATCH semantics; an inherited waf_enabled is cleared when the
  // route becomes L4, an explicit one → 400 WAF_REQUIRES_HTTP.
  const waf = resolveWafFields(data, route, { route_type: routeType });
  const wafChangedAt = wafModeChanged(route, waf) ? new Date().toISOString() : (route.waf_mode_changed_at || null);
  // Gateway backend TLS fingerprint (release B §13b): effective target kind
  // and backend scheme after this patch decide whether it may stay.
  const backendFingerprint = resolveBackendFingerprint(data, route, {
    route_type: routeType,
    target_kind: data.target_kind !== undefined ? (data.target_kind || 'peer') : (route.target_kind || 'peer'),
    backend_https: data.backend_https !== undefined ? !!data.backend_https : !!route.backend_https,
  });

  const tls = tlsBecomes ? await guardTls(nextDomain) : null;

  db.prepare(`
    UPDATE routes SET
      domain = COALESCE(?, domain),
      target_ip = ?,
      target_port = COALESCE(?, target_port),
      description = COALESCE(?, description),
      peer_id = ?,
      https_enabled = COALESCE(?, https_enabled),
      backend_https = COALESCE(?, backend_https),
      basic_auth_enabled = ?,
      basic_auth_user = ?,
      basic_auth_password_hash = ?,
      route_type = COALESCE(?, route_type),
      l4_protocol = ?,
      l4_listen_port = ?,
      l4_tls_mode = ?,
      enabled = COALESCE(?, enabled),
      monitoring_enabled = COALESCE(?, monitoring_enabled),
      ip_filter_enabled = COALESCE(?, ip_filter_enabled),
      ip_filter_mode = COALESCE(?, ip_filter_mode),
      ip_filter_rules = COALESCE(?, ip_filter_rules),
      branding_title = ?,
      branding_text = ?,
      branding_logo = COALESCE(?, branding_logo),
      branding_color = COALESCE(?, branding_color),
      branding_bg = COALESCE(?, branding_bg),
      acl_enabled = COALESCE(?, acl_enabled),
      compress_enabled = COALESCE(?, compress_enabled),
      custom_headers = ?,
      rate_limit_enabled = COALESCE(?, rate_limit_enabled),
      rate_limit_requests = COALESCE(?, rate_limit_requests),
      rate_limit_window = COALESCE(?, rate_limit_window),
      retry_enabled = COALESCE(?, retry_enabled),
      retry_count = COALESCE(?, retry_count),
      retry_match_status = COALESCE(?, retry_match_status),
      backends = ?,
      sticky_enabled = COALESCE(?, sticky_enabled),
      sticky_cookie_name = COALESCE(?, sticky_cookie_name),
      sticky_cookie_ttl = COALESCE(?, sticky_cookie_ttl),
      circuit_breaker_enabled = COALESCE(?, circuit_breaker_enabled),
      circuit_breaker_threshold = COALESCE(?, circuit_breaker_threshold),
      circuit_breaker_timeout = COALESCE(?, circuit_breaker_timeout),
      mirror_enabled = COALESCE(?, mirror_enabled),
      mirror_targets = ?,
      debug_enabled = COALESCE(?, debug_enabled),
      bot_blocker_enabled = COALESCE(?, bot_blocker_enabled),
      bot_blocker_mode = COALESCE(?, bot_blocker_mode),
      bot_blocker_config = COALESCE(?, bot_blocker_config),
      user_ids = COALESCE(?, user_ids),
      external_enabled = COALESCE(?, external_enabled),
      external_block_action = COALESCE(?, external_block_action),
      external_block_body = COALESCE(?, external_block_body),
      external_block_redirect_url = COALESCE(?, external_block_redirect_url),
      target_kind = COALESCE(?, target_kind),
      target_peer_id = COALESCE(?, target_peer_id),
      target_pool_id = COALESCE(?, target_pool_id),
      target_lan_host = COALESCE(?, target_lan_host),
      target_lan_port = COALESCE(?, target_lan_port),
      wol_enabled = COALESCE(?, wol_enabled),
      wol_mac = COALESCE(?, wol_mac),
      hsts_enabled = ?,
      hsts_max_age = ?,
      hsts_subdomains = ?,
      hsts_preload = ?,
      backend_tls_verify = ?,
      backend_tls_server_name = ?,
      backend_tls_ca_pem = ?,
      max_body_mb = ?,
      mtls_enabled = ?,
      mtls_ca_pem = ?,
      mtls_mode = ?,
      waf_enabled = ?,
      waf_mode = ?,
      waf_paranoia = ?,
      waf_mode_changed_at = ?,
      backend_tls_fingerprint = ?,
      label = ?,
      on_demand = COALESCE(?, on_demand),
      updated_at = datetime('now')
    WHERE id = ?
  `).run(
    data.domain !== undefined ? sanitize(data.domain).toLowerCase() : null,
    targetIp,
    data.target_port !== undefined ? parseInt(data.target_port, 10) : null,
    data.description !== undefined ? sanitize(data.description) : null,
    data.peer_id !== undefined ? (data.peer_id || null) : route.peer_id,
    data.https_enabled !== undefined ? (data.https_enabled ? 1 : 0) : null,
    data.backend_https !== undefined ? (data.backend_https ? 1 : 0) : null,
    authEnabled ? 1 : 0,
    basicAuthUser,
    basicAuthPasswordHash,
    data.route_type || null,
    // Force L4-only fields to NULL on http routes regardless of input
    // or stored value. The effective routeType after this update is
    // either the new one or the existing one — if it's not 'l4', the
    // l4_* columns must not survive (they trip getGatewayConfig's Zod
    // schema and 500 the gateway-config endpoint). Mirrors the same
    // guard in create().
    routeType === 'l4' ? (data.l4_protocol !== undefined ? (data.l4_protocol || null) : route.l4_protocol) : null,
    routeType === 'l4' ? (data.l4_listen_port !== undefined ? (data.l4_listen_port || null) : route.l4_listen_port) : null,
    routeType === 'l4' ? (data.l4_tls_mode !== undefined ? (data.l4_tls_mode || null) : route.l4_tls_mode) : null,
    data.enabled !== undefined ? (data.enabled ? 1 : 0) : null,
    data.monitoring_enabled !== undefined ? (data.monitoring_enabled ? 1 : 0) : null,
    data.ip_filter_enabled !== undefined ? (data.ip_filter_enabled ? 1 : 0) : null,
    data.ip_filter_mode !== undefined ? (data.ip_filter_mode || null) : null,
    data.ip_filter_rules !== undefined ? (typeof data.ip_filter_rules === 'string' ? data.ip_filter_rules : JSON.stringify(data.ip_filter_rules)) : null,
    data.branding_title !== undefined ? (data.branding_title === '' ? null : data.branding_title) : route.branding_title,
    data.branding_text !== undefined ? (data.branding_text === '' ? null : data.branding_text) : route.branding_text,
    data.branding_logo !== undefined ? (data.branding_logo || null) : null,
    data.branding_color !== undefined ? (data.branding_color || null) : null,
    data.branding_bg !== undefined ? (data.branding_bg || null) : null,
    data.acl_enabled !== undefined ? (data.acl_enabled ? 1 : 0) : null,
    data.compress_enabled !== undefined ? (data.compress_enabled ? 1 : 0) : null,
    updateCustomHeaders,
    data.rate_limit_enabled !== undefined ? (data.rate_limit_enabled ? 1 : 0) : null,
    data.rate_limit_requests !== undefined ? parseInt(data.rate_limit_requests, 10) : null,
    data.rate_limit_window !== undefined ? (data.rate_limit_window || null) : null,
    data.retry_enabled !== undefined ? (data.retry_enabled ? 1 : 0) : null,
    data.retry_count !== undefined ? parseInt(data.retry_count, 10) : null,
    data.retry_match_status !== undefined ? (data.retry_match_status || null) : null,
    updateBackends,
    data.sticky_enabled !== undefined ? (data.sticky_enabled ? 1 : 0) : null,
    data.sticky_cookie_name !== undefined ? (data.sticky_cookie_name || null) : null,
    data.sticky_cookie_ttl !== undefined ? (data.sticky_cookie_ttl || null) : null,
    data.circuit_breaker_enabled !== undefined ? (data.circuit_breaker_enabled ? 1 : 0) : null,
    data.circuit_breaker_threshold !== undefined ? parseInt(data.circuit_breaker_threshold, 10) : null,
    data.circuit_breaker_timeout !== undefined ? parseInt(data.circuit_breaker_timeout, 10) : null,
    data.mirror_enabled !== undefined ? (data.mirror_enabled ? 1 : 0) : null,
    updateMirrorTargets,
    data.debug_enabled !== undefined ? (data.debug_enabled ? 1 : 0) : null,
    data.bot_blocker_enabled !== undefined ? (data.bot_blocker_enabled ? 1 : 0) : null,
    data.bot_blocker_mode !== undefined ? data.bot_blocker_mode : null,
    data.bot_blocker_config !== undefined ? (typeof data.bot_blocker_config === 'string' ? data.bot_blocker_config : JSON.stringify(data.bot_blocker_config)) : null,
    data.user_ids !== undefined ? (data.user_ids ? JSON.stringify(data.user_ids) : null) : null,
    data.external_enabled !== undefined ? (data.external_enabled ? 1 : 0) : null,
    data.external_block_action !== undefined ? data.external_block_action : null,
    data.external_block_body !== undefined ? (data.external_block_body != null ? String(data.external_block_body) : null) : null,
    data.external_block_redirect_url !== undefined ? (data.external_block_redirect_url != null ? String(data.external_block_redirect_url) : null) : null,
    data.target_kind !== undefined ? (data.target_kind || null) : null,
    data.target_peer_id !== undefined ? (data.target_peer_id || null) : null,
    data.target_pool_id !== undefined ? (data.target_pool_id != null ? parseInt(data.target_pool_id, 10) : null) : null,
    data.target_lan_host !== undefined ? (data.target_lan_host || null) : null,
    data.target_lan_port !== undefined ? (data.target_lan_port ? parseInt(data.target_lan_port, 10) : null) : null,
    data.wol_enabled !== undefined ? (data.wol_enabled ? 1 : 0) : null,
    data.wol_mac !== undefined ? (data.wol_mac || null) : null,
    hsts.hsts_enabled,
    hsts.hsts_max_age,
    hsts.hsts_subdomains,
    hsts.hsts_preload,
    sec.backend_tls_verify,
    sec.backend_tls_server_name,
    sec.backend_tls_ca_pem,
    sec.max_body_mb,
    sec.mtls_enabled,
    sec.mtls_ca_pem,
    sec.mtls_mode,
    waf.waf_enabled,
    waf.waf_mode,
    waf.waf_paranoia,
    wafChangedAt,
    backendFingerprint,
    // Entry name: sent = set/clear it, absent = keep the stored one.
    data.label !== undefined ? normalizeLabel(data.label) : (route.label || null),
    data.on_demand !== undefined ? onDemandFlag(data.on_demand) : null,
    id
  );

  // When the admin switches target_kind away from 'gateway', COALESCE
  // above would preserve stale gateway_* values that pollute both the
  // DB row and any future backup. Explicitly clear them in a follow-up
  // write so Caddy config generation sees a clean row.
  if (data.target_kind !== undefined && data.target_kind !== 'gateway') {
    db.prepare(`UPDATE routes SET target_peer_id = NULL, target_pool_id = NULL, target_lan_host = NULL, target_lan_port = NULL, wol_enabled = 0, wol_mac = NULL WHERE id = ?`).run(id);
  }

  // Update ACL peers if provided
  const oldAclPeers = getAclPeers(id).map(p => p.peer_id).sort();
  if (data.acl_peers !== undefined) {
    setAclPeers(id, data.acl_peers || []);
  }

  // Log ACL changes
  const newAclEnabled = data.acl_enabled !== undefined ? !!data.acl_enabled : !!route.acl_enabled;
  const oldAclEnabled = !!route.acl_enabled;
  if (newAclEnabled !== oldAclEnabled) {
    activity.log('route_acl_toggled', `Route "${route.domain}" ACL ${newAclEnabled ? 'enabled' : 'disabled'}`, {
      source: 'admin',
      severity: 'info',
      details: { routeId: id, acl_enabled: newAclEnabled },
    });
  }
  if (data.acl_peers !== undefined) {
    const newPeersSorted = (data.acl_peers || []).map(Number).sort();
    if (JSON.stringify(oldAclPeers) !== JSON.stringify(newPeersSorted)) {
      activity.log('route_acl_peers_changed', `Route "${route.domain}" ACL peers updated`, {
        source: 'admin',
        severity: 'info',
        details: { routeId: id, old_peers: oldAclPeers, new_peers: newPeersSorted },
      });
    }
  }

  // Sync to Caddy — rollback DB update on failure. Use a full-column
  // snapshot restore so security-critical fields (ip_filter_*, acl_*,
  // bot_blocker_*, monitoring_*, branding_*, retry_*, ...) aren't
  // silently reset to defaults when the rollback path fires.
  await withCaddySync(syncToCaddy, () => restoreRouteRow(db, id, snapshot), 'route update');

  activity.log('route_updated', `Route "${route.domain}" updated`, {
    source: 'admin',
    severity: 'info',
    details: { routeId: id },
  });

  if (data.mirror_enabled !== undefined || data.mirror_targets !== undefined) {
    activity.log('route_mirror_changed', `Mirror config changed for "${route.domain}"`, {
      source: 'admin',
      severity: 'info',
      details: { routeId: id, mirror_enabled: data.mirror_enabled },
    });
  }

  // Fire-and-forget push-notification for gateway peers (current + previous)
  const finalRoute = getById(id);
  const touchedGwPeers = new Set();
  if (finalRoute && finalRoute.target_kind === 'gateway' && finalRoute.target_peer_id) {
    touchedGwPeers.add(finalRoute.target_peer_id);
  }
  if (route.target_kind === 'gateway' && route.target_peer_id) {
    touchedGwPeers.add(route.target_peer_id);
  }
  if (touchedGwPeers.size > 0) {
    try {
      const gateways = require('./gateways');
      for (const pid of touchedGwPeers) {
        gateways.notifyConfigChanged(pid).catch(() => {});
      }
    } catch { /* module load guard */ }
  }

  try { dns.rebuildNow(); } catch (err) { logger.warn({ err: err?.message ?? String(err) }, 'DNS rebuild after route update failed'); }

  // Host bookkeeping (metadata only, after the sync): a route without a host
  // gets one; a domain change lets the route follow its fqdn (join the host
  // of the new fqdn, or the host follows its HTTP entry — the bundle domain
  // was always kept in step with the HTTP member). Re-fetch so the returned
  // row reflects a new bundle_id.
  // Capture the old host's zone first: a move may delete the emptied host.
  const refsBefore = route.bundle_id != null ? hostRefs(db, [route.bundle_id]) : [];
  const domainChanged = finalRoute && (finalRoute.domain || null) !== (route.domain || null);
  assignHost(id, domainChanged ? { previousDomain: route.domain || null } : undefined);
  const after = getById(id);
  const refsAfter = after && after.bundle_id != null && after.bundle_id !== route.bundle_id
    ? hostRefs(db, [after.bundle_id]) : [];
  const refs = [...refsBefore, ...refsAfter];
  publishRoutesEvent(refs.length ? refs : [{ domain_id: null, host_id: null }]);

  return withTls(after, tls);
}

/**
 * Delete a route
 */
async function remove(id) {
  const db = getDb();
  const route = db.prepare('SELECT * FROM routes WHERE id = ?').get(id);
  if (!route) throw new Error('Route not found');

  // Snapshot the access rules before deleting so a sync-failure rollback can
  // restore them. Without this, a rolled-back delete brings the route row back
  // but drops its time-based access windows — a route that was only protected
  // by a schedule would silently become reachable around the clock.
  const accessRulesSnapshot = require('./accessRules').listRules('route', id);
  // Captured before the delete: the last entry takes its host with it.
  const refs = hostRefs(db, [route.bundle_id]);

  // Delete the row and its access rules atomically.
  db.transaction(() => {
    db.prepare('DELETE FROM routes WHERE id = ?').run(id);
    require('./accessRules').deleteForTarget('route', id);
  })();

  // Sync to Caddy — rollback DB delete on failure. Re-insert every
  // column of the original row (not just the hard-coded core set),
  // otherwise a rollback throws away ACLs / IP-filter / bot-blocker
  // config that the admin set up and leaves a half-castrated route.
  // The access rules are restored alongside the row.
  await withCaddySync(syncToCaddy, () => {
    reinsertRouteRow(db, route);
    require('./accessRules').restoreRules(accessRulesSnapshot);
  }, 'route delete');

  if (route.bundle_id) cleanupEmptyBundles(db, [route.bundle_id]);

  activity.log('route_deleted', `Route "${route.domain}" deleted`, {
    source: 'admin',
    severity: 'warning',
    details: { routeId: id, domain: route.domain },
  });

  logger.info({ routeId: id, domain: route.domain }, 'Route deleted');
  try { dns.rebuildNow(); } catch (err) { logger.warn({ err: err?.message ?? String(err) }, 'DNS rebuild after route delete failed'); }
  publishRoutesEvent(refs);
}

/**
 * Toggle route enabled/disabled
 */
async function toggle(id) {
  const db = getDb();
  const route = db.prepare('SELECT * FROM routes WHERE id = ?').get(id);
  if (!route) throw new Error('Route not found');

  const newState = route.enabled ? 0 : 1;
  db.prepare("UPDATE routes SET enabled = ?, updated_at = datetime('now') WHERE id = ?").run(newState, id);

  // Sync to Caddy — rollback toggle on failure
  await withCaddySync(syncToCaddy, () => {
    db.prepare("UPDATE routes SET enabled = ?, updated_at = ? WHERE id = ?").run(route.enabled, route.updated_at, id);
  }, 'route toggle');

  // Push the new config to the linked gateway-companion so it picks up
  // the toggle immediately instead of waiting for the next 300 s poll.
  // Without this, re-enabling a route leaves the companion answering
  // "No route for domain ..." until the next polling cycle.
  if (route.target_kind === 'gateway' && route.target_peer_id) {
    try {
      const gateways = require('./gateways');
      gateways.notifyConfigChanged(route.target_peer_id).catch(() => {});
    } catch { /* fallback when module load fails */ }
  }

  activity.log(
    newState ? 'route_enabled' : 'route_disabled',
    `Route "${route.domain}" ${newState ? 'enabled' : 'disabled'}`,
    { source: 'admin', severity: 'info', details: { routeId: id } }
  );

  try { dns.rebuildNow(); } catch (err) { logger.warn({ err: err?.message ?? String(err) }, 'DNS rebuild after route toggle failed'); }
  publishRoutesEvent(hostRefs(db, [route.bundle_id]));

  return getById(id);
}

/**
 * Get route count
 */
function getCount() {
  const db = getDb();
  return db.prepare('SELECT COUNT(*) AS count FROM routes WHERE enabled = 1').get().count;
}

/**
 * Batch enable, disable, or delete routes.
 * Returns the count of affected routes.
 */
async function batch(action, ids) {
  if (!['enable', 'disable', 'delete'].includes(action)) {
    throw new Error('Invalid batch action');
  }
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new Error('No IDs provided');
  }

  const db = getDb();

  // Validate all IDs exist
  const placeholders = ids.map(() => '?').join(',');
  const existing = db.prepare(`SELECT id, domain FROM routes WHERE id IN (${placeholders})`).all(...ids);
  if (existing.length !== ids.length) {
    const found = new Set(existing.map(r => r.id));
    const missing = ids.filter(id => !found.has(id));
    throw new Error(`Routes not found: ${missing.join(', ')}`);
  }

  const domains = existing.map(r => r.domain);
  // Full-row snapshots so we can restore every column (not just enabled)
  // if syncToCaddy throws. A partial rollback would leave security flags
  // out of sync between DB and Caddy, same problem the single-row paths
  // already solved.
  const snapshots = db.prepare(`SELECT * FROM routes WHERE id IN (${placeholders})`).all(...ids);
  const aclSnapshots = db.prepare(`SELECT * FROM route_peer_acl WHERE route_id IN (${placeholders})`).all(...ids);
  // Access rules must also survive a delete-rollback (see remove()); a restored
  // route would otherwise lose its scheduled access windows.
  const accessRuleSnapshots = action === 'delete'
    ? db.prepare(`SELECT * FROM access_rules WHERE target_type = 'route' AND target_id IN (${placeholders})`).all(...ids)
    : [];
  // Realtime refs captured before a delete can remove the hosts.
  const refs = hostRefs(db, snapshots.map((r) => r.bundle_id));

  if (action === 'enable') {
    db.prepare(`UPDATE routes SET enabled = 1, updated_at = datetime('now') WHERE id IN (${placeholders})`).run(...ids);
  } else if (action === 'disable') {
    db.prepare(`UPDATE routes SET enabled = 0, updated_at = datetime('now') WHERE id IN (${placeholders})`).run(...ids);
  } else if (action === 'delete') {
    // Delete rows + their access rules atomically (one transaction).
    db.transaction(() => {
      db.prepare(`DELETE FROM route_peer_acl WHERE route_id IN (${placeholders})`).run(...ids);
      db.prepare(`DELETE FROM routes WHERE id IN (${placeholders})`).run(...ids);
      db.prepare(`DELETE FROM access_rules WHERE target_type = 'route' AND target_id IN (${placeholders})`).run(...ids);
    })();
  }

  await withCaddySync(syncToCaddy, () => {
    const tx = db.transaction(() => {
      if (action === 'delete') {
        for (const row of snapshots) reinsertRouteRow(db, row);
        const insertAcl = db.prepare('INSERT OR IGNORE INTO route_peer_acl (route_id, peer_id) VALUES (?, ?)');
        for (const a of aclSnapshots) insertAcl.run(a.route_id, a.peer_id);
        require('./accessRules').restoreRules(accessRuleSnapshots);
      } else {
        for (const row of snapshots) restoreRouteRow(db, row.id, row);
      }
    });
    tx();
  }, `batch ${action}`);

  if (action === 'delete') {
    cleanupEmptyBundles(db, snapshots.map((r) => r.bundle_id));
  }

  const actionPast = action === 'enable' ? 'enabled' : action === 'disable' ? 'disabled' : 'deleted';
  activity.log(
    `batch_routes_${actionPast}`,
    `Batch ${actionPast} ${ids.length} route(s): ${domains.join(', ')}`,
    {
      source: 'admin',
      severity: action === 'delete' ? 'warning' : 'info',
      details: { routeIds: ids, action },
    }
  );

  logger.info({ action, routeIds: ids, count: ids.length }, `Batch ${actionPast} routes`);

  // One rebuild for the whole batch — never per-route (avoids N hosts-file
  // writes + N dnsmasq SIGHUPs). Best-effort.
  try { dns.rebuildNow(); } catch (err) { logger.warn({ err: err?.message ?? String(err) }, 'DNS rebuild after batch route mutation failed'); }
  publishRoutesEvent(refs);

  return ids.length;
}

// ─── Bulk update (release B §2) ──────────────────────────
//
// POST /api/v1/routes/bulk { ids, set }: the same field rules as
// PUT /api/v1/routes/:id (resolveHstsFields / resolveWafFields), validated for
// EVERY route before anything is written — one failure → nothing changes.
// One transaction, one Caddy sync, full-row restore of every touched route on
// sync failure. Licence gates are the API layer's job (like PUT).

const BULK_MAX_IDS = 200;
const BULK_BOOL_FIELDS = ['enabled', 'external_enabled', 'waf_enabled', 'hsts_enabled', 'hsts_subdomains', 'monitoring_enabled'];
const BULK_FIELDS = [...BULK_BOOL_FIELDS, 'waf_mode', 'waf_paranoia', 'hsts_max_age'];
const BULK_COLUMNS = ['enabled', 'external_enabled', 'monitoring_enabled', 'waf_enabled', 'waf_mode', 'waf_paranoia',
  'waf_mode_changed_at', 'hsts_enabled', 'hsts_max_age', 'hsts_subdomains', 'hsts_preload'];

function bulkError(statusCode, code, message, extra = {}) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  Object.assign(err, extra);
  return err;
}

function bulkBool(v) {
  if (v === true || v === 1) return 1;
  if (v === false || v === 0) return 0;
  return null;
}

/** Validate the request shape → { ids:number[], set:object } or throw 400. */
function parseBulkInput(input) {
  const body = input && typeof input === 'object' ? input : {};
  const rawIds = body.ids;
  if (!Array.isArray(rawIds) || rawIds.length === 0) throw bulkError(400, 'BULK_IDS_INVALID', 'ids must be a non-empty array of route ids');
  if (rawIds.length > BULK_MAX_IDS) throw bulkError(400, 'BULK_IDS_INVALID', `at most ${BULK_MAX_IDS} ids per request`);
  const ids = [];
  for (const v of rawIds) {
    const n = typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v.trim()) : v;
    if (!Number.isInteger(n) || n < 1) throw bulkError(400, 'BULK_IDS_INVALID', 'ids must be positive integers');
    if (!ids.includes(n)) ids.push(n);
  }
  const set = body.set;
  if (!set || typeof set !== 'object' || Array.isArray(set) || Object.keys(set).length === 0) {
    throw bulkError(400, 'BULK_SET_INVALID', 'set must be an object with at least one field');
  }
  const out = {};
  for (const [k, v] of Object.entries(set)) {
    if (!BULK_FIELDS.includes(k)) throw bulkError(400, 'BULK_FIELD_INVALID', `field "${k}" cannot be changed in bulk`);
    if (v === undefined) continue;
    if (BULK_BOOL_FIELDS.includes(k)) {
      const b = bulkBool(v);
      if (b === null) throw bulkError(400, 'BULK_FIELD_INVALID', `${k} must be a boolean`);
      out[k] = b;
    } else {
      out[k] = v;
    }
  }
  if (Object.keys(out).length === 0) throw bulkError(400, 'BULK_SET_INVALID', 'set must be an object with at least one field');
  return { ids, set: out };
}

/** The column values of `route` after applying `set`; throws the coded field errors. */
function bulkNextColumns(route, set) {
  const routeType = route.route_type || 'http';
  const httpsOn = routeType !== 'l4' && !!route.https_enabled;
  const hsts = resolveHstsFields(set, route, { route_type: routeType, https_enabled: httpsOn });
  const waf = resolveWafFields(set, route, { route_type: routeType });
  const pickBool = (field) => (set[field] !== undefined ? set[field] : (route[field] ? 1 : 0));
  return {
    enabled: pickBool('enabled'),
    external_enabled: pickBool('external_enabled'),
    monitoring_enabled: pickBool('monitoring_enabled'),
    waf_enabled: waf.waf_enabled,
    waf_mode: waf.waf_mode,
    waf_paranoia: waf.waf_paranoia,
    waf_mode_changed_at: wafModeChanged(route, waf) ? new Date().toISOString() : (route.waf_mode_changed_at || null),
    hsts_enabled: hsts.hsts_enabled,
    hsts_max_age: hsts.hsts_max_age,
    hsts_subdomains: hsts.hsts_subdomains,
    hsts_preload: hsts.hsts_preload,
  };
}

/**
 * Validate all routes of a bulk request without writing. → { ids, set, rows,
 * plans: [{ row, next, changed }] } or throws 400 BULK_INVALID with
 * `failed: [{ id, code, error }]` (every failing route, not just the first).
 */
function planBulkUpdate(input) {
  const { ids, set } = parseBulkInput(input);
  const db = getDb();
  const rows = db.prepare(`SELECT * FROM routes WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const failed = [];
  const plans = [];
  for (const id of ids) {
    const row = byId.get(id);
    if (!row) { failed.push({ id, code: 'NOT_FOUND', error: 'route not found' }); continue; }
    try {
      const next = bulkNextColumns(row, set);
      const changed = BULK_COLUMNS.some((c) => c !== 'waf_mode_changed_at' && String(next[c]) !== String(row[c]));
      plans.push({ row, next, changed });
    } catch (err) {
      failed.push({ id, code: err.code || 'INVALID', error: err.message });
    }
  }
  if (failed.length > 0) {
    throw bulkError(400, 'BULK_INVALID', `${failed.length} of ${ids.length} routes cannot be changed — nothing was changed`, { failed });
  }
  return { ids, set, plans };
}

/** Validate (planBulkUpdate) and apply a bulk update. → { updated: ids, changed: n }. */
async function bulkUpdate(input) {
  const { ids, set, plans } = planBulkUpdate(input);
  const db = getDb();
  const todo = plans.filter((p) => p.changed);
  if (todo.length === 0) return { updated: ids, changed: 0 };

  const setSql = BULK_COLUMNS.map((c) => `${c} = ?`).join(', ');
  const stmt = db.prepare(`UPDATE routes SET ${setSql}, updated_at = datetime('now') WHERE id = ?`);
  db.transaction(() => {
    for (const p of todo) stmt.run(...BULK_COLUMNS.map((c) => p.next[c]), p.row.id);
  })();

  // Looked up at call time (like domainZones) so a stub of
  // caddyConfig.syncToCaddy applies.
  await withCaddySync(() => require('./caddyConfig').syncToCaddy(), () => {
    db.transaction(() => {
      for (const p of todo) restoreRouteRow(db, p.row.id, p.row);
    })();
  }, 'routes bulk update');

  const changedIds = todo.map((p) => p.row.id);
  activity.log('routes_bulk_update', `Bulk update of ${changedIds.length} route(s): ${Object.keys(set).join(', ')}`, {
    source: 'admin',
    severity: 'info',
    details: { routeIds: changedIds, requested: ids, set },
  });
  logger.info({ routeIds: changedIds, fields: Object.keys(set) }, 'Routes bulk update');

  // Companions see enabled (their config lists enabled gateway routes only).
  const gwPeers = new Set();
  for (const p of todo) {
    if (p.row.target_kind === 'gateway' && p.row.target_peer_id && p.next.enabled !== (p.row.enabled ? 1 : 0)) gwPeers.add(p.row.target_peer_id);
  }
  if (gwPeers.size > 0) {
    try {
      const gateways = require('./gateways');
      for (const pid of gwPeers) gateways.notifyConfigChanged(pid).catch(() => {});
    } catch { /* module load guard */ }
  }
  if (todo.some((p) => p.next.enabled !== (p.row.enabled ? 1 : 0) || p.next.external_enabled !== (p.row.external_enabled ? 1 : 0))) {
    try { dns.rebuildNow(); } catch (err) { logger.warn({ err: err?.message ?? String(err) }, 'DNS rebuild after bulk update failed'); }
  }
  // Monitoring newly on → first check right away (like PUT).
  for (const p of todo) {
    if (p.next.monitoring_enabled && !p.row.monitoring_enabled) {
      try { require('./monitor').checkRouteById(p.row.id).catch(() => {}); } catch { /* best-effort */ }
    }
  }
  publishRoutesEvent(hostRefs(db, todo.map((p) => p.row.bundle_id)));
  return { updated: ids, changed: changedIds.length };
}

/**
 * Resolve the server-side companion proxy URL for a gateway route.
 * The GC server reaches deCONZ/companion via the peer's WireGuard IP on the
 * companion proxy port (default 8080). Callers also get the domain so they
 * can set X-Gateway-Target-Domain on every request.
 * Returns { baseUrl, domain } or null if the route/peer is not found.
 */
function resolveCompanionUrl(routeId) {
  const route = getById(routeId);
  if (!route || !route.target_peer_ip) return null;
  const peerIp = String(route.target_peer_ip).split('/')[0];
  // ponytail: companion proxy port default 8080; per-peer override via gm.proxy_port wenn nötig
  return { baseUrl: 'http://' + peerIp + ':8080', domain: route.domain };
}

/**
 * Get HTTP routes filtered by user_ids for client API.
 * If user_ids is set on a route, only matching users see it.
 * If not set, route is visible to all.
 */
function getForUser(userId) {
  const db = getDb();
  const routes = db.prepare("SELECT * FROM routes WHERE enabled = 1 AND (route_type = 'http' OR route_type IS NULL)").all();
  return routes.filter(r => {
    if (r.user_ids) {
      try {
        const allowed = JSON.parse(r.user_ids);
        if (Array.isArray(allowed) && allowed.length > 0) {
          return userId ? allowed.includes(userId) : false;
        }
      } catch {}
    }
    return true;
  });
}

module.exports = {
  assertDomainAvailable,
  cleanupEmptyBundles,
  toApiRows,
  getAll,
  getById,
  create,
  update,
  remove,
  toggle,
  getCount,
  syncToCaddy,
  buildCaddyConfig,
  caddyApi,
  getAclPeers,
  setAclPeers,
  batch,
  planBulkUpdate,
  bulkUpdate,
  BULK_MAX_IDS,
  getForUser,
  resolveCompanionUrl,
};
