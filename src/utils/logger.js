'use strict';

const pino = require('pino');
const config = require('../../config/default');

// Header values that carry a secret never reach a log line, wherever an
// object with headers is logged (AI provider keys: authorization,
// x-api-key, x-goog-api-key — docs/plugins.md "AI requests").
const SECRET_HEADERS = ['authorization', 'proxy-authorization', 'x-api-key', 'x-goog-api-key', 'cookie', 'set-cookie'];
const REDACT_PATHS = [];
for (const h of SECRET_HEADERS) {
  const k = /^[a-z]+$/.test(h) ? `.${h}` : `["${h}"]`;
  REDACT_PATHS.push(`headers${k}`, `*.headers${k}`, `req.headers${k}`, `res.headers${k}`);
}
REDACT_PATHS.push('apiKey', '*.apiKey', 'key_encrypted', '*.key_encrypted');

const logger = pino({
  level: config.app.logLevel,
  redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
  transport: process.env.NODE_ENV !== 'production'
    ? { target: 'pino-pretty', options: { colorize: true } }
    : undefined,
});

module.exports = logger;
module.exports.REDACT_PATHS = REDACT_PATHS;
