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
const gatewayHealth = require('./gatewayHealth');

function _peerIp(allowedIps) {
  return (allowedIps || '').split('/')[0].split(',')[0].trim();
}

function resolveRouteUpstreams(route, options = {}) {
  const db = require('../db/connection').getDb();
  const snapshot = gatewayHealth.getSnapshot();
  const proxyPort = options.gatewayProxyPort || 8080;

  if (route.target_pool_id) {
    const pool = gatewayPool.getPool(route.target_pool_id);
    if (!pool || !pool.enabled) return { peers: [], outage: true };
    const peerIds = pool.mode === 'failover'
      ? (() => { const id = gatewayPool.resolveActivePeer(route.target_pool_id, snapshot); return id ? [id] : []; })()
      : gatewayPool.resolveActivePeers(route.target_pool_id, snapshot);
    if (peerIds.length === 0) return { peers: [], outage: true };
    const peers = peerIds.map(id => db.prepare('SELECT id, allowed_ips FROM peers WHERE id = ?').get(id));
    return {
      peers: peers.map(p => ({ id: p.id, ip: _peerIp(p.allowed_ips), port: proxyPort })),
      outage: false,
      lb_policy: pool.mode === 'load_balancing' ? pool.lb_policy : null,
      pool,
    };
  }

  if (route.target_peer_id) {
    // Pin-route: use target_peer_allowed_ips from JOIN if available, else query DB
    const allowedIps = route.target_peer_allowed_ips
      || (() => {
        const peer = db.prepare('SELECT id, allowed_ips FROM peers WHERE id = ?').get(route.target_peer_id);
        return peer ? peer.allowed_ips : null;
      })();
    if (!allowedIps) return { peers: [], outage: true };
    return {
      peers: [{ id: route.target_peer_id, ip: _peerIp(allowedIps), port: proxyPort }],
      outage: false,
      lb_policy: null,
    };
  }

  return { peers: [], outage: true };
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
           gp.allowed_ips AS target_peer_allowed_ips, gp.name AS target_peer_name
    FROM routes r
    LEFT JOIN peers p ON r.peer_id = p.id
    LEFT JOIN peers gp ON gp.id = r.target_peer_id
    WHERE r.enabled = 1
  `).all();

  const httpRoutes = routes.filter(r => r.route_type !== 'l4');
  const l4Routes = routes.filter(r => r.route_type === 'l4');

  const caddyRoutes = {};
  // Pre-assembled route entries (e.g. pool-outage 503 blocks) that bypass
  // the caddyRoutes dict and are merged directly into serverRoutes.
  const serverRoutes_pending = [];

  for (const route of httpRoutes) {
    // Determine target IP: if linked to a peer, use peer's WG IP; otherwise use target_ip
    let targetIp = route.target_ip;
    if (route.peer_id && route.allowed_ips) {
      targetIp = route.allowed_ips.split('/')[0];
    }

    // Parse backends for load balancing — resolve peer IPs from peer_id
    const backends = resolveBackends(db, route);
    const hasMultipleBackends = Array.isArray(backends) && backends.length > 0;

    // Determine gateway-target peer IP (for target_kind='gateway' routes)
    // Pool-routes (target_pool_id) are resolved via resolveRouteUpstreams;
    // pin-routes (target_peer_id) fall back to the existing JOIN columns.
    let gatewayPeerIp = null;
    let poolUpstreams = null; // set when target_pool_id is present
    if (route.target_kind === 'gateway') {
      if (route.target_pool_id) {
        // Pool-aware resolution — may result in outage block
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

    let upstreams;
    if (poolUpstreams) {
      // Pool route: upstreams already resolved
      upstreams = poolUpstreams.peers.map(p => ({ dial: `${p.ip}:${p.port}` }));
    } else if (gatewayPeerIp) {
      // Pin-route through gateway: upstream = gateway-tunnel-IP:proxy-port
      upstreams = [{ dial: `${gatewayPeerIp}:${gatewayProxyPort}` }];
    } else if (hasMultipleBackends) {
      upstreams = backends.map(b => ({ dial: `${b.ip}:${b.port}` }));
    } else {
      const upstream = `${targetIp}:${route.target_port}`;
      upstreams = [{ dial: upstream }];
    }

    // Parse custom headers
    let customHeaders = null;
    if (route.custom_headers) {
      try { customHeaders = JSON.parse(route.custom_headers); } catch {}
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
      } catch {}
    }

    // Gateway-offline: serve maintenance page instead of proxying
    let reverseProxy;
    if (route.target_kind === 'gateway' && route.gateway_offline) {
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
      const lanTarget = `${route.target_lan_host}:${route.target_lan_port}`;
      reverseProxy.headers.request.set = {
        ...(reverseProxy.headers.request.set || {}),
        'X-Gateway-Target': [lanTarget],
        'X-Gateway-Target-Domain': [route.domain],
      };
    }

    // Pool load balancing policy
    if (poolUpstreams?.lb_policy) {
      reverseProxy.load_balancing = {
        selection_policy: { policy: poolUpstreams.lb_policy },
      };
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
          encoder: { format: 'json' },
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

  // TLS email. Split domains into public-TLD (gets real ACME) and
  // internal/private suffixes (gets Caddy's internal CA). Without the
  // split a single `.test`/`.local`/`.internal` route would hammer the
  // Let's Encrypt rate-limit endpoint with retries every hour and
  // pollute acme logs.
  const tlsConfig = buildTlsAutomation(Object.keys(caddyRoutes), config.caddy);
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
          }],
        }],
      };
    }
  } catch {}

  // Group routes into a single server
  const serverRoutes = [...serverRoutes_pending];
  for (const [domain, srvConfig] of Object.entries(caddyRoutes)) {
    if (srvConfig.routes.length === 1) {
      const inner = srvConfig.routes[0];
      const entry = {
        match: [{ host: [domain] }],
        handle: inner.handle,
        terminal: true,
      };
      // Propagate @id marker (used by Admin-API partial patches, Task 20).
      if (inner['@id']) entry['@id'] = inner['@id'];
      serverRoutes.push(entry);
    } else {
      // For compound routes, preserve inner @id markers inside subroute
      serverRoutes.push({
        match: [{ host: [domain] }],
        handle: [{
          handler: 'subroute',
          routes: srvConfig.routes,
        }],
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
    };
  }

  // L4 config
  if (l4Routes.length > 0) {
    const activeL4Routes = [];
    for (const route of l4Routes) {
      if (route.target_kind === 'gateway' && route.target_pool_id) {
        // Pool-aware: skip listener if pool is in outage
        const resolved = resolveRouteUpstreams(route, { gatewayProxyPort });
        if (resolved.outage) continue;
        // Use first resolved peer for L4 (single upstream for TCP proxy)
        const first = resolved.peers[0];
        route.target_ip = first.ip;
        route.target_port = route.l4_listen_port;
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
        servers: buildL4Servers(activeL4Routes),
      };
    }
  }

  return caddyConfig;
}

// ─── Push config to Caddy Admin API ─────────────────────
let lastGoodConfig = null;

async function syncToCaddy() {
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
