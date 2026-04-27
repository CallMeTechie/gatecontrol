'use strict';

const rateLimit = require('express-rate-limit');
const config = require('../../config/default');

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: config.auth.rateLimitLogin,
  standardHeaders: true,
  legacyHeaders: true,
  keyGenerator: (req) => req.ip,
  handler: (req, res) => {
    res.status(429).json({ error: req.t('error.rate_limit.login') });
  },
});

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: (req) => (req.session && req.session.userId)
    ? config.auth.rateLimitApi * 10
    : config.auth.rateLimitApi,
  standardHeaders: true,
  legacyHeaders: true,
  keyGenerator: (req) => req.tokenAuth ? `token:${req.tokenId}` : req.ip,
  handler: (req, res) => {
    res.status(429).json({ ok: false, error: req.t('error.rate_limit.api') });
  },
});

const routeAuthLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: true,
  keyGenerator: (req) => req.ip,
  handler: (req, res) => {
    res.status(429).json({ ok: false, error: req.t('error.rate_limit.route_auth_login') || 'Too many login attempts. Try again later.' });
  },
});

const routeAuthCodeLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: true,
  keyGenerator: (req) => req.ip,
  handler: (req, res) => {
    res.status(429).json({ ok: false, error: req.t('error.rate_limit.route_auth_code') || 'Too many code requests. Try again later.' });
  },
});

const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: true,
  keyGenerator: (req) => req.tokenAuth ? `upload:${req.tokenId}` : `upload:${req.ip}`,
  handler: (req, res) => {
    res.status(429).json({ ok: false, error: 'Too many uploads. Try again later.' });
  },
});

// Peer hostname reporter: a compromised agent token must not be able to
// flood the hosts-file rebuild. 3 reports per minute per token is ample
// for legitimate boot/reconnect flows.
const hostnameReportLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: true,
  keyGenerator: (req) => req.tokenAuth ? `hostname:${req.tokenId}` : `hostname:${req.ip}`,
  handler: (req, res) => {
    res.status(429).json({ ok: false, error: req.t ? req.t('error.rate_limit.hostname') : 'Too many hostname reports.' });
  },
});

// Public gateway-pairing redemption: 64-bit codes with 10-min TTL plus
// one-shot semantics already make brute-force impractical, but a tight
// per-IP limit (10 per 5 min) keeps log noise down and discourages
// scanning. Endpoint is unauthenticated by design.
const gatewayPairLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: true,
  keyGenerator: (req) => `pair:${req.ip}`,
  handler: (req, res) => {
    res.status(429).json({ ok: false, error: 'Too many pairing attempts. Try again later.' });
  },
});

module.exports = { loginLimiter, apiLimiter, routeAuthLoginLimiter, routeAuthCodeLimiter, uploadLimiter, hostnameReportLimiter, gatewayPairLimiter };
