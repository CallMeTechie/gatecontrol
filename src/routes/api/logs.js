'use strict';

const { Router } = require('express');
const activity = require('../../services/activity');
const accessLog = require('../../services/accessLog');
const { requireFeature } = require('../../middleware/license');

const router = Router();

/**
 * GET /api/logs/activity?page=1&limit=50
 * Returns paginated activity log
 */
router.get('/activity', (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));

    const result = activity.getPaginated(page, limit);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: req.t('error.logs.activity') });
  }
});

/**
 * GET /api/logs/recent?limit=10
 * Returns recent activity entries (for dashboard widget)
 */
router.get('/recent', (req, res) => {
  try {
    const limit = Math.min(20, Math.max(1, parseInt(req.query.limit, 10) || 6));
    const entries = activity.getRecent(limit);
    res.json({ ok: true, entries });
  } catch (err) {
    res.status(500).json({ ok: false, error: req.t('error.logs.recent') });
  }
});

/**
 * GET /api/logs/access?page=1&limit=50&domain=&status=&method=
 * Returns paginated Caddy access log entries
 */
router.get('/access', async (req, res) => {
  try {
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const filters = {
      page: req.query.page || 1,
      domain: req.query.domain || '',
      status: req.query.status || '',
      method: req.query.method || '',
    };

    const result = await accessLog.getRecent(limit, filters);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: req.t('error.logs.access') });
  }
});

// ─── CSV helper ───────────────────────────────────
function escapeCsvField(value) {
  if (value == null) return '';
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

function toCsvRow(fields) {
  return fields.map(escapeCsvField).join(',');
}

function formatDateForFilename() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

/**
 * GET /api/logs/activity/export?format=csv|json
 * Export full activity log as file download
 */
router.get('/activity/export', requireFeature('log_export'), (req, res) => {
  try {
    const format = (req.query.format || 'json').toLowerCase();
    if (format !== 'csv' && format !== 'json') {
      return res.status(400).json({ ok: false, error: 'Invalid format. Use csv or json.' });
    }

    const entries = activity.getAll();
    const dateStr = formatDateForFilename();
    const filename = `gatecontrol-activity-${dateStr}.${format}`;

    if (format === 'json') {
      const data = entries.map(e => ({
        timestamp: e.created_at,
        event: e.event_type,
        severity: e.severity,
        message: e.message,
        details: e.details,
      }));
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      return res.send(JSON.stringify(data, null, 2));
    }

    // CSV
    const header = 'timestamp,event,severity,message,details';
    const rows = entries.map(e => toCsvRow([
      e.created_at,
      e.event_type,
      e.severity,
      e.message,
      e.details ? JSON.stringify(e.details) : '',
    ]));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(header + '\n' + rows.join('\n'));
  } catch (err) {
    res.status(500).json({ ok: false, error: req.t('error.logs.export') });
  }
});

/**
 * GET /api/logs/access/export?format=csv|json&domain=&status=&method=
 * Export access log as file download
 */
router.get('/access/export', requireFeature('log_export'), async (req, res) => {
  try {
    const format = (req.query.format || 'json').toLowerCase();
    if (format !== 'csv' && format !== 'json') {
      return res.status(400).json({ ok: false, error: 'Invalid format. Use csv or json.' });
    }

    const filters = {
      domain: req.query.domain || '',
      status: req.query.status || '',
      method: req.query.method || '',
    };

    const entries = await accessLog.getAllFiltered(filters);
    const dateStr = formatDateForFilename();
    const filename = `gatecontrol-access-${dateStr}.${format}`;

    if (format === 'json') {
      const data = entries.map(e => ({
        timestamp: e.timestamp,
        domain: e.host,
        method: e.method,
        path: e.uri,
        status: e.status,
        remote_ip: e.remote_ip,
        user_agent: e.user_agent,
      }));
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      return res.send(JSON.stringify(data, null, 2));
    }

    // CSV
    const header = 'timestamp,domain,method,path,status,remote_ip,user_agent';
    const rows = entries.map(e => toCsvRow([
      e.timestamp,
      e.host,
      e.method,
      e.uri,
      e.status,
      e.remote_ip,
      e.user_agent,
    ]));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(header + '\n' + rows.join('\n'));
  } catch (err) {
    res.status(500).json({ ok: false, error: req.t('error.logs.export') });
  }
});

module.exports = router;
