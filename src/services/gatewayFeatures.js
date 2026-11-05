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
//
// What a gateway can do is read from its telemetry: `capabilities` (array)
// or, for a gateway that does not report it, its version (≥ MIN_GATEWAY).

const { getDb } = require('../db/connection');
const { isPrivateIpv4 } = require('../utils/validate');
const logger = require('../utils/logger');

const MIN_GATEWAY = '1.21.0';
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
});

// Memory of the parts (MB), contract §6 — guide values for the hint only.
const MEM_MB = { gateway: 80, netwatch: 15, inetq: 10, edge: 50, deconz: 150, mosquitto: 10 };

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
  const allowed = { netwatch: ['enabled', 'portscan'], inetq: ['enabled', 'speedtest', 'targets'], presence: ['enabled'], ups: ['enabled', 'host', 'port', 'name'], notify: ['outage', 'ups'] };
  let any = false;
  for (const [k, v] of Object.entries(p)) {
    if (!allowed[k]) continue; // other keys (lanDiscovery, edge) are handled by the route
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new FeatureError('invalid', `${k}: invalid`);
    for (const [f, val] of Object.entries(v)) {
      if (!allowed[k].includes(f)) throw new FeatureError('invalid', `${k}.${f}: unknown`);
      any = true;
      if (f === 'enabled' || f === 'portscan' || f === 'outage' || (k === 'notify' && f === 'ups')) {
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
  const changed = FEATURE_KEYS.concat(['notify']).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
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
  };
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
  return { netwatch: has('netwatch'), inetq: has('inetq'), presence: has('presence'), ups: has('ups'), version: typeof t.gateway_version === 'string' ? t.gateway_version : null, minGateway: MIN_GATEWAY };
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
  };
}

module.exports = {
  DEFAULTS, MIN_GATEWAY, SPEEDTEST_PLANS, MEM_MB, FeatureError,
  normalize, get, set, applyPatch, configPayload, support, overview, memoryEstimate, boardOf, speedLimit, zigbeeOf,
  needGateway, telemetryOf, gatewayPeer, notifyGateway, publicIpv4,
};
