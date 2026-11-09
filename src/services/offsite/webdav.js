'use strict';

// WebDAV transport (Nextcloud/ownCloud, Synology/QNAP WebDAV, Apache mod_dav,
// nginx-dav, …): PROPFIND / MKCOL / PUT / GET / DELETE with Basic auth.
// docs/feature-release-b.md §7.
//
// Config: { url, username, password, via?, tls_ca? } — url is the target
// collection, e.g. https://cloud.example.com/remote.php/dav/files/alice/gatecontrol/
//
// Requests go through the storage targets' net.request (one checked, pinned
// address per request; TLS always verified). `via` (storageTargets/via.js,
// the same as a storage target's "Verbindung"): connect to a VPN peer or a
// route instead of the URL's host — the URL still gives the scheme, the
// path, the Host header and the name for SNI and the certificate check, so
// a NAS certificate for nas.example.com stays valid through the tunnel.
// `tls_ca`: the target's own trust anchor (PEM), as a storage target's tlsCa.

const crypto = require('node:crypto');
const net = require('../storageTargets/net');
const via = require('../storageTargets/via');

const TIMEOUT_MS = 120 * 1000;
const MAX_DOWNLOAD = 1024 * 1024 * 1024; // the restore test refuses more than 128 MB anyway

function collectionUrl(cfg) {
  const u = new URL(cfg.url);
  if (!u.pathname.endsWith('/')) u.pathname += '/';
  u.search = '';
  u.hash = '';
  return u;
}

function authHeader(cfg) {
  if (!cfg.username) return {};
  return { authorization: 'Basic ' + Buffer.from(`${cfg.username}:${cfg.password || ''}`, 'utf8').toString('base64') };
}

/** A failed connection → Error code TRANSPORT (+ hint 'self_address', see via.selfHint). */
async function transportError(cfg, method, url, err) {
  const e = new Error(`WebDAV ${method} failed: ${(err.cause && err.cause.message) || err.message}`);
  e.code = 'TRANSPORT';
  const hint = await via.selfHint(err, via.webdavViaOf(cfg), url.hostname);
  if (hint) { e.hint = hint; e.message += ` (${via.SELF_HINT_TEXT})`; }
  return e;
}

/**
 * One request → { status, headers, stream }. `timeoutMs`: no byte for that
 * long ends it (an idle timeout, so a large upload over a slow line is fine).
 */
async function send(cfg, method, url, { body = null, headers = {}, timeoutMs = 30000 } = {}) {
  try {
    const dialer = via.webdavDialer(via.webdavViaOf(cfg), url);
    return await net.request({
      // a string body as a Buffer: sent with Content-Length, not chunked (some NAS refuse chunked PROPFIND)
      method, url, body: typeof body === 'string' ? Buffer.from(body, 'utf8') : body, idleMs: timeoutMs,
      headers: { ...authHeader(cfg), ...headers },
      tlsCa: cfg.tls_ca || null,
      dial: dialer ? dialer() : null,
    });
  } catch (err) {
    throw await transportError(cfg, method, url, err);
  }
}

function statusError(method, res) {
  let hint = '';
  if (res.status === 401 || res.status === 403) hint = ' (check username/password and permissions)';
  else if (res.status >= 300 && res.status < 400) hint = ` (redirect to ${res.headers.location || '?'} — enter the final URL)`;
  const e = new Error(`WebDAV ${method} ${res.status}${hint}`);
  e.code = 'TRANSPORT';
  e.remoteStatus = res.status;
  return e;
}

async function dav(cfg, method, url, { body, headers = {}, timeoutMs = 30000, okStatuses } = {}) {
  const res = await send(cfg, method, url, { body, headers, timeoutMs });
  let text = '';
  try { text = (await net.readBody(res.stream)).toString('utf8'); } catch { /* answer cut off: the status decides */ }
  if (okStatuses ? !okStatuses.includes(res.status) : (res.status < 200 || res.status >= 300)) throw statusError(method, res);
  return { status: res.status, text };
}

const PROPFIND_BODY = '<?xml version="1.0" encoding="utf-8"?>'
  + '<d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getlastmodified/></d:prop></d:propfind>';

/** Parse a multistatus body → [{href, size, modified, collection}] (namespace prefix agnostic). */
function parseMultistatus(xml) {
  const out = [];
  const tag = (name) => `(?:[A-Za-z][\\w.-]*:)?${name}`;
  const resp = new RegExp(`<${tag('response')}\\b[^>]*>([\\s\\S]*?)</${tag('response')}>`, 'gi');
  for (const m of xml.matchAll(resp)) {
    const block = m[1];
    const pick = (name) => {
      const r = new RegExp(`<${tag(name)}\\b[^>]*>([\\s\\S]*?)</${tag(name)}>`, 'i').exec(block);
      return r ? r[1].trim() : null;
    };
    const href = pick('href');
    if (!href) continue;
    out.push({
      href: href.replace(/&amp;/g, '&'),
      size: Number(pick('getcontentlength')) || 0,
      modified: pick('getlastmodified'),
      collection: new RegExp(`<${tag('collection')}\\b`, 'i').test(block),
    });
  }
  return out;
}

async function ensureCollection(cfg) {
  const url = collectionUrl(cfg);
  const r = await dav(cfg, 'PROPFIND', url, {
    headers: { depth: '0', 'content-type': 'application/xml; charset=utf-8' },
    body: PROPFIND_BODY,
    okStatuses: [207, 200, 404],
  });
  if (r.status === 404) {
    await dav(cfg, 'MKCOL', url, { okStatuses: [201, 405] });
    return true;
  }
  return false;
}

async function upload(cfg, name, buf) {
  await ensureCollection(cfg);
  const url = new URL(encodeURIComponent(name), collectionUrl(cfg));
  await dav(cfg, 'PUT', url, {
    body: buf,
    headers: { 'content-type': 'application/octet-stream', 'content-length': String(buf.length) },
    timeoutMs: TIMEOUT_MS,
  });
}

async function list(cfg) {
  const base = collectionUrl(cfg);
  const r = await dav(cfg, 'PROPFIND', base, {
    headers: { depth: '1', 'content-type': 'application/xml; charset=utf-8' },
    body: PROPFIND_BODY,
    okStatuses: [207, 200],
  });
  const files = [];
  for (const e of parseMultistatus(r.text)) {
    if (e.collection) continue;
    let p;
    try { p = new URL(e.href, base).pathname; } catch { continue; }
    if (!p.startsWith(base.pathname) || p === base.pathname) continue;
    const rest = p.slice(base.pathname.length).replace(/\/$/, '');
    if (!rest || rest.includes('/')) continue;
    let name;
    try { name = decodeURIComponent(rest); } catch { continue; }
    const t = e.modified ? Date.parse(e.modified) : NaN;
    files.push({ name, size: e.size, modified: Number.isFinite(t) ? new Date(t).toISOString() : null });
  }
  return files;
}

/** Read one file back (restore test). Returns a Buffer; never writes anything. */
async function download(cfg, name) {
  const url = new URL(encodeURIComponent(name), collectionUrl(cfg));
  const res = await send(cfg, 'GET', url, { timeoutMs: TIMEOUT_MS });
  if (res.status < 200 || res.status >= 300) {
    await net.drain(res.stream);
    throw statusError('GET', res);
  }
  try { return await net.readBody(res.stream, MAX_DOWNLOAD); } catch (err) { throw await transportError(cfg, 'GET', url, err); }
}

async function remove(cfg, name) {
  const url = new URL(encodeURIComponent(name), collectionUrl(cfg));
  await dav(cfg, 'DELETE', url, { okStatuses: [200, 204, 404] });
}

async function test(cfg) {
  const created = await ensureCollection(cfg);
  const probe = `.gatecontrol-write-test-${crypto.randomBytes(4).toString('hex')}`;
  const url = new URL(probe, collectionUrl(cfg));
  await dav(cfg, 'PUT', url, { body: Buffer.from('ok'), headers: { 'content-type': 'text/plain' } });
  await dav(cfg, 'DELETE', url, { okStatuses: [200, 204, 404] });
  const files = await list(cfg);
  return `${created ? 'folder created, ' : ''}write + delete ok (${files.length} file(s) in the folder)`;
}

module.exports = { upload, download, list, remove, test, parseMultistatus, collectionUrl };
