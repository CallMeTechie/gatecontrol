'use strict';

/**
 * Admin API of the person groups (docs/groups.md, services/groups.js).
 * Admin session only, like /api/v1/users: API tokens are refused (403), a
 * session without the admin role too. CSRF and the API limiter come from the
 * /api/v1 router.
 *
 *   GET    /api/v1/groups[?tree=1&kind=&archived=1]   list (flat or tree)
 *   POST   /api/v1/groups                             create (always source 'local')
 *   POST   /api/v1/groups/import                      CSV (text/plain body or { csv })
 *   GET    /api/v1/groups/:id                         group + members (incl. inherited) + invites
 *   PATCH  /api/v1/groups/:id                         name, description, color, kind, endsAt, parentId
 *   DELETE /api/v1/groups/:id?confirm=<name>[&successor=<userId>|none]
 *                                                     delete (name typed to confirm; plugins'
 *                                                     groupDeleting hooks run first, ≤ 30 s)
 *   POST   /api/v1/groups/:id/archive | /unarchive
 *   GET    /api/v1/groups/:id/usage[?successor=<userId>|none]
 *                                                     "Wird genutzt von" (core + providers) and
 *                                                     defaultSuccessor (delete dialog)
 *   PUT    /api/v1/groups/:id/members/:userId { role }
 *   DELETE /api/v1/groups/:id/members/:userId
 *   GET    /api/v1/groups/:id/invites
 *   POST   /api/v1/groups/:id/invites { role, expiresInDays | expiresIn, maxUses }
 *   DELETE /api/v1/groups/:id/invites/:inviteId
 */

const express = require('express');
const { requireAdminSession } = require('../../middleware/auth');
const groups = require('../../services/groups');
const logger = require('../../utils/logger');

const router = express.Router();
router.use(requireAdminSession);

const ERRORS = {
  NOT_FOUND: [404, 'error.groups.not_found'],
  USER_NOT_FOUND: [404, 'error.groups.user_not_found'],
  USER_DISABLED: [400, 'error.groups.user_disabled'],
  INVALID_NAME: [400, 'error.groups.invalid_name'],
  INVALID_KIND: [400, 'error.groups.invalid_kind'],
  INVALID_ROLE: [400, 'error.groups.invalid_role'],
  INVALID_COLOR: [400, 'error.groups.invalid_color'],
  INVALID_DATE: [400, 'error.groups.invalid_date'],
  INVALID_SOURCE: [400, 'error.groups.invalid'],
  INVALID_PARENT: [400, 'error.groups.invalid_parent'],
  INVALID: [400, 'error.groups.invalid'],
  NAME_TAKEN: [409, 'error.groups.name_taken'],
  DEPTH_EXCEEDED: [400, 'error.groups.depth_exceeded'],
  CYCLE: [400, 'error.groups.cycle'],
  FAMILY_NESTING: [400, 'error.groups.family_nesting'],
  READ_ONLY: [403, 'error.groups.read_only'],
  HAS_CHILDREN: [409, 'error.groups.has_children'],
  CONFIRM_MISMATCH: [400, 'error.groups.confirm_mismatch'],
  ARCHIVED: [409, 'error.groups.archived'],
  INVITE_INVALID: [400, 'error.groups.invite_invalid'],
};

function fail(req, res, err, fallbackKey) {
  const m = err && ERRORS[err.code];
  if (m) return res.status(m[0]).json({ ok: false, code: err.code, error: req.t(m[1]) });
  logger.error({ err: err && err.message }, 'groups API failed');
  return res.status(500).json({ ok: false, error: req.t(fallbackKey || 'error.groups.generic') });
}

function opts(req, extra) {
  return { actor: req.session.userId, ip: req.ip, ...(extra || {}) };
}

/** Where an invitation link points: the portal when it is on, else the web UI. */
function inviteBase() {
  try {
    const portalConfig = require('../../services/portalConfig');
    if (portalConfig().enabled) return `https://${portalConfig.effectivePortalHost().host}`;
  } catch { /* portal not configured */ }
  try { return new URL(require('../../../config/default').app.baseUrl).origin; } catch { return ''; }
}

router.get('/', (req, res) => {
  try {
    const kind = typeof req.query.kind === 'string' && groups.KINDS.includes(req.query.kind) ? req.query.kind : undefined;
    const list = groups.list({ tree: req.query.tree === '1' || req.query.tree === 'true', kind, includeArchived: req.query.archived === '1' });
    res.json({ ok: true, groups: list, kinds: groups.KINDS });
  } catch (err) { fail(req, res, err); }
});

router.post('/', (req, res) => {
  try {
    const b = req.body || {};
    // Admins create local groups; directory / plugin groups come from their source.
    const group = groups.create({
      parentId: b.parentId, kind: b.kind, name: b.name, description: b.description, color: b.color, endsAt: b.endsAt,
    }, opts(req));
    res.status(201).json({ ok: true, group });
  } catch (err) { fail(req, res, err); }
});

router.post('/import', express.text({ type: ['text/plain', 'text/csv'], limit: '1mb' }), (req, res) => {
  try {
    const text = typeof req.body === 'string' ? req.body : (req.body && typeof req.body.csv === 'string' ? req.body.csv : null);
    if (text == null) return res.status(400).json({ ok: false, code: 'INVALID', error: req.t('error.groups.csv_required') });
    const result = groups.importCsv(text, opts(req));
    return res.json({ ok: true, ...result });
  } catch (err) { return fail(req, res, err); }
});

router.get('/:id', (req, res) => {
  try {
    const group = groups.get(req.params.id);
    if (!group) return fail(req, res, { code: 'NOT_FOUND' });
    return res.json({
      ok: true,
      group,
      members: groups.members(group.id, { nested: true }),
      invites: group.readOnly && !group.source.startsWith('directory:') ? [] : groups.listInvites(group.id),
      roles: groups.rolesFor(group.kind),
    });
  } catch (err) { return fail(req, res, err); }
});

router.patch('/:id', (req, res) => {
  try {
    const b = req.body || {};
    const patch = {};
    for (const k of ['name', 'description', 'color', 'kind', 'endsAt', 'parentId']) if (b[k] !== undefined) patch[k] = b[k];
    const group = groups.update(req.params.id, patch, opts(req));
    res.json({ ok: true, group });
  } catch (err) { fail(req, res, err); }
});

router.delete('/:id', async (req, res) => {
  try {
    const confirmName = typeof req.query.confirm === 'string' ? req.query.confirm
      : (req.body && typeof req.body.confirm === 'string' ? req.body.confirm : '');
    // successor: who takes over what plugins keep for the group (groupDeleting hook); default its leader
    const successor = req.query.successor != null ? req.query.successor : (req.body && req.body.successor != null ? req.body.successor : null);
    // plugins clean up first (groupDeleting, ≤ 30 s in total), then the group goes
    await groups.removeWithHooks(req.params.id, opts(req, { confirmName, successorUserId: successor }));
    res.json({ ok: true });
  } catch (err) { fail(req, res, err); }
});

router.post('/:id/archive', (req, res) => {
  try { res.json({ ok: true, group: groups.archive(req.params.id, opts(req)) }); } catch (err) { fail(req, res, err); }
});

router.post('/:id/unarchive', (req, res) => {
  try { res.json({ ok: true, group: groups.unarchive(req.params.id, opts(req)) }); } catch (err) { fail(req, res, err); }
});

router.get('/:id/usage', async (req, res) => {
  try {
    // ?successor=<userId>|none: what the plugins would say for that successor
    // (delete dialog); default the group's lead / deputy (defaultSuccessor).
    const successor = typeof req.query.successor === 'string' ? req.query.successor : null;
    const usage = (await groups.usage(req.params.id, { successorUserId: successor })).map((u) => (
      u.onDeleteKey && !u.onDelete ? { ...u, onDelete: req.t(u.onDeleteKey) } : u));
    res.json({ ok: true, usage, defaultSuccessor: groups.defaultSuccessor(req.params.id) });
  } catch (err) { fail(req, res, err); }
});

router.put('/:id/members/:userId', (req, res) => {
  try {
    const role = req.body && req.body.role;
    const r = groups.setMember(req.params.id, req.params.userId, role, opts(req));
    res.json({ ok: true, member: r });
  } catch (err) { fail(req, res, err); }
});

router.delete('/:id/members/:userId', (req, res) => {
  try {
    const removed = groups.removeMember(req.params.id, req.params.userId, opts(req));
    if (!removed) return res.status(404).json({ ok: false, code: 'NOT_FOUND', error: req.t('error.groups.member_not_found') });
    return res.json({ ok: true });
  } catch (err) { return fail(req, res, err); }
});

router.get('/:id/invites', (req, res) => {
  try { res.json({ ok: true, invites: groups.listInvites(req.params.id) }); } catch (err) { fail(req, res, err); }
});

router.post('/:id/invites', (req, res) => {
  try {
    const b = req.body || {};
    const expiresInDays = b.expiresInDays !== undefined ? b.expiresInDays : (b.expiresIn !== undefined ? b.expiresIn : 7);
    const inv = groups.createInvite(req.params.id, {
      role: b.role, expiresInDays: Number(expiresInDays), maxUses: b.maxUses == null ? 1 : Number(b.maxUses), ...opts(req),
    });
    res.set('Cache-Control', 'no-store');
    res.status(201).json({ ok: true, invite: { ...inv, url: `${inviteBase()}/portal/groups/join/${inv.token}` } });
  } catch (err) { fail(req, res, err); }
});

router.delete('/:id/invites/:inviteId', (req, res) => {
  try {
    const ok = groups.revokeInvite(req.params.id, req.params.inviteId, opts(req));
    if (!ok) return res.status(404).json({ ok: false, code: 'NOT_FOUND', error: req.t('error.groups.invite_not_found') });
    return res.json({ ok: true });
  } catch (err) { return fail(req, res, err); }
});

module.exports = router;
module.exports.inviteBase = inviteBase;
