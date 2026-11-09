'use strict';

// Request bodies the parsers (express.json, express.urlencoded — body-parser)
// turn away. body-parser marks them with `type`, `expose` and a 4xx status:
//
//   entity.parse.failed    400 invalid_json          not JSON (scanners send exploit payloads)
//   entity.too.large       413 payload_too_large
//   encoding.unsupported   415 unsupported_encoding
//   charset.unsupported    415 unsupported_charset
//   request.aborted        400 request_aborted       the client went away mid-body
//   request.size.invalid   400 invalid_body_size     fewer/more bytes than Content-Length
//   parameters.too.many    413 too_many_parameters
//
// The client's fault, not the server's: the answer has that status and the
// usual JSON error shape ({ ok: false, code, error }); a browser outside
// /api/ gets the error page with the status. The log gets a warning
// "malformed request body" (method, path, ip, type, status, length) — once
// per type and 5 minutes (utils/warnOnce.js), the repeats counted in the next
// line. The body is never logged: it is the sender's data, often an exploit.
//
// A body that is not JSON or comes in an encoding/charset no client of
// GateControl sends counts for the IP block like a 404 of an unknown path
// (services/ipBlock.js noteSuspiciousRequest: every ten from one address
// count once). Too large and aborted bodies do not count — a phone on a bad
// network or a large settings import is no scanner.

const logger = require('../utils/logger');
const warnOnce = require('../utils/warnOnce');

const KNOWN = {
  'entity.parse.failed': { code: 'invalid_json', error: 'Invalid JSON body', suspicious: true },
  'entity.too.large': { code: 'payload_too_large', error: 'Payload too large' },
  'encoding.unsupported': { code: 'unsupported_encoding', error: 'Unsupported content encoding', suspicious: true },
  'charset.unsupported': { code: 'unsupported_charset', error: 'Unsupported charset', suspicious: true },
  'request.aborted': { code: 'request_aborted', error: 'Request aborted' },
  'request.size.invalid': { code: 'invalid_body_size', error: 'Request size did not match content length' },
  'parameters.too.many': { code: 'too_many_parameters', error: 'Too many parameters' },
};
const FALLBACK = { code: 'bad_request', error: 'Bad request' };
const MSG = 'malformed request body';

/** Is `err` a body-parser rejection of the client's body (4xx, exposed)? */
function isBodyError(err) {
  if (!err || typeof err.type !== 'string' || err.expose !== true) return false;
  const status = Number(err.status || err.statusCode);
  return status >= 400 && status < 500;
}

/** The body's length as declared (Content-Length), else as body-parser counted it; never the body. */
function lengthOf(err, req) {
  const declared = Number.parseInt(req.headers['content-length'], 10);
  if (Number.isFinite(declared) && declared >= 0) return declared;
  return Number.isFinite(err.length) ? err.length : null;
}

/**
 * Error handler step (app.js): answers a body-parser rejection and logs it.
 * → true when `err` was one (the response is sent), false otherwise.
 */
function handle(err, req, res, theme) {
  if (!isBodyError(err)) return false;
  const status = Number(err.status || err.statusCode);
  const known = KNOWN[err.type] || FALLBACK;
  warnOnce.throttled(`body-error:${err.type}`, {
    method: req.method,
    path: String(req.path || '').slice(0, 200),
    ip: req.ip || null,
    type: err.type,
    status,
    length: lengthOf(err, req),
  }, MSG);
  if (known.suspicious) {
    try { require('../services/ipBlock').noteSuspiciousRequest(req.ip); } catch { /* best-effort */ }
  }
  if (res.headersSent) return true;
  const api = String(req.path || '').startsWith('/api/');
  if (!api && theme && req.accepts(['json', 'html']) === 'html') {
    res.status(status).render(`${theme}/pages/error.njk`, { title: 'Error', message: known.error }, (renderErr, html) => {
      if (renderErr) return res.status(status).json({ ok: false, code: known.code, error: known.error });
      res.send(html);
    });
    return true;
  }
  res.status(status).json({ ok: false, code: known.code, error: known.error });
  return true;
}

module.exports = { handle, isBodyError, KNOWN, MSG };
