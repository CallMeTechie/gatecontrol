'use strict';

/**
 * Caddy JSON config builder and sync orchestrator.
 *
 * Internals are split across focused modules:
 *   caddyValidators.js    — string/format validators + defender helpers
 *   caddyAcl.js           — route ACL peer DB helpers
 *   caddyMaintenance.js   — gateway-offline page renderer
 *   caddyRateLimit.js     — rate_limit handler builder
 *   caddyCircuitBreaker.js — circuit-breaker open-state 503 builder
 *   caddyMirror.js        — mirror handler builder
 *   caddyRetry.js         — retry config applier (mutates reverseProxy)
 *   caddyCustomHeaders.js — request/response headers handler builders
 *   caddyBackends.js      — JSON `backends` column → resolved peer IPs
 *   caddyTlsAutomation.js — apps.tls.automation policies (ACME / internal)
 *   caddyAuthSubroute.js  — forward-auth subroute + handler chain
 *   caddyAdminClient.js   — Caddy Admin API client + TLS self-test +
 *                           supervisor restart + partial PATCH helpers
 *
 * This file keeps the monolithic buildCaddyConfig() (~600 lines of
 * route→JSON mapping) and the syncToCaddy() orchestration. Public API
 * (module.exports) is unchanged — all importers keep working.
 */

const { getDb } = require('../db/connection');
const config = require('../../config/default');
const { buildL4Servers, validatePortConflicts } = require('./l4');
const { getAuthForRoute } = require('./routeAuth');
const logger = require('../utils/logger');

const {
  CADDY_PLACEHOLDER_RE,
  BOT_BLOCKER_RANGES,
  buildDefenderConfig,
  sanitizeStickyCookieName,
} = require('./caddyValidators');
const { buildRateLimitHandler } = require('./caddyRateLimit');
const { buildCircuitBreakerOpenHandler } = require('./caddyCircuitBreaker');
const { buildMirrorHandler } = require('./caddyMirror');
const { applyRetryConfig } = require('./caddyRetry');
const { buildRequestHeadersHandler, applyResponseHeaders } = require('./caddyCustomHeaders');
const { resolveBackends } = require('./caddyBackends');
const { buildTlsAutomation } = require('./caddyTlsAutomation');
const { buildRouteAuthProxy, buildAuthHandlerChain } = require('./caddyAuthSubroute');
const { getAclPeers, setAclPeers } = require('./caddyAcl');
const { renderMaintenancePage } = require('./caddyMaintenance');
const { renderAccessWindowPage } = require('./caddyAccessWindow');
const {
  caddyApi,
  _caddyApi,
  _persistRuntimeJson,
  _verifyLocalTls,
  _restartCaddyViaSupervisor,
  _managementHost,
  patchGatewayRouteHandlers,
} = require('./caddyAdminClient');

const gatewayPool = require('./gatewayPool');
const { isLoopbackHost } = require('../utils/validate');
const gatewayHealth = require('./gatewayHealth');

// Source IP ranges allowed to reach an internal-only route (external_enabled=0).
// Centralised in config.wireguard.internalOnlyRanges (config/default.js) so
// the HTTP gate here and the L4 gate in services/l4.js share a single source
// of truth. Default: VPN subnet only; GC_HUB_PUBLIC_IP appends a /32.
const INTERNAL_ONLY_RANGES = config.wireguard.internalOnlyRanges;

function _peerIp(allowedIps) {
  return (allowedIps || '').split('/')[0].split(',')[0].trim();
}

// Resolve a target_pool_id route to its current upstream(s). Peer-pinned
// routes don't go through here — they read target_peer_allowed_ips directly
// in buildCaddyConfig because failover is now done by pivoting
// target_peer_id in the DB (gatewayHealth._onTransition), so the peer at
// route lookup time is always the right one.
function resolveRouteUpstreams(route, options = {}) {
  if (!route.target_pool_id) return { peers: [], outage: true };

  const db = require('../db/connection').getDb();
  let snapshot = gatewayHealth.getSnapshot();
  // export-caddy-config.js builds the boot config before the watchdog has
  // ever ticked, so the in-memory snapshot is empty {}. Without this seed
  // every pool-route would serve a 503 outage page until the first state
  // transition (which may never come if peers were stable at boot).
  if (Object.keys(snapshot).length === 0) {
    const rows = db.prepare('SELECT peer_id, alive FROM gateway_meta').all();
    const seeded = {};
    for (const r of rows) seeded[r.peer_id] = { alive: r.alive === 1 };
    snapshot = seeded;
  }
  const fallbackPort = options.gatewayProxyPort || 8080;

  const peerLookup = db.prepare(`
    SELECT p.id, p.allowed_ips, gm.proxy_port
    FROM peers p
    LEFT JOIN gateway_meta gm ON gm.peer_id = p.id
    WHERE p.id = ?
  `);

  const pool = gatewayPool.getPool(route.target_pool_id);
  if (!pool || !pool.enabled) return { peers: [], outage: true };
  const peerIds = pool.mode === 'failover'
    ? (() => { const id = gatewayPool.resolveActivePeer(route.target_pool_id, snapshot); return id ? [id] : []; })()
    : gatewayPool.resolveActivePeers(route.target_pool_id, snapshot);
  if (peerIds.length === 0) return { peers: [], outage: true };
  const peers = peerIds.map(id => peerLookup.get(id));
  return {
    peers: peers.map(p => ({ id: p.id, ip: _peerIp(p.allowed_ips), port: p.proxy_port || fallbackPort })),
    outage: false,
    lb_policy: pool.mode === 'load_balancing' ? pool.lb_policy : null,
    pool,
  };
}

function buildPoolOutageBlock(route) {
  const pool = route.target_pool_id ? gatewayPool.getPool(route.target_pool_id) : null;
  let defaultBody = 'Service temporarily unavailable. Please try again later.';
  try {
    const i18n = require('../i18n');
    if (typeof i18n.t === 'function') {
      const lang = process.env.GC_DEFAULT_LANG || 'de';
      const translated = i18n.t(lang, 'pool_outage.body');
      if (translated) defaultBody = translated;
    }
  } catch { /* i18n not available — fall back to literal */ }
  const body = pool?.outage_message || defaultBody;
  return {
    match: [{ host: [route.domain] }],
    handle: [{
      handler: 'static_response',
      status_code: 503,
      headers: { 'Content-Type': ['text/plain; charset=utf-8'] },
      body,
    }],
    terminal: true,
  };
}

// Human-readable schedule for a route's access-window 403 page. Joins the
// schedules of the route's enabled allow-rules so the visitor learns when the
// route is reachable; returns '' when none (e.g. denial is via a block rule or
// the route has no allow-rules). Best-effort — never throws into the builder.
function humanScheduleForRoute(routeId) {
  try {
    const rules = require('./accessRules').listRules('route', routeId);
    return rules
      .filter(r => r.enabled && r.mode === 'allow' && r.schedule)
      .map(r => String(r.schedule).trim())
      .filter(Boolean)
      .join('; ');
  } catch {
    return '';
  }
}

// Resolve the external-block fallback handler for an internal-only route.
// Returns null when no fallback applies (route is external, action 'empty',
// or a misconfigured redirect/custom). The returned handler is served to
// EXTERNAL source IPs only (the caller attaches it as a host-only sibling
// route AFTER the remote_ip-gated content route). Mirrors the static_response
// shape already used for access-window/outage pages (caddyConfig.js:129-138).
function buildExternalBlockHandler(route) {
  if (route.external_enabled) return null;
  const settings = require('./settings');
  let action = route.external_block_action || 'inherit';
  if (action === 'inherit') action = settings.get('route_external_block_action', 'not_found');
  if (action === 'empty') return null;

  if (action === 'redirect') {
    let url = route.external_block_redirect_url;
    if (!url || !String(url).trim()) url = settings.get('route_external_block_redirect_url', '');
    url = url ? String(url).trim() : '';
    if (!url) return null; // misconfigured → behave like today (no fallback)
    return [{ handler: 'static_response', status_code: 302, headers: { Location: [url] } }];
  }

  if (action === 'custom') {
    let body = route.external_block_body;
    if (!body) body = settings.get('route_external_block_body', '');
    if (!body) return [{ handler: 'static_response', status_code: 404 }]; // empty custom → bare 404
    return [{ handler: 'static_response', status_code: 404, headers: { 'Content-Type': ['text/html; charset=utf-8'] }, body: String(body) }];
  }

  // not_found (default) — honest empty-body 404
  return [{ handler: 'static_response', status_code: 404 }];
}

// ─── Build Caddy JSON config from all enabled routes ────
/**
 * Build Caddy configuration JSON. Overloaded:
 *   buildCaddyConfig()                   → Query routes from DB
 *   buildCaddyConfig(options)            → Query routes from DB, pass options
 *   buildCaddyConfig(routes, options)    → Use provided routes (for tests)
 */
function buildCaddyConfig(injectedRoutes, options = {}) {
  // Support buildCaddyConfig(options) — single plain-object argument
  if (injectedRoutes && !Array.isArray(injectedRoutes) && typeof injectedRoutes === 'object') {
    options = injectedRoutes;
    injectedRoutes = null;
  }
  const db = getDb();
  const gatewayProxyPort = options.gatewayProxyPort || 8080;
  const routes = Array.isArray(injectedRoutes) ? injectedRoutes : db.prepare(`
    SELECT r.*, p.allowed_ips, p.name AS peer_name,
           gp.allowed_ips AS target_peer_allowed_ips, gp.name AS target_peer_name,
           gm.proxy_port AS target_peer_proxy_port,
           gm_home.lan_ip AS home_lan_ip
    FROM routes r
    LEFT JOIN peers p ON r.peer_id = p.id
    LEFT JOIN peers gp ON gp.id = r.target_peer_id
    LEFT JOIN gateway_meta gm ON gm.peer_id = r.target_peer_id
    LEFT JOIN gateway_meta gm_home ON gm_home.peer_id = r.original_peer_id
    WHERE r.enabled = 1
  `).all();

  const httpRoutes = routes.filter(r => r.route_type !== 'l4');
  const l4Routes = routes.filter(r => r.route_type === 'l4');

  // Scheduled access windows: consult accessRules at build time so denial is
  // fail-closed across restarts. anyRulesExist() is a cheap short-circuit —
  // when no access_rules exist (the common case) we skip every per-route
  // isDenied() check, so this code path is a true no-op and the emitted config
  // is byte-identical to before the feature existed. require('./accessRules')
  // is resolved inline so test stubs on the module export are observed.
  const now = new Date();
  const rulesExist = require('./accessRules').anyRulesExist();

  const caddyRoutes = {};
  // Pre-assembled route entries (e.g. pool-outage 503 blocks) that bypass
  // the caddyRoutes dict and are merged directly into serverRoutes.
  const serverRoutes_pending = [];

  for (const route of httpRoutes) {
    // Scheduled access window — denied right now → serve a 403 page instead of
    // proxying. This replaces the entire normal handler chain (no upstream, no
    // forward_auth, no basic_auth). Gated on rulesExist so the no-rules case is
    // a true no-op.
    if (rulesExist && require('./accessRules').isDenied('route', route.id, now)) {
      const html = renderAccessWindowPage({ schedule: humanScheduleForRoute(route.id) });
      caddyRoutes[route.domain] = {
        listen: route.https_enabled ? [':443'] : [':80'],
        routes: [{
          '@id': `gc_route_${route.id}`,
          handle: [{
            handler: 'static_response',
            status_code: 403,
            headers: { 'Content-Type': ['text/html; charset=utf-8'] },
            body: html,
          }],
        }],
      };
      continue;
    }

    // Determine target IP: if linked to a peer, use peer's WG IP; otherwise use target_ip
    let targetIp = route.target_ip;
    if (route.peer_id && route.allowed_ips) {
      targetIp = route.allowed_ips.split('/')[0];
    }

    // Parse backends for load balancing — resolve peer IPs from peer_id
    const backends = resolveBackends(db, route);
    const hasMultipleBackends = Array.isArray(backends) && backends.length > 0;

    // Determine gateway-target peer IP (for target_kind='gateway' routes).
    // Pool-routes (target_pool_id) are resolved via resolveRouteUpstreams;
    // pin-routes (target_peer_id) use the pre-joined target_peer_allowed_ips.
    // Failover for pin-routes happens via DB pivot in gatewayHealth — the
    // route's target_peer_id is updated in place when the pinned peer
    // goes offline, so by the time caddy reads it the IP is already the
    // alive sibling's.
    let gatewayPeerIp = null;
    let poolUpstreams = null;
    if (route.target_kind === 'gateway') {
      if (route.target_pool_id) {
        const resolved = resolveRouteUpstreams(route, { gatewayProxyPort });
        if (resolved.outage) {
          serverRoutes_pending.push(buildPoolOutageBlock(route));
          continue;
        }
        poolUpstreams = resolved;
      } else if (route.target_peer_ip) {
        gatewayPeerIp = route.target_peer_ip;
      } else if (route.target_peer_allowed_ips) {
        gatewayPeerIp = route.target_peer_allowed_ips.split('/')[0];
      }
    }

    // Loopback resolution: a gateway route whose target is 127.0.0.1 is
    // host-relative. When it has failed over to a sibling (original_peer_id
    // set), the sibling would forward to ITS OWN localhost. Rewrite to the
    // home gateway's LAN IP (home_lan_ip, joined via original_peer_id). If the
    // home LAN IP is unknown (old companion / never reported), fail closed
    // with a maintenance page instead of silently mis-forwarding.
    let effectiveLanHost = route.target_lan_host;
    let loopbackOutage = false;
    if (route.target_kind === 'gateway'
        && isLoopbackHost(route.target_lan_host)
        && route.original_peer_id != null) {
      if (route.home_lan_ip) {
        effectiveLanHost = route.home_lan_ip;
      } else {
        loopbackOutage = true;
      }
    }

    let upstreams;
    if (poolUpstreams) {
      // Pool route: upstreams already resolved
      upstreams = poolUpstreams.peers.map(p => ({ dial: `${p.ip}:${p.port}` }));
    } else if (gatewayPeerIp) {
      // Pin-route through gateway: upstream = gateway-tunnel-IP:proxy-port.
      // Use the peer-specific proxy_port from the JOIN (DSM hosts often
      // can't bind 8080), fall back to the global default.
      const pinPort = route.target_peer_proxy_port || gatewayProxyPort;
      upstreams = [{ dial: `${gatewayPeerIp}:${pinPort}` }];
    } else if (hasMultipleBackends) {
      upstreams = backends.map(b => ({ dial: `${b.ip}:${b.port}` }));
    } else {
      const upstream = `${targetIp}:${route.target_port}`;
      upstreams = [{ dial: upstream }];
    }

    // Parse custom headers
    let customHeaders = null;
    if (route.custom_headers) {
      try {
        customHeaders = JSON.parse(route.custom_headers);
      } catch (err) {
        logger.warn({ routeId: route.id, err: err.message }, 'Invalid JSON in route.custom_headers — ignoring custom headers for this route');
      }
    }

    // Parse mirror targets — resolve peer IPs from peer_id. Cap at 5 so
    // a backup-restored or manually-edited DB with many targets can't
    // multiply ingress traffic unbounded on the WG tunnel.
    const MIRROR_MAX = 5;
    let mirrorTargets = null;
    if (route.mirror_enabled && route.mirror_targets) {
      try {
        const rawMirrorTargets = JSON.parse(route.mirror_targets);
        if (Array.isArray(rawMirrorTargets)) {
          mirrorTargets = rawMirrorTargets.slice(0, MIRROR_MAX).map(t => {
            if (!t.peer_id) return null;
            const mirrorPeer = db.prepare('SELECT allowed_ips, enabled FROM peers WHERE id = ?').get(t.peer_id);
            if (!mirrorPeer || !mirrorPeer.enabled) return null;
            return { ip: mirrorPeer.allowed_ips.split('/')[0], port: t.port };
          }).filter(Boolean);
          if (rawMirrorTargets.length > MIRROR_MAX) {
            logger.warn({ routeId: route.id, got: rawMirrorTargets.length, cap: MIRROR_MAX }, 'Mirror targets exceed cap, truncating');
          }
        }
      } catch (err) {
        logger.warn({ routeId: route.id, err: err.message }, 'Invalid JSON in route.mirror_targets — disabling mirroring for this route');
      }
    }

    // Gateway-offline: serve maintenance page instead of proxying
    let reverseProxy;
    if (route.target_kind === 'gateway' && (route.gateway_offline || loopbackOutage)) {
      const html = renderMaintenancePage({
        gateway_name: route.gateway_name || '',
        gateway_last_seen: route.gateway_last_seen || '',
      });
      reverseProxy = {
        handler: 'static_response',
        status_code: 502,
        headers: { 'Content-Type': ['text/html; charset=utf-8'] },
        body: html,
      };
      // Skip to route config assembly — no upstreams/headers needed
    } else {
      reverseProxy = {
        handler: 'reverse_proxy',
        upstreams,
      };
    }

    // Gateway-routing: inject X-Gateway-Target and X-Gateway-Target-Domain headers
    // so the Gateway-HTTP-Proxy knows the LAN target to forward to.
    // Skip when serving the gateway_offline maintenance page (static_response).
    // Always strip any client-supplied X-Gateway-* headers first so a caller
    // cannot spoof them into a gateway regardless of whether this route is
    // gateway-routed itself.
    if (reverseProxy.handler === 'reverse_proxy') {
      reverseProxy.headers = reverseProxy.headers || {};
      reverseProxy.headers.request = reverseProxy.headers.request || {};
      reverseProxy.headers.request.delete = [
        ...(reverseProxy.headers.request.delete || []),
        'X-Gateway-Target',
        'X-Gateway-Target-Domain',
      ];
    }
    if (reverseProxy.handler === 'reverse_proxy'
        && (gatewayPeerIp || poolUpstreams) && (route.target_lan_host || route.target_lan_port)) {
      // Defense in depth: never interpolate a Caddy placeholder into the
      // header value. Caddy expands {…} tokens (e.g. {env.GC_ENCRYPTION_KEY})
      // at request time, so a placeholder reaching here — whether from a
      // legacy row that predates the write-time validator or from a
      // heartbeat-reported home_lan_ip — would leak server state to the
      // gateway companion. Fail closed: skip the target header entirely.
      if (CADDY_PLACEHOLDER_RE.test(String(effectiveLanHost))) {
        logger.error({ routeId: route.id, domain: route.domain },
          'LAN target contains a Caddy placeholder — refusing to set X-Gateway-Target');
      } else {
        const lanTarget = `${effectiveLanHost}:${route.target_lan_port}`;
        reverseProxy.headers.request.set = {
          ...(reverseProxy.headers.request.set || {}),
          'X-Gateway-Target': [lanTarget],
          'X-Gateway-Target-Domain': [route.domain],
        };
      }
    }

    // Pool load balancing policy + passive health checks. The selection
    // policy controls which upstream a request goes to; passive HC takes
    // a member out of rotation after repeated 5xx without needing an
    // active probe. Keeps LB pools self-healing even if gatewayHealth
    // hasn't yet flipped alive=0 (companion is up but a backend behind
    // it is failing).
    if (poolUpstreams?.lb_policy) {
      reverseProxy.load_balancing = {
        selection_policy: { policy: poolUpstreams.lb_policy },
      };
      if ((poolUpstreams.peers || []).length > 1) {
        reverseProxy.health_checks = {
          ...(reverseProxy.health_checks || {}),
          passive: {
            fail_duration: '30s',
            max_fails: 3,
            unhealthy_status: [500, 502, 503, 504],
          },
        };
      }
    }

    // Load balancing policy (only for multiple backends)
    if (hasMultipleBackends) {
      if (route.sticky_enabled) {
        reverseProxy.load_balancing = {
          selection_policy: { policy: 'cookie', name: sanitizeStickyCookieName(route.sticky_cookie_name), max_age: (route.sticky_cookie_ttl || '3600') + 's' },
        };
      } else {
        const weights = backends.map(b => b.weight || 1);
        const allEqual = weights.every(w => w === weights[0]);
        if (allEqual) {
          reverseProxy.load_balancing = {
            selection_policy: { policy: 'round_robin' },
          };
        } else {
          reverseProxy.load_balancing = {
            selection_policy: { policy: 'weighted_round_robin', weights },
          };
        }
      }
    }

    // Retry configuration (mutates reverseProxy.load_balancing in place
    // when route.retry_enabled is set; no-op otherwise).
    applyRetryConfig(reverseProxy, route);

    // Response custom headers (mutates reverseProxy.headers).
    if (customHeaders) applyResponseHeaders(reverseProxy, customHeaders.response);

    // Backend HTTPS with insecure_skip_verify. Skipped for gateway-typed
    // routes: the Caddy → Gateway hop (over WG tunnel) always speaks
    // plain HTTP on the gateway's proxy port, regardless of the LAN
    // target's scheme. Applying TLS transport here turned every gateway
    // route into a 502 (`tls: first record does not look like a TLS
    // handshake`) whenever the flag was set. If the LAN target itself
    // needs HTTPS, that gets handled by the gateway's own proxy — not
    // by the WG-side leg.
    if (route.backend_https && !gatewayPeerIp) {
      logger.warn({ domain: route.domain, upstreams: upstreams.map(u => u.dial).join(',') }, 'Route uses backend_https with insecure_skip_verify — TLS not validated');
      reverseProxy.transport = {
        protocol: 'http',
        tls: {
          insecure_skip_verify: true,
        },
      };
    }

    // Circuit breaker — when open, return 503
    if (route.circuit_breaker_enabled && route.circuit_breaker_status === 'open') {
      caddyRoutes[route.domain] = {
        listen: route.https_enabled ? [':443'] : [':80'],
        routes: [{
          handle: [buildCircuitBreakerOpenHandler(route.circuit_breaker_timeout)],
        }],
      };
      continue;
    }

    const routeHandlers = [];

    // Bot blocker
    if (route.bot_blocker_enabled) {
      routeHandlers.push(buildDefenderConfig(route));
    }

    // Request tracing
    if (route.debug_enabled) {
      routeHandlers.push({
        handler: 'trace',
        tag: `route-${route.id}`,
        response_debug_enabled: true,
      });
    }

    // Request custom headers
    if (customHeaders) {
      const reqHeaders = buildRequestHeadersHandler(customHeaders.request);
      if (reqHeaders) routeHandlers.push(reqHeaders);
    }

    // Rate limiting
    if (route.rate_limit_enabled) {
      routeHandlers.push(buildRateLimitHandler(route));
    }

    // Request mirroring
    if (mirrorTargets && Array.isArray(mirrorTargets) && mirrorTargets.length > 0) {
      routeHandlers.push(buildMirrorHandler(mirrorTargets));
    }

    // Compression
    if (route.compress_enabled) {
      routeHandlers.push({
        handler: 'encode',
        encodings: { zstd: {}, brotli: {}, gzip: {} },
      });
    }

    routeHandlers.push(reverseProxy);

    const routeConfig = {
      '@id': `gc_route_${route.id}`,
      handle: routeHandlers,
    };

    // Peer ACL
    if (route.acl_enabled) {
      const aclPeers = getAclPeers(route.id);
      if (aclPeers.length > 0) {
        const ranges = aclPeers
          .map(p => p.allowed_ips ? p.allowed_ips.split('/')[0] + '/32' : null)
          .filter(Boolean);
        if (ranges.length > 0) {
          routeConfig.match = [{ remote_ip: { ranges } }];
        }
      }
    }

    // External-exposure gate: an internal-only route (external_enabled=0) is
    // served ONLY to VPN source IPs. Key off the EFFECTIVE matcher
    // (routeConfig.match), NOT the acl_enabled flag — an ACL with zero selected
    // peers leaves match unset and would otherwise fall OPEN. Fail-closed.
    // Monitoring is unaffected: monitor.js probes the backend targetIp directly,
    // never the Caddy front, so no loopback carve-out is needed. remote_ip =
    // real connection IP (NOT X-Forwarded-For) → cannot be spoofed via headers;
    // never use client_ip here. (Phase-0 empirically verified: ACME still
    // issues, VPN reaches, external is blocked, XFF spoof fails.)
    // NOTE: the parallel L4 gate lives in services/l4.js buildL4Route().
    if (!route.external_enabled && !routeConfig.match) {
      routeConfig.match = [{ remote_ip: { ranges: INTERNAL_ONLY_RANGES } }];
    }

    // Basic auth
    if (route.basic_auth_enabled && route.basic_auth_user && route.basic_auth_password_hash) {
      routeConfig.handle.unshift({
        handler: 'authentication',
        providers: {
          http_basic: {
            accounts: [
              {
                username: route.basic_auth_user,
                password: route.basic_auth_password_hash,
              },
            ],
          },
        },
      });
    }

    // Route Auth (forward auth)
    const routeAuthConfig = !route.basic_auth_enabled ? getAuthForRoute(route.id) : null;
    const needsForwardAuth = routeAuthConfig || route.ip_filter_enabled;

    if (needsForwardAuth) {
      routeConfig.handle = buildAuthHandlerChain({
        route, reverseProxy, customHeaders, mirrorTargets,
      });
      caddyRoutes[route.domain] = {
        listen: route.https_enabled ? [':443'] : [':80'],
        routes: [buildRouteAuthProxy(), routeConfig],
      };
    } else {
      caddyRoutes[route.domain] = {
        listen: route.https_enabled ? [':443'] : [':80'],
        routes: [routeConfig],
      };
    }

    // External-block metadata for the domain-grouping loop below.
    // _gateRanges = the remote_ip ranges already on the inner content route
    // (subnet from the external-exposure gate, or peer IPs from an ACL). Used
    // to hoist the gate onto the OUTER subroute match for forward-auth routes,
    // so the auth proxy is also behind the gate (else an external scanner hits
    // /route-auth/* before the gate). For non-auth routes the fold fast-path
    // already ANDs remote_ip onto the outer host match, so no hoist needed.
    const srv = caddyRoutes[route.domain];
    if (srv) {
      srv._externalBlock = buildExternalBlockHandler(route);
      srv._internalOnly = !route.external_enabled;
      srv._gateRanges = (routeConfig.match && routeConfig.match[0] && routeConfig.match[0].remote_ip && routeConfig.match[0].remote_ip.ranges) || INTERNAL_ONLY_RANGES;
      // Spec §3 (Gate-Hoisting): for an internal-only FORWARD-AUTH route the gate
      // must live ONLY on the outer subroute match, not on the inner routeConfig.
      // We captured the ranges into _gateRanges above; now drop the inner match so
      // the gate exists in exactly one place. (Non-auth routes keep their inner
      // match — the fold fast-path ANDs it onto the outer host. ACL ranges, if any,
      // were captured into _gateRanges and are re-applied on the outer match.)
      if (needsForwardAuth && srv._internalOnly && srv._externalBlock) {
        delete routeConfig.match;
      }
    }

  }

  // Build full Caddy config
  const caddyConfig = {
    admin: {
      listen: '127.0.0.1:2019',
    },
    logging: {
      logs: {
        access: {
          writer: {
            output: 'file',
            filename: '/data/caddy/access.log',
            roll_size_mb: 10,
            roll_keep: 3,
          },
          encoder: {
            format: 'filter',
            wrap: { format: 'json' },
            fields: {
              'request>uri': {
                filter: 'regexp',
                regexp: '/route-auth/share/[^/?]+',
                value: '/route-auth/share/REDACTED',
              },
            },
          },
          include: ['http.log.access'],
        },
      },
    },
    apps: {
      http: {
        servers: {},
      },
    },
  };

  // Home portal hostname — computed early so it can be included in TLS
  // automation (must be covered by the internal-CA issuer policy).
  const homeHost = `home.${config.dns.domain}`;

  // TLS email. Split domains into public-TLD (gets real ACME) and
  // internal/private suffixes (gets Caddy's internal CA). Without the
  // split a single `.test`/`.local`/`.internal` route would hammer the
  // Let's Encrypt rate-limit endpoint with retries every hour and
  // pollute acme logs.
  // homeHost is passed explicitly because it is added to caddyRoutes below,
  // AFTER this call, so it would otherwise be absent from the TLS policy.
  const tlsConfig = buildTlsAutomation([...Object.keys(caddyRoutes), homeHost], config.caddy);
  if (tlsConfig) caddyConfig.apps.tls = tlsConfig;

  // GateControl management UI route
  const baseUrl = config.app.baseUrl || '';
  try {
    const gcHost = new URL(baseUrl).hostname;
    if (gcHost && !caddyRoutes[gcHost]) {
      caddyRoutes[gcHost] = {
        listen: [':443', ':80'],
        routes: [{
          handle: [{
            handler: 'reverse_proxy',
            upstreams: [{ dial: `127.0.0.1:${config.app.port}` }],
            // Belt-and-suspenders: strip the portal identity header on the
            // management-UI vhost so it cannot be used to forge peer identity
            // even if an external request somehow reaches Node via this path.
            headers: {
              request: {
                delete: ['X-GC-Portal-Peer-IP'],
              },
            },
          }],
        }],
      };
    }
  } catch {}

  // Home portal site — internal-only reverse proxy to the local Node app.
  // SECURITY-CRITICAL: This is the trusted-IP control for the VPN landing
  // portal (Task 10). The site:
  //   • Is restricted to INTERNAL_ONLY_RANGES (VPN subnet) — never externally
  //     exposed. remote_ip match is on the real TCP source; cannot be spoofed.
  //   • Strips any client-supplied X-GC-Portal-Peer-IP (prevents header forgery).
  //   • Sets X-GC-Portal-Peer-IP from {http.request.remote.host} — the real TCP
  //     source IP, NOT from any forwarded header.
  //   • Rewrites bare / to /portal so VPN clients landing on home.<domain> see
  //     the portal immediately; asset/API paths pass through unchanged.
  if (!caddyRoutes[homeHost]) {
    caddyRoutes[homeHost] = {
      listen: [':443', ':80'],
      routes: [{
        match: [{ remote_ip: { ranges: INTERNAL_ONLY_RANGES } }],
        handle: [
          // Path-conditional rewrite: only / → /portal; other paths unchanged.
          {
            handler: 'subroute',
            routes: [{
              match: [{ path: ['/'] }],
              handle: [{ handler: 'rewrite', uri: '/portal' }],
            }],
          },
          // Reverse proxy to local Node app with trusted-IP header handling.
          {
            handler: 'reverse_proxy',
            upstreams: [{ dial: `127.0.0.1:${config.app.port}` }],
            headers: {
              request: {
                // Delete first: prevent any client-supplied copy from reaching Node.
                delete: ['X-GC-Portal-Peer-IP'],
                // Set from real TCP source — Caddy resolves this before XFF processing.
                set: { 'X-GC-Portal-Peer-IP': ['{http.request.remote.host}'] },
              },
            },
          },
        ],
      }],
    };
  }

  // Group routes into a single server
  const serverRoutes = [...serverRoutes_pending];
  for (const [domain, srvConfig] of Object.entries(caddyRoutes)) {
    const inner = srvConfig.routes.length === 1 ? srvConfig.routes[0] : null;
    // Single-domain fast path: AND the host matcher with any matcher already on
    // the inner route (remote_ip from a Peer-ACL or the external-exposure gate).
    // Matchers within ONE match object are AND-ed by Caddy, so folding them into
    // a single object yields "host X AND source IP in ranges". Without this fold
    // the host-only matcher would silently drop the ACL/gate restriction for
    // plain (non-forward-auth) single-domain routes.
    //
    // GUARD: only fold when inner.match has at most ONE object. Today inner.match
    // is always a single remote_ip object, but if any future code path ever puts
    // MULTIPLE OR'd objects on inner.match (Caddy treats sibling match objects as
    // OR), a blind Object.assign fold would collapse OR→AND (last-wins) and
    // silently DROP a matcher — a fail-OPEN security regression for the gate. In
    // that case we fall through to the subroute form below, which ANDs the outer
    // host via the subroute wrapper while preserving the inner multi-object OR
    // match untouched.
    if (inner && (!Array.isArray(inner.match) || inner.match.length <= 1)) {
      const matchObj = { host: [domain] };
      if (Array.isArray(inner.match)) {
        for (const m of inner.match) Object.assign(matchObj, m);
      }
      const entry = {
        match: [matchObj],
        handle: inner.handle,
        terminal: true,
      };
      // Propagate @id marker (used by Admin-API partial patches, Task 20).
      if (inner['@id']) entry['@id'] = inner['@id'];
      serverRoutes.push(entry);
    } else {
      // Compound route (forward-auth sibling + content) or multi-OR inner match.
      // For internal-only routes, hoist the remote_ip gate onto the OUTER host
      // match so the auth proxy is also gated (Concern 3). Non-auth routes never
      // reach here (single route → fold fast-path).
      const outerMatch = (srvConfig._internalOnly && srvConfig._externalBlock)
        ? [{ host: [domain], remote_ip: { ranges: srvConfig._gateRanges } }]
        : [{ host: [domain] }];
      serverRoutes.push({
        match: outerMatch,
        handle: [{
          handler: 'subroute',
          routes: srvConfig.routes,
        }],
        terminal: true,
      });
    }

    // Fallback (B): served to external source IPs that fell past the gated
    // route (A). Host-only match, NO @id (keeps the caddyReconciler's
    // one-gc_route_<id>-per-route invariant intact — an extra @id here would
    // cause permanent drift re-sync). Appended AFTER (A) so VPN clients match
    // (A) first and external clients fall to (B).
    if (srvConfig._externalBlock) {
      serverRoutes.push({
        match: [{ host: [domain] }],
        handle: srvConfig._externalBlock,
        terminal: true,
      });
    }
  }

  if (serverRoutes.length > 0) {
    caddyConfig.apps.http.servers.srv0 = {
      listen: [':443', ':80'],
      routes: serverRoutes,
      logs: {
        default_logger_name: 'access',
      },
      protocols: ['h1', 'h2'],
      // Trust X-Forwarded-For from RFC1918 / CGNAT / IPv6 ULA sources so
      // ip_hash and other client-IP-aware policies see the real client IP
      // when GateControl runs behind a private LB or CDN. Trust scope is
      // restricted to private ranges — direct internet clients can spoof
      // XFF freely but Caddy ignores it because the source isn't trusted.
      trusted_proxies: {
        source: 'static',
        ranges: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10', 'fd00::/8', '::1/128', '127.0.0.0/8'],
      },
      client_ip_headers: ['X-Forwarded-For'],
    };
  }

  // L4 config
  if (l4Routes.length > 0) {
    const activeL4Routes = [];
    for (const route of l4Routes) {
      // Scheduled access window — denied right now → omit the L4 listener
      // entirely (no static_response possible at layer4; the connection simply
      // is not accepted). Gated on rulesExist for the no-op no-rules case.
      if (rulesExist && require('./accessRules').isDenied('route', route.id, now)) continue;
      if (route.target_kind === 'gateway' && route.target_pool_id) {
        // Pool-aware: skip listener if pool is in outage. For load_balancing
        // mode we hand the FULL alive set + lb_policy to the L4 builder so
        // it can render multiple upstreams. Failover mode collapses to the
        // first alive (priority order).
        const resolved = resolveRouteUpstreams(route, { gatewayProxyPort });
        if (resolved.outage) continue;
        const first = resolved.peers[0];
        route.target_ip = first.ip;
        route.target_port = route.l4_listen_port;
        if (resolved.lb_policy && resolved.peers.length > 1) {
          // Stash for buildL4Route — non-DB hint, removed before persisting.
          route._poolUpstreams = resolved.peers.map(p => p.ip + ':' + route.l4_listen_port);
          route._poolLbPolicy = resolved.lb_policy;
        }
      } else if (route.peer_id && route.allowed_ips) {
        // Peer-route: upstream = peer's WG IP + route.target_port.
        route.target_ip = route.allowed_ips.split('/')[0];
      } else if (route.target_kind === 'gateway' && route.target_peer_allowed_ips) {
        // Gateway-route: upstream = gateway-peer's WG IP + l4_listen_port.
        // The gateway container runs its own TcpProxyManager bound to
        // tunnel_ip:l4_listen_port and forwards to target_lan_host:
        // target_lan_port on the LAN — so Caddy on the server just
        // needs to hand the connection to the gateway's listener.
        route.target_ip = route.target_peer_allowed_ips.split('/')[0];
        route.target_port = route.l4_listen_port;
      }
      activeL4Routes.push(route);
    }

    const conflicts = validatePortConflicts(activeL4Routes);
    if (conflicts.length > 0) {
      throw new Error('L4 port conflicts: ' + conflicts.join('; '));
    }

    if (activeL4Routes.length > 0) {
      caddyConfig.apps.layer4 = {
        servers: buildL4Servers(activeL4Routes, INTERNAL_ONLY_RANGES),
      };
    }
  }

  return caddyConfig;
}

// ─── Push config to Caddy Admin API ─────────────────────
let lastGoodConfig = null;

// Serialize all Caddy syncs through one promise chain so concurrent callers
// (CRUD's withCaddySync, the access reconciler's requestCaddySync, the
// monitor's coalesced sync) run one at a time — no overlapping POST /load, no
// stale-previousConfig clobber. Mirrors peers.js:_wgRewriteChain.
let _syncChain = Promise.resolve();
function syncToCaddy() {
  _syncChain = _syncChain.then(_syncToCaddyInner, _syncToCaddyInner);
  return _syncChain;
}

async function _syncToCaddyInner() {
  // Production-safety: skip sync in test env. caddyAdminClient's
  // caddyApi() also guards individually, but skipping the whole sync
  // here avoids even building the config and spares test runs from
  // uninterruptible "Caddy not reachable" throws downstream.
  if (process.env.NODE_ENV === 'test') return;

  let previousConfig = null;
  try {
    previousConfig = await caddyApi('/config/');
  } catch {}

  const caddyConfig = buildCaddyConfig();

  // 1. Persist runtime.json FIRST so a Caddy restart always recovers
  //    the latest intended config even if /load corrupts live state.
  _persistRuntimeJson(caddyConfig);

  // 2. Fast path: live config update via /load (no downtime when it works).
  const result = await caddyApi('/load', {
    method: 'POST',
    body: JSON.stringify(caddyConfig),
  });

  if (result === null) {
    throw new Error('Caddy admin API is not reachable — route saved but not deployed. Restart Caddy or retry later.');
  }

  try {
    const check = await caddyApi('/config/');
    if (!check) throw new Error('Config verification failed');

    // 3. Real TLS self-test — admin API answering is not enough. Caddy
    //    can accept /load and still reject every TLS handshake with
    //    `internal error` after a bad listener transition. Detect that
    //    and automatically restart Caddy so it reloads the runtime.json
    //    we just wrote, with a clean TLS state.
    const sni = _managementHost(caddyConfig);
    if (sni) {
      const tlsOk = await _verifyLocalTls(sni);
      if (!tlsOk) {
        logger.warn({ sni }, 'Caddy /load succeeded but local TLS handshake fails — restarting Caddy');
        try {
          await _restartCaddyViaSupervisor();
          await new Promise((r) => setTimeout(r, 3000));
          logger.info('Caddy restarted — serving from runtime.json');
        } catch (restartErr) {
          logger.error({ err: restartErr.message }, 'Automatic Caddy restart failed — manual `docker compose restart` required');
        }
      }
    }

    lastGoodConfig = caddyConfig;
    logger.info('Caddy config synced and verified');
  } catch (verifyErr) {
    logger.error({ error: verifyErr.message }, 'Caddy config verification failed — rolling back');
    if (previousConfig) {
      try {
        await caddyApi('/load', {
          method: 'POST',
          body: JSON.stringify(previousConfig),
        });
        logger.info('Caddy config rolled back to previous state');
      } catch (rollbackErr) {
        logger.error({ error: rollbackErr.message }, 'Caddy rollback also failed');
      }
    }
    throw verifyErr;
  }

  return true;
}

module.exports = {
  caddyApi,
  buildCaddyConfig,
  syncToCaddy,
  getAclPeers,
  setAclPeers,
  patchGatewayRouteHandlers,
  _caddyApi,
  renderMaintenancePage,
  resolveRouteUpstreams,
  buildPoolOutageBlock,
};

module.exports.__test = Object.assign({}, module.exports.__test, { buildExternalBlockHandler });
