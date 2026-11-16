'use strict';

// gc.remote version 7 — what „Gerät hinzufügen“ of the plugin „Fernzugriff“ offers to pick from
// (docs/plugins.md "Remote access", docs/feature-remote-access.md):
//
//   candidates({ user })   the VPN devices, the devices the network watch of each home gateway sees, the L4
//                          routes that look like SSH / RDP / VNC / Telnet — only for an enabled administrator
//                          whose request to this plugin is in flight (plugins/personContext.js), never a MAC,
//                          no owner, no presence. The core keeps nothing of it; the plugin must not store it.
//   scan(target, ports)    a handful of ports of one target at once: directly from the server (with a look at
//                          the greeting: SSH, VNC, Telnet) or through the gateway's /api/probe, one port each.
//
// The gateway needs nothing new: the watch already reports address, vendor and open ports (22, 23, 3389,
// 5900), /api/probe already checks one port of its own LAN.

const net = require('node:net');
const ipaddr = require('ipaddr.js');
const config = require('../../../config/default');
const targets = require('./targets');

const { TargetError } = targets;

// the ports of a remote desktop or a shell — the only ports of the watch a plugin gets to see
const REMOTE_PORTS = new Map([[22, 'ssh'], [2222, 'ssh'], [23, 'telnet'], [3389, 'rdp']]);
for (let p = 5900; p <= 5909; p++) REMOTE_PORTS.set(p, 'vnc');
const WATCH_PORTS = new Set([22, 23, 3389, 5900, 5901, 5902, 5903, 5904, 5905, 5906, 5907, 5908, 5909]);
const SCAN_MAX_PORTS = 8;
const SCAN_PARALLEL = 2;
const GREETING_MS = 1200;
const CONNECT_MS = 3000;

function db() { return require('../../db/connection').getDb(); }
function iso(ms) { const n = Number(ms); return Number.isFinite(n) && n > 0 ? new Date(n).toISOString() : null; }
function json(s) { try { return s ? JSON.parse(s) : null; } catch { return null; } }

/** The first IPv4 of allowed_ips → '10.8.0.30' | null */
function peerIp(allowed) {
  const ip = String(allowed || '').split(',')[0].split('/')[0].trim();
  return net.isIPv4(ip) ? ip : null;
}

/** A name to compare: lower case, without a domain, only a–z 0–9 and '-'. */
function nameKey(v) {
  const s = typeof v === 'string' ? v.trim().toLowerCase().split('.')[0] : '';
  const k = s.replace(/[^a-z0-9-]/g, '');
  return k.length >= 2 ? k : null;
}

/** The LAN subnets a gateway reported (telemetry lan_subnets) as checked CIDR strings. */
function subnetsOf(lastHealth) {
  const h = json(lastHealth);
  const list = h && h.telemetry && Array.isArray(h.telemetry.lan_subnets) ? h.telemetry.lan_subnets : [];
  const out = [];
  for (const x of list.slice(0, 16)) {
    const c = x && typeof x === 'object' ? x.cidr : x;
    if (typeof c !== 'string' || c.length > 43) continue;
    try {
      const [a, bits] = ipaddr.parseCIDR(c.trim());
      out.push(a.toString() + '/' + bits);
    } catch { /* not a CIDR */ }
  }
  return [...new Set(out)];
}

function remotePorts(v) {
  const list = json(v);
  if (!Array.isArray(list)) return null;
  return list.filter((p) => p && WATCH_PORTS.has(p.port))
    .map((p) => ({ port: p.port, service: typeof p.service === 'string' && /^[a-z0-9._/+ -]{1,32}$/i.test(p.service) ? p.service : null }));
}

function liveStates() {
  try { return require('../gatewayLiveState').all(); } catch { return new Map(); }
}

function poolsOf() {
  const out = new Map(); // peerId → { poolId, name }
  try {
    for (const r of db().prepare(`SELECT m.peer_id, p.id, p.name FROM gateway_pool_members m JOIN gateway_pools p ON p.id = m.pool_id
      WHERE p.enabled = 1 ORDER BY m.priority, p.id`).all()) if (!out.has(r.peer_id)) out.set(r.peer_id, { poolId: r.id, name: r.name });
  } catch { /* no pools */ }
  return out;
}

function watchOf(peerId) {
  let s = { enabled: false, portscan: false };
  try { s = require('../gatewayFeatures').get(peerId).netwatch || s; } catch { /* defaults */ }
  let at = null;
  try { at = (db().prepare('SELECT netwatch_scan_at FROM gateway_features WHERE peer_id = ?').get(peerId) || {}).netwatch_scan_at; } catch { at = null; }
  return { enabled: !!s.enabled, portscan: !!s.portscan, scannedAt: iso(at) };
}

function zone() {
  try { return require('../vpnNames').current().primary || null; } catch { return null; }
}

/** L4 routes that look like a remote desktop or a shell (not the plugin's own listeners). */
function routeCandidates(peerNames, gwNames, poolNames) {
  let own = new Set();
  try { own = new Set(db().prepare('SELECT route_id FROM remote_listeners').all().map((r) => r.route_id)); } catch { own = new Set(); }
  const out = [];
  const rows = db().prepare(`SELECT id, domain, description, target_kind, target_ip, target_port, peer_id, target_peer_id, target_pool_id,
    target_lan_host, target_lan_port, l4_listen_port FROM routes WHERE route_type = 'l4' AND enabled = 1 AND l4_protocol = 'tcp' ORDER BY id`).all();
  for (const r of rows) {
    if (own.has(r.id) || !/^[0-9]{1,5}$/.test(String(r.l4_listen_port || ''))) continue;
    const listenPort = Number(r.l4_listen_port);
    let target = null;
    if (r.target_kind === 'gateway') {
      const port = Number(r.target_lan_port);
      if (!r.target_lan_host || !Number.isInteger(port)) continue;
      target = r.target_peer_id
        ? { kind: 'gateway', peerId: r.target_peer_id, name: gwNames.get(r.target_peer_id) || null, host: r.target_lan_host, port }
        : { kind: 'gateway', poolId: r.target_pool_id, name: poolNames.get(r.target_pool_id) || null, host: r.target_lan_host, port };
    } else {
      const port = Number(r.target_port);
      if (!r.target_ip || !Number.isInteger(port)) continue;
      target = r.peer_id && peerNames.has(r.peer_id)
        ? { kind: 'peer', peerId: r.peer_id, name: peerNames.get(r.peer_id), host: r.target_ip, port }
        : { kind: 'host', host: r.target_ip, port };
    }
    const protocol = REMOTE_PORTS.get(target.port) || REMOTE_PORTS.get(listenPort) || null;
    if (!protocol) continue;
    out.push({ routeId: r.id, name: String(r.description || r.domain || ('L4 ' + listenPort)).slice(0, 120), listenPort, protocol, target });
  }
  return out;
}

/**
 * gc.remote.candidates({ user }) — what „Gerät hinzufügen“ offers, for an administrator in a request.
 */
function candidates(plugin, a) {
  targets.adminInRequest(plugin, a && a.user);
  const live = liveStates();
  const pools = poolsOf();
  const peers = db().prepare(`SELECT id, name, hostname, allowed_ips, peer_type, client_platform FROM peers
    WHERE enabled = 1 ORDER BY name COLLATE NOCASE, id`).all();
  const z = zone();
  const outPeers = [];
  const peerNames = new Map();
  const gwRows = [];
  for (const p of peers) {
    if (p.peer_type === 'gateway') { gwRows.push(p); continue; }
    const address = peerIp(p.allowed_ips);
    if (!address) continue;
    peerNames.set(p.id, p.name);
    const app = ['windows', 'linux', 'android'].includes(p.client_platform) ? p.client_platform : null;
    outPeers.push({ peerId: p.id, name: p.name, address, dnsName: p.hostname && z ? `${p.hostname}.${z}` : null, app, twin: null, _keys: [nameKey(p.hostname), nameKey(p.name)].filter(Boolean) });
  }
  const gwNames = new Map(gwRows.map((g) => [g.id, g.name]));
  const poolNames = new Map();
  for (const v of pools.values()) poolNames.set(v.poolId, v.name);
  const meta = new Map();
  try { for (const m of db().prepare('SELECT peer_id, last_health FROM gateway_meta').all()) meta.set(m.peer_id, m); } catch { /* none */ }
  const outGws = [];
  for (const g of gwRows) {
    if (!meta.has(g.id)) continue;
    const l = live.get(g.id);
    const rows = db().prepare('SELECT id, ip, vendor, hostname, name, random_mac, mac, online, last_seen, ports, ports_at FROM netwatch_devices WHERE peer_id = ? AND ip IS NOT NULL ORDER BY id').all(g.id);
    outGws.push({
      peerId: g.id, name: g.name, online: !!(l && l.state === 'online'), offlineSince: l && l.state !== 'online' ? iso(l.offline_since) : null,
      pool: pools.get(g.id) || null, subnets: subnetsOf(meta.get(g.id).last_health), watch: watchOf(g.id),
      devices: rows.map((r) => ({
        ref: 'nw-' + r.id, name: r.name || r.hostname || null, address: r.ip, vendor: r.vendor || null, online: r.online === 1, lastSeen: iso(r.last_seen),
        ports: remotePorts(r.ports), portsAt: iso(r.ports_at), wake: r.random_mac !== 1 && !!r.mac, twin: null,
        _keys: [nameKey(r.name), nameKey(r.hostname)].filter(Boolean),
      })),
    });
  }
  // the same device in the VPN and in a home network: the same name on both sides, and only once each
  const byKeyPeer = new Map();
  for (const p of outPeers) for (const k of new Set(p._keys)) byKeyPeer.set(k, byKeyPeer.has(k) ? null : p);
  const byKeyDev = new Map();
  for (const g of outGws) for (const d of g.devices) for (const k of new Set(d._keys)) byKeyDev.set(k, byKeyDev.has(k) ? null : { g, d });
  for (const [k, p] of byKeyPeer) {
    const hit = byKeyDev.get(k);
    if (!p || !hit || p.twin || hit.d.twin) continue;
    p.twin = { gatewayPeerId: hit.g.peerId, ref: hit.d.ref, address: hit.d.address };
    hit.d.twin = { peerId: p.peerId, address: p.address };
  }
  for (const p of outPeers) delete p._keys;
  for (const g of outGws) for (const d of g.devices) delete d._keys;
  return {
    vpn: { subnet: config.wireguard.subnet, hub: targets.hubIp(), zone: z },
    peers: outPeers,
    gateways: outGws,
    routes: routeCandidates(peerNames, gwNames, poolNames),
  };
}

// ─── scan ────────────────────────────────────────

/** What answers first on a port (within GREETING_MS): SSH, VNC, Telnet — or nothing (RDP waits for the client). */
function classify(buf) {
  if (!buf || !buf.length) return null;
  if (buf[0] === 0xff) return 'telnet';
  const s = buf.subarray(0, 12).toString('latin1');
  if (s.startsWith('SSH-')) return 'ssh';
  if (/^RFB \d{3}\.\d{3}/.test(s)) return 'vnc';
  return null;
}

let connectFn = null; // test seam
function tcpLook(host, port) {
  return new Promise((resolve) => {
    const start = Date.now();
    const sock = (connectFn || net.connect)({ host, port });
    let done = false;
    let rt = null;
    let greetTimer = null;
    const finish = (open, service) => {
      if (done) return;
      done = true;
      clearTimeout(connTimer);
      clearTimeout(greetTimer);
      try { sock.destroy(); } catch { /* gone */ }
      resolve({ port, open, responseTime: open ? rt : null, service: service || null });
    };
    const connTimer = setTimeout(() => finish(false), CONNECT_MS);
    sock.once('connect', () => {
      rt = Date.now() - start;
      clearTimeout(connTimer);
      greetTimer = setTimeout(() => finish(true, null), GREETING_MS);
    });
    sock.once('data', (b) => finish(true, classify(b)));
    sock.once('error', () => finish(rt != null, null));
    sock.once('close', () => finish(rt != null, null));
  });
}

const inFlight = new Map(); // pluginId → scans running

/**
 * gc.remote.scan(target, ports) → { via, address, results: [{ port, open, responseTime, service }] }
 */
async function scan(plugin, target, ports) {
  const x = target && typeof target === 'object' && !Array.isArray(target) ? target : null;
  if (!x) throw new TargetError('invalid', 'target required');
  if (x.listener != null) throw new TargetError('invalid', 'scan: a target with host, not a listener');
  if (!Array.isArray(ports) || !ports.length || ports.length > SCAN_MAX_PORTS) throw new TargetError('invalid', `ports: 1…${SCAN_MAX_PORTS} ports`);
  const list = [];
  for (const p of ports) {
    const n = Number(p);
    if (!Number.isInteger(n) || n < 1 || n > 65535) throw new TargetError('invalid', 'ports: 1…65535');
    if (!list.includes(n)) list.push(n);
  }
  const t = targets.normalise({ ...x, port: list[0] });
  const busy = inFlight.get(plugin.id) || 0;
  if (busy >= SCAN_PARALLEL) throw new TargetError('rate_limited', 'a scan of this plugin is still running');
  inFlight.set(plugin.id, busy + 1);
  try {
    if (t.gatewayPeerId) {
      if (!require('../gatewayFeatures').gatewayPeer(t.gatewayPeerId)) throw new TargetError('not_found', 'gateway not found');
      const l = liveStates().get(t.gatewayPeerId);
      if (!l || l.state !== 'online') throw new TargetError('gateway_offline', 'the gateway is offline');
      const gws = require('../gateways');
      const results = await Promise.all(list.map(async (port) => {
        let r = null;
        try { r = await gws.probeGatewayTarget(t.gatewayPeerId, t.host, port); } catch { r = null; }
        if (!r || !r.probed_target) return { port, open: null, responseTime: null, service: null };
        return { port, open: !!r.probe_result, responseTime: r.probe_result ? (r.probe_latency_ms ?? null) : null, service: null };
      }));
      return { via: 'gateway', address: null, results };
    }
    const address = await targets.resolveHost(t.host);
    const results = await Promise.all(list.map((port) => tcpLook(address, port)));
    return { via: 'direct', address, results };
  } finally {
    const n = (inFlight.get(plugin.id) || 1) - 1;
    if (n > 0) inFlight.set(plugin.id, n); else inFlight.delete(plugin.id);
  }
}

function _setConnectForTest(fn) { if (process.env.NODE_ENV === 'test') connectFn = fn; }
function _resetForTest() { if (process.env.NODE_ENV === 'test') { connectFn = null; inFlight.clear(); } }

module.exports = { candidates, scan, classify, REMOTE_PORTS, _setConnectForTest, _resetForTest };
