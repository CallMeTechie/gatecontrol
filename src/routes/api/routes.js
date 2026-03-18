'use strict';

const { Router } = require('express');
const dns = require('dns').promises;
const routes = require('../../services/routes');
const peers = require('../../services/peers');
const logger = require('../../utils/logger');
const stripFields = require('../../utils/stripFields');
const config = require('../../../config/default');

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
      route_type, l4_protocol, l4_listen_port, l4_tls_mode } = req.body;
    const route = await routes.create({
      domain, target_ip, target_port, description, peer_id,
      https_enabled, backend_https, basic_auth_enabled,
      basic_auth_user, basic_auth_password,
      route_type, l4_protocol, l4_listen_port, l4_tls_mode,
    });
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
      route_type, l4_protocol, l4_listen_port, l4_tls_mode } = req.body;
    const route = await routes.update(req.params.id, {
      domain, target_ip, target_port, description, peer_id,
      https_enabled, backend_https, basic_auth_enabled,
      basic_auth_user, basic_auth_password, enabled,
      route_type, l4_protocol, l4_listen_port, l4_tls_mode,
    });
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
 * POST /api/routes/:id/toggle — Toggle route enabled/disabled
 */
router.post('/:id/toggle', async (req, res) => {
  try {
    const route = await routes.toggle(req.params.id);
    res.json({ ok: true, route: stripRoute(route) });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to toggle route');
    const { status, error } = resolveError(req, err, 'error.routes.toggle');
    res.status(status).json({ ok: false, error });
  }
});

module.exports = router;
