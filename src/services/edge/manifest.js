'use strict';

// plugin.json `edge` (docs/plugins.md "Edge part"): the part of a plugin that
// runs on a home gateway, next to the devices (container gatecontrol-edge).
// Contract between server and gateway: docs/plugins.md "Edge part" / the
// edge protocol v1. The gateway checks the same rules again before it starts
// anything — this is the server's half.
//
//   "edge": { "entry": "edge/index.js", "minGateway": "1.20.0", "memoryMb": 48,
//     "capabilities": { "udp": { "ports": [5683], "multicast": ["224.0.1.187"], "broadcast": false },
//                       "mdns": { "services": ["_shelly._tcp"] },
//                       "tcp": { "lan": true }, "http": { "lan": true },
//                       "mqtt": { "topics": ["shellies/#"] }, "serial": ["zigbee"] },
//     "optionalCapabilities": { "mqtt": { "topics": ["zigbee2mqtt/#"] },
//                               "tcp": { "lan": true }, "udp": { "ports": [6666, 6667, 7000], "broadcast": true } } }
//
// udp.broadcast (key "udp.broadcast"): gc.lan.udp.send may also go to 255.255.255.255 or the broadcast
// address of a LAN subnet of the gateway — only to the plugin's UDP ports (udp.ports). Needs udp.ports.
//
// optionalCapabilities (since 1.317.0): what the plugin may ask for later, per gateway, when it needs
// it (gc.edge.requestCapability). Validated at install like capabilities, but never part of the
// confirmation that switches the edge part on and never a reason for update_pending — an
// administrator confirms each key on its own (Gateways › Gateway › Edge-Plugins). MQTT topics
// (gateway feature edge-optional-caps) and, since 1.326.0, LAN access over TCP (tcp.lan), UDP ports
// (udp.port:<n>) and UDP broadcast (udp.broadcast) (gateway feature edge-optional-lan): the gateway
// applies them with the next state. Multicast groups, mDNS, HTTP and serial devices stay in capabilities.
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
const EDGE_KEYS = Object.freeze(['entry', 'minGateway', 'memoryMb', 'capabilities', 'optionalCapabilities']);
// what edge.optionalCapabilities may hold (kept narrow on purpose, see above)
const OPTIONAL_CAP_KEYS = Object.freeze(['mqtt', 'tcp', 'udp']);
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

function validateCaps(raw, err, where = 'edge.capabilities') {
  const caps = {};
  if (raw == null) return caps;
  if (!plainObject(raw)) { err(where + ': invalid'); return null; }
  let ok = true;
  const bad = (code) => { err(code); ok = false; };
  for (const k of Object.keys(raw)) if (!CAP_KEYS.includes(k)) bad(where + ': unknown capability ' + k);

  if (raw.udp != null) {
    const u = raw.udp;
    if (!plainObject(u) || !onlyKeys(u, ['ports', 'multicast', 'broadcast'])) bad(where + '.udp: invalid');
    else {
      const ports = u.ports == null ? [] : u.ports;
      const groups = u.multicast == null ? [] : u.multicast;
      if (u.broadcast != null && typeof u.broadcast !== 'boolean') bad(where + '.udp.broadcast: invalid (true or false)');
      const broadcast = u.broadcast === true;
      if (!Array.isArray(ports) || ports.length > UDP_PORTS_MAX || !ports.every((p) => Number.isInteger(p) && p >= 1 && p <= 65535)) {
        bad(where + '.udp.ports: invalid');
      } else if (ports.some((p) => p === 5353)) bad(where + '.udp.ports: 5353 only through capabilities.mdns');
      else if (ports.some((p) => p < 1024)) bad(where + '.udp.ports: below 1024');
      else if (new Set(ports).size !== ports.length) bad(where + '.udp.ports: duplicate');
      if (!Array.isArray(groups) || groups.length > MULTICAST_MAX || !groups.every(multicastOk)) {
        bad(where + '.udp.multicast: invalid (224.0.0.0/4 without 224.0.0.0/24, ≤ ' + MULTICAST_MAX + ')');
      } else if (new Set(groups).size !== groups.length) bad(where + '.udp.multicast: duplicate');
      if (ok && !ports.length && !groups.length && !broadcast) bad(where + '.udp: empty');
      // broadcast only goes to the plugin's own UDP ports (validateOptional allows ports from capabilities)
      else if (ok && broadcast && !ports.length && where === 'edge.capabilities') bad(where + '.udp.broadcast: needs udp.ports');
      if (ok) caps.udp = { ports: ports.slice().sort((x, y) => x - y), multicast: groups.slice(), ...(broadcast ? { broadcast: true } : {}) };
    }
  }
  if (raw.mdns != null) {
    const m = raw.mdns;
    const list = plainObject(m) && onlyKeys(m, ['services']) ? m.services : null;
    if (!Array.isArray(list) || !list.length || list.length > MDNS_MAX || !list.every((s) => typeof s === 'string' && MDNS_RE.test(s))) bad(where + '.mdns: invalid');
    else if (new Set(list).size !== list.length) bad(where + '.mdns: duplicate');
    else caps.mdns = { services: list.slice() };
  }
  if (raw.tcp != null) {
    const v = raw.tcp;
    if (!plainObject(v) || !onlyKeys(v, ['lan']) || typeof v.lan !== 'boolean') bad(where + '.tcp: invalid');
    else if (v.lan) caps.tcp = { lan: true };
  }
  // http: { lan } — HTTPS is always checked on the gateway: fully, or against a pinned certificate
  // (gc.lan.http.request pinSha256, gc.lan.tlsFingerprint). There is no capability to switch the check off.
  if (raw.http != null) {
    const v = raw.http;
    if (plainObject(v) && Object.prototype.hasOwnProperty.call(v, 'selfSigned')) {
      bad(where + '.http.selfSigned: no longer supported — HTTPS to self-signed devices only with a pinned certificate (pinSha256, gc.lan.tlsFingerprint)');
    } else if (!plainObject(v) || !onlyKeys(v, ['lan']) || typeof v.lan !== 'boolean') bad(where + '.http: invalid');
    else if (v.lan) caps.http = { lan: true };
  }
  if (raw.mqtt != null) {
    const m = raw.mqtt;
    const list = plainObject(m) && onlyKeys(m, ['topics']) ? m.topics : null;
    if (!Array.isArray(list) || !list.length || list.length > MQTT_TOPICS_MAX) bad(where + '.mqtt.topics: invalid');
    else if (!list.every(topicFilterOk)) bad(where + '.mqtt.topics: invalid topic (no leading # or +, no $…)');
    else if (new Set(list).size !== list.length) bad(where + '.mqtt.topics: duplicate');
    else caps.mqtt = { topics: list.slice() };
  }
  if (raw.serial != null) {
    const s = raw.serial;
    if (!Array.isArray(s) || !s.length || !s.every((n) => typeof n === 'string' && SERIAL_NAMES.includes(n))) bad(where + '.serial: invalid (known: ' + SERIAL_NAMES.join(', ') + ')');
    else if (new Set(s).size !== s.length) bad(where + '.serial: duplicate');
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
  if (raw.optionalCapabilities != null) {
    const opt = validateOptional(raw.optionalCapabilities, e, caps || {});
    if (opt) out.optionalCapabilities = opt;
  }
  return before.length ? null : out;
}

/** edge.optionalCapabilities: the same form as capabilities, only OPTIONAL_CAP_KEYS, nothing that capabilities already holds. */
function validateOptional(raw, err, caps) {
  const where = 'edge.optionalCapabilities';
  if (!plainObject(raw)) { err(where + ': invalid'); return null; }
  let ok = true;
  for (const k of Object.keys(raw)) {
    if (!OPTIONAL_CAP_KEYS.includes(k)) { err(where + ': ' + k + ' cannot be optional (optional: ' + OPTIONAL_CAP_KEYS.join(', ') + ')'); ok = false; }
  }
  if (!ok) return null;
  const opt = validateCaps(raw, err, where);
  if (!opt) return null;
  if (raw.tcp != null && !opt.tcp) { err(where + '.tcp: only { "lan": true } can be optional'); return null; }
  if (opt.tcp && caps.tcp && caps.tcp.lan) { err(where + '.tcp: already in capabilities'); return null; }
  if (opt.udp) {
    const own = caps.udp ? caps.udp : { ports: [], multicast: [] };
    // multicast groups stay in capabilities (joined when the socket is bound)
    if (opt.udp.multicast.length) { err(where + '.udp.multicast: cannot be optional'); return null; }
    if (opt.udp.ports.some((p) => own.ports.includes(p))) { err(where + '.udp.ports: already in capabilities'); return null; }
    if (own.ports.length + opt.udp.ports.length > UDP_PORTS_MAX) { err(where + '.udp.ports: more than ' + UDP_PORTS_MAX + ' together with capabilities'); return null; }
    if (opt.udp.broadcast && own.broadcast) { err(where + '.udp.broadcast: already in capabilities'); return null; }
    if (opt.udp.broadcast && !own.ports.length && !opt.udp.ports.length) { err(where + '.udp.broadcast: needs udp.ports'); return null; }
  }
  if (opt.mqtt) {
    const required = caps.mqtt ? caps.mqtt.topics : [];
    if (opt.mqtt.topics.some((t) => required.includes(t))) { err(where + '.mqtt.topics: already in capabilities'); return null; }
    // the gateway takes at most MQTT_TOPICS_MAX topics per plugin (state.mqtt.pluginTopics)
    if (required.length + opt.mqtt.topics.length > MQTT_TOPICS_MAX) { err(where + '.mqtt.topics: more than ' + MQTT_TOPICS_MAX + ' together with capabilities'); return null; }
  }
  return opt;
}

/** The optional capability keys a plugin declares (edge.optionalCapabilities), flat and sorted like capabilityList. */
function optionalList(edge) {
  return capabilityList(edge && edge.optionalCapabilities);
}

/** The keys of `approvedList` the edge part still declares as optional (an update may drop one). */
function approvedOptional(edge, approvedList) {
  const ok = new Set(Array.isArray(approvedList) ? approvedList : []);
  return optionalList(edge).filter((k) => ok.has(k));
}

/** capabilities plus the approved optional ones (keys of optionalList) — what a switched-on edge part may use. */
function withOptional(caps, approvedKeys) {
  const out = { ...(plainObject(caps) ? caps : {}) };
  const keys = Array.isArray(approvedKeys) ? approvedKeys : [];
  const topics = keys.filter((k) => k.startsWith('mqtt.topic:')).map((k) => k.slice('mqtt.topic:'.length));
  if (topics.length) {
    const own = out.mqtt && Array.isArray(out.mqtt.topics) ? out.mqtt.topics : [];
    out.mqtt = { topics: [...own, ...topics.filter((t) => !own.includes(t))] };
  }
  if (keys.includes('tcp.lan')) out.tcp = { lan: true };
  const ports = keys.filter((k) => /^udp\.port:\d{1,5}$/.test(k)).map((k) => Number(k.slice('udp.port:'.length)));
  const broadcast = keys.includes('udp.broadcast');
  if (ports.length || broadcast) {
    const u = plainObject(out.udp) ? out.udp : {};
    const own = Array.isArray(u.ports) ? u.ports : [];
    const all = [...own, ...ports.filter((p) => !own.includes(p))].sort((x, y) => x - y);
    out.udp = { ports: all, multicast: Array.isArray(u.multicast) ? u.multicast.slice() : [],
      ...(u.broadcast === true || broadcast ? { broadcast: true } : {}) };
  }
  return out;
}

// the gateway feature (hello gw.features / telemetry.capabilities) that applies an optional key
const OPTIONAL_FEATURE_MQTT = 'edge-optional-caps';
const OPTIONAL_FEATURE_LAN = 'edge-optional-lan';

/** Which gateway feature an optional key needs: edge-optional-caps (MQTT topics) or edge-optional-lan (tcp.lan, udp.port:<n>, udp.broadcast). */
function optionalFeature(key) {
  const k = String(key || '');
  return k === 'tcp.lan' || k === 'udp.broadcast' || k.startsWith('udp.port:') ? OPTIONAL_FEATURE_LAN : OPTIONAL_FEATURE_MQTT;
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
    if (c.udp.broadcast === true) out.push('udp.broadcast');
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
  'udp.broadcast': { de: 'UDP-Broadcast im Heimnetz (nur an die UDP-Ports des Plugins)', en: 'UDP broadcast in the home network (only to the plugin\'s UDP ports)' },
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
  optionalList, approvedOptional, withOptional, optionalFeature, OPTIONAL_CAP_KEYS, OPTIONAL_FEATURE_MQTT, OPTIONAL_FEATURE_LAN,
  MEMORY_MIN, MEMORY_MAX, MEMORY_DEFAULT, SERIAL_NAMES, MQTT_TOPICS_MAX,
};
