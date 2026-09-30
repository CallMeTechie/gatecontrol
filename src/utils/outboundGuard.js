'use strict';

/**
 * Outbound-URL-Wächter für serverseitige Requests an admin-konfigurierte
 * URLs (Webhooks).
 *
 * GateControl läuft mit `network_mode: host` neben Caddy (Admin-API auf
 * 127.0.0.1:2019) und WireGuard. Ein Webhook, der — direkt, per DNS-Namen,
 * per DNS-Rebinding oder per HTTP-Redirect — auf eine interne Adresse zeigt,
 * wäre ein SSRF-Hebel gegen genau diese Dienste. Deshalb:
 *
 *   1. nur http/https;
 *   2. Hostname auflösen und JEDE Adresse klassifizieren;
 *   3. die Verbindung auf die geprüfte Adresse pinnen (eigener `lookup`),
 *      damit zwischen Prüfung und Verbindung keine zweite DNS-Antwort
 *      (Rebinding) dazwischenkommt;
 *   4. Redirects nicht automatisch folgen — höchstens `maxRedirects`, und
 *      jeder Hop durchläuft 1.–3. erneut;
 *   5. Gesamt-Timeout und Obergrenze für die gelesene Antwort.
 *
 * Adressklassen:
 *   'forbidden' — immer gesperrt: Loopback, 0.0.0.0/8, ::, Link-Local
 *                 (inkl. Cloud-Metadaten 169.254.169.254), Multicast,
 *                 240/4 + Broadcast, 192.0.0.0/24, Teredo, bekannte
 *                 Metadaten-Adressen, die eigene WireGuard-Adresse des
 *                 Servers und alles außerhalb von 2000::/3 bzw. fc00::/7.
 *   'private'   — RFC1918, CGNAT 100.64/10, 198.18/15, fc00::/7 (ULA) und
 *                 das WireGuard-Subnetz. Nur mit `allowPrivate` erreichbar.
 *   'public'    — alles andere.
 *
 * IPv4-mapped (::ffff:a.b.c.d), NAT64 (64:ff9b::/96) und 6to4 (2002::/16)
 * werden auf die eingebettete IPv4-Adresse zurückgeführt.
 */

const dns = require('node:dns');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const ipaddr = require('ipaddr.js');

const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_MAX_BYTES = 64 * 1024;
const MAX_REDIRECTS_CAP = 5;

class OutboundUrlError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'OutboundUrlError';
    this.code = code;
  }
}

// Fehlermeldungen bleiben wortgleich zu den bisherigen, damit das
// i18n-Mapping in routes/api/webhooks.js (VALIDATION_ERROR_MAP) greift.
const MSG = {
  invalid: 'Invalid webhook URL',
  protocol: 'Webhook URL must use http or https',
  localhost: 'Webhook URL must not target localhost',
  private: 'Webhook URL must not target private or reserved IP addresses',
  resolvesPrivate: 'Webhook URL resolves to a private or reserved IP address',
  dns: 'Webhook URL hostname could not be resolved',
  redirects: 'Webhook URL exceeded the redirect limit',
  timeout: 'Webhook request timed out',
};

function cidrs(list) {
  return list.map((c) => ipaddr.parseCIDR(c));
}

const V4_FORBIDDEN = cidrs([
  '0.0.0.0/8',          // "this network", 0.0.0.0
  '127.0.0.0/8',        // Loopback
  '169.254.0.0/16',     // Link-Local, Cloud-Metadaten (AWS/GCP/Azure/OpenStack)
  '192.0.0.0/24',       // IETF-Protokollzuweisungen (u. a. Oracle-Metadaten 192.0.0.192)
  '224.0.0.0/4',        // Multicast
  '240.0.0.0/4',        // Reserviert + 255.255.255.255
  '100.100.100.200/32', // Alibaba-Cloud-Metadaten (liegt in CGNAT)
]);

const V4_PRIVATE = cidrs([
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '100.64.0.0/10',      // CGNAT / Shared Address Space
  '198.18.0.0/15',      // Benchmarking, intern oft als Fake-IP-Bereich genutzt
]);

const V6_FORBIDDEN = cidrs([
  'fd00:ec2::254/128',  // AWS-IMDS über IPv6 (liegt in der ULA)
  '2001::/32',          // Teredo
]);

const V6_GLOBAL = ipaddr.parseCIDR('2000::/3');
const V6_ULA = ipaddr.parseCIDR('fc00::/7');
const V6_NAT64 = ipaddr.parseCIDR('64:ff9b::/96');
const V6_6TO4 = ipaddr.parseCIDR('2002::/16');

function inAny(addr, list) {
  return list.some(([range, bits]) => addr.kind() === range.kind() && addr.match(range, bits));
}

function wireguardRanges() {
  // Lazy: config/default.js wirft ohne GC_SECRET außerhalb der Tests; der
  // Wächter soll auch ohne vollständige Konfiguration nutzbar bleiben.
  let wg = {};
  try { wg = require('../../config/default').wireguard || {}; } catch { /* ignore */ }
  const own = [];
  const subnet = [];
  try { if (wg.gatewayIp) own.push(ipaddr.parseCIDR(`${ipaddr.process(wg.gatewayIp)}/32`)); } catch { /* ignore */ }
  try { if (wg.subnet) subnet.push(ipaddr.parseCIDR(wg.subnet)); } catch { /* ignore */ }
  return { own, subnet };
}

/**
 * Klassifiziert eine IP-Adresse: 'public' | 'private' | 'forbidden'.
 * Unparsbares gilt als 'forbidden'.
 */
function classifyIp(ip, { wg = wireguardRanges() } = {}) {
  let addr;
  try {
    addr = ipaddr.parse(String(ip).replace(/^\[|\]$/g, '').split('%')[0]);
  } catch {
    return 'forbidden';
  }

  if (addr.kind() === 'ipv6') {
    if (addr.isIPv4MappedAddress()) return classifyIp(addr.toIPv4Address().toString(), { wg });
    const bytes = addr.toByteArray();
    if (addr.match(V6_NAT64[0], V6_NAT64[1])) {
      return classifyIp(bytes.slice(12, 16).join('.'), { wg });
    }
    if (addr.match(V6_6TO4[0], V6_6TO4[1])) {
      return classifyIp(bytes.slice(2, 6).join('.'), { wg });
    }
    if (inAny(addr, V6_FORBIDDEN)) return 'forbidden';
    if (addr.match(V6_ULA[0], V6_ULA[1])) return 'private';
    // ::, ::1, IPv4-compatible ::a.b.c.d, fe80::/10, fec0::/10, ff00::/8 …
    if (!addr.match(V6_GLOBAL[0], V6_GLOBAL[1])) return 'forbidden';
    if (addr.range() === 'reserved') return 'forbidden'; // 2001:db8::/32
    if (inAny(addr, wg.own)) return 'forbidden';
    if (inAny(addr, wg.subnet)) return 'private';
    return 'public';
  }

  if (inAny(addr, V4_FORBIDDEN)) return 'forbidden';
  if (inAny(addr, wg.own)) return 'forbidden';
  if (inAny(addr, V4_PRIVATE)) return 'private';
  if (inAny(addr, wg.subnet)) return 'private';
  return 'public';
}

function isLoopbackLike(ip) {
  try {
    let a = ipaddr.parse(String(ip).replace(/^\[|\]$/g, ''));
    if (a.kind() === 'ipv6' && a.isIPv4MappedAddress()) a = a.toIPv4Address();
    return a.range() === 'loopback';
  } catch {
    return false;
  }
}

/** Wirft, wenn die Adresse mit den gegebenen Optionen nicht erreichbar sein darf. */
function assertIpAllowed(ip, { allowPrivate = false, resolved = false } = {}) {
  const cls = classifyIp(ip);
  if (cls === 'public') return;
  if (cls === 'private' && allowPrivate) return;
  if (!resolved && isLoopbackLike(ip)) throw new OutboundUrlError(MSG.localhost, 'LOCALHOST');
  throw new OutboundUrlError(resolved ? MSG.resolvesPrivate : MSG.private, 'FORBIDDEN_ADDRESS');
}

function bareHost(hostname) {
  return hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

/**
 * Synchrone Prüfung ohne DNS: Syntax, Schema, IP-Literale, localhost-Namen.
 * Für die Validierung beim Speichern; maßgeblich ist die Prüfung beim Senden.
 */
function validateUrlSyntax(urlStr, { allowPrivate = false } = {}) {
  let parsed;
  try { parsed = new URL(String(urlStr).trim()); } catch { throw new OutboundUrlError(MSG.invalid, 'INVALID_URL'); }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new OutboundUrlError(MSG.protocol, 'PROTOCOL');
  }
  const host = bareHost(parsed.hostname);
  if (!host) throw new OutboundUrlError(MSG.invalid, 'INVALID_URL');

  if (host === 'localhost' || host.endsWith('.localhost') ||
      host === 'localhost.localdomain' || host === 'ip6-localhost' || host === 'ip6-loopback') {
    throw new OutboundUrlError(MSG.localhost, 'LOCALHOST');
  }

  // WHATWG-URL normalisiert IPv4-Kurzformen (0x7f.1, 2130706433) bereits.
  if (net.isIP(host)) assertIpAllowed(host, { allowPrivate });
  return parsed;
}

/**
 * Löst den Hostnamen auf und prüft ALLE Adressen. Liefert die geprüften
 * Adressen ({address, family}). DNS-Fehler führen zur Ablehnung (fail closed).
 */
async function resolveAndValidate(hostname, { allowPrivate = false, lookup = dns.promises.lookup } = {}) {
  const host = bareHost(hostname);
  if (net.isIP(host)) {
    assertIpAllowed(host, { allowPrivate });
    return [{ address: host, family: net.isIP(host) }];
  }
  let addrs;
  try {
    addrs = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new OutboundUrlError(MSG.dns, 'DNS');
  }
  if (!Array.isArray(addrs) || addrs.length === 0) throw new OutboundUrlError(MSG.dns, 'DNS');
  for (const a of addrs) assertIpAllowed(a.address, { allowPrivate, resolved: true });
  return addrs.map((a) => ({ address: a.address, family: a.family || net.isIP(a.address) }));
}

/** Validiert eine URL vollständig (Syntax + DNS). */
async function validateOutboundUrl(urlStr, opts = {}) {
  const parsed = validateUrlSyntax(urlStr, opts);
  const addresses = await resolveAndValidate(parsed.hostname, opts);
  return { url: parsed, addresses };
}

function pinnedLookup(pinned) {
  return (hostname, options, cb) => {
    if (typeof options === 'function') { cb = options; options = {}; }
    if (options && options.all) return cb(null, [{ address: pinned.address, family: pinned.family }]);
    return cb(null, pinned.address, pinned.family);
  };
}

function requestOnce(url, pinned, { method, headers, body, maxBytes, signal }) {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(url, {
      method,
      headers,
      lookup: pinnedLookup(pinned),
      // Eigene Verbindung: ein Keep-Alive-Socket aus dem globalen Agent
      // könnte sonst zu einer anderen (ungeprüften) Adresse gehören.
      agent: false,
      signal,
    }, (res) => {
      const chunks = [];
      let size = 0;
      let truncated = false;
      res.on('data', (chunk) => {
        if (truncated) return;
        const room = maxBytes - size;
        if (chunk.length > room) {
          if (room > 0) chunks.push(chunk.subarray(0, room));
          size = maxBytes;
          truncated = true;
          res.destroy();
          finish();
          return;
        }
        chunks.push(chunk);
        size += chunk.length;
      });
      let done = false;
      function finish() {
        if (done) return;
        done = true;
        resolve({
          status: res.statusCode,
          statusText: res.statusMessage || '',
          headers: res.headers,
          body: Buffer.concat(chunks),
          truncated,
          url: url.toString(),
        });
      }
      res.on('end', finish);
      res.on('close', finish);
      res.on('error', (err) => { if (!done) { done = true; reject(err); } });
    });
    req.on('error', reject);
    if (body !== undefined && body !== null) req.write(body);
    req.end();
  });
}

function withAbort(promise, signal) {
  if (signal.aborted) return Promise.reject(new OutboundUrlError(MSG.timeout, 'TIMEOUT'));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new OutboundUrlError(MSG.timeout, 'TIMEOUT'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
      (e) => { signal.removeEventListener('abort', onAbort); reject(e); },
    );
  });
}

/**
 * Serverseitiger HTTP-Request an eine admin-konfigurierte URL mit
 * SSRF-Schutz. Redirects werden standardmäßig NICHT gefolgt (3xx wird als
 * Antwort zurückgegeben); mit `maxRedirects > 0` wird jeder Hop neu geprüft.
 */
async function safeRequest(urlStr, {
  method = 'GET',
  headers = {},
  body,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBytes = DEFAULT_MAX_BYTES,
  maxRedirects = 0,
  allowPrivate = false,
  lookup,
} = {}) {
  const redirectsAllowed = Math.max(0, Math.min(MAX_REDIRECTS_CAP, maxRedirects | 0));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();

  let current = urlStr;
  let curMethod = String(method).toUpperCase();
  let curBody = body;
  let curHeaders = { ...headers };
  try {
    for (let hop = 0; ; hop++) {
      const { url, addresses } = await withAbort(
        validateOutboundUrl(current, { allowPrivate, lookup }), controller.signal);
      if (curBody !== undefined && curBody !== null) {
        curHeaders['Content-Length'] = Buffer.byteLength(curBody);
      } else {
        delete curHeaders['Content-Length'];
      }
      const res = await requestOnce(url, addresses[0], {
        method: curMethod, headers: curHeaders, body: curBody, maxBytes, signal: controller.signal,
      });

      const isRedirect = [301, 302, 303, 307, 308].includes(res.status) && res.headers.location;
      if (!isRedirect || redirectsAllowed === 0) return { ...res, redirects: hop };
      if (hop >= redirectsAllowed) throw new OutboundUrlError(MSG.redirects, 'REDIRECTS');

      let next;
      try { next = new URL(res.headers.location, url); } catch { throw new OutboundUrlError(MSG.invalid, 'INVALID_URL'); }
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && curMethod === 'POST')) {
        curMethod = 'GET';
        curBody = undefined;
        delete curHeaders['Content-Type'];
      }
      if (next.origin !== url.origin) {
        for (const k of Object.keys(curHeaders)) {
          if (/^(authorization|cookie|proxy-authorization)$/i.test(k)) delete curHeaders[k];
        }
      }
      current = next.toString();
    }
  } catch (err) {
    if (controller.signal.aborted && !(err instanceof OutboundUrlError)) {
      throw new OutboundUrlError(MSG.timeout, 'TIMEOUT');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  OutboundUrlError,
  classifyIp,
  assertIpAllowed,
  validateUrlSyntax,
  resolveAndValidate,
  validateOutboundUrl,
  safeRequest,
  _internal: { pinnedLookup, MSG },
};
