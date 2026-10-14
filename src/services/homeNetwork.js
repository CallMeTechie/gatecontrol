// src/services/homeNetwork.js
'use strict';

/**
 * "Is this device in the server's own home LAN?" — the location-free mode of
 * the apps' trusted-network detection (GET /api/v1/client/home-network). A
 * wrong "yes" switches the VPN off in a foreign network, so every rule here
 * errs towards "no".
 *
 * lan:   the server's private IPv4 addresses (RFC 1918 only) on up,
 *        non-internal interfaces — not the WireGuard interface, nothing
 *        inside the WireGuard subnet, no container/virtual bridges.
 *        os.networkInterfaces() (libuv) lists only interfaces that are UP and
 *        RUNNING; the server runs with network_mode: host, so these are the
 *        host's real interfaces.
 * same_lan: see check().
 */

const fs = require('node:fs');
const os = require('node:os');
const ipaddr = require('ipaddr.js');
const config = require('../../config/default');
const logger = require('../utils/logger');

// Interface-name prefixes that are never "the home LAN": container and VM
// bridges/veths (docker0, br-<id>, veth*, virbr*, lxc*/lxd*, podman*), CNI /
// Kubernetes overlays (cni*, flannel*, cali*, vxlan*) and other VPN/tunnel
// devices (tailscale*, zt* = ZeroTier, tun*, tap*, wg*). Matched
// case-insensitively against the start of the name. The configured WireGuard
// interface is excluded separately (it may be named anything).
const EXCLUDED_IFACE_PREFIXES = Object.freeze([
  'docker', 'br-', 'veth', 'virbr', 'cni', 'flannel', 'cali', 'vxlan',
  'lxc', 'lxd', 'podman', 'tailscale', 'zt', 'tun', 'tap', 'wg',
]);

const MAX_LAN = 8;

// Injectable seam for the interface scan (os.networkInterfaces()), like
// services/domains.js.
let _interfaces = () => os.networkInterfaces();
function _setInterfacesForTest(fn) {
  if (process.env.NODE_ENV === 'test') _interfaces = fn || (() => os.networkInterfaces());
}

// Injectable seam for the kernel's IPv4 routing table (default gateways).
// network_mode: host → this is the host's real table.
const ROUTE_TABLE = '/proc/net/route';
let _routeTable = () => fs.readFileSync(ROUTE_TABLE, 'utf8');
function _setRouteTableForTest(fn) {
  if (process.env.NODE_ENV === 'test') _routeTable = fn || (() => fs.readFileSync(ROUTE_TABLE, 'utf8'));
}

/** "0101A8C0" (little-endian hex, /proc/net/route) → "192.168.1.1"; null when malformed. */
function hexToV4(hex) {
  if (!/^[0-9A-Fa-f]{8}$/.test(String(hex))) return null;
  const n = parseInt(hex, 16);
  return [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255].join('.');
}

/**
 * IPv4 default gateways of the host: every route with destination 0.0.0.0
 * and a gateway set (any interface, any metric, any flags — more exclusions
 * are the safe side). Returns a Set of dotted addresses, or null when the
 * table cannot be read or parsed: the caller then fails closed.
 */
function defaultGateways() {
  let text;
  try { text = String(_routeTable() || ''); }
  catch (err) { logger.debug({ err: err.message }, 'home network: route table unreadable'); return null; }
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return null;
  const head = lines[0].split(/\s+/);
  const iDst = head.indexOf('Destination');
  const iGw = head.indexOf('Gateway');
  if (iDst < 0 || iGw < 0) return null;
  const out = new Set();
  for (const line of lines.slice(1)) {
    const cols = line.split(/\s+/);
    if (cols.length <= Math.max(iDst, iGw)) return null;
    if (cols.at(iDst) !== '00000000') continue;
    const gw = hexToV4(cols.at(iGw));
    if (gw == null) return null;
    if (gw !== '0.0.0.0') out.add(gw);
  }
  return out;
}

/** ipaddr IPv4 of `ip` (IPv4-mapped IPv6 unwrapped), else null. */
function toV4(ip) {
  try {
    let a = ipaddr.parse(String(ip == null ? '' : ip).trim());
    if (a.kind() === 'ipv6' && a.isIPv4MappedAddress()) a = a.toIPv4Address();
    return a.kind() === 'ipv4' ? a : null;
  } catch { return null; }
}

function wgSubnet() {
  try {
    const [net, bits] = ipaddr.parseCIDR(config.wireguard.subnet);
    return net.kind() === 'ipv4' ? [net, bits] : null;
  } catch { return null; }
}

function inWgSubnet(v4) {
  const wg = wgSubnet();
  return !!(wg && v4.match(wg[0], wg[1]));
}

/**
 * 'tunnel' when a request from `ip` came through the WireGuard tunnel (source
 * inside the WireGuard subnet, IPv4-mapped IPv6 unwrapped), else 'direct'.
 * Also used by the speed test (GET /api/v1/client/speedtest → viaTunnel).
 */
function viaOf(ip) {
  const v4 = toV4(ip);
  return v4 && inWgSubnet(v4) ? 'tunnel' : 'direct';
}

function isExcludedIface(name) {
  const n = String(name || '').toLowerCase();
  if (!n) return true;
  if (n === String(config.wireguard.interface || '').toLowerCase()) return true;
  return EXCLUDED_IFACE_PREFIXES.some((p) => n.startsWith(p));
}

/** Prefix length of an interface entry (cidr, else netmask); null when unusable. */
function prefixOf(entry) {
  const m = /\/(\d{1,2})$/.exec(String(entry.cidr || ''));
  if (m) { const n = Number(m[1]); return n >= 0 && n <= 32 ? n : null; }
  try { return ipaddr.IPv4.parse(String(entry.netmask)).prefixLengthFromSubnetMask(); }
  catch { return null; }
}

function scan() {
  try { return _interfaces() || {}; }
  catch (err) { logger.debug({ err: err.message }, 'home network: interface scan failed'); return {}; }
}

/**
 * Included LAN entries { address, prefix, iface }: RFC 1918 IPv4 on
 * non-excluded interfaces, deduplicated by address, max 8, ordered by
 * interface name then address. Also returns every own address (all
 * interfaces, all families) for the "not the server itself" check.
 */
function lanEntries() {
  const ifaces = scan();
  const own = new Set();
  const cands = [];
  for (const [name, list] of Object.entries(ifaces)) {
    for (const e of Array.isArray(list) ? list : []) {
      if (!e) continue;
      const v4 = toV4(e.address);
      if (v4) own.add(v4.toString());
      else if (e.address) own.add(String(e.address).toLowerCase());
      if (e.internal || isExcludedIface(name)) continue;
      if (e.family !== 'IPv4' && e.family !== 4) continue;
      if (!v4 || v4.range() !== 'private' || inWgSubnet(v4)) continue;
      const prefix = prefixOf(e);
      if (prefix == null || prefix < 8) continue; // wider than any RFC 1918 block: misconfigured
      cands.push({ name, v4, prefix });
    }
  }
  cands.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    || Buffer.compare(Buffer.from(a.v4.toByteArray()), Buffer.from(b.v4.toByteArray())));
  const seen = new Set();
  const entries = [];
  for (const c of cands) {
    const address = c.v4.toString();
    if (seen.has(address)) continue;
    seen.add(address);
    entries.push({ address, prefix: c.prefix, iface: c.name, v4: c.v4 });
    if (entries.length >= MAX_LAN) break;
  }
  return { entries, own };
}

/** True when `ip` is an RFC 1918 IPv4 in one of the included subnets, outside the WG subnet, not the server itself. */
function inLan(ip, lan) {
  const v4 = toV4(ip);
  if (!v4 || v4.range() !== 'private' || inWgSubnet(v4)) return false;
  if (lan.own.has(v4.toString())) return false;
  return lan.entries.some((e) => v4.match(e.v4, e.prefix));
}

/** Does `ip` lie inside one of the peer's allowed_ips (e.g. "10.8.0.5/32")? */
function fromPeerAddress(peer, v4) {
  for (const part of String((peer && peer.allowed_ips) || '').split(',')) {
    try {
      const s = part.trim();
      if (!s) continue;
      const [net, bits] = s.includes('/') ? ipaddr.parseCIDR(s) : [ipaddr.parse(s), 32];
      if (net.kind() === 'ipv4' && v4.match(net, bits)) return true;
    } catch { /* ignore malformed entry */ }
  }
  return false;
}

// ─── Gateway sites ───────────────────────────────────────────────────────
//
// Typical setup: the server runs on a VPS, the home LAN is reached through a
// GateControl gateway peer (e.g. a NAS) that reports its LAN subnets. The
// device is "at the site of gateway G" when it shares G's public address
// AND one of its own private addresses lies in a LAN subnet G reports.

const MAX_LOCAL = 4;
const MAX_LOCAL_QUERY = 128; // 4 × "255.255.255.255" + separators, with room
const MAX_GATEWAY_SUBNETS = 16;
const SITE_HANDSHAKE_MAX_AGE_S = 180;

/**
 * `local` query value → up to 4 distinct ipaddr IPv4 objects: the device's
 * own addresses on its Wi-Fi/Ethernet interfaces. Only a single string is
 * accepted (a repeated parameter is ignored as a whole); only the first four
 * comma-separated entries are looked at; each must be a strict dotted-quad
 * RFC 1918 address outside the WireGuard subnet — everything else is
 * dropped.
 */
function parseLocal(raw) {
  if (typeof raw !== 'string' || !raw || raw.length > MAX_LOCAL_QUERY) return [];
  const out = [];
  const seen = new Set();
  for (const part of raw.split(',').slice(0, MAX_LOCAL)) {
    const s = part.trim();
    if (!ipaddr.IPv4.isValidFourPartDecimal(s)) continue;
    const a = ipaddr.IPv4.parse(s);
    if (a.range() !== 'private' || inWgSubnet(a)) continue;
    const key = a.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  return out;
}

/**
 * A device's or gateway's public address: only globally routable unicast
 * (IPv4-mapped IPv6 unwrapped). Private, CGNAT (100.64/10), loopback,
 * link-local, ULA, documentation/reserved, 6to4/Teredo/NAT64 → null. A
 * private "public" address means a LAN reverse proxy or an SNAT-ing router
 * stands in between — then every remote client shares it.
 */
function publicAddr(ip) {
  try {
    let a = ipaddr.parse(String(ip == null ? '' : ip).trim());
    if (a.kind() === 'ipv6' && a.isIPv4MappedAddress()) a = a.toIPv4Address();
    return a.range() === 'unicast' ? a : null;
  } catch { return null; }
}

/** Same public address: IPv4 exact, IPv6 same /64, mixed families never. */
function samePublic(a, b) {
  if (!a || !b || a.kind() !== b.kind()) return false;
  if (a.kind() === 'ipv4') return a.toString() === b.toString();
  return a.match(b, 64);
}

/**
 * A gateway-reported LAN subnet as [network, bits], or null unless it is an
 * IPv4 CIDR lying entirely inside one RFC 1918 block (first and last address
 * private: 10.0.0.0/7, 172.0.0.0/8, 0.0.0.0/0 … are rejected) and not
 * overlapping the WireGuard subnet.
 */
function siteSubnet(cidr) {
  try {
    const s = String(cidr == null ? '' : cidr).trim();
    if (!s.includes('/')) return null;
    const [net, bits] = ipaddr.parseCIDR(s);
    if (net.kind() !== 'ipv4' || bits < 8 || bits > 32) return null;
    const first = ipaddr.IPv4.networkAddressFromCIDR(s);
    const last = ipaddr.IPv4.broadcastAddressFromCIDR(s);
    if (first.range() !== 'private' || last.range() !== 'private') return null;
    const wg = wgSubnet();
    if (wg && (first.match(wg[0], wg[1]) || wg[0].match(first, bits))) return null;
    return [first, bits];
  } catch { return null; }
}

/** LAN subnets a gateway reported in its last heartbeat (telemetry.lan_subnets[].cidr). */
function gatewaySubnets(lastHealth) {
  let list;
  try { list = JSON.parse(lastHealth || '{}').telemetry.lan_subnets; } catch { return []; }
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const e of list.slice(0, MAX_GATEWAY_SUBNETS)) {
    const sub = siteSubnet(e && typeof e === 'object' ? e.cidr : null);
    if (sub) out.push(sub);
  }
  return out;
}

/**
 * The wg peer entry's current endpoint address as a public ipaddr object —
 * only with a known endpoint and a handshake that is both "online" by the
 * configured timeout and at most 3 minutes old. null otherwise.
 */
function freshEndpoint(wg) {
  if (!wg || !wg.isOnline || !wg.endpoint) return null;
  const hs = Number(wg.latestHandshake);
  if (!Number.isFinite(hs) || hs <= 0) return null;
  const age = Date.now() / 1000 - hs;
  if (age < -60 || age > SITE_HANDSHAKE_MAX_AGE_S) return null;
  return publicAddr(require('./notify/vpnPresence').endpointHost(wg.endpoint));
}

/** Enabled gateway peers with their reported LAN subnets, by id. */
function enabledGateways() {
  const { getDb } = require('../db/connection');
  return getDb().prepare(`
    SELECT p.id, p.name, p.public_key, gm.last_health
    FROM peers p JOIN gateway_meta gm ON gm.peer_id = p.id
    WHERE p.peer_type = 'gateway' AND p.enabled = 1
    ORDER BY p.id
  `).all();
}

/**
 * Gateway-site rule: { gatewayId, name } of the first (lowest id) gateway G
 * the device is at, else null. All must hold:
 *  1. G is an enabled gateway peer with a fresh handshake (≤ 3 min) and a
 *     known, public current endpoint (`wg show <iface> dump`);
 *  2. the device's public address equals G's endpoint (IPv4 exact, IPv6
 *     same /64, mixed families never). The device's public address is
 *     - through the tunnel: the current endpoint of the token's own peer
 *       (req.ip must be one of that peer's tunnel addresses, the peer
 *       enabled with a fresh handshake);
 *     - direct: req.ip (trust proxy 'loopback', i.e. Caddy's
 *       X-Forwarded-For only) — public addresses only;
 *  3. at least one `local` address lies in a LAN subnet G reports. Without
 *     `local` the rule never matches (CGNAT: two households behind one
 *     carrier address).
 */
async function gatewaySite(ip, peerId, local, own) {
  if (!local.length) return null;
  const gws = enabledGateways().filter((g) => g.public_key && Number(g.id) !== Number(peerId));
  if (!gws.length) return null;
  const status = await require('./wireguard').getStatus();
  if (!status || !status.running || !Array.isArray(status.peers)) return null;
  const byKey = new Map(status.peers.filter((p) => p && p.publicKey).map((p) => [p.publicKey, p]));

  let device;
  if (viaOf(ip) === 'tunnel') {
    if (peerId == null) return null;
    const peer = require('./peers').getById(peerId);
    if (!peer || peer.enabled !== 1 || !peer.public_key || !fromPeerAddress(peer, toV4(ip))) return null;
    device = freshEndpoint(byKey.get(peer.public_key));
  } else {
    device = publicAddr(ip);
  }
  if (!device || own.has(device.toString())) return null;

  for (const g of gws) {
    const ep = freshEndpoint(byKey.get(g.public_key));
    if (!ep || !samePublic(device, ep)) continue;
    const subnets = gatewaySubnets(g.last_health);
    if (local.some((a) => subnets.some(([net, bits]) => a.match(net, bits)))) {
      return { gatewayId: Number(g.id), name: String(g.name || '') };
    }
  }
  return null;
}

/**
 * Home-network answer for a request from `ip` made with the token of peer
 * `peerId`: { lan, same_lan, via, site }. `opts.local` is the raw `local`
 * query value (see parseLocal()).
 *
 * Two positive rules; site says which one matched (null = neither):
 *
 * site { type: 'server' } — the device is in the server's own LAN. Only for
 * a request through the tunnel — source inside the WireGuard subnet and one
 * of the token peer's own tunnel addresses (allowed_ips) — while that peer
 * is enabled and online (fresh handshake) and its current WireGuard endpoint
 *  - is an RFC 1918 IPv4 inside one of the included LAN subnets,
 *  - is not inside the WireGuard subnet and not one of the server's own
 *    addresses, and
 *  - is not a default gateway of the host (a router that SNATs inbound
 *    port-forwards makes every remote peer's endpoint look like its own LAN
 *    address). Route table unreadable → false (fail closed).
 * A direct request never matches this rule: a LAN reverse proxy in front of
 * GateControl, or a router that SNATs inbound forwards, makes internet
 * clients look like LAN sources.
 *
 * site { type: 'gateway', gatewayId, name } — the device is at the site of
 * a gateway peer: see gatewaySite(). Tunnel and direct requests.
 *
 * same_lan is true for either rule. Any error → false.
 */
async function check(ip, peerId, opts = {}) {
  const lan = lanEntries();
  const out = { lan: lan.entries.map((e) => e.address), same_lan: false, via: viaOf(ip), site: null };
  if (out.via === 'tunnel' && lan.entries.length && peerId != null) {
    try {
      const v4 = toV4(ip);
      const peer = require('./peers').getById(peerId);
      if (peer && fromPeerAddress(peer, v4)) {
        const endpoint = await require('./notify/vpnPresence').currentEndpoint(peerId);
        if (endpoint != null && inLan(endpoint, lan)) {
          const gateways = defaultGateways();
          const ep = toV4(endpoint);
          if (gateways != null && ep && !gateways.has(ep.toString())) {
            out.same_lan = true;
            out.site = { type: 'server' };
            return out;
          }
        }
      }
    } catch (err) {
      logger.debug({ err: err.message, peerId }, 'home network: tunnel check failed');
    }
  }
  try {
    const local = parseLocal(opts.local);
    const site = await gatewaySite(ip, peerId, local, lan.own);
    if (site) {
      out.same_lan = true;
      out.site = { type: 'gateway', gatewayId: site.gatewayId, name: site.name };
    }
    logger.debug({ peerId, via: out.via, localCount: local.length, gatewayId: site ? site.gatewayId : null },
      'home network: gateway site check');
  } catch (err) {
    logger.debug({ err: err.message, peerId }, 'home network: gateway site check failed');
    out.same_lan = false;
    out.site = null;
  }
  return out;
}

module.exports = {
  check, viaOf, lanEntries, defaultGateways, parseLocal, publicAddr, samePublic, siteSubnet,
  EXCLUDED_IFACE_PREFIXES, MAX_LAN, MAX_LOCAL, SITE_HANDSHAKE_MAX_AGE_S,
  _setInterfacesForTest, _setRouteTableForTest,
};
