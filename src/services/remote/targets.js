'use strict';

// Targets of gc.remote (docs/plugins.md "Remote access"): where a session,
// a probe or a wake-up goes. The plugin owns its devices and names the
// target in every call; the core checks the address and resolves it:
//
//   { id, name?, host, port }                      direct (VPN address of a device, LAN of the server, …)
//   { id, name?, listener: '<key>' }               through an L4 listener of this plugin (gc.remote.listener):
//                                                  guacd connects to the hub address and the listen port, the
//                                                  gateway passes it on into its home network — as old
//                                                  gateway-mode RDP routes do (services/guacTarget.js)
//   + gateway: { peerId }                          the home gateway of a direct LAN target (probe / wake through it)
//   + mac: 'AA:BB:CC:DD:EE:FF'                     for wake()
//
// Never reachable: loopback, link-local, unspecified, multicast, broadcast
// and reserved addresses, the hub address itself (only through a listener of
// this plugin). A host name is resolved by the core and every address checked;
// guacd gets the checked address, not the name (no rebinding in between).

const dns = require('node:dns');
const net = require('node:net');
const ipaddr = require('ipaddr.js');
const config = require('../../../config/default');

class TargetError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const KEY_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const HOST_RE = /^[A-Za-z0-9.-]{1,253}$/;
const MAC_RE = /^([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})$/;
const BLOCKED_RANGES = new Set(['loopback', 'linkLocal', 'unspecified', 'multicast', 'broadcast', 'reserved']);

function db() { return require('../../db/connection').getDb(); }

function hubIp() { return (config.wireguard && config.wireguard.gatewayIp) || '10.8.0.1'; }

function portOf(v, what = 'port') {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new TargetError('invalid', `${what}: 1…65535`);
  return n;
}

/** Is a literal address one a plugin may aim at? */
function addressAllowed(ip) {
  let a;
  try { a = ipaddr.process(ip); } catch { return false; }
  if (BLOCKED_RANGES.has(a.range())) return false;
  if (a.toString() === hubIp()) return false;
  return true;
}

let lookupFn = null; // test seam
async function resolveHost(host) {
  if (typeof host !== 'string' || !host.trim()) throw new TargetError('invalid', 'host required');
  const h = host.trim();
  if (net.isIP(h)) {
    if (!addressAllowed(h)) throw new TargetError('not_allowed', 'this address may not be used as a remote target');
    return h;
  }
  if (!HOST_RE.test(h)) throw new TargetError('invalid', 'invalid host');
  let list;
  try {
    list = await (lookupFn || ((n) => dns.promises.lookup(n, { all: true, verbatim: true })))(h);
  } catch {
    throw new TargetError('unreachable', 'the host name does not resolve');
  }
  if (!Array.isArray(list) || !list.length) throw new TargetError('unreachable', 'the host name does not resolve');
  for (const r of list) if (!addressAllowed(r.address)) throw new TargetError('not_allowed', 'this host name points to an address that may not be used');
  return list[0].address;
}

/** The checked shape of a target (no lookups yet). */
function normalise(t) {
  if (!t || typeof t !== 'object' || Array.isArray(t)) throw new TargetError('invalid', 'target required');
  const id = t.id == null ? null : String(t.id);
  if (!id || !ID_RE.test(id)) throw new TargetError('invalid', 'target.id: 1…64 of A-Z a-z 0-9 . _ : -');
  const out = { id, name: t.name == null ? null : String(t.name).slice(0, 120) };
  if (t.listener != null) {
    if (typeof t.listener !== 'string' || !KEY_RE.test(t.listener)) throw new TargetError('invalid', 'target.listener: a listener key');
    out.listener = t.listener;
  } else {
    if (typeof t.host !== 'string' || !t.host.trim() || t.host.length > 253) throw new TargetError('invalid', 'target.host required');
    out.host = t.host.trim();
    out.port = portOf(t.port, 'target.port');
  }
  if (t.gateway != null) {
    const pid = Number(t.gateway && t.gateway.peerId);
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new TargetError('invalid', 'target.gateway.peerId');
    out.gatewayPeerId = pid;
  }
  if (t.mac != null) {
    if (typeof t.mac !== 'string' || !MAC_RE.test(t.mac.trim())) throw new TargetError('invalid', 'target.mac: AA:BB:CC:DD:EE:FF');
    out.mac = t.mac.trim();
  }
  return out;
}

// ─── Listeners (L4 through a gateway) ────────────

function listenerRow(pluginId, key) {
  const row = db().prepare('SELECT * FROM remote_listeners WHERE plugin_id = ? AND key = ?').get(pluginId, key);
  if (!row) return null;
  const route = db().prepare('SELECT * FROM routes WHERE id = ?').get(row.route_id);
  return route ? { row, route } : null;
}

function listenerView(key, row, route) {
  return {
    key,
    routeId: route.id,
    listenPort: Number(route.l4_listen_port),
    gateway: route.target_peer_id ? { peerId: route.target_peer_id } : (route.target_pool_id ? { poolId: route.target_pool_id } : null),
    lanHost: route.target_lan_host,
    lanPort: route.target_lan_port,
    enabled: route.enabled === 1,
    shared: row.shared === 1,
  };
}

/**
 * gc.remote.listener({ key, gateway: { peerId } | { poolId }, host, port, listenPort? })
 * An L4 port on the server that the gateway passes on to host:port in its home network. An existing
 * L4 route with exactly this target and port (an old gateway-mode RDP route) is reused (shared).
 */
async function listener(plugin, a) {
  const o = a && typeof a === 'object' ? a : {};
  if (typeof o.key !== 'string' || !KEY_RE.test(o.key)) throw new TargetError('invalid', 'key: a-z 0-9 . _ - (≤ 64)');
  const g = o.gateway && typeof o.gateway === 'object' ? o.gateway : {};
  const peerId = g.peerId == null ? null : Number(g.peerId);
  const poolId = g.poolId == null ? null : Number(g.poolId);
  if (!((Number.isSafeInteger(peerId) && peerId > 0) || (Number.isSafeInteger(poolId) && poolId > 0))) throw new TargetError('invalid', 'gateway: { peerId } or { poolId }');
  if (typeof o.host !== 'string' || !o.host.trim() || o.host.length > 253) throw new TargetError('invalid', 'host required');
  const host = o.host.trim();
  const port = portOf(o.port);
  const listenPort = o.listenPort == null ? port : portOf(o.listenPort, 'listenPort');
  if (peerId && !require('../gatewayFeatures').gatewayPeer(peerId)) throw new TargetError('not_found', 'gateway not found');

  const existing = listenerRow(plugin.id, o.key);
  const same = (r) => r.route_type === 'l4' && r.target_kind === 'gateway' && r.target_lan_host === host && Number(r.target_lan_port) === port
    && String(r.l4_listen_port) === String(listenPort) && (peerId ? r.target_peer_id === peerId : r.target_pool_id === poolId);
  if (existing && same(existing.route)) return listenerView(o.key, existing.row, existing.route);

  // an L4 route already passing exactly this on (e.g. the one of an old gateway-mode RDP route): reuse it
  const shared = db().prepare("SELECT * FROM routes WHERE route_type = 'l4' AND target_kind = 'gateway' AND l4_listen_port = ?").all(String(listenPort)).find(same);
  if (existing && existing.row.shared !== 1) await removeRoute(existing.route.id);
  if (shared) {
    db().prepare(`INSERT INTO remote_listeners (plugin_id, key, route_id, shared) VALUES (?, ?, ?, 1)
      ON CONFLICT(plugin_id, key) DO UPDATE SET route_id = excluded.route_id, shared = 1`).run(plugin.id, o.key, shared.id);
    return listenerView(o.key, { shared: 1 }, shared);
  }
  try {
    require('../l4').assertListenPortFree(listenPort, { protocol: 'tcp', code: 'GATEWAY_PORT_CONFLICT' });
  } catch (e) {
    const err = new TargetError('port_in_use', e.message);
    err.suggestedPort = e.conflict ? e.conflict.suggestedPort || null : null;
    throw err;
  }
  let created;
  try {
    created = await require('../routes').create({
      domain: null,
      route_type: 'l4',
      target_kind: 'gateway',
      target_peer_id: peerId || null,
      target_pool_id: peerId ? null : poolId,
      target_lan_host: host,
      target_lan_port: port,
      l4_protocol: 'tcp',
      l4_listen_port: String(listenPort),
      l4_tls_mode: 'none',
      target_port: listenPort,
      enabled: true,
      description: `auto-created for plugin "${plugin.id}" (${o.key})`,
    });
  } catch (e) {
    throw new TargetError('listener_failed', String((e && e.message) || e).slice(0, 200));
  }
  db().prepare(`INSERT INTO remote_listeners (plugin_id, key, route_id, shared) VALUES (?, ?, ?, 0)
    ON CONFLICT(plugin_id, key) DO UPDATE SET route_id = excluded.route_id, shared = 0`).run(plugin.id, o.key, created.id);
  return listenerView(o.key, { shared: 0 }, db().prepare('SELECT * FROM routes WHERE id = ?').get(created.id));
}

async function removeRoute(routeId) {
  try { await require('../routes').remove(routeId); } catch { /* gone already */ }
}

/** gc.remote.listener.remove(key) → { removed } — a shared route stays (it is not the plugin's). */
async function removeListener(plugin, key) {
  if (typeof key !== 'string' || !KEY_RE.test(key)) throw new TargetError('invalid', 'invalid key');
  const l = listenerRow(plugin.id, key);
  const row = l ? l.row : db().prepare('SELECT * FROM remote_listeners WHERE plugin_id = ? AND key = ?').get(plugin.id, key);
  if (!row) return { removed: false };
  if (l && row.shared !== 1) await removeRoute(l.route.id);
  db().prepare('DELETE FROM remote_listeners WHERE plugin_id = ? AND key = ?').run(plugin.id, key);
  return { removed: true };
}

/** gc.remote.listeners() → [listener] */
function listeners(plugin) {
  return db().prepare('SELECT * FROM remote_listeners WHERE plugin_id = ? ORDER BY key').all(plugin.id).map((row) => {
    const route = db().prepare('SELECT * FROM routes WHERE id = ?').get(row.route_id);
    return route ? listenerView(row.key, row, route) : null;
  }).filter(Boolean);
}

/** A plugin goes: its own listener routes go with it (shared ones stay). */
async function removeAllListeners(pluginId) {
  let rows = [];
  try { rows = db().prepare('SELECT * FROM remote_listeners WHERE plugin_id = ?').all(pluginId); } catch { return; }
  for (const r of rows) if (r.shared !== 1) await removeRoute(r.route_id);
  db().prepare('DELETE FROM remote_listeners WHERE plugin_id = ?').run(pluginId);
}

// ─── Resolution ──────────────────────────────────

/**
 * Where guacd connects for a normalised target → { host, port, gatewayPeerId, lanHost, lanPort, listener }.
 * Throws TargetError (not_found: unknown listener, listener_off: its route is switched off).
 */
async function endpoint(plugin, t) {
  if (t.listener) {
    const l = listenerRow(plugin.id, t.listener);
    if (!l) throw new TargetError('not_found', 'no such listener of this plugin');
    if (l.route.enabled !== 1) throw new TargetError('listener_off', 'the listener is switched off');
    return { host: hubIp(), port: Number(l.route.l4_listen_port), gatewayPeerId: l.route.target_peer_id || null,
      lanHost: l.route.target_lan_host, lanPort: Number(l.route.target_lan_port), listener: t.listener };
  }
  if (t.gatewayPeerId) {
    // a LAN target of a gateway without a listener: guacd cannot reach it, only probe / wake go through the gateway
    return { host: null, port: t.port, gatewayPeerId: t.gatewayPeerId, lanHost: t.host, lanPort: t.port, listener: null };
  }
  return { host: await resolveHost(t.host), port: t.port, gatewayPeerId: null, lanHost: null, lanPort: null, listener: null };
}

/** gc.remote.probe(target) → { online, responseTime, via: 'direct' | 'gateway' } */
async function probe(plugin, target) {
  const t = normalise(target);
  const ep = await endpoint(plugin, t);
  const monitor = require('../rdpMonitor');
  if (ep.gatewayPeerId && ep.lanHost) {
    if (!require('../gatewayFeatures').gatewayPeer(ep.gatewayPeerId)) throw new TargetError('not_found', 'gateway not found');
    let resp = null;
    try { resp = await require('../gateways').probeGatewayTarget(ep.gatewayPeerId, ep.lanHost, ep.lanPort); } catch { resp = null; }
    if (resp && resp.probed_target) return { online: !!resp.probe_result, responseTime: resp.probe_latency_ms ?? null, via: 'gateway' };
    if (ep.listener) {
      const r = await monitor.checkTcp('127.0.0.1', ep.port);
      return { online: r.online, responseTime: r.responseTime, via: 'gateway' };
    }
    return { online: false, responseTime: null, via: 'gateway' };
  }
  const r = await monitor.checkTcp(ep.host, ep.port);
  return { online: r.online, responseTime: r.responseTime, via: 'direct' };
}

const wakeLast = new Map(); // plugin:mac → ms
const WAKE_GAP_MS = 10000;

/** gc.remote.wake(target) — target.mac required → { sent: true, via: 'gateway' | 'server' } */
async function wake(plugin, target) {
  const t = normalise(target);
  if (!t.mac) throw new TargetError('invalid', 'target.mac required');
  const k = plugin.id + ':' + t.mac.toLowerCase();
  const now = Date.now();
  if (now - (wakeLast.get(k) || 0) < WAKE_GAP_MS) throw new TargetError('rate_limited', 'wake-up sent a moment ago');
  wakeLast.set(k, now);
  let peerId = t.gatewayPeerId || null;
  let lanHost = t.host || null;
  if (t.listener) {
    const l = listenerRow(plugin.id, t.listener);
    if (!l) throw new TargetError('not_found', 'no such listener of this plugin');
    peerId = l.route.target_peer_id || null;
    lanHost = l.route.target_lan_host;
  }
  if (peerId) {
    if (!require('../gatewayFeatures').gatewayPeer(peerId)) throw new TargetError('not_found', 'gateway not found');
    try { await require('../gateways').notifyWol(peerId, { mac: t.mac, lan_host: lanHost }); } catch (e) { throw new TargetError('wake_failed', String((e && e.message) || e).slice(0, 200)); }
    return { sent: true, via: 'gateway' };
  }
  try { await require('../wol').sendMagicPacket(t.mac); } catch (e) { throw new TargetError('wake_failed', String((e && e.message) || e).slice(0, 200)); }
  return { sent: true, via: 'server' };
}

function _setLookupForTest(fn) { if (process.env.NODE_ENV === 'test') lookupFn = fn; }
function _resetForTest() { if (process.env.NODE_ENV === 'test') { wakeLast.clear(); lookupFn = null; } }

module.exports = {
  TargetError, normalise, endpoint, resolveHost, addressAllowed, listener, removeListener, listeners, removeAllListeners, probe, wake, hubIp,
  _setLookupForTest, _resetForTest,
};
