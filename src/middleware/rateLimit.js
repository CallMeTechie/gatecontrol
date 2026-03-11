'use strict';

const rateLimit = require('express-rate-limit');
const config = require('../../config/default');

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: config.auth.rateLimitLogin,
  message: { error: 'Too many login attempts, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip,
});

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: config.auth.rateLimitApi,
  message: { error: 'Too many requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

module.exports = { loginLimiter, apiLimiter };
