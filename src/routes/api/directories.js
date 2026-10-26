'use strict';

/**
 * Admin API of the directory sync (docs/groups.md "Verzeichnis-Abgleich und
 * Anmeldung", services/directory/). Admin session only, like /groups: API
 * tokens and member sessions get 403. CSRF and the API limiter come from the
 * /api/v1 router. Secrets (bind password, client secret) are write-only:
 * answers carry `hasSecret` and a mask.
 *
 *   GET    /api/v1/directories                        list with state and counts
 *   POST   /api/v1/directories                        create { kind, name, config, secret, … }
 *   POST   /api/v1/directories/test                   test unsaved settings { kind, config, secret[, id] }
 *   GET    /api/v1/directories/:id                    one directory
 *   PATCH  /api/v1/directories/:id                    change (secret: '' or absent = keep)
 *   DELETE /api/v1/directories/:id?confirm=<name>     remove (groups archived, accounts stay)
 *   POST   /api/v1/directories/:id/test               connection test with the stored settings
 *   GET    /api/v1/directories/:id/groups?q=          search groups in the directory
 *   POST   /api/v1/directories/:id/sync               start a run now (202, runs in the background);
 *                                                      { full: true } reads everything ("Vollständig abgleichen")
 *   GET    /api/v1/directories/:id/runs               last runs
 *   GET    /api/v1/directories/:id/runs/:runId        one run with details
 *   POST   /api/v1/directories/:id/runs/:runId/confirm  confirm a stopped mass change
 *   POST   /api/v1/directories/:id/runs/:runId/discard  discard it
 *   GET    /api/v1/directories/:id/conflicts[?status=all]
 *   POST   /api/v1/directories/:id/conflicts/:conflictId/merge
 *   POST   /api/v1/directories/:id/conflicts/:conflictId/separate
 */

const express = require('express');
const { requireAdminSession } = require('../../middleware/auth');
const store = require('../../services/directory/store');
const sync = require('../../services/directory/sync');
const adapters = require('../../services/directory/adapters');
const logger = require('../../utils/logger');

const router = express.Router();
router.use(requireAdminSession);

const ERRORS = {
  NOT_FOUND: [404, 'error.directory.not_found'],
  RUN_NOT_FOUND: [404, 'error.directory.run_not_found'],
  CONFLICT_NOT_FOUND: [404, 'error.directory.conflict_not_found'],
  USER_NOT_FOUND: [404, 'error.directory.user_not_found'],
  INVALID_KIND: [400, 'error.directory.invalid_kind'],
  INVALID_NAME: [400, 'error.directory.invalid_name'],
  INVALID_HOST: [400, 'error.directory.invalid_host'],
  INVALID_PORT: [400, 'error.directory.invalid_port'],
  INVALID_SECURITY: [400, 'error.directory.invalid_security'],
  INVALID_BASE_DN: [400, 'error.directory.invalid_base_dn'],
  INVALID_BIND_DN: [400, 'error.directory.invalid_bind_dn'],
  INVALID_FILTER: [400, 'error.directory.invalid_filter'],
  INVALID_ATTRIBUTE: [400, 'error.directory.invalid_attribute'],
  INVALID_TENANT: [400, 'error.directory.invalid_tenant'],
  INVALID_CLIENT: [400, 'error.directory.invalid_client'],
  INVALID_SECRET: [400, 'error.directory.invalid_secret'],
  INVALID_CA: [400, 'error.directory.invalid_ca'],
  INVALID_INTERVAL: [400, 'error.directory.invalid_interval'],
  INVALID_FULL_INTERVAL: [400, 'error.directory.invalid_full_interval'],
  INVALID_PARENT: [400, 'error.directory.invalid_parent'],
  INVALID: [400, 'error.directory.invalid'],
  CONFIRM_MISMATCH: [400, 'error.directory.confirm_mismatch'],
  RUNNING: [409, 'error.directory.running'],
  RUN_NOT_PENDING: [409, 'error.directory.run_not_pending'],
  CONFLICT_RESOLVED: [409, 'error.directory.conflict_resolved'],
  ALREADY_LINKED: [409, 'error.directory.already_linked'],
  ADMIN_NOT_MERGEABLE: [409, 'error.directory.admin_not_mergeable'],
};

function fail(req, res, err, fallbackKey) {
  const m = err && ERRORS[err.code];
  if (m) return res.status(m[0]).json({ ok: false, code: err.code, field: err.field || undefined, error: req.t(m[1]) });
  logger.error({ err: err && err.message }, 'directories API failed');
  return res.status(500).json({ ok: false, error: req.t(fallbackKey || 'error.directory.generic') });
}

function opts(req) { return { actor: req.session.userId, ip: req.ip }; }

function dirOr404(req, res) {
  const d = store.load(req.params.id);
  if (!d) { fail(req, res, Object.assign(new Error('nf'), { code: 'NOT_FOUND' })); return null; }
  return d;
}

/** Directory errors of a test / search: a short, safe description. */
function connectionError(req, err) {
  const code = err && err.code;
  const msg = String((err && err.message) || '').slice(0, 300);
  let key = 'error.directory.unreachable';
  if (code === 'AUTH_FAILED' || code === 'NO_CREDENTIALS' || (err && (err.name === 'InvalidCredentialsError' || code === 49))) key = 'error.directory.auth_failed';
  else if (/certificate|self[- ]signed|unable to verify|CERT_|hostname|altnames/i.test(msg)) key = 'error.directory.tls_failed';
  else if (ERRORS[code]) key = ERRORS[code][1];
  return { ok: false, code: code || 'UNREACHABLE', error: req.t(key), detail: msg };
}

router.get('/', (req, res) => {
  try { res.json({ ok: true, directories: store.list() }); } catch (err) { fail(req, res, err); }
});

router.post('/', (req, res) => {
  try {
    const d = store.create(req.body || {}, opts(req));
    res.status(201).json({ ok: true, directory: d });
  } catch (err) { fail(req, res, err); }
});

router.post('/test', async (req, res) => {
  try {
    const b = req.body || {};
    let base = null;
    if (b.id != null && b.id !== '') {
      base = store.load(b.id);
      if (!base) return fail(req, res, Object.assign(new Error('nf'), { code: 'NOT_FOUND' }));
    }
    const kind = base ? base.kind : b.kind;
    if (!store.KINDS.includes(kind)) return fail(req, res, Object.assign(new Error('kind'), { code: 'INVALID_KIND' }));
    const merged = { ...((base && base.config) || {}), ...((b.config && typeof b.config === 'object') ? b.config : {}) };
    const config = store.cleanConfig(kind, merged);
    const secret = typeof b.secret === 'string' && b.secret && b.secret !== store.MASK ? b.secret : (base ? store.secretOf(base) : '');
    const adapter = adapters.adapterForDraft({ id: base ? base.id : 0, kind, config }, secret);
    try {
      const result = await adapter.test();
      return res.json({ ok: true, result });
    } catch (err) {
      return res.json(connectionError(req, err));
    }
  } catch (err) { return fail(req, res, err); }
});

router.get('/:id', (req, res) => {
  try {
    const d = store.get(req.params.id);
    if (!d) return fail(req, res, Object.assign(new Error('nf'), { code: 'NOT_FOUND' }));
    res.json({ ok: true, directory: d, running: sync.isRunning(d.id) });
  } catch (err) { fail(req, res, err); }
});

router.patch('/:id', (req, res) => {
  try {
    res.json({ ok: true, directory: store.update(req.params.id, req.body || {}, opts(req)) });
  } catch (err) { fail(req, res, err); }
});

router.delete('/:id', (req, res) => {
  try {
    store.remove(req.params.id, { ...opts(req), confirmName: typeof req.query.confirm === 'string' ? req.query.confirm : '' });
    res.json({ ok: true });
  } catch (err) { fail(req, res, err); }
});

router.post('/:id/test', async (req, res) => {
  const d = dirOr404(req, res);
  if (!d) return undefined;
  try {
    const result = await adapters.adapterFor(d).test();
    return res.json({ ok: true, result });
  } catch (err) {
    return res.json(connectionError(req, err));
  }
});

router.get('/:id/groups', async (req, res) => {
  const d = dirOr404(req, res);
  if (!d) return undefined;
  try {
    const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 100) : '';
    const list = await adapters.adapterFor(d).searchGroups(q, { limit: 50 });
    const selected = new Set(d.selectedGroups.map((g) => String(g.externalId).toLowerCase()));
    return res.json({ ok: true, groups: list.map((g) => ({ ...g, selected: selected.has(String(g.externalId).toLowerCase()) })) });
  } catch (err) {
    return res.status(502).json(connectionError(req, err));
  }
});

router.post('/:id/sync', (req, res) => {
  const d = dirOr404(req, res);
  if (!d) return undefined;
  if (sync.isRunning(d.id)) return fail(req, res, Object.assign(new Error('running'), { code: 'RUNNING' }));
  // In the background: a large directory can take longer than a request.
  const full = !!(req.body && (req.body.full === true || req.body.full === 'true' || req.body.full === 1));
  sync.run(d.id, { trigger: 'manual', actor: req.session.userId, full }).catch((err) => {
    logger.warn({ directoryId: d.id, err: err.message }, 'manual directory sync failed');
  });
  return res.status(202).json({ ok: true, started: true, full });
});

router.get('/:id/runs', (req, res) => {
  const d = dirOr404(req, res);
  if (!d) return undefined;
  try { res.json({ ok: true, runs: sync.listRuns(d.id, { limit: req.query.limit }), running: sync.isRunning(d.id) }); } catch (err) { fail(req, res, err); }
});

router.get('/:id/runs/:runId', (req, res) => {
  const d = dirOr404(req, res);
  if (!d) return undefined;
  const r = sync.getRun(d.id, req.params.runId);
  if (!r) return fail(req, res, Object.assign(new Error('nf'), { code: 'RUN_NOT_FOUND' }));
  return res.json({ ok: true, run: r });
});

router.post('/:id/runs/:runId/confirm', async (req, res) => {
  const d = dirOr404(req, res);
  if (!d) return undefined;
  try {
    const r = await sync.confirm(d.id, req.params.runId, opts(req));
    return res.json({ ok: true, run: r });
  } catch (err) { return fail(req, res, err); }
});

router.post('/:id/runs/:runId/discard', (req, res) => {
  const d = dirOr404(req, res);
  if (!d) return undefined;
  try { return res.json({ ok: true, run: sync.discard(d.id, req.params.runId, opts(req)) }); } catch (err) { return fail(req, res, err); }
});

router.get('/:id/conflicts', (req, res) => {
  const d = dirOr404(req, res);
  if (!d) return undefined;
  try {
    res.json({ ok: true, conflicts: sync.listConflicts(d.id, { status: req.query.status === 'all' ? null : 'open' }) });
  } catch (err) { fail(req, res, err); }
});

for (const action of ['merge', 'separate']) {
  router.post(`/:id/conflicts/:conflictId/${action}`, (req, res) => {
    const d = dirOr404(req, res);
    if (!d) return undefined;
    try {
      return res.json({ ok: true, conflict: sync.resolveConflict(d.id, req.params.conflictId, action, opts(req)) });
    } catch (err) { return fail(req, res, err); }
  });
}

module.exports = router;
