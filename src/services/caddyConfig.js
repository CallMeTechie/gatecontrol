'use strict';

/**
 * Caddy JSON config builder and sync.
 *
 * Extracted from routes.js to keep that module focused on CRUD.
 * Contains: buildCaddyConfig(), syncToCaddy(), caddyApi(), and the
 * validation/sanitization helpers used exclusively during config generation.
 */

const { getDb } = require('../db/connection');
const config = require('../../config/default');
const { buildL4Servers, validatePortConflicts } = require('./l4');
const { getAuthForRoute } = require('./routeAuth');
const logger = require('../utils/logger');
const nunjucks = require('nunjucks');
const nodePath = require('node:path');

// Static list of caddy-defender bot provider ranges used by this project.
// Extracted from the two inline builders so adding/removing a provider is
// a single-point change. Override via GC_BOT_BLOCKER_RANGES (comma list).
const DEFAULT_BOT_BLOCKER_RANGES = Object.freeze([
  'openai', 'aws', 'gcloud', 'githubcopilot', 'deepseek', 'azurepubliccloud',
]);
const BOT_BLOCKER_RANGES = Object.freeze(
  (process.env.GC_BOT_BLOCKER_RANGES || '').split(',').map(s => s.trim()).filter(Boolean).length > 0
    ? process.env.GC_BOT_BLOCKER_RANGES.split(',').map(s => s.trim()).filter(Boolean)
    : DEFAULT_BOT_BLOCKER_RANGES
);

// Escape user-supplied strings that land in Caddy response bodies so they
// cannot inject HTML into the error page served to blocked bots/humans.
function escapeHtmlForDefender(str) {
  if (typeof str !== 'string') return str;
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildDefenderConfig(route) {
  const defenderConfig = {
    handler: 'defender',
    raw_responder: route.bot_blocker_mode || 'block',
    ranges: [...BOT_BLOCKER_RANGES],
  };
  const bbConfig = (route.bot_blocker_config ? JSON.parse(route.bot_blocker_config) : null) || {};
  if (bbConfig.message) defenderConfig.message = escapeHtmlForDefender(String(bbConfig.message));
  if (bbConfig.status_code) defenderConfig.status_code = bbConfig.status_code;
  if (bbConfig.url) defenderConfig.url = bbConfig.url;
  return defenderConfig;
}

/**
 * Parse the comma-separated status code list that the UI stores in
 * route.retry_match_status (e.g. "502,503,504"). Dropped silently: non-
 * numeric tokens, codes outside the standard HTTP range. Returns a de-
 * duplicated number array.
 */
function parseStatusCodes(csv) {
  if (!csv || typeof csv !== 'string') return [];
  const seen = new Set();
  const out = [];
  for (const token of csv.split(',')) {
    const n = parseInt(token.trim(), 10);
    if (!Number.isInteger(n) || n < 100 || n > 599) continue;
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

/**
 * Render the gateway-offline maintenance page. Nunjucks-based so i18n-keys
 * are picked up via the `t()` helper. Uses a fallback key-lookup if no
 * request-scoped t() is available (standalone render from caddyConfig builder).
 */
function renderMaintenancePage(ctx) {
  const tmplDir = nodePath.join(__dirname, '..', '..', 'templates');
  const env = nunjucks.configure(tmplDir, { autoescape: true, noCache: false });
  // Provide a default `t()` helper that returns the raw key — the gateway-
  // offline page is rendered server-side at config-build time (no request).
  env.addGlobal('t', (key) => key);
  return env.render('gateway-offline.njk', { lang: 'de', ...ctx });
}

const CADDY_ADMIN = config.caddy.adminUrl;

// ─── Header / config injection prevention ────────────────
const HEADER_NAME_RE = /^[a-zA-Z0-9\-]+$/;
const CADDY_PLACEHOLDER_RE = /\{[^}]+\}/;
const VALID_RATE_WINDOWS = ['1s', '1m', '5m', '1h'];
const STICKY_COOKIE_NAME_RE = /^[a-zA-Z0-9_\-]+$/;

function isValidHeaderName(name) {
  return typeof name === 'string' && name.length <= 256 && HEADER_NAME_RE.test(name);
}

function isValidHeaderValue(value) {
  return typeof value === 'string' && value.length <= 4096 && !CADDY_PLACEHOLDER_RE.test(value);
}

function sanitizeRateWindow(window) {
  return VALID_RATE_WINDOWS.includes(window) ? window : '1m';
}

function sanitizeStickyCookieName(name) {
  return (typeof name === 'string' && STICKY_COOKIE_NAME_RE.test(name)) ? name : 'gc_sticky';
}

// ─── ACL helpers ────────────────────────────────────────
function getAclPeers(routeId) {
  const db = getDb();
  return db.prepare(`
    SELECT rpa.peer_id, p.name, p.allowed_ips
    FROM route_peer_acl rpa
    JOIN peers p ON p.id = rpa.peer_id
    WHERE rpa.route_id = ?
  `).all(routeId);
}

function setAclPeers(routeId, peerIds) {
  const db = getDb();
  db.prepare('DELETE FROM route_peer_acl WHERE route_id = ?').run(routeId);
  if (Array.isArray(peerIds) && peerIds.length > 0) {
    const insert = db.prepare('INSERT OR IGNORE INTO route_peer_acl (route_id, peer_id) VALUES (?, ?)');
    for (const peerId of peerIds) {
      insert.run(routeId, peerId);
    }
  }
}

// ─── Caddy Admin API helper ─────────────────────────────
async function caddyApi(path, options = {}) {
  // Production-safety: in NODE_ENV=test, never open a real HTTP connection
  // to the Caddy admin API. The container uses network_mode: host, so
  // 127.0.0.1:2019 from a host-side test process is the LIVE Caddy and
  // would get overwritten with test-seeded routes. Return null to mimic
  // the existing ECONNREFUSED fallback branch — callers already handle that.
  if (process.env.NODE_ENV === 'test') return null;

  const url = `${CADDY_ADMIN}${path}`;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(config.timeouts.caddyApi),
      ...options,
      headers: { 'Content-Type': 'application/json', 'Origin': 'http://127.0.0.1:2019', ...options.headers },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Caddy API ${res.status}: ${text}`);
    }
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  } catch (err) {
    if (err.cause && err.cause.code === 'ECONNREFUSED') {
      logger.warn('Caddy admin API not reachable');
      return null;
    }
    throw err;
  }
}

// ─── Build Caddy JSON config from all enabled routes ────
/**
 * Build Caddy configuration JSON. Overloaded:
 *   buildCaddyConfig()                   → Query routes from DB
 *   buildCaddyConfig(routes, options)    → Use provided routes (for tests)
 */
function buildCaddyConfig(injectedRoutes, options = {}) {
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

  for (const route of httpRoutes) {
    // Determine target IP: if linked to a peer, use peer's WG IP; otherwise use target_ip
    let targetIp = route.target_ip;
    if (route.peer_id && route.allowed_ips) {
      targetIp = route.allowed_ips.split('/')[0];
    }

    // Parse backends for load balancing — resolve peer IPs from peer_id
    let backends = null;
    if (route.backends) {
      try {
        const rawBackends = JSON.parse(route.backends);
        if (Array.isArray(rawBackends)) {
          backends = rawBackends.map(b => {
            if (!b.peer_id) return null;
            const bPeer = db.prepare('SELECT allowed_ips, enabled FROM peers WHERE id = ?').get(b.peer_id);
            if (!bPeer || !bPeer.enabled) return null;
            return { ip: bPeer.allowed_ips.split('/')[0], port: b.port, weight: b.weight || 1 };
          }).filter(Boolean);
        }
      } catch {}
    }
    const hasMultipleBackends = Array.isArray(backends) && backends.length > 0;

    // Determine gateway-target peer IP (for target_kind='gateway' routes)
    let gatewayPeerIp = null;
    if (route.target_kind === 'gateway') {
      if (route.target_peer_ip) {
        gatewayPeerIp = route.target_peer_ip;
      } else if (route.target_peer_allowed_ips) {
        gatewayPeerIp = route.target_peer_allowed_ips.split('/')[0];
      }
    }

    let upstreams;
    if (gatewayPeerIp) {
      // Route through gateway: upstream = gateway-tunnel-IP:proxy-port
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
        && gatewayPeerIp && (route.target_lan_host || route.target_lan_port)) {
      const lanTarget = `${route.target_lan_host}:${route.target_lan_port}`;
      reverseProxy.headers.request.set = {
        ...(reverseProxy.headers.request.set || {}),
        'X-Gateway-Target': [lanTarget],
        'X-Gateway-Target-Domain': [route.domain],
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

    // Retry configuration.
    //
    // Caddy's reverse_proxy retries only within `try_duration` and only for
    // responses matching `retry_match` (or connect errors by default). Prior
    // code set `retries` alone — which Caddy ignores unless try_duration is
    // positive and something in retry_match triggers — so the admin-set
    // status codes in route.retry_match_status never made it into the
    // actual config. Wire both fields through.
    if (route.retry_enabled) {
      if (!reverseProxy.load_balancing) reverseProxy.load_balancing = {};
      const retryCount = route.retry_count || 3;
      reverseProxy.load_balancing.retries = retryCount;
      // try_duration bounds the retry loop; a fixed 5s silently caps
      // high retry_count values (a slow upstream burns the whole budget
      // in a few attempts). Scale with the admin's configured count.
      reverseProxy.load_balancing.try_duration = `${Math.max(5, retryCount * 2)}s`;
      const codes = parseStatusCodes(route.retry_match_status);
      if (codes.length > 0) {
        reverseProxy.load_balancing.retry_match = [{ status_code: codes }];
      }
    }

    // Response custom headers
    if (customHeaders && Array.isArray(customHeaders.response) && customHeaders.response.length > 0) {
      const responseSet = {};
      for (const h of customHeaders.response) {
        if (h.name && h.value && isValidHeaderName(h.name) && isValidHeaderValue(h.value)) {
          responseSet[h.name] = [h.value];
        }
      }
      if (Object.keys(responseSet).length > 0) {
        reverseProxy.headers = { response: { set: responseSet } };
      }
    }

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
      const routeConfig503 = {
        handle: [{
          handler: 'static_response',
          status_code: '503',
          body: 'Service temporarily unavailable',
          headers: { 'Retry-After': [String(route.circuit_breaker_timeout || 30)] },
        }],
      };
      caddyRoutes[route.domain] = {
        listen: route.https_enabled ? [':443'] : [':80'],
        routes: [routeConfig503],
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
    if (customHeaders && Array.isArray(customHeaders.request) && customHeaders.request.length > 0) {
      const requestSet = {};
      for (const h of customHeaders.request) {
        if (h.name && h.value && isValidHeaderName(h.name) && isValidHeaderValue(h.value)) {
          requestSet[h.name] = [h.value];
        }
      }
      if (Object.keys(requestSet).length > 0) {
        routeHandlers.push({
          handler: 'headers',
          request: { set: requestSet },
        });
      }
    }

    // Rate limiting
    if (route.rate_limit_enabled) {
      routeHandlers.push({
        handler: 'rate_limit',
        rate_limits: {
          static: {
            key: '{http.request.remote.host}',
            window: sanitizeRateWindow(route.rate_limit_window),
            max_events: route.rate_limit_requests || 100,
          },
        },
      });
    }

    // Request mirroring
    if (mirrorTargets && Array.isArray(mirrorTargets) && mirrorTargets.length > 0) {
      routeHandlers.push({
        handler: 'mirror',
        targets: mirrorTargets.map(t => ({ dial: `${t.ip}:${t.port}` })),
      });
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
      const routeAuthProxy = {
        // Only intercept /route-auth/* (covers the login page and its
        // assets under /route-auth/static/*). Previously /css/*, /js/*,
        // /fonts/*, /branding/* were also intercepted so the login
        // template could load its own stylesheet/script — but those
        // paths collide with the upstream's own assets, so after login
        // the upstream's /js/jquery.js etc. got routed to our Node and
        // returned as 404 HTML, breaking every legacy web interface
        // (Speedport, TR-064, older Synology panels…).
        match: [{ path: ['/route-auth/*'] }],
        handle: [{
          handler: 'reverse_proxy',
          upstreams: [{ dial: '127.0.0.1:3000' }],
        }],
      };

      const forwardAuthSubrequest = {
        handler: 'reverse_proxy',
        upstreams: [{ dial: '127.0.0.1:3000' }],
        rewrite: { method: 'GET', uri: '/route-auth/verify' },
        headers: {
          request: {
            set: {
              'X-Route-Domain': [route.domain],
              'X-Forwarded-Method': ['{http.request.method}'],
              'X-Forwarded-Uri': ['{http.request.uri}'],
            },
          },
        },
        handle_response: [
          {
            match: { status_code: [2] },
            routes: [{ handle: [{ handler: 'vars' }] }],
          },
          {
            routes: [{
              handle: [{
                handler: 'static_response',
                status_code: 302,
                headers: {
                  'Location': [`/route-auth/login?route=${route.domain}&redirect={http.request.uri}`],
                },
              }],
            }],
          },
        ],
      };

      const authHandlers = [forwardAuthSubrequest];
      if (route.debug_enabled) {
        authHandlers.unshift({
          handler: 'trace',
          tag: `route-${route.id}`,
          response_debug_enabled: true,
        });
      }
      if (route.bot_blocker_enabled) {
        authHandlers.unshift(buildDefenderConfig(route));
      }
      if (customHeaders && Array.isArray(customHeaders.request) && customHeaders.request.length > 0) {
        const requestSet = {};
        for (const h of customHeaders.request) {
          if (h.name && h.value && isValidHeaderName(h.name) && isValidHeaderValue(h.value)) {
            requestSet[h.name] = [h.value];
          }
        }
        if (Object.keys(requestSet).length > 0) {
          authHandlers.push({
            handler: 'headers',
            request: { set: requestSet },
          });
        }
      }
      if (route.rate_limit_enabled) {
        authHandlers.push({
          handler: 'rate_limit',
          rate_limits: {
            static: {
              key: '{http.request.remote.host}',
              window: sanitizeRateWindow(route.rate_limit_window),
              max_events: route.rate_limit_requests || 100,
            },
          },
        });
      }
      if (mirrorTargets && Array.isArray(mirrorTargets) && mirrorTargets.length > 0) {
        authHandlers.push({
          handler: 'mirror',
          targets: mirrorTargets.map(t => ({ dial: `${t.ip}:${t.port}` })),
        });
      }
      if (route.compress_enabled) {
        authHandlers.push({ handler: 'encode', encodings: { zstd: {}, brotli: {}, gzip: {} } });
      }
      authHandlers.push(reverseProxy);
      routeConfig.handle = authHandlers;

      caddyRoutes[route.domain] = {
        listen: route.https_enabled ? [':443'] : [':80'],
        routes: [routeAuthProxy, routeConfig],
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
  const NON_PUBLIC_TLDS = new Set(['test', 'local', 'invalid', 'internal', 'lan', 'home', 'localhost', 'corp']);
  function isPublicDomain(d) {
    if (!d) return false;
    const parts = String(d).toLowerCase().split('.');
    const tld = parts[parts.length - 1];
    return !NON_PUBLIC_TLDS.has(tld);
  }
  const allDomains = Object.keys(caddyRoutes).filter(d => !/^:\d+$/.test(d));
  const publicDomains = allDomains.filter(isPublicDomain);
  const privateDomains = allDomains.filter(d => !isPublicDomain(d));
  if (config.caddy.email) {
    caddyConfig.apps.tls = {
      automation: {
        policies: [],
      },
    };
    if (publicDomains.length > 0) {
      const acmePolicy = {
        subjects: publicDomains,
        issuers: [{ module: 'acme', email: config.caddy.email }],
      };
      if (config.caddy.acmeCa) acmePolicy.issuers[0].ca = config.caddy.acmeCa;
      caddyConfig.apps.tls.automation.policies.push(acmePolicy);
    }
    if (privateDomains.length > 0) {
      caddyConfig.apps.tls.automation.policies.push({
        subjects: privateDomains,
        issuers: [{ module: 'internal' }],
      });
    }
    if (caddyConfig.apps.tls.automation.policies.length === 0) {
      // Keep the previous catch-all so new routes created before the
      // next buildCaddyConfig still get a certificate attempt.
      const fallback = { issuers: [{ module: 'acme', email: config.caddy.email }] };
      if (config.caddy.acmeCa) fallback.issuers[0].ca = config.caddy.acmeCa;
      caddyConfig.apps.tls.automation.policies.push(fallback);
    }
  }

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
  const serverRoutes = [];
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
    for (const route of l4Routes) {
      if (route.peer_id && route.allowed_ips) {
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
    }

    const conflicts = validatePortConflicts(l4Routes);
    if (conflicts.length > 0) {
      throw new Error('L4 port conflicts: ' + conflicts.join('; '));
    }

    caddyConfig.apps.layer4 = {
      servers: buildL4Servers(l4Routes),
    };
  }

  return caddyConfig;
}

// ─── Push config to Caddy Admin API ─────────────────────
let lastGoodConfig = null;

const RUNTIME_JSON_PATH = (config.caddy && config.caddy.dataDir
  ? config.caddy.dataDir
  : '/data/caddy') + '/runtime.json';

// Write the generated Caddy config to /data/caddy/runtime.json atomically.
// This file is the source-of-truth that entrypoint.sh boots Caddy from
// (variant C) and that a runtime restart falls back to if /load leaves
// Caddy in a bad state.
function _persistRuntimeJson(caddyConfig) {
  const fs = require('node:fs');
  const path = require('node:path');
  const tmp = RUNTIME_JSON_PATH + '.tmp';
  try {
    fs.mkdirSync(path.dirname(RUNTIME_JSON_PATH), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(caddyConfig, null, 2));
    fs.renameSync(tmp, RUNTIME_JSON_PATH);
    return true;
  } catch (err) {
    logger.warn({ err: err.message, path: RUNTIME_JSON_PATH }, 'Could not persist runtime.json (not fatal)');
    return false;
  }
}

// Quick TLS-handshake self-test against 127.0.0.1:443 with the given SNI.
// POST /load occasionally leaves Caddy in a state where it answers the
// admin API but kills every new TLS handshake with `internal error`.
function _verifyLocalTls(sniHost, timeoutMs = 4000) {
  const tls = require('node:tls');
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok) => { if (!settled) { settled = true; resolve(ok); } };
    const socket = tls.connect({
      host: '127.0.0.1',
      port: 443,
      servername: sniHost,
      rejectUnauthorized: false,
      timeout: timeoutMs,
      ALPNProtocols: ['http/1.1'],
    });
    socket.once('secureConnect', () => { socket.end(); done(true); });
    socket.once('error', () => done(false));
    socket.once('timeout', () => { socket.destroy(); done(false); });
  });
}

// Kill the Caddy process so supervisord's autorestart brings it back
// from scratch. Caddy boots from runtime.json (which we just wrote),
// giving it a clean TLS state and re-triggering cert provisioning for
// any new hosts. Brief downtime (~2–3 s) but recovers.
// Uses execFile with fixed argv — no shell, no injection surface.
// (Avoids supervisorctl because Alpine's supervisor package doesn't
// ship the RPC interface module we'd need for it.)
function _restartCaddyViaSupervisor() {
  const { execFile } = require('node:child_process');
  return new Promise((resolve, reject) => {
    execFile('pkill', ['-TERM', '-x', 'caddy'], { timeout: 10000 }, (err, stdout, stderr) => {
      // pkill exit code 1 = no process matched (Caddy not running); still a
      // success for our purposes because supervisord will spawn it shortly.
      if (err && err.code !== 1) {
        return reject(new Error(`pkill caddy failed: ${err.message} ${stderr || ''}`.trim()));
      }
      resolve(stdout);
    });
  });
}

// The management UI domain is the canary for TLS health — it has a
// provisioned cert from day one, so a failed TLS handshake against it
// means Caddy's listener state is broken (not just "cert still
// provisioning for a new subdomain"). Prefer GC_BASE_URL's hostname;
// fall back to the first route's first host.
function _managementHost(caddyConfig) {
  try {
    const baseUrl = config.app && config.app.baseUrl;
    if (baseUrl) {
      try {
        const host = new URL(baseUrl).hostname;
        if (host) return host;
      } catch { /* fall through */ }
    }
    const srv = caddyConfig && caddyConfig.apps && caddyConfig.apps.http
      && caddyConfig.apps.http.servers && caddyConfig.apps.http.servers.srv0;
    const hosts = srv && srv.routes && srv.routes[0] && srv.routes[0].match
      && srv.routes[0].match[0] && srv.routes[0].match[0].host;
    return Array.isArray(hosts) && hosts.length > 0 ? hosts[0] : null;
  } catch { return null; }
}

async function syncToCaddy() {
  // Production-safety: skip the whole sync in test env. Returning early
  // keeps routes.create/update from throwing "Caddy not reachable" in
  // tests while guaranteeing no HTTP ever touches the real admin API.
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

// ─── Gateway-aware partial patching of Caddy Admin API ──────
// Uses @id route markers (added in Task 18) so status transitions can be
// applied without a full config reload — PATCH /id/gc_route_<id>/handle.

const _caddyApi = {
  async patch(patchPath, body) {
    // Same production-safety guard as caddyApi() — see that comment.
    if (process.env.NODE_ENV === 'test') return;

    const http = require('node:http');
    return new Promise((resolve, reject) => {
      const url = new URL((process.env.GC_CADDY_ADMIN_URL || config.caddy.adminUrl || 'http://127.0.0.1:2019') + patchPath);
      const payload = body === null || body === undefined ? '' : (typeof body === 'string' ? body : JSON.stringify(body));
      const req = http.request({
        host: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'Origin': 'http://127.0.0.1:2019',
        },
      }, (res) => {
        res.resume();
        res.on('end', resolve);
      });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  },
};

async function patchGatewayRouteHandlers({ peerId, offline, gatewayName, lastSeen }) {
  const db = getDb();
  const routes = db.prepare(`
    SELECT id, domain FROM routes
    WHERE target_peer_id = ? AND target_kind = 'gateway' AND enabled = 1
  `).all(peerId);

  for (const route of routes) {
    const routeId = `gc_route_${route.id}`;
    const handler = offline
      ? {
          handler: 'static_response',
          status_code: 502,
          headers: { 'Content-Type': ['text/html; charset=utf-8'] },
          body: renderMaintenancePage({ gateway_name: gatewayName, gateway_last_seen: lastSeen }),
        }
      : null;

    try {
      // Standard pattern: PATCH /id/gc_route_<id>/handle
      await module.exports._caddyApi.patch(`/id/${routeId}/handle`, handler || 'revert');
    } catch (err) {
      logger.warn({ err: err.message, routeId }, 'Caddy partial patch failed');
    }
  }
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
};
