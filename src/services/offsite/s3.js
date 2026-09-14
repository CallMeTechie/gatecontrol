'use strict';

// S3 transport (AWS S3 and S3-compatible: MinIO, Wasabi, Backblaze B2, Hetzner
// Object Storage, …) — AWS Signature Version 4 with node:crypto + fetch, no SDK.
// docs/feature-release-b.md §7.
//
// Config: { endpoint, region, bucket, prefix, access_key_id,
//           secret_access_key, path_style }
//   endpoint    https://s3.eu-central-1.amazonaws.com, https://minio.lan:9000 …
//               empty → https://s3.<region>.amazonaws.com
//   path_style  true  → <endpoint>/<bucket>/<key>
//               false → <bucket>.<endpoint host>/<key> (virtual host)
// Payloads are signed with their real SHA-256 (no UNSIGNED-PAYLOAD), which
// every S3 implementation accepts.

const crypto = require('node:crypto');

const SERVICE = 's3';
const TIMEOUT_MS = 120 * 1000;

function sha256hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}
function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
}

/** RFC 3986 encoding as SigV4 wants it (unreserved kept; '/' optional). */
function uriEncode(str, keepSlash) {
  let out = '';
  for (const ch of Buffer.from(String(str), 'utf8')) {
    const c = String.fromCharCode(ch);
    if (/[A-Za-z0-9\-._~]/.test(c) || (keepSlash && c === '/')) out += c;
    else out += '%' + ch.toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}

function amzDate(d) {
  return d.toISOString().replace(/[:-]|\.\d{3}/g, ''); // 20130524T000000Z
}

/**
 * Sign a request (header-based SigV4).
 *
 * @param {object} o
 * @param {string} o.method
 * @param {URL}    o.url          path must already be URI-encoded (as sent)
 * @param {object} [o.headers]    extra headers to sign (lower-cased here)
 * @param {string} o.payloadHash  hex SHA-256 of the body
 * @param {string} o.region
 * @param {string} o.accessKeyId
 * @param {string} o.secretAccessKey
 * @param {Date}   [o.date]
 * @param {string} [o.service]
 * @returns {object} headers to send (incl. authorization, x-amz-date, host)
 */
function signRequest({ method, url, headers = {}, payloadHash, region, accessKeyId, secretAccessKey, date = new Date(), service = SERVICE }) {
  const t = amzDate(date);
  const day = t.slice(0, 8);
  const h = {};
  for (const [k, v] of Object.entries(headers)) h[k.toLowerCase()] = String(v).trim().replace(/\s+/g, ' ');
  h.host = url.host;
  h['x-amz-date'] = t;
  if (service === 's3' && !h['x-amz-content-sha256']) h['x-amz-content-sha256'] = payloadHash;

  const signedNames = Object.keys(h).sort();
  const canonicalHeaders = signedNames.map((k) => `${k}:${h[k]}\n`).join('');
  const signedHeaders = signedNames.join(';');

  const raw = url.search ? url.search.slice(1).split('&').filter(Boolean) : [];
  const params = raw
    .map((kv) => {
      const i = kv.indexOf('=');
      const k = i === -1 ? kv : kv.slice(0, i);
      const v = i === -1 ? '' : kv.slice(i + 1);
      return [uriEncode(decodeURIComponent(k), false), uriEncode(decodeURIComponent(v), false)];
    })
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : (a[0] < b[0] ? -1 : 1)));
  const canonicalQuery = params.map(([k, v]) => `${k}=${v}`).join('&');

  const canonicalRequest = [method, url.pathname || '/', canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${day}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', t, scope, sha256hex(canonicalRequest)].join('\n');
  const kDate = hmac('AWS4' + secretAccessKey, day);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

  return {
    ...h,
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

function baseEndpoint(cfg) {
  const ep = (cfg.endpoint || '').trim() || `https://s3.${cfg.region || 'us-east-1'}.amazonaws.com`;
  return new URL(ep.replace(/\/+$/, ''));
}

function prefixOf(cfg) {
  const p = String(cfg.prefix || '').replace(/^\/+/, '');
  return p && !p.endsWith('/') ? p + '/' : p;
}

/** URL for an object key ('' = bucket root) plus optional query. */
function objectUrl(cfg, key, query) {
  const ep = baseEndpoint(cfg);
  const basePath = ep.pathname.replace(/\/+$/, '');
  const encKey = uriEncode(key, true);
  let u;
  if (cfg.path_style) {
    u = new URL(`${ep.protocol}//${ep.host}${basePath}/${uriEncode(cfg.bucket, false)}/${encKey}`);
  } else {
    u = new URL(`${ep.protocol}//${cfg.bucket}.${ep.host}${basePath}/${encKey}`);
  }
  // Query built by hand with the SigV4 encoding (URLSearchParams would send a
  // space as '+', which S3 does not read as a space) — sent == signed.
  if (query) u.search = Object.entries(query).map(([k, v]) => `${uriEncode(k, false)}=${uriEncode(v, false)}`).join('&');
  return u;
}

function xmlValue(xml, tag) {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
  return m ? decodeXml(m[1]) : null;
}
function decodeXml(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

async function request(cfg, method, key, { query, body, headers = {}, timeoutMs = TIMEOUT_MS } = {}) {
  const url = objectUrl(cfg, key, query);
  const payload = body || Buffer.alloc(0);
  const signed = signRequest({
    method, url, headers, payloadHash: sha256hex(payload),
    region: cfg.region || 'us-east-1', accessKeyId: cfg.access_key_id, secretAccessKey: cfg.secret_access_key,
  });
  delete signed.host; // fetch sets Host from the URL (identical value)
  let res;
  try {
    res = await fetch(url, {
      method, headers: signed, body: method === 'PUT' ? payload : undefined,
      redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const e = new Error(`S3 ${method} failed: ${(err.cause && err.cause.message) || err.message}`);
    e.code = 'TRANSPORT';
    throw e;
  }
  const text = await res.text();
  if (res.status >= 300) {
    const code = xmlValue(text, 'Code');
    const msg = xmlValue(text, 'Message');
    const e = new Error(`S3 ${method} ${res.status}${code ? ` ${code}` : ''}${msg ? `: ${msg}` : ''}`);
    e.code = 'TRANSPORT';
    e.remoteStatus = res.status;
    throw e;
  }
  return { status: res.status, text };
}

async function upload(cfg, name, buf) {
  await request(cfg, 'PUT', prefixOf(cfg) + name, {
    body: buf,
    headers: { 'content-type': 'application/octet-stream' },
  });
}

async function list(cfg) {
  const prefix = prefixOf(cfg);
  const files = [];
  let token = null;
  for (let page = 0; page < 50; page++) {
    const query = { 'list-type': '2', prefix };
    if (token) query['continuation-token'] = token;
    const { text } = await request(cfg, 'GET', '', { query, timeoutMs: 30000 });
    for (const m of text.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const key = xmlValue(m[1], 'Key');
      if (!key || !key.startsWith(prefix)) continue;
      const name = key.slice(prefix.length);
      if (!name || name.includes('/')) continue;
      files.push({ name, size: Number(xmlValue(m[1], 'Size')) || 0, modified: xmlValue(m[1], 'LastModified') });
    }
    if (xmlValue(text, 'IsTruncated') !== 'true') break;
    token = xmlValue(text, 'NextContinuationToken');
    if (!token) break;
  }
  return files;
}

async function remove(cfg, name) {
  await request(cfg, 'DELETE', prefixOf(cfg) + name, { timeoutMs: 30000 });
}

async function test(cfg) {
  const files = await list(cfg);
  const probe = `.gatecontrol-write-test-${crypto.randomBytes(4).toString('hex')}`;
  await request(cfg, 'PUT', prefixOf(cfg) + probe, { body: Buffer.from('ok'), timeoutMs: 30000 });
  await request(cfg, 'DELETE', prefixOf(cfg) + probe, { timeoutMs: 30000 });
  return `bucket reachable, write + delete ok (${files.length} file(s) under the prefix)`;
}

module.exports = { signRequest, uriEncode, objectUrl, upload, list, remove, test, _sha256hex: sha256hex };
