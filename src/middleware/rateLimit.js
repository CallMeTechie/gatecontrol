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

module.exports = { loginLimiter, apiLimiter, routeAuthLoginLimiter, routeAuthCodeLimiter };
