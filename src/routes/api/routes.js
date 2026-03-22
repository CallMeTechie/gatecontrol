'use strict';

const { Router } = require('express');
const dns = require('dns').promises;
const routes = require('../../services/routes');
const peers = require('../../services/peers');
const logger = require('../../utils/logger');
const stripFields = require('../../utils/stripFields');
const { validateDomain, validatePort, validateDescription, validateIp } = require('../../utils/validate');
const config = require('../../../config/default');
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
  try {
    const dnsTimeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('DNS timeout')), 2000)
    );
    const [serverIp, addresses] = await Promise.all([
      getServerIp(),
      Promise.race([dns.resolve4(domain), dnsTimeout]),
    ]);
    const resolves = serverIp ? addresses.includes(serverIp) : false;
    return res.json({ ok: true, resolves, expected: serverIp, actual: addresses });
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
router.post('/', async (req, res) => {
  try {
    const { domain, target_ip, target_port, description, peer_id,
      https_enabled, backend_https, basic_auth_enabled, basic_auth_user, basic_auth_password,
      route_type, l4_protocol, l4_listen_port, l4_tls_mode, monitoring_enabled,
      ip_filter_enabled, ip_filter_mode, ip_filter_rules,
      branding_title, branding_text, branding_color, branding_bg,
      acl_enabled, acl_peers } = req.body;

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

    const route = await routes.create({
      domain, target_ip, target_port, description, peer_id,
      https_enabled, backend_https, basic_auth_enabled,
      basic_auth_user, basic_auth_password,
      route_type, l4_protocol, l4_listen_port, l4_tls_mode,
      monitoring_enabled,
      ip_filter_enabled, ip_filter_mode, ip_filter_rules,
      branding_title, branding_text, branding_color, branding_bg,
      acl_enabled, acl_peers,
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
router.put('/:id', async (req, res) => {
  try {
    const { domain, target_ip, target_port, description, peer_id,
      https_enabled, backend_https, basic_auth_enabled, basic_auth_user, basic_auth_password, enabled,
      route_type, l4_protocol, l4_listen_port, l4_tls_mode, monitoring_enabled,
      ip_filter_enabled, ip_filter_mode, ip_filter_rules,
      branding_title, branding_text, branding_color, branding_bg,
      acl_enabled, acl_peers } = req.body;

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

    const route = await routes.update(req.params.id, {
      domain, target_ip, target_port, description, peer_id,
      https_enabled, backend_https, basic_auth_enabled,
      basic_auth_user, basic_auth_password, enabled,
      route_type, l4_protocol, l4_listen_port, l4_tls_mode,
      monitoring_enabled,
      ip_filter_enabled, ip_filter_mode, ip_filter_rules,
      branding_title, branding_text, branding_color, branding_bg,
      acl_enabled, acl_peers,
    });
    // Trigger immediate check if monitoring was just enabled
    if (monitoring_enabled) {
      try { const { checkRouteById } = require('../../services/monitor'); checkRouteById(req.params.id); } catch {}
    }
    res.json({ ok: true, route: stripRoute(route) });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to update route');
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
router.post('/:id/branding/logo', logoUpload.single('logo'), (req, res) => {
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

module.exports = router;
