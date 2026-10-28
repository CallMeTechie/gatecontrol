'use strict';

// Cloud accounts (docs/cloud-accounts.md): the only way GateControl talks to
// Google and Microsoft. Fixed hosts only, https on port 443, the system's
// certificate authorities:
//
//   www.googleapis.com, oauth2.googleapis.com, accounts.google.com,
//   graph.microsoft.com, login.microsoftonline.com
//
// One exception, needed by OneDrive itself: Graph answers a download with a
// redirect to a pre-authenticated address on its storage hosts and hands out
// upload sessions there. Such an address (`content: true`) may only be on
// *.sharepoint.com, *.1drv.com, *.onedrive.com or *.livefilestore.com, and
// never gets the access token (`authorization` is dropped).
//
// Under NODE_ENV=test nothing leaves the machine: without a stub
// (_setTransportForTest) every request fails with ERR_CLOUD_PROVIDER.

const https = require('node:https');
const { Readable } = require('node:stream');

const HOSTS = new Set(['www.googleapis.com', 'oauth2.googleapis.com', 'accounts.google.com', 'graph.microsoft.com', 'login.microsoftonline.com']);
const CONTENT_SUFFIXES = ['.sharepoint.com', '.1drv.com', '.onedrive.com', '.livefilestore.com'];
const HEADERS_MS = 30 * 1000;  // until the answer's headers arrive
const IDLE_MS = 60 * 1000;     // no byte for this long while a body flows → aborted
const JSON_MAX = 4 * 1024 * 1024;

class CloudError extends Error {
  constructor(code, message, extra) {
    super(message || code);
    this.code = code;
    if (extra) Object.assign(this, extra);
  }
}

let transport = null;

/** May a request go to `u` (URL)? content: a OneDrive storage address handed out by Graph. */
function allowed(u, content) {
  if (u.protocol !== 'https:' || (u.port && u.port !== '443') || u.username || u.password) return false;
  const h = u.hostname.toLowerCase();
  if (HOSTS.has(h)) return true;
  return !!content && CONTENT_SUFFIXES.some((s) => h.endsWith(s) && h.length > s.length);
}

/**
 * One HTTPS request.
 * opts: { method, url, headers, body (Buffer | string | Readable | null), content, headersMs, idleMs }
 * → { status, headers, stream } — the caller reads or drains `stream`.
 */
async function request(opts) {
  let u;
  try { u = new URL(String(opts.url)); } catch { throw new CloudError('ERR_CLOUD_PROVIDER', 'invalid address'); }
  if (!allowed(u, opts.content)) throw new CloudError('ERR_CLOUD_PROVIDER', `${u.hostname} is not a host cloud accounts may reach`);
  const headers = Object.assign({}, opts.headers || {});
  if (opts.content) { delete headers.authorization; delete headers.Authorization; }
  const method = opts.method || 'GET';
  if (transport) return viaStub(method, u, headers, opts.body);
  if (process.env.NODE_ENV === 'test') throw new CloudError('ERR_CLOUD_PROVIDER', 'no cloud provider is reached in tests');
  const body = opts.body;
  if (Buffer.isBuffer(body) || typeof body === 'string') headers['content-length'] = String(Buffer.byteLength(body));
  return new Promise((resolve, reject) => {
    const rq = https.request({ method, host: u.hostname, servername: u.hostname, port: 443, path: u.pathname + u.search, headers, agent: false }, (res) => {
      clearTimeout(timer);
      res.setTimeout(opts.idleMs || IDLE_MS, () => res.destroy(new CloudError('ERR_TIMEOUT', 'the transfer stalled')));
      resolve({ status: res.statusCode, headers: res.headers, stream: res });
    });
    const timer = setTimeout(() => rq.destroy(new CloudError('ERR_TIMEOUT', 'no answer from the provider')), opts.headersMs || HEADERS_MS);
    rq.setTimeout(opts.idleMs || IDLE_MS, () => rq.destroy(new CloudError('ERR_TIMEOUT', 'the transfer stalled')));
    rq.on('error', (e) => { clearTimeout(timer); reject(e instanceof CloudError ? e : new CloudError('ERR_CLOUD_PROVIDER', `the provider cannot be reached (${(e && e.code) || 'net'})`)); });
    if (body == null) rq.end();
    else if (Buffer.isBuffer(body) || typeof body === 'string') rq.end(body);
    else {
      body.on('error', (e) => rq.destroy(e));
      body.pipe(rq);
    }
  });
}

/** Tests: the stub gets { method, url, headers, body: Buffer|null } and answers { status, headers, body: Buffer|string|object|Readable }. */
async function viaStub(method, u, headers, body) {
  let buf = null;
  if (Buffer.isBuffer(body)) buf = body;
  else if (typeof body === 'string') buf = Buffer.from(body);
  else if (body) { const parts = []; for await (const c of body) parts.push(Buffer.from(c)); buf = Buffer.concat(parts); }
  const r = await transport({ method, url: u.href, headers, body: buf });
  const out = r || { status: 599 };
  let stream;
  if (out.body instanceof Readable) stream = out.body;
  else if (out.body == null) stream = Readable.from([]);
  else if (Buffer.isBuffer(out.body) || typeof out.body === 'string') stream = Readable.from([Buffer.from(out.body)]);
  else stream = Readable.from([Buffer.from(JSON.stringify(out.body))]);
  const h = {};
  for (const [k, v] of Object.entries(out.headers || {})) h[k.toLowerCase()] = v;
  return { status: out.status || 200, headers: h, stream };
}

/** Read a whole (small) answer → Buffer, at most `max` bytes. */
async function readBody(stream, max = JSON_MAX) {
  const parts = [];
  let n = 0;
  for await (const c of stream) {
    n += c.length;
    if (n > max) { stream.destroy(); throw new CloudError('ERR_CLOUD_TOO_LARGE', 'the answer is too large'); }
    parts.push(c);
  }
  return Buffer.concat(parts);
}

/** The answer as JSON ({} when it is none). */
async function readJson(stream, max = JSON_MAX) {
  const buf = await readBody(stream, max);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); } catch { return {}; }
}

/** Drain and drop an answer. */
async function drain(stream) {
  try { for await (const c of stream) { void c; } } catch { /* closed */ }
}

module.exports = {
  HOSTS, CONTENT_SUFFIXES, CloudError, allowed, request, readBody, readJson, drain,
  _setTransportForTest: (fn) => { if (process.env.NODE_ENV === 'test') transport = fn || null; },
};
