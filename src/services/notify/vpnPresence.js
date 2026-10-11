'use strict';

/**
 * "Push only through the VPN" (allow_direct = false) for devices whose VPN
 * does not route the server's public address — a split tunnel that carries
 * only the VPN subnet and a few networks. Such a device reaches the push
 * endpoint over the internet even while its tunnel is up, so the request's
 * source address is a public one and viaOf() says "direct".
 *
 * Such a request still counts as VPN-backed when it comes from the public
 * address the token's own peer is connected from right now: the endpoint of
 * a WireGuard handshake that is still fresh. The stream is remembered as
 * VPN-gated (conn.vpnPeerId) and closed again as soon as that peer goes
 * offline or is disabled; the device's reconnect then gets
 * 403 direct_not_allowed as before.
 */

const ipaddr = require('ipaddr.js');
const eventBus = require('../eventBus');
const stream = require('./stream');
const logger = require('../../utils/logger');

const REASON = 'vpn_down';

function normalize(ip) {
  try {
    let addr = ipaddr.parse(String(ip || ''));
    if (addr.kind() === 'ipv6' && addr.isIPv4MappedAddress()) addr = addr.toIPv4Address();
    return addr.toNormalizedString();
  } catch { return null; }
}

/** Host part of a `wg show` endpoint: "1.2.3.4:51820" or "[2001:db8::1]:51820". */
function endpointHost(endpoint) {
  const s = String(endpoint || '');
  const m = /^\[([^\]]+)\]:\d{1,5}$/.exec(s) || /^([^:]+):\d{1,5}$/.exec(s);
  return m ? m[1] : null;
}

/**
 * True when the peer `peerId` is enabled, has a fresh handshake and its
 * current WireGuard endpoint is the address `ip` the request came from.
 */
async function connectedFrom(peerId, ip) {
  if (peerId == null) return false;
  const want = normalize(ip);
  if (!want) return false;
  try {
    const peer = require('../peers').getById(peerId);
    if (!peer || !peer.public_key || peer.enabled !== 1) return false;
    const status = await require('../wireguard').getStatus();
    if (!status || !status.running) return false;
    const wg = status.peers.find((p) => p.publicKey === peer.public_key);
    if (!wg || !wg.isOnline || !wg.endpoint) return false;
    return normalize(endpointHost(wg.endpoint)) === want;
  } catch (err) {
    logger.debug({ err: err.message, peerId }, 'push: VPN presence check failed');
    return false;
  }
}

/** Close the VPN-gated streams of these peers (their VPN went down or they were disabled). */
function drop(peerIds) {
  const set = new Set((peerIds || []).filter((id) => id != null).map(Number));
  if (!set.size) return;
  stream.closeAll((c) => c.vpnPeerId != null && set.has(Number(c.vpnPeerId)), REASON);
}

function onPeerEvent(evt) {
  const p = (evt && evt.payload) || {};
  if (p.connected === false && p.peerId != null) drop([p.peerId]);
}

let installed = false;
/** Follow peer connect/disconnect (peerStatus poller). Idempotent. */
function install() {
  if (installed) return;
  installed = true;
  eventBus.subscribe(onPeerEvent, (type) => type === 'peer');
}

module.exports = { connectedFrom, drop, install, endpointHost, REASON };
