'use strict';

// Logs & Monitoring (FEATURES.md "Logs & Monitoring"), mounted below
// /api/v1/logs:
//
//   GET    /meta                      sources, plugins, licence, limits
//   GET    /events                    entries of every source, newest first
//   GET    /events/stats              facets, histogram, KPI tiles
//   GET    /events/item?id=           one entry with fields and raw data
//   GET    /events/export             download (csv|json|ndjson|log|zip)
//   GET    /events/export/preview     first rows, count, size estimate
//   GET    /problems                  grouped errors/warnings of a range
//   GET    /problems/item?key=        one problem with correlations
//   PUT    /problems/state            status / notify of a problem
//   GET    /saved?kind=filter|export  saved filters and export templates
//   POST   /saved                     save one
//   DELETE /saved/:id
//
// Rights: an admin session reads every source; an API token with the `logs`
// right (the scope map sends /api/v1/logs to it) reads activity, access and
// sessions only — the server log and plugin logs hold internal details.
// Problems and saved views belong to the admin session. The licence feature
// log_export still gates exports of activity and access; server, plugin and
// session exports are free (diagnosis).

const { Router } = require('express');
const { requireAdminSession, isAdminSession } = require('../../middleware/auth');
const { hasFeature } = require('../../services/license');
const logEvents = require('../../services/logEvents');
const logProblems = require('../../services/logProblems');
const logExport = require('../../services/logExport');
const logQuery = require('../../utils/logQuery');
const logger = require('../../utils/logger');

const router = Router();

const TOKEN_SOURCES = ['activity', 'access', 'sessions'];
const LICENSED_SOURCES = ['activity', 'access'];
const SCOPES = ['view', 'selection', 'problem', 'window', 'report'];

function admin(req) {
  return !req.tokenAuth && isAdminSession(req);
}
function allowedSources(req) {
  return admin(req) ? logEvents.SOURCES.slice() : TOKEN_SOURCES.slice();
}

function fail(req, res, err, key = 'error.logs.events') {
  if (err instanceof logQuery.QueryError) {
    return res.status(400).json({ ok: false, error: req.t('error.logs.query'), code: err.code, param: err.param });
  }
  logger.warn({ err: err.message }, 'logs request failed');
  return res.status(500).json({ ok: false, error: req.t(key) });
}

/** Filter of the request; explicitly asked sources the caller may not read → 403. */
function filterOf(req, res, query = req.query) {
  const allowed = allowedSources(req);
  const filter = logEvents.parseFilter(query, { allowed });
  if (filter.sources && filter.sources.some((s) => !allowed.includes(s))) {
    res.status(403).json({ ok: false, error: req.t('error.logs.source_forbidden'), code: 'SOURCE_FORBIDDEN' });
    return null;
  }
  return filter;
}

router.get('/meta', (req, res) => {
  const allowed = allowedSources(req);
  const names = logEvents.pluginNames();
  res.set('Cache-Control', 'no-store');
  res.json({
    ok: true,
    admin: admin(req),
    sources: allowed,
    allSources: logEvents.SOURCES,
    levels: logEvents.LEVELS,
    licence: { log_export: hasFeature('log_export'), licensedSources: LICENSED_SOURCES },
    plugins: allowed.includes('plugins') ? [...names.entries()].map(([id, p]) => ({ id, name: p.name, version: p.version })) : [],
    serverLog: allowed.includes('server') ? { enabled: !!logger.serverLogFile.enabled } : null,
    limits: { page: 500, ids: logEvents.MAX_IDS },
    formats: logExport.FORMATS,
    columns: logExport.COLUMNS,
    knownCodes: [...logEvents.KNOWN_CODES],
  });
});

router.get('/events', async (req, res) => {
  try {
    const filter = filterOf(req, res);
    if (!filter) return;
    const before = logEvents.parseCursor(req.query.before);
    const limit = logEvents.parseLimit(req.query.limit, 100);
    const r = await logEvents.page(filter, { before, limit });
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, entries: r.entries.map((e) => logEvents.view(e)), next: r.next, more: r.more });
  } catch (err) {
    fail(req, res, err);
  }
});

router.get('/events/stats', async (req, res) => {
  try {
    const filter = filterOf(req, res);
    if (!filter) return;
    const bucketMs = logQuery.parseBucket(req.query.bucket, filter.from, filter.to);
    const r = await logEvents.stats(filter, { bucketMs });
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, ...r });
  } catch (err) {
    fail(req, res, err);
  }
});

router.get('/events/item', async (req, res) => {
  try {
    const id = logQuery.shortString(req.query.id, 'id', 64);
    const e = id ? await logEvents.get(id, allowedSources(req)) : null;
    if (!e) return res.status(404).json({ ok: false, error: req.t('error.logs.not_found') });
    const key = logProblems.keyOf(e);
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, entry: logEvents.view(e, { raw: true }), problem: key && logProblems.isProblem(e) ? { key } : null });
  } catch (err) {
    fail(req, res, err);
  }
});

// ─── Export ──────────────────────────────────────────────────────────────────

const bool = (v) => v === '1' || v === 'true' || v === 'on';

/**
 * Export options from the query:
 *   scope   view | selection (ids) | problem (problem=<key>) | window (around=<id>, window=10|60|300) | report
 *   format  csv | json | ndjson | log (report: always zip)
 *   columns comma list of time, level, source, message, fields, raw
 *   mask_ip, mask_email, pseudonymize  1/0
 *   tz      utc | IANA name (the browser's zone)
 *   note    1 = an entry in the activity log
 * plus the filter of /events (level, source, plugin, q, from, to).
 */
async function exportPlan(req, res) {
  const q = req.query || {};
  const scope = q.scope ? String(q.scope) : 'view';
  if (!SCOPES.includes(scope)) throw new logQuery.QueryError('scope');
  const format = scope === 'report' ? 'zip' : String(q.format || 'csv');
  if (format !== 'zip' && !logExport.FORMATS.includes(format)) throw new logQuery.QueryError('format');
  const cols = logQuery.list(q.columns);
  if (cols === null || cols.some((c) => !logExport.COLUMNS.includes(c))) throw new logQuery.QueryError('columns');
  const tz = q.tz ? String(q.tz) : 'utc';
  if (!logExport.validTimeZone(tz)) throw new logQuery.QueryError('tz');
  const allowed = allowedSources(req);
  let query = { ...q };
  let ids = null;
  if (scope === 'selection') ids = logEvents.parseIds(q.ids);
  if (scope === 'problem') {
    if (!admin(req)) { res.status(403).json({ ok: false, error: req.t('error.users.admin_required') }); return null; }
    if (!q.problem) throw new logQuery.QueryError('problem');
    query = { problem: q.problem, from: q.from, to: q.to, level: 'error,warn' };
  }
  if (scope === 'window') {
    const around = await logEvents.get(logQuery.shortString(q.around, 'around', 64), allowed);
    if (!around) { res.status(404).json({ ok: false, error: req.t('error.logs.not_found') }); return null; }
    const w = { 10: 10e3, 60: 60e3, 300: 300e3 }[String(q.window || '60')];
    if (!w) throw new logQuery.QueryError('window');
    query = { from: String(around.ts - w), to: String(around.ts + w) };
  }
  if (scope === 'report' && !admin(req)) { res.status(403).json({ ok: false, error: req.t('error.users.admin_required') }); return null; }
  const filter = filterOf(req, res, query);
  if (!filter) return null;
  // Licence: activity and access exports stay behind log_export.
  const reads = ids ? [...new Set(ids.map((id) => ({ a: 'activity', h: 'access' })[id[0]]).filter(Boolean))] : logEvents.sourcesOf(filter);
  const locked = hasFeature('log_export') ? [] : LICENSED_SOURCES.filter((s) => reads.includes(s));
  if (locked.length) {
    res.status(403).json({ ok: false, error: req.t('error.logs.export_licence'), code: 'LICENSE_LOG_EXPORT', locked });
    return null;
  }
  return {
    scope, format, filter, ids, tz,
    columns: cols.length ? cols : logExport.DEFAULT_COLUMNS,
    mask: logExport.masker({ maskIp: bool(q.mask_ip), maskEmail: bool(q.mask_email), pseudonymize: bool(q.pseudonymize) }),
    note: bool(q.note),
  };
}

function fileStamp(filter) {
  const f = (ms) => new Date(ms).toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
  const to = filter.to != null ? filter.to : Date.now();
  return filter.from != null ? `${f(filter.from)}_${f(to)}` : f(to);
}

async function writeOut(res, chunk) {
  if (res.write(chunk)) return true;
  return new Promise((resolve) => {
    const done = () => { res.off('drain', done); res.off('close', done); resolve(!res.destroyed); };
    res.on('drain', done);
    res.on('close', done);
  });
}

router.get('/events/export', async (req, res) => {
  let plan;
  try {
    plan = await exportPlan(req, res);
    if (!plan) return;
  } catch (err) {
    return fail(req, res, err, 'error.logs.export');
  }
  const ext = plan.format;
  const filename = `gatecontrol-${plan.scope === 'report' ? 'fehlerbericht' : 'logs'}_${fileStamp(plan.filter)}.${ext}`;
  res.setHeader('Content-Type', logExport.TYPES[ext]);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  let count = 0;
  try {
    if (plan.scope === 'report') {
      const buf = await logExport.report({
        from: plan.filter.from, to: plan.filter.to, allowed: plan.filter.allowed, mask: plan.mask, tz: plan.tz, lang: req.language,
      });
      res.end(buf);
    } else {
      const w = logExport.writer(plan);
      let open = await writeOut(res, w.header());
      if (plan.ids) {
        for (const e of await logEvents.byIds(plan.ids, plan.filter.allowed)) {
          count += 1;
          if (!(open = await writeOut(res, w.row(e)))) break;
        }
      } else {
        const r = await logEvents.each(plan.filter, async (e) => {
          count += 1;
          open = await writeOut(res, w.row(e));
          return open;
        }, { desc: true });
        count = r.count;
      }
      if (open) res.end(w.footer());
    }
  } catch (err) {
    logger.warn({ err: err.message }, 'logs export failed');
    if (!res.headersSent) {
      res.removeHeader('Content-Disposition');
      return fail(req, res, err, 'error.logs.export');
    }
    return res.destroy();
  }
  if (plan.note) {
    try {
      require('../../services/activity').log('logs_exported', `Logs exported: ${plan.scope}, ${ext}${plan.scope === 'report' ? '' : `, ${count} entries`}`, {
        source: 'admin', ipAddress: req.ip,
        details: { scope: plan.scope, format: ext, count, sources: logEvents.sourcesOf(plan.filter), userId: req.session && req.session.userId },
      });
    } catch { /* the export itself is done */ }
  }
});

router.get('/events/export/preview', async (req, res) => {
  try {
    const plan = await exportPlan(req, res);
    if (!plan) return;
    res.set('Cache-Control', 'no-store');
    if (plan.scope === 'report') {
      const problems = await logProblems.collect({ from: plan.filter.from, to: plan.filter.to, allowed: plan.filter.allowed });
      return res.json({ ok: true, count: problems.length, problems: problems.length, bytes: null, lines: [], filename: `gatecontrol-fehlerbericht_${fileStamp(plan.filter)}.zip` });
    }
    const w = logExport.writer(plan);
    const lines = [];
    let bytes = Buffer.byteLength(w.header());
    let count = 0;
    const take = (e) => {
      const row = w.row(e);
      bytes += Buffer.byteLength(row);
      count += 1;
      if (lines.length < 6) lines.push(row.replace(/^,?\n/, '').replace(/\n$/, ''));
    };
    if (plan.ids) for (const e of await logEvents.byIds(plan.ids, plan.filter.allowed)) take(e);
    else await logEvents.each(plan.filter, async (e) => { take(e); return true; }, { desc: true, max: 200000 });
    bytes += Buffer.byteLength(w.footer());
    const header = plan.format === 'csv' ? w.header().trim() : null;
    res.json({ ok: true, count, bytes, header, lines, filename: `gatecontrol-logs_${fileStamp(plan.filter)}.${plan.format}` });
  } catch (err) {
    fail(req, res, err, 'error.logs.export');
  }
});

// ─── Problems (admin session) ────────────────────────────────────────────────

function range(req) {
  const from = logQuery.parseTime(req.query.from, 'from');
  const to = logQuery.parseTime(req.query.to, 'to');
  if (from != null && to != null && from > to) throw new logQuery.QueryError('to');
  return { from, to };
}

router.get('/problems', requireAdminSession, async (req, res) => {
  try {
    const status = req.query.status ? String(req.query.status) : 'open';
    if (!logProblems.STATUSES.includes(status)) throw new logQuery.QueryError('status');
    const sort = req.query.sort ? String(req.query.sort) : 'last';
    if (!['last', 'count', 'severity'].includes(sort)) throw new logQuery.QueryError('sort');
    const r = await logProblems.listProblems({ ...range(req), allowed: logEvents.SOURCES, status, sort });
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, ...r });
  } catch (err) {
    fail(req, res, err, 'error.logs.problems');
  }
});

router.get('/problems/item', requireAdminSession, async (req, res) => {
  try {
    const key = logQuery.shortString(req.query.key, 'key', 300);
    if (!key) throw new logQuery.QueryError('key');
    const p = await logProblems.getProblem(key, { ...range(req), allowed: logEvents.SOURCES });
    if (!p) return res.status(404).json({ ok: false, error: req.t('error.logs.not_found') });
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, problem: p });
  } catch (err) {
    fail(req, res, err, 'error.logs.problems');
  }
});

router.put('/problems/state', requireAdminSession, (req, res) => {
  try {
    const b = req.body || {};
    if (typeof b.key !== 'string' || !b.key || b.key.length > 300 || !/^[chm]:/.test(b.key)) throw new logQuery.QueryError('key');
    if (b.status !== undefined && !logProblems.STATUSES.includes(b.status)) throw new logQuery.QueryError('status');
    if (b.notifyOnReturn !== undefined && typeof b.notifyOnReturn !== 'boolean') throw new logQuery.QueryError('notifyOnReturn');
    if (b.title !== undefined && (typeof b.title !== 'string' || b.title.length > 300)) throw new logQuery.QueryError('title');
    const row = logProblems.setState(b.key, { status: b.status, notifyOnReturn: b.notifyOnReturn, title: b.title }, req.session.userId);
    res.json({ ok: true, state: { key: row.key, status: row.status, notifyOnReturn: !!row.notify_on_return,
      mutedUntil: row.muted_until ? new Date(row.muted_until).toISOString() : null } });
  } catch (err) {
    fail(req, res, err, 'error.logs.problems');
  }
});

// ─── Saved filters and export templates (admin session) ─────────────────────

const KINDS = ['filter', 'export'];

router.get('/saved', requireAdminSession, (req, res) => {
  try {
    const db = require('../../db/connection').getDb();
    const rows = db.prepare('SELECT id, kind, name, data, created_at FROM log_saved_views ORDER BY kind, name COLLATE NOCASE').all();
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, saved: rows.map((r) => {
      let data = {};
      try { data = JSON.parse(r.data) || {}; } catch { data = {}; }
      return { id: r.id, kind: r.kind, name: r.name, data, createdAt: new Date(r.created_at).toISOString() };
    }) });
  } catch (err) {
    fail(req, res, err, 'error.logs.saved');
  }
});

router.post('/saved', requireAdminSession, (req, res) => {
  try {
    const b = req.body || {};
    if (!KINDS.includes(b.kind)) throw new logQuery.QueryError('kind');
    const name = typeof b.name === 'string' ? b.name.trim() : '';
    if (!name || name.length > 80) throw new logQuery.QueryError('name');
    if (!b.data || typeof b.data !== 'object' || Array.isArray(b.data)) throw new logQuery.QueryError('data');
    const data = {};
    for (const [k, v] of Object.entries(b.data)) {
      if (!/^[a-z_]{1,24}$/i.test(k)) continue;
      if (typeof v === 'string' && v.length <= 1000) data[k] = v;
      else if (typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) data[k] = v;
    }
    const db = require('../../db/connection').getDb();
    if (db.prepare('SELECT COUNT(*) AS c FROM log_saved_views').get().c >= 200) {
      return res.status(409).json({ ok: false, error: req.t('error.logs.saved_full'), code: 'TOO_MANY' });
    }
    const info = db.prepare('INSERT INTO log_saved_views (kind, name, data, created_by, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(b.kind, name, JSON.stringify(data), req.session.userId, Date.now());
    res.status(201).json({ ok: true, saved: { id: Number(info.lastInsertRowid), kind: b.kind, name, data } });
  } catch (err) {
    fail(req, res, err, 'error.logs.saved');
  }
});

router.delete('/saved/:id', requireAdminSession, (req, res) => {
  const id = /^\d{1,12}$/.test(req.params.id) ? Number(req.params.id) : null;
  if (!id) return res.status(400).json({ ok: false, error: req.t('error.logs.query'), code: 'INVALID_QUERY', param: 'id' });
  const db = require('../../db/connection').getDb();
  const r = db.prepare('DELETE FROM log_saved_views WHERE id = ?').run(id);
  if (!r.changes) return res.status(404).json({ ok: false, error: req.t('error.logs.not_found') });
  res.json({ ok: true });
});

module.exports = router;
