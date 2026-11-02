'use strict';

const { Router } = require('express');
const activity = require('../../services/activity');
const accessLog = require('../../services/accessLog');
const { requireFeature } = require('../../middleware/license');
const { requireAdminSession } = require('../../middleware/auth');
const serverLog = require('../../services/serverLog');
const logQuery = require('../../utils/logQuery');
const logger = require('../../utils/logger');

const router = Router();

// Logs & Monitoring: every source as one stream, problems, saved views (logsHub.js).
router.use(require('./logsHub'));

// ─── Optional filters of activity and access ──────
// Without them both endpoints answer exactly as before. Invalid values → 400.

function wantCounts(q) {
  return q.counts === '1' || q.counts === 'true';
}

/**
 * Activity filter from the query: severity (comma list of info, success,
 * warning, error), category (activityCategories name), event (comma list of
 * exact event types, ≤ 20), q (text in message, event type or source),
 * from/to (epoch ms or ISO). → { filter, active }
 */
function activityFilter(q) {
  const categories = require('../../services/activityCategories');
  const severities = logQuery.list(q.severity);
  if (severities === null || severities.some((v) => !activity.SEVERITIES.includes(v))) throw new logQuery.QueryError('severity');
  let category = null;
  if (q.category !== undefined && q.category !== '' && q.category !== 'all') {
    if (typeof q.category !== 'string' || !categories.isCategory(q.category)) throw new logQuery.QueryError('category');
    category = q.category;
  }
  const eventTypes = logQuery.list(q.event);
  if (eventTypes === null || eventTypes.length > 20 || eventTypes.some((v) => !activity.EVENT_TYPE_RE.test(v))) {
    throw new logQuery.QueryError('event');
  }
  const filter = {
    severities: severities.length && severities.length < activity.SEVERITIES.length ? severities : null,
    category,
    eventTypes,
    q: logQuery.shortString(q.q, 'q', 200).trim(),
    from: logQuery.parseTime(q.from, 'from'),
    to: logQuery.parseTime(q.to, 'to'),
  };
  const active = !!(filter.severities || filter.category || filter.eventTypes.length || filter.q || filter.from != null || filter.to != null);
  return { filter, active };
}

/**
 * Access filter: domain, status (one value or comma list; each selects its
 * class, 404 → 4xx), method, q (host, path, client IP, user agent), from/to.
 */
function accessFilter(q) {
  const str = (v, name, max) => logQuery.shortString(v, name, max);
  const status = str(q.status, 'status', 40);
  if (status && !/^\d{3}(,\d{3})*$/.test(status)) throw new logQuery.QueryError('status');
  return {
    domain: str(q.domain, 'domain', 253),
    status,
    method: str(q.method, 'method', 16),
    q: str(q.q, 'q', 200).trim(),
    from: logQuery.parseTime(q.from, 'from'),
    to: logQuery.parseTime(q.to, 'to'),
  };
}

function queryError(req, res, err, fallbackKey) {
  if (err instanceof logQuery.QueryError) {
    return res.status(400).json({ ok: false, error: req.t('error.logs.query'), code: err.code, param: err.param });
  }
  return res.status(500).json({ ok: false, error: req.t(fallbackKey) });
}

/**
 * GET /api/logs/activity?page=1&limit=50
 *   [&severity=warning,error&category=&event=&q=&from=&to=][&counts=1&bucket=]
 * Returns paginated activity log; with counts=1 also { counts (per severity,
 * without the severity filter), events (event types with count, top 100),
 * histogram { bucketMs, buckets[{ t, time, info, success, warning, error }] } }.
 */
router.get('/activity', (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const { filter, active } = activityFilter(req.query);
    const counts = wantCounts(req.query);

    const result = active ? activity.getFiltered(filter, page, limit) : activity.getPaginated(page, limit);
    if (counts) {
      const bucketMs = logQuery.parseBucket(req.query.bucket, filter.from, filter.to);
      Object.assign(result, activity.getCounts(filter, { bucketMs }));
    }
    res.json({ ok: true, ...result });
  } catch (err) {
    queryError(req, res, err, 'error.logs.activity');
  }
});

/**
 * GET /api/logs/recent?limit=10[&category=login|peer|route|security]
 * Returns recent activity entries (for the dashboard feed). `category` is an
 * allow-listed name (services/activityCategories.js) mapped to event_type
 * prefixes on the server — never a raw prefix; anything else is a 400.
 */
router.get('/recent', (req, res) => {
  try {
    const limit = Math.min(20, Math.max(1, parseInt(req.query.limit, 10) || 6));
    const categories = require('../../services/activityCategories');
    const raw = req.query.category;
    let category = null;
    if (raw !== undefined && raw !== '' && raw !== 'all') {
      if (typeof raw !== 'string' || !categories.isCategory(raw)) {
        return res.status(400).json({ ok: false, error: 'invalid category', code: 'INVALID_CATEGORY' });
      }
      category = raw;
    }
    const entries = activity.getRecent(limit, 0, { category })
      .map((e) => ({ ...e, category: categories.categoryOf(e.event_type) }));
    res.json({ ok: true, category: category || 'all', entries });
  } catch (err) {
    res.status(500).json({ ok: false, error: req.t('error.logs.recent') });
  }
});

/**
 * GET /api/logs/access?page=1&limit=50&domain=&status=&method=
 *   [&q=&from=&to=][&counts=1&bucket=]
 * Returns paginated Caddy access log entries; with counts=1 also { counts
 * (per status class, without the status filter), histogram }.
 */
router.get('/access', async (req, res) => {
  try {
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const filters = { page: req.query.page || 1, ...accessFilter(req.query) };
    const counts = wantCounts(req.query);
    const bucketMs = counts ? logQuery.parseBucket(req.query.bucket, filters.from, filters.to) : null;

    const result = await accessLog.getRecent(limit, filters, { counts, bucketMs });
    res.json({ ok: true, ...result });
  } catch (err) {
    queryError(req, res, err, 'error.logs.access');
  }
});

// ─── CSV helper ───────────────────────────────────
// Neutralize Excel/Sheets formula-injection. User-agents and URIs come from
// unauthenticated public HTTP traffic, so a crafted request header can land
// as `=IMPORTXML(...)` in a CSV cell and exfiltrate data when the admin
// opens the export. Prefix the cell with a single quote so the spreadsheet
// treats it as literal text.
const FORMULA_TRIGGERS = /^[=+\-@\t\r]/;
function escapeCsvField(value) {
  if (value == null) return '';
  let str = String(value);
  if (FORMULA_TRIGGERS.test(str)) str = "'" + str;
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
 * GET /api/logs/activity/export?format=csv|json[&severity=&category=&event=&q=&from=&to=]
 * Export the activity log (the filters of /activity, all entries without) as file download
 */
router.get('/activity/export', requireFeature('log_export'), (req, res) => {
  try {
    const format = (req.query.format || 'json').toLowerCase();
    if (format !== 'csv' && format !== 'json') {
      return res.status(400).json({ ok: false, error: 'Invalid format. Use csv or json.' });
    }

    const { filter, active } = activityFilter(req.query);
    const entries = active ? activity.getAllFiltered(filter) : activity.getAll();
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
    queryError(req, res, err, 'error.logs.export');
  }
});

/**
 * GET /api/logs/access/export?format=csv|json&domain=&status=&method=[&q=&from=&to=]
 * Export access log as file download
 */
router.get('/access/export', requireFeature('log_export'), async (req, res) => {
  try {
    const format = (req.query.format || 'json').toLowerCase();
    if (format !== 'csv' && format !== 'json') {
      return res.status(400).json({ ok: false, error: 'Invalid format. Use csv or json.' });
    }

    const filters = accessFilter(req.query);

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
    queryError(req, res, err, 'error.logs.export');
  }
});

// ─── Server log (the host's own log file) ─────────
// utils/serverLogFile.js writes it, services/serverLog.js reads it.
// Administrators only (session with the admin role, like Support-Pakete):
// the server log holds internal details — plugin ids and errors, paths,
// stack traces — that the `logs` right (activity + access log) does not
// cover, so API tokens are refused even with that scope. Export is part of
// diagnosis/support and therefore not behind the `log_export` licence.

function serverLogError(req, res, err) {
  if (err instanceof logQuery.QueryError) {
    return res.status(400).json({ ok: false, error: req.t('error.logs.query'), code: err.code, param: err.param });
  }
  logger.warn({ err: err.message }, 'server log could not be read');
  return res.status(500).json({ ok: false, error: req.t('error.logs.server_read') });
}

/**
 * GET /api/v1/logs/server?level=error,warn&q=&from=&to=&plugin=&module=&msg=
 *     &field=key:value&before=<cursor>&limit=1..500&counts=1&bucket=auto|1m|5m|15m|1h|6h|1d
 * → { ok, enabled, entries, next, more, files, retention, counts?, histogram? }
 * Newest first; `next` goes into `before` for the next (older) page.
 */
router.get('/server', requireAdminSession, async (req, res) => {
  try {
    const q = req.query || {};
    const filter = serverLog.parseFilter(q);
    const before = serverLog.parseCursor(q.before);
    const limit = serverLog.parseLimit(q.limit);
    const counts = q.counts === '1' || q.counts === 'true';
    const bucketMs = counts ? logQuery.parseBucket(q.bucket, filter.from, filter.to) : null;
    const result = await serverLog.query(filter, { before, limit, counts, bucketMs });
    const opts = serverLog.options();
    res.set('Cache-Control', 'no-store');
    res.json({
      ok: true,
      enabled: !!logger.serverLogFile.enabled,
      ...result,
      retention: { maxBytes: opts.maxBytes, files: opts.files },
    });
  } catch (err) {
    serverLogError(req, res, err);
  }
});

const SERVER_EXPORT_FORMATS = ['log', 'json', 'csv'];

/**
 * GET /api/v1/logs/server/export?format=log|json|csv + the filters of /server
 * Oldest first, streamed; at most serverLog.MAX_EXPORT_LINES lines.
 *   log   "<ISO time> <LEVEL> <msg> <fields as JSON>" per line
 *   json  array of the pino objects as written (already redacted)
 *   csv   time,level,msg,plugin,module,details
 */
router.get('/server/export', requireAdminSession, async (req, res) => {
  let filter;
  const format = String(req.query.format || 'log').toLowerCase();
  try {
    if (!SERVER_EXPORT_FORMATS.includes(format)) throw new logQuery.QueryError('format');
    filter = serverLog.parseFilter(req.query || {});
  } catch (err) {
    return serverLogError(req, res, err);
  }
  const d = new Date();
  const stamp = formatDateForFilename() + '-' + String(d.getHours()).padStart(2, '0') + String(d.getMinutes()).padStart(2, '0');
  const filename = `gatecontrol-server-${stamp}.${format}`;
  const type = { log: 'text/plain; charset=utf-8', json: 'application/json; charset=utf-8', csv: 'text/csv; charset=utf-8' }[format];
  let aborted = false;
  res.on('close', () => { if (!res.writableEnded) aborted = true; });
  res.setHeader('Content-Type', type);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  const write = (chunk) => new Promise((resolve) => {
    if (aborted) return resolve(false);
    if (res.write(chunk)) return resolve(true);
    const done = () => { res.off('drain', done); res.off('close', done); resolve(!aborted); };
    res.on('drain', done);
    res.on('close', done);
  });
  try {
    let first = true;
    if (format === 'json') await write('[');
    if (format === 'csv') await write('time,level,msg,plugin,module,details\n');
    const { capped } = await serverLog.each(filter, (obj) => {
      if (format === 'log') return write(serverLog.textLine(obj) + '\n');
      if (format === 'json') {
        const s = (first ? '\n' : ',\n') + JSON.stringify(obj);
        first = false;
        return write(s);
      }
      const rest = serverLog.restOf(obj);
      const ts = Number(obj.time);
      return write(toCsvRow([
        Number.isFinite(ts) ? new Date(ts).toISOString() : '',
        serverLog.levelName(Number(obj.level) || 30),
        obj.msg,
        rest.plugin == null || typeof rest.plugin === 'object' ? '' : rest.plugin,
        rest.module == null || typeof rest.module === 'object' ? '' : rest.module,
        Object.keys(rest).length ? JSON.stringify(rest) : '',
      ]) + '\n');
    });
    if (format === 'json') await write(first ? ']\n' : '\n]\n');
    if (capped) logger.info({ max: serverLog.MAX_EXPORT_LINES }, 'server log export capped');
    if (!aborted) res.end();
  } catch (err) {
    if (!res.headersSent) {
      res.removeHeader('Content-Disposition');
      return serverLogError(req, res, err);
    }
    logger.warn({ err: err.message }, 'server log export failed');
    res.destroy();
  }
});

module.exports = router;
