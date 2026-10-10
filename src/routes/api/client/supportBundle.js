'use strict';

/**
 * POST /api/v1/client/support-bundle
 *
 * A client uploads a redacted diagnostics bundle (docs/feature-support-bundle.md).
 * Token auth only, the token must be bound to the peer (?peerId= / X-Peer-Id),
 * machine binding applies. Body:
 *   - Content-Type: application/gzip (or application/octet-stream) — gzip of
 *     the bundle JSON, up to supportBundles.maxUploadBytes (default 5 MB)
 *   - Content-Type: application/json — plain JSON (global 1 MB parser limit)
 * Limits: supportBundles.perHour uploads per peer and hour (default 3), plus
 * an attempt limiter per token (failed uploads count too).
 *
 * 201 { ok, bundle: { id, created_at, size_bytes } }
 * 400 invalid_* / unsupported_schema · 403 not bound · 413 too_large · 429 rate_limited
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = rateLimit;
const config = require('../../../../config/default');
const peers = require('../../../services/peers');
const activity = require('../../../services/activity');
const supportBundles = require('../../../services/supportBundles');
const logger = require('../../../utils/logger');
const { requirePeerOwnership, verifyMachineBinding } = require('./helpers');

const router = express.Router();

const GZIP_TYPES = ['application/gzip', 'application/x-gzip', 'application/octet-stream'];

// Attempts (incl. failed ones) per token and hour — the per-peer upload
// limit below only counts stored bundles.
const attemptLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: () => Math.max(1, config.supportBundles.perHour) * 4,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `support:${req.tokenId || ipKeyGenerator(req.ip)}`,
  handler: (req, res) => res.status(429).json({ ok: false, error: 'rate_limited' }),
});

function tokenOnly(req, res, next) {
  // The admin UI never uploads bundles; a session must not create them.
  if (!req.tokenAuth) return res.status(403).json({ ok: false, error: 'token_required' });
  return next();
}

const rawBody = express.raw({ type: GZIP_TYPES, limit: config.supportBundles.maxUploadBytes });

function bodyErrors(err, req, res, next) {
  if (err && (err.type === 'entity.too.large' || err.status === 413)) {
    return res.status(413).json({ ok: false, error: 'too_large' });
  }
  if (err) return res.status(400).json({ ok: false, error: 'invalid_body' });
  return next();
}

router.post('/support-bundle', tokenOnly, attemptLimiter, rawBody, bodyErrors, (req, res) => {
  try {
    const peerId = requirePeerOwnership(req, res);
    if (peerId == null) return;
    if (!verifyMachineBinding(req, res)) return;

    const peer = peers.getById(peerId);
    if (!peer) return res.status(404).json({ ok: false, error: 'peer_not_found' });

    if (supportBundles.isRateLimited(peerId)) {
      res.set('Retry-After', '3600');
      return res.status(429).json({ ok: false, error: 'rate_limited' });
    }

    const body = req.body;
    const hasBody = Buffer.isBuffer(body)
      ? body.byteLength > 0
      : (body !== null && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).length > 0);
    if (!hasBody && !Array.isArray(body)) return res.status(400).json({ ok: false, error: 'empty_body' });

    const bundle = supportBundles.parseBundle(body);
    const saved = supportBundles.store(peerId, bundle, {
      version: req.headers['x-client-version'],
      product: req.headers['x-client-type'],
      platform: req.headers['x-client-platform'],
    });

    activity.log('support_bundle_uploaded', `Support bundle received from "${peer.name}"`, {
      source: 'api',
      severity: 'info',
      ipAddress: req.ip,
      details: {
        peerId,
        bundleId: saved.id,
        sizeBytes: saved.size_bytes,
        clientVersion: saved.client_version,
        reason: saved.reason,
      },
    });

    return res.status(201).json({
      ok: true,
      bundle: { id: saved.id, created_at: saved.created_at, size_bytes: saved.size_bytes },
    });
  } catch (err) {
    if (err instanceof supportBundles.BundleError) {
      return res.status(err.status).json({ ok: false, error: err.code });
    }
    logger.error({ err: err.message }, 'Support bundle upload failed');
    return res.status(500).json({ ok: false, error: 'upload_failed' });
  }
});

module.exports = router;
