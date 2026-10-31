'use strict';

// Storage target "S3-kompatibel" (kind 's3'): AWS S3, Hetzner Object
// Storage, Wasabi, Backblaze B2, MinIO, Synology C2 … Requests signed with
// AWS Signature V4; bodies are streamed with x-amz-content-sha256:
// UNSIGNED-PAYLOAD (the transport is TLS; MinIO and the providers accept
// it). Objects above PART_SIZE go up as a multipart upload (64 MiB parts,
// at most 10 000 parts — 640 GiB), aborted when a part fails. `copy` (since
// 1.215.0, gc.media.copy): CopyObject on the bucket, above 5 GiB a multipart
// upload of UploadPartCopy parts — no byte travels through GateControl.
//
// config: { endpoint: 'https://…', region, bucket, prefix, pathStyle, accessKeyId, tlsCa }
// secret: { accessKeyId, secretAccessKey }

const crypto = require('node:crypto');
const net = require('../net');
const { StorageError } = require('../errors');
const { slice } = require('../streams');

const PART_SIZE = 64 * 1024 * 1024;
const MAX_PARTS = 10000;
const UNSIGNED = 'UNSIGNED-PAYLOAD';
const COPY_MAX = 5 * 1024 * 1024 * 1024;    // the largest object one CopyObject copies
const COPY_PART_SIZE = 512 * 1024 * 1024;  // UploadPartCopy parts above that
// the live tests lower both (a 5 GiB object is too big for a test)
const copyLimits = { max: COPY_MAX, part: COPY_PART_SIZE };

function hmac(key, s) { return crypto.createHmac('sha256', key).update(s, 'utf8').digest(); }
function sha256hex(s) { return crypto.createHash('sha256').update(s, 'utf8').digest('hex'); }

/** RFC 3986 encoding as SigV4 wants it (every byte but A-Z a-z 0-9 - _ . ~). */
function uriEncode(s, keepSlash) {
  return Array.from(Buffer.from(String(s), 'utf8')).map((b) => {
    const c = String.fromCharCode(b);
    if (/[A-Za-z0-9\-_.~]/.test(c) || (keepSlash && c === '/')) return c;
    return '%' + b.toString(16).toUpperCase().padStart(2, '0');
  }).join('');
}

function amzDate(d) { return d.toISOString().replace(/[:-]|\.\d{3}/g, ''); }

/**
 * Sign one request (SigV4, header auth). `query` an object of strings,
 * `headers` lower-case names. Returns the headers to send.
 */
function sign({ method, host, path, query, headers, accessKeyId, secretAccessKey, region, now = new Date() }) {
  const date = amzDate(now);
  const day = date.slice(0, 8);
  const h = Object.assign({}, headers, { host, 'x-amz-date': date });
  if (!h['x-amz-content-sha256']) h['x-amz-content-sha256'] = UNSIGNED;
  const names = Object.keys(h).map((k) => k.toLowerCase()).sort();
  const lower = {};
  for (const [k, v] of Object.entries(h)) lower[k.toLowerCase()] = String(v).trim().replace(/\s+/g, ' ');
  const canonQuery = Object.keys(query || {}).sort().map((k) => `${uriEncode(k)}=${uriEncode(query[k])}`).join('&');
  const canon = [method, uriEncode(path, true), canonQuery, names.map((n) => `${n}:${lower[n]}\n`).join(''), names.join(';'), lower['x-amz-content-sha256']].join('\n');
  const scope = `${day}/${region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', date, scope, sha256hex(canon)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac('AWS4' + secretAccessKey, day), region), 's3'), 'aws4_request');
  const sig = crypto.createHmac('sha256', kSigning).update(toSign, 'utf8').digest('hex');
  const out = Object.assign({}, lower);
  delete out.host;
  out.authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${sig}`;
  return out;
}

/** <Tag>value</Tag> of a small XML answer (S3 answers are flat enough). */
function xmlValue(xml, tag) {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
  return m ? m[1].replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&') : null;
}

function xmlEscape(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

/** An error answer → StorageError. */
async function failure(res, what) {
  let body = '';
  try { body = (await net.readBody(res.stream, 64 * 1024)).toString('utf8'); } catch { /* none */ }
  const code = xmlValue(body, 'Code') || '';
  const msg = `${what}: HTTP ${res.status}${code ? ' ' + code : ''}`;
  if (res.status === 404 || code === 'NoSuchKey' || code === 'NoSuchBucket') return new StorageError('not_found', msg);
  if (res.status === 401 || /InvalidAccessKeyId|SignatureDoesNotMatch|AuthorizationHeaderMalformed/.test(code)) return new StorageError('auth', msg);
  if (res.status === 403) return new StorageError(code === 'AccessDenied' ? 'denied' : 'auth', msg);
  if (/EntityTooLarge|QuotaExceeded|XMinioStorageFull/.test(code) || res.status === 507) return new StorageError('full', msg);
  return new StorageError('failed', msg);
}

function create(cfg, secret) {
  const endpoint = new URL(cfg.endpoint);
  const region = cfg.region || 'us-east-1';
  const prefix = cfg.prefix ? cfg.prefix.replace(/^\/+|\/+$/g, '') + '/' : '';
  const tlsCa = cfg.tlsCa || null;
  const basePath = endpoint.pathname.replace(/\/+$/, '');

  /** URL host and path of an object (`key` null: the bucket itself). */
  function where(key) {
    const obj = key == null ? '' : prefix + key;
    if (cfg.pathStyle !== false) return { host: endpoint.host, path: `${basePath}/${cfg.bucket}${key == null ? '/' : '/' + obj}` };
    return { host: `${cfg.bucket}.${endpoint.host}`, path: `${basePath}/${obj}` };
  }

  async function call(method, key, { query = {}, headers = {}, body = null, idleMs } = {}) {
    const w = where(key);
    const signed = sign({ method, host: w.host, path: w.path, query, headers, accessKeyId: secret.accessKeyId, secretAccessKey: secret.secretAccessKey, region });
    const qs = Object.keys(query).sort().map((k) => `${uriEncode(k)}=${uriEncode(query[k])}`).join('&');
    const url = new URL(`${endpoint.protocol}//${w.host}${uriEncode(w.path, true)}${qs ? '?' + qs : ''}`);
    try {
      return await net.request({ method, url, headers: signed, body, tlsCa, idleMs });
    } catch (e) { throw StorageError.from(e); }
  }

  async function putSingle(key, source) {
    const res = await call('PUT', key, { headers: { 'content-length': String(source.length), 'content-type': 'application/octet-stream' }, body: source.open(0, source.length - 1) });
    if (res.status !== 200) throw await failure(res, 'upload');
    await net.drain(res.stream);
  }

  async function putMultipart(key, source) {
    const partSize = Math.max(PART_SIZE, Math.ceil(source.length / MAX_PARTS));
    const init = await call('POST', key, { query: { uploads: '' }, headers: { 'content-type': 'application/octet-stream' } });
    if (init.status !== 200) throw await failure(init, 'upload start');
    const uploadId = xmlValue((await net.readBody(init.stream)).toString('utf8'), 'UploadId');
    if (!uploadId) throw new StorageError('protocol', 'no UploadId in the answer');
    const parts = [];
    try {
      for (let n = 1, start = 0; start < source.length; n++, start += partSize) {
        const end = Math.min(source.length, start + partSize) - 1;
        const res = await call('PUT', key, { query: { partNumber: String(n), uploadId }, headers: { 'content-length': String(end - start + 1) }, body: source.open(start, end) });
        if (res.status !== 200) throw await failure(res, `upload part ${n}`);
        await net.drain(res.stream);
        const etag = res.headers.etag;
        if (!etag) throw new StorageError('protocol', 'no ETag for a part');
        parts.push({ n, etag });
      }
      const xml = `<CompleteMultipartUpload>${parts.map((p) => `<Part><PartNumber>${p.n}</PartNumber><ETag>${xmlEscape(p.etag)}</ETag></Part>`).join('')}</CompleteMultipartUpload>`;
      const done = await call('POST', key, { query: { uploadId }, headers: { 'content-type': 'application/xml' }, body: Buffer.from(xml), idleMs: 10 * 60 * 1000 });
      const text = done.status === 200 ? (await net.readBody(done.stream)).toString('utf8') : null;
      // S3 may answer 200 with an <Error> body when completing fails late
      if (done.status !== 200) throw await failure(done, 'upload complete');
      if (/<Error>/.test(text)) throw new StorageError('failed', 'upload complete: ' + (xmlValue(text, 'Code') || 'error'));
    } catch (e) {
      try { const ab = await call('DELETE', key, { query: { uploadId } }); await net.drain(ab.stream); } catch { /* best effort */ }
      throw StorageError.from(e);
    }
  }

  async function put(key, source) {
    if (source.length <= PART_SIZE) return putSingle(key, source);
    return putMultipart(key, source);
  }

  /** x-amz-copy-source of an object of this bucket ("/<bucket>/<prefix><key>", URL-encoded). */
  function copySource(key) { return '/' + uriEncode(`${cfg.bucket}/${prefix}${key}`, true); }

  /** The body of a copy answer — S3 may answer 200 with an <Error> body when a copy fails late. */
  async function copyAnswer(res, what) {
    if (res.status !== 200) throw await failure(res, what);
    const text = (await net.readBody(res.stream)).toString('utf8');
    if (/<Error>/.test(text)) {
      const code = xmlValue(text, 'Code') || 'error';
      throw new StorageError(code === 'NoSuchKey' ? 'not_found' : 'failed', `${what}: ${code}`);
    }
    return text;
  }

  /**
   * Copy an object on the bucket. S3 cannot refuse an existing destination
   * atomically: the media store copies only to fresh keys (its own ids).
   */
  async function copy(from, to) {
    const h = await head(from);
    if (!h) throw new StorageError('not_found', 'no such object');
    const src = copySource(from);
    if (h.size <= copyLimits.max) {
      const res = await call('PUT', to, { headers: { 'content-length': '0', 'x-amz-copy-source': src }, idleMs: 10 * 60 * 1000 });
      await copyAnswer(res, 'copy');
      return;
    }
    const partSize = Math.max(copyLimits.part, Math.ceil(h.size / MAX_PARTS));
    const init = await call('POST', to, { query: { uploads: '' }, headers: { 'content-type': 'application/octet-stream' } });
    if (init.status !== 200) throw await failure(init, 'copy start');
    const uploadId = xmlValue((await net.readBody(init.stream)).toString('utf8'), 'UploadId');
    if (!uploadId) throw new StorageError('protocol', 'no UploadId in the answer');
    const parts = [];
    try {
      for (let n = 1, start = 0; start < h.size; n++, start += partSize) {
        const end = Math.min(h.size, start + partSize) - 1;
        const res = await call('PUT', to, { query: { partNumber: String(n), uploadId },
          headers: { 'content-length': '0', 'x-amz-copy-source': src, 'x-amz-copy-source-range': `bytes=${start}-${end}` }, idleMs: 10 * 60 * 1000 });
        const etag = xmlValue(await copyAnswer(res, `copy part ${n}`), 'ETag');
        if (!etag) throw new StorageError('protocol', 'no ETag for a part');
        parts.push({ n, etag });
      }
      const xml = `<CompleteMultipartUpload>${parts.map((p) => `<Part><PartNumber>${p.n}</PartNumber><ETag>${xmlEscape(p.etag)}</ETag></Part>`).join('')}</CompleteMultipartUpload>`;
      const done = await call('POST', to, { query: { uploadId }, headers: { 'content-type': 'application/xml' }, body: Buffer.from(xml), idleMs: 10 * 60 * 1000 });
      await copyAnswer(done, 'copy complete');
    } catch (e) {
      try { const ab = await call('DELETE', to, { query: { uploadId } }); await net.drain(ab.stream); } catch { /* best effort */ }
      throw StorageError.from(e);
    }
  }

  async function get(key, range) {
    const res = await call('GET', key, { headers: range ? { range: `bytes=${range.start}-${range.end}` } : {} });
    if (res.status !== 200 && res.status !== 206) throw await failure(res, 'download');
    return range && res.status === 200 ? slice(res.stream, range.start, range.end) : res.stream;
  }

  async function head(key) {
    const res = await call('HEAD', key);
    await net.drain(res.stream);
    if (res.status === 404) return null;
    if (res.status !== 200) throw await failure(res, 'head');
    return { size: Number(res.headers['content-length']), mtime: Date.parse(res.headers['last-modified']) || null };
  }

  /** S3 answers 204 whether the key existed or not: true unless it said 404. */
  async function remove(key) {
    const res = await call('DELETE', key);
    if (res.status !== 204 && res.status !== 200 && res.status !== 404) throw await failure(res, 'delete');
    await net.drain(res.stream);
    return res.status !== 404;
  }

  async function prepare() {
    const res = await call('HEAD', null);
    await net.drain(res.stream);
    if (res.status === 404) throw new StorageError('not_found', 'the bucket does not exist');
    if (res.status === 403) throw new StorageError('auth', 'access to the bucket denied');
    if (res.status !== 200) throw new StorageError('failed', `bucket: HTTP ${res.status}`);
  }

  async function space() { return { free: null, total: null }; }

  // files: false — on S3 media areas always keep sealed blocks under opaque keys
  /** After a `tls` failure: the certificate the endpoint presents for the bucket's host (net.inspectTls). */
  async function inspectTls() {
    if (endpoint.protocol !== 'https:') return null;
    return net.inspectTls({ url: `https://${where(null).host}/`, tlsCa });
  }

  return { kind: 's3', ranges: true, files: false, put, get, head, remove, copy, space, prepare, inspectTls };
}

module.exports = { create, sign, uriEncode, PART_SIZE, COPY_MAX, _copyLimitsForTest: copyLimits };
