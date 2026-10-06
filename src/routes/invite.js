'use strict';

/**
 * /invite/:token — the public page of an invitation to "Mein Bereich".
 * GET shows the form (or "invalid or expired"), POST sets the password via
 * services/userInvites.accept — plus, optionally, the portal PIN for shared
 * devices — and sends the person to the login page.
 * Nothing about the account is shown before the token checks out; an
 * unknown, used or expired token gets one and the same answer.
 */

const { ensureCsrfToken } = require('../middleware/csrf');
const { setFlash } = require('../middleware/locals');
const invites = require('../services/userInvites');
const users = require('../services/users');
const portalPin = require('../services/portalPin');
const logger = require('../utils/logger');

function render(req, res, invite, extra = {}) {
  ensureCsrfToken(req, res);
  res.set('Cache-Control', 'no-store');
  res.set('Referrer-Policy', 'no-referrer');
  res.status(invite ? 200 : 404).render(`${res.locals.theme}/pages/invite.njk`, {
    title: res.locals.t('invite.title'),
    layout: false,
    invite: invite ? { name: invite.display_name || invite.username, username: invite.username } : null,
    token: invite ? req.params.token : '',
    minLength: users.PASSWORD_MIN_LENGTH,
    ...extra,
  });
}

function page(req, res) {
  return render(req, res, invites.lookup(req.params.token));
}

async function accept(req, res) {
  const raw = req.params.token;
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const confirm = typeof req.body.password_confirm === 'string' ? req.body.password_confirm : '';
  const invite = invites.lookup(raw);
  if (!invite) return render(req, res, null);
  if (password !== confirm) return render(req, res, invite, { error: res.locals.t('pwchange.mismatch') });
  // Optional second step: the portal PIN for shared devices ("Wer bist du?").
  const pin = typeof req.body.pin === 'string' ? req.body.pin.trim() : '';
  const pinConfirm = typeof req.body.pin_confirm === 'string' ? req.body.pin_confirm.trim() : '';
  if (pin || pinConfirm) {
    if (!portalPin.validPin(pin)) return render(req, res, invite, { error: res.locals.t('profile.pin.err_format') });
    if (pin !== pinConfirm) return render(req, res, invite, { error: res.locals.t('profile.pin.err_mismatch') });
  }
  let accepted;
  try {
    accepted = await invites.accept(raw, password, { ip: req.ip });
  } catch (err) {
    if (err.code === 'PASSWORD_POLICY') {
      const msg = err.policy.map((e) => {
        let m = res.locals.t(e.key);
        for (const [k, v] of Object.entries(e.params || {})) m = m.split(`{{${k}}}`).join(String(v));
        return m;
      }).join(' · ');
      return render(req, res, invite, { error: msg });
    }
    if (err.code === 'INVALID') return render(req, res, null);
    logger.error({ err: err.message }, 'Accepting an invitation failed');
    return render(req, res, invite, { error: res.locals.t('auth.error_generic') });
  }
  if (pin) {
    try { await portalPin.setPin(accepted.userId, pin, { ip: req.ip, source: 'user' }); } catch (err) {
      logger.error({ err: err.message }, 'Setting the portal PIN with the invitation failed');
    }
  }
  // A session of somebody else in this browser must not carry over.
  if (req.session && req.session.userId) {
    return req.session.destroy(() => res.redirect('/login'));
  }
  setFlash(req, 'success', res.locals.t('invite.done'));
  return res.redirect('/login');
}

module.exports = { page, accept };
