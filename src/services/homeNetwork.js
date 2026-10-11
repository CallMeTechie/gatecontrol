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
 * same_lan: see sameLan().
 */

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

/**
 * Home-network answer for a request from `ip` made with the token of peer
 * `peerId`: { lan, same_lan, via }.
 *
 * same_lan is true only for
 *  (a) a direct request whose source is inside an included LAN subnet
 *      (also hairpin NAT: the phone's or the router's LAN address), or
 *  (b) a request through the tunnel — source inside the WireGuard subnet and
 *      one of the token peer's own tunnel addresses — while that peer is
 *      enabled, online (fresh handshake) and its current WireGuard endpoint
 *      lies inside an included LAN subnet.
 * Exclusions apply to both: WG subnet, the server's own addresses, excluded
 * interfaces. Any error → false.
 */
async function check(ip, peerId) {
  const lan = lanEntries();
  const out = { lan: lan.entries.map((e) => e.address), same_lan: false, via: 'direct' };
  const v4 = toV4(ip);
  if (v4 && inWgSubnet(v4)) {
    out.via = 'tunnel';
    if (!lan.entries.length || peerId == null) return out;
    try {
      const peer = require('./peers').getById(peerId);
      if (!peer || !fromPeerAddress(peer, v4)) return out;
      const endpoint = await require('./notify/vpnPresence').currentEndpoint(peerId);
      out.same_lan = endpoint != null && inLan(endpoint, lan);
    } catch (err) {
      logger.debug({ err: err.message, peerId }, 'home network: tunnel check failed');
      out.same_lan = false;
    }
    return out;
  }
  out.same_lan = inLan(ip, lan);
  return out;
}

module.exports = { check, lanEntries, EXCLUDED_IFACE_PREFIXES, MAX_LAN, _setInterfacesForTest };
