'use strict';

const { Router } = require('express');
const logger = require('../../utils/logger');
const { getDb } = require('../../db/connection');
const { requireFeature } = require('../../middleware/license');
const accessRules = require('../../services/accessRules');
const { parseSchedule } = require('../../services/rdpMaintenance');

/**
 * Admin API for scheduled access windows. Factory that closes over the
 * target type ('route' | 'peer') so the same router shape serves both
 * /routes/:id/access-rules and /peers/:id/access-rules.
 *
 * Mounted with mergeParams:true under /api/v1, so:
 *   - req.params.id is the route/peer id from the parent mount path
 *   - CSRF is auto-applied by the /api/v1 mount
 *   - every endpoint is gated behind the 'access_windows' license feature
 */
module.exports = (target_type) => {
  const router = Router({ mergeParams: true });

  const tableFor = () => (target_type === 'peer' ? 'peers' : 'routes');

  function targetExists(id) {
    return !!getDb().prepare(`SELECT 1 FROM ${tableFor()} WHERE id = ?`).get(id);
  }

  // Validate the request body for create/update. Returns null on success or
  // an Express-style { status, error } object on failure.
  function validateBody(body, req) {
    const { mode, schedule, valid_from, valid_until } = body || {};

    if (mode !== 'allow' && mode !== 'block') {
      return { status: 400, error: req.t('access.err_mode') };
    }

    const parsed = parseSchedule(schedule);
    if (parsed.errors.length || !parsed.windows.length) {
      return { status: 400, error: req.t('access.err_schedule') };
    }

    if (valid_from && valid_until && String(valid_from) > String(valid_until)) {
      return { status: 400, error: req.t('access.err_date_order') };
    }

    return null;
  }

  // GET / — list rules + the live evaluate() state/active-rule for the badge.
  router.get('/', requireFeature('access_windows'), (req, res) => {
    (async () => {
      const id = Number(req.params.id);
      if (!targetExists(id)) {
        return res.status(404).json({ ok: false, error: req.t('access.target_not_found') });
      }
      const ev = accessRules.evaluate(target_type, id);
      res.json({
        ok: true,
        rules: accessRules.listRules(target_type, id),
        state: ev.state,
        rule: (ev.reason && ev.reason.rule) || null,
      });
    })().catch((err) => { logger.error({ err: err.message }, 'access-rules handler failed'); res.status(500).json({ ok: false, error: req.t('common.error') }); });
  });

  // POST / — create a rule, then reconcile the deny-set immediately.
  router.post('/', requireFeature('access_windows'), (req, res) => {
    (async () => {
      const id = Number(req.params.id);
      const invalid = validateBody(req.body, req);
      if (invalid) return res.status(invalid.status).json({ ok: false, error: invalid.error });
      if (!targetExists(id)) {
        return res.status(404).json({ ok: false, error: req.t('access.target_not_found') });
      }

      const { mode, schedule, valid_from, valid_until, label } = req.body;
      const created = accessRules.createRule({
        target_type, target_id: id, mode, schedule, valid_from, valid_until, label,
      });
      await require('../../services/accessReconciler').reconcileNow();
      res.status(201).json({ ok: true, id: created.id });
    })().catch((err) => { logger.error({ err: err.message }, 'access-rules handler failed'); res.status(500).json({ ok: false, error: req.t('common.error') }); });
  });

  // PUT /:ruleId — edit a rule, then reconcile.
  router.put('/:ruleId', requireFeature('access_windows'), (req, res) => {
    (async () => {
      const id = Number(req.params.id);
      const invalid = validateBody(req.body, req);
      if (invalid) return res.status(invalid.status).json({ ok: false, error: invalid.error });
      if (!targetExists(id)) {
        return res.status(404).json({ ok: false, error: req.t('access.target_not_found') });
      }

      const { mode, schedule, valid_from, valid_until, label } = req.body;
      const upd = accessRules.updateRule(Number(req.params.ruleId), {
        mode, schedule,
        valid_from: valid_from || null,
        valid_until: valid_until || null,
        label: label || null,
      }, target_type, id);
      if (!upd || upd.changes === 0) {
        return res.status(404).json({ ok: false, error: req.t('access.target_not_found') });
      }
      await require('../../services/accessReconciler').reconcileNow();
      res.json({ ok: true });
    })().catch((err) => { logger.error({ err: err.message }, 'access-rules handler failed'); res.status(500).json({ ok: false, error: req.t('common.error') }); });
  });

  // DELETE /:ruleId — drop a rule, then reconcile.
  router.delete('/:ruleId', requireFeature('access_windows'), (req, res) => {
    (async () => {
      const id = Number(req.params.id);
      const del = accessRules.deleteRule(Number(req.params.ruleId), target_type, id);
      if (!del || del.changes === 0) {
        return res.status(404).json({ ok: false, error: req.t('access.target_not_found') });
      }
      await require('../../services/accessReconciler').reconcileNow();
      res.json({ ok: true });
    })().catch((err) => { logger.error({ err: err.message }, 'access-rules handler failed'); res.status(500).json({ ok: false, error: req.t('common.error') }); });
  });

  return router;
};
