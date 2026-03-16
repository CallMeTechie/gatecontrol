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
  max: (req) => (req.session && req.session.userId) ? config.auth.rateLimitApi * 10 : config.auth.rateLimitApi,
  standardHeaders: true,
  legacyHeaders: true,
  handler: (req, res) => {
    res.status(429).json({ error: req.t('error.rate_limit.api') });
  },
});

module.exports = { loginLimiter, apiLimiter };
