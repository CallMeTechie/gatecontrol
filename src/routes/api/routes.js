'use strict';

const { Router } = require('express');
const dns = require('dns').promises;
const routes = require('../../services/routes');
const peers = require('../../services/peers');
const logger = require('../../utils/logger');
const stripFields = require('../../utils/stripFields');
const asyncHandler = require('../../utils/asyncHandler');
const { validateDomain, validatePort, validateDescription, validateIp } = require('../../utils/validate');
const config = require('../../../config/default');
const { requireLimit, requireFeatureField, requireFeature } = require('../../middleware/license');
const { getDb } = require('../../db/connection');
const multer = require('multer');
const path = require('node:path');
const fs = require('node:fs');

const BRANDING_DIR = '/data/branding';
const logoUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      if (!fs.existsSync(BRANDING_DIR)) fs.mkdirSync(BRANDING_DIR, { recursive: true });
      cb(null, BRANDING_DIR);
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || '.png';
      cb(null, `${req.params.id}-${Date.now()}${ext}`);
    },
  }),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files are allowed'));
  },
});

const router = Router();

const httpRouteCountFn = () => getDb().prepare("SELECT COUNT(*) as count FROM routes WHERE route_type = 'http' OR route_type IS NULL").get().count;
const l4RouteCountFn = () => getDb().prepare("SELECT COUNT(*) as count FROM routes WHERE route_type = 'l4'").get().count;

const stripRoute = (r) => stripFields(r, ['basic_auth_password_hash']);

/** Map service-layer error messages to i18n keys */
const VALIDATION_ERROR_MAP = {
  'not found': 'error.routes.not_found',
  'already exists': 'error.routes.domain_exists',
  'peer not found': 'error.routes.peer_not_found',
  'peer is disabled': 'error.routes.peer_disabled',
  'required': 'error.routes.basic_auth_required',
  'Invalid': 'error.routes.create',
  'must be': 'error.routes.create',
  'characters': 'error.routes.create',
  'L4 protocol must be': 'error.routes.l4_invalid_protocol',
  'Invalid port or port range': 'error.routes.l4_invalid_port',
  'TLS mode must be': 'error.routes.l4_invalid_tls_mode',
  'TLS mode requires a domain': 'error.routes.l4_tls_requires_domain',
  'TLS requires TCP': 'error.routes.l4_tls_requires_tcp',
  'is reserved': 'error.routes.l4_port_blocked',
  'port conflicts': 'error.routes.l4_port_conflict',
  'Port range exceeds': 'error.routes.l4_port_range_too_large',
};

function resolveError(req, err, fallbackKey) {
  const msg = err.message || '';
  if (msg.includes('Caddy')) return { status: 502, error: req.t('error.routes.caddy_unreachable') };
  for (const [pattern, key] of Object.entries(VALIDATION_ERROR_MAP)) {
    if (msg.toLowerCase().includes(pattern.toLowerCase())) {
      const status = pattern === 'not found' ? 404 : 400;
      return { status, error: req.t(key) };
    }
  }
  return { status: 500, error: req.t(fallbackKey) };
}

/**
 * POST /api/routes/batch — Batch enable/disable/delete routes
 */
router.post('/batch', async (req, res) => {
  try {
    const { action, ids } = req.body;

    if (!action || !['enable', 'disable', 'delete'].includes(action)) {
      return res.status(400).json({ ok: false, error: req.t('error.batch.invalid_action') });
    }
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ ok: false, error: req.t('error.batch.no_ids') });
    }

    const affected = await routes.batch(action, ids);
    res.json({ ok: true, affected });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to batch operate on routes');
    if (err.message.includes('not found')) {
      return res.status(404).json({ ok: false, error: req.t('error.batch.not_found') });
    }
    res.status(500).json({ ok: false, error: req.t('error.batch.failed') });
  }
});

/**
 * GET /api/routes — List all routes with peer info
 */
router.get('/', async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 250, 1), 250);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const { type } = req.query;
    const list = routes.getAll({ limit, offset, type: type || null }).map(stripRoute);
    res.json({ ok: true, routes: list, limit, offset });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to list routes');
    res.status(500).json({ ok: false, error: req.t('error.routes.list') });
  }
});

// ─── Server public IP cache ──────────────────────────────
let _cachedServerIp = null;

function isPublicIp(str) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(str);
}

async function getServerIp() {
  if (_cachedServerIp) return _cachedServerIp;
  const wgHost = config.wireguard.host;
  if (wgHost && isPublicIp(wgHost)) {
    _cachedServerIp = wgHost;
    return _cachedServerIp;
  }
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const res = await fetch('https://api.ipify.org', { signal: controller.signal });
    clearTimeout(timeout);
    const ip = (await res.text()).trim();
    if (isPublicIp(ip)) {
      _cachedServerIp = ip;
      return _cachedServerIp;
    }
  } catch (_) { /* ignore */ }
  return null;
}

/**
 * POST /api/routes/check-dns — Check if domain resolves to server IP
 */
router.post('/check-dns', async (req, res) => {
  const { domain } = req.body || {};
  if (!domain || typeof domain !== 'string') {
    return res.status(400).json({ ok: false, error: 'domain required' });
  }
  const domainErr = validateDomain(domain);
  if (domainErr) return res.status(400).json({ ok: false, error: domainErr });
  try {
    const dnsTimeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('DNS timeout')), 2000)
    );
    const [serverIp, addresses] = await Promise.all([
      getServerIp(),
      Promise.race([dns.resolve4(domain), dnsTimeout]),
    ]);
    const resolves = serverIp ? addresses.includes(serverIp) : false;
    return res.json({ ok: true, resolves, expected: serverIp });
  } catch (err) {
    logger.debug({ error: err.message, domain }, 'DNS check failed');
    return res.json({ ok: true, resolves: false, expected: null, actual: [] });
  }
});

/**
 * GET /api/routes/peers — List peers for route target dropdown
 */
router.get('/peers', async (req, res) => {
  try {
    const list = await peers.getAll();
    const simplified = list.map(p => ({
      id: p.id,
      name: p.name,
      ip: p.allowed_ips ? p.allowed_ips.split('/')[0] : null,
      enabled: p.enabled,
      isOnline: p.isOnline,
    }));
    res.json({ ok: true, peers: simplified });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to list peers for routes');
    res.status(500).json({ ok: false, error: req.t('error.peers.list') });
  }
});

/**
 * GET /api/routes/:id — Get single route
 */
router.get('/:id', (req, res) => {
  try {
    const route = routes.getById(req.params.id);
    if (!route) return res.status(404).json({ ok: false, error: req.t('error.routes.not_found') });
    res.json({ ok: true, route: stripRoute(route) });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to get route');
    res.status(500).json({ ok: false, error: req.t('error.routes.get') });
  }
});

/**
 * POST /api/routes — Create new route
 */
router.post('/',
  (req, res, next) => {
    const rt = req.body.route_type || 'http';
    if (rt === 'l4') return requireLimit('l4_routes', l4RouteCountFn)(req, res, next);
    return requireLimit('http_routes', httpRouteCountFn)(req, res, next);
  },
  requireFeatureField('acl_enabled', 'peer_acl'),
  requireFeatureField('ip_filter_enabled', 'ip_access_control'),
  requireFeatureField('rate_limit_enabled', 'rate_limiting'),
  requireFeatureField('compress_enabled', 'compression'),
  requireFeatureField('custom_headers', 'custom_headers'),
  requireFeatureField('retry_enabled', 'retry_on_error'),
  requireFeatureField('circuit_breaker_enabled', 'circuit_breaker'),
  requireFeatureField('mirror_enabled', 'request_mirroring'),
  requireFeatureField('monitoring_enabled', 'uptime_monitoring'),
  requireFeatureField('backends', 'load_balancing'),
  requireFeatureField('branding_title', 'custom_branding'),
  requireFeatureField('debug_enabled', 'request_debugging'),
  requireFeatureField('bot_blocker_enabled', 'bot_blocking'),
  async (req, res) => {
  try {
    const { domain, target_ip, target_port, description, peer_id,
      https_enabled, backend_https, basic_auth_enabled, basic_auth_user, basic_auth_password,
      route_type, l4_protocol, l4_listen_port, l4_tls_mode, monitoring_enabled,
      ip_filter_enabled, ip_filter_mode, ip_filter_rules,
      branding_title, branding_text, branding_color, branding_bg,
      acl_enabled, acl_peers, compress_enabled, custom_headers,
      rate_limit_enabled, rate_limit_requests, rate_limit_window,
      retry_enabled, retry_count, retry_match_status,
      backends, sticky_enabled, sticky_cookie_name, sticky_cookie_ttl,
      circuit_breaker_enabled, circuit_breaker_threshold, circuit_breaker_timeout,
      mirror_enabled, mirror_targets, debug_enabled,
      bot_blocker_enabled, bot_blocker_mode, bot_blocker_config } = req.body;

    // Field-level validation
    const fields = {};
    const rt = route_type || 'http';
    if (rt === 'http' || domain) {
      const domErr = validateDomain(domain);
      if (domErr) fields.domain = req.t('error.routes.domain_invalid') || domErr;
    }
    const portErr = validatePort(target_port);
    if (portErr) fields.target_port = req.t('error.routes.port_invalid') || portErr;
    if (description) {
      const descErr = validateDescription(description);
      if (descErr) fields.description = req.t('error.routes.description_invalid') || descErr;
    }
    if (target_ip && !peer_id) {
      const ipErr = validateIp(target_ip);
      if (ipErr) fields.target_ip = req.t('error.routes.ip_invalid') || ipErr;
    }
    if (Object.keys(fields).length > 0) {
      return res.status(400).json({ ok: false, error: Object.values(fields)[0], fields });
    }

    // SSRF protection: block private/loopback IPs for direct target_ip (not peer-linked routes)
    if (target_ip && !peer_id) {
      const parts = target_ip.split('.').map(Number);
      if (parts[0] === 127 || parts[0] === 10 ||
          (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
          (parts[0] === 192 && parts[1] === 168) ||
          (parts[0] === 169 && parts[1] === 254) ||
          parts[0] === 0) {
        return res.status(400).json({ ok: false, error: req.t('error.routes.private_ip') || 'Private/loopback IPs are not allowed as route targets' });
      }
    }

    // Validate mirror targets (peer_id + port format)
    if (mirror_targets) {
      if (!Array.isArray(mirror_targets)) {
        return res.status(400).json({ ok: false, error: req.t('routes.mirror_invalid_array') || 'Mirror targets must be an array' });
      }
      if (mirror_enabled && mirror_targets.length === 0) {
        return res.status(400).json({ ok: false, error: req.t('routes.mirror_empty') || 'Mirror targets must be non-empty when mirroring is enabled' });
      }
      if (mirror_targets.length > 5) {
        return res.status(400).json({ ok: false, error: req.t('routes.mirror_max') || 'Maximum 5 mirror targets' });
      }
      for (const t of mirror_targets) {
        if (!t || !t.peer_id || t.port === undefined || t.port === null) {
          return res.status(400).json({ ok: false, error: req.t('routes.mirror_invalid_target') || 'Each mirror target must have a peer and port' });
        }
        const pErr = validatePort(t.port);
        if (pErr) return res.status(400).json({ ok: false, error: 'Mirror target: ' + pErr });
      }
    }

    const route = await routes.create({
      domain, target_ip, target_port, description, peer_id,
      https_enabled, backend_https, basic_auth_enabled,
      basic_auth_user, basic_auth_password,
      route_type, l4_protocol, l4_listen_port, l4_tls_mode,
      monitoring_enabled,
      ip_filter_enabled, ip_filter_mode, ip_filter_rules,
      branding_title, branding_text, branding_color, branding_bg,
      acl_enabled, acl_peers, compress_enabled, custom_headers,
      rate_limit_enabled, rate_limit_requests, rate_limit_window,
      retry_enabled, retry_count, retry_match_status,
      backends, sticky_enabled, sticky_cookie_name, sticky_cookie_ttl,
      circuit_breaker_enabled, circuit_breaker_threshold, circuit_breaker_timeout,
      mirror_enabled, mirror_targets, debug_enabled,
      bot_blocker_enabled, bot_blocker_mode, bot_blocker_config,
    });
    // Trigger immediate check if monitoring enabled on create
    if (monitoring_enabled) {
      try { const { checkRouteById } = require('../../services/monitor'); checkRouteById(route.id); } catch {}
    }
    res.status(201).json({ ok: true, route: stripRoute(route) });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to create route');
    const { status, error } = resolveError(req, err, 'error.routes.create');
    res.status(status).json({ ok: false, error });
  }
});

/**
 * PUT /api/routes/:id — Update route
 */
router.put('/:id',
  requireFeatureField('acl_enabled', 'peer_acl'),
  requireFeatureField('ip_filter_enabled', 'ip_access_control'),
  requireFeatureField('rate_limit_enabled', 'rate_limiting'),
  requireFeatureField('compress_enabled', 'compression'),
  requireFeatureField('custom_headers', 'custom_headers'),
  requireFeatureField('retry_enabled', 'retry_on_error'),
  requireFeatureField('circuit_breaker_enabled', 'circuit_breaker'),
  requireFeatureField('mirror_enabled', 'request_mirroring'),
  requireFeatureField('monitoring_enabled', 'uptime_monitoring'),
  requireFeatureField('backends', 'load_balancing'),
  requireFeatureField('branding_title', 'custom_branding'),
  requireFeatureField('debug_enabled', 'request_debugging'),
  requireFeatureField('bot_blocker_enabled', 'bot_blocking'),
  async (req, res) => {
  try {
    const { domain, target_ip, target_port, description, peer_id,
      https_enabled, backend_https, basic_auth_enabled, basic_auth_user, basic_auth_password, enabled,
      route_type, l4_protocol, l4_listen_port, l4_tls_mode, monitoring_enabled,
      ip_filter_enabled, ip_filter_mode, ip_filter_rules,
      branding_title, branding_text, branding_color, branding_bg,
      acl_enabled, acl_peers, compress_enabled, custom_headers,
      rate_limit_enabled, rate_limit_requests, rate_limit_window,
      retry_enabled, retry_count, retry_match_status,
      backends, sticky_enabled, sticky_cookie_name, sticky_cookie_ttl,
      circuit_breaker_enabled, circuit_breaker_threshold, circuit_breaker_timeout,
      mirror_enabled, mirror_targets, debug_enabled,
      bot_blocker_enabled, bot_blocker_mode, bot_blocker_config } = req.body;

    // Field-level validation
    const fields = {};
    if (domain !== undefined) {
      const domErr = validateDomain(domain);
      if (domErr) fields.domain = req.t('error.routes.domain_invalid') || domErr;
    }
    if (target_port !== undefined) {
      const portErr = validatePort(target_port);
      if (portErr) fields.target_port = req.t('error.routes.port_invalid') || portErr;
    }
    if (description !== undefined) {
      const descErr = validateDescription(description);
      if (descErr) fields.description = req.t('error.routes.description_invalid') || descErr;
    }
    if (target_ip !== undefined && !peer_id) {
      const ipErr = validateIp(target_ip);
      if (ipErr) fields.target_ip = req.t('error.routes.ip_invalid') || ipErr;
    }
    if (Object.keys(fields).length > 0) {
      return res.status(400).json({ ok: false, error: Object.values(fields)[0], fields });
    }

    // SSRF protection: block private/loopback IPs for direct target_ip (not peer-linked routes)
    if (target_ip && !peer_id) {
      const parts = target_ip.split('.').map(Number);
      if (parts[0] === 127 || parts[0] === 10 ||
          (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
          (parts[0] === 192 && parts[1] === 168) ||
          (parts[0] === 169 && parts[1] === 254) ||
          parts[0] === 0) {
        return res.status(400).json({ ok: false, error: req.t('error.routes.private_ip') || 'Private/loopback IPs are not allowed as route targets' });
      }
    }

    // Validate mirror targets
    if (mirror_targets) {
      if (!Array.isArray(mirror_targets)) {
        return res.status(400).json({ ok: false, error: req.t('routes.mirror_invalid_array') || 'Mirror targets must be an array' });
      }
      if (mirror_enabled && mirror_targets.length === 0) {
        return res.status(400).json({ ok: false, error: req.t('routes.mirror_empty') || 'Mirror targets must be non-empty when mirroring is enabled' });
      }
      if (mirror_targets.length > 5) {
        return res.status(400).json({ ok: false, error: req.t('routes.mirror_max') || 'Maximum 5 mirror targets' });
      }
      for (const t of mirror_targets) {
        if (!t || !t.peer_id || t.port === undefined || t.port === null) {
          return res.status(400).json({ ok: false, error: req.t('routes.mirror_invalid_target') || 'Each mirror target must have a peer and port' });
        }
        const pErr = validatePort(t.port);
        if (pErr) return res.status(400).json({ ok: false, error: 'Mirror target: ' + pErr });
      }
    }

    const route = await routes.update(req.params.id, {
      domain, target_ip, target_port, description, peer_id,
      https_enabled, backend_https, basic_auth_enabled,
      basic_auth_user, basic_auth_password, enabled,
      route_type, l4_protocol, l4_listen_port, l4_tls_mode,
      monitoring_enabled,
      ip_filter_enabled, ip_filter_mode, ip_filter_rules,
      branding_title, branding_text, branding_color, branding_bg,
      acl_enabled, acl_peers, compress_enabled, custom_headers,
      rate_limit_enabled, rate_limit_requests, rate_limit_window,
      retry_enabled, retry_count, retry_match_status,
      backends, sticky_enabled, sticky_cookie_name, sticky_cookie_ttl,
      circuit_breaker_enabled, circuit_breaker_threshold, circuit_breaker_timeout,
      mirror_enabled, mirror_targets, debug_enabled,
      bot_blocker_enabled, bot_blocker_mode, bot_blocker_config,
    });
    // Reset circuit breaker status when settings change
    if (circuit_breaker_enabled !== undefined) {
      try { const cb = require('../../services/circuitBreaker'); cb.resetStatus(req.params.id); } catch {}
    }
    // Trigger immediate check if monitoring was just enabled
    if (monitoring_enabled) {
      try { const { checkRouteById } = require('../../services/monitor'); checkRouteById(req.params.id); } catch {}
    }
    res.json({ ok: true, route: stripRoute(route) });
  } catch (err) {
    logger.error({ error: err.message, stack: err.stack }, 'Failed to update route');
    const { status, error } = resolveError(req, err, 'error.routes.update');
    res.status(status).json({ ok: false, error });
  }
});

/**
 * DELETE /api/routes/:id — Delete route
 */
router.delete('/:id', async (req, res) => {
  try {
    await routes.remove(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to delete route');
    const { status, error } = resolveError(req, err, 'error.routes.delete');
    res.status(status).json({ ok: false, error });
  }
});

/**
 * PUT /api/routes/:id/toggle — Toggle route enabled/disabled
 */
router.put('/:id/toggle', async (req, res) => {
  try {
    // Check if trying to enable and limit would be exceeded
    const existing = routes.getById(req.params.id);
    if (existing && !existing.enabled) {
      const { isWithinLimit, getFeatureLimit } = require('../../services/license');
      const routeType = existing.route_type || 'http';
      const limitKey = routeType === 'l4' ? 'l4_routes' : 'http_routes';
      const countQuery = routeType === 'l4'
        ? "SELECT COUNT(*) as count FROM routes WHERE route_type = 'l4' AND enabled = 1"
        : "SELECT COUNT(*) as count FROM routes WHERE (route_type = 'http' OR route_type IS NULL) AND enabled = 1";
      const count = getDb().prepare(countQuery).get().count;
      if (!isWithinLimit(limitKey, count)) {
        const limit = getFeatureLimit(limitKey);
        return res.status(403).json({
          ok: false,
          error: req.t ? req.t('error.license.limit_reached') : 'Route limit reached',
          feature: limitKey,
          current: count,
          limit,
          upgrade_url: 'https://callmetechie.de/products/gatecontrol/pricing',
        });
      }
    }
    const route = await routes.toggle(req.params.id);
    res.json({ ok: true, route: stripRoute(route) });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to toggle route');
    const { status, error } = resolveError(req, err, 'error.routes.toggle');
    res.status(status).json({ ok: false, error });
  }
});

/**
 * POST /api/routes/:id/check — Manually trigger a monitoring check
 */
router.post('/:id/check', async (req, res) => {
  try {
    const { checkRouteById } = require('../../services/monitor');
    const result = await checkRouteById(req.params.id);
    res.json({ ok: true, ...result });
  } catch (err) {
    logger.error({ error: err.message }, 'Manual check failed');
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * POST /api/routes/:id/branding/logo — Upload branding logo
 */
router.post('/:id/branding/logo', requireFeature('custom_branding'), logoUpload.single('logo'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: 'No file uploaded' });

    const { getDb } = require('../../db/connection');
    const db = getDb();
    const route = db.prepare('SELECT branding_logo FROM routes WHERE id = ?').get(req.params.id);
    if (!route) return res.status(404).json({ ok: false, error: 'Route not found' });

    // Delete old logo if exists
    if (route.branding_logo) {
      const oldPath = path.join(BRANDING_DIR, route.branding_logo);
      try { fs.unlinkSync(oldPath); } catch {}
    }

    db.prepare("UPDATE routes SET branding_logo = ?, updated_at = datetime('now') WHERE id = ?")
      .run(req.file.filename, req.params.id);

    res.json({ ok: true, filename: req.file.filename });
  } catch (err) {
    logger.error({ error: err.message }, 'Logo upload failed');
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * DELETE /api/routes/:id/branding/logo — Remove branding logo
 */
router.delete('/:id/branding/logo', (req, res) => {
  try {
    const { getDb } = require('../../db/connection');
    const db = getDb();
    const route = db.prepare('SELECT branding_logo FROM routes WHERE id = ?').get(req.params.id);
    if (!route) return res.status(404).json({ ok: false, error: 'Route not found' });

    if (route.branding_logo) {
      const filePath = path.join(BRANDING_DIR, route.branding_logo);
      try { fs.unlinkSync(filePath); } catch {}
    }

    db.prepare("UPDATE routes SET branding_logo = NULL, updated_at = datetime('now') WHERE id = ?")
      .run(req.params.id);

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * POST /api/routes/:id/branding/bg-image — Upload background image
 */
router.post('/:id/branding/bg-image', logoUpload.single('bg_image'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: 'No file uploaded' });

    const { getDb } = require('../../db/connection');
    const db = getDb();
    const route = db.prepare('SELECT branding_bg_image FROM routes WHERE id = ?').get(req.params.id);
    if (!route) return res.status(404).json({ ok: false, error: 'Route not found' });

    if (route.branding_bg_image) {
      const oldPath = path.join(BRANDING_DIR, route.branding_bg_image);
      try { fs.unlinkSync(oldPath); } catch {}
    }

    db.prepare("UPDATE routes SET branding_bg_image = ?, updated_at = datetime('now') WHERE id = ?")
      .run(req.file.filename, req.params.id);

    res.json({ ok: true, filename: req.file.filename });
  } catch (err) {
    logger.error({ error: err.message }, 'BG image upload failed');
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * DELETE /api/routes/:id/branding/bg-image — Remove background image
 */
router.delete('/:id/branding/bg-image', (req, res) => {
  try {
    const { getDb } = require('../../db/connection');
    const db = getDb();
    const route = db.prepare('SELECT branding_bg_image FROM routes WHERE id = ?').get(req.params.id);
    if (!route) return res.status(404).json({ ok: false, error: 'Route not found' });

    if (route.branding_bg_image) {
      const filePath = path.join(BRANDING_DIR, route.branding_bg_image);
      try { fs.unlinkSync(filePath); } catch {}
    }

    db.prepare("UPDATE routes SET branding_bg_image = NULL, updated_at = datetime('now') WHERE id = ?")
      .run(req.params.id);

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /routes/:id/trace — read trace log entries for a route
router.get('/:id/trace', asyncHandler(async (req, res) => {
  const routeId = req.params.id;
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const since = req.query.since || '';
  const logPath = '/data/caddy/caddy-stdout.log';

  const entries = [];
  try {
    const fs = require('fs');
    if (!fs.existsSync(logPath)) {
      return res.json({ ok: true, data: { entries: [] } });
    }
    const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean);

    // Merge incoming+outgoing pairs by request_id
    const requests = new Map();
    for (let i = 0; i < lines.length; i++) {
      try {
        const parsed = JSON.parse(lines[i]);
        if (parsed.tag !== `route-${routeId}`) continue;
        if (!parsed.request_id) continue;
        const rid = parsed.request_id;
        if (!requests.has(rid)) requests.set(rid, {});
        const entry = requests.get(rid);
        if (parsed.direction === 'incoming') {
          entry.timestamp = parsed.time || '';
          entry.method = parsed.method || '';
          entry.uri = parsed.uri || '';
          entry.remote_ip = parsed.remote_addr || '';
          entry.host = parsed.host || '';
          entry.user_agent = parsed.user_agent || '';
        } else if (parsed.direction === 'outgoing') {
          entry.status = parsed.status_code || 0;
          entry.response_size = parsed.response_size || 0;
        }
      } catch { /* skip unparseable lines */ }
    }

    // Convert to array, filter by since, sort newest first, limit
    for (const [, entry] of requests) {
      if (!entry.timestamp || !entry.method) continue;
      if (since && entry.timestamp <= since) continue;
      entries.push(entry);
    }
    entries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    entries.splice(limit);
  } catch { /* log file not readable */ }

  res.json({ ok: true, data: { entries } });
}));

module.exports = router;
