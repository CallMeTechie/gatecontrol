'use strict';

// Web Application Firewall API (docs/feature-waf.md). Admin session or token
// scope `routes` (/api/v1/waf → 'routes' in services/tokens.js).
//
//   GET    /waf/status                    engine, licence, routes with WAF + 24 h counters
//   GET    /waf/events                    event list (filters, keyset cursor)
//   POST   /waf/routes/:id/exclusions     { rule_id?, path? } → add + Caddy sync   (feature `waf`)
//   DELETE /waf/routes/:id/exclusions     { rule_id?, path? } (body or query)       (feature `waf`)
// Release B §3 (docs/feature-release-b.md), all feature `waf`:
//   GET    /waf/bans                      { ok, bans:[{ip, reason, hits, first_seen, banned_at, expires_at, manual}] }
//   POST   /waf/bans                      { ip, duration_h?, reason? } → { ok, ban }   (manual ban, synced at once)
//   DELETE /waf/bans/:ip                  → { ok, ban }  (IP or CIDR, '/' as %2F)
//   GET    /waf/assistant[?route_id=]     { ok, routes:[…] } (services/wafAssistant.js)
//
// Errors: { ok:false, error, code } — codes from services/waf.js (WAF_*), plus
// CADDY_SYNC_FAILED (502) when the change could not be deployed (rolled back).

const { Router } = require('express');
const waf = require('../../services/waf');
const wafBans = require('../../services/wafBans');
const wafAssistant = require('../../services/wafAssistant');
const license = require('../../services/license');
const { requireFeature } = require('../../middleware/license');
const logger = require('../../utils/logger');

const router = Router();

function sendError(res, err, label) {
  if (err && err.statusCode && err.code) {
    return res.status(err.statusCode).json({ ok: false, error: err.message, code: err.code });
  }
  if (err && /caddy/i.test(String(err.message || ''))) {
    return res.status(502).json({ ok: false, error: err.message, code: 'CADDY_SYNC_FAILED' });
  }
  logger.warn({ err: err && err.message }, `${label} failed`);
  return res.status(500).json({ ok: false, error: `${label} failed` });
}

router.get('/status', (req, res) => {
  try {
    res.json({ ok: true, licensed: license.hasFeature('waf'), ...waf.status() });
  } catch (err) {
    sendError(res, err, 'GET /waf/status');
  }
});

router.get('/events', (req, res) => {
  try {
    const q = req.query || {};
    res.json({
      ok: true,
      ...waf.listEvents({
        host: q.host, route_id: q.route_id, action: q.action, rule_id: q.rule_id,
        from: q.from, to: q.to, limit: q.limit, cursor: q.cursor,
      }),
    });
  } catch (err) {
    sendError(res, err, 'GET /waf/events');
  }
});

function exclusionBody(req) {
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  const q = req.query || {};
  return {
    rule_id: b.rule_id !== undefined ? b.rule_id : q.rule_id,
    path: b.path !== undefined ? b.path : q.path,
  };
}

router.post('/routes/:id/exclusions', requireFeature('waf'), async (req, res) => {
  try {
    const out = await waf.addExclusion(req.params.id, exclusionBody(req));
    res.json({ ok: true, route_id: Number(req.params.id), ...out });
  } catch (err) {
    sendError(res, err, 'POST /waf/routes/:id/exclusions');
  }
});

router.delete('/routes/:id/exclusions', requireFeature('waf'), async (req, res) => {
  try {
    const out = await waf.removeExclusion(req.params.id, exclusionBody(req));
    res.json({ ok: true, route_id: Number(req.params.id), ...out });
  } catch (err) {
    sendError(res, err, 'DELETE /waf/routes/:id/exclusions');
  }
});

// ─── Scanner ban (release B §3) ─────────────────────────

router.get('/bans', requireFeature('waf'), (req, res) => {
  try {
    res.json({ ok: true, bans: wafBans.listBans() });
  } catch (err) {
    sendError(res, err, 'GET /waf/bans');
  }
});

router.post('/bans', requireFeature('waf'), async (req, res) => {
  try {
    const ban = await wafBans.addBan(req.body || {});
    res.status(201).json({ ok: true, ban });
  } catch (err) {
    sendError(res, err, 'POST /waf/bans');
  }
});

router.delete('/bans/:ip', requireFeature('waf'), async (req, res) => {
  try {
    const ban = await wafBans.removeBan(req.params.ip);
    res.json({ ok: true, ban });
  } catch (err) {
    sendError(res, err, 'DELETE /waf/bans/:ip');
  }
});

// ─── Assistant (release B §3) ───────────────────────────

router.get('/assistant', requireFeature('waf'), async (req, res) => {
  try {
    const q = req.query || {};
    let routeId;
    if (q.route_id !== undefined && q.route_id !== '') {
      routeId = Number(q.route_id);
      if (!Number.isInteger(routeId) || routeId < 1) {
        return res.status(400).json({ ok: false, error: 'route_id must be a positive integer', code: 'WAF_ROUTE_ID_INVALID' });
      }
    }
    res.json({ ok: true, ...(await wafAssistant.assistant({ routeId })) });
  } catch (err) {
    sendError(res, err, 'GET /waf/assistant');
  }
});

module.exports = router;
