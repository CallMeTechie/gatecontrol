'use strict';

// Home-network targets of a plugin (docs/plugins.md "Netzwerk").
//
// plugin.json declares WHAT it needs (permissions.network.homeTargets: id,
// label, protocols); the administrator assigns WHERE, per plugin, in
// Settings → Plugins → Einstellungen → Zugriffsziele:
//   { kind: 'route', routeId }                    a GateControl route
//   { kind: 'peer',  peerId, port?, scheme? }     a VPN peer
//   { kind: 'host',  host, port?, scheme? }       a host, domain (also an
//                                                 internal-only one) or IP
// The plugin only ever names the id (gc.net.fetchTarget('gateway', '/api'),
// gc.net.tcpTarget('ac', { index })) — it cannot reach any home or VPN address
// nobody assigned. Transport, as GateControl itself reaches these targets:
//   HTTP route via a gateway   companion proxy http://<gateway VPN IP>:8080
//                              + X-Gateway-Target-Domain: <route domain>
//                              (routes.resolveCompanionUrl)
//   HTTP route, peer/direct    its backend (peer VPN IP or target IP + port)
//   L4 route                   gateway listener / peer / target as Caddy dials it
//   peer, host                 direct (host names through the server's DNS,
//                              so internal-only domains of the VPN DNS work)
// Never, even when assigned: loopback, unspecified, multicast, cloud metadata,
// and GateControl's own admin API / Caddy admin ports on this server's
// addresses.

const { getDb } = require('../../db/connection');
const netPolicy = require('./netPolicy');

const DISCOVERY = '@discovery';
const HOST_RE = /^(?=.{1,253}$)[a-z0-9_](?:[a-z0-9_-]{0,62})(?:\.[a-z0-9_](?:[a-z0-9_-]{0,62}))*$/i;

class TargetError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

function declared(plugin) {
  const n = plugin.manifest && plugin.manifest.permissions && plugin.manifest.permissions.network;
  return (n && n.homeTargets) || [];
}

function discoveryDecl(plugin) {
  const n = plugin.manifest && plugin.manifest.permissions && plugin.manifest.permissions.network;
  return (n && n.localDiscovery) || null;
}

// ─── Storage ────────────────────────────────────

function rows(pluginId) {
  return getDb().prepare('SELECT target_id, idx, assignment FROM plugin_targets WHERE plugin_id = ? ORDER BY target_id, idx').all(pluginId);
}

/** { targetId: [assignment, …] } */
function assignments(pluginId) {
  const out = {};
  for (const r of rows(pluginId)) {
    if (r.target_id === DISCOVERY) continue;
    let a;
    try { a = JSON.parse(r.assignment); } catch { continue; }
    (out[r.target_id] = out[r.target_id] || []).push(a);
  }
  return out;
}

function discoveryGranted(pluginId) {
  return !!getDb().prepare('SELECT 1 FROM plugin_targets WHERE plugin_id = ? AND target_id = ?').get(pluginId, DISCOVERY);
}

function setDiscovery(pluginId, on) {
  const db = getDb();
  db.prepare('DELETE FROM plugin_targets WHERE plugin_id = ? AND target_id = ?').run(pluginId, DISCOVERY);
  if (on) db.prepare('INSERT INTO plugin_targets (plugin_id, target_id, idx, assignment) VALUES (?, ?, 0, ?)').run(pluginId, DISCOVERY, '{}');
}

function removeAll(pluginId) {
  getDb().prepare('DELETE FROM plugin_targets WHERE plugin_id = ?').run(pluginId);
}

function intIn(v, lo, hi) {
  const n = Number(v);
  return Number.isInteger(n) && n >= lo && n <= hi ? n : null;
}

/** Validate one assignment from the admin UI → normalised object (throws TargetError). */
function normalise(a) {
  if (!a || typeof a !== 'object') throw new TargetError('invalid_target');
  const scheme = a.scheme === 'https' ? 'https' : 'http';
  if (a.kind === 'route') {
    const routeId = intIn(a.routeId, 1, 2 ** 31);
    if (!routeId) throw new TargetError('invalid_target');
    if (!getDb().prepare('SELECT 1 FROM routes WHERE id = ?').get(routeId)) throw new TargetError('unknown_route');
    return { kind: 'route', routeId };
  }
  if (a.kind === 'peer') {
    const peerId = intIn(a.peerId, 1, 2 ** 31);
    if (!peerId) throw new TargetError('invalid_target');
    if (!getDb().prepare('SELECT 1 FROM peers WHERE id = ?').get(peerId)) throw new TargetError('unknown_peer');
    const port = a.port == null || a.port === '' ? null : intIn(a.port, 1, 65535);
    if (a.port != null && a.port !== '' && !port) throw new TargetError('invalid_port');
    return { kind: 'peer', peerId, port, scheme };
  }
  if (a.kind === 'host') {
    const host = String(a.host || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
    if (!(netPolicy.isIpLiteral(host) || HOST_RE.test(host))) throw new TargetError('invalid_host');
    if (netPolicy.isIpLiteral(host) && netPolicy.classify(host) === 'never') throw new TargetError('blocked_address');
    const port = a.port == null || a.port === '' ? null : intIn(a.port, 1, 65535);
    if (a.port != null && a.port !== '' && !port) throw new TargetError('invalid_port');
    return { kind: 'host', host, port, scheme };
  }
  throw new TargetError('invalid_target');
}

/** Replace the assignments of one declared target. */
function assign(plugin, targetId, list) {
  const decl = declared(plugin).find((t) => t.id === targetId);
  if (!decl) throw new TargetError('unknown_target');
  if (!Array.isArray(list) || list.length > (decl.multiple ? 32 : 1)) throw new TargetError('too_many_targets');
  const norm = list.map(normalise);
  const db = getDb();
  db.transaction(() => {
    db.prepare('DELETE FROM plugin_targets WHERE plugin_id = ? AND target_id = ?').run(plugin.id, targetId);
    const ins = db.prepare('INSERT INTO plugin_targets (plugin_id, target_id, idx, assignment) VALUES (?, ?, ?, ?)');
    norm.forEach((a, i) => ins.run(plugin.id, targetId, i, JSON.stringify(a)));
  })();
  return norm;
}

// ─── Display ────────────────────────────────────

function peerIp(peerId) {
  const p = getDb().prepare('SELECT name, allowed_ips, enabled FROM peers WHERE id = ?').get(peerId);
  return p ? { name: p.name, ip: String(p.allowed_ips || '').split(',')[0].split('/')[0].trim(), enabled: p.enabled === 1 } : null;
}

/** Short text of an assignment for the UI ("phoscon.example.com (Route)"). */
function display(a) {
  if (a.kind === 'route') {
    const r = getDb().prepare('SELECT domain, route_type, l4_listen_port FROM routes WHERE id = ?').get(a.routeId);
    return r ? (r.route_type === 'l4' ? `${r.domain || 'L4'}:${r.l4_listen_port}` : r.domain) : `#${a.routeId}`;
  }
  if (a.kind === 'peer') {
    const p = peerIp(a.peerId);
    return p ? `${p.name} (${p.ip}${a.port ? ':' + a.port : ''})` : `#${a.peerId}`;
  }
  return a.host + (a.port ? ':' + a.port : '');
}

/** Choices for the "Zugriffsziele" pickers. */
function choices() {
  const db = getDb();
  const routes = db.prepare("SELECT id, domain, route_type, l4_listen_port, external_enabled, enabled FROM routes ORDER BY domain").all()
    .map((r) => ({ id: r.id, label: r.route_type === 'l4' ? `${r.domain || 'L4'}:${r.l4_listen_port}` : r.domain, type: r.route_type === 'l4' ? 'l4' : 'http',
      internal: !r.external_enabled, enabled: r.enabled === 1 }));
  const peers = db.prepare('SELECT id, name, allowed_ips, peer_type FROM peers WHERE enabled = 1 ORDER BY name').all()
    .map((p) => ({ id: p.id, label: p.name, ip: String(p.allowed_ips || '').split('/')[0], gateway: p.peer_type === 'gateway' }));
  return { routes, peers };
}

// ─── Resolution ─────────────────────────────────

function blockedPorts() {
  let app = 3000;
  try { app = require('../../../config/default').app.port; } catch { /* default */ }
  return new Set([app, 2019]);
}

function lookupFn(opts) { return (opts && opts.lookup) || netPolicy.lookupAll; }

/** Final check of a resolved address (also for assigned targets). */
async function checkAddress(host, port, opts) {
  let addrs;
  if (netPolicy.isIpLiteral(host)) addrs = [{ address: netPolicy.toAddr(host).toString() }];
  else {
    try { addrs = await lookupFn(opts)(host); } catch { throw new TargetError('dns', 'name does not resolve'); }
    if (!addrs || !addrs.length) throw new TargetError('dns', 'name does not resolve');
  }
  for (const a of addrs) {
    if (netPolicy.classify(a.address) === 'never') throw new TargetError('blocked_address', 'address not reachable for plugins');
    if (blockedPorts().has(port) && netPolicy.isHostReserved(a.address, opts && opts.reserved)) throw new TargetError('blocked_port', 'GateControl’s own admin ports are never reachable');
  }
  const first = netPolicy.toAddr(addrs[0].address);
  return { address: first.toString(), family: first.kind() === 'ipv6' ? 6 : 4 };
}

/**
 * Where does target `id` (assignment `index`) go for protocol `proto`?
 * @returns {Promise<{scheme, host, port, address, family, headers}>}
 */
async function resolve(plugin, id, index, proto, opts = {}) {
  const decl = declared(plugin).find((t) => t.id === id);
  if (!decl) throw new TargetError('unknown_target', 'plugin.json declares no target ' + id);
  if (proto === 'http' && !decl.proto.http) throw new TargetError('protocol', 'target does not allow HTTP');
  if ((proto === 'tcp' || proto === 'udp') && !decl.proto[proto].length) throw new TargetError('protocol', `target does not allow ${proto.toUpperCase()}`);
  const list = assignments(plugin.id)[id] || [];
  const i = Number.isInteger(index) ? index : 0;
  const a = list[i];
  if (!a) throw new TargetError('unassigned', `no target assigned for ${id} — an administrator assigns it in Settings → Plugins`);
  const declPorts = (decl.proto[proto] || []).length ? netPolicy.parsePorts(decl.proto[proto]) : null;
  const wantPort = (p) => {
    const port = intIn(p, 1, 65535) || (declPorts ? declPorts[0][0] : null);
    if (declPorts && !netPolicy.inRanges(declPorts, port)) throw new TargetError('port', `port ${port} is not declared for ${id}`);
    return port;
  };

  let host;
  let port;
  let scheme = 'http';
  const headers = {};
  if (a.kind === 'route') {
    const routes = require('../routes');
    const r = routes.getById(a.routeId);
    if (!r || !r.enabled) throw new TargetError('route_unavailable', 'assigned route is missing or switched off');
    const isL4 = r.route_type === 'l4';
    if (proto === 'http') {
      if (isL4) throw new TargetError('protocol', 'an L4 route cannot carry HTTP');
      const comp = r.target_kind === 'gateway' ? routes.resolveCompanionUrl(a.routeId) : null;
      if (comp) {
        const u = new URL(comp.baseUrl);
        host = u.hostname; port = Number(u.port) || 80; scheme = 'http';
        headers['x-gateway-target-domain'] = comp.domain;
      } else {
        host = r.peer_id ? (peerIp(r.peer_id) || {}).ip : r.target_ip;
        port = Number(r.target_port) || (r.backend_https ? 443 : 80);
        scheme = r.backend_https ? 'https' : 'http';
      }
    } else {
      if (!isL4) throw new TargetError('protocol', 'only an L4 route carries TCP/UDP');
      if (r.target_kind === 'gateway' && r.target_peer_ip) { host = String(r.target_peer_ip).split('/')[0]; port = Number(r.l4_listen_port); }
      else if (r.peer_id) { host = (peerIp(r.peer_id) || {}).ip; port = Number(r.target_port); }
      else { host = r.target_ip; port = Number(r.target_port); }
    }
  } else if (a.kind === 'peer') {
    const p = peerIp(a.peerId);
    if (!p || !p.enabled) throw new TargetError('peer_unavailable', 'assigned peer is missing or switched off');
    host = p.ip;
    scheme = a.scheme;
    port = proto === 'http' ? (a.port || (scheme === 'https' ? 443 : 80)) : wantPort(opts.port || a.port);
  } else {
    host = a.host;
    scheme = a.scheme;
    port = proto === 'http' ? (a.port || (scheme === 'https' ? 443 : 80)) : wantPort(opts.port || a.port);
  }
  if (!host || !port) throw new TargetError('route_unavailable', 'target has no address');
  const addr = await checkAddress(host, port, opts);
  return { scheme, host, port, headers, ...addr };
}

/** Targets the plugin may use, for gc.net.targets(). */
function listFor(plugin) {
  const as = assignments(plugin.id);
  return declared(plugin).map((t) => ({ id: t.id, protocols: t.protocols, assigned: (as[t.id] || []).map((a, index) => ({ index, label: display(a) })) }));
}

module.exports = {
  DISCOVERY, TargetError, declared, discoveryDecl, assignments, assign, normalise, discoveryGranted, setDiscovery, removeAll,
  display, choices, resolve, listFor, checkAddress,
};
