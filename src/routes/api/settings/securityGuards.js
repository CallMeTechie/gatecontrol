'use strict';

// Einstellungen › Sicherheit: IP-Sperre and Routenschutz (admin session only —
// settings/index.js TOKEN_FORBIDDEN):
//
//   GET    /api/v1/settings/ip-block                 → { ok, config, never, exceptions, bans, stats, engine, licensed, … }
//   PUT    /api/v1/settings/ip-block                 { enabled?, threshold?, window_min?, notify?, sources?, lists? }
//   POST   /api/v1/settings/ip-block/bans            { ip, hours: 1|24|168|720|null, note? } (by hand)
//   DELETE /api/v1/settings/ip-block/bans/:ip        unblock (IP or CIDR, URL-encoded)
//   POST   /api/v1/settings/ip-block/never           { ip, label? } ("Nie sperren")
//   DELETE /api/v1/settings/ip-block/never/:ip
//   POST   /api/v1/settings/ip-block/lists/refresh   download the block lists now (licence ip_blocklists)
//
//   GET    /api/v1/settings/route-guard              → { ok, routes, stats, attention, defaults, licensed, geoKey, vpn }
//   PUT    /api/v1/settings/route-guard              { defaults?: { access, waf, countries, rate_limit }, vpn?: { two_places, new_country } }
//   POST   /api/v1/settings/route-guard/routes/:id/vpn-only   "Nur über VPN" (external_enabled = 0, Caddy synced)
//   POST   /api/v1/settings/route-guard/routes/:id/ack        "Ist Absicht"
//   DELETE /api/v1/settings/route-guard/routes/:id/ack
//
// Errors: { ok: false, error, code, fields?: { <field>: message } } — the
// settings page shows a field error next to its control; licence errors
// carry `feature`.

const { Router } = require('express');
const ipBlock = require('../../../services/ipBlock');
const routeGuard = require('../../../services/routeGuard');
const vpnGuard = require('../../../services/vpnGuard');
const { requireFeature } = require('../../../middleware/license');
const logger = require('../../../utils/logger');

const router = Router();

function fail(req, res, err, label) {
  if (err && err.statusCode && err.code) {
    const body = { ok: false, error: err.message, code: err.code };
    if (err.field) body.fields = { [err.field]: err.message };
    if (err.feature) body.feature = err.feature;
    if (Array.isArray(err.failed)) body.failed = err.failed;
    return res.status(err.statusCode).json(body);
  }
  if (err && /caddy/i.test(String(err.message || ''))) return res.status(502).json({ ok: false, error: err.message, code: 'CADDY_SYNC_FAILED' });
  logger.warn({ err: err && err.message }, `${label} failed`);
  return res.status(500).json({ ok: false, error: req.t('common.error') });
}

function userId(req) { return req.session && req.session.userId != null ? req.session.userId : null; }

// ─── IP-Sperre ──────────────────────────────────────

router.get('/ip-block', (req, res) => {
  try { res.json({ ok: true, ...ipBlock.view() }); } catch (err) { fail(req, res, err, 'GET /settings/ip-block'); }
});

router.put('/ip-block', (req, res) => {
  try {
    ipBlock.setConfig(req.body || {});
    res.json({ ok: true, ...ipBlock.view() });
  } catch (err) { fail(req, res, err, 'PUT /settings/ip-block'); }
});

router.post('/ip-block/bans', (req, res) => {
  try {
    const b = req.body || {};
    const ban = ipBlock.banManual({ ip: b.ip, hours: b.hours === undefined ? null : b.hours, note: b.note }, userId(req));
    res.status(201).json({ ok: true, ban });
  } catch (err) { fail(req, res, err, 'POST /settings/ip-block/bans'); }
});

router.delete('/ip-block/bans/:ip', (req, res) => {
  try { res.json({ ok: true, ban: ipBlock.unban(req.params.ip) }); } catch (err) { fail(req, res, err, 'DELETE /settings/ip-block/bans'); }
});

router.post('/ip-block/never', (req, res) => {
  try { res.status(201).json({ ok: true, ...ipBlock.addNever(req.body || {}) }); } catch (err) { fail(req, res, err, 'POST /settings/ip-block/never'); }
});

router.delete('/ip-block/never/:ip', (req, res) => {
  try { res.json({ ok: true, never: ipBlock.removeNever(req.params.ip) }); } catch (err) { fail(req, res, err, 'DELETE /settings/ip-block/never'); }
});

router.post('/ip-block/lists/refresh', requireFeature('ip_blocklists'), async (req, res) => {
  try {
    const result = await ipBlock.refreshLists({ force: true });
    res.json({ ok: true, result, stats: ipBlock.stats() });
  } catch (err) { fail(req, res, err, 'POST /settings/ip-block/lists/refresh'); }
});

// ─── Routenschutz ───────────────────────────────────

router.get('/route-guard', (req, res) => {
  try { res.json({ ok: true, ...routeGuard.overview() }); } catch (err) { fail(req, res, err, 'GET /settings/route-guard'); }
});

router.put('/route-guard', (req, res) => {
  try {
    const b = req.body || {};
    if (b.defaults !== undefined) routeGuard.setDefaults(b.defaults);
    if (b.vpn !== undefined) vpnGuard.setConfig(b.vpn);
    res.json({ ok: true, ...routeGuard.overview() });
  } catch (err) { fail(req, res, err, 'PUT /settings/route-guard'); }
});

function routeId(req) {
  const n = Number(req.params.id);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

router.post('/route-guard/routes/:id/vpn-only', async (req, res) => {
  const id = routeId(req);
  if (!id) return res.status(404).json({ ok: false, error: 'route not found', code: 'not_found' });
  try { res.json({ ok: true, route: await routeGuard.vpnOnly(id, userId(req)) }); } catch (err) { fail(req, res, err, 'POST /settings/route-guard vpn-only'); }
});

router.post('/route-guard/routes/:id/ack', (req, res) => {
  const id = routeId(req);
  if (!id) return res.status(404).json({ ok: false, error: 'route not found', code: 'not_found' });
  try { res.json({ ok: true, route: routeGuard.acknowledge(id, userId(req)) }); } catch (err) { fail(req, res, err, 'POST /settings/route-guard ack'); }
});

router.delete('/route-guard/routes/:id/ack', (req, res) => {
  const id = routeId(req);
  if (!id) return res.status(404).json({ ok: false, error: 'route not found', code: 'not_found' });
  try { res.json({ ok: true, route: routeGuard.unacknowledge(id) }); } catch (err) { fail(req, res, err, 'DELETE /settings/route-guard ack'); }
});

module.exports = router;
