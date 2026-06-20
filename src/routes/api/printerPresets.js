'use strict';
const { Router } = require('express');
const preset = require('../../services/printerPreset');
const { evaluateRouteLicense } = require('../../services/routeLicense');
const gateways = require('../../services/gateways');
const logger = require('../../utils/logger');
const router = Router();

function deny(res, req, key, extra = {}) { return res.status(403).json({ ok: false, error: req.t ? req.t(key) : key, upgrade_url: 'https://callmetechie.de/products/gatecontrol/pricing', ...extra }); }

router.post('/', async (req, res) => {
  const b = req.body || {};
  const ports = Array.isArray(b.print_ports) ? b.print_ports : [];
  const scanOn = !!(b.scan && b.scan.enabled);
  const ewsOn = !!(b.ews && b.ews.enabled);
  // License gate (combined, before any creation).
  const verdict = evaluateRouteLicense({ httpCount: ewsOn ? 1 : 0, l4Count: ports.length + (scanOn && b.scan.target && b.scan.target.mode === 'new' ? 1 : 0), targetKind: 'gateway', scanEgress: scanOn });
  if (!verdict.ok) return deny(res, req, verdict.key, verdict.extra);
  try {
    const result = await preset.createPreset(b);
    // Gateway push: near peer (egress) + NAS peer (skipSync'd NAS route). A failed
    // push is NOT fatal (route is live, self-heal reconcile picks it up) → warning (R1-G5).
    const warnings = [];
    const push = async (pid) => { try { await gateways.notifyConfigChanged(pid); } catch (_e) { warnings.push(`gateway ${pid} push failed (self-heal will reconcile)`); } };
    if (result.egress_id) await push(b.near_peer_id);
    if (result.nas_route_id && b.scan && b.scan.target && b.scan.target.nas_peer_id) await push(b.scan.target.nas_peer_id);
    res.status(201).json({ ok: true, preset: { ...result, warning: warnings.length ? warnings.join('; ') : null } });
  } catch (err) {
    if (err.statusCode === 409) return res.status(409).json({ ok: false, error: err.message, code: err.code });
    if (err.statusCode === 400) return res.status(400).json({ ok: false, error: err.message });
    if ((err.message || '').includes('Caddy')) return res.status(502).json({ ok: false, error: req.t('error.routes.caddy_unreachable') });
    logger.error({ error: err.message }, 'printer preset failed');
    res.status(500).json({ ok: false, error: req.t('error.bundles.preset') });
  }
});
module.exports = router;
