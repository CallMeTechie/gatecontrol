'use strict';

/**
 * /portal/groups/join/:token — joining a person group with an invitation
 * link (docs/groups.md "Einladungslinks", services/groups.js).
 *
 * GET shows the group and the role (or "invalid or expired"); POST joins.
 * Only a signed-in person joins — a web session or a portal session (login
 * link of the app, "Wer bist du?" + PIN); never a kiosk device and never the
 * read-only device recognition. Somebody who is not signed in gets the login
 * page with returnTo back to this link (safeReturnTo allows /portal paths).
 * The token is single-purpose (only this route reads it), expires and has a
 * maximum number of uses; it is never logged. An unknown, used-up or expired
 * token gets one and the same answer.
 *
 * A signed-in person sees who they are and who leads the group, each with
 * the profile picture or the initials on the favourite colour
 * (docs/feature-avatars.md); somebody who is not signed in sees neither.
 */

const { ensureCsrfToken } = require('../middleware/csrf');
const { getDb } = require('../db/connection');
const groups = require('../services/groups');
const avatars = require('../services/avatars');
const logger = require('../utils/logger');

function noStore(res) {
  res.set('Cache-Control', 'no-store');
  res.set('Referrer-Policy', 'no-referrer');
}

/** The signed-in person behind the request (portalOwner ran before), or null. */
function viewerId(req) {
  if (!req.portalLoggedIn || req.portalOwnerSource === 'kiosk') return null;
  return req.portalOwnerId != null ? req.portalOwnerId : null;
}

function loginUrl(token) {
  return '/login?returnTo=' + encodeURIComponent(`/portal/groups/join/${token}`);
}

function roleLabel(t, role) {
  return t(`grp.role.${role}`);
}

/** { name, initials, color, avatarUrl } of an account (null when unknown). */
function person(userId, name) {
  const f = avatars.info(userId);
  if (!f) return null;
  return { name: name || null, initials: f.initials, color: f.color, avatarUrl: f.avatarUrl };
}

/** The viewer and the group's lead / deputy (walking up) for a signed-in person. */
function people(uid, groupId) {
  if (uid == null) return { viewer: null, leaders: [] };
  const nameOf = (id) => {
    const u = getDb().prepare('SELECT username, display_name FROM users WHERE id = ?').get(id);
    return u ? (u.display_name || u.username) : null;
  };
  let leaders = [];
  try {
    leaders = groupId == null ? [] : groups.leadersOf(uid, { groupId })
      .map((l) => ({ ...person(l.userId, nameOf(l.userId)), role: l.role }))
      .filter((l) => l.name);
  } catch (err) { logger.warn({ err: err.message }, 'group join: leaders unavailable'); }
  return { viewer: person(uid, nameOf(uid)), leaders };
}

function render(req, res, invite, extra = {}) {
  ensureCsrfToken(req, res);
  noStore(res);
  const t = res.locals.t;
  res.status(invite || extra.done ? 200 : 404).render(`${res.locals.theme || 'aurora'}/pages/group-join.njk`, {
    title: t('grp.join.title'),
    layout: false,
    invite: invite ? { path: invite.path, name: invite.name, role: roleLabel(t, invite.role) } : null,
    token: invite ? req.params.token : '',
    roleOf: (r) => roleLabel(t, r),
    ...people(viewerId(req), extra.groupId != null ? extra.groupId : (invite ? invite.groupId : null)),
    ...extra,
  });
}

function page(req, res) {
  const invite = groups.lookupInvite(req.params.token);
  if (!invite) return render(req, res, null);
  const uid = viewerId(req);
  if (uid == null) return render(req, res, invite, { needLogin: true, loginUrl: loginUrl(req.params.token) });
  const already = groups.isMember(uid, invite.groupId);
  return render(req, res, invite, { already });
}

function accept(req, res) {
  const raw = req.params.token;
  const invite = groups.lookupInvite(raw);
  if (!invite) return render(req, res, null);
  const uid = viewerId(req);
  if (uid == null) return res.redirect(loginUrl(raw));
  try {
    const r = groups.acceptInvite(raw, uid, { ip: req.ip });
    return render(req, res, null, { done: true, already: r.already, groupPath: invite.path, role: roleLabel(res.locals.t, r.role), groupId: invite.groupId });
  } catch (err) {
    if (err.code === 'INVITE_INVALID') return render(req, res, null);
    if (err.code === 'USER_DISABLED' || err.code === 'USER_NOT_FOUND') return res.redirect(loginUrl(raw));
    logger.error({ err: err.message }, 'Joining a group with an invitation failed');
    return render(req, res, invite, { error: res.locals.t('grp.join.failed') });
  }
}

module.exports = { page, accept };
