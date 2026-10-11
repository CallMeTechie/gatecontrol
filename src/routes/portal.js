'use strict';

/**
 * Portal pages (the VPN landing portal on its own host, Caddy rewrites / to
 * /portal there). Identity comes from portalIdentity (device by VPN source
 * address) and portalOwner (who is looking: web session, portal session,
 * anonymous mode, device trust).
 *
 *   GET  /portal                 the portal (redesign "variant A": tabs)
 *   GET  /auto?t=<ticket>[&next=<tab>]  one-time login link of the apps
 *                                (next: portalTickets.portalNext, else /portal)
 *   GET  /portal/who             "Wer bist du?" on a shared device
 *   POST /portal/who             pick a person + portal PIN
 *   POST /portal/switch          "Person wechseln" (shared device)
 *   POST /portal/anonymous       "nur die Dienste für alle anzeigen"
 *   POST /portal/identify        leave the anonymous mode again
 *
 * Portal sessions are separate from the web UI: session.portalOnly with
 * session.portalUserId (never session.userId), so requireAuth — and with it
 * every admin page and admin API — treats them as logged out. Every
 * login-like step regenerates the session (fixation). Redirect targets are
 * fixed paths only. Ticket values are never logged.
 */

const { Router } = require('express');
const config = require('../../config/default');
const portalConfig = require('../services/portalConfig');
const portalIdentity = require('../middleware/portalIdentity');
const portalOwner = require('../middleware/portalOwner');
const portalTickets = require('../services/portalTickets');
const portalDevices = require('../services/portalDevices');
const portalPin = require('../services/portalPin');
const users = require('../services/users');
const license = require('../services/license');
const activity = require('../services/activity');
const logger = require('../utils/logger');
const { csrfProtection, ensureCsrfToken } = require('../middleware/csrf');
const { stringsWithPrefix } = require('../middleware/i18n');
const { portalPageLimiter, portalPinLimiter } = require('../middleware/rateLimit');

const router = Router();

/** Lifetime of a portal session (login link or picker). */
const PORTAL_SESSION_MS = 8 * 60 * 60 * 1000;

function enabled(req, res, next) {
  if (!portalConfig().enabled) return res.sendStatus(404);
  return next();
}

function noStore(res) {
  res.set('Cache-Control', 'no-store');
  res.set('Referrer-Policy', 'no-referrer');
}

/** Regenerate the session (fixation) and fill it; `done(err)` afterwards. */
function freshSession(req, fill, done) {
  req.session.regenerate((err) => {
    if (err) return done(err);
    fill(req.session);
    req.session.save(done);
  });
}

function startPortalSession(req, { userId, peerId, via, remember }, done) {
  const user = users.getById(userId);
  freshSession(req, (s) => {
    s.portalOnly = true;
    s.portalUserId = userId;
    s.portalPeerId = peerId;
    s.portalVia = via;
    s.portalAt = Date.now();
    if (user && user.language) s.language = user.language;
    if (remember === false) s.cookie.expires = false; // browser-session cookie
    else s.cookie.maxAge = PORTAL_SESSION_MS;
  }, done);
}

/** Web origin of the admin UI for "Konto & Sicherheit" (server config, never request data). */
function accountUrl() {
  try { return new URL('/profile', config.app.baseUrl).href; } catch { return '/profile'; }
}

function notifyEnabled() {
  try { return !!require('../services/notify/config').value('enabled'); } catch { return false; }
}

/** Which tabs have something to show (unlicensed or empty areas stay hidden). */
function tabsFor(req, plg) {
  const sections = (plg && plg.sections) || { home: [], car: [] };
  const w = portalConfig().widgets;
  const identified = req.portalPeerId != null;
  return {
    start: true,
    services: identified && w.services,
    home: sections.home.length > 0,
    plugins: ((plg && plg.tabs) || []).length + sections.home.length + sections.car.length > 0,
    car: sections.car.length > 0,
    net: identified && (w.device || w.traffic || w.pihole),
    device: identified && w.device,
    traffic: identified && w.traffic,
    pihole: identified && w.pihole && license.hasFeature('pihole_integration'),
    devices: !!req.portalLoggedIn,
    // Notification center: bell, inbox, own settings (signed in, push on).
    notify: !!req.portalLoggedIn && notifyEnabled(),
  };
}

/** The portal viewer as plugins see it ({ id, name, role, portal: true, loggedIn }) or null. */
function portalViewer(req) {
  if (req.portalOwnerId == null) return null;
  const u = users.getById(req.portalOwnerId);
  if (!u || u.enabled !== 1) return null;
  return { id: u.id, name: u.display_name || u.username, role: u.role, portal: true, loggedIn: !!req.portalLoggedIn };
}

/**
 * What running plugins add for this viewer (docs/plugins.md "Portal"): own
 * tabs and sections in "Zuhause"/"Fahrzeug" — only for an identified viewer,
 * only those whose plugin has something for this person (portalVisible).
 */
async function pluginContributions(req, lang) {
  const none = { tabs: [], sections: { home: [], car: [] } };
  const user = portalViewer(req);
  if (!user) return none;
  try { return await require('../services/plugins/portal').contributions(user, lang === 'en' ? 'en' : 'de'); } catch { return none; }
}

/** Who the header shows. */
function viewerFor(req) {
  const deviceName = req.portalPeerName || '';
  if (req.portalOwnerId != null) {
    const u = users.getById(req.portalOwnerId);
    if (u) {
      let via = 'login';
      if (req.portalOwnerSource === 'device') via = 'device';
      else if (req.portalOwnerSource === 'portal') via = req.session.portalVia === 'pin' ? 'pin' : 'link';
      const name = portalDevices.displayName(u);
      return {
        kind: 'person', via, name, first: portalDevices.firstName(u), initials: portalDevices.initials(name), deviceName,
        canWebLogin: users.canWebLogin(u),
        canEnroll: u.enabled === 1 && (u.role === 'admin' || u.self_enroll_enabled === 1),
      };
    }
  }
  if (req.portalAnonymous) return { kind: 'anonymous', deviceName };
  return { kind: 'guest', deviceName };
}

// ─── GET /portal ───────────────────────────────────────────────────────────
router.get('/portal', portalPageLimiter, enabled, portalIdentity, portalOwner, async (req, res, next) => {
  // A shared device asks first — never IP trust there.
  if (req.portalSharedDevice && req.portalOwnerId == null && !req.portalAnonymous) {
    return res.redirect('/portal/who');
  }
  noStore(res);
  let note = null;
  if (req.session && req.session.portalNote) {
    note = req.session.portalNote === 'link_invalid' ? 'link_invalid' : null;
    delete req.session.portalNote;
  }
  // State-changing portal requests need the session's CSRF token.
  if (req.portalLoggedIn || req.portalAnonymous || req.portalSharedDevice) ensureCsrfToken(req, res);
  const viewer = viewerFor(req);
  const lang0 = req.language || res.locals.language;
  let plg;
  try { plg = await pluginContributions(req, lang0); } catch (e) { return next(e); }
  const tabs = tabsFor(req, plg);
  const lang = req.language || res.locals.language;
  const island = (obj) => JSON.stringify(obj).replace(/</g, '\\u003c');
  res.render('portal/portal.njk', {
    portalI18n: island(stringsWithPrefix(lang, ['portal.'])),
    portalCtx: island({
      csrf: res.locals.csrfToken || '',
      lang,
      loggedIn: !!req.portalLoggedIn,
      identified: req.portalPeerId != null,
      person: viewer.kind === 'person',
      firstName: viewer.kind === 'person' ? viewer.first : '',
      canEnroll: viewer.kind === 'person' && !!req.portalLoggedIn && !!viewer.canEnroll,
      tabs,
    }),
    widgets: portalConfig().widgets,
    tabs,
    pluginTabs: plg.tabs,
    pluginSections: plg.sections,
    // Start tiles / search of plugins (public/js/portal.js asks /api/v1/portal/plugins/start|search)
    viewer,
    note,
    deviceName: req.portalPeerName,   // null → generic welcome
    identified: req.portalPeerId != null,
    sharedDevice: req.portalSharedDevice,
    portalSession: req.portalOwnerSource === 'portal',
    // Reflect the (host-scoped) web session so the header shows Login vs Logout.
    loggedIn: !!(req.session && req.session.userId),
    portalLoggedIn: !!req.portalLoggedIn,
    accountUrl: viewer.kind === 'person' && viewer.canWebLogin ? accountUrl() : null,
  });
});

// ─── GET /auto?t=… — one-time login link of the apps ───────────────────────
router.get('/auto', portalPageLimiter, enabled, portalIdentity, (req, res, next) => {
  noStore(res);
  const raw = typeof req.query.t === 'string' ? req.query.t : '';
  const ticket = portalTickets.consume(raw);
  // Deep link of the app: a validated portal tab, or the portal itself.
  const rawNext = typeof req.query.next === 'string' ? req.query.next : (typeof req.query.path === 'string' ? req.query.path : '');
  const target = portalTickets.portalNext(rawNext) || '/portal';
  // Same device as the one the ticket was issued for (when the device is known).
  const valid = !!ticket && (req.portalPeerId == null || req.portalPeerId === ticket.peerId);
  const info = valid ? portalDevices.usageForPeer(ticket.peerId) : null;
  const fail = (err) => (err ? next(err) : res.redirect('/portal'));
  if (!valid || !info) {
    if (ticket) logger.warn({ ticketPeer: ticket.peerId, requestPeer: req.portalPeerId }, 'portal login link used from another device');
    return freshSession(req, (s) => { s.portalAnonymous = true; s.portalNote = 'link_invalid'; }, fail);
  }
  const toTarget = (err) => (err ? next(err) : res.redirect(target));
  if (info.mode === 'multi') {
    // Shared device: the picker first; the target follows the PIN.
    return freshSession(req, (s) => { if (target !== '/portal') s.portalNext = target; }, (err) => (err ? next(err) : res.redirect('/portal/who')));
  }
  if (!portalOwner.trustEnabled() || ticket.userId == null || !portalDevices.userMayUseDevice(ticket.userId, ticket.peerId)) {
    // Automatic recognition switched off (or nobody to sign in): the portal
    // as it is without the link.
    return freshSession(req, () => {}, toTarget);
  }
  return startPortalSession(req, { userId: ticket.userId, peerId: ticket.peerId, via: 'link' }, (err) => {
    if (err) return next(err);
    logger.info({ userId: ticket.userId, peerId: ticket.peerId }, 'portal: signed in with the login link of the app');
    return toTarget();
  });
});

// ─── "Wer bist du?" ────────────────────────────────────────────────────────
function renderWho(req, res, { status = 200, error = null, selected = null } = {}) {
  ensureCsrfToken(req, res);
  noStore(res);
  const info = portalDevices.usageForPeer(req.portalPeerId);
  res.status(status).render('portal/who.njk', {
    deviceName: (info && info.name) || req.portalPeerName || '',
    people: portalDevices.peopleForPicker(req.portalPeerId),
    selected,
    error,
  });
}

router.get('/portal/who', portalPageLimiter, enabled, portalIdentity, portalOwner, (req, res) => {
  if (!req.portalSharedDevice) return res.redirect('/portal');
  return renderWho(req, res);
});

router.post('/portal/who', portalPinLimiter, enabled, csrfProtection, portalIdentity, portalOwner, async (req, res, next) => {
  if (!req.portalSharedDevice) return res.redirect('/portal');
  const t = res.locals.t;
  const people = portalDevices.peopleForPicker(req.portalPeerId);
  const userId = Number.parseInt(String((req.body && req.body.user) || ''), 10);
  const person = people.find((p) => p.id === userId);
  if (!person) return renderWho(req, res, { status: 400, error: t('portal.who.err_pick') });
  const pin = typeof req.body.pin === 'string' ? req.body.pin.trim() : '';
  let result;
  try {
    result = await portalPin.verify(person.id, req.portalPeerId, pin, { ip: req.ip });
  } catch (err) {
    logger.error({ err: err.message }, 'portal: PIN check failed');
    return renderWho(req, res, { status: 500, error: t('portal.who.err_generic'), selected: person.id });
  }
  if (!result.ok) {
    if (result.reason === 'locked') {
      return renderWho(req, res, { status: 429, selected: person.id,
        error: t('portal.who.err_locked', { name: person.name, minutes: Math.max(1, Math.ceil(result.retryAfter / 60)) }) });
    }
    if (result.reason === 'no_pin') {
      return renderWho(req, res, { status: 400, selected: person.id, error: t('portal.who.err_no_pin', { name: person.name }) });
    }
    return renderWho(req, res, { status: 400, selected: person.id,
      error: result.attemptsLeft === 1 ? t('portal.who.err_wrong_last') : t('portal.who.err_wrong', { count: result.attemptsLeft }) });
  }
  const remember = req.body.remember === '1' || req.body.remember === 'on';
  const peerId = req.portalPeerId;
  // The app's deep link (GET /auto on a shared device), validated again.
  const target = portalTickets.portalNext(req.session && req.session.portalNext) || '/portal';
  return startPortalSession(req, { userId: person.id, peerId, via: 'pin', remember }, (err) => {
    if (err) return next(err);
    activity.log('portal_person_picked', `Portal: a person signed in with the PIN on shared device #${peerId}`, {
      source: 'user', ipAddress: req.ip, severity: 'info', details: { userId: person.id, peerId, remember },
    });
    return res.redirect(target);
  });
});

// "Person wechseln": end the portal session on a shared device.
router.post('/portal/switch', portalPageLimiter, enabled, csrfProtection, portalIdentity, portalOwner, (req, res, next) => {
  const target = req.portalSharedDevice ? '/portal/who' : '/portal';
  freshSession(req, () => {}, (err) => (err ? next(err) : res.redirect(target)));
});

// "nur die Dienste für alle anzeigen" — nobody is shown, nothing personal.
router.post('/portal/anonymous', portalPageLimiter, enabled, csrfProtection, (req, res, next) => {
  freshSession(req, (s) => { s.portalAnonymous = true; }, (err) => (err ? next(err) : res.redirect('/portal')));
});

// Leave the anonymous mode (back to automatic recognition / the picker).
router.post('/portal/identify', portalPageLimiter, enabled, csrfProtection, (req, res, next) => {
  freshSession(req, () => {}, (err) => (err ? next(err) : res.redirect('/portal')));
});

module.exports = router;
module.exports.PORTAL_SESSION_MS = PORTAL_SESSION_MS;
