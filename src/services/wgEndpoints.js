'use strict';

/**
 * Remember where recently active WireGuard peers were reachable, so the next
 * container start can reach them at once.
 *
 * Every container (re)start — each auto-update — recreates wg0 from the
 * config file, which carries no endpoints for roaming peers (gateways, VPN
 * clients behind NAT). The server then cannot start a handshake itself and
 * waits until each peer's own timers make it re-handshake: gateway routes
 * answered 502 for about a minute after every update. This service writes the
 * endpoints of peers with a recent handshake to a small root-only file;
 * scripts/wg-restore-endpoints.sh (called by wg-wrapper.sh right after
 * `wg-quick up`) sets them again and pokes each peer so the handshake starts
 * immediately.
 *
 * File format, one peer per line (space separated, validated on both sides):
 *   <public key> <endpoint ip:port | [ipv6]:port> <tunnel ip>
 * The restore side ignores the file when it is older than 30 minutes.
 */

const fs = require('node:fs');
const path = require('node:path');
const logger = require('../utils/logger');

const FILE = process.env.GC_WG_ENDPOINTS_FILE || '/data/wireguard/last-endpoints';
const RECENT_S = 180;          // only peers with a handshake in the last 3 minutes
const INTERVAL_MS = 30 * 1000;
const REFRESH_MS = 5 * 60 * 1000; // rewrite unchanged content this often (keeps mtime fresh)

const KEY_RE = /^[A-Za-z0-9+/]{43}=$/;
const EP_RE = /^(?:(?:\d{1,3}\.){3}\d{1,3}|\[[0-9A-Fa-f:.]+\]):\d{1,5}$/;
const IP4_RE = /^(?:\d{1,3}\.){3}\d{1,3}$/;

/** Tunnel address to poke: the first IPv4 /32 of the peer's allowed IPs. */
function tunnelIp(allowedIps) {
  for (const part of String(allowedIps || '').split(',')) {
    const [ip, mask] = part.trim().split('/');
    if (IP4_RE.test(ip) && (mask === undefined || mask === '32')) return ip;
  }
  return null;
}

/**
 * Pure: the file content for the given `wg show dump` peers (see
 * wireguard.getStatus). Peers without an endpoint, without a recent
 * handshake or with anything malformed are left out; sorted for stable output.
 */
function formatLines(peers, nowS = Math.floor(Date.now() / 1000)) {
  const lines = [];
  for (const p of peers || []) {
    if (!p || !KEY_RE.test(p.publicKey || '')) continue;
    if (!p.endpoint || !EP_RE.test(p.endpoint)) continue;
    if (!(p.latestHandshake > 0) || nowS - p.latestHandshake > RECENT_S) continue;
    const ip = tunnelIp(p.allowedIps);
    if (!ip) continue;
    lines.push(`${p.publicKey} ${p.endpoint} ${ip}`);
  }
  return lines.sort().join('\n') + (lines.length ? '\n' : '');
}

const _state = { timer: null, last: null, lastWrite: 0, file: FILE };

function writeAtomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** One recording pass. Returns true when the file was (re)written. */
async function record({ now = Date.now() } = {}) {
  let status;
  try {
    status = await require('./wireguard').getStatus();
  } catch (err) {
    logger.debug({ err: err.message }, 'wg endpoints: status unavailable');
    return false;
  }
  if (!status || !status.running) return false;
  const content = formatLines(status.peers, Math.floor(now / 1000));
  // Nothing recent (e.g. right after a start, before peers came back): keep
  // the previous file — it is exactly what the next start may still need.
  if (!content) return false;
  if (content === _state.last && now - _state.lastWrite < REFRESH_MS) return false;
  try {
    writeAtomic(_state.file, content);
    _state.last = content;
    _state.lastWrite = now;
    return true;
  } catch (err) {
    logger.warn({ err: err.message }, 'wg endpoints: could not write');
    return false;
  }
}

function start({ intervalMs = INTERVAL_MS, file } = {}) {
  if (_state.timer) return;
  if (file) _state.file = file;
  _state.timer = setInterval(() => { record().catch(() => {}); }, intervalMs);
  if (_state.timer.unref) _state.timer.unref();
}

function stop() {
  if (_state.timer) clearInterval(_state.timer);
  _state.timer = null;
}

function _resetForTest({ file } = {}) {
  stop();
  _state.last = null;
  _state.lastWrite = 0;
  _state.file = file || FILE;
}

module.exports = { formatLines, tunnelIp, record, start, stop, FILE, RECENT_S, _resetForTest };
