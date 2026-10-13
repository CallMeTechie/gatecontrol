'use strict';

/**
 * Speed test of the apps' diagnosis screen ("Diagnose-Assistent",
 * docs/feature-client-diagnosis.md) — download and upload against the
 * user's own GateControl server, through the tunnel when it is up.
 *
 *   GET  /api/v1/client/speedtest
 *        → 200 { ok: true, maxDownloadBytes, maxUploadBytes, viaTunnel }
 *   GET  /api/v1/client/speedtest/download?bytes=N
 *        → 200 application/octet-stream, exactly N bytes (N clamped to
 *          [64 KiB, maxDownloadBytes], default 10 MiB) of incompressible
 *          data; Content-Length set, Cache-Control: no-store, no-transform,
 *          Content-Encoding: identity (nothing in between may compress it)
 *   POST /api/v1/client/speedtest/upload   (Content-Type: application/octet-stream)
 *        → 200 { ok: true, bytes, serverMs } — the body is counted and
 *          discarded while it streams in, never buffered
 *        → 413 { ok: false, error: 'too_large' } above maxUploadBytes
 *        → 415 { ok: false, error: 'unsupported_media_type' } for another type
 *
 *   403 token_required (browser session) · scope_required (no `client` /
 *       `full-access`) · machine binding mismatch (helpers.verifyMachineBinding)
 *   429 { ok: false, error: 'rate_limited' } + Retry-After — speedtestLimiter,
 *       GC_SPEEDTEST_RATE_LIMIT (30) requests per token and 10 minutes, in
 *       front of every handler
 *
 * Limits: GC_SPEEDTEST_MAX_DOWNLOAD_BYTES / GC_SPEEDTEST_MAX_UPLOAD_BYTES
 * (25 MiB each). No activity log entry per run (a debug line only).
 */

const crypto = require('node:crypto');
const { Router } = require('express');
const config = require('../../../../config/default');
const homeNetwork = require('../../../services/homeNetwork');
const { speedtestLimiter } = require('../../../middleware/rateLimit');
const { verifyMachineBinding } = require('./helpers');
const logger = require('../../../utils/logger');

const router = Router();

const MIN_BYTES = 64 * 1024;
const DEFAULT_BYTES = 10 * 1024 * 1024;
const CHUNK_BYTES = 1024 * 1024;

// One random block, written again and again: random bytes do not compress,
// and 1 MiB is larger than the window of gzip/deflate.
let _chunk = null;
function chunk() {
  if (!_chunk) _chunk = crypto.randomBytes(CHUNK_BYTES);
  return _chunk;
}

function limits() {
  const c = config.speedtest || {};
  const pick = (v) => (Number.isSafeInteger(v) ? Math.max(MIN_BYTES, v) : 25 * 1024 * 1024);
  return { maxDownloadBytes: pick(c.maxDownloadBytes), maxUploadBytes: pick(c.maxUploadBytes) };
}

/** ?bytes= → the size actually sent: [64 KiB, max], default 10 MiB (or max when smaller). */
function downloadSize(raw, max) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!/^\d{1,15}$/.test(s)) return Math.min(DEFAULT_BYTES, max);
  return Math.min(max, Math.max(MIN_BYTES, Number(s)));
}

/** Token (not a session), scope `client`/`full-access`, machine binding. false = answered. */
function guard(req, res) {
  res.set('Cache-Control', 'no-store, no-transform');
  if (!req.tokenAuth) { res.status(403).json({ ok: false, error: 'token_required' }); return false; }
  const scopes = req.tokenScopes || [];
  if (!scopes.includes('client') && !scopes.includes('full-access')) {
    res.status(403).json({ ok: false, error: 'scope_required' });
    return false;
  }
  return verifyMachineBinding(req, res);
}

router.get('/speedtest', speedtestLimiter, (req, res) => {
  if (!guard(req, res)) return undefined;
  const l = limits();
  return res.json({
    ok: true,
    maxDownloadBytes: l.maxDownloadBytes,
    maxUploadBytes: l.maxUploadBytes,
    viaTunnel: homeNetwork.viaOf(req.ip) === 'tunnel',
  });
});

router.get('/speedtest/download', speedtestLimiter, (req, res) => {
  if (!guard(req, res)) return;
  const total = downloadSize(req.query.bytes, limits().maxDownloadBytes);
  const block = chunk();
  const started = Date.now();
  res.status(200);
  res.set({
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(total),
    'Content-Encoding': 'identity',
  });
  if (req.method === 'HEAD') return void res.end();
  let left = total;
  const pump = () => {
    while (left > 0) {
      if (res.destroyed) return;
      const n = Math.min(left, block.length);
      left -= n;
      if (!res.write(n === block.length ? block : block.subarray(0, n))) {
        res.once('drain', pump);
        return;
      }
    }
    res.end();
    logger.debug({ tokenId: req.tokenId, bytes: total, ms: Date.now() - started }, 'speed test download sent');
  };
  res.on('close', () => { left = 0; });
  pump();
});

router.post('/speedtest/upload', speedtestLimiter, (req, res) => {
  if (!guard(req, res)) return;
  const max = limits().maxUploadBytes;
  const type = req.headers['content-type'];
  if (type && !req.is('application/octet-stream')) {
    return void res.status(415).json({ ok: false, error: 'unsupported_media_type' });
  }
  const tooLarge = () => {
    res.set('Connection', 'close');
    res.status(413).json({ ok: false, error: 'too_large' });
  };
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > max) return void tooLarge();

  const started = process.hrtime.bigint();
  let bytes = 0;
  let done = false;
  req.on('data', (buf) => {
    if (done) return;
    bytes += buf.length;
    if (bytes > max) {
      done = true;
      tooLarge();
    }
  });
  req.on('end', () => {
    if (done) return;
    done = true;
    const serverMs = Math.max(0, Math.round(Number(process.hrtime.bigint() - started) / 1e6));
    logger.debug({ tokenId: req.tokenId, bytes, ms: serverMs }, 'speed test upload received');
    res.json({ ok: true, bytes, serverMs });
  });
  req.on('error', (err) => {
    done = true;
    logger.debug({ tokenId: req.tokenId, err: err.message }, 'speed test upload aborted');
  });
});

module.exports = router;
module.exports.downloadSize = downloadSize;
module.exports.MIN_BYTES = MIN_BYTES;
module.exports.DEFAULT_BYTES = DEFAULT_BYTES;
