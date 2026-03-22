'use strict';

const { getDb } = require('../db/connection');
const config = require('../../config/default');
const { validateDomain, validatePort, validateDescription, validateBasicAuthUser, validateBasicAuthPassword, validateIp, sanitize, validateL4Protocol, validateL4ListenPort, validateL4TlsMode, isPortBlocked, parsePortRange } = require('../utils/validate');
const bcrypt = require('bcryptjs');
const { buildL4Servers, validatePortConflicts } = require('./l4');
const { getAuthForRoute } = require('./routeAuth');
const activity = require('./activity');
const logger = require('../utils/logger');

const CADDY_ADMIN = config.caddy.adminUrl;

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

// ─── Build Caddy JSON config from all enabled routes ────
function buildCaddyConfig() {
  const db = getDb();
  const routes = db.prepare(`
    SELECT r.*, p.allowed_ips, p.name AS peer_name
    FROM routes r
    LEFT JOIN peers p ON r.peer_id = p.id
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

    // Parse backends for load balancing
    let backends = null;
    if (route.backends) {
      try { backends = JSON.parse(route.backends); } catch {}
    }
    const hasMultipleBackends = Array.isArray(backends) && backends.length > 0;

    let upstreams;
    if (hasMultipleBackends) {
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

    const reverseProxy = {
      handler: 'reverse_proxy',
      upstreams,
    };

    // Load balancing policy (only for multiple backends)
    if (hasMultipleBackends) {
      if (route.sticky_enabled) {
        // Sticky sessions replace load balancing policy with cookie affinity
        reverseProxy.load_balancing = {
          selection_policy: { policy: 'cookie', name: route.sticky_cookie_name || 'gc_sticky', max_age: (route.sticky_cookie_ttl || '3600') + 's' },
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

    // Retry configuration — part of load_balancing in Caddy JSON
    if (route.retry_enabled) {
      const statusCodes = (route.retry_match_status || '502,503,504')
        .split(',')
        .map(s => parseInt(s.trim(), 10))
        .filter(n => !isNaN(n));
      if (!reverseProxy.load_balancing) reverseProxy.load_balancing = {};
      reverseProxy.load_balancing.retry_match = [{ status_code: statusCodes }];
      reverseProxy.load_balancing.retries = route.retry_count || 3;
    }

    // Response custom headers — applied inside reverse_proxy handler
    if (customHeaders && Array.isArray(customHeaders.response) && customHeaders.response.length > 0) {
      const responseSet = {};
      for (const h of customHeaders.response) {
        if (h.name && h.value) responseSet[h.name] = [h.value];
      }
      if (Object.keys(responseSet).length > 0) {
        reverseProxy.headers = { response: { set: responseSet } };
      }
    }

    // If backend uses HTTPS (e.g. Synology DSM on port 5001)
    // WARNING: insecure_skip_verify disables TLS cert validation for the upstream
    if (route.backend_https) {
      logger.warn({ domain: route.domain, upstreams: upstreams.map(u => u.dial).join(',') }, 'Route uses backend_https with insecure_skip_verify — TLS not validated');
      reverseProxy.transport = {
        protocol: 'http',
        tls: {
          insecure_skip_verify: true,
        },
      };
    }

    const routeHandlers = [];

    // Request custom headers — added BEFORE reverse_proxy
    if (customHeaders && Array.isArray(customHeaders.request) && customHeaders.request.length > 0) {
      const requestSet = {};
      for (const h of customHeaders.request) {
        if (h.name && h.value) requestSet[h.name] = [h.value];
      }
      if (Object.keys(requestSet).length > 0) {
        routeHandlers.push({
          handler: 'headers',
          request: { set: requestSet },
        });
      }
    }

    // Rate limiting — must come before reverse_proxy
    if (route.rate_limit_enabled) {
      routeHandlers.push({
        handler: 'rate_limit',
        rate_limits: {
          static: {
            key: '{http.request.remote.host}',
            window: route.rate_limit_window || '1m',
            max_events: route.rate_limit_requests || 100,
          },
        },
      });
    }

    // Compression — encode handler must come before reverse_proxy
    if (route.compress_enabled) {
      routeHandlers.push({
        handler: 'encode',
        encodings: { zstd: {}, gzip: {} },
      });
    }

    routeHandlers.push(reverseProxy);

    const routeConfig = {
      handle: routeHandlers,
    };

    // Peer ACL — restrict by remote_ip when acl_enabled
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

    // Basic auth if enabled
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

    // Route Auth (forward auth) — mutually exclusive with basic auth
    const routeAuthConfig = !route.basic_auth_enabled ? getAuthForRoute(route.id) : null;
    // IP filter also needs forward auth (even without route auth)
    const needsForwardAuth = routeAuthConfig || route.ip_filter_enabled;

    if (needsForwardAuth) {
      // Route 1: /route-auth/* and static assets → proxy to GateControl (no auth check)
      const routeAuthProxy = {
        match: [{ path: ['/route-auth/*', '/css/*', '/js/*', '/fonts/*', '/branding/*'] }],
        handle: [{
          handler: 'reverse_proxy',
          upstreams: [{ dial: '127.0.0.1:3000' }],
        }],
      };

      // Route 2: Everything else → auth check via cookie, then proxy to backend
      // Uses Caddy's authentication handler pattern:
      // 1. Check session cookie via a subrequest
      // 2. If valid → strip Auth header + proxy to backend
      // 3. If invalid → redirect to login page
      //
      // Since Caddy's reverse_proxy handle_response consumes the body,
      // we use a different approach: check the cookie directly in an
      // intercept handler, and only proxy if authenticated.
      //
      // Actually, we use Caddy's forward_auth which is a reverse_proxy
      // that buffers the request body and replays it to the upstream.
      // The key is setting `buffer_requests: true`.
      // Forward auth subrequest — mirrors Caddy's forward_auth directive output:
      // - Rewrites to GET (preserves original request body for backend)
      // - On 2xx: sets vars and continues to next handler (backend proxy)
      // - On non-2xx: redirects to login page
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

      // The main route: auth subrequest → (optional headers/rate limit/encode) → proxy to backend
      const authHandlers = [forwardAuthSubrequest];
      // Request custom headers
      if (customHeaders && Array.isArray(customHeaders.request) && customHeaders.request.length > 0) {
        const requestSet = {};
        for (const h of customHeaders.request) {
          if (h.name && h.value) requestSet[h.name] = [h.value];
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
              window: route.rate_limit_window || '1m',
              max_events: route.rate_limit_requests || 100,
            },
          },
        });
      }
      if (route.compress_enabled) {
        authHandlers.push({ handler: 'encode', encodings: { zstd: {}, gzip: {} } });
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

  // Add TLS email if configured
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

  // Always include the GateControl management UI as a route
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
      // Simple case: single route — inline handles directly
      serverRoutes.push({
        match: [{ host: [domain] }],
        handle: srvConfig.routes[0].handle,
        terminal: true,
      });
    } else {
      // Multiple sub-routes (e.g. forward auth): wrap in a subroute handler
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

  // L4 config generation
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
async function syncToCaddy() {
  const caddyConfig = buildCaddyConfig();

  const result = await caddyApi('/load', {
    method: 'POST',
    body: JSON.stringify(caddyConfig),
  });

  if (result === null) {
    throw new Error('Caddy admin API is not reachable — route saved but not deployed. Restart Caddy or retry later.');
  }

  logger.info('Caddy config synced successfully');
  return true;
}

// ─── CRUD Operations ────────────────────────────────────

/**
 * Get all routes with peer info
 */
function getAll({ limit = 250, offset = 0, type = null } = {}) {
  const db = getDb();
  let query = `SELECT r.*, p.name as peer_name, p.enabled as peer_enabled,
    ra.auth_type as route_auth_type, ra.two_factor_enabled as route_auth_2fa,
    ra.two_factor_method as route_auth_2fa_method, ra.session_max_age as route_auth_session_max_age,
    CASE WHEN ra.id IS NOT NULL THEN 1 ELSE 0 END as route_auth_enabled
    FROM routes r
    LEFT JOIN peers p ON r.peer_id = p.id
    LEFT JOIN route_auth ra ON ra.route_id = r.id`;
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
    SELECT r.*, p.name AS peer_name, p.allowed_ips AS peer_ip
    FROM routes r
    LEFT JOIN peers p ON r.peer_id = p.id
    WHERE r.id = ?
  `).get(id);
  if (route) {
    route.acl_peers = getAclPeers(id).map(p => p.peer_id);
  }
  return route;
}

/**
 * Create a new route
 */
async function create(data) {
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

  if (data.description) {
    const descErr = validateDescription(data.description);
    if (descErr) throw new Error(descErr);
  }

  const db = getDb();
  const domain = data.domain ? sanitize(data.domain).toLowerCase() : null;

  // Check for duplicate domain
  if (domain) {
    const existing = db.prepare('SELECT id FROM routes WHERE domain = ?').get(domain);
    if (existing) throw new Error('A route with this domain already exists');
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

  // Validate and serialize custom_headers
  const customHeaders = data.custom_headers
    ? (typeof data.custom_headers === 'string' ? data.custom_headers : JSON.stringify(data.custom_headers))
    : null;

  // Validate and serialize backends
  const backendsJson = data.backends
    ? (typeof data.backends === 'string' ? data.backends : JSON.stringify(data.backends))
    : null;

  const result = db.prepare(`
    INSERT INTO routes (domain, target_ip, target_port, description, peer_id,
                        https_enabled, backend_https, basic_auth_enabled, basic_auth_user, basic_auth_password_hash,
                        route_type, l4_protocol, l4_listen_port, l4_tls_mode, monitoring_enabled,
                        ip_filter_enabled, ip_filter_mode, ip_filter_rules,
                        branding_title, branding_text, branding_color, branding_bg, acl_enabled, compress_enabled,
                        custom_headers, rate_limit_enabled, rate_limit_requests, rate_limit_window,
                        retry_enabled, retry_count, retry_match_status,
                        backends, sticky_enabled, sticky_cookie_name, sticky_cookie_ttl, enabled)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
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
    data.l4_protocol || null,
    data.l4_listen_port || null,
    data.l4_tls_mode || null,
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
    data.sticky_cookie_ttl || '3600'
  );

  const routeId = result.lastInsertRowid;

  // Set ACL peers if provided
  if (data.acl_enabled && Array.isArray(data.acl_peers)) {
    setAclPeers(routeId, data.acl_peers);
  }

  // Sync to Caddy — rollback DB insert on failure
  try {
    await syncToCaddy();
  } catch (err) {
    db.prepare('DELETE FROM route_peer_acl WHERE route_id = ?').run(routeId);
    db.prepare('DELETE FROM routes WHERE id = ?').run(routeId);
    throw err;
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

  return getById(routeId);
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
    if (data.l4_protocol !== undefined) {
      const protoErr = validateL4Protocol(data.l4_protocol);
      if (protoErr) throw new Error(protoErr);
    }
    if (data.l4_listen_port !== undefined) {
      const portErr = validateL4ListenPort(data.l4_listen_port);
      if (portErr) throw new Error(portErr);
    }
    const tlsMode = data.l4_tls_mode !== undefined ? data.l4_tls_mode : route.l4_tls_mode;
    if (data.l4_tls_mode !== undefined) {
      const tlsErr = validateL4TlsMode(data.l4_tls_mode);
      if (tlsErr) throw new Error(tlsErr);
    }
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
    const dup = db.prepare('SELECT id FROM routes WHERE domain = ? AND id != ?').get(domain, id);
    if (dup) throw new Error('A route with this domain already exists');
  }

  if (data.target_port !== undefined) {
    const portErr = validatePort(data.target_port);
    if (portErr) throw new Error(portErr);
  }

  if (data.description !== undefined) {
    const descErr = validateDescription(data.description);
    if (descErr) throw new Error(descErr);
  }

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

  // Serialize custom_headers for update
  const updateCustomHeaders = data.custom_headers !== undefined
    ? (data.custom_headers ? (typeof data.custom_headers === 'string' ? data.custom_headers : JSON.stringify(data.custom_headers)) : null)
    : route.custom_headers;

  // Serialize backends for update
  const updateBackends = data.backends !== undefined
    ? (data.backends ? (typeof data.backends === 'string' ? data.backends : JSON.stringify(data.backends)) : null)
    : route.backends;

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
    data.l4_protocol !== undefined ? (data.l4_protocol || null) : route.l4_protocol,
    data.l4_listen_port !== undefined ? (data.l4_listen_port || null) : route.l4_listen_port,
    data.l4_tls_mode !== undefined ? (data.l4_tls_mode || null) : route.l4_tls_mode,
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
    id
  );

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

  // Sync to Caddy — rollback DB update on failure
  try {
    await syncToCaddy();
  } catch (err) {
    db.prepare(`
      UPDATE routes SET
        domain = ?, target_ip = ?, target_port = ?, description = ?, peer_id = ?,
        https_enabled = ?, backend_https = ?, basic_auth_enabled = ?,
        basic_auth_user = ?, basic_auth_password_hash = ?,
        route_type = ?, l4_protocol = ?, l4_listen_port = ?, l4_tls_mode = ?,
        enabled = ?, updated_at = ?
      WHERE id = ?
    `).run(
      snapshot.domain, snapshot.target_ip, snapshot.target_port, snapshot.description,
      snapshot.peer_id, snapshot.https_enabled, snapshot.backend_https,
      snapshot.basic_auth_enabled, snapshot.basic_auth_user,
      snapshot.basic_auth_password_hash,
      snapshot.route_type, snapshot.l4_protocol, snapshot.l4_listen_port, snapshot.l4_tls_mode,
      snapshot.enabled, snapshot.updated_at, id
    );
    throw err;
  }

  activity.log('route_updated', `Route "${route.domain}" updated`, {
    source: 'admin',
    severity: 'info',
    details: { routeId: id },
  });

  return getById(id);
}

/**
 * Delete a route
 */
async function remove(id) {
  const db = getDb();
  const route = db.prepare('SELECT * FROM routes WHERE id = ?').get(id);
  if (!route) throw new Error('Route not found');

  db.prepare('DELETE FROM routes WHERE id = ?').run(id);

  // Sync to Caddy — rollback DB delete on failure
  try {
    await syncToCaddy();
  } catch (err) {
    db.prepare(`
      INSERT INTO routes (id, domain, target_ip, target_port, description, peer_id,
        https_enabled, backend_https, basic_auth_enabled, basic_auth_user,
        basic_auth_password_hash, route_type, l4_protocol, l4_listen_port, l4_tls_mode,
        enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      route.id, route.domain, route.target_ip, route.target_port, route.description,
      route.peer_id, route.https_enabled, route.backend_https, route.basic_auth_enabled,
      route.basic_auth_user, route.basic_auth_password_hash,
      route.route_type, route.l4_protocol, route.l4_listen_port, route.l4_tls_mode,
      route.enabled, route.created_at, route.updated_at
    );
    throw err;
  }

  activity.log('route_deleted', `Route "${route.domain}" deleted`, {
    source: 'admin',
    severity: 'warning',
    details: { routeId: id, domain: route.domain },
  });

  logger.info({ routeId: id, domain: route.domain }, 'Route deleted');
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
  try {
    await syncToCaddy();
  } catch (err) {
    db.prepare("UPDATE routes SET enabled = ?, updated_at = ? WHERE id = ?").run(route.enabled, route.updated_at, id);
    throw err;
  }

  activity.log(
    newState ? 'route_enabled' : 'route_disabled',
    `Route "${route.domain}" ${newState ? 'enabled' : 'disabled'}`,
    { source: 'admin', severity: 'info', details: { routeId: id } }
  );

  return getById(id);
}

/**
 * Get route count
 */
function getCount() {
  const db = getDb();
  return db.prepare('SELECT COUNT(*) AS count FROM routes WHERE enabled = 1').get().count;
}

module.exports = {
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
};
