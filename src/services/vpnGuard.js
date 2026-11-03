'use strict';

// VPN misuse (Einstellungen › Sicherheit › Routenschutz, "VPN-Missbrauch
// erkennen"). WireGuard cannot be brute-forced — but a copied key works.
//
//   two_places   the same key keeps switching between internet addresses:
//                WireGuard answers the address the last packet came from, so
//                two devices with one key make the endpoint flap. Fed by the
//                peer poller (peerStatus.js, every 30 s, `wg show dump`): at
//                least FLAP_MIN switches among at most three addresses within
//                FLAP_WINDOW → warn (activity vpn_key_shared → notifications)
//                or block the peer (disabled like the switch on the peer page)
//   new_country  a peer connects from a country it never came from: the
//                countries of its endpoints are kept (peer_endpoints_seen,
//                ip2location.io — only with a key); the first country is
//                learnt silently → warn (vpn_new_country)
//
// Endpoints on private networks (a peer in the LAN) are ignored. Each warning
// at most once per peer and 6 h (new country: once per country).

const ipaddr = require('ipaddr.js');
const { getDb } = require('../db/connection');
const settings = require('./settings');
const logger = require('../utils/logger');

const K_CONFIG = 'vpnguard.config';
const FLAP_WINDOW_MS = 15 * 60e3;
const FLAP_MIN = 6;
const FLAP_MAX_IPS = 3;
const REWARN_MS = 6 * 3600e3;
const TWO_PLACES = ['warn', 'block', 'off'];
const NEW_COUNTRY = ['warn', 'off'];

const _state = { last: new Map(), changes: new Map(), warned: new Map(), lookup: null, testMode: process.env.NODE_ENV === 'test' };

function getConfig() {
  let c = {};
  try { c = JSON.parse(settings.get(K_CONFIG, '{}')) || {}; } catch { c = {}; }
  return {
    two_places: TWO_PLACES.includes(c.two_places) ? c.two_places : 'warn',
    new_country: NEW_COUNTRY.includes(c.new_country) ? c.new_country : 'warn',
  };
}

function setConfig(input) {
  const b = input && typeof input === 'object' ? input : {};
  const next = getConfig();
  if (b.two_places !== undefined) {
    if (!TWO_PLACES.includes(b.two_places)) throw Object.assign(new Error('two_places must be warn, block or off'), { statusCode: 400, code: 'invalid', field: 'two_places' });
    next.two_places = b.two_places;
  }
  if (b.new_country !== undefined) {
    if (!NEW_COUNTRY.includes(b.new_country)) throw Object.assign(new Error('new_country must be warn or off'), { statusCode: 400, code: 'invalid', field: 'new_country' });
    next.new_country = b.new_country;
  }
  settings.set(K_CONFIG, JSON.stringify(next));
  return getConfig();
}

/** '203.0.113.5:51820' / '[2001:db8::1]:51820' → public IP text, or null. */
function endpointIp(endpoint) {
  const s = String(endpoint || '');
  const m = /^\[([0-9A-Fa-f:.]+)\]:\d+$/.exec(s) || /^((?:\d{1,3}\.){3}\d{1,3}):\d+$/.exec(s);
  if (!m) return null;
  try {
    const a = ipaddr.process(m[1]);
    return a.range() === 'unicast' ? a.toString() : null;
  } catch { return null; }
}

/** Pure: does this list of { ip, at } switches look like one key at two places? */
function flapping(changes, at) {
  const recent = changes.filter((c) => at - c.at <= FLAP_WINDOW_MS);
  if (recent.length < FLAP_MIN) return null;
  const ips = [...new Set(recent.map((c) => c.ip))];
  if (ips.length < 2 || ips.length > FLAP_MAX_IPS) return null;
  // back and forth: an address shows up again after another one
  let returns = 0;
  for (let i = 2; i < recent.length; i++) if (recent[i].ip === recent[i - 2].ip) returns++;
  return returns >= FLAP_MIN - 2 ? { ips, switches: recent.length } : null;
}

function activity(type, message, details) {
  try { require('./activity').log(type, message, { source: 'wireguard', severity: 'warning', details }); } catch { /* best-effort */ }
}

async function blockPeer(peer) {
  try {
    const row = getDb().prepare('SELECT enabled FROM peers WHERE id = ?').get(peer.id);
    if (row && row.enabled) await require('./peers').toggle(peer.id);
    return true;
  } catch (err) {
    logger.warn({ err: err.message, peerId: peer.id }, 'vpn guard: peer not blocked');
    return false;
  }
}

async function countryOf(ip) {
  if (_state.lookup) return _state.lookup(ip);
  try { if (!settings.get('ip2location.api_key', '')) return null; } catch { return null; }
  return require('./ipFilter').lookupCountry(ip);
}

async function noteEndpoint(peer, ip, at, cfg) {
  const db = getDb();
  const seen = db.prepare('SELECT * FROM peer_endpoints_seen WHERE peer_id = ? AND ip = ?').get(peer.id, ip);
  if (seen) { db.prepare('UPDATE peer_endpoints_seen SET last_seen = ? WHERE peer_id = ? AND ip = ?').run(at, peer.id, ip); return; }
  let cc = null;
  if (cfg.new_country !== 'off') {
    try { cc = await countryOf(ip); } catch { cc = null; }
    cc = cc ? String(cc).slice(0, 2).toUpperCase() : null;
  }
  const known = db.prepare('SELECT DISTINCT country FROM peer_endpoints_seen WHERE peer_id = ? AND country IS NOT NULL').all(peer.id).map((r) => r.country);
  db.prepare('INSERT OR IGNORE INTO peer_endpoints_seen (peer_id, ip, country, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)').run(peer.id, ip, cc, at, at);
  // keep the table small: the newest 50 addresses per peer
  db.prepare(`DELETE FROM peer_endpoints_seen WHERE peer_id = ? AND ip NOT IN
    (SELECT ip FROM peer_endpoints_seen WHERE peer_id = ? ORDER BY last_seen DESC LIMIT 50)`).run(peer.id, peer.id);
  if (cfg.new_country === 'warn' && cc && known.length > 0 && !known.includes(cc)) {
    activity('vpn_new_country', `${peer.name} connected from a new country: ${cc}`, {
      peerId: peer.id, peer_name: peer.name, country: cc, ip, known: known.slice(0, 10),
    });
  }
}

/**
 * One poll of `wg show dump` (peerStatus.js). `peers`: [{ publicKey,
 * endpoint }], `byKey`: Map publicKey → { id, name }. Never throws.
 */
async function observe(peers, byKey, at = Date.now()) {
  let cfg;
  try { cfg = getConfig(); } catch { return; }
  if (cfg.two_places === 'off' && cfg.new_country === 'off') return;
  for (const p of peers || []) {
    try {
      const peer = byKey.get(p.publicKey);
      const ip = endpointIp(p.endpoint);
      if (!peer || !ip) continue;
      const prev = _state.last.get(peer.id);
      _state.last.set(peer.id, ip);
      if (prev !== ip) {
        await noteEndpoint(peer, ip, at, cfg);
        if (prev) {
          const list = (_state.changes.get(peer.id) || []).filter((c) => at - c.at <= FLAP_WINDOW_MS);
          list.push({ ip, at });
          _state.changes.set(peer.id, list.slice(-50));
        }
      }
      if (cfg.two_places === 'off') continue;
      const hit = flapping(_state.changes.get(peer.id) || [], at);
      if (!hit) continue;
      const last = _state.warned.get(peer.id) || 0;
      if (at - last < REWARN_MS) continue;
      _state.warned.set(peer.id, at);
      const blocked = cfg.two_places === 'block' ? await blockPeer(peer) : false;
      activity('vpn_key_shared', `${peer.name}: the key is used at ${hit.ips.length} places at once${blocked ? ' — peer blocked' : ''}`, {
        peerId: peer.id, peer_name: peer.name, ips: hit.ips, switches: hit.switches, blocked,
      });
    } catch (err) {
      logger.debug({ err: err.message }, 'vpn guard: peer not checked');
    }
  }
}

function _resetForTest({ lookup = null } = {}) {
  _state.last.clear();
  _state.changes.clear();
  _state.warned.clear();
  _state.lookup = lookup;
}

module.exports = { getConfig, setConfig, observe, flapping, endpointIp, FLAP_MIN, FLAP_WINDOW_MS, _resetForTest, _state };
