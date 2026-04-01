'use strict';

const { Router } = require('express');
const rdp = require('../../services/rdp');
const rdpMonitor = require('../../services/rdpMonitor');
const rdpSessions = require('../../services/rdpSessions');
const wol = require('../../services/wol');
const { getServerPublicKey, publicKeyEncrypt } = require('../../utils/crypto');
const logger = require('../../utils/logger');
const { requireFeature } = require('../../middleware/license');

const router = Router();

// All RDP routes require the remote_desktop feature
router.use(requireFeature('remote_desktop'));

// --- CRUD ------------------------------------------------------

/**
 * GET /api/v1/rdp -- List all RDP routes
 */
router.get('/', (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 250, 1), 250);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const list = rdp.getAll({ limit, offset });

    // Attach status from cache
    const statuses = rdpMonitor.getAllStatus();
    const activeCounts = rdpSessions.getActiveSessionCounts();
    const activeMap = {};
    for (const ac of activeCounts) {
      activeMap[ac.rdp_route_id] = ac.count;
    }

    const enriched = list.map(r => ({
      ...r,
      status: statuses[r.id] || { online: false, lastCheck: null },
      active_sessions: activeMap[r.id] || 0,
    }));

    res.json({ ok: true, routes: enriched, limit, offset });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to list RDP routes');
    res.status(500).json({ ok: false, error: req.t('error.rdp.list') });
  }
});

/**
 * GET /api/v1/rdp/status -- Bulk status for all RDP routes
 */
router.get('/status', async (req, res) => {
  try {
    const results = await rdpMonitor.checkAll();
    res.json({ ok: true, statuses: results });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to get bulk RDP status');
    res.status(500).json({ ok: false, error: req.t('error.rdp.status') });
  }
});

/**
 * GET /api/v1/rdp/history -- Global session history
 */
router.get('/history', (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const { status, since, until } = req.query;
    const history = rdpSessions.getGlobalHistory({ limit, offset, status, since, until });
    res.json({ ok: true, history, limit, offset });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to get RDP history');
    res.status(500).json({ ok: false, error: req.t('error.rdp.history') });
  }
});

/**
 * GET /api/v1/rdp/history/export -- Export session history as CSV or JSON
 */
router.get('/history/export', (req, res) => {
  try {
    const { format, since, until, routeId } = req.query;
    if (format === 'csv') {
      const csv = rdpSessions.exportCsv({ since, until, routeId: routeId ? parseInt(routeId, 10) : null });
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="rdp-sessions.csv"');
      return res.send(csv);
    }
    // Default: JSON
    const history = rdpSessions.getGlobalHistory({
      limit: 10000,
      since,
      until,
    });
    res.json({ ok: true, history });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to export RDP history');
    res.status(500).json({ ok: false, error: req.t('error.rdp.export') });
  }
});

/**
 * GET /api/v1/rdp/pubkey -- Server public key for E2EE
 */
router.get('/pubkey', (req, res) => {
  try {
    const publicKey = getServerPublicKey();
    res.json({ ok: true, publicKey });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to get server public key');
    res.status(500).json({ ok: false, error: req.t('error.rdp.pubkey') });
  }
});

/**
 * GET /api/v1/rdp/rotation/pending -- Pending credential rotations
 */
router.get('/rotation/pending', (req, res) => {
  try {
    const { getDb } = require('../../db/connection');
    const db = getDb();
    const pending = db.prepare(`
      SELECT id, name, credential_rotation_days, credential_rotation_last
      FROM rdp_routes
      WHERE credential_rotation_enabled = 1
      AND (
        credential_rotation_last IS NULL
        OR datetime(credential_rotation_last, '+' || credential_rotation_days || ' days') < datetime('now')
      )
    `).all();
    res.json({ ok: true, pending });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to get pending rotations');
    res.status(500).json({ ok: false, error: req.t('error.rdp.rotation') });
  }
});

/**
 * POST /api/v1/rdp/batch -- Batch operations
 */
router.post('/batch', (req, res) => {
  try {
    const { action, ids } = req.body;
    if (!action || !['enable', 'disable', 'delete'].includes(action)) {
      return res.status(400).json({ ok: false, error: req.t('error.batch.invalid_action') });
    }
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ ok: false, error: req.t('error.batch.no_ids') });
    }
    const affected = rdp.batch(action, ids);
    res.json({ ok: true, affected });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to batch operate on RDP routes');
    res.status(500).json({ ok: false, error: req.t('error.batch.failed') });
  }
});

/**
 * POST /api/v1/rdp -- Create new RDP route
 */
router.post('/', (req, res) => {
  try {
    const route = rdp.create(req.body);
    res.status(201).json({ ok: true, route });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to create RDP route');
    if (err.fields) {
      return res.status(400).json({ ok: false, error: err.message, fields: err.fields });
    }
    res.status(500).json({ ok: false, error: req.t('error.rdp.create') });
  }
});

/**
 * GET /api/v1/rdp/:id -- Get single RDP route
 */
router.get('/:id', (req, res) => {
  try {
    const route = rdp.getById(parseInt(req.params.id, 10));
    if (!route) return res.status(404).json({ ok: false, error: req.t('error.rdp.not_found') });
    res.json({ ok: true, route });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to get RDP route');
    res.status(500).json({ ok: false, error: req.t('error.rdp.get') });
  }
});

/**
 * PATCH /api/v1/rdp/:id -- Update RDP route
 */
router.patch('/:id', (req, res) => {
  try {
    const route = rdp.update(parseInt(req.params.id, 10), req.body);
    res.json({ ok: true, route });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to update RDP route');
    if (err.message === 'RDP route not found') {
      return res.status(404).json({ ok: false, error: req.t('error.rdp.not_found') });
    }
    if (err.fields) {
      return res.status(400).json({ ok: false, error: err.message, fields: err.fields });
    }
    res.status(500).json({ ok: false, error: req.t('error.rdp.update') });
  }
});

/**
 * DELETE /api/v1/rdp/:id -- Delete RDP route
 */
router.delete('/:id', (req, res) => {
  try {
    rdp.remove(parseInt(req.params.id, 10));
    res.json({ ok: true });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to delete RDP route');
    if (err.message === 'RDP route not found') {
      return res.status(404).json({ ok: false, error: req.t('error.rdp.not_found') });
    }
    res.status(500).json({ ok: false, error: req.t('error.rdp.delete') });
  }
});

/**
 * PUT /api/v1/rdp/:id/toggle -- Toggle RDP route enabled/disabled
 */
router.put('/:id/toggle', (req, res) => {
  try {
    const route = rdp.toggle(parseInt(req.params.id, 10));
    res.json({ ok: true, route });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to toggle RDP route');
    if (err.message === 'RDP route not found') {
      return res.status(404).json({ ok: false, error: req.t('error.rdp.not_found') });
    }
    res.status(500).json({ ok: false, error: req.t('error.rdp.toggle') });
  }
});

// --- Credentials -----------------------------------------------

/**
 * GET /api/v1/rdp/:id/credentials -- Get credentials (decrypted)
 */
router.get('/:id/credentials', (req, res) => {
  try {
    const creds = rdp.getCredentials(parseInt(req.params.id, 10));
    res.json({ ok: true, credentials: creds });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to get RDP credentials');
    if (err.message === 'RDP route not found') {
      return res.status(404).json({ ok: false, error: req.t('error.rdp.not_found') });
    }
    res.status(500).json({ ok: false, error: req.t('error.rdp.credentials') });
  }
});

/**
 * PUT /api/v1/rdp/:id/credentials -- Set credentials
 */
router.put('/:id/credentials', (req, res) => {
  try {
    const { username, password, domain, credential_mode } = req.body;
    rdp.setCredentials(parseInt(req.params.id, 10), { username, password, domain, credential_mode });
    res.json({ ok: true });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to set RDP credentials');
    if (err.message === 'RDP route not found') {
      return res.status(404).json({ ok: false, error: req.t('error.rdp.not_found') });
    }
    res.status(500).json({ ok: false, error: req.t('error.rdp.credentials') });
  }
});

/**
 * DELETE /api/v1/rdp/:id/credentials -- Clear credentials
 */
router.delete('/:id/credentials', (req, res) => {
  try {
    rdp.clearCredentials(parseInt(req.params.id, 10));
    res.json({ ok: true });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to clear RDP credentials');
    if (err.message === 'RDP route not found') {
      return res.status(404).json({ ok: false, error: req.t('error.rdp.not_found') });
    }
    res.status(500).json({ ok: false, error: req.t('error.rdp.credentials') });
  }
});

// --- Wake-on-LAN -----------------------------------------------

/**
 * POST /api/v1/rdp/:id/wol -- Send Wake-on-LAN magic packet
 */
router.post('/:id/wol', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const route = rdp.getById(id);
    if (!route) return res.status(404).json({ ok: false, error: req.t('error.rdp.not_found') });
    if (!route.wol_enabled || !route.wol_mac_address) {
      return res.status(400).json({ ok: false, error: req.t('error.rdp.wol_not_configured') });
    }
    await wol.sendMagicPacket(route.wol_mac_address);
    res.json({ ok: true, message: 'Magic packet sent' });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to send WoL packet');
    res.status(500).json({ ok: false, error: req.t('error.rdp.wol_failed') });
  }
});

/**
 * GET /api/v1/rdp/:id/wol/status -- Check reachability after WoL
 */
router.get('/:id/wol/status', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const route = rdp.getById(id);
    if (!route) return res.status(404).json({ ok: false, error: req.t('error.rdp.not_found') });

    const result = await rdpMonitor.checkRouteById(id);
    res.json({ ok: true, ...result });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to check WoL status');
    res.status(500).json({ ok: false, error: req.t('error.rdp.status') });
  }
});

// --- Monitoring ------------------------------------------------

/**
 * GET /api/v1/rdp/:id/status -- Online/Offline check
 */
router.get('/:id/status', async (req, res) => {
  try {
    const result = await rdpMonitor.checkRouteById(parseInt(req.params.id, 10));
    res.json({ ok: true, ...result });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to check RDP status');
    if (err.message === 'RDP route not found') {
      return res.status(404).json({ ok: false, error: req.t('error.rdp.not_found') });
    }
    res.status(500).json({ ok: false, error: req.t('error.rdp.status') });
  }
});

// --- Session History -------------------------------------------

/**
 * GET /api/v1/rdp/:id/history -- Connection history per route
 */
router.get('/:id/history', (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const history = rdpSessions.getHistory(parseInt(req.params.id, 10), { limit, offset });
    res.json({ ok: true, history, limit, offset });
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to get RDP route history');
    res.status(500).json({ ok: false, error: req.t('error.rdp.history') });
  }
});

// --- Maintenance -----------------------------------------------

/**
 * GET /api/v1/rdp/:id/maintenance -- Read maintenance window
 */
router.get('/:id/maintenance', (req, res) => {
  try {
    const route = rdp.getById(parseInt(req.params.id, 10));
    if (!route) return res.status(404).json({ ok: false, error: req.t('error.rdp.not_found') });
    let schedule = null;
    try { schedule = route.maintenance_schedule ? JSON.parse(route.maintenance_schedule) : null; } catch {}
    res.json({
      ok: true,
      maintenance: {
        enabled: !!route.maintenance_enabled,
        schedule,
      },
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: req.t('error.rdp.maintenance') });
  }
});

/**
 * PUT /api/v1/rdp/:id/maintenance -- Set maintenance window
 */
router.put('/:id/maintenance', (req, res) => {
  try {
    const { enabled, schedule } = req.body;
    rdp.update(parseInt(req.params.id, 10), {
      maintenance_enabled: enabled,
      maintenance_schedule: schedule,
    });
    res.json({ ok: true });
  } catch (err) {
    if (err.message === 'RDP route not found') {
      return res.status(404).json({ ok: false, error: req.t('error.rdp.not_found') });
    }
    res.status(500).json({ ok: false, error: req.t('error.rdp.maintenance') });
  }
});

/**
 * POST /api/v1/rdp/:id/rotation/ack -- Acknowledge credential rotation
 */
router.post('/:id/rotation/ack', (req, res) => {
  try {
    const { getDb } = require('../../db/connection');
    const db = getDb();
    const id = parseInt(req.params.id, 10);
    const route = db.prepare('SELECT id, name FROM rdp_routes WHERE id = ?').get(id);
    if (!route) return res.status(404).json({ ok: false, error: req.t('error.rdp.not_found') });

    db.prepare("UPDATE rdp_routes SET credential_rotation_last = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: req.t('error.rdp.rotation') });
  }
});

module.exports = router;
