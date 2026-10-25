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
 */

const { ensureCsrfToken } = require('../middleware/csrf');
const groups = require('../services/groups');
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

function render(req, res, invite, extra = {}) {
  ensureCsrfToken(req, res);
  noStore(res);
  const t = res.locals.t;
  res.status(invite || extra.done ? 200 : 404).render(`${res.locals.theme || 'aurora'}/pages/group-join.njk`, {
    title: t('grp.join.title'),
    layout: false,
    invite: invite ? { path: invite.path, name: invite.name, role: roleLabel(t, invite.role) } : null,
    token: invite ? req.params.token : '',
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
    return render(req, res, null, { done: true, already: r.already, groupPath: invite.path, role: roleLabel(res.locals.t, r.role) });
  } catch (err) {
    if (err.code === 'INVITE_INVALID') return render(req, res, null);
    if (err.code === 'USER_DISABLED' || err.code === 'USER_NOT_FOUND') return res.redirect(loginUrl(raw));
    logger.error({ err: err.message }, 'Joining a group with an invitation failed');
    return render(req, res, invite, { error: res.locals.t('grp.join.failed') });
  }
}

module.exports = { page, accept };
