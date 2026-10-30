'use strict';

// gc.http.fetchImage(url, { maxBytes, timeoutMs }) (plugin.json
// `permissions.network.images: true`, docs/plugins.md "Network", since
// 1.216.0): one picture from any public host, loaded by the host on behalf
// of the plugin — e.g. the pictures of a mail, so the sender never sees the
// reader's address. GET only, http/https on 80, 443, 8080, 8443; every
// resolved address public (checked like gc.http.fetch, pinned), at most 5
// redirects, each checked again; no cookies, no Referer, a neutral
// User-Agent. The answer must be a picture: Content-Type image/* (never SVG)
// and the bytes of a known picture format (JPEG, PNG, GIF, WebP, BMP, ICO,
// AVIF/HEIC, TIFF), else ERR_INVALID. → { status, mime, bytes }.

const netPolicy = require('./netPolicy');

const PORTS = [[80, 80], [443, 443], [8080, 8080], [8443, 8443]];
let testPorts = null; // test seam (NODE_ENV=test): the port of the tests' own server
const MAX_BYTES_DEFAULT = 2 * 1024 * 1024;
const MAX_BYTES = 5 * 1024 * 1024;
const TIMEOUT_DEFAULT_MS = 10000;
const TIMEOUT_MAX_MS = 15000;
const REDIRECTS_MAX = 5;
const PARALLEL = 8;
const USER_AGENT = 'Mozilla/5.0 (compatible; ImageProxy)';
const slots = new Map(); // plugin id → { running, waiting: [resolve] }

class ImageError extends Error {
  constructor(code, message, extra) { super(message || code); this.code = code; if (extra) Object.assign(this, extra); }
}

function need(cond, code, message) { if (!cond) throw new ImageError(code, message); }

/** The picture format of `buf` by its first bytes → MIME type, or null. */
function sniff(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return null;
  const at = (i, s) => buf.length >= i + s.length && buf.subarray(i, i + s.length).toString('latin1') === s;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (at(0, '\x89PNG\r\n\x1a\n')) return 'image/png';
  if (at(0, 'GIF87a') || at(0, 'GIF89a')) return 'image/gif';
  if (at(0, 'RIFF') && at(8, 'WEBP')) return 'image/webp';
  if (at(0, 'BM') && buf.length >= 26) return 'image/bmp';
  if (buf[0] === 0 && buf[1] === 0 && buf[2] === 1 && buf[3] === 0) return 'image/x-icon';
  if (at(0, 'II*\x00') || at(0, 'MM\x00*')) return 'image/tiff';
  if (at(4, 'ftyp')) {
    const brand = buf.subarray(8, 12).toString('latin1');
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
    if (['heic', 'heix', 'hevc', 'heim', 'heis', 'mif1', 'msf1'].includes(brand)) return 'image/heic';
  }
  return null;
}

function declared(plugin) {
  const n = plugin && plugin.manifest && plugin.manifest.permissions && plugin.manifest.permissions.network;
  return !!(n && !Array.isArray(n) && n.images === true);
}

async function slot(pluginId) {
  let st = slots.get(pluginId);
  if (!st) { st = { running: 0, waiting: [] }; slots.set(pluginId, st); }
  if (st.running >= PARALLEL) await new Promise((resolve) => st.waiting.push(resolve));
  st.running++;
  return () => { st.running--; const next = st.waiting.shift(); if (next) next(); };
}

/**
 * @returns {Promise<{ status, mime, bytesBase64 }>} (the plugin process turns bytesBase64 into a Buffer `bytes`)
 */
async function fetchImage(plugin, args, opts = {}) {
  need(declared(plugin), 'ERR_NETWORK_DENIED', 'plugin.json does not declare permissions.network.images');
  const url = args && args.url;
  need(typeof url === 'string' && url.length <= 8192 && /^https?:\/\//i.test(url), 'ERR_INVALID', 'invalid url (http or https)');
  const o = args && args.opts != null ? args.opts : {};
  need(typeof o === 'object' && !Array.isArray(o), 'ERR_INVALID', 'invalid options');
  need(o.maxBytes == null || (Number.isSafeInteger(o.maxBytes) && o.maxBytes >= 1 && o.maxBytes <= MAX_BYTES), 'ERR_INVALID', 'maxBytes must be 1 … 5 MB');
  need(o.timeoutMs == null || (Number.isFinite(o.timeoutMs) && o.timeoutMs >= 1 && o.timeoutMs <= TIMEOUT_MAX_MS), 'ERR_INVALID', 'timeoutMs must be ≤ 15000');
  const maxBytes = o.maxBytes == null ? MAX_BYTES_DEFAULT : o.maxBytes;
  const timeoutMs = Math.max(1000, o.timeoutMs == null ? TIMEOUT_DEFAULT_MS : o.timeoutMs);
  const release = await slot(plugin.id);
  let res;
  try {
    res = await netPolicy.fetchWithPolicy(netPolicy.anyPublic(testPorts || PORTS), url, {
      method: 'GET', headers: { 'user-agent': USER_AGENT, accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif,image/*;q=0.8' },
      body: null, timeoutMs, maxBytes, redirect: 'follow', maxRedirects: REDIRECTS_MAX, deadline: Date.now() + timeoutMs,
      lookup: opts.lookup, reserved: opts.reserved,
    });
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (e && e.code === 'ERR_NET_DENIED') throw new ImageError('ERR_NETWORK_DENIED', msg.slice(0, 200));
    if (msg === 'response_too_large') throw new ImageError('ERR_MEDIA_TOO_LARGE', `the picture is larger than ${maxBytes} bytes`);
    if ((e && e.code === 'ERR_TIMEOUT') || msg === 'timeout') throw new ImageError('ERR_TIMEOUT', 'the picture did not arrive in time');
    throw new ImageError('ERR_NET', msg.slice(0, 200));
  } finally { release(); }
  if (res.status < 200 || res.status > 299) throw new ImageError('ERR_HTTP', `HTTP ${res.status}`, { status: res.status });
  const declaredType = String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  need(/^image\/[a-z0-9.+-]+$/.test(declaredType) && declaredType !== 'image/svg+xml', 'ERR_INVALID', `not a picture (${declaredType || 'no type'})`);
  const mime = sniff(res.body);
  need(mime, 'ERR_INVALID', 'not a picture (unknown format)');
  return { status: res.status, mime, bytesBase64: res.body.toString('base64') };
}

function _resetForTest() { if (process.env.NODE_ENV === 'test') slots.clear(); }
function _setPortsForTest(ports) { if (process.env.NODE_ENV === 'test') testPorts = ports ? ports.map((p) => [p, p]) : null; }

module.exports = { fetchImage, sniff, ImageError, PORTS, MAX_BYTES, MAX_BYTES_DEFAULT, TIMEOUT_MAX_MS, REDIRECTS_MAX, USER_AGENT, _resetForTest, _setPortsForTest };
