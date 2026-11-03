'use strict';

// Network side of the scanners (clamd, ICAP): address parsing, the target
// check (SSRF) and a TCP connection with time limits.
//
// A scanner gets the plaintext of every file — it must be one of the
// operator's own machines. Allowed targets: loopback, private networks
// (RFC 1918, CGNAT 100.64/10, IPv6 ULA), the WireGuard subnet; a host name
// must resolve only to such addresses, and the connection goes to the
// address that was checked (no second lookup). Cloud metadata
// (169.254.169.254) and every public address are refused unless
// GC_SCAN_ALLOW_PUBLIC=1 (a scanner rented elsewhere, on the operator's own
// risk).

const net = require('node:net');
const dns = require('node:dns');
const ipaddr = require('ipaddr.js');

class ScanNetError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

const HOST_RE = /^(?:\[[0-9a-fA-F:.]+\]|[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?)$/;

/** 'nas.home.lan:3310' / '[fd00::5]:3310' / 'icap://av.lan:1344/avscan' → { host, port, service }. */
function parseAddress(value, { defaultPort, scheme = null } = {}) {
  let s = String(value == null ? '' : value).trim();
  if (!s || s.length > 300) throw new ScanNetError('address_invalid', 'address missing');
  let service = '';
  if (scheme && s.toLowerCase().startsWith(scheme + '://')) s = s.slice(scheme.length + 3);
  const slash = s.indexOf('/');
  if (slash >= 0) { service = s.slice(slash + 1); s = s.slice(0, slash); }
  let host = s;
  let port = defaultPort;
  const m = /^(\[[^\]]+\]|[^:]+)(?::(\d{1,5}))?$/.exec(s);
  if (!m) throw new ScanNetError('address_invalid', 'not host:port');
  host = m[1];
  if (m[2] !== undefined) port = Number(m[2]);
  if (!HOST_RE.test(host)) throw new ScanNetError('address_invalid', 'invalid host');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ScanNetError('address_invalid', 'invalid port');
  if (service && !/^[A-Za-z0-9._~\-/]{1,100}$/.test(service)) throw new ScanNetError('address_invalid', 'invalid service');
  return { host: host.replace(/^\[|\]$/g, ''), port, service };
}

function allowedIp(ip) {
  let a;
  try { a = ipaddr.process(ip); } catch { return false; }
  const s = a.toString();
  if (s === '169.254.169.254' || s === 'fd00:ec2::254') return false;
  if (process.env.GC_SCAN_ALLOW_PUBLIC === '1') return a.range() !== 'unspecified';
  return ['loopback', 'private', 'uniqueLocal', 'carrierGradeNat', 'linkLocal'].includes(a.range());
}

let _lookup = (host) => dns.promises.lookup(host, { all: true, verbatim: true });

/** Resolve and check the host → the address to connect to. */
async function resolveTarget(host) {
  let addrs;
  if (net.isIP(host)) addrs = [{ address: host }];
  else {
    try { addrs = await _lookup(host); } catch { throw new ScanNetError('unresolvable', `${host} cannot be resolved`); }
  }
  if (!addrs || !addrs.length) throw new ScanNetError('unresolvable', `${host} cannot be resolved`);
  if (!addrs.every((a) => allowedIp(a.address))) throw new ScanNetError('target_not_allowed', 'the scanner must be in your own network (private address)');
  return addrs[0].address;
}

/** A connected socket to the checked address (timeout for the connection itself). */
async function connect({ host, port }, { timeoutMs = 5000 } = {}) {
  const ip = await resolveTarget(host);
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: ip, port });
    const t = setTimeout(() => { sock.destroy(); reject(new ScanNetError('unreachable', 'connection timed out')); }, timeoutMs);
    sock.once('connect', () => { clearTimeout(t); resolve(sock); });
    sock.once('error', (e) => { clearTimeout(t); reject(new ScanNetError('unreachable', e && e.code ? e.code : 'connection failed')); });
  });
}

/** Write with back-pressure. */
function write(sock, buf) {
  return new Promise((resolve, reject) => {
    if (sock.destroyed) { reject(new ScanNetError('unreachable', 'connection closed')); return; }
    const ok = sock.write(buf, (e) => { if (e) reject(new ScanNetError('unreachable', e.message)); });
    if (ok) resolve();
    else {
      const onDrain = () => { cleanup(); resolve(); };
      const onClose = () => { cleanup(); reject(new ScanNetError('unreachable', 'connection closed')); };
      const cleanup = () => { sock.off('drain', onDrain); sock.off('close', onClose); };
      sock.once('drain', onDrain);
      sock.once('close', onClose);
    }
  });
}

/** Collect what the peer sends until it closes or `done(buf)` says so (max bytes, timeout). */
function readReply(sock, { timeoutMs, max = 64 * 1024, done = null }) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let n = 0;
    const t = setTimeout(() => { finish(new ScanNetError('timeout', 'the scanner did not answer in time')); }, timeoutMs);
    function finish(err) {
      clearTimeout(t);
      sock.off('data', onData);
      sock.off('end', onEnd);
      sock.off('error', onErr);
      sock.off('close', onEnd);
      if (err) reject(err); else resolve(Buffer.concat(parts));
    }
    function onData(d) {
      parts.push(d);
      n += d.length;
      if (n > max) { finish(new ScanNetError('protocol', 'answer too long')); return; }
      if (done && done(Buffer.concat(parts))) finish();
    }
    function onEnd() { finish(); }
    function onErr(e) { finish(new ScanNetError('unreachable', e && e.message)); }
    sock.on('data', onData);
    sock.once('end', onEnd);
    sock.once('close', onEnd);
    sock.once('error', onErr);
  });
}

function _setLookupForTest(fn) { _lookup = fn || ((host) => dns.promises.lookup(host, { all: true, verbatim: true })); }

module.exports = { ScanNetError, parseAddress, allowedIp, resolveTarget, connect, write, readReply, _setLookupForTest };
