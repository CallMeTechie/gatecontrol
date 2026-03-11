'use strict';

const { getDb } = require('../db/connection');
const config = require('../../config/default');
const { validateDomain, validatePort, validateDescription, validateBasicAuthUser, validateBasicAuthPassword, sanitize } = require('../utils/validate');
const bcrypt = require('bcryptjs');
const activity = require('./activity');
const logger = require('../utils/logger');

const CADDY_ADMIN = config.caddy.adminUrl;

// ─── Caddy Admin API helper ─────────────────────────────
async function caddyApi(path, options = {}) {
  const url = `${CADDY_ADMIN}${path}`;
  try {
    const res = await fetch(url, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...options.headers },
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
function buildCaddyConfig() {
  const db = getDb();
  const routes = db.prepare(`
    SELECT r.*, p.allowed_ips, p.name AS peer_name
    FROM routes r
    LEFT JOIN peers p ON r.peer_id = p.id
    WHERE r.enabled = 1
  `).all();

  const caddyRoutes = {};

  for (const route of routes) {
    // Determine target IP: if linked to a peer, use peer's WG IP; otherwise use target_ip
    let targetIp = route.target_ip;
    if (route.peer_id && route.allowed_ips) {
      targetIp = route.allowed_ips.split('/')[0];
    }

    const upstream = `${targetIp}:${route.target_port}`;

    const reverseProxy = {
      handler: 'reverse_proxy',
      upstreams: [{ dial: upstream }],
    };

    // If backend uses HTTPS (e.g. Synology DSM on port 5001)
    if (route.backend_https) {
      reverseProxy.transport = {
        protocol: 'http',
        tls: {
          insecure_skip_verify: true,
        },
      };
    }

    const routeConfig = {
      handle: [reverseProxy],
    };

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

    caddyRoutes[route.domain] = {
      listen: route.https_enabled ? [':443'] : [':80'],
      routes: [routeConfig],
    };

    // If HTTPS, also auto-redirect HTTP to HTTPS
    if (route.https_enabled) {
      // Caddy handles this automatically when listening on :443
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
    serverRoutes.push({
      match: [{ host: [domain] }],
      handle: srvConfig.routes[0].handle,
      terminal: true,
    });
  }

  if (serverRoutes.length > 0) {
    caddyConfig.apps.http.servers.srv0 = {
      listen: [':443', ':80'],
      routes: serverRoutes,
      logs: {
        default_logger_name: 'access',
      },
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
function getAll({ limit = 250, offset = 0 } = {}) {
  const db = getDb();
  return db.prepare(`
    SELECT r.*, p.name AS peer_name, p.allowed_ips AS peer_ip, p.enabled AS peer_enabled
    FROM routes r
    LEFT JOIN peers p ON r.peer_id = p.id
    ORDER BY r.domain ASC
    LIMIT ? OFFSET ?
  `).all(limit, offset);
}

/**
 * Get a single route by ID
 */
function getById(id) {
  const db = getDb();
  return db.prepare(`
    SELECT r.*, p.name AS peer_name, p.allowed_ips AS peer_ip
    FROM routes r
    LEFT JOIN peers p ON r.peer_id = p.id
    WHERE r.id = ?
  `).get(id);
}

/**
 * Create a new route
 */
async function create(data) {
  const domainErr = validateDomain(data.domain);
  if (domainErr) throw new Error(domainErr);

  const portErr = validatePort(data.target_port);
  if (portErr) throw new Error(portErr);

  if (data.description) {
    const descErr = validateDescription(data.description);
    if (descErr) throw new Error(descErr);
  }

  const db = getDb();
  const domain = sanitize(data.domain).toLowerCase();

  // Check for duplicate domain
  const existing = db.prepare('SELECT id FROM routes WHERE domain = ?').get(domain);
  if (existing) throw new Error('A route with this domain already exists');

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
    targetIp = sanitize(data.target_ip);
  }

  const result = db.prepare(`
    INSERT INTO routes (domain, target_ip, target_port, description, peer_id,
                        https_enabled, backend_https, basic_auth_enabled, basic_auth_user, basic_auth_password_hash, enabled)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
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
    basicAuthPasswordHash
  );

  const routeId = result.lastInsertRowid;

  // Sync to Caddy — rollback DB insert on failure
  try {
    await syncToCaddy();
  } catch (err) {
    db.prepare('DELETE FROM routes WHERE id = ?').run(routeId);
    throw err;
  }

  activity.log('route_created', `Route "${domain}" created → ${targetIp}:${data.target_port}`, {
    source: 'admin',
    severity: 'success',
    details: { routeId, domain, targetIp, targetPort: data.target_port },
  });

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

  if (data.domain !== undefined) {
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
      enabled = COALESCE(?, enabled),
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
    data.enabled !== undefined ? (data.enabled ? 1 : 0) : null,
    id
  );

  // Sync to Caddy — rollback DB update on failure
  try {
    await syncToCaddy();
  } catch (err) {
    db.prepare(`
      UPDATE routes SET
        domain = ?, target_ip = ?, target_port = ?, description = ?, peer_id = ?,
        https_enabled = ?, backend_https = ?, basic_auth_enabled = ?,
        basic_auth_user = ?, basic_auth_password_hash = ?, enabled = ?, updated_at = ?
      WHERE id = ?
    `).run(
      snapshot.domain, snapshot.target_ip, snapshot.target_port, snapshot.description,
      snapshot.peer_id, snapshot.https_enabled, snapshot.backend_https,
      snapshot.basic_auth_enabled, snapshot.basic_auth_user,
      snapshot.basic_auth_password_hash, snapshot.enabled, snapshot.updated_at, id
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
        basic_auth_password_hash, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      route.id, route.domain, route.target_ip, route.target_port, route.description,
      route.peer_id, route.https_enabled, route.backend_https, route.basic_auth_enabled,
      route.basic_auth_user, route.basic_auth_password_hash, route.enabled,
      route.created_at, route.updated_at
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
};
