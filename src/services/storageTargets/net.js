'use strict';

// Network helpers of the storage targets (docs/storage-targets.md): every
// connection goes to an address checked once and pinned (no second DNS
// answer between check and connect). TLS is always verified; a target may
// bring its own trust anchor (`tlsCa`, PEM): the NAS's self-signed
// certificate or a private CA. Then only that anchor is trusted, and a
// server presenting exactly a pinned certificate needs no matching host name
// (a NAS reached by its IP with a certificate for "synology"). Every stored
// certificate is an anchor, also a leaf issued by a CA (DSM's default
// certificate). inspectTls reads what a server presents when that fails.
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
const { handshakeError } = require('./errors');

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

/**
 * TLS options for a target's own trust anchor: only it is trusted; a pinned
 * leaf needs no matching name. `allowPartialTrustChain` (OpenSSL
 * X509_V_FLAG_PARTIAL_CHAIN): every stored certificate is an anchor, not
 * only a self-signed root — the leaf of a Synology (issued by "Synology Inc.
 * CA") or an intermediate CA. Without it OpenSSL wants the chain up to a
 * root and refuses such a leaf (UNABLE_TO_VERIFY_LEAF_SIGNATURE,
 * SELF_SIGNED_CERT_IN_CHAIN). Safe here: the system CAs are not in this
 * context, the dates are still checked, and a leaf signed by a stored
 * certificate still has to match the URL's name.
 */
function caOptions(tlsCa) {
  const certs = parseCa(tlsCa);
  const pinned = new Set(certs.map((c) => c.fingerprint));
  return {
    ca: certs.map((c) => c.pem),
    allowPartialTrustChain: true,
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

/** A certificate (DER) → what the check shows of it, with its PEM. */
function certInfo(raw) {
  const c = new crypto.X509Certificate(raw);
  const names = String(c.subjectAltName || '').split(/,\s*/).filter(Boolean)
    .map((n) => n.replace(/^DNS:/, '').replace(/^IP Address:/, '')).filter((n) => !/:/.test(n) || /^[0-9a-f:.]+$/i.test(n));
  return {
    subject: c.subject.replace(/\n/g, ', '), issuer: c.issuer.replace(/\n/g, ', '), names,
    validFrom: new Date(c.validFrom).toISOString(), validTo: new Date(c.validTo).toISOString(), fingerprint: c.fingerprint256.replace(/:/g, '').toLowerCase(),
    ca: !!c.ca, selfSigned: c.checkIssued(c) && c.verify(c.publicKey), pem: c.toString(),
  };
}

// OpenSSL's verdict on the chain → why it is not trusted (docs/storage-targets.md "Certificates")
const TLS_REASON = {
  CERT_HAS_EXPIRED: 'expired', CERT_NOT_YET_VALID: 'not_yet_valid',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'self_signed', SELF_SIGNED_CERT_IN_CHAIN: 'untrusted_ca',
  UNABLE_TO_GET_ISSUER_CERT: 'untrusted_ca', UNABLE_TO_GET_ISSUER_CERT_LOCALLY: 'untrusted_ca',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'missing_intermediate',
};

/**
 * The certificate a server presents and why it is not trusted — the
 * diagnosis after a check failed with `tls`. Same address rules, dial and
 * name (SNI) as request(), the same trust (the target's own anchor or the
 * system CAs, verified): the certificate is read when the handshake is done,
 * the socket closed right after — not one application byte, no credentials.
 * opts: { url, dial ({ host, port } or null), tlsCa, timeoutMs }
 * → { reason, code, host, cert, chain: [cert …] (the server's certificates
 *     with the issuers found, leaf first) }
 *   reason: null (trusted) | 'name' | 'expired' | 'not_yet_valid' | 'self_signed'
 *           | 'missing_intermediate' | 'untrusted_ca' | 'not_stored' | 'untrusted'
 *           | 'not_tls' (no TLS on that port) | 'handshake' (refused before a
 *           certificate: an alert, no common protocol) — then cert null, chain []
 */
async function inspectTls(opts) {
  const u = opts.url instanceof URL ? opts.url : new URL(opts.url);
  if (u.protocol !== 'https:') throw new NetError('invalid_url', 'only https');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const dial = opts.dial || null;
  const port = dial ? Number(dial.port) : (Number(u.port) || 443);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || (dial && !dial.host)) throw new NetError('net', 'no address to connect to');
  const { address, family } = await resolve(dial ? dial.host : host, port);
  const ca = opts.tlsCa ? caOptions(opts.tlsCa) : null;
  // verified like request() (rejectUnauthorized stays on); only the name is
  // checked below, to tell `name` from the rest
  const o = { host: address, family, port, servername: netPolicy.isIpLiteral(host) ? undefined : host, checkServerIdentity: () => undefined };
  if (ca) { o.ca = ca.ca; o.allowPartialTrustChain = true; }
  const seen = await new Promise((resolveP, reject) => {
    const s = tls.connect(o);
    let peer = null;
    // 'secure': the handshake is done, Node's verdict on the chain comes next
    // ('secureConnect', or an error and the socket destroyed) — read the
    // certificate before that; nothing is ever written to this socket
    s.prependListener('secure', () => {
      try { peer = s.getPeerCertificate(true); } catch { /* none */ }
    });
    const fail = (e) => {
      s.destroy();
      const hs = handshakeError(e);
      // the chain refused: Node's code is the finding
      if (peer && peer.raw && !hs && e && e.code) resolveP({ peer, code: String(e.code) });
      // no TLS at all, or a handshake aborted before any certificate
      else if (hs) resolveP({ peer: null, code: hs.sys, kind: hs.code === 'not_tls' ? 'not_tls' : 'handshake' });
      else reject(e instanceof NetError ? e : new NetError((e && e.code) || 'net', e && e.message));
    };
    s.setTimeout(opts.timeoutMs || 15000, () => fail(new NetError('timeout', 'no answer')));
    s.once('error', fail);
    s.once('secureConnect', () => {
      const p = peer || s.getPeerCertificate(true);
      s.destroy();
      resolveP({ peer: p, code: null });
    });
  });
  if (seen.kind) return { reason: seen.kind, code: seen.code, host, cert: null, chain: [] };
  if (!seen.peer || !seen.peer.raw) throw new NetError('tls', 'the server presented no certificate');
  const chain = [];
  const fps = new Set();
  for (let c = seen.peer; c && c.raw && chain.length < 10; c = c.issuerCertificate) {
    const info = certInfo(c.raw);
    if (fps.has(info.fingerprint)) break;
    fps.add(info.fingerprint);
    chain.push(info);
  }
  let reason = null;
  if (seen.code) {
    reason = TLS_REASON[seen.code] || 'untrusted';
    if (reason === 'untrusted_ca' && chain.length === 1 && !chain[0].selfSigned) reason = 'missing_intermediate';
    if (ca && reason !== 'expired' && reason !== 'not_yet_valid') reason = 'not_stored';
  } else {
    const checkIdentity = ca ? ca.checkServerIdentity : tls.checkServerIdentity;
    if (checkIdentity(host, seen.peer)) reason = 'name';
  }
  return { reason, code: seen.code, host, cert: chain[0], chain };
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
  NetError, addressAllowed, resolve, parseCa, request, inspectTls, readBody, drain,
  _setLookupForTest: (fn) => { lookupImpl = fn; },
};
