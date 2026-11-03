'use strict';

// Einstellungen › Sicherheit › Virenscan (services/scan) — admin session only
// (settings/index.js TOKEN_FORBIDDEN):
//
//   GET    /api/v1/settings/scan                       → { ok, config, licensed, scanner, down, hashlist, stats, quarantine, … }
//   PUT    /api/v1/settings/scan                       { engine, address, icap_service, unreachable, sources, action,
//                                                        unscannable, notify, max_mb, archive_depth, rescan, sig_check_h, abusech_key }
//   POST   /api/v1/settings/scan/test                  { engine?, address?, icap_service? } "Verbindung testen"
//   POST   /api/v1/settings/scan/eicar                 "Mit Testdatei prüfen" (nothing is stored)
//   POST   /api/v1/settings/scan/refresh               "Signaturen jetzt aktualisieren"
//   POST   /api/v1/settings/scan/recheck-all           "Alle erneut prüfen" (the quarantine)
//   GET    /api/v1/settings/scan/history               found, not scannable, deleted, released
//   POST   /api/v1/settings/scan/findings/:id/recheck
//   POST   /api/v1/settings/scan/findings/:id/release  "Trotzdem freigeben" (logged, checksum exception)
//   DELETE /api/v1/settings/scan/findings/:id          delete the file
//
// Errors: { ok: false, error, code, fields?, feature? }.

const { Router } = require('express');
const scan = require('../../../services/scan');
const logger = require('../../../utils/logger');

const router = Router();

function fail(req, res, err, label) {
  if (err && err.statusCode && err.code) {
    const body = { ok: false, error: err.message, code: err.code };
    if (err.field) body.fields = { [err.field]: err.message };
    if (err.feature) body.feature = err.feature;
    return res.status(err.statusCode).json(body);
  }
  logger.warn({ err: err && err.message }, `${label} failed`);
  return res.status(500).json({ ok: false, error: req.t('common.error') });
}

const uid = (req) => (req.session && req.session.userId != null ? req.session.userId : null);
const fid = (req) => { const n = Number(req.params.id); return Number.isSafeInteger(n) && n > 0 ? n : 0; };

router.get('/scan', async (req, res) => {
  try { res.json({ ok: true, ...(await scan.view({ ask: req.query.ask !== '0' })) }); } catch (err) { fail(req, res, err, 'GET /settings/scan'); }
});

router.put('/scan', async (req, res) => {
  try {
    scan.setConfig(req.body || {});
    res.json({ ok: true, ...(await scan.view()) });
  } catch (err) { fail(req, res, err, 'PUT /settings/scan'); }
});

router.post('/scan/test', async (req, res) => {
  try { res.json({ ok: true, result: await scan.testConnection(req.body || {}) }); } catch (err) { fail(req, res, err, 'POST /settings/scan/test'); }
});

router.post('/scan/eicar', async (req, res) => {
  try { res.json({ ok: true, result: await scan.eicarTest() }); } catch (err) { fail(req, res, err, 'POST /settings/scan/eicar'); }
});

router.post('/scan/refresh', async (req, res) => {
  try { res.json({ ok: true, result: await scan.refreshSignatures() }); } catch (err) { fail(req, res, err, 'POST /settings/scan/refresh'); }
});

router.post('/scan/recheck-all', async (req, res) => {
  try {
    const list = scan.quarantine();
    for (const f of list) await scan.recheck(f.id).catch(() => null);
    res.json({ ok: true, checked: list.length, quarantine: scan.quarantine() });
  } catch (err) { fail(req, res, err, 'POST /settings/scan/recheck-all'); }
});

router.get('/scan/history', (req, res) => {
  try { res.json({ ok: true, history: scan.history() }); } catch (err) { fail(req, res, err, 'GET /settings/scan/history'); }
});

router.post('/scan/findings/:id/recheck', async (req, res) => {
  try { res.json({ ok: true, finding: await scan.recheck(fid(req)) }); } catch (err) { fail(req, res, err, 'POST /settings/scan/findings recheck'); }
});

router.post('/scan/findings/:id/release', (req, res) => {
  try { res.json({ ok: true, finding: scan.release(fid(req), uid(req)) }); } catch (err) { fail(req, res, err, 'POST /settings/scan/findings release'); }
});

router.delete('/scan/findings/:id', (req, res) => {
  try { res.json({ ok: true, finding: scan.deleteFinding(fid(req), uid(req)) }); } catch (err) { fail(req, res, err, 'DELETE /settings/scan/findings'); }
});

module.exports = router;
