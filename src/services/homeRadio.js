'use strict';

// Funk (phase 3c, step 2 — contract "Funk", the gateway's docs/radio.md):
// Zigbee (deCONZ), Bluetooth sensors (passive) and Thread (detection only) of
// a gateway. The gateway finds the sticks, runs deCONZ through a small watcher
// in the deconz service of its compose file and listens to Bluetooth sensors;
// the server keeps the switch, the sensors it reported and which of them the
// administrator took over ("Übernehmen") — only those reach plugins (gc.radio,
// permissions.radio: the Smart Home plugin shows them like its other sensors).
//
//   switch per gateway: gateway_features.settings.radio { zigbee: true|false|null, ble }
//     (services/gatewayFeatures.js), in the config pull as features.radio
//     (zigbee null = automatic: on when a deCONZ radio is found)
//   POST /api/v1/gateway/radio/ble     ingestBle()   the Bluetooth sensors a gateway hears
//   management calls to the gateway (gateways.mgmtCall): /api/radio/status,
//   /api/radio/zigbee/pair, /api/radio/zigbee/unlock, /api/radio/zigbee/retry

const { getDb } = require('../db/connection');
const logger = require('../utils/logger');

const MIN_GATEWAY = '1.25.0';
const MAX_SENSORS = 64;
const KEEP_UNACCEPTED_MS = 24 * 3600 * 1000;
const ONLINE_MS = 30 * 60 * 1000;
const MAC_RE = /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/;
const ZB_MAC_RE = /^([0-9a-f]{2}:){7}[0-9a-f]{2}$/;
const FORMATS = ['bthome', 'atc1441', 'pvvx', 'mibeacon'];
const STICK_KINDS = ['zigbee', 'thread', 'multi', 'bluetooth'];
const ZB_STATES = ['off', 'no_stick', 'unsupported', 'service_missing', 'starting', 'running', 'key_needed', 'error'];
const ZB_SERVICES = ['managed', 'absent', 'image', 'missing'];
const BLE_STATES = ['off', 'no_adapter', 'starting', 'running', 'error'];
// values of a sensor: [min, max] for numbers, 'bool' for flags (everything else is dropped)
const VALUES = {
  temperature: [-60, 120], humidity: [0, 100], battery: [0, 100], pressure: [300, 1200], illuminance: [0, 200000],
  dewpoint: [-60, 100], voltage: [0, 60], pm25: [0, 2000], pm10: [0, 2000], co2: [0, 20000], tvoc: [0, 60000],
  moisture: [0, 100], button: [0, 255], uv: [0, 20], power: [-100000, 100000], energy: [0, 1e7],
  opening: 'bool', door: 'bool', window: 'bool', motion: 'bool', occupancy: 'bool', presence: 'bool',
  moisture_wet: 'bool', smoke: 'bool', battery_low: 'bool', vibration: 'bool', tamper: 'bool', light: 'bool',
};

class RadioError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

function db() { return getDb(); }
function json(s) { try { return s ? JSON.parse(s) : null; } catch { return null; } }
function iso(ms) { return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null; }
function oneOf(v, list, dflt = null) { return list.includes(v) ? v : dflt; }

/** Text without control characters, trimmed, at most n characters ('' for a non-string). */
function clean(v, n) {
  if (typeof v !== 'string') return '';
  let out = '';
  for (const ch of v) { const c = ch.codePointAt(0); out += c < 32 || c === 127 ? ' ' : ch; }
  return out.trim().replace(/\s+/g, ' ').slice(0, n);
}

function isoOrNull(v) {
  if (typeof v !== 'string' || v.length > 40) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

// ─── Settings (part of the gateway's features) ─────────────────────────

/** features.radio of the stored settings (any shape) → { zigbee: true|false|null, ble } */
function normalizeSettings(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  return { zigbee: typeof r.zigbee === 'boolean' ? r.zigbee : null, ble: r.ble === true };
}

function settingsOf(peerId) { return require('./gatewayFeatures').get(peerId).radio; }

/** features.radio of the config pull */
function configPayload(peerId) {
  const s = settingsOf(peerId);
  return { zigbee: s.zigbee, ble: s.ble };
}

// ─── Telemetry (features.radio of the heartbeat, input of the gateway) ─

function cleanError(e) {
  if (!e || typeof e !== 'object') return null;
  const code = typeof e.code === 'string' && /^[a-z0-9_]{1,40}$/.test(e.code) ? e.code : 'error';
  return { code, at: Number.isSafeInteger(e.at) ? e.at : null };
}

/** telemetry.features.radio, checked and cut → the view or null (gateway without the function). */
function telemetryRadio(tel) {
  const r = tel && tel.features && tel.features.radio;
  if (!r || typeof r !== 'object') return null;
  const z = r.zigbee && typeof r.zigbee === 'object' ? r.zigbee : {};
  const b = r.ble && typeof r.ble === 'object' ? r.ble : {};
  const th = r.thread && typeof r.thread === 'object' ? r.thread : {};
  const sticks = (Array.isArray(r.sticks) ? r.sticks : []).slice(0, 8).filter((s) => s && typeof s === 'object' && STICK_KINDS.includes(s.kind)).map((s) => ({
    kind: s.kind, model: clean(s.model, 48) || null, bus: s.bus === 'usb' ? 'usb' : (s.bus === 'uart' ? 'uart' : 'builtin'),
    tty: typeof s.tty === 'string' && /^(tty[A-Z]{3}[0-9]{1,3}|hci[0-9]{1,2})$/.test(s.tty) ? s.tty : null, deconz: s.deconz === true,
  }));
  const recent = (Array.isArray(z.recent) ? z.recent : []).slice(0, 5).filter((d) => d && typeof d === 'object' && typeof d.mac === 'string' && ZB_MAC_RE.test(d.mac)).map((d) => ({
    mac: d.mac, type: d.type === 'light' ? 'light' : 'sensor', name: clean(d.name, 48) || null, model: clean(d.model, 48) || null,
    manufacturer: clean(d.manufacturer, 48) || null, at: isoOrNull(d.at),
  }));
  return {
    sticks,
    zigbee: {
      mode: oneOf(z.mode, ['auto', 'on', 'off'], 'auto'),
      want: z.want === true,
      service: oneOf(z.service, ZB_SERVICES, 'missing'),
      state: oneOf(z.state, ZB_STATES, 'off'),
      model: clean(z.model, 48) || null,
      device: typeof z.device === 'string' && /^tty[A-Z]{3}[0-9]{1,3}$/.test(z.device) ? z.device : null,
      firmware: typeof z.firmware === 'string' && /^0x[0-9a-f]{1,8}$/i.test(z.firmware) ? z.firmware.toLowerCase() : null,
      channel: Number.isInteger(z.channel) && z.channel >= 11 && z.channel <= 26 ? z.channel : null,
      devices: Number.isInteger(z.devices) && z.devices >= 0 && z.devices < 100000 ? z.devices : null,
      permitUntil: isoOrNull(z.permitUntil),
      recent,
      error: cleanError(z.error),
    },
    ble: {
      enabled: b.enabled === true,
      state: oneOf(b.state, BLE_STATES, 'off'),
      mode: oneOf(b.mode, ['legacy', 'extended', 'shared']),
      adapter: b.adapter && typeof b.adapter === 'object' && typeof b.adapter.name === 'string' && /^hci[0-9]{1,2}$/.test(b.adapter.name)
        ? { name: b.adapter.name, bus: b.adapter.bus === 'usb' ? 'usb' : 'builtin', model: clean(b.adapter.model, 48) || null } : null,
      sensors: Number.isInteger(b.sensors) && b.sensors >= 0 ? Math.min(b.sensors, 999) : 0,
      lastAt: isoOrNull(b.lastAt),
      error: cleanError(b.error),
    },
    thread: {
      sticks: Number.isInteger(th.sticks) && th.sticks >= 0 ? Math.min(th.sticks, 8) : 0,
      models: (Array.isArray(th.models) ? th.models : []).slice(0, 4).map((m) => clean(m, 48)).filter(Boolean),
      otbr: false,
    },
  };
}

// ─── Bluetooth sensors (gateway → server) ──────────────────────────────

function cleanValues(v) {
  const out = {};
  if (!v || typeof v !== 'object') return out;
  for (const [k, rule] of Object.entries(VALUES)) {
    if (!(k in v)) continue;
    const x = v[k];
    if (rule === 'bool') { if (typeof x === 'boolean') out[k] = x; continue; }
    if (typeof x === 'number' && Number.isFinite(x) && x >= rule[0] && x <= rule[1]) out[k] = Math.round(x * 1000) / 1000;
  }
  return out;
}

/** One sensor of a report → the stored view or null. */
function cleanSensor(s) {
  if (!s || typeof s !== 'object' || typeof s.mac !== 'string' || !MAC_RE.test(s.mac) || !FORMATS.includes(s.format)) return null;
  const seen = Date.parse(s.seenAt);
  const first = Date.parse(s.firstSeen);
  return {
    mac: s.mac,
    format: s.format,
    encrypted: s.encrypted === true,
    name: clean(s.name, 32) || null,
    values: cleanValues(s.values),
    rssi: Number.isInteger(s.rssi) && s.rssi >= -127 && s.rssi <= 20 ? s.rssi : null,
    seenAt: Number.isFinite(seen) ? seen : null,
    firstSeen: Number.isFinite(first) ? first : null,
  };
}

/** POST /api/v1/gateway/radio/ble { scannedAt, adapter, sensors } — what the gateway hears now (rows it no longer names stay). */
function ingestBle(peerId, body, now = Date.now()) {
  const b = body && typeof body === 'object' ? body : {};
  if (!Array.isArray(b.sensors)) throw new RadioError('invalid', 'sensors must be a list');
  const list = b.sensors.slice(0, MAX_SENSORS).map(cleanSensor).filter(Boolean);
  const d = db();
  let n = 0;
  d.transaction(() => {
    const up = d.prepare(`INSERT INTO gateway_ble_sensors (peer_id, mac, format, encrypted, adv_name, data, rssi, first_seen, seen_at, reported_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(peer_id, mac) DO UPDATE SET format = excluded.format, encrypted = excluded.encrypted,
        adv_name = COALESCE(excluded.adv_name, gateway_ble_sensors.adv_name), data = excluded.data, rssi = excluded.rssi,
        seen_at = MAX(COALESCE(gateway_ble_sensors.seen_at, 0), COALESCE(excluded.seen_at, 0)), reported_at = excluded.reported_at`);
    const seenMac = new Set();
    for (const s of list) {
      if (seenMac.has(s.mac)) continue;
      seenMac.add(s.mac);
      up.run(peerId, s.mac, s.format, s.encrypted ? 1 : 0, s.name, JSON.stringify(s.values), s.rssi, s.firstSeen || now, Math.min(s.seenAt || now, now), now);
      n++;
    }
    // at most 256 rows per gateway: the oldest of the not taken over go first
    d.prepare(`DELETE FROM gateway_ble_sensors WHERE peer_id = ? AND accepted = 0 AND mac NOT IN (
      SELECT mac FROM gateway_ble_sensors WHERE peer_id = ? ORDER BY accepted DESC, seen_at DESC LIMIT 256)`).run(peerId, peerId);
  })();
  return { sensors: n };
}

/** A guess of the model from the format and the address (only for the label). */
function modelOf(r) {
  if (r.format === 'atc1441' || r.format === 'pvvx' || (r.format === 'mibeacon' && r.mac.startsWith('A4:C1:38'))) return 'Xiaomi LYWSD03MMC';
  const n = String(r.adv_name || '');
  if (/^SBHT/i.test(n)) return 'Shelly BLU H&T';
  if (/^SBDW/i.test(n)) return 'Shelly BLU Door/Window';
  if (/^SBMO/i.test(n)) return 'Shelly BLU Motion';
  if (/^SBBT/i.test(n)) return 'Shelly BLU Button';
  if (r.format === 'bthome') return 'BTHome';
  return null;
}

function sensorView(r, now = Date.now()) {
  return {
    mac: r.mac,
    format: r.format,
    encrypted: r.encrypted === 1,
    accepted: r.accepted === 1,
    name: r.label || null,
    advName: r.adv_name || null,
    model: modelOf(r),
    values: json(r.data) || {},
    rssi: r.rssi,
    online: Number.isFinite(r.seen_at) && now - r.seen_at < ONLINE_MS,
    firstSeen: iso(r.first_seen),
    seenAt: iso(r.seen_at),
  };
}

/** The sensors of one gateway: taken over first, then by the last packet. */
function sensorsOf(peerId, now = Date.now()) {
  return db().prepare('SELECT * FROM gateway_ble_sensors WHERE peer_id = ? ORDER BY accepted DESC, seen_at DESC LIMIT 128').all(peerId).map((r) => sensorView(r, now));
}

function needMac(mac) {
  const m = typeof mac === 'string' ? mac.toUpperCase() : '';
  if (!MAC_RE.test(m)) throw new RadioError('invalid', 'invalid sensor address');
  return m;
}

/** "Übernehmen" / rename / give back: { accepted?, name? } → the view. */
function setSensor(peerId, mac, patch) {
  const m = needMac(mac);
  const p = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : null;
  if (!p) throw new RadioError('invalid', 'invalid body');
  const row = db().prepare('SELECT * FROM gateway_ble_sensors WHERE peer_id = ? AND mac = ?').get(peerId, m);
  if (!row) throw new RadioError('not_found', 'no such sensor');
  const sets = [];
  const vals = [];
  if ('accepted' in p) {
    if (typeof p.accepted !== 'boolean') throw new RadioError('invalid', 'accepted must be true or false');
    sets.push('accepted = ?'); vals.push(p.accepted ? 1 : 0);
  }
  if ('name' in p) {
    if (p.name !== null && typeof p.name !== 'string') throw new RadioError('invalid', 'name must be text');
    const n = clean(p.name || '', 60);
    sets.push('label = ?'); vals.push(n || null);
  }
  if (!sets.length) throw new RadioError('invalid', 'nothing to change');
  db().prepare(`UPDATE gateway_ble_sensors SET ${sets.join(', ')} WHERE peer_id = ? AND mac = ?`).run(...vals, peerId, m);
  return sensorView(db().prepare('SELECT * FROM gateway_ble_sensors WHERE peer_id = ? AND mac = ?').get(peerId, m));
}

function removeSensor(peerId, mac) {
  const m = needMac(mac);
  const r = db().prepare('DELETE FROM gateway_ble_sensors WHERE peer_id = ? AND mac = ?').run(peerId, m);
  if (!r.changes) throw new RadioError('not_found', 'no such sensor');
  return { removed: true };
}

/** gc.radio.sensors(): the taken-over sensors of every gateway with Bluetooth on. */
function pluginSensors(now = Date.now()) {
  const rows = db().prepare(`SELECT s.*, p.name AS gw_name FROM gateway_ble_sensors s
    JOIN peers p ON p.id = s.peer_id AND p.enabled = 1 AND p.peer_type = 'gateway'
    WHERE s.accepted = 1 ORDER BY p.name, s.label, s.mac`).all();
  return rows.filter((r) => settingsOf(r.peer_id).ble).map((r) => {
    const v = sensorView(r, now);
    return {
      id: 'ble:' + r.mac.replace(/:/g, '').toLowerCase(), gatewayId: r.peer_id, gateway: r.gw_name, mac: r.mac,
      name: v.name || v.advName || v.model || r.mac, model: v.model, format: v.format, values: v.values,
      battery: Number.isFinite(v.values.battery) ? v.values.battery : null, online: v.online, seenAt: v.seenAt,
    };
  });
}

/** every hour: sensors nobody took over and nobody heard for a day go */
function housekeeping(now = Date.now()) {
  return db().prepare('DELETE FROM gateway_ble_sensors WHERE accepted = 0 AND COALESCE(seen_at, 0) < ?').run(now - KEEP_UNACCEPTED_MS).changes;
}

// ─── Management calls (server → gateway) ───────────────────────────────

function mgmt(peerId, p, body, timeoutMs) {
  return require('./gateways').mgmtCall(peerId, p, body || {}, timeoutMs);
}

function gatewayOf(peerId) { return require('./gatewayFeatures').needGateway(peerId); }

function needSupport(g) {
  const tel = require('./gatewayFeatures').telemetryOf(g);
  if (!supported(tel)) throw new RadioError('gateway_unsupported', 'the gateway is too old for radio (from ' + MIN_GATEWAY + ')');
  return tel;
}

function supported(tel) {
  return !!(tel && Array.isArray(tel.capabilities) && tel.capabilities.includes('radio'));
}

const ANSWERS = { not_running: 'not_running', key_needed: 'key_needed', feature_disabled: 'unavailable', deconz_failed: 'deconz_failed', invalid_request: 'invalid' };

async function zigbeeCall(peerId, p, body) {
  const g = gatewayOf(peerId);
  needSupport(g);
  const r = await mgmt(g.id, p, body, 8000);
  if (!r) throw new RadioError('gateway_unreachable', 'the gateway does not answer');
  if (r.status === 202) return { accepted: true };
  const err = r.body && typeof r.body.error === 'string' ? r.body.error : null;
  throw new RadioError(ANSWERS[err] || 'gateway_error', err || ('gateway answered ' + r.status));
}

/** "Anlernen starten": deCONZ accepts new devices for `seconds` (180). */
function pair(peerId, seconds = 180) {
  const s = Number.isInteger(seconds) && seconds >= 60 && seconds <= 254 ? seconds : 180;
  return zigbeeCall(peerId, '/api/radio/zigbee/pair', { seconds: s });
}
/** deCONZ takes new API keys for 60 s (the Smart Home plugin gets its own). */
function unlock(peerId) { return zigbeeCall(peerId, '/api/radio/zigbee/unlock', {}); }
/** "Erneut versuchen" after key_needed. */
function retry(peerId) { return zigbeeCall(peerId, '/api/radio/zigbee/retry', {}); }

/** The live state of the gateway (the tab "Funk"), null when it does not answer. */
async function liveStatus(peerId) {
  const r = await mgmt(peerId, '/api/radio/status', {}, 4000);
  if (!r || r.status !== 200 || !r.body || !r.body.radio) return null;
  return telemetryRadio({ features: { radio: r.body.radio } });
}

// ─── Overview (card "Funktionen", tab "Funk") ──────────────────────────

/** Does the compose file of this gateway need the deconz service? (a deCONZ stick is there, or Zigbee was switched on) */
function composeWantsZigbee(peerId) {
  try {
    const g = gatewayOf(peerId);
    const t = telemetryRadio(require('./gatewayFeatures').telemetryOf(g));
    if (t && t.sticks.some((s) => s.deconz)) return true;
    return settingsOf(g.id).zigbee === true;
  } catch { return false; }
}

/** What needs one step outside: the compose file (Synology/Linux) when the deconz service is missing. */
function composeHint(t, platform) {
  if (!t) return null;
  const z = t.zigbee;
  const stick = t.sticks.some((s) => s.deconz);
  if (!stick && !z.want) return null;
  if (z.service === 'managed' || z.service === 'image') return null;
  if (platform === 'rpi') return z.service === 'absent' ? null : 'image';
  return 'compose';
}

/** The part of features.overview for the row "Funk" (and the tab badge). */
function overview(peerId) {
  const g = gatewayOf(peerId);
  const gf = require('./gatewayFeatures');
  const tel = gf.telemetryOf(g);
  const s = settingsOf(g.id);
  const t = telemetryRadio(tel);
  const counts = db().prepare('SELECT SUM(accepted = 1) AS accepted, SUM(accepted = 0) AS fresh FROM gateway_ble_sensors WHERE peer_id = ?').get(g.id) || {};
  const platform = platformOf(g.id, tel);
  return {
    zigbee: s.zigbee,
    ble: s.ble,
    enabled: !!(s.ble || (t ? t.zigbee.want : s.zigbee === true)),
    supported: supported(tel),
    minGateway: MIN_GATEWAY,
    platform,
    sticks: t ? t.sticks : [],
    state: t ? { zigbee: t.zigbee.state, service: t.zigbee.service, devices: t.zigbee.devices, model: t.zigbee.model, ble: t.ble.state, bleSensors: t.ble.sensors, thread: t.thread.sticks } : null,
    sensors: { accepted: Number(counts.accepted) || 0, fresh: Number(counts.fresh) || 0 },
    compose: composeHint(t, platform),
  };
}

/** 'rpi' | 'synology' | 'linux' | null — the platform of the gateway (assistant, else the Pi image's profile). */
function platformOf(peerId, tel) {
  const hw = tel && tel.hardware && typeof tel.hardware === 'object' ? tel.hardware : {};
  if (hw.platform === 'rpi-image') return 'rpi';
  try {
    const row = db().prepare('SELECT platform FROM gateway_meta WHERE peer_id = ?').get(peerId);
    const p = row && row.platform;
    if (p === 'rpi' || p === 'synology' || p === 'linux') return p;
    if (p === 'proxmox') return 'linux';
  } catch { /* column missing on an old schema */ }
  return null;
}

/** Everything the tab "Funk" shows. */
async function view(peerId, { live = true } = {}) {
  const g = gatewayOf(peerId);
  const gf = require('./gatewayFeatures');
  const tel = gf.telemetryOf(g);
  let radio = telemetryRadio(tel);
  let fresh = false;
  const alive = db().prepare('SELECT alive FROM gateway_meta WHERE peer_id = ?').get(g.id);
  if (live && supported(tel) && alive && alive.alive === 1) {
    const l = await liveStatus(g.id).catch(() => null);
    if (l) { radio = l; fresh = true; }
  }
  const hw = tel.hardware && typeof tel.hardware === 'object' ? tel.hardware : {};
  let smarthome = null;
  try {
    const st = require('./gatewayWizard').setupStatus(g.id);
    smarthome = st ? { installed: st.smarthome.installed, assigned: st.smarthome.assigned, url: st.smarthome.plugin_url, route: !!(st.deconz && st.deconz.route_id) } : null;
  } catch (e) { logger.debug({ err: e.message }, 'smart home state unavailable'); }
  const platform = platformOf(g.id, tel);
  return {
    gateway: { id: g.id, name: g.name, version: typeof tel.gateway_version === 'string' ? tel.gateway_version : null, model: typeof hw.model === 'string' ? hw.model : null, platform, imageVersion: typeof hw.image_version === 'string' ? hw.image_version : null },
    settings: settingsOf(g.id),
    supported: supported(tel),
    minGateway: MIN_GATEWAY,
    live: fresh,
    radio,
    sensors: sensorsOf(g.id),
    smarthome,
    compose: composeHint(radio, platform),
  };
}

const HOST_CODES = { invalid: 'ERR_INVALID', not_found: 'ERR_NOT_FOUND' };

module.exports = {
  MIN_GATEWAY, MAX_SENSORS, RadioError, HOST_CODES,
  normalizeSettings, configPayload, telemetryRadio, cleanSensor, ingestBle, sensorsOf, setSensor, removeSensor, pluginSensors,
  housekeeping, pair, unlock, retry, liveStatus, overview, view, composeWantsZigbee, composeHint, supported, platformOf,
};
