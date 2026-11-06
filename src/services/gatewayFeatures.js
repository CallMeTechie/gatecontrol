'use strict';

// Feature switches of a home gateway (phase 3a: network watch, internet
// quality, presence over the home network, UPS status) — stored per gateway
// in gateway_features.settings (migration 128), sent to the gateway in the
// config pull as `features` (gateways.getGatewayConfig; part of the config
// hash, see computeConfigHash there) and shown in the card "Funktionen dieses
// Gateways" of the overview tab with hints about the hardware.
//
//   features (config pull, docs: phase 3a contract §1)
//     netwatch { enabled, portscan }
//     inetq    { enabled, speedtest: 'off'|'4x'|'hourly', targets? }
//     presence { enabled, macs }          macs: only of people who agreed themselves
//     ups      { enabled, host, port, name }
//     timezone 'Europe/Berlin'         phase 3b: the server's time zone (local
//                                       times of the gateway: port scan, speed
//                                       test, the DNS profiles' times)
//     dns      { enabled, … }          phase 3b: DNS filter (services/homeDns.js)
//     cache    { enabled, … }          phase 3b: home cache (services/homeCache.js)
//     print    { enabled, manual }      phase 3c: Drucken & Scannen (services/homePrint.js)
//
// What a gateway can do is read from its telemetry: `capabilities` (array)
// or, for a gateway that does not report it, its version (≥ MIN_GATEWAY).

const { getDb } = require('../db/connection');
const { isPrivateIpv4 } = require('../utils/validate');
const logger = require('../utils/logger');

const MIN_GATEWAY = '1.21.0';
// phase 3b (DNS filter, home cache): the gateway release after 1.21.0
const MIN_GATEWAY_3B = '1.22.0';
// phase 3c, step 1 (Drucken & Scannen): only by the capability `print` — the version is the hint
const MIN_GATEWAY_PRINT = '1.24.0';
const FEATURE_KEYS = ['netwatch', 'inetq', 'presence', 'ups'];
const SPEEDTEST_PLANS = ['off', '4x', 'hourly'];
const UPS_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
const TARGETS_MAX = 4;

const DEFAULTS = Object.freeze({
  netwatch: { enabled: true, portscan: true },
  inetq: { enabled: true, speedtest: '4x', targets: [] },
  presence: { enabled: true },
  ups: { enabled: false, host: '', port: 3493, name: null },
  notify: { outage: true, ups: true },
  print: { enabled: false, manual: [] },
});

// Memory of the parts (MB), contract §6 — guide values for the hint only.
const MEM_MB = { gateway: 80, netwatch: 15, inetq: 10, edge: 50, deconz: 150, mosquitto: 10, dns: 25, cache: 10, print: 20 };
// the DNS filter keeps its lists in memory as sorted 53-bit hashes: 8 bytes per entry
// (gateway side 1: 25 MB guide value with typical lists, measured +3 … 20 MB)
const DNS_BYTES_PER_ENTRY = 8;

class FeatureError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

function db() { return getDb(); }
function bool(v, d) { return typeof v === 'boolean' ? v : d; }
function json(s) { try { return s ? JSON.parse(s) : null; } catch { return null; } }

function publicIpv4(ip) {
  const s = String(ip || '').trim();
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return false;
  const o = m.slice(1).map(Number);
  if (o.some((x) => x > 255)) return false;
  if (isPrivateIpv4(s) || o[0] === 0 || o[0] === 127 || o[0] >= 224 || (o[0] === 169 && o[1] === 254) || (o[0] === 100 && o[1] >= 64 && o[1] <= 127)) return false;
  return true;
}

/** Stored settings (any shape) → the complete, valid settings object. */
function normalize(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const nw = r.netwatch || {};
  const iq = r.inetq || {};
  const pr = r.presence || {};
  const up = r.ups || {};
  const no = r.notify || {};
  const host = typeof up.host === 'string' && isPrivateIpv4(up.host.trim()) ? up.host.trim() : '';
  const port = Number.isInteger(up.port) && up.port >= 1 && up.port <= 65535 ? up.port : 3493;
  const targets = Array.isArray(iq.targets) ? [...new Set(iq.targets.filter((x) => typeof x === 'string' && publicIpv4(x)).map((x) => x.trim()))].slice(0, TARGETS_MAX).sort() : [];
  return {
    netwatch: { enabled: bool(nw.enabled, DEFAULTS.netwatch.enabled), portscan: bool(nw.portscan, DEFAULTS.netwatch.portscan) },
    inetq: { enabled: bool(iq.enabled, DEFAULTS.inetq.enabled), speedtest: SPEEDTEST_PLANS.includes(iq.speedtest) ? iq.speedtest : DEFAULTS.inetq.speedtest, targets },
    presence: { enabled: bool(pr.enabled, DEFAULTS.presence.enabled) },
    ups: { enabled: bool(up.enabled, false) && !!host, host, port, name: typeof up.name === 'string' && UPS_NAME_RE.test(up.name) ? up.name : null },
    notify: { outage: bool(no.outage, DEFAULTS.notify.outage), ups: bool(no.ups, DEFAULTS.notify.ups) },
    print: require('./homePrint').normalizeSettings(r.print),
  };
}

function row(peerId) {
  return db().prepare('SELECT * FROM gateway_features WHERE peer_id = ?').get(peerId) || null;
}

/** The settings of a gateway (defaults when it never had any). */
function get(peerId) {
  const r = row(peerId);
  return normalize(r ? json(r.settings) : null);
}

function gatewayPeer(peerId) {
  const id = Number(peerId);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return db().prepare(`SELECT p.id, p.name, gm.last_health FROM peers p JOIN gateway_meta gm ON gm.peer_id = p.id
    WHERE p.id = ? AND p.peer_type = 'gateway' AND p.enabled = 1`).get(id) || null;
}

function needGateway(peerId) {
  const g = gatewayPeer(peerId);
  if (!g) throw new FeatureError('not_found', 'gateway not found');
  return g;
}

function telemetryOf(g) {
  const h = json(g && g.last_health) || {};
  return h.telemetry && typeof h.telemetry === 'object' ? h.telemetry : {};
}

/**
 * Validate a change from the admin API and merge it into the stored settings.
 * Unknown keys or wrong types → FeatureError('invalid').
 * @returns {{ before, after }}
 */
function applyPatch(current, patch) {
  const p = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : null;
  if (!p) throw new FeatureError('invalid', 'invalid body');
  const out = JSON.parse(JSON.stringify(current));
  const allowed = { netwatch: ['enabled', 'portscan'], inetq: ['enabled', 'speedtest', 'targets'], presence: ['enabled'], ups: ['enabled', 'host', 'port', 'name'], notify: ['outage', 'ups'], print: ['enabled', 'manual'] };
  let any = false;
  for (const [k, v] of Object.entries(p)) {
    if (!allowed[k]) continue; // other keys (lanDiscovery, edge) are handled by the route
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new FeatureError('invalid', `${k}: invalid`);
    for (const [f, val] of Object.entries(v)) {
      if (!allowed[k].includes(f)) throw new FeatureError('invalid', `${k}.${f}: unknown`);
      any = true;
      if (k === 'print' && f === 'manual') {
        if (!Array.isArray(val) || val.length > 16 || !val.every((x) => typeof x === 'string' && isPrivateIpv4(x.trim()))) {
          throw new FeatureError('invalid_host', 'print.manual: up to 16 private IPv4 addresses (RFC 1918)');
        }
        out.print.manual = [...new Set(val.map((x) => x.trim()))];
      } else if (f === 'enabled' || f === 'portscan' || f === 'outage' || (k === 'notify' && f === 'ups')) {
        if (typeof val !== 'boolean') throw new FeatureError('invalid', `${k}.${f}: must be true or false`);
        out[k][f] = val;
      } else if (f === 'speedtest') {
        if (!SPEEDTEST_PLANS.includes(val)) throw new FeatureError('invalid', 'inetq.speedtest: off, 4x or hourly');
        out.inetq.speedtest = val;
      } else if (f === 'targets') {
        if (!Array.isArray(val) || val.length > TARGETS_MAX || !val.every((x) => typeof x === 'string' && publicIpv4(x))) {
          throw new FeatureError('invalid', `inetq.targets: up to ${TARGETS_MAX} public IPv4 addresses`);
        }
        out.inetq.targets = val.map((x) => x.trim());
      } else if (f === 'host') {
        const h = typeof val === 'string' ? val.trim() : null;
        if (h === null || (h !== '' && !isPrivateIpv4(h))) throw new FeatureError('invalid_host', 'ups.host: a private IPv4 address (RFC 1918)');
        out.ups.host = h;
      } else if (f === 'port') {
        if (!Number.isInteger(val) || val < 1 || val > 65535) throw new FeatureError('invalid', 'ups.port: 1…65535');
        out.ups.port = val;
      } else if (f === 'name') {
        if (val !== null && !(typeof val === 'string' && (val.trim() === '' || UPS_NAME_RE.test(val.trim())))) throw new FeatureError('invalid', 'ups.name: letters, digits, . _ -');
        out.ups.name = val && val.trim() ? val.trim() : null;
      }
    }
  }
  if (!any) throw new FeatureError('invalid', 'nothing to change');
  if (out.ups.enabled && !out.ups.host) throw new FeatureError('ups_host_required', 'ups.host is needed to switch the UPS status on');
  return normalize(out);
}

/** Store new settings → the normalised settings; the gateway is told to pull its config. */
function set(peerId, patch, { ip, user } = {}) {
  const g = needGateway(peerId);
  const before = get(g.id);
  const after = applyPatch(before, patch);
  db().prepare(`INSERT INTO gateway_features (peer_id, settings, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(peer_id) DO UPDATE SET settings = excluded.settings, updated_at = excluded.updated_at`)
    .run(g.id, JSON.stringify(after), Date.now());
  const changed = FEATURE_KEYS.concat(['notify', 'print']).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
  if (changed.length) {
    try {
      require('./activity').log('gateway_features_changed', `Gateway features changed on "${g.name}" (${changed.join(', ')})`, {
        source: 'admin', ipAddress: ip, severity: 'info', details: { peer_id: g.id, ...(user ? { user } : {}), changed, features: after },
      });
    } catch (e) { logger.debug({ err: e.message }, 'gateway features activity not written'); }
    notifyGateway(g.id);
  }
  return after;
}

/** Tell the gateway its config changed (best-effort, the next poll covers it). */
function notifyGateway(peerId) {
  try {
    require('./gateways').notifyConfigChanged(peerId).catch(() => {});
  } catch (e) { logger.debug({ err: e.message, peerId }, 'config-changed push not sent'); }
}

/**
 * `features` of the config pull. Presence MACs only of devices that count
 * for presence and whose owner agreed (homePresence.macsFor).
 */
function configPayload(peerId) {
  const s = get(peerId);
  let macs = [];
  if (s.netwatch.enabled && s.presence.enabled) {
    try { macs = require('./homePresence').macsFor(peerId); } catch (e) { logger.warn({ err: e.message, peerId }, 'presence macs unavailable'); macs = []; }
  }
  return {
    netwatch: { enabled: s.netwatch.enabled, portscan: s.netwatch.portscan },
    inetq: { enabled: s.inetq.enabled, speedtest: s.inetq.speedtest, ...(s.inetq.targets.length ? { targets: s.inetq.targets.slice() } : {}) },
    presence: { enabled: s.netwatch.enabled && s.presence.enabled, macs },
    ups: { enabled: s.ups.enabled, host: s.ups.host, port: s.ups.port, name: s.ups.name },
    // phase 3b (contract server side 1–3)
    timezone: timezone(),
    dns: part(peerId, 'dns', () => require('./homeDns').configPayload(peerId)),
    cache: part(peerId, 'cache', () => require('./homeCache').configPayload(peerId)),
    // phase 3c: Drucken & Scannen
    print: part(peerId, 'print', () => require('./homePrint').configPayload(peerId)),
  };
}

function validZone(tz) {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

let tzWarned = false;

/**
 * The server's IANA time zone, 'UTC' when unknown. The TZ variable of the
 * server container comes first (that is what the admin sets, e.g.
 * TZ=Europe/Berlin; a leading ':' as in TZ=:Europe/Berlin is allowed), then
 * the zone the runtime reports. A failure is logged once instead of being
 * swallowed, so a wrong "UTC" can be traced.
 */
function timezone() {
  const env = typeof process.env.TZ === 'string' ? process.env.TZ.trim().replace(/^:/, '') : '';
  if (validZone(env)) return env;
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (validZone(tz)) return tz;
  } catch (e) {
    if (!tzWarned) { tzWarned = true; logger.warn({ err: e.message }, 'server time zone could not be read; the gateways get UTC'); }
  }
  if (env && !tzWarned) { tzWarned = true; logger.warn({ tz: env }, 'TZ of the server is not a valid IANA time zone; the gateways get UTC'); }
  return 'UTC';
}

function part(peerId, name, fn) {
  try { return fn(); } catch (e) {
    logger.error({ err: e.message, peerId }, `features.${name} not built — sent as switched off`);
    return { enabled: false };
  }
}

// ─── What the gateway supports ─────────────────────────────────────────

function versionAtLeast(v, min) {
  try {
    const semver = require('./plugins/semver');
    return typeof v === 'string' && semver.valid(v.replace(/^v/, '')) ? semver.compare(v.replace(/^v/, ''), min) >= 0 : false;
  } catch { return false; }
}

/** { netwatch, inetq, presence, ups, version, minGateway } from the telemetry. */
function support(tel) {
  const t = tel && typeof tel === 'object' ? tel : {};
  const caps = Array.isArray(t.capabilities) ? t.capabilities.filter((x) => typeof x === 'string') : null;
  const byVersion = versionAtLeast(t.gateway_version, MIN_GATEWAY);
  const has = (k) => (caps ? caps.includes(k) : byVersion);
  // phase 3b: DNS filter and home cache from MIN_GATEWAY_3B on (or named in the capabilities)
  const by3b = versionAtLeast(t.gateway_version, MIN_GATEWAY_3B);
  const has3b = (k) => (caps && caps.includes(k)) || by3b;
  return {
    netwatch: has('netwatch'), inetq: has('inetq'), presence: has('presence'), ups: has('ups'), dns: has3b('dns'), cache: has3b('cache'),
    // phase 3c: only a gateway that names `print` (every gateway since 1.21.0 reports its capabilities)
    print: !!(caps && caps.includes('print')),
    version: typeof t.gateway_version === 'string' ? t.gateway_version : null, minGateway: MIN_GATEWAY, minGateway3b: MIN_GATEWAY_3B, minGatewayPrint: MIN_GATEWAY_PRINT,
  };
}

// ─── Hardware hints (contract §6) ──────────────────────────────────────

function zigbeeOf(tel) {
  const hw = tel && tel.hardware;
  const r = hw && Array.isArray(hw.radios) ? hw.radios.find((x) => x && x.kind === 'zigbee' && (x.detected || x.enabled)) : null;
  return r ? { type: typeof r.type === 'string' ? r.type : null, device: typeof r.device === 'string' ? r.device : null, enabled: r.enabled === true, detected: r.detected === true } : null;
}

/** 'pi3bplus' | 'pi3' | 'pi_zero' | 'pi4' | 'pi5' | 'other' from the board name. */
function boardOf(model) {
  const m = String(model || '');
  if (/Raspberry Pi 3 Model B Plus|Raspberry Pi 3 B\+/i.test(m)) return 'pi3bplus';
  if (/Raspberry Pi Zero/i.test(m)) return 'pi_zero';
  if (/Raspberry Pi 3|Raspberry Pi 2|Raspberry Pi Model B/i.test(m)) return 'pi3';
  if (/Raspberry Pi 4|Raspberry Pi 400|Compute Module 4/i.test(m)) return 'pi4';
  if (/Raspberry Pi 5|Compute Module 5/i.test(m)) return 'pi5';
  return 'other';
}

/** The speed a board can measure at most (null: no limit worth a hint). */
function speedLimit(board) {
  if (board === 'pi3bplus') return { key: 'pi3bplus', mbps: 300 };
  if (board === 'pi3') return { key: 'pi3', mbps: 95 };
  if (board === 'pi_zero') return { key: 'pi_zero', mbps: null };
  return null;
}

function edgeMemory(peerId) {
  try {
    const store = require('./edge/store');
    const s = store.settings(peerId);
    if (!s.edgeEnabled) return { edge: false, mqtt: false, plugins: 0, pluginsMb: 0 };
    const reg = require('./plugins/registry');
    let mb = 0;
    let n = 0;
    for (const a of store.assignmentsOfGateway(peerId)) {
      if (!a.enabled) continue;
      const p = reg.get(a.pluginId);
      const m = p && p.manifest && p.manifest.edge ? Number(p.manifest.edge.memoryMb) || 0 : 0;
      mb += m; n++;
    }
    return { edge: true, mqtt: !!s.mqttEnabled, plugins: n, pluginsMb: mb };
  } catch { return { edge: false, mqtt: false, plugins: 0, pluginsMb: 0 }; }
}

/**
 * RAM estimate for the switched-on parts against the memory of the board.
 * @returns {{ usedMb, totalMb|null, level: 'ok'|'tight'|'too_much'|null, parts: [{ key, mb }] }}
 */
function memoryEstimate(peerId, s, tel) {
  const parts = [{ key: 'gateway', mb: MEM_MB.gateway }];
  if (s.netwatch.enabled) parts.push({ key: 'netwatch', mb: MEM_MB.netwatch });
  if (s.inetq.enabled) parts.push({ key: 'inetq', mb: MEM_MB.inetq });
  const e = edgeMemory(peerId);
  if (e.edge) parts.push({ key: 'edge', mb: MEM_MB.edge + e.pluginsMb, plugins: e.plugins });
  if (e.edge && e.mqtt) parts.push({ key: 'mosquitto', mb: MEM_MB.mosquitto });
  const z = zigbeeOf(tel);
  if (z && (z.enabled || z.detected)) parts.push({ key: 'deconz', mb: MEM_MB.deconz });
  // phase 3b: the DNS filter with the entries of the lists its profiles use, the home cache
  try {
    const dns = require('./homeDns').get(peerId);
    if (dns.enabled) {
      const cat = require('./homeDnsCatalog');
      const used = new Set(dns.profiles.flatMap((p) => p.lists));
      const entries = cat.LISTS.filter((l) => used.has(l.id)).reduce((a, l) => a + l.entries, 0);
      parts.push({ key: 'dns', mb: MEM_MB.dns + Math.round((entries * DNS_BYTES_PER_ENTRY) / 1048576), entries });
    }
    if (require('./homeCache').get(peerId).enabled) parts.push({ key: 'cache', mb: MEM_MB.cache });
  } catch (e) { logger.debug({ err: e.message }, 'phase 3b memory parts unavailable'); }
  // phase 3c: Drucken & Scannen (discovery, IPP/eSCL, a page or a job in memory at a time)
  if (s.print && s.print.enabled) parts.push({ key: 'print', mb: MEM_MB.print });
  const usedMb = parts.reduce((a, p) => a + p.mb, 0);
  const total = Number((tel.hardware && tel.hardware.mem_total) || tel.mem_total);
  const totalMb = Number.isFinite(total) && total > 0 ? Math.round(total / (1024 * 1024)) : null;
  let level = null;
  if (totalMb) {
    const r = usedMb / totalMb;
    level = r > 0.75 ? 'too_much' : r > 0.5 ? 'tight' : 'ok';
  }
  return { usedMb, totalMb, level, parts };
}

function printPart(peerId) {
  try { return require('./homePrint').overview(peerId); } catch (e) { logger.debug({ err: e.message }, 'print overview unavailable'); return null; }
}

/** Everything the card "Funktionen dieses Gateways" shows. */
function overview(peerId) {
  const g = needGateway(peerId);
  const tel = telemetryOf(g);
  const s = get(g.id);
  const hw = tel.hardware && typeof tel.hardware === 'object' ? tel.hardware : {};
  const board = boardOf(hw.model);
  let lan = null;
  try {
    const d = require('./gateways').getDiscoverySettings(g.id);
    const licensed = require('./license').hasFeature('gateway_lan_discovery');
    lan = { available: tel.lan_discovery === true, licensed, enabled: !!(d && d.enabled) };
  } catch { lan = null; }
  let edge = null;
  try { const es = require('./edge/store').settings(g.id); edge = { enabled: es.edgeEnabled, mqtt: es.mqttEnabled }; } catch { edge = null; }
  const z = zigbeeOf(tel);
  let dns = null;
  let cache = null;
  try {
    const hd = require('./homeDns');
    const d = hd.get(g.id);
    const t = hd.telemetryDns(tel);
    dns = { enabled: d.enabled, profiles: d.profiles.length, state: t ? t.state : null, outage: hd.outageOf(g.id) };
    const c = require('./homeCache').get(g.id);
    cache = { enabled: c.enabled, maxBytes: c.maxBytes, path: c.path };
  } catch (e) { logger.debug({ err: e.message }, 'phase 3b overview parts unavailable'); }
  const tz = timezone();
  // the other gateways of the same Heimnetz (pool or same LAN + router): the
  // DNS filter and the home cache hold for them as well (tab "Funktionen")
  let home = [];
  try {
    const ids = require('./homeNetwork').homeOf(g.id).filter((x) => x !== g.id);
    if (ids.length) {
      home = db().prepare(`SELECT id, name FROM peers WHERE id IN (${ids.map(() => '?').join(',')}) AND enabled = 1 ORDER BY name COLLATE NOCASE`).all(...ids);
    }
  } catch (e) { logger.debug({ err: e.message }, 'home network of the gateway unavailable'); }
  return {
    id: g.id,
    name: g.name,
    features: s,
    support: support(tel),
    hardware: {
      model: typeof hw.model === 'string' ? hw.model : null,
      board,
      cores: Number.isInteger(hw.cpu_cores) ? hw.cpu_cores : (Number.isInteger(tel.cpu_cores) ? tel.cpu_cores : null),
      memTotal: Number(hw.mem_total || tel.mem_total) || null,
      storageFree: hw.storage && Number(hw.storage.free) ? Number(hw.storage.free) : null,
    },
    speedLimit: speedLimit(board),
    memory: memoryEstimate(g.id, s, tel),
    lanDiscovery: lan,
    edge,
    zigbee: z,
    dns,
    cache,
    print: printPart(g.id),
    timezone: { tz, utc: tz === 'UTC' || tz === 'Etc/UTC' },
    home,
  };
}

module.exports = {
  DEFAULTS, MIN_GATEWAY, MIN_GATEWAY_3B, MIN_GATEWAY_PRINT, SPEEDTEST_PLANS, MEM_MB, FeatureError, timezone,
  normalize, get, set, applyPatch, configPayload, support, overview, memoryEstimate, boardOf, speedLimit, zigbeeOf,
  needGateway, telemetryOf, gatewayPeer, notifyGateway, publicIpv4,
};
