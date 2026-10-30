'use strict';

/**
 * Admin API of the storage targets (docs/storage-targets.md,
 * services/storageTargets/). Admin session only, like /directories: API
 * tokens and member sessions get 403. CSRF and the API limiter come from the
 * /api/v1 router. Secrets (password, secret key) are write-only: answers
 * carry `secretSet` per field.
 *
 *   GET    /api/v1/storage-targets              list (with the last check and what uses each) and the media cache
 *   PUT    /api/v1/storage-targets/cache        { limitBytes } the cache of plugin media kept on targets (null = default)
 *   POST   /api/v1/storage-targets              create { kind, label, …settings, …secrets }
 *   POST   /api/v1/storage-targets/check        check unsaved settings { kind, …[, id] } (nothing stored)
 *   GET    /api/v1/storage-targets/choices      peers and routes for "via" (SMB: L4 routes; WebDAV: L4 and HTTP)
 *   GET    /api/v1/storage-targets/:id
 *   PATCH  /api/v1/storage-targets/:id          change (a secret left empty keeps the stored one)
 *   DELETE /api/v1/storage-targets/:id          remove (409 while an area uses it)
 *   POST   /api/v1/storage-targets/:id/check    check the stored target (result kept on it)
 */

const express = require('express');
const { requireAdminSession } = require('../../middleware/auth');
const targets = require('../../services/storageTargets');
const activity = require('../../services/activity');
const logger = require('../../utils/logger');

const router = express.Router();
router.use(requireAdminSession);

const STATUS = { invalid: 400, not_found: 404, in_use: 409, limit: 409 };

function tr(req, key, fallback, params) {
  const s = req.t ? req.t(key, params) : key;
  return s && s !== key ? s : fallback;
}

function fail(req, res, e) {
  const code = e && e.code;
  if (STATUS[code]) {
    const field = e.field || null;
    return res.status(STATUS[code]).json({ ok: false, code, field,
      error: field ? tr(req, `plugins.stg.err.field_${field}`, tr(req, 'plugins.stg.err.invalid', 'Invalid input')) : tr(req, `plugins.stg.err.${code}`, e.message) });
  }
  logger.warn({ err: e && e.message }, 'storage target request failed');
  return res.status(500).json({ ok: false, code: 'internal', error: tr(req, 'plugins.stg.err.internal', 'Internal error') });
}

function body(req) { return req.body && typeof req.body === 'object' ? req.body : {}; }

/**
 * Google Drive / OneDrive: `draft` names an account this administrator just
 * connected (services/cloudAccounts) — another one's or an expired draft is
 * refused; a used draft is dropped.
 */
function ownDraft(req, b) {
  if (b.draft == null || b.draft === '') return true;
  const d = require('../../services/cloudAccounts').draft(String(b.draft));
  return !!d && d.userId === req.session.userId;
}
function dropDraft(b) { if (b.draft) require('../../services/cloudAccounts').dropDraft(String(b.draft)); }
function draftGone(req, res) {
  return res.status(400).json({ ok: false, code: 'invalid', field: 'draft', error: tr(req, 'plugins.stg.err.field_draft', 'Connect the account again') });
}

function log(req, event, message, details) {
  activity.log(event, message, { source: 'admin', ipAddress: req.ip, severity: 'info', details });
}

router.get('/', (req, res) => {
  res.json({ ok: true, targets: targets.list(), cache: require('../../services/plugins/mediaAreas').cacheStats() });
});

// the local cache of plugin media areas kept on targets (services/plugins/mediaAreas.js)
router.put('/cache', (req, res) => {
  const areas = require('../../services/plugins/mediaAreas');
  const b = body(req);
  const v = b.limitBytes == null ? null : b.limitBytes;
  try {
    areas.setCacheLimit(v);
  } catch (e) {
    return res.status(400).json({ ok: false, code: 'invalid', field: 'limitBytes', error: tr(req, 'plugins.stg.err.field_cache', 'Invalid cache size') });
  }
  const cache = areas.cacheStats();
  log(req, 'storage_cache_changed', `Media cache limit set to ${v == null ? 'default' : v + ' bytes'}`, { limitBytes: v });
  res.json({ ok: true, cache });
});

router.get('/choices', (req, res) => {
  const { getDb } = require('../../db/connection');
  const db = getDb();
  const peers = db.prepare('SELECT id, name, allowed_ips FROM peers WHERE enabled = 1 ORDER BY name').all()
    .map((p) => ({ id: p.id, label: p.name, ip: String(p.allowed_ips || '').split(',')[0].split('/')[0] }));
  // type: 'l4' (TCP only — UDP carries neither SMB nor WebDAV) or 'http'; gateway: through a
  // gateway's companion; https: the backend speaks https; internal: not reachable from outside
  const routes = db.prepare(`SELECT id, domain, route_type, l4_listen_port, l4_protocol, target_kind, backend_https, external_enabled
    FROM routes WHERE enabled = 1 AND (route_type IS NULL OR route_type != 'l4' OR l4_protocol IS NULL OR l4_protocol != 'udp') ORDER BY domain`).all()
    .map((r) => (r.route_type === 'l4'
      ? { id: r.id, label: `${r.domain || 'L4'}:${r.l4_listen_port}`, type: 'l4', gateway: r.target_kind === 'gateway', internal: !r.external_enabled }
      : { id: r.id, label: r.domain, type: 'http', gateway: r.target_kind === 'gateway', https: !!r.backend_https, internal: !r.external_enabled }));
  res.json({ ok: true, peers, routes });
});

router.post('/', (req, res) => {
  const b = body(req);
  if (!ownDraft(req, b)) return draftGone(req, res);
  try {
    const t = targets.create(String(b.kind || ''), b);
    dropDraft(b);
    log(req, 'storage_target_created', `Storage target "${t.label}" (${t.kind}) created`, { id: t.id, kind: t.kind });
    res.status(201).json({ ok: true, target: t });
  } catch (e) { fail(req, res, e); }
});

router.post('/check', async (req, res) => {
  const b = body(req);
  if (!ownDraft(req, b)) return draftGone(req, res);
  try {
    const id = b.id == null ? null : Number(b.id);
    const r = await targets.checkInput(String(b.kind || ''), b, id);
    res.json({ ok: true, check: r });
  } catch (e) { fail(req, res, e); }
});

router.get('/:id', (req, res) => {
  const t = targets.get(req.params.id);
  if (!t) return res.status(404).json({ ok: false, code: 'not_found', error: tr(req, 'plugins.stg.err.not_found', 'Not found') });
  res.json({ ok: true, target: t });
});

router.patch('/:id', (req, res) => {
  const b = body(req);
  if (!ownDraft(req, b)) return draftGone(req, res);
  try {
    const t = targets.update(req.params.id, b);
    dropDraft(b);
    log(req, 'storage_target_changed', `Storage target "${t.label}" changed`, { id: t.id, kind: t.kind });
    res.json({ ok: true, target: t });
  } catch (e) { fail(req, res, e); }
});

router.delete('/:id', (req, res) => {
  const t = targets.get(req.params.id);
  if (!t) return res.status(404).json({ ok: false, code: 'not_found', error: tr(req, 'plugins.stg.err.not_found', 'Not found') });
  try {
    targets.remove(t.id);
    log(req, 'storage_target_deleted', `Storage target "${t.label}" deleted`, { id: t.id, kind: t.kind });
    res.json({ ok: true });
  } catch (e) { fail(req, res, e); }
});

router.post('/:id/check', async (req, res) => {
  try {
    const r = await targets.check(req.params.id);
    res.json({ ok: true, check: r, target: targets.get(req.params.id) });
  } catch (e) { fail(req, res, e); }
});

module.exports = router;
