'use strict';

// Where a connection to a NAS goes (docs/storage-targets.md "Addresses"):
// the address of the settings themselves, a VPN peer or a GateControl route.
// Shared by the storage targets (index.js, `via` of SMB and WebDAV) and the
// off-site backup targets (services/offsite: WebDAV, SMB, SFTP) — one
// validation, one dial resolution, so the same NAS is reached the same way
// from both.
//
//   { kind: 'host' }                      the URL's / the host field's own address
//   { kind: 'peer', peerId, port }        the peer's VPN address
//   { kind: 'route', routeId }            what Caddy dials for the route, never Caddy itself
//
// Validation throws StorageError `invalid` with `field` ('via', 'routeId',
// 'port'); the dial throws StorageError `unreachable` (peer / route missing
// or switched off). The peer or route is read again for every connection: a
// gateway failover moves a route.

const { getDb } = require('../../db/connection');
const { StorageError } = require('./errors');

function invalid(field, message) { return new StorageError('invalid', message || `${field}: invalid`, { field }); }

function portOf(v, dflt) {
  if (v == null || v === '') return dflt;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw invalid('port');
  return n;
}

function kindOf(v) { return v && v.kind ? v.kind : 'host'; }

/** { kind: 'peer', peerId, port } for an existing peer, else invalid('via'). */
function peerVia(v, p, dflt) {
  const peerId = Number(v.peerId);
  if (!Number.isSafeInteger(peerId) || !getDb().prepare('SELECT 1 FROM peers WHERE id = ?').get(peerId)) throw invalid('via');
  return { kind: 'peer', peerId, port: portOf(p, dflt) };
}

/**
 * A TCP connection (SMB, SFTP) through a peer or an L4 route → the `via` to
 * store, or null for kind 'host' (the caller keeps its own host and port).
 * `port`, `dflt`: the peer's port (given / default). An L4 route has its own.
 * opts.tcpOnly: refuse a UDP route too (storage targets' SMB never did).
 */
function tcpVia(v, port, dflt, opts = {}) {
  const k = kindOf(v);
  if (k === 'host') return null;
  if (k === 'peer') return peerVia(v, v.port != null && v.port !== '' ? v.port : port, dflt);
  if (k === 'route') {
    const routeId = Number(v.routeId);
    const r = Number.isSafeInteger(routeId) ? getDb().prepare('SELECT route_type, l4_protocol FROM routes WHERE id = ?').get(routeId) : null;
    if (!r || r.route_type !== 'l4' || (opts.tcpOnly && r.l4_protocol === 'udp')) throw invalid('via', 'an L4 route');
    return { kind: 'route', routeId };
  }
  throw invalid('via');
}

/**
 * Can a WebDAV target with a `scheme` URL go through route `r`? → null or why not.
 * L4 (TCP): always — the bytes go through untouched, TLS stays end to end.
 * HTTP route via a gateway: only plain http on both hops — the companion
 * proxy would make the TLS connection to the NAS itself, unchecked by us.
 * HTTP route to a peer / an address: its backend, when it speaks the URL's scheme.
 */
function webdavRouteProblem(r, scheme) {
  if (!r) return 'no such route';
  if (r.route_type === 'l4') return r.l4_protocol === 'udp' ? 'a TCP route' : null;
  if (r.target_kind === 'gateway') {
    return scheme === 'http' && !r.backend_https ? null : 'an HTTP route through a gateway carries http only — use an L4 route for https';
  }
  return (scheme === 'https') === !!r.backend_https ? null : `the route's backend does not speak ${scheme}`;
}

/**
 * WebDAV: where to connect — the URL's own host, a VPN peer (+ port) or a
 * route. `port`: the peer's port when `v.port` is empty (default: the URL's
 * port, else 443 / 80). `url`: a URL.
 */
function webdavVia(v, port, url) {
  const k = kindOf(v);
  if (k === 'host') return { kind: 'host' };
  if (k === 'peer') return peerVia(v, v.port != null && v.port !== '' ? v.port : port, Number(url.port) || (url.protocol === 'https:' ? 443 : 80));
  if (k === 'route') {
    const routeId = Number(v.routeId);
    const r = Number.isSafeInteger(routeId) ? getDb().prepare('SELECT route_type, l4_protocol, target_kind, backend_https FROM routes WHERE id = ?').get(routeId) : null;
    if (!r) throw invalid('via');
    const why = webdavRouteProblem(r, url.protocol.slice(0, -1));
    if (why) throw invalid('routeId', why);
    return { kind: 'route', routeId };
  }
  throw invalid('via');
}

/** The `via` of a stored WebDAV config (rows from before it have none: the URL's host). */
function webdavViaOf(cfg) { return cfg && cfg.via && cfg.via.kind ? cfg.via : { kind: 'host' }; }

// ─── Dial ───────────────────────────────────────

function peerAddress(peerId) {
  const p = getDb().prepare('SELECT allowed_ips FROM peers WHERE id = ?').get(peerId);
  return p ? String(p.allowed_ips || '').split(',')[0].split('/')[0].trim() : null;
}

/** A peer that is there and switched on → its VPN address. */
function peerDial(peerId) {
  const p = getDb().prepare('SELECT enabled FROM peers WHERE id = ?').get(peerId);
  if (!p || p.enabled !== 1) throw new StorageError('unreachable', 'the peer is missing or switched off');
  return peerAddress(peerId);
}

/** An enabled route (routes.getById) or unreachable. */
function routeOf(routeId) {
  const r = require('../routes').getById(routeId);
  if (!r || !r.enabled) throw new StorageError('unreachable', 'the route is missing or switched off');
  return r;
}

/**
 * An L4 route: what Caddy dials for it, never Caddy itself (so an internal-only
 * route stays internal) — the gateway's listener for a gateway route, else
 * the peer or the target address with the target port.
 */
function l4Dial(r) {
  if (r.target_kind === 'gateway' && r.target_peer_ip) return { host: String(r.target_peer_ip).split('/')[0], port: Number(r.l4_listen_port) };
  if (r.peer_id) return { host: peerAddress(r.peer_id), port: Number(r.target_port) };
  return { host: r.target_ip, port: Number(r.target_port) };
}

/**
 * A TCP `via` (SMB, SFTP) → { host, port } to connect to. `own`: the
 * settings' own { host, port } for kind 'host' (and a missing via).
 */
function tcpDial(v, own) {
  const k = kindOf(v);
  if (k === 'host') return { host: (v && v.host) || own.host, port: (v && v.port) || own.port };
  if (k === 'peer') return { host: peerDial(v.peerId), port: v.port || own.port };
  const r = routeOf(v.routeId);
  if (r.route_type !== 'l4' || r.l4_protocol === 'udp') throw new StorageError('unreachable', 'the route is missing or switched off');
  return l4Dial(r);
}

/**
 * A TCP `via` (SMB, SFTP) through a peer or a route → { address, port } to
 * connect to, the address checked by the storage targets' rules and pinned
 * (net.resolve); null for kind 'host' (the tool connects to the host field
 * itself, as before). Throws StorageError (unreachable, blocked_address …).
 */
async function tcpAddress(v, own) {
  if (kindOf(v) === 'host') return null;
  const d = tcpDial(v, own);
  if (!d.host || !(d.port >= 1 && d.port <= 65535)) throw new StorageError('unreachable', 'no address');
  try {
    const r = await require('./net').resolve(d.host, d.port);
    return { address: r.address, port: d.port };
  } catch (e) { throw StorageError.from(e); }
}

/**
 * WebDAV through a peer or a route: where to connect → { host, port, headers }
 * (null: the URL's own host). Read again for every connection.
 *   peer                 its VPN address, `port`
 *   L4 route             as l4Dial — TLS stays end to end
 *   HTTP route, gateway  the gateway's companion proxy (http, X-Gateway-Target-Domain:
 *                        the route's domain), as Caddy and the plugin targets reach it
 *   HTTP route           its backend (peer VPN address or target address, target port)
 */
function webdavDial(v, url) {
  if (kindOf(v) === 'peer') return { host: peerDial(v.peerId), port: v.port };
  if (kindOf(v) !== 'route') return null;
  const r = routeOf(v.routeId);
  const why = webdavRouteProblem(r, url.protocol.slice(0, -1));
  if (why) throw new StorageError('unreachable', why);
  if (r.route_type === 'l4') return l4Dial(r);
  if (r.target_kind === 'gateway') {
    const comp = require('../routes').resolveCompanionUrl(r.id);
    if (!comp) throw new StorageError('unreachable', 'the route has no gateway');
    const c = new URL(comp.baseUrl);
    return { host: c.hostname, port: Number(c.port) || 80, headers: { 'x-gateway-target-domain': comp.domain } };
  }
  return { host: r.peer_id ? peerAddress(r.peer_id) : r.target_ip, port: Number(r.target_port) };
}

/**
 * The dial of a WebDAV `via` as net.request wants it: null for the URL's own
 * host, else a function asked before every request (→ { host, port, headers },
 * throws `unreachable` when there is nothing to dial).
 */
function webdavDialer(v, url) {
  if (kindOf(v) === 'host') return null;
  const u = url instanceof URL ? url : new URL(url);
  return () => {
    const d = webdavDial(v, u);
    if (!d || !d.host || !(d.port >= 1 && d.port <= 65535)) throw new StorageError('unreachable', 'no address');
    return d;
  };
}

/** A peer ("nas-gateway", WebDAV: ":port" added) or a route ("nas.example.de:5006" for L4, the domain for HTTP). */
function viaLabel(v, bare) {
  if (v.kind === 'peer') {
    const p = getDb().prepare('SELECT name FROM peers WHERE id = ?').get(v.peerId);
    return (p ? p.name : `#${v.peerId}`) + (!bare && v.port ? ':' + v.port : '');
  }
  const r = getDb().prepare('SELECT domain, route_type, l4_listen_port FROM routes WHERE id = ?').get(v.routeId);
  if (!r) return `#${v.routeId}`;
  return r.route_type === 'l4' ? `${r.domain || 'L4'}:${r.l4_listen_port}` : r.domain;
}

// ─── "Points at this server" ────────────────────

// connection refused / no answer — what a port of this server that nothing
// listens on looks like (not DNS, not TLS, not a login)
const NO_ANSWER_RE = /ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|connection refused|timed out|no answer|NT_STATUS_CONNECTION_REFUSED|NT_STATUS_IO_TIMEOUT/i;

/** Was `err` (or its message) a refused / unanswered connection? */
function isNoAnswer(err) {
  if (!err) return false;
  const c = String(err.code || '');
  if (['ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH', 'timeout'].includes(c)) return true;
  return NO_ANSWER_RE.test(String(err.message || err));
}

let lookupImpl = null;

/**
 * Does `host` resolve to this server's own public address (setting
 * server.public_ip, GC_WG_HOST, …: domains.getServerPublicIps)? A NAS name
 * that points at GateControl's own domain — reachable through a GateControl
 * route from outside, but not from GateControl itself on the NAS's port.
 * Never throws; false when unsure.
 */
async function pointsAtThisServer(host) {
  const h = String(host || '').replace(/^\[|\]$/g, '').trim();
  if (!h) return false;
  try {
    const netPolicy = require('../plugins/netPolicy');
    const domains = require('../domains');
    const own = await domains.getServerPublicIps();
    const mine = [own.v4, own.v6].filter(Boolean).map((a) => domains.canonIp(a));
    if (!mine.length) return false;
    let addrs;
    if (netPolicy.isIpLiteral(h)) addrs = [h];
    else addrs = ((await (lookupImpl || netPolicy.lookupAll)(h)) || []).map((a) => a.address);
    return addrs.some((a) => mine.includes(domains.canonIp(a)));
  } catch { return false; }
}

/**
 * The hint for a connection that failed: 'self_address' when `via` is the
 * settings' own host, the error is a refused / unanswered connection and
 * `host` resolves to this server itself → else null.
 */
async function selfHint(err, v, host) {
  if (kindOf(v) !== 'host' || !isNoAnswer(err)) return null;
  return (await pointsAtThisServer(host)) ? 'self_address' : null;
}

// English, for logs, last_error and API callers; the pages have their own text per hint code
const SELF_HINT_TEXT = 'the address points to this GateControl server itself — if the target is behind the VPN, choose the VPN device or the route under "Connection"';

module.exports = {
  portOf, tcpVia, webdavVia, webdavViaOf, webdavRouteProblem,
  peerAddress, peerDial, routeOf, l4Dial, tcpDial, tcpAddress, webdavDial, webdavDialer, viaLabel,
  isNoAnswer, pointsAtThisServer, selfHint, SELF_HINT_TEXT,
  _setLookupForTest: (fn) => { lookupImpl = fn; },
};
