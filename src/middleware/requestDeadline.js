'use strict';

// How long a request body may take to arrive (since 1.193.0).
//
// Node's server-wide requestTimeout (5 min by default) ends every request
// whose body has not arrived by then — a 2 GB media upload (docs/plugins.md
// "Media", media.maxBytes up to 2 GB) from a phone easily takes longer.
// server.js therefore raises requestTimeout to UPLOAD_DEADLINE_MS, and this
// middleware gives every other request the old 5 minutes back: a body still
// arriving after BODY_DEADLINE_MS ends the connection, exactly what Node did
// before. Media uploads (PUT …/plugins/<id>/media on the admin, portal and
// client API) get UPLOAD_DEADLINE_MS in all and are ended when no byte
// arrives for UPLOAD_IDLE_MS (a stalled phone does not hold a socket).
// headersTimeout (60 s) is unchanged for everything.

const BODY_DEADLINE_MS = 5 * 60 * 1000;
const UPLOAD_DEADLINE_MS = 2 * 3600 * 1000;
const UPLOAD_IDLE_MS = 5 * 60 * 1000;
const UPLOAD_PATH_RE = /^\/api\/v1\/(?:client\/|portal\/)?plugins\/[^/]+\/media$/;
// files into an upload link (routes/publicLinks.js, since 1.205.0)
const LINK_UPLOAD_RE = /^\/s\/[A-Za-z0-9_-]{22,64}\/u$/;

/** Is this request a media upload (the route with the long deadline)? */
function isMediaUpload(req) {
  return req.method === 'PUT' && (UPLOAD_PATH_RE.test(req.path) || LINK_UPLOAD_RE.test(req.path));
}

function requestDeadline(req, res, next) {
  if (req.complete || req.method === 'GET' || req.method === 'HEAD') return next();
  const upload = isMediaUpload(req);
  if (upload) req.setTimeout(UPLOAD_IDLE_MS, () => req.destroy());
  const timer = setTimeout(() => { if (!req.complete) req.destroy(); }, upload ? UPLOAD_DEADLINE_MS : module.exports._bodyDeadlineMs || BODY_DEADLINE_MS);
  if (timer.unref) timer.unref();
  const clear = () => {
    clearTimeout(timer);
    // the connection may serve further requests (keep-alive): no idle limit of the upload left on it
    if (upload && req.socket && !req.socket.destroyed) req.socket.setTimeout(0);
  };
  req.once('end', clear);
  req.once('close', clear);
  res.once('finish', clear);
  res.once('close', clear);
  return next();
}

module.exports = { requestDeadline, isMediaUpload, BODY_DEADLINE_MS, UPLOAD_DEADLINE_MS, UPLOAD_IDLE_MS, _bodyDeadlineMs: null };
