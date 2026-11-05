'use strict';

// Admin API of phase 3b of the gateways (tabs "DNS-Filter" and
// "Zwischenspeicher", their switches in the card "Funktionen dieses
// Gateways"), mounted at /api/v1/gateways next to gatewayNet.js behind
// requireAuth + apiLimiter + CSRF + requireAdmin (routes/api/index.js).
// Every route here also needs an admin SESSION: API tokens are refused
// (requireAdminSession).
//
//   GET    /:id/dns                        state, today's numbers, profiles, router check, catalogue
//   PUT    /:id/dns                        { enabled?, logQueries?, upstream?, allowAll? }
//   POST   /:id/dns/profiles               { name, lists?, safeSearch?, allow?, deny?, schedules?, users?, devices? }
//   PUT    /:id/dns/profiles/:pid          the same fields
//   DELETE /:id/dns/profiles/:pid          not the default profile
//   POST   /:id/dns/test                   { domain, deviceId? } "Test: Domain prüfen" (gateway management API)
//   GET    /:id/cache                      settings, usage, stock, storage suggestion (never the secret)
//   PUT    /:id/cache                      { enabled?, path?, maxBytes?, kinds? }
//   POST   /:id/cache/clear                "Zwischenspeicher leeren" (gateway management API)

const { Router } = require('express');
const { requireAdminSession } = require('../../middleware/auth');
const logger = require('../../utils/logger');

const router = Router();

const STATUS = {
  not_found: 404, invalid: 400, invalid_domain: 400, invalid_url: 400, invalid_name: 400, invalid_schedule: 400, invalid_member: 400,
  invalid_path: 400, name_taken: 409, too_many: 409, default_profile: 409,
  gateway_unreachable: 502, gateway_error: 502, gateway_unsupported: 409, unavailable: 409,
};

function fail(res, err) {
  const code = (err && err.code) || 'internal';
  if (!STATUS[code]) logger.error({ err: err && err.message }, 'gateway phase 3b admin API failed');
  const body = { ok: false, code, error: STATUS[code] ? err.message : 'internal error' };
  if (err && err.value !== undefined) body.value = err.value;
  if (err && err.index !== undefined) body.index = err.index;
  return res.status(STATUS[code] || 500).json(body);
}

function actor(req) {
  let user = null;
  try { const u = require('../../services/users').getById(req.session.userId); user = u ? u.username : null; } catch { user = null; }
  return { ip: req.ip, user };
}

const handle = (fn) => async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    const out = await fn(req, res);
    if (!res.headersSent) res.json({ ok: true, ...out });
  } catch (e) { fail(res, e); }
};

const dns = () => require('../../services/homeDns');
const cache = () => require('../../services/homeCache');

router.get('/:id/dns', requireAdminSession, handle((req) => dns().view(req.params.id)));
router.put('/:id/dns', requireAdminSession, handle((req) => ({ settings: dns().setGeneral(req.params.id, req.body, actor(req)) })));
router.post('/:id/dns/profiles', requireAdminSession, handle((req) => ({ profile: dns().createProfile(req.params.id, req.body, actor(req)) })));
router.put('/:id/dns/profiles/:pid', requireAdminSession, handle((req) => ({ profile: dns().updateProfile(req.params.id, String(req.params.pid), req.body, actor(req)) })));
router.delete('/:id/dns/profiles/:pid', requireAdminSession, handle((req) => dns().deleteProfile(req.params.id, String(req.params.pid), actor(req))));
router.post('/:id/dns/test', requireAdminSession, handle(async (req) => ({ result: await dns().test(req.params.id, req.body) })));

router.get('/:id/cache', requireAdminSession, handle((req) => cache().view(req.params.id)));
router.put('/:id/cache', requireAdminSession, handle((req) => ({ settings: cache().set(req.params.id, req.body, actor(req)) })));
router.post('/:id/cache/clear', requireAdminSession, handle(async (req) => cache().clear(req.params.id, actor(req))));

module.exports = router;
