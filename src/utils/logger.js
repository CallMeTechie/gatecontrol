'use strict';

const pino = require('pino');
const config = require('../../config/default');
const serverLogFile = require('./serverLogFile');

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

const options = {
  level: config.app.logLevel,
  redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
};
const prettyTransport = process.env.NODE_ENV !== 'production'
  ? { target: 'pino-pretty', options: { colorize: true } }
  : undefined;

// Server log file (utils/serverLogFile.js): the same redacted JSON lines also
// go to <data>/logs/server.log for Logs & Monitoring › Server-Log. stdout
// stays as it was (pino-pretty resp. plain JSON); GC_SERVER_LOG=off — and
// NODE_ENV=test without the variable — leaves the logger exactly as before.
const fileOptions = serverLogFile.resolveOptions();
let fileStream = null;
let logger;
if (fileOptions.enabled) {
  fileStream = new serverLogFile.RotatingFileStream({
    ...fileOptions,
    // Once per failure streak; the file stream drops lines meanwhile, so this
    // warning only reaches stdout.
    onError: (err) => logger.warn({ err: err.message, code: err.code, file: fileOptions.file },
      'server log file not writable — logging to stdout only until it is'),
  });
  const stdout = prettyTransport ? pino.transport(prettyTransport) : pino.destination(process.stdout.fd || 1);
  // Both streams take every line the logger lets through (its level decides).
  logger = pino(options, pino.multistream([
    { level: 'trace', stream: stdout },
    { level: 'trace', stream: fileStream },
  ]));
  process.on('exit', () => fileStream.flushSync());
} else {
  logger = pino({ ...options, transport: prettyTransport });
}

module.exports = logger;
module.exports.REDACT_PATHS = REDACT_PATHS;
/** State of the server log file for the Server-Log tab. */
module.exports.serverLogFile = {
  enabled: !!fileStream,
  options: fileOptions,
  stream: fileStream,
};
