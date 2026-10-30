'use strict';

// Network helpers of the storage targets (docs/storage-targets.md): every
// connection goes to an address checked once and pinned (no second DNS
// answer between check and connect). TLS is always verified; a target may
// bring its own trust anchor (`tlsCa`, PEM): the NAS's self-signed
// certificate or a private CA. Then only that anchor is trusted, and a
// server presenting exactly a pinned certificate needs no matching host name
// (a NAS reached by its IP with a certificate for "synology").
//
// Allowed: public, private, carrier-grade NAT and loopback addresses — an
// administrator sets these targets up, a MinIO next to GateControl is fine.
// Never: unspecified, broadcast, multicast, link-local (cloud metadata) and
// reserved ranges, the metadata addresses, and GateControl's own admin
// ports (app, Caddy admin) on this server's addresses.

const http = require('node:http');
const https = require('node:https');
const tls = require('node:tls');
const crypto = require('node:crypto');
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

/**
 * The certificates of a PEM text → [{ pem, fingerprint (SHA-256 hex), subject, validTo }].
 * Throws NetError invalid_ca for anything that is not one or more certificates.
 */
function parseCa(text) {
  const blocks = String(text || '').match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || [];
  if (!blocks.length || blocks.length > 10) throw new NetError('invalid_ca', 'no certificate');
  return blocks.map((pem) => {
    let c;
    try { c = new crypto.X509Certificate(pem); } catch { throw new NetError('invalid_ca', 'not a certificate'); }
    return { pem, fingerprint: c.fingerprint256.replace(/:/g, '').toLowerCase(), subject: c.subject.replace(/\n/g, ', '), validTo: c.validTo };
  });
}

/** TLS options for a target's own trust anchor: only it is trusted; a pinned leaf needs no matching name. */
function caOptions(tlsCa) {
  const certs = parseCa(tlsCa);
  const pinned = new Set(certs.map((c) => c.fingerprint));
  return {
    ca: certs.map((c) => c.pem),
    checkServerIdentity(host, cert) {
      const fp = cert && cert.fingerprint256 ? cert.fingerprint256.replace(/:/g, '').toLowerCase() : '';
      return pinned.has(fp) ? undefined : tls.checkServerIdentity(host, cert);
    },
  };
}

/**
 * One HTTP(S) request to a checked, pinned address.
 * opts: { method, url (string|URL), headers, body (Buffer | Readable | null),
 *         tlsCa (PEM of the target's own trust anchor, or null), idleMs,
 *         dial ({ host, port, headers } or null) }
 * `dial`: connect there instead of to the URL's host and port (a WebDAV
 * target through a route or a VPN peer) — checked and pinned the same way;
 * the URL still gives the scheme, the path, the Host header and, for https,
 * the name for SNI and the certificate check. `dial.headers` are added.
 * → { status, headers, stream } — the caller reads or drains `stream`.
 */
async function request(opts) {
  const u = opts.url instanceof URL ? opts.url : new URL(opts.url);
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new NetError('invalid_url', 'only http and https');
  const isHttps = u.protocol === 'https:';
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const dial = opts.dial || null;
  const port = dial ? Number(dial.port) : (Number(u.port) || (isHttps ? 443 : 80));
  if (!Number.isInteger(port) || port < 1 || port > 65535 || (dial && !dial.host)) throw new NetError('net', 'no address to connect to');
  const { address, family } = await resolve(dial ? dial.host : host, port);
  const headers = Object.assign({}, opts.headers || {}, dial && dial.headers ? dial.headers : {});
  if (Buffer.isBuffer(opts.body)) headers['content-length'] = String(opts.body.length);
  const ro = {
    method: opts.method || 'GET', host: address, family, port, path: u.pathname + u.search,
    headers: Object.assign({ host: u.host }, headers), agent: false,
  };
  if (isHttps) {
    ro.servername = netPolicy.isIpLiteral(host) ? undefined : host;
    const ca = opts.tlsCa ? caOptions(opts.tlsCa) : null;
    if (ca) Object.assign(ro, ca);
    // the certificate is checked against the URL's host, never against the address dialled
    const checkIdentity = ca ? ca.checkServerIdentity : tls.checkServerIdentity;
    ro.checkServerIdentity = (_dialled, cert) => checkIdentity(host, cert);
  }
  const lib = isHttps ? https : http;
  return new Promise((resolveP, reject) => {
    const rq = lib.request(ro, (res) => {
      res.setTimeout(opts.idleMs || IDLE_MS, () => res.destroy(new NetError('timeout', 'the transfer stalled')));
      resolveP({ status: res.statusCode, headers: res.headers, stream: res });
    });
    rq.setTimeout(opts.idleMs || IDLE_MS, () => rq.destroy(new NetError('timeout', 'no answer')));
    // keep the system's code (ECONNREFUSED, CERT_HAS_EXPIRED …): errors.js maps it
    rq.on('error', (e) => reject(e instanceof NetError ? e : new NetError((e && e.code) || 'net', e.message)));
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
  NetError, addressAllowed, resolve, parseCa, request, readBody, drain,
  _setLookupForTest: (fn) => { lookupImpl = fn; },
};
