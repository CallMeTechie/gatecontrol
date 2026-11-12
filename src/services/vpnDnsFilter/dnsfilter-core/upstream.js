'use strict';

// Weiterleitung der erlaubten Anfragen (Vertrag Phase 3b §1.2):
//   1. DNS über HTTPS (RFC 8484, HTTP/2, POST application/dns-message)
//   2. Rückfall Router (UDP 53, bei TC über TCP) – wenn `fallbackRouter`
//
// Bekannte Anbieter werden über feste IP-Adressen erreicht (TLS-Prüfung gegen
// den Hostnamen): Zeigt der Router alle Geräte – auch den Gateway-Host – auf
// den Filter, darf die Weiterleitung nicht selbst wieder DNS brauchen.

const http2 = require('node:http2');
const tls = require('node:tls');
const net = require('node:net');
const dgram = require('node:dgram');
const dns = require('node:dns');
const crypto = require('node:crypto');

const PROVIDERS = Object.freeze({
  quad9: { url: 'https://dns.quad9.net/dns-query', ips: ['9.9.9.9', '149.112.112.112'] },
  cloudflare: { url: 'https://cloudflare-dns.com/dns-query', ips: ['1.1.1.1', '1.0.0.1'] },
  dns0: { url: 'https://dns0.eu/dns-query', ips: ['193.110.81.0', '185.253.5.0'] },
});
const MAX_RESPONSE = 65535;
const DOH_TIMEOUT_MS = 3000;
const ROUTER_TIMEOUT_MS = 2500;
const IDLE_MS = 120_000;
const DOWN_AFTER = 3;
const DOWN_MS = 60_000;

class UpstreamError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

/**
 * DoH-Client mit einer HTTP/2-Verbindung (wird bei Fehlern/GOAWAY neu
 * aufgebaut). `ips` = feste Adressen in Reihenfolge; ohne → Auflösung über
 * `lookup` (Router zuerst).
 */
class DohClient {
  constructor({ url, ips = [], timeoutMs = DOH_TIMEOUT_MS, tlsOptions = {}, lookup = null, port = null }) {
    const u = new URL(url);
    this.url = u;
    this.host = u.hostname;
    this.port = port || Number(u.port) || 443;
    this.path = u.pathname + u.search;
    this.ips = ips.slice();
    this.timeoutMs = timeoutMs;
    this.tlsOptions = tlsOptions;
    this.lookup = lookup;
    this.session = null;
    this.connecting = null;
    this.ipIndex = 0;
  }

  _drop(s) {
    if (this.session === s) this.session = null;
    try { s.destroy(); } catch (_e) { /* schon zu */ }
  }

  async _connectTo(ip) {
    return new Promise((resolve, reject) => {
      const opts = {
        ...this.tlsOptions,
        port: this.port,
        servername: net.isIP(this.host) ? undefined : this.host,
        ALPNProtocols: ['h2'],
        minVersion: 'TLSv1.2',
      };
      if (ip) opts.host = ip; else { opts.host = this.host; if (this.lookup) opts.lookup = this.lookup; }
      const s = http2.connect(this.url.origin, { createConnection: () => tls.connect(opts), maxSessionMemory: 4 });
      const timer = setTimeout(() => { this._drop(s); reject(new UpstreamError('timeout', 'connect timeout')); }, this.timeoutMs);
      s.once('connect', () => { clearTimeout(timer); resolve(s); });
      s.once('error', (err) => { clearTimeout(timer); this._drop(s); reject(new UpstreamError('connect', err.message)); });
    });
  }

  async _session() {
    if (this.session && !this.session.closed && !this.session.destroyed) return this.session;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const candidates = this.ips.length ? this.ips.map((_, i) => this.ips[(this.ipIndex + i) % this.ips.length]) : [null];
      let last = null;
      for (let i = 0; i < candidates.length; i++) {
        try {
          const s = await this._connectTo(candidates[i]);
          this.ipIndex = (this.ipIndex + i) % Math.max(1, this.ips.length);
          s.on('error', () => this._drop(s));
          s.on('goaway', () => this._drop(s));
          s.on('close', () => { if (this.session === s) this.session = null; });
          s.setTimeout(IDLE_MS, () => this._drop(s));
          s.unref();
          this.session = s;
          return s;
        } catch (err) {
          last = err;
        }
      }
      throw last || new UpstreamError('connect');
    })();
    try { return await this.connecting; } finally { this.connecting = null; }
  }

  /** Anfrage (wire, ID wird 0 gesetzt) → Antwort (wire). */
  async query(wire) {
    const body = Buffer.from(wire);
    body.writeUInt16BE(0, 0);
    const s = await this._session();
    s.ref();
    try {
      return await new Promise((resolve, reject) => {
        const req = s.request({
          ':method': 'POST', ':path': this.path,
          'content-type': 'application/dns-message', accept: 'application/dns-message',
          'content-length': body.length,
        });
        const chunks = [];
        let size = 0;
        let status = 0;
        const timer = setTimeout(() => { req.close(http2.constants.NGHTTP2_CANCEL); reject(new UpstreamError('timeout')); }, this.timeoutMs);
        req.on('response', (h) => { status = h[':status']; });
        req.on('data', (c) => {
          size += c.length;
          if (size > MAX_RESPONSE) { req.close(http2.constants.NGHTTP2_CANCEL); clearTimeout(timer); reject(new UpstreamError('too_large')); return; }
          chunks.push(c);
        });
        req.on('end', () => {
          clearTimeout(timer);
          if (status !== 200) return reject(new UpstreamError('http_status', `HTTP ${status}`));
          const out = Buffer.concat(chunks);
          if (out.length < 12) return reject(new UpstreamError('short'));
          return resolve(out);
        });
        req.on('error', (err) => { clearTimeout(timer); reject(new UpstreamError('stream', err.message)); });
        req.end(body);
      });
    } finally {
      if (!s.destroyed) s.unref();
    }
  }

  close() {
    if (this.session) this._drop(this.session);
  }
}

/** Klassisches DNS über UDP an `ip:port`; ID und Absender werden geprüft. */
function udpQuery(ip, wire, { port = 53, timeoutMs = ROUTER_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket(net.isIPv6(ip) ? 'udp6' : 'udp4');
    const id = crypto.randomInt(0, 65536);
    const q = Buffer.from(wire);
    q.writeUInt16BE(id, 0);
    let done = false;
    const finish = (err, res) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { sock.close(); } catch (_e) { /* zu */ }
      if (err) reject(err); else resolve(res);
    };
    const timer = setTimeout(() => finish(new UpstreamError('timeout')), timeoutMs);
    sock.on('error', (err) => finish(new UpstreamError('udp', err.message)));
    sock.on('message', (msg, rinfo) => {
      if (rinfo.address !== ip || rinfo.port !== port || msg.length < 12 || msg.readUInt16BE(0) !== id) return;
      finish(null, msg);
    });
    sock.send(q, port, ip, (err) => { if (err) finish(new UpstreamError('udp', err.message)); });
  });
}

/** DNS über TCP (2-Byte-Längenpräfix). */
function tcpQuery(ip, wire, { port = 53, timeoutMs = ROUTER_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const id = crypto.randomInt(0, 65536);
    const q = Buffer.from(wire);
    q.writeUInt16BE(id, 0);
    const len = Buffer.alloc(2);
    len.writeUInt16BE(q.length, 0);
    const sock = net.connect({ host: ip, port });
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => { sock.destroy(); reject(new UpstreamError('timeout')); }, timeoutMs);
    sock.on('connect', () => sock.write(Buffer.concat([len, q])));
    sock.on('data', (c) => {
      buf = Buffer.concat([buf, c]);
      if (buf.length > MAX_RESPONSE + 2) { sock.destroy(); clearTimeout(timer); reject(new UpstreamError('too_large')); return; }
      if (buf.length >= 2 && buf.length >= 2 + buf.readUInt16BE(0)) {
        clearTimeout(timer);
        const msg = buf.subarray(2, 2 + buf.readUInt16BE(0));
        sock.destroy();
        if (msg.length < 12 || msg.readUInt16BE(0) !== id) reject(new UpstreamError('mismatch'));
        else resolve(Buffer.from(msg));
      }
    });
    sock.on('error', (err) => { clearTimeout(timer); reject(new UpstreamError('tcp', err.message)); });
    sock.on('close', () => { clearTimeout(timer); reject(new UpstreamError('closed')); });
  });
}

/** Router fragen: UDP, bei abgeschnittener Antwort TCP. */
async function routerQuery(ip, wire, opts) {
  const r = await udpQuery(ip, wire, opts);
  if (r.readUInt16BE(2) & 0x0200) return tcpQuery(ip, wire, opts);
  return r;
}

/** Hostnamen über den Router auflösen (für eigene DoH-Adressen ohne feste IPs). */
function routerLookup(routerIp) {
  return (hostname, options, cb) => {
    if (typeof options === 'function') { cb = options; options = {}; }
    const fallback = () => dns.lookup(hostname, { family: 4 }, cb);
    const ip = routerIp();
    if (!ip) return fallback();
    const r = new dns.Resolver({ timeout: 2000, tries: 1 });
    r.setServers([ip]);
    r.resolve4(hostname, (err, addrs) => {
      if (err || !addrs || !addrs.length) return fallback();
      if (options && options.all) return cb(null, addrs.map((a) => ({ address: a, family: 4 })));
      return cb(null, addrs[0], 4);
    });
    return undefined;
  };
}

/**
 * Weiterleitung mit Rückfall. Zustand für die Telemetrie in `state`.
 * `routerIp()` liefert das Default-Gateway (oder null).
 */
class Upstream {
  constructor({ upstream, routerIp = () => null, doh = null, routerQueryFn = routerQuery, now = Date.now }) {
    this.cfg = upstream;
    this.routerIp = routerIp;
    this.routerQueryFn = routerQueryFn;
    this.now = now;
    const p = PROVIDERS[upstream.provider];
    this.doh = doh || new DohClient(p
      ? { url: p.url, ips: p.ips }
      : { url: upstream.url, lookup: routerLookup(routerIp) });
    this.state = { provider: upstream.provider, lastOkAt: null, lastError: null, lastFallbackAt: null, dohFailures: 0, fallbacks: 0, dohDownUntil: 0 };
    this.streak = 0;
  }

  async _router(wire, fromIp, err) {
    const rip = this.routerIp();
    // Schleifenschutz: Fragt der Router selbst, nicht an ihn zurückgeben.
    if (!this.cfg.fallbackRouter || !rip || rip === fromIp) throw err;
    const r = await this.routerQueryFn(rip, wire);
    this.state.fallbacks++;
    this.state.lastFallbackAt = this.now();
    return { wire: r, via: 'router' };
  }

  /**
   * → { wire, via: 'doh'|'router' } oder wirft UpstreamError. Nach
   * DOWN_AFTER Fehlern in Folge gilt DoH DOWN_MS lang als gestört: Anfragen
   * gehen dann gleich an den Router (kein Warten auf Zeitüberschreitungen),
   * danach wird DoH wieder versucht.
   */
  async query(wire, { fromIp = null } = {}) {
    if (this.state.dohDownUntil > this.now()) {
      return this._router(wire, fromIp, new UpstreamError('doh_down'));
    }
    try {
      const r = await this.doh.query(wire);
      this.state.lastOkAt = this.now();
      this.streak = 0;
      return { wire: r, via: 'doh' };
    } catch (err) {
      this.state.dohFailures++;
      this.state.lastError = { at: this.now(), code: err.code || 'error' };
      if (++this.streak >= DOWN_AFTER) { this.state.dohDownUntil = this.now() + DOWN_MS; this.streak = 0; }
      return this._router(wire, fromIp, err);
    }
  }

  /** Lokale Namen direkt beim Router. */
  async local(wire, { fromIp = null } = {}) {
    const rip = this.routerIp();
    if (!rip || rip === fromIp) throw new UpstreamError('no_router');
    return { wire: await this.routerQueryFn(rip, wire), via: 'router' };
  }

  close() { this.doh.close(); }
}

module.exports = { DohClient, Upstream, UpstreamError, udpQuery, tcpQuery, routerQuery, PROVIDERS };
