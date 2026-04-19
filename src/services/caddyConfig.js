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

    // Parse mirror targets — resolve peer IPs from peer_id
    let mirrorTargets = null;
    if (route.mirror_enabled && route.mirror_targets) {
      try {
        const rawMirrorTargets = JSON.parse(route.mirror_targets);
        if (Array.isArray(rawMirrorTargets)) {
          mirrorTargets = rawMirrorTargets.map(t => {
            if (!t.peer_id) return null;
            const mirrorPeer = db.prepare('SELECT allowed_ips, enabled FROM peers WHERE id = ?').get(t.peer_id);
            if (!mirrorPeer || !mirrorPeer.enabled) return null;
            return { ip: mirrorPeer.allowed_ips.split('/')[0], port: t.port };
          }).filter(Boolean);
        }
      } catch {}
    }

    const reverseProxy = {
      handler: 'reverse_proxy',
      upstreams,
    };

    // Gateway-routing: inject X-Gateway-Target and X-Gateway-Target-Domain headers
    // so the Gateway-HTTP-Proxy knows the LAN target to forward to.
    if (gatewayPeerIp && (route.target_lan_host || route.target_lan_port)) {
      const lanTarget = `${route.target_lan_host}:${route.target_lan_port}`;
      reverseProxy.headers = reverseProxy.headers || {};
      reverseProxy.headers.request = reverseProxy.headers.request || {};
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

    // Retry configuration
    if (route.retry_enabled) {
      if (!reverseProxy.load_balancing) reverseProxy.load_balancing = {};
      reverseProxy.load_balancing.retries = route.retry_count || 3;
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

    // Backend HTTPS with insecure_skip_verify
    if (route.backend_https) {
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
      const defenderConfig = {
        handler: 'defender',
        raw_responder: route.bot_blocker_mode || 'block',
        ranges: ['openai', 'aws', 'gcloud', 'githubcopilot', 'deepseek', 'azurepubliccloud'],
      };
      const bbConfig = (route.bot_blocker_config ? JSON.parse(route.bot_blocker_config) : null) || {};
      if (bbConfig.message) defenderConfig.message = bbConfig.message;
      if (bbConfig.status_code) defenderConfig.status_code = bbConfig.status_code;
      if (bbConfig.url) defenderConfig.url = bbConfig.url;
      routeHandlers.push(defenderConfig);
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
        match: [{ path: ['/route-auth/*', '/css/*', '/js/*', '/fonts/*', '/branding/*'] }],
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
        const defenderConfig = {
          handler: 'defender',
          raw_responder: route.bot_blocker_mode || 'block',
          ranges: ['openai', 'aws', 'gcloud', 'githubcopilot', 'deepseek', 'azurepubliccloud'],
        };
        const bbConfig = (route.bot_blocker_config ? JSON.parse(route.bot_blocker_config) : null) || {};
        if (bbConfig.message) defenderConfig.message = bbConfig.message;
        if (bbConfig.status_code) defenderConfig.status_code = bbConfig.status_code;
        if (bbConfig.url) defenderConfig.url = bbConfig.url;
        authHandlers.unshift(defenderConfig);
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

  // TLS email
  if (config.caddy.email) {
    caddyConfig.apps.tls = {
      automation: {
        policies: [
          {
            issuers: [
              {
                module: 'acme',
                email: config.caddy.email,
              },
            ],
          },
        ],
      },
    };
    if (config.caddy.acmeCa) {
      caddyConfig.apps.tls.automation.policies[0].issuers[0].ca = config.caddy.acmeCa;
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
        route.target_ip = route.allowed_ips.split('/')[0];
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

async function syncToCaddy() {
  let previousConfig = null;
  try {
    previousConfig = await caddyApi('/config/');
  } catch {}

  const caddyConfig = buildCaddyConfig();

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
};
