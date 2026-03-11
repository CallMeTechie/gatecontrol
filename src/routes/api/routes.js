'use strict';

const { Router } = require('express');
const routes = require('../../services/routes');
const peers = require('../../services/peers');
const logger = require('../../utils/logger');

const router = Router();

/** Strip password hash from API responses */
function stripHash(route) {
  if (!route) return route;
  const { basic_auth_password_hash, ...safe } = route;
  return safe;
}

/** Map error message to HTTP status code */
function errorStatus(err) {
  const msg = err.message || '';
  if (msg.includes('not found')) return 404;
  if (msg.includes('already exists') || msg.includes('required') || msg.includes('Invalid') || msg.includes('must be') || msg.includes('characters')) return 400;
  if (msg.includes('Caddy admin API')) return 502;
  return 500;
}

/**
 * GET /api/routes — List all routes with peer info
 */
router.get('/', async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 250, 1), 250);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const list = routes.getAll({ limit, offset }).map(stripHash);
    res.json({ ok: true, routes: list, limit, offset });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to list routes');
    res.status(500).json({ ok: false, error: err.message });
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
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * GET /api/routes/:id — Get single route
 */
router.get('/:id', (req, res) => {
  try {
    const route = routes.getById(req.params.id);
    if (!route) return res.status(404).json({ ok: false, error: 'Route not found' });
    res.json({ ok: true, route: stripHash(route) });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to get route');
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * POST /api/routes — Create new route
 */
router.post('/', async (req, res) => {
  try {
    const { domain, target_ip, target_port, description, peer_id, https_enabled, backend_https, basic_auth_enabled, basic_auth_user, basic_auth_password } = req.body;
    const route = await routes.create({
      domain, target_ip, target_port, description, peer_id,
      https_enabled, backend_https, basic_auth_enabled,
      basic_auth_user, basic_auth_password,
    });
    res.status(201).json({ ok: true, route: stripHash(route) });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to create route');
    res.status(errorStatus(err)).json({ ok: false, error: err.message });
  }
});

/**
 * PUT /api/routes/:id — Update route
 */
router.put('/:id', async (req, res) => {
  try {
    const { domain, target_ip, target_port, description, peer_id, https_enabled, backend_https, basic_auth_enabled, basic_auth_user, basic_auth_password, enabled } = req.body;
    const route = await routes.update(req.params.id, {
      domain, target_ip, target_port, description, peer_id,
      https_enabled, backend_https, basic_auth_enabled,
      basic_auth_user, basic_auth_password, enabled,
    });
    res.json({ ok: true, route: stripHash(route) });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to update route');
    res.status(errorStatus(err)).json({ ok: false, error: err.message });
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
    res.status(errorStatus(err)).json({ ok: false, error: err.message });
  }
});

/**
 * POST /api/routes/:id/toggle — Toggle route enabled/disabled
 */
router.post('/:id/toggle', async (req, res) => {
  try {
    const route = await routes.toggle(req.params.id);
    res.json({ ok: true, route: stripHash(route) });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to toggle route');
    res.status(errorStatus(err)).json({ ok: false, error: err.message });
  }
});

module.exports = router;
