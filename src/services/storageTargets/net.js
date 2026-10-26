'use strict';

// Network helpers of the storage targets (docs/storage-targets.md): every
// connection goes to an address checked once and pinned (no second DNS
// answer between check and connect), optionally to a TLS certificate pinned
// by its SHA-256 fingerprint (a NAS with a self-signed certificate).
//
// Allowed: public, private, carrier-grade NAT and loopback addresses — an
// administrator sets these targets up, a MinIO next to GateControl is fine.
// Never: unspecified, broadcast, multicast, link-local (cloud metadata) and
// reserved ranges, the metadata addresses, and GateControl's own admin
// ports (app, Caddy admin) on this server's addresses.

const http = require('node:http');
const https = require('node:https');
const tls = require('node:tls');
const netPolicy = require('../plugins/netPolicy');

const ALLOWED_RANGES = new Set(['unicast', 'private', 'loopback', 'carrierGradeNat', 'uniqueLocal']);
const IDLE_MS = 60 * 1000;

class NetError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

function blockedPorts() {
  let app = 3000;
  try { app = require('../../../config/default').app.port; } catch { /* default */ }
  return new Set([Number(app), 2019]);
}

/** May a storage target connect to `ip` on `port`? */
function addressAllowed(ip, port) {
  let a;
  try { a = netPolicy.toAddr(ip); } catch { return false; }
  if (!ALLOWED_RANGES.has(a.range())) return false;
  // the metadata addresses are unicast / unique-local themselves
  if (netPolicy.classify(a.toString()) === 'never' && a.range() !== 'loopback') return false;
  if (blockedPorts().has(Number(port)) && netPolicy.isHostReserved(a.toString())) return false;
  return true;
}

let lookupImpl = null;

/** Resolve `host` once and check every answer → { address, family }. */
async function resolve(host, port) {
  const h = String(host || '').replace(/^\[|\]$/g, '');
  let addrs;
  if (netPolicy.isIpLiteral(h)) addrs = [{ address: netPolicy.toAddr(h).toString() }];
  else {
    try { addrs = await (lookupImpl || netPolicy.lookupAll)(h); } catch { throw new NetError('dns', `${h} does not resolve`); }
    if (!addrs || !addrs.length) throw new NetError('dns', `${h} does not resolve`);
  }
  for (const a of addrs) {
    if (!addressAllowed(a.address, port)) throw new NetError('blocked_address', `${h} is not an address a storage target may use`);
  }
  const first = netPolicy.toAddr(addrs[0].address);
  return { address: first.toString(), family: first.kind() === 'ipv6' ? 6 : 4 };
}

/** "AB:CD:…", "abcd…" → lower-case hex without separators, or null. */
function normFingerprint(v) {
  if (v == null || v === '') return null;
  const s = String(v).replace(/[\s:]/g, '').toLowerCase();
  return /^[0-9a-f]{64}$/.test(s) ? s : undefined;
}

/** A TLS connection whose certificate must have `fingerprint` (SHA-256), chain not checked. */
function pinnedTls({ address, port, servername, fingerprint }) {
  return new Promise((resolveP, reject) => {
    const sock = tls.connect({ host: address, port, servername: netPolicy.isIpLiteral(servername) ? undefined : servername, rejectUnauthorized: false });
    sock.setTimeout(IDLE_MS, () => sock.destroy(new NetError('timeout', 'no answer')));
    sock.once('error', reject);
    sock.once('secureConnect', () => {
      const cert = sock.getPeerCertificate();
      const got = cert && cert.fingerprint256 ? cert.fingerprint256.replace(/:/g, '').toLowerCase() : '';
      if (got !== fingerprint) { sock.destroy(); reject(new NetError('tls_fingerprint', 'the server certificate does not match the fingerprint')); return; }
      sock.removeListener('error', reject);
      resolveP(sock);
    });
  });
}

/**
 * One HTTP(S) request to a checked, pinned address.
 * opts: { method, url (string|URL), headers, body (Buffer | Readable | null),
 *         fingerprint (normalised SHA-256 hex or null), idleMs }
 * → { status, headers, stream } — the caller reads or drains `stream`.
 */
async function request(opts) {
  const u = opts.url instanceof URL ? opts.url : new URL(opts.url);
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new NetError('invalid_url', 'only http and https');
  const isHttps = u.protocol === 'https:';
  const port = Number(u.port) || (isHttps ? 443 : 80);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const { address, family } = await resolve(host, port);
  const headers = Object.assign({}, opts.headers || {});
  if (Buffer.isBuffer(opts.body)) headers['content-length'] = String(opts.body.length);
  const ro = {
    method: opts.method || 'GET', host: address, family, port, path: u.pathname + u.search,
    headers: Object.assign({ host: u.host }, headers), agent: false,
  };
  if (isHttps) {
    if (opts.fingerprint) {
      const sock = await pinnedTls({ address, port, servername: host, fingerprint: opts.fingerprint });
      ro.createConnection = () => sock;
    } else {
      ro.servername = netPolicy.isIpLiteral(host) ? undefined : host;
    }
  }
  const lib = isHttps ? https : http;
  return new Promise((resolveP, reject) => {
    const rq = lib.request(ro, (res) => {
      res.setTimeout(opts.idleMs || IDLE_MS, () => res.destroy(new NetError('timeout', 'the transfer stalled')));
      resolveP({ status: res.statusCode, headers: res.headers, stream: res });
    });
    rq.setTimeout(opts.idleMs || IDLE_MS, () => rq.destroy(new NetError('timeout', 'no answer')));
    rq.on('error', (e) => reject(e instanceof NetError ? e : new NetError('net', e.message)));
    const body = opts.body;
    if (body == null) rq.end();
    else if (Buffer.isBuffer(body) || typeof body === 'string') rq.end(body);
    else {
      body.on('error', (e) => rq.destroy(e));
      body.pipe(rq);
    }
  });
}

/** Read a whole (small) answer body → Buffer, at most `max` bytes. */
async function readBody(stream, max = 4 * 1024 * 1024) {
  const parts = [];
  let n = 0;
  for await (const c of stream) {
    n += c.length;
    if (n > max) { stream.destroy(); throw new NetError('too_large', 'answer too large'); }
    parts.push(c);
  }
  return Buffer.concat(parts);
}

/** Drain and drop an answer body. */
async function drain(stream) {
  try { for await (const c of stream) { void c; } } catch { /* closed */ }
}

module.exports = {
  NetError, addressAllowed, resolve, normFingerprint, request, readBody, drain,
  _setLookupForTest: (fn) => { lookupImpl = fn; },
};
