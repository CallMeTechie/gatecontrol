'use strict';

/**
 * Admin API of the storage targets (docs/storage-targets.md,
 * services/storageTargets/). Admin session only, like /directories: API
 * tokens and member sessions get 403. CSRF and the API limiter come from the
 * /api/v1 router. Secrets (password, secret key) are write-only: answers
 * carry `secretSet` per field.
 *
 *   GET    /api/v1/storage-targets              list (with the last check and what uses each)
 *   POST   /api/v1/storage-targets              create { kind, label, …settings, …secrets }
 *   POST   /api/v1/storage-targets/check        check unsaved settings { kind, …[, id] } (nothing stored)
 *   GET    /api/v1/storage-targets/choices      peers and L4 routes for an SMB target
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

function log(req, event, message, details) {
  activity.log(event, message, { source: 'admin', ipAddress: req.ip, severity: 'info', details });
}

router.get('/', (req, res) => {
  res.json({ ok: true, targets: targets.list() });
});

router.get('/choices', (req, res) => {
  const { getDb } = require('../../db/connection');
  const db = getDb();
  const peers = db.prepare('SELECT id, name, allowed_ips FROM peers WHERE enabled = 1 ORDER BY name').all()
    .map((p) => ({ id: p.id, label: p.name, ip: String(p.allowed_ips || '').split(',')[0].split('/')[0] }));
  const routes = db.prepare("SELECT id, domain, l4_listen_port FROM routes WHERE route_type = 'l4' AND enabled = 1 ORDER BY domain").all()
    .map((r) => ({ id: r.id, label: `${r.domain || 'L4'}:${r.l4_listen_port}` }));
  res.json({ ok: true, peers, routes });
});

router.post('/', (req, res) => {
  const b = body(req);
  try {
    const t = targets.create(String(b.kind || ''), b);
    log(req, 'storage_target_created', `Storage target "${t.label}" (${t.kind}) created`, { id: t.id, kind: t.kind });
    res.status(201).json({ ok: true, target: t });
  } catch (e) { fail(req, res, e); }
});

router.post('/check', async (req, res) => {
  const b = body(req);
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
  try {
    const t = targets.update(req.params.id, body(req));
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
