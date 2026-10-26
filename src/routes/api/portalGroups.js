'use strict';

/**
 * Portal "Meine Gruppen" (docs/groups.md "Portal", services/groups.js) —
 * mounted at /api/v1/portal/groups behind portalIdentity / portalOwner (and
 * the portal API's CSRF check for writes).
 *
 * Only a signed-in person (portal or web session — never device trust and
 * never a kiosk device: kioskSession refuses these paths, and this router
 * checks again). Everybody sees their own groups (direct and inherited, with
 * role, path, source and the leadership). A group's LEAD or GROUP ADMIN
 * (family: a parent) — a direct role in exactly that group — maintains it:
 * members, roles, invitation links. Local groups fully; directory groups only
 * their extra local members; plugin groups never. Server admins alone give
 * the roles lead / parent and change people who hold them; nobody changes
 * their own membership here. People are added by their exact user name or
 * e-mail address — there is no directory of people for non-admins.
 *
 *   GET    /                               own groups
 *   GET    /principals                     GC.pickPrincipals in portal frames:
 *                                          groups by name + the viewer
 *   GET    /:id                            a group (members etc. for managers)
 *
 * People (leaders, members) carry their look — avatarUrl, color,
 * colorHex (docs/feature-avatars.md) — like everywhere else in the portal.
 *   POST   /:id/members { login, role }    add a person (user name or e-mail)
 *   PUT    /:id/members/:userId { role }   change a member's role
 *   DELETE /:id/members/:userId            remove a (local) member
 *   GET    /:id/invites                    invitation links
 *   POST   /:id/invites { role, expiresInDays, maxUses }
 *   DELETE /:id/invites/:inviteId
 */

const express = require('express');
const groups = require('../../services/groups');
const avatars = require('../../services/avatars');
const { getDb } = require('../../db/connection');
const logger = require('../../utils/logger');

const router = express.Router();

const MANAGER_ROLES = ['lead', 'admin', 'parent'];
const PROTECTED_ROLES = ['lead', 'parent'];
const LOGIN_MAX = 200;

const ERRORS = {
  NOT_FOUND: [404, 'error.groups.not_found'],
  USER_NOT_FOUND: [404, 'error.groups.portal.no_account'],
  USER_DISABLED: [404, 'error.groups.portal.no_account'],
  INVALID_ROLE: [400, 'error.groups.invalid_role'],
  INVALID: [400, 'error.groups.invalid'],
  READ_ONLY: [403, 'error.groups.read_only'],
  ARCHIVED: [409, 'error.groups.archived'],
  LOGIN_REQUIRED: [401, 'error.groups.portal.login_required'],
  NOT_MEMBER: [403, 'error.groups.portal.not_member'],
  NOT_MANAGER: [403, 'error.groups.portal.not_manager'],
  PROTECTED: [403, 'error.groups.portal.protected'],
  SELF: [403, 'error.groups.portal.self'],
  ALREADY_MEMBER: [409, 'error.groups.portal.already_member'],
  MEMBER_NOT_FOUND: [404, 'error.groups.member_not_found'],
  INVITE_NOT_FOUND: [404, 'error.groups.invite_not_found'],
};

function coded(code) { const e = new Error(code); e.code = code; return e; }

function fail(req, res, err) {
  const m = err && ERRORS[err.code];
  if (m) return res.status(m[0]).json({ ok: false, code: err.code, error: req.t(m[1]) });
  logger.error({ err: err && err.message }, 'portal groups API failed');
  return res.status(500).json({ ok: false, error: req.t('error.groups.generic') });
}

/** The signed-in person (never device trust, never a kiosk device) — else LOGIN_REQUIRED. */
function viewer(req) {
  if (!req.portalLoggedIn || req.portalOwnerId == null || req.portalOwnerSource === 'kiosk' || req.portalKiosk) throw coded('LOGIN_REQUIRED');
  const u = getDb().prepare('SELECT id, username, display_name, enabled FROM users WHERE id = ?').get(req.portalOwnerId);
  if (!u || u.enabled !== 1) throw coded('LOGIN_REQUIRED');
  return u;
}

function sourceKind(source) {
  if (!source || source === 'local') return 'local';
  return String(source).startsWith('directory:') ? 'directory' : 'plugin';
}

/** Roles a manager may give in a group of `kind` (lead / parent: server admins only). */
function assignable(kind) { return kind === 'family' ? ['child'] : ['member', 'deputy', 'admin']; }

function names() {
  return new Map(getDb().prepare('SELECT id, username, display_name FROM users').all().map((u) => [u.id, u.display_name || u.username]));
}

/** The viewer's own entry for a group (direct or inherited) or NOT_MEMBER / NOT_FOUND. */
function mine(uid, groupId) {
  const g = groups.get(groupId);
  if (!g || g.archived) throw coded('NOT_FOUND');
  const own = groups.groupsOfUser(uid, { includeInherited: true }).find((x) => x.id === g.id);
  if (!own) throw coded('NOT_MEMBER');
  const manage = own.direct && MANAGER_ROLES.includes(own.role) && sourceKind(g.source) !== 'plugin';
  return { g, own, manage };
}

function needManager(uid, groupId) {
  const m = mine(uid, groupId);
  if (!m.manage) throw coded('NOT_MANAGER');
  return m;
}

function leadersView(uid, groupId, nm) {
  return avatars.withLooks(groups.leadersOf(uid, { groupId }).map((l) => ({ userId: l.userId, name: nm.get(l.userId) || null, role: l.role, groupId: l.groupId })));
}

/** May the manager `uid` change this member (role / removal) in group `g`? */
function memberRights(uid, g, m) {
  const fixed = !m.direct || PROTECTED_ROLES.includes(m.role) || m.userId === uid;
  const localOnly = sourceKind(g.source) === 'directory';
  const memberLocal = m.source === 'local';
  return {
    canEditRole: !fixed && (!localOnly || memberLocal),
    canRemove: !fixed && memberLocal,
  };
}

function inviteBase() {
  try { return require('./groups').inviteBase(); } catch { return ''; }
}

// logSource: the activity row's source (setMember's opts.source would be the MEMBER's source)
function opts(req, uid, extra) { return { actor: uid, ip: req.ip, logSource: 'user', ...(extra || {}) }; }

// ─── reading ──────────────────────────────────────────────────────────────

router.get('/', (req, res) => {
  try {
    const u = viewer(req);
    const nm = names();
    const all = new Map(groups.list({}).map((g) => [g.id, g]));
    const list = groups.groupsOfUser(u.id, { includeInherited: true }).map((x) => {
      const g = all.get(x.id) || {};
      const sk = sourceKind(x.source);
      return {
        id: x.id, name: x.name, path: x.path, kind: x.kind, role: x.role, direct: x.direct, source: x.source, sourceKind: sk,
        endsAt: g.endsAt || null, memberCount: g.totalMemberCount || 0,
        manage: x.direct && MANAGER_ROLES.includes(x.role) && sk !== 'plugin',
        leaders: leadersView(u.id, x.id, nm),
      };
    });
    res.set('Cache-Control', 'no-store');
    return res.json({ ok: true, groups: list });
  } catch (err) { return fail(req, res, err); }
});

// GC.pickPrincipals in portal frames: every non-archived group by name (no member lists) and the viewer —
// a portal viewer cannot list other people.
router.get('/principals', (req, res) => {
  try {
    const u = viewer(req);
    const list = groups.list({}).map((g) => ({ id: g.id, label: g.path, sub: req.t(`grp.kind.${g.kind}`) }));
    res.set('Cache-Control', 'no-store');
    return res.json({ ok: true, groups: list, users: [{ id: u.id, label: u.display_name || u.username, sub: '', self: true }] });
  } catch (err) { return fail(req, res, err); }
});

router.get('/:id', (req, res) => {
  try {
    const u = viewer(req);
    const { g, own, manage } = mine(u.id, req.params.id);
    const nm = names();
    const out = {
      ok: true,
      group: { id: g.id, name: g.name, path: g.path, kind: g.kind, source: g.source, sourceKind: sourceKind(g.source), endsAt: g.endsAt,
        memberCount: g.totalMemberCount },
      role: own.role, direct: own.direct, manage,
      leaders: leadersView(u.id, g.id, nm),
    };
    if (manage) {
      out.roles = assignable(g.kind);
      out.members = avatars.withLooks(groups.members(g.id, { nested: true }).map((m) => ({
        userId: m.userId, name: m.name, email: m.email, role: m.role, direct: m.direct, source: m.source === 'local' ? 'local' : 'directory',
        enabled: m.enabled, self: m.userId === u.id, ...memberRights(u.id, g, m),
      })));
      out.invites = groups.listInvites(g.id).filter((i) => i.active);
    }
    res.set('Cache-Control', 'no-store');
    return res.json(out);
  } catch (err) { return fail(req, res, err); }
});

// ─── members ──────────────────────────────────────────────────────────────

/** An account by its exact user name, else by its exact e-mail address (one account only). */
function findByLogin(login) {
  const db = getDb();
  const byName = db.prepare('SELECT id, enabled FROM users WHERE lower(username) = lower(?)').get(login);
  if (byName) return byName;
  const byMail = db.prepare("SELECT id, enabled FROM users WHERE email IS NOT NULL AND email <> '' AND lower(email) = lower(?) LIMIT 2").all(login);
  return byMail.length === 1 ? byMail[0] : null;
}

router.post('/:id/members', (req, res) => {
  try {
    const u = viewer(req);
    const { g } = needManager(u.id, req.params.id);
    const b = req.body || {};
    const login = typeof b.login === 'string' ? b.login.trim() : '';
    if (!login || login.length > LOGIN_MAX) throw coded('INVALID');
    const roles = assignable(g.kind);
    const role = b.role == null || b.role === '' ? roles[0] : b.role;
    if (!roles.includes(role)) throw coded('INVALID_ROLE');
    const target = findByLogin(login);
    // unknown, ambiguous and disabled accounts get one and the same answer
    if (!target || target.enabled !== 1) throw coded('USER_NOT_FOUND');
    if (groups.membershipsOfUser(target.id).some((m) => m.group_id === g.id)) throw coded('ALREADY_MEMBER');
    const r = groups.setMember(g.id, target.id, role, opts(req, u.id));
    const m = groups.members(g.id).find((x) => x.userId === target.id);
    const member = m ? { userId: m.userId, name: m.name, email: m.email, role: r.role, direct: true, source: 'local', enabled: m.enabled, self: false, ...memberRights(u.id, g, m) } : null;
    return res.status(201).json({ ok: true, member: member ? avatars.withLooks([member])[0] : null });
  } catch (err) { return fail(req, res, err); }
});

function directMember(g, userId) {
  const m = groups.members(g.id).find((x) => x.userId === Number(userId));
  if (!m) throw coded('MEMBER_NOT_FOUND');
  return m;
}

router.put('/:id/members/:userId', (req, res) => {
  try {
    const u = viewer(req);
    const { g } = needManager(u.id, req.params.id);
    const m = directMember(g, req.params.userId);
    if (m.userId === u.id) throw coded('SELF');
    if (PROTECTED_ROLES.includes(m.role)) throw coded('PROTECTED');
    if (!memberRights(u.id, g, m).canEditRole) throw coded('READ_ONLY');
    const role = req.body && req.body.role;
    if (!assignable(g.kind).includes(role)) throw coded(role === 'lead' || role === 'parent' ? 'PROTECTED' : 'INVALID_ROLE');
    const r = groups.setMember(g.id, m.userId, role, opts(req, u.id));
    return res.json({ ok: true, member: { userId: m.userId, role: r.role, changed: r.changed } });
  } catch (err) { return fail(req, res, err); }
});

router.delete('/:id/members/:userId', (req, res) => {
  try {
    const u = viewer(req);
    const { g } = needManager(u.id, req.params.id);
    const m = directMember(g, req.params.userId);
    if (m.userId === u.id) throw coded('SELF');
    if (PROTECTED_ROLES.includes(m.role)) throw coded('PROTECTED');
    if (!memberRights(u.id, g, m).canRemove) throw coded('READ_ONLY');
    groups.removeMember(g.id, m.userId, opts(req, u.id));
    return res.json({ ok: true });
  } catch (err) { return fail(req, res, err); }
});

// ─── invitation links ─────────────────────────────────────────────────────

router.get('/:id/invites', (req, res) => {
  try {
    const u = viewer(req);
    const { g } = needManager(u.id, req.params.id);
    res.set('Cache-Control', 'no-store');
    return res.json({ ok: true, invites: groups.listInvites(g.id).filter((i) => i.active) });
  } catch (err) { return fail(req, res, err); }
});

router.post('/:id/invites', (req, res) => {
  try {
    const u = viewer(req);
    const { g } = needManager(u.id, req.params.id);
    const b = req.body || {};
    const roles = assignable(g.kind);
    const role = b.role == null || b.role === '' ? roles[0] : b.role;
    if (!roles.includes(role)) throw coded(role === 'lead' || role === 'parent' ? 'PROTECTED' : 'INVALID_ROLE');
    // the limits of groups.createInvite: 1–30 days, 1–500 uses
    const inv = groups.createInvite(g.id, {
      role, expiresInDays: Number(b.expiresInDays == null ? 7 : b.expiresInDays), maxUses: b.maxUses == null ? 1 : Number(b.maxUses), actor: u.id, ip: req.ip,
    });
    res.set('Cache-Control', 'no-store');
    return res.status(201).json({ ok: true, invite: { ...inv, url: `${inviteBase()}/portal/groups/join/${inv.token}` } });
  } catch (err) { return fail(req, res, err); }
});

router.delete('/:id/invites/:inviteId', (req, res) => {
  try {
    const u = viewer(req);
    const { g } = needManager(u.id, req.params.id);
    if (!groups.revokeInvite(g.id, req.params.inviteId, { actor: u.id, ip: req.ip })) throw coded('INVITE_NOT_FOUND');
    return res.json({ ok: true });
  } catch (err) { return fail(req, res, err); }
});

module.exports = router;
module.exports.MANAGER_ROLES = MANAGER_ROLES;
module.exports.assignable = assignable;
