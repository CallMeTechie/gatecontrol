'use strict';

const { getDb } = require('../db/connection');
const config = require('../../config/default');
const { validateDomain, validatePort, validateDescription, validateBasicAuthUser, validateBasicAuthPassword, validateIp, sanitize, validateL4Protocol, validateL4ListenPort, validateL4TlsMode, isPortBlocked, parsePortRange } = require('../utils/validate');
const bcrypt = require('bcryptjs');
const { syncToCaddy, buildCaddyConfig, caddyApi, getAclPeers, setAclPeers } = require('./caddyConfig');
const { restoreRouteRow, reinsertRouteRow } = require('./routesRollback');
const { validateBrandingFields, validateBotBlockerConfig } = require('./routesValidation');
const { withCaddySync } = require('./routesSync');
const activity = require('./activity');
const logger = require('../utils/logger');

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
    CASE WHEN ra.id IS NOT NULL THEN 1 ELSE 0 END as route_auth_enabled
    FROM routes r
    LEFT JOIN peers p ON r.peer_id = p.id
    LEFT JOIN peers gp ON gp.id = r.target_peer_id
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

  validateBrandingFields(data);

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

  // Validate and serialize mirror_targets
  const mirrorTargetsJson = data.mirror_targets
    ? (typeof data.mirror_targets === 'string' ? data.mirror_targets : JSON.stringify(data.mirror_targets))
    : null;

  validateBotBlockerConfig(data);

  const targetKind = data.target_kind || 'peer';
  const targetPeerId = targetKind === 'gateway' ? (data.target_peer_id || null) : null;
  const targetLanHost = targetKind === 'gateway' ? (data.target_lan_host || null) : null;
  const targetLanPort = targetKind === 'gateway' && data.target_lan_port
    ? parseInt(data.target_lan_port, 10)
    : null;
  const wolEnabled = (targetKind === 'gateway' && data.wol_enabled) ? 1 : 0;
  const wolMac = targetKind === 'gateway' ? (data.wol_mac || null) : null;

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
                        target_kind, target_peer_id, target_lan_host, target_lan_port, wol_enabled, wol_mac,
                        enabled)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
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
    targetKind,
    targetPeerId,
    targetLanHost,
    targetLanPort,
    wolEnabled,
    wolMac,
  );

  const routeId = result.lastInsertRowid;

  // Set ACL peers if provided
  if (data.acl_enabled && Array.isArray(data.acl_peers)) {
    setAclPeers(routeId, data.acl_peers);
  }

  // Sync to Caddy — rollback DB insert on failure
  await withCaddySync(syncToCaddy, () => {
    db.prepare('DELETE FROM route_peer_acl WHERE route_id = ?').run(routeId);
    db.prepare('DELETE FROM routes WHERE id = ?').run(routeId);
  }, 'route create');

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
  if (targetKind === 'gateway' && targetPeerId) {
    try {
      const gateways = require('./gateways');
      gateways.notifyConfigChanged(targetPeerId).catch(() => {});
    } catch { /* fallback when module load fails */ }
  }

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
      target_kind = COALESCE(?, target_kind),
      target_peer_id = COALESCE(?, target_peer_id),
      target_lan_host = COALESCE(?, target_lan_host),
      target_lan_port = COALESCE(?, target_lan_port),
      wol_enabled = COALESCE(?, wol_enabled),
      wol_mac = COALESCE(?, wol_mac),
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
    data.target_kind !== undefined ? (data.target_kind || null) : null,
    data.target_peer_id !== undefined ? (data.target_peer_id || null) : null,
    data.target_lan_host !== undefined ? (data.target_lan_host || null) : null,
    data.target_lan_port !== undefined ? (data.target_lan_port ? parseInt(data.target_lan_port, 10) : null) : null,
    data.wol_enabled !== undefined ? (data.wol_enabled ? 1 : 0) : null,
    data.wol_mac !== undefined ? (data.wol_mac || null) : null,
    id
  );

  // When the admin switches target_kind away from 'gateway', COALESCE
  // above would preserve stale gateway_* values that pollute both the
  // DB row and any future backup. Explicitly clear them in a follow-up
  // write so Caddy config generation sees a clean row.
  if (data.target_kind !== undefined && data.target_kind !== 'gateway') {
    db.prepare(`UPDATE routes SET target_peer_id = NULL, target_lan_host = NULL, target_lan_port = NULL, wol_enabled = 0, wol_mac = NULL WHERE id = ?`).run(id);
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

  return finalRoute;
}

/**
 * Delete a route
 */
async function remove(id) {
  const db = getDb();
  const route = db.prepare('SELECT * FROM routes WHERE id = ?').get(id);
  if (!route) throw new Error('Route not found');

  db.prepare('DELETE FROM routes WHERE id = ?').run(id);

  // Sync to Caddy — rollback DB delete on failure. Re-insert every
  // column of the original row (not just the hard-coded core set),
  // otherwise a rollback throws away ACLs / IP-filter / bot-blocker
  // config that the admin set up and leaves a half-castrated route.
  await withCaddySync(syncToCaddy, () => reinsertRouteRow(db, route), 'route delete');

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
  await withCaddySync(syncToCaddy, () => {
    db.prepare("UPDATE routes SET enabled = ?, updated_at = ? WHERE id = ?").run(route.enabled, route.updated_at, id);
  }, 'route toggle');

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

  if (action === 'enable') {
    db.prepare(`UPDATE routes SET enabled = 1, updated_at = datetime('now') WHERE id IN (${placeholders})`).run(...ids);
  } else if (action === 'disable') {
    db.prepare(`UPDATE routes SET enabled = 0, updated_at = datetime('now') WHERE id IN (${placeholders})`).run(...ids);
  } else if (action === 'delete') {
    db.prepare(`DELETE FROM route_peer_acl WHERE route_id IN (${placeholders})`).run(...ids);
    db.prepare(`DELETE FROM routes WHERE id IN (${placeholders})`).run(...ids);
  }

  await withCaddySync(syncToCaddy, () => {
    const tx = db.transaction(() => {
      if (action === 'delete') {
        for (const row of snapshots) reinsertRouteRow(db, row);
        const insertAcl = db.prepare('INSERT OR IGNORE INTO route_peer_acl (route_id, peer_id) VALUES (?, ?)');
        for (const a of aclSnapshots) insertAcl.run(a.route_id, a.peer_id);
      } else {
        for (const row of snapshots) restoreRouteRow(db, row.id, row);
      }
    });
    tx();
  }, `batch ${action}`);

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

  return ids.length;
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
  getForUser,
};
