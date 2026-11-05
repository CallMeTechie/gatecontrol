'use strict';

// plugin.json `edge` (docs/plugins.md "Edge part"): the part of a plugin that
// runs on a home gateway, next to the devices (container gatecontrol-edge).
// Contract between server and gateway: docs/plugins.md "Edge part" / the
// edge protocol v1. The gateway checks the same rules again before it starts
// anything — this is the server's half.
//
//   "edge": { "entry": "edge/index.js", "minGateway": "1.20.0", "memoryMb": 48,
//     "capabilities": { "udp": { "ports": [5683], "multicast": ["224.0.1.187"] },
//                       "mdns": { "services": ["_shelly._tcp"] },
//                       "tcp": { "lan": true }, "http": { "lan": true },
//                       "mqtt": { "topics": ["shellies/#"] }, "serial": ["zigbee"] } }
//
// validate() pushes stable "edge…: problem" codes through `err` like the rest
// of manifest.js and returns the normalised section (null when invalid).

const net = require('node:net');
const semver = require('../plugins/semver');

const MEMORY_MIN = 16;
const MEMORY_MAX = 256;
const MEMORY_DEFAULT = 48;
const UDP_PORTS_MAX = 16;
const MULTICAST_MAX = 16;
const MDNS_MAX = 16;
const MQTT_TOPICS_MAX = 16;
const MQTT_TOPIC_LEN = 128;
// serial devices by name — the gateway maps a name to the device its hardware detection found
const SERIAL_NAMES = Object.freeze(['zigbee']);
const CAP_KEYS = Object.freeze(['udp', 'mdns', 'tcp', 'http', 'mqtt', 'serial']);
const EDGE_KEYS = Object.freeze(['entry', 'minGateway', 'memoryMb', 'capabilities']);
const MDNS_RE = /^_[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\._(?:tcp|udp)$/;
const ENTRY_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)+$/;

function plainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

function onlyKeys(o, keys) { return Object.keys(o).every((k) => keys.includes(k)); }

const MDNS_GROUP = '224.0.0.251';

/** 224.0.0.0/4 without 224.0.0.0/24 (local network control) — except the mDNS group (its port 5353 only through `mdns`). */
function multicastOk(ip) {
  if (typeof ip !== 'string' || net.isIPv4(ip) !== true) return false;
  const p = ip.split('.').map(Number);
  if (p[0] < 224 || p[0] > 239) return false;
  return !(p[0] === 224 && p[1] === 0 && p[2] === 0) || ip === MDNS_GROUP;
}

/**
 * An MQTT topic filter a plugin may declare: no leading wildcard, no `$…`
 * (broker topics such as $SYS), `#` only as the whole last level, `+` only
 * as a whole level, no empty level, ≤ MQTT_TOPIC_LEN characters.
 */
function topicFilterOk(t) {
  if (typeof t !== 'string' || !t || t.length > MQTT_TOPIC_LEN || /[\0-\x1f\x7f]/.test(t)) return false;
  if (t.startsWith('$') || t.startsWith('#') || t.startsWith('+')) return false;
  const levels = t.split('/');
  for (let i = 0; i < levels.length; i++) {
    const l = levels[i];
    if (!l) return false;
    if (l.includes('#') && (l !== '#' || i !== levels.length - 1)) return false;
    if (l.includes('+') && l !== '+') return false;
  }
  return true;
}

/**
 * Does filter `outer` match every topic `inner` matches? (inner ⊆ outer)
 * Used for MQTT accounts a plugin creates: only below its manifest topics.
 */
function filterCovers(outer, inner) {
  const a = String(outer).split('/');
  const b = String(inner).split('/');
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '#') return true;
    if (i >= b.length) return false;
    if (b[i] === '#') return false;
    if (a[i] === '+') continue;
    if (b[i] === '+' || a[i] !== b[i]) return false;
  }
  return a.length === b.length;
}

function validateCaps(raw, err) {
  const caps = {};
  if (raw == null) return caps;
  if (!plainObject(raw)) { err('edge.capabilities: invalid'); return null; }
  let ok = true;
  const bad = (code) => { err(code); ok = false; };
  for (const k of Object.keys(raw)) if (!CAP_KEYS.includes(k)) bad('edge.capabilities: unknown capability ' + k);

  if (raw.udp != null) {
    const u = raw.udp;
    if (!plainObject(u) || !onlyKeys(u, ['ports', 'multicast'])) bad('edge.capabilities.udp: invalid');
    else {
      const ports = u.ports == null ? [] : u.ports;
      const groups = u.multicast == null ? [] : u.multicast;
      if (!Array.isArray(ports) || ports.length > UDP_PORTS_MAX || !ports.every((p) => Number.isInteger(p) && p >= 1 && p <= 65535)) {
        bad('edge.capabilities.udp.ports: invalid');
      } else if (ports.some((p) => p === 5353)) bad('edge.capabilities.udp.ports: 5353 only through capabilities.mdns');
      else if (ports.some((p) => p < 1024)) bad('edge.capabilities.udp.ports: below 1024');
      else if (new Set(ports).size !== ports.length) bad('edge.capabilities.udp.ports: duplicate');
      if (!Array.isArray(groups) || groups.length > MULTICAST_MAX || !groups.every(multicastOk)) {
        bad('edge.capabilities.udp.multicast: invalid (224.0.0.0/4 without 224.0.0.0/24, ≤ ' + MULTICAST_MAX + ')');
      } else if (new Set(groups).size !== groups.length) bad('edge.capabilities.udp.multicast: duplicate');
      if (ok && !ports.length && !groups.length) bad('edge.capabilities.udp: empty');
      if (ok) caps.udp = { ports: ports.slice().sort((x, y) => x - y), multicast: groups.slice() };
    }
  }
  if (raw.mdns != null) {
    const m = raw.mdns;
    const list = plainObject(m) && onlyKeys(m, ['services']) ? m.services : null;
    if (!Array.isArray(list) || !list.length || list.length > MDNS_MAX || !list.every((s) => typeof s === 'string' && MDNS_RE.test(s))) bad('edge.capabilities.mdns: invalid');
    else if (new Set(list).size !== list.length) bad('edge.capabilities.mdns: duplicate');
    else caps.mdns = { services: list.slice() };
  }
  if (raw.tcp != null) {
    const v = raw.tcp;
    if (!plainObject(v) || !onlyKeys(v, ['lan']) || typeof v.lan !== 'boolean') bad('edge.capabilities.tcp: invalid');
    else if (v.lan) caps.tcp = { lan: true };
  }
  // http: { lan } — HTTPS is always checked on the gateway: fully, or against a pinned certificate
  // (gc.lan.http.request pinSha256, gc.lan.tlsFingerprint). There is no capability to switch the check off.
  if (raw.http != null) {
    const v = raw.http;
    if (plainObject(v) && Object.prototype.hasOwnProperty.call(v, 'selfSigned')) {
      bad('edge.capabilities.http.selfSigned: no longer supported — HTTPS to self-signed devices only with a pinned certificate (pinSha256, gc.lan.tlsFingerprint)');
    } else if (!plainObject(v) || !onlyKeys(v, ['lan']) || typeof v.lan !== 'boolean') bad('edge.capabilities.http: invalid');
    else if (v.lan) caps.http = { lan: true };
  }
  if (raw.mqtt != null) {
    const m = raw.mqtt;
    const list = plainObject(m) && onlyKeys(m, ['topics']) ? m.topics : null;
    if (!Array.isArray(list) || !list.length || list.length > MQTT_TOPICS_MAX) bad('edge.capabilities.mqtt.topics: invalid');
    else if (!list.every(topicFilterOk)) bad('edge.capabilities.mqtt.topics: invalid topic (no leading # or +, no $…)');
    else if (new Set(list).size !== list.length) bad('edge.capabilities.mqtt.topics: duplicate');
    else caps.mqtt = { topics: list.slice() };
  }
  if (raw.serial != null) {
    const s = raw.serial;
    if (!Array.isArray(s) || !s.length || !s.every((n) => typeof n === 'string' && SERIAL_NAMES.includes(n))) bad('edge.capabilities.serial: invalid (known: ' + SERIAL_NAMES.join(', ') + ')');
    else if (new Set(s).size !== s.length) bad('edge.capabilities.serial: duplicate');
    else caps.serial = s.slice();
  }
  return ok ? caps : null;
}

/**
 * @param {*} raw          plugin.json `edge`
 * @param {(e:string)=>void} err
 * @param {{files?: Set<string>, entry?: string}} [opts]  files of the package; the server entry
 * @returns {object|null}  normalised `edge` or null (invalid / absent)
 */
function validate(raw, err, opts = {}) {
  if (raw == null) return null;
  if (!plainObject(raw)) { err('edge: invalid'); return null; }
  const before = [];
  const e = (x) => { before.push(x); err(x); };
  for (const k of Object.keys(raw)) if (!EDGE_KEYS.includes(k)) e('edge: unknown key ' + k);
  const out = {};
  // the gateway unpacks only the entry's folder (+ plugin.json): the entry lives in a folder of its own
  if (typeof raw.entry !== 'string' || raw.entry.length > 200 || !ENTRY_RE.test(raw.entry) || raw.entry.split('/').some((s) => s === '.' || s === '..')
    || !/\.c?js$/.test(raw.entry)) e('edge.entry: invalid (a .js file inside a folder, e.g. edge/index.js)');
  else if (opts.files && !opts.files.has(raw.entry)) e('edge.entry: missing');
  else out.entry = raw.entry;
  if (raw.minGateway != null) {
    if (typeof raw.minGateway !== 'string' || !semver.valid(raw.minGateway)) e('edge.minGateway: invalid');
    else out.minGateway = raw.minGateway.trim();
  } else out.minGateway = null;
  if (raw.memoryMb != null) {
    if (!Number.isInteger(raw.memoryMb) || raw.memoryMb < MEMORY_MIN || raw.memoryMb > MEMORY_MAX) e(`edge.memoryMb: invalid (${MEMORY_MIN}…${MEMORY_MAX})`);
    else out.memoryMb = raw.memoryMb;
  } else out.memoryMb = MEMORY_DEFAULT;
  const caps = validateCaps(raw.capabilities, e);
  if (caps) out.capabilities = caps;
  return before.length ? null : out;
}

/**
 * Capabilities as a flat, sorted list of stable keys — what an administrator
 * confirms when switching the edge part on, and what is compared after an
 * update (new keys → update_pending).
 */
function capabilityList(caps) {
  const c = caps || {};
  const out = [];
  if (c.udp) {
    for (const p of c.udp.ports || []) out.push('udp.port:' + p);
    for (const g of c.udp.multicast || []) out.push('udp.multicast:' + g);
  }
  if (c.mdns) for (const s of c.mdns.services) out.push('mdns:' + s);
  if (c.tcp && c.tcp.lan) out.push('tcp.lan');
  if (c.http && c.http.lan) out.push('http.lan');
  if (c.mqtt) for (const t of c.mqtt.topics) out.push('mqtt.topic:' + t);
  if (c.serial) for (const s of c.serial) out.push('serial:' + s);
  return out.sort();
}

/** Keys of `current` an administrator has not approved yet. */
function newCapabilities(current, approvedList) {
  const ok = new Set(Array.isArray(approvedList) ? approvedList : []);
  return capabilityList(current).filter((k) => !ok.has(k));
}

const TEXT = {
  'udp.port': { de: 'UDP-Port {v} im Heimnetz (senden/empfangen)', en: 'UDP port {v} in the home network (send/receive)' },
  'udp.multicast': { de: 'Multicast-Gruppe {v}', en: 'Multicast group {v}' },
  mdns: { de: 'Geräte suchen per mDNS: {v}', en: 'Find devices via mDNS: {v}' },
  'tcp.lan': { de: 'TCP-Verbindungen zu Geräten im Heimnetz', en: 'TCP connections to devices in the home network' },
  'http.lan': { de: 'HTTP-Anfragen an Geräte im Heimnetz', en: 'HTTP requests to devices in the home network' },
  'mqtt.topic': { de: 'MQTT-Themen {v} am lokalen Broker', en: 'MQTT topics {v} on the local broker' },
  serial: { de: 'Serielles Gerät „{v}“', en: 'Serial device "{v}"' },
};

// keys an administrator confirms with an explicit warning (none at the moment; the former
// http.selfSigned — HTTPS without certificate checks — is gone, see forState)
const WARN = new Set();

/** [{ key, text, warning? }] — one line per capability key (install dialog, confirmation, gateway page). */
function describe(caps, lang) {
  const l = lang === 'en' ? 'en' : 'de';
  return capabilityList(caps).map((key) => {
    const i = key.indexOf(':');
    const kind = i < 0 ? key : key.slice(0, i);
    const v = i < 0 ? '' : key.slice(i + 1);
    const t = TEXT[kind] ? TEXT[kind][l] : key;
    return { key, text: t.replace('{v}', v), ...(WARN.has(key) ? { warning: true } : {}) };
  });
}

/**
 * Capabilities as they go to a gateway in `state.plugins[].caps`: only what the gateway knows, from a
 * stored manifest or approval snapshot that may predate a change. Drops `http.selfSigned` (removed —
 * the gateway refuses it; an older install or approval must never switch certificate checks off).
 */
function forState(caps) {
  const c = plainObject(caps) ? caps : {};
  const out = {};
  for (const [k, v] of Object.entries(c)) {
    if (k === 'http') {
      if (plainObject(v) && v.lan === true) out.http = { lan: true };
    } else out[k] = v;
  }
  return out;
}

module.exports = {
  validate, capabilityList, forState, newCapabilities, describe, topicFilterOk, filterCovers, multicastOk,
  MEMORY_MIN, MEMORY_MAX, MEMORY_DEFAULT, SERIAL_NAMES, MQTT_TOPICS_MAX,
};
