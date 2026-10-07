'use strict';

// Network access of plugins (docs/plugins.md "Netzwerk"). A plugin process
// has no network of its own — every connection is made here.
//
// Three target classes (plugin.json permissions.network):
//   internet        host names (exact or "*.domain", optional ports) the
//                   plugin may call with http.fetch. Every resolved address
//                   must be PUBLIC: private, loopback, link-local, CGNAT, ULA,
//                   the WireGuard network, Docker networks and this server's
//                   own addresses are refused (DNS-rebinding SSRF protection).
//   homeTargets     home-network targets the plugin NEEDS, by id; the
//                   administrator assigns the concrete target after install
//                   (a GateControl route, a VPN peer or an entered host) —
//                   see targets.js. The plugin only names the id.
//   localDiscovery  UDP broadcast on declared ports in the server's own local
//                   networks, only when the administrator grants it.
//
// This module: entry parsing, address classes, the internet check, the
// pinned HTTP client (no DNS rebinding between check and connect), TCP and
// UDP primitives used by targets.js.

const dns = require('node:dns');
const dgram = require('node:dgram');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const os = require('node:os');
const ipaddr = require('ipaddr.js');

const HOST_RE = /^(\*\.)?([a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9])?)((?:\.[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9])?)*)$/;
const NEVER_RANGES = new Set(['unspecified', 'broadcast', 'multicast', 'loopback', 'reserved',
  '6to4', 'teredo', 'rfc6052', 'rfc6145', 'ipv4Mapped']);
const PRIVATE_RANGES = new Set(['private', 'carrierGradeNat', 'uniqueLocal', 'linkLocal']);
const METADATA = new Set(['169.254.169.254', 'fd00:ec2::254']);

// ─── Parsing ────────────────────────────────────

function parsePorts(s) {
  if (s === undefined || s === null || s === '') return null;
  const out = [];
  for (const part of (Array.isArray(s) ? s : String(s).split(','))) {
    const m = /^(\d{1,5})(?:-(\d{1,5}))?$/.exec(String(part).trim());
    if (!m) throw new Error('invalid port');
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    if (a < 1 || b > 65535 || a > b) throw new Error('invalid port');
    out.push([a, b]);
  }
  if (!out.length || out.length > 32) throw new Error('invalid port');
  return out;
}

function toAddr(ip) {
  return ipaddr.process(String(ip).replace(/^\[|\]$/g, ''));
}

function parseNet(s) {
  if (s.includes('/')) {
    const [addr, bits] = ipaddr.parseCIDR(s);
    if (addr.kind() === 'ipv6' && addr.isIPv4MappedAddress()) return [addr.toIPv4Address(), Math.max(0, bits - 96)];
    return [addr, bits];
  }
  const addr = toAddr(s);
  return [addr, addr.kind() === 'ipv4' ? 32 : 128];
}

function isIpLiteral(s) {
  return /^[0-9a-f:.]+$/i.test(s) && ipaddr.isValid(s) && !/^\d+$/.test(s);
}

/**
 * One allowlist entry → { raw, type: 'host'|'wildcard'|'cidr', host?, net?, ports }.
 * Throws on anything it does not understand.
 */
function parseEntry(raw) {
  if (typeof raw !== 'string') throw new Error('network entry must be a string');
  const s = raw.trim().toLowerCase();
  if (!s || s.length > 300) throw new Error('invalid network entry');
  let hostPart;
  let portPart = null;
  const br = /^\[([0-9a-f:.]+(?:\/\d{1,3})?)\](?::([0-9,\- ]+))?$/.exec(s);
  if (br) { hostPart = br[1]; portPart = br[2] || null; }
  else if ((s.match(/:/g) || []).length > 1) hostPart = s; // bare IPv6 (no port)
  else {
    const i = s.lastIndexOf(':');
    if (i >= 0) { hostPart = s.slice(0, i); portPart = s.slice(i + 1); } else hostPart = s;
  }
  const ports = parsePorts(portPart);
  const bare = hostPart.split('/')[0];
  if (isIpLiteral(bare) && /^[0-9a-f:.]+(\/\d{1,3})?$/.test(hostPart)) {
    let n;
    try { n = parseNet(hostPart); } catch { throw new Error('invalid network entry'); }
    return { raw, type: 'cidr', net: n, ports };
  }
  if (hostPart.length > 253 || /^[0-9.]+$/.test(hostPart)) throw new Error('invalid network entry');
  const m = HOST_RE.exec(hostPart);
  if (!m || (m[1] && !m[3])) throw new Error('invalid network entry'); // "*.com" is too broad
  return m[1] ? { raw, type: 'wildcard', host: hostPart.slice(2), ports } : { raw, type: 'host', host: hostPart, ports };
}

function parseList(list) {
  if (list == null) return [];
  if (!Array.isArray(list)) throw new Error('permissions.network must be an array');
  if (list.length > 64) throw new Error('too many network entries');
  return list.map(parseEntry);
}

// ─── Host-reserved networks ─────────────────────

let reservedCache = null;
let reservedOverride = null;
const VIRTUAL_IF = /^(docker|br-|veth|cni|flannel|virbr|podman|lxc|lxd)/;

function cidrOf(address, netmask) {
  try {
    const a = toAddr(address);
    const bits = ipaddr.parse(netmask).prefixLengthFromSubnetMask();
    return bits == null ? null : [ipaddr.parse(a.toString()), bits];
  } catch { return null; }
}

/**
 * Networks generic LAN access never reaches: this server's own addresses,
 * Docker/virtual bridge networks, the WireGuard network and its server address.
 * @returns {Array<[ipaddr, number]>}
 */
function hostReserved() {
  if (reservedOverride) return reservedOverride;
  if (reservedCache && Date.now() - reservedCache.at < 60000) return reservedCache.nets;
  const nets = [];
  let wgIf = 'wg0';
  try {
    const cfg = require('../../../config/default');
    wgIf = cfg.wireguard.interface || wgIf;
    if (cfg.wireguard.subnet) nets.push(parseNet(cfg.wireguard.subnet));
    if (cfg.wireguard.gatewayIp) nets.push(parseNet(cfg.wireguard.gatewayIp));
  } catch { /* config unavailable (packing tool) */ }
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const ni of ifs[name] || []) {
      try { nets.push(parseNet(ni.address.split('%')[0])); } catch { /* skip */ }
      if (VIRTUAL_IF.test(name) || name === wgIf) {
        const c = cidrOf(ni.address.split('%')[0], ni.netmask);
        if (c) nets.push(c);
      }
    }
  }
  reservedCache = { at: Date.now(), nets };
  return nets;
}

function inNets(nets, ip) {
  let a;
  try { a = toAddr(ip); } catch { return false; }
  return nets.some(([n, bits]) => {
    try { return a.kind() === n.kind() && a.match(n, bits); } catch { return false; }
  });
}

// ─── Classification and checks ──────────────────

let testPrivate = null; // test seam: loopback addresses that count as public/LAN hosts in tests

/** 'never' | 'private' | 'public' */
function classify(ip) {
  let a;
  try { a = toAddr(ip); } catch { return 'never'; }
  if (testPrivate && testPrivate.has(a.toString())) return testPrivate.get(a.toString());
  if (METADATA.has(a.toString())) return 'never';
  const r = a.range();
  if (NEVER_RANGES.has(r)) return 'never';
  if (PRIVATE_RANGES.has(r)) return 'private';
  return r === 'unicast' ? 'public' : 'never';
}

/** Is `ip` one of this server's own / Docker / WireGuard addresses? */
function isHostReserved(ip, reserved) {
  return inNets(reserved || hostReserved(), ip);
}

function portOk(entry, port) {
  return !entry.ports || entry.ports.some(([a, b]) => port >= a && port <= b);
}

function inRanges(ranges, port) {
  return Array.isArray(ranges) && ranges.some(([a, b]) => port >= a && port <= b);
}

function lookupAll(hostname) {
  return new Promise((resolve, reject) => {
    dns.lookup(hostname, { all: true, verbatim: true }, (err, addrs) => (err ? reject(err) : resolve(addrs)));
  });
}

/** The internet allowlist of a manifest (`permissions.network.internet`). */
function compile(perms) {
  const n = perms && perms.network;
  const list = Array.isArray(n) ? n : (n && n.internet) || [];
  return { entries: parseList(list) };
}

/**
 * Internet check: host must match an entry; every address must be public
 * and not one of this server's own, Docker or WireGuard addresses.
 * @returns {Promise<{ok:true, address, family}|{ok:false, reason}>}
 */
async function checkInternet(policy, host, port, opts = {}) {
  const h = String(host || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (!h || h.length > 253) return { ok: false, reason: 'invalid_host' };
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, reason: 'invalid_port' };
  const literal = isIpLiteral(h);
  const hit = policy.entries.some((e) => portOk(e, port) && (
    (e.type === 'host' && e.host === h)
    || (e.type === 'wildcard' && h.endsWith('.' + e.host))
    || (e.type === 'cidr' && literal && cidrContains(e, h))));
  if (!hit) return { ok: false, reason: 'not_allowed' };
  let addrs;
  if (literal) {
    const a = toAddr(h);
    addrs = [{ address: a.toString(), family: a.kind() === 'ipv6' ? 6 : 4 }];
  } else {
    try { addrs = await (opts.lookup || lookupAll)(h); } catch { return { ok: false, reason: 'dns' }; }
    if (!Array.isArray(addrs) || !addrs.length) return { ok: false, reason: 'dns' };
  }
  const reserved = opts.reserved || hostReserved();
  for (const a of addrs) {
    const cls = classify(a.address);
    if (cls === 'never') return { ok: false, reason: 'blocked_address' };
    if (cls !== 'public' || inNets(reserved, a.address)) return { ok: false, reason: 'not_public' };
  }
  const first = toAddr(addrs[0].address);
  return { ok: true, address: first.toString(), family: first.kind() === 'ipv6' ? 6 : 4 };
}

function cidrContains(entry, ip) {
  if (entry.type !== 'cidr') return false;
  try {
    const a = toAddr(ip);
    const [n, bits] = entry.net;
    return a.kind() === n.kind() && a.match(n, bits);
  } catch { return false; }
}

/** URL check against the internet allowlist (http.fetch, licence check). */
async function checkTarget(url, permsOrPolicy, opts = {}) {
  let u;
  try { u = url instanceof URL ? url : new URL(String(url)); } catch { return { ok: false, reason: 'invalid_url' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, reason: 'protocol' };
  if (u.username || u.password) return { ok: false, reason: 'credentials_in_url' };
  const port = u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80);
  let policy;
  try { policy = permsOrPolicy && permsOrPolicy.entries ? permsOrPolicy : compile(permsOrPolicy); } catch { return { ok: false, reason: 'invalid_policy' }; }
  const r = await checkInternet(policy, u.hostname, port, opts);
  return r.ok ? { ...r, url: u, port } : r;
}

// ─── HTTP ───────────────────────────────────────

const HOP_HEADERS = new Set(['host', 'connection', 'keep-alive', 'transfer-encoding', 'content-length', 'upgrade',
  'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'expect']);

function cleanHeaders(h) {
  const out = {};
  if (!h || typeof h !== 'object') return out;
  let n = 0;
  for (const [k, v] of Object.entries(h)) {
    const key = String(k).toLowerCase();
    if (!/^[a-z0-9!#$%&'*+.^_`|~-]{1,64}$/.test(key) || HOP_HEADERS.has(key)) continue;
    const val = String(v);
    if (val.length > 16384 || /[\r\n\0]/.test(val)) continue;
    out[key] = val;
    if (++n >= 50) break;
  }
  return out;
}

/**
 * One HTTP(S) request pinned to an already checked address. No redirects.
 * @returns {Promise<{status:number, headers:object, body:Buffer}>}
 */
function pinnedRequest({ target, method = 'GET', headers, body, timeoutMs = 15000, maxBytes = 5 * 1024 * 1024 }) {
  const u = target.url;
  const lib = u.protocol === 'https:' ? https : http;
  const payload = body == null ? null : (Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8'));
  const hdrs = cleanHeaders(headers);
  if (payload) hdrs['content-length'] = String(payload.length);
  const hostname = u.hostname.replace(/^\[|\]$/g, '');
  return new Promise((resolve, reject) => {
    const req = lib.request({
      protocol: u.protocol,
      hostname,
      port: target.port,
      path: u.pathname + u.search,
      method,
      headers: hdrs,
      servername: isIpLiteral(hostname) ? undefined : hostname,
      agent: false,
      lookup: (_h, o, cb) => {
        if (o && o.all) return cb(null, [{ address: target.address, family: target.family }]);
        return cb(null, target.address, target.family);
      },
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > maxBytes) { req.destroy(new Error('response_too_large')); return; }
        chunks.push(c);
      });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    const timer = setTimeout(() => req.destroy(new Error('timeout')), timeoutMs);
    req.on('close', () => clearTimeout(timer));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * http.fetch of a plugin: check, request, optionally follow redirects within
 * the policy (each hop checked). Stops at a redirect to a non-http(s)
 * location (e.g. an OAuth app scheme) and returns that 3xx.
 * @returns {Promise<{status, headers, body: Buffer, url: string, redirects: string[]}>}
 */
async function fetchWithPolicy(policy, url, { method = 'GET', headers, body, timeoutMs, maxBytes, redirect = 'manual', lookup, reserved, check } = {}) {
  let current = String(url);
  let m = method;
  let b = body;
  let h = { ...(headers || {}) };
  const redirects = [];
  for (let hop = 0; ; hop++) {
    const target = check ? await check(current) : await checkTarget(current, policy, { lookup, reserved });
    if (!target.ok) throw Object.assign(new Error('connection refused by the plugin policy: ' + target.reason), { code: 'ERR_NET_DENIED', reason: target.reason });
    const res = await pinnedRequest({ target, method: m, headers: h, body: b, timeoutMs, maxBytes });
    const loc = res.headers.location;
    if (redirect !== 'follow' || ![301, 302, 303, 307, 308].includes(res.status) || typeof loc !== 'string') {
      return { ...res, url: current, redirects };
    }
    let next;
    try { next = new URL(loc, current); } catch { return { ...res, url: current, redirects }; }
    if (next.protocol !== 'http:' && next.protocol !== 'https:') return { ...res, url: current, redirects };
    if (hop >= 9) throw Object.assign(new Error('too many redirects'), { code: 'ERR_NET' });
    const sameOrigin = next.origin === new URL(current).origin;
    redirects.push(next.href);
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && m === 'POST')) { m = 'GET'; b = null; delete h['content-type']; }
    if (!sameOrigin) { h = { ...h }; delete h.authorization; delete h.cookie; }
    current = next.href;
  }
}

// ─── TCP ────────────────────────────────────────

/**
 * Open a TCP connection to an address the caller has checked already.
 * @returns {Promise<net.Socket>} connected socket
 */
function tcpConnect({ address, family, port }, { timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: address, port, family });
    const timer = setTimeout(() => { sock.destroy(); reject(Object.assign(new Error('connect timeout'), { code: 'ERR_TIMEOUT' })); }, timeoutMs);
    sock.once('connect', () => { clearTimeout(timer); resolve(sock); });
    sock.once('error', (e) => { clearTimeout(timer); reject(Object.assign(new Error(e.message), { code: 'ERR_NET' })); });
  });
}

// ─── UDP discovery ──────────────────────────────

function ipv4ToInt(s) { return s.split('.').reduce((acc, o) => ((acc << 8) >>> 0) + Number(o), 0) >>> 0; }
function intToIpv4(n) { return [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.'); }

/** Subnet-directed broadcast addresses of the LAN interfaces (no Docker/WireGuard/loopback). */
function lanBroadcasts() {
  const out = new Set();
  let wgIf = 'wg0';
  try { wgIf = require('../../../config/default').wireguard.interface || wgIf; } catch { /* default */ }
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    if (VIRTUAL_IF.test(name) || name === wgIf) continue;
    for (const ni of ifs[name] || []) {
      if (ni.internal || (ni.family !== 'IPv4' && ni.family !== 4)) continue;
      if (classify(ni.address) !== 'private') continue;
      const a = ipv4ToInt(ni.address);
      const m = ipv4ToInt(ni.netmask);
      out.add(intToIpv4(((a & m) | (~m >>> 0)) >>> 0));
    }
  }
  return [...out];
}

/**
 * Send a datagram (broadcast in the server's local networks, or to `targets`)
 * on allowed ports and collect the answers.
 * @param {Array<[number,number]>} allowedPorts
 * @param {{ports:number[], data:Buffer, timeoutMs?:number, maxResponses?:number, repeat?:number}} o
 * @returns {Promise<Array<{address:string, port:number, data:Buffer}>>}
 */
function udpExchange(allowedPorts, { ports, data, timeoutMs = 3000, maxResponses = 64, repeat = 1, targets, acceptFrom } = {}) {
  if (!Array.isArray(ports) || !ports.length || ports.length > 8 || !ports.every((p) => Number.isInteger(p) && inRanges(allowedPorts, p))) {
    return Promise.reject(Object.assign(new Error('UDP port not allowed by the plugin policy'), { code: 'ERR_NET_DENIED', reason: 'udp_port' }));
  }
  const dests = targets || ['255.255.255.255', ...lanBroadcasts()];
  const accept = acceptFrom || ((ip) => classify(ip) === 'private' && !isHostReserved(ip));
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    const found = [];
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try { sock.close(); } catch { /* closed */ }
      resolve(found);
    };
    sock.on('message', (msg, rinfo) => {
      if (!accept(rinfo.address)) return; // answers from the local network only
      if (found.length < maxResponses) found.push({ address: rinfo.address, port: rinfo.port, data: Buffer.from(msg) });
      if (found.length >= maxResponses) finish();
    });
    sock.on('error', finish);
    sock.bind(() => {
      try { sock.setBroadcast(true); } catch { /* ignore */ }
      for (const d of new Set(dests)) for (const p of ports) for (let i = 0; i < Math.max(1, Math.min(3, repeat)); i++) sock.send(data, p, d, () => {});
    });
    setTimeout(finish, Math.max(200, Math.min(10000, timeoutMs))).unref();
  });
}

/** Human summary for the install dialog / permissions tab. */
function describe(perms, lang) {
  const n = (perms && perms.network) || {};
  const internet = (Array.isArray(n) ? n : n.internet || []).map((x) => String(x));
  const loc = (t) => (t && typeof t === 'object' ? (lang === 'en' ? t.en : t.de) || t.de || t.en : String(t || ''));
  return {
    internet,
    homeTargets: (n.homeTargets || []).map((t) => ({ id: t.id, label: loc(t.label), protocols: t.protocols, multiple: !!t.multiple })),
    discovery: n.localDiscovery ? { udp: n.localDiscovery.udp } : null,
  };
}

/** Test seam: { '127.0.0.1': 'private'|'public' } */
function _setTestPrivateForTest(map) {
  if (process.env.NODE_ENV !== 'test') return;
  if (!map) { testPrivate = null; return; }
  testPrivate = new Map(Array.isArray(map) ? map.map((ip) => [ip, 'private']) : Object.entries(map));
}

function _setReservedForTest(nets) {
  if (process.env.NODE_ENV === 'test') reservedOverride = nets ? nets.map((s) => parseNet(s)) : null;
}

module.exports = {
  parseEntry, parseList, parsePorts, compile, classify, isHostReserved, checkInternet, checkTarget, inRanges, toAddr, isIpLiteral,
  pinnedRequest, fetchWithPolicy, tcpConnect, udpExchange, lanBroadcasts, hostReserved, describe, cleanHeaders, lookupAll,
  _setReservedForTest, _setTestPrivateForTest,
};
