'use strict';

// Funk (phase 3c, step 2 — contract "Funk", the gateway's docs/radio.md):
// Zigbee (deCONZ), Bluetooth sensors (passive) and Thread (detection only) of
// a gateway. The gateway finds the sticks, runs deCONZ through a small watcher
// in the deconz service of its compose file and listens to Bluetooth sensors;
// the server keeps the switch, the sensors it reported and which of them the
// administrator took over ("Übernehmen") — only those reach plugins (gc.radio,
// permissions.radio: the Smart Home plugin shows them like its other sensors).
//
//   switch per gateway: gateway_features.settings.radio { zigbee: true|false|null, ble, stack, thread }
//     (services/gatewayFeatures.js), in the config pull as features.radio
//     (zigbee null = automatic: on when a deCONZ radio is found; stack 'deconz' | 'zigbee2mqtt';
//     stack, thread and bleKeys — the stand of the sensor keys — only when not the default,
//     so the config hash of a gateway without them stays as it was)
//   POST /api/v1/gateway/radio/ble       ingestBle()     the Bluetooth sensors a gateway hears
//   POST /api/v1/gateway/radio/zigbee    ingestZigbee()  the devices of its zigbee2mqtt (complete list)
//   GET  /api/v1/gateway/radio/ble/keys  keysFor()       keys of encrypted sensors (never in the config pull)
//   management calls to the gateway (gateways.mgmtCall): /api/radio/status,
//   /api/radio/zigbee/pair, /api/radio/zigbee/unlock, /api/radio/zigbee/retry,
//   /api/radio/zigbee/remove, /api/radio/zigbee/set, /api/radio/thread/form,
//   /api/radio/thread/join, /api/radio/thread/dataset
//
// A stick serves one radio: the gateway gives one to Zigbee (the chosen stack)
// first, then another to Thread (telemetry sticks[].use). The administrator can
// set a stick by hand ("Automatisch (Standard)" / Zigbee / Thread / "nicht
// verwenden", settings.radio.sticks, PUT /:id/radio/sticks): the choice wins,
// keyed by the stick's stable id (its /dev/serial/by-id name or USB socket,
// never the ttyACM number), in the config pull as features.radio.sticks
// [{ id, use }]; a gateway with the capability radio-stick-assign honours it
// and reports per stick what is chosen (choice), what it serves (use) and a
// hint (note). Conflicts are hints, never bans (stickPlan()). The Smart Home plugin
// gets the devices of zigbee2mqtt through gc.radio.zigbee() / gc.radio.command().

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
const STACKS = ['deconz', 'zigbee2mqtt'];
const STICK_USES = ['deconz', 'zigbee2mqtt', 'thread'];
// the choice per stick (settings.radio.sticks[].use; 'auto' is the default and never stored)
const STICK_CHOICES = ['auto', 'zigbee', 'thread', 'none'];
const STICK_NOTES = ['second', 'radio_off', 'fit', 'no_adapter'];
const STICK_ID_RE = /^[A-Za-z0-9#+.:=@_-]{1,128}$/;
const MAX_STICK_CHOICES = 16;
const Z2M_ADAPTERS = ['ember', 'zstack', 'deconz'];
const Z2M_STATES = ['off', 'no_stick', 'stick_missing', 'unsupported', 'mqtt_missing', 'mqtt_off', 'service_missing', 'starting', 'running', 'error'];
const TH_STATES = ['off', 'no_stick', 'stick_missing', 'stick_busy', 'no_lan', 'service_missing', 'starting', 'no_network', 'detached', 'running', 'error'];
const TH_ROLES = ['disabled', 'detached', 'child', 'router', 'leader'];
const KEY_STATES = ['ok', 'no_key', 'wrong_key', 'unsupported'];
const KEY_RE = /^[0-9a-f]{32}$/;
const TLV_RE = /^[0-9a-f]{20,508}$/;
const MAX_ZIGBEE = 128;
const KEEP_ZIGBEE_MS = 30 * 24 * 3600 * 1000;
const Z_KINDS = ['light', 'plug', 'cover', 'sensor', 'remote', 'climate', 'other'];
// several switched channels (state_l1 …), thermostats and firmware over the air (gateway docs/radio.md "zigbee2mqtt")
const Z_CHANNEL_RE = /^[a-z0-9_]{1,8}$/;
const Z_MAX_CHANNELS = 8;
const Z_MODES = ['off', 'heat', 'auto', 'cool', 'fan_only', 'dry'];
const Z_OTA_STATES = ['idle', 'available', 'updating', 'scheduled'];
const Z_OTA_ERRORS = ['check_failed', 'update_failed'];
const Z_OTA_ACTIONS = ['check', 'update'];
const Z_VERSION_RE = /^[\w.+-]{1,32}$/;
// values of a zigbee2mqtt device besides those of the Bluetooth sensors
const Z_VALUES = { on: 'bool', bri: [0, 100], ct: [100, 1000], pos: [0, 100], linkquality: [0, 255] };
const ZB_STATES = ['off', 'no_stick', 'stick_missing', 'unsupported', 'service_missing', 'starting', 'running', 'key_needed', 'error'];
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

/** The sticks set by hand (any shape) → [{ id, use, model }] — valid ones, the first per id, no 'auto'. */
function normalizeSticks(raw) {
  const out = [];
  const seen = new Set();
  for (const e of Array.isArray(raw) ? raw.slice(0, 64) : []) {
    if (!e || typeof e !== 'object' || typeof e.id !== 'string' || !STICK_ID_RE.test(e.id) || seen.has(e.id)) continue;
    if (!STICK_CHOICES.includes(e.use) || e.use === 'auto') continue;
    seen.add(e.id);
    out.push({ id: e.id, use: e.use, model: clean(e.model, 48) || null });
    if (out.length >= MAX_STICK_CHOICES) break;
  }
  return out;
}

/** radio.sticks of an admin change → the list, or RadioError('invalid'). */
function patchSticks(val) {
  if (!Array.isArray(val) || val.length > MAX_STICK_CHOICES) throw new RadioError('invalid', `radio.sticks: a list of up to ${MAX_STICK_CHOICES} sticks`);
  for (const e of val) {
    if (!e || typeof e !== 'object' || typeof e.id !== 'string' || !STICK_ID_RE.test(e.id) || !STICK_CHOICES.includes(e.use)) {
      throw new RadioError('invalid', 'radio.sticks: { id, use: auto | zigbee | thread | none }');
    }
  }
  return normalizeSticks(val);
}

/** features.radio of the stored settings (any shape) → { zigbee: true|false|null, ble, stack, thread, sticks } */
function normalizeSettings(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  return { zigbee: typeof r.zigbee === 'boolean' ? r.zigbee : null, ble: r.ble === true, stack: oneOf(r.stack, STACKS, 'deconz'), thread: r.thread === true, sticks: normalizeSticks(r.sticks) };
}

function settingsOf(peerId) { return require('./gatewayFeatures').get(peerId).radio; }

/** features.radio of the config pull — stack, thread, sticks and bleKeys only when set (older hashes stay). */
function configPayload(peerId) {
  const s = settingsOf(peerId);
  const out = { zigbee: s.zigbee, ble: s.ble };
  if (s.stack !== 'deconz') out.stack = s.stack;
  if (s.thread) out.thread = true;
  if (s.sticks.length) out.sticks = s.sticks.map((e) => ({ id: e.id, use: e.use }));
  const rev = s.ble ? keysRev(peerId) : null;
  if (rev) out.bleKeys = rev;
  return out;
}

/** Does zigbee2mqtt run for this gateway (chosen and not switched off)? */
function z2mWanted(s) { return s.stack === 'zigbee2mqtt' && s.zigbee !== false; }

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
  const zt = r.zigbee2mqtt && typeof r.zigbee2mqtt === 'object' ? r.zigbee2mqtt : null;
  const sticks = (Array.isArray(r.sticks) ? r.sticks : []).slice(0, 8).filter((s) => s && typeof s === 'object' && STICK_KINDS.includes(s.kind)).map((s) => ({
    kind: s.kind, model: clean(s.model, 48) || null, bus: s.bus === 'usb' ? 'usb' : (s.bus === 'uart' ? 'uart' : 'builtin'),
    tty: typeof s.tty === 'string' && /^(tty[A-Z]{3}[0-9]{1,3}|hci[0-9]{1,2})$/.test(s.tty) ? s.tty : null, deconz: s.deconz === true,
    z2m: oneOf(s.z2m, Z2M_ADAPTERS), thread: s.thread === true, use: oneOf(s.use, STICK_USES),
    // a gateway with radio-stick-assign: the stable id, the choice it honours and its hint
    id: s.kind !== 'bluetooth' && typeof s.id === 'string' && STICK_ID_RE.test(s.id) ? s.id : null,
    idKind: oneOf(s.idKind, ['serial', 'port', 'uart']),
    choice: oneOf(s.choice, STICK_CHOICES),
    note: oneOf(s.note, STICK_NOTES),
  }));
  const missing = (Array.isArray(r.missing) ? r.missing : []).slice(0, 8)
    .filter((m) => m && typeof m === 'object' && typeof m.id === 'string' && STICK_ID_RE.test(m.id) && (m.use === 'zigbee' || m.use === 'thread'))
    .map((m) => ({ id: m.id, use: m.use }));
  const recentOf = (list) => (Array.isArray(list) ? list : []).slice(0, 5).filter((d) => d && typeof d === 'object' && typeof d.mac === 'string' && ZB_MAC_RE.test(d.mac)).map((d) => ({
    mac: d.mac, type: d.type === 'light' ? 'light' : 'sensor', name: clean(d.name, 48) || null, model: clean(d.model, 48) || null,
    manufacturer: clean(d.manufacturer, 48) || null, at: isoOrNull(d.at),
  }));
  const net = th.network && typeof th.network === 'object' ? th.network : null;
  const recent = recentOf(z.recent);
  return {
    stack: oneOf(r.stack, STACKS, 'deconz'),
    sticks,
    missing,
    zigbee: {
      stack: oneOf(z.stack || r.stack, STACKS, 'deconz'),
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
    zigbee2mqtt: zt ? {
      want: zt.want === true,
      service: oneOf(zt.service, ZB_SERVICES, 'missing'),
      state: oneOf(zt.state, Z2M_STATES, 'off'),
      broker: oneOf(zt.broker, ['ok', 'mqtt_off', 'mqtt_missing'], 'mqtt_missing'),
      model: clean(zt.model, 48) || null,
      device: typeof zt.device === 'string' && /^tty[A-Z]{3}[0-9]{1,3}$/.test(zt.device) ? zt.device : null,
      adapter: oneOf(zt.adapter, Z2M_ADAPTERS),
      version: typeof zt.version === 'string' && /^[0-9][0-9a-z.+-]{0,23}$/i.test(zt.version) ? zt.version : null,
      firmware: clean(zt.firmware, 32) || null,
      channel: Number.isInteger(zt.channel) && zt.channel >= 11 && zt.channel <= 26 ? zt.channel : null,
      devices: Number.isInteger(zt.devices) && zt.devices >= 0 && zt.devices < 100000 ? zt.devices : null,
      permitUntil: isoOrNull(zt.permitUntil),
      recent: recentOf(zt.recent),
      error: cleanError(zt.error),
    } : null,
    ble: {
      enabled: b.enabled === true,
      state: oneOf(b.state, BLE_STATES, 'off'),
      mode: oneOf(b.mode, ['legacy', 'extended', 'shared']),
      adapter: b.adapter && typeof b.adapter === 'object' && typeof b.adapter.name === 'string' && /^hci[0-9]{1,2}$/.test(b.adapter.name)
        ? { name: b.adapter.name, bus: b.adapter.bus === 'usb' ? 'usb' : 'builtin', model: clean(b.adapter.model, 48) || null } : null,
      sensors: Number.isInteger(b.sensors) && b.sensors >= 0 ? Math.min(b.sensors, 999) : 0,
      keys: Number.isInteger(b.keys) && b.keys >= 0 ? Math.min(b.keys, 64) : null,
      lastAt: isoOrNull(b.lastAt),
      error: cleanError(b.error),
    },
    thread: {
      sticks: Number.isInteger(th.sticks) && th.sticks >= 0 ? Math.min(th.sticks, 8) : 0,
      models: (Array.isArray(th.models) ? th.models : []).slice(0, 4).map((m) => clean(m, 48)).filter(Boolean),
      otbr: th.otbr === true,
      // a gateway with the border router (capability radio-stacks) names its state; older ones only detect
      supported: typeof th.state === 'string',
      want: th.want === true,
      service: oneOf(th.service, ZB_SERVICES, 'missing'),
      state: oneOf(th.state, TH_STATES, 'off'),
      role: oneOf(th.role, TH_ROLES),
      model: clean(th.model, 48) || null,
      device: typeof th.device === 'string' && /^tty[A-Z]{3}[0-9]{1,3}$/.test(th.device) ? th.device : null,
      network: net ? {
        name: clean(net.name, 16) || null,
        channel: Number.isInteger(net.channel) && net.channel >= 11 && net.channel <= 26 ? net.channel : null,
        panId: Number.isInteger(net.panId) && net.panId >= 0 && net.panId <= 0xffff ? net.panId : null,
        extPanId: typeof net.extPanId === 'string' && /^[0-9a-f]{16}$/.test(net.extPanId) ? net.extPanId : null,
      } : null,
      routers: Number.isInteger(th.routers) && th.routers >= 0 && th.routers < 100 ? th.routers : null,
      forwarding: typeof th.forwarding === 'boolean' ? th.forwarding : null,
      error: cleanError(th.error),
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
    keyState: oneOf(s.keyState, KEY_STATES),
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
    const up = d.prepare(`INSERT INTO gateway_ble_sensors (peer_id, mac, format, encrypted, key_state, adv_name, data, rssi, first_seen, seen_at, reported_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(peer_id, mac) DO UPDATE SET format = excluded.format, encrypted = excluded.encrypted, key_state = excluded.key_state,
        adv_name = COALESCE(excluded.adv_name, gateway_ble_sensors.adv_name), data = excluded.data, rssi = excluded.rssi,
        seen_at = MAX(COALESCE(gateway_ble_sensors.seen_at, 0), COALESCE(excluded.seen_at, 0)), reported_at = excluded.reported_at`);
    const seenMac = new Set();
    for (const s of list) {
      if (seenMac.has(s.mac)) continue;
      seenMac.add(s.mac);
      up.run(peerId, s.mac, s.format, s.encrypted ? 1 : 0, s.keyState, s.name, JSON.stringify(s.values), s.rssi, s.firstSeen || now, Math.min(s.seenAt || now, now), now);
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
    hasKey: !!r.key_enc,
    keyState: r.key_state || null,
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
  if ('key' in p) {
    // the key of an encrypted sensor (BTHome v2 / Xiaomi bindkey): 32 hex digits, stored encrypted, never shown again
    if (p.key !== null && typeof p.key !== 'string') throw new RadioError('invalid', 'key must be 32 hex digits');
    const k = typeof p.key === 'string' ? p.key.trim().toLowerCase().replace(/[\s:-]/g, '') : '';
    if (k && !KEY_RE.test(k)) throw new RadioError('invalid_key', 'key must be 32 hex digits');
    sets.push('key_enc = ?'); vals.push(k ? require('../utils/crypto').encrypt(k) : null);
    if (!k) { sets.push('key_state = ?'); vals.push(null); }
  }
  if (!sets.length) throw new RadioError('invalid', 'nothing to change');
  db().prepare(`UPDATE gateway_ble_sensors SET ${sets.join(', ')} WHERE peer_id = ? AND mac = ?`).run(...vals, peerId, m);
  // a new key: the config pull names a new stand (features.radio.bleKeys), the gateway fetches the keys
  if ('key' in p) require('./gatewayFeatures').notifyGateway(peerId);
  return sensorView(db().prepare('SELECT * FROM gateway_ble_sensors WHERE peer_id = ? AND mac = ?').get(peerId, m));
}

function removeSensor(peerId, mac) {
  const m = needMac(mac);
  const had = db().prepare('SELECT key_enc FROM gateway_ble_sensors WHERE peer_id = ? AND mac = ?').get(peerId, m);
  const r = db().prepare('DELETE FROM gateway_ble_sensors WHERE peer_id = ? AND mac = ?').run(peerId, m);
  if (!r.changes) throw new RadioError('not_found', 'no such sensor');
  if (had && had.key_enc) require('./gatewayFeatures').notifyGateway(peerId);
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

// ─── Keys of encrypted Bluetooth sensors (gateway pulls them) ──────────

/** The stand of the keys of a gateway (hex) or null without keys — the config pull names only this. */
function keysRev(peerId) {
  const rows = db().prepare('SELECT mac, key_enc FROM gateway_ble_sensors WHERE peer_id = ? AND key_enc IS NOT NULL ORDER BY mac').all(peerId);
  if (!rows.length) return null;
  const h = require('node:crypto').createHash('sha256');
  for (const r of rows) h.update(r.mac + '\n' + r.key_enc + '\n');
  return h.digest('hex').slice(0, 32);
}

/** GET /api/v1/gateway/radio/ble/keys — { rev, keys: { MAC: hex } } of this gateway only (never logged, never cached). */
function keysFor(peerId) {
  const keys = {};
  if (!settingsOf(peerId).ble) return { rev: null, keys };
  for (const r of db().prepare('SELECT mac, key_enc FROM gateway_ble_sensors WHERE peer_id = ? AND key_enc IS NOT NULL ORDER BY mac LIMIT 64').all(peerId)) {
    try {
      const k = require('../utils/crypto').decrypt(r.key_enc);
      if (KEY_RE.test(k)) keys[r.mac] = k;
    } catch { logger.warn({ peerId }, 'radio: a sensor key is not readable'); }
  }
  return { rev: keysRev(peerId), keys };
}

// ─── zigbee2mqtt devices (gateway → server, plugins) ───────────────────

const IEEE_MAC_RE = ZB_MAC_RE;

function cleanZigbeeValues(v) {
  const out = cleanValues(v);
  if (!v || typeof v !== 'object') return out;
  for (const [k, rule] of Object.entries(Z_VALUES)) {
    if (!(k in v)) continue;
    const x = v[k];
    if (rule === 'bool') { if (typeof x === 'boolean') out[k] = x; continue; }
    if (typeof x === 'number' && Number.isFinite(x) && x >= rule[0] && x <= rule[1]) out[k] = Math.round(x);
  }
  if (typeof v.action === 'string' && /^[a-z0-9_-]{1,32}$/i.test(v.action)) out.action = v.action;
  // channels of a device with several outputs: { l1: true, l2: false }
  if (v.ch && typeof v.ch === 'object' && !Array.isArray(v.ch)) {
    const ch = {};
    for (const [k, x] of Object.entries(v.ch).slice(0, Z_MAX_CHANNELS)) if (Z_CHANNEL_RE.test(k) && typeof x === 'boolean') ch[k] = x;
    if (Object.keys(ch).length) out.ch = ch;
  }
  // a thermostat: target temperature (half degrees stay), mode, heating right now, valve
  if (typeof v.setpoint === 'number' && Number.isFinite(v.setpoint) && v.setpoint >= 0 && v.setpoint <= 50) out.setpoint = Math.round(v.setpoint * 10) / 10;
  if (Z_MODES.includes(v.mode)) out.mode = v.mode;
  if (typeof v.heating === 'boolean') out.heating = v.heating;
  if (typeof v.valve === 'number' && Number.isFinite(v.valve) && v.valve >= 0 && v.valve <= 100) out.valve = Math.round(v.valve);
  // firmware over the air
  if (v.ota && typeof v.ota === 'object' && !Array.isArray(v.ota)) {
    const o = { state: oneOf(v.ota.state, Z_OTA_STATES, 'idle') };
    if (o.state === 'updating' && typeof v.ota.progress === 'number' && Number.isFinite(v.ota.progress)) o.progress = Math.max(0, Math.min(100, Math.round(v.ota.progress)));
    for (const k of ['installed', 'latest']) if (typeof v.ota[k] === 'string' && Z_VERSION_RE.test(v.ota[k])) o[k] = v.ota[k];
    const checked = typeof v.ota.checked === 'string' ? Date.parse(v.ota.checked) : NaN;
    if (Number.isFinite(checked)) o.checked = new Date(checked).toISOString();
    if (Z_OTA_ERRORS.includes(v.ota.error)) o.error = v.ota.error;
    out.ota = o;
  }
  return out;
}

function cleanZigbeeCaps(c) {
  const o = c && typeof c === 'object' ? c : {};
  const out = {};
  for (const k of ['bri', 'ct', 'position', 'power', 'battery', 'ota']) if (o[k] === true) out[k] = true;
  if (o.color === 'xy' || o.color === 'hs') out.color = o.color;
  if (Array.isArray(o.channels)) {
    const ch = [...new Set(o.channels.filter((x) => typeof x === 'string' && Z_CHANNEL_RE.test(x)))].slice(0, Z_MAX_CHANNELS);
    if (ch.length >= 2) out.channels = ch;
  }
  const sp = o.setpoint && typeof o.setpoint === 'object' ? o.setpoint : null;
  const n = (x, lo, hi) => typeof x === 'number' && Number.isFinite(x) && x >= lo && x <= hi;
  if (sp && n(sp.min, 0, 40) && n(sp.max, 1, 50) && sp.max > sp.min && n(sp.step, 0.1, 5)) out.setpoint = { min: sp.min, max: sp.max, step: sp.step };
  if (Array.isArray(o.modes)) {
    const modes = Z_MODES.filter((m) => o.modes.includes(m));
    if (modes.length) out.modes = modes;
  }
  return out;
}

/** One device of a report → the stored view or null. */
function cleanZigbeeDevice(d) {
  if (!d || typeof d !== 'object' || typeof d.ieee !== 'string') return null;
  const ieee = d.ieee.toLowerCase();
  if (!IEEE_MAC_RE.test(ieee)) return null;
  const seen = Date.parse(d.seenAt);
  return {
    ieee,
    name: clean(d.name, 64) || null,
    model: clean(d.model, 48) || null,
    vendor: clean(d.vendor, 48) || null,
    description: clean(d.description, 80) || null,
    kind: oneOf(d.kind, Z_KINDS, 'other'),
    caps: cleanZigbeeCaps(d.caps),
    values: cleanZigbeeValues(d.values),
    type: d.type === 'router' ? 'router' : 'end_device',
    power: clean(d.power, 24) || null,
    supported: d.supported !== false,
    interview: oneOf(d.interview, ['done', 'running', 'failed'], 'done'),
    available: typeof d.available === 'boolean' ? d.available : null,
    seenAt: Number.isFinite(seen) ? seen : null,
  };
}

/** POST /api/v1/gateway/radio/zigbee { stack, devices } — the complete device list of its zigbee2mqtt. */
function ingestZigbee(peerId, body, now = Date.now()) {
  const b = body && typeof body === 'object' ? body : {};
  if (b.stack !== 'zigbee2mqtt' || !Array.isArray(b.devices)) throw new RadioError('invalid', 'stack zigbee2mqtt with a device list expected');
  const list = b.devices.slice(0, MAX_ZIGBEE).map(cleanZigbeeDevice).filter(Boolean);
  const d = db();
  const seen = new Set();
  d.transaction(() => {
    const up = d.prepare(`INSERT INTO gateway_zigbee_devices (peer_id, ieee, name, model, vendor, description, kind, caps, data, dev_type, power, supported, interview, available, seen_at, reported_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(peer_id, ieee) DO UPDATE SET name = excluded.name, model = excluded.model, vendor = excluded.vendor, description = excluded.description,
        kind = excluded.kind, caps = excluded.caps, data = excluded.data, dev_type = excluded.dev_type, power = excluded.power, supported = excluded.supported,
        interview = excluded.interview, available = excluded.available,
        seen_at = MAX(COALESCE(gateway_zigbee_devices.seen_at, 0), COALESCE(excluded.seen_at, 0)), reported_at = excluded.reported_at`);
    for (const z of list) {
      if (seen.has(z.ieee)) continue;
      seen.add(z.ieee);
      up.run(peerId, z.ieee, z.name, z.model, z.vendor, z.description, z.kind, JSON.stringify(z.caps), JSON.stringify(z.values), z.type, z.power,
        z.supported ? 1 : 0, z.interview, z.available === null ? null : (z.available ? 1 : 0), z.seenAt ? Math.min(z.seenAt, now) : null, now);
    }
    // the list is complete: what zigbee2mqtt no longer knows is gone (removed from the network)
    const keep = [...seen];
    d.prepare(`DELETE FROM gateway_zigbee_devices WHERE peer_id = ?${keep.length ? ` AND ieee NOT IN (${keep.map(() => '?').join(',')})` : ''}`).run(peerId, ...keep);
  })();
  return { devices: seen.size };
}

function zigbeeView(r, now = Date.now()) {
  return {
    ieee: r.ieee, name: r.name, model: r.model, vendor: r.vendor, description: r.description, kind: r.kind,
    caps: json(r.caps) || {}, values: json(r.data) || {}, type: r.dev_type, power: r.power, supported: r.supported === 1, interview: r.interview,
    available: r.available === null || r.available === undefined ? null : r.available === 1,
    online: r.available === 0 ? false : (Number.isFinite(r.seen_at) ? now - r.seen_at < (r.power === 'Battery' ? 26 * 3600 * 1000 : ONLINE_MS) : r.available === 1),
    seenAt: iso(r.seen_at),
  };
}

/** The zigbee2mqtt devices of one gateway (stored). */
function zigbeeDevicesOf(peerId, now = Date.now()) {
  return db().prepare('SELECT * FROM gateway_zigbee_devices WHERE peer_id = ? ORDER BY name, ieee LIMIT ?').all(peerId, MAX_ZIGBEE).map((r) => zigbeeView(r, now));
}

/**
 * gc.radio.zigbee(): the zigbee2mqtt devices of every gateway that runs zigbee2mqtt —
 * { gateways: [{ id, name, reportedAt }], devices: [{ id: 'z2m:<ieee hex>', gatewayId, gateway, ieee, name, model, vendor, kind, caps, values, online, seenAt }] }.
 * A gateway listed under `gateways` reports its complete list (a device missing there is gone).
 */
function pluginZigbee(now = Date.now()) {
  const gws = db().prepare(`SELECT p.id, p.name FROM peers p JOIN gateway_meta m ON m.peer_id = p.id WHERE p.enabled = 1 AND p.peer_type = 'gateway' ORDER BY p.name`).all()
    .filter((g) => { try { return z2mWanted(settingsOf(g.id)); } catch { return false; } });
  const out = { gateways: [], devices: [] };
  for (const g of gws) {
    const last = db().prepare('SELECT MAX(reported_at) AS at FROM gateway_zigbee_devices WHERE peer_id = ?').get(g.id);
    out.gateways.push({ id: g.id, name: g.name, reportedAt: iso(last && last.at) });
    for (const v of zigbeeDevicesOf(g.id, now)) {
      if (!v.supported || v.interview !== 'done' || v.kind === 'other') continue;
      out.devices.push({ id: 'z2m:' + v.ieee.replace(/:/g, ''), gatewayId: g.id, gateway: g.name, ieee: v.ieee, name: v.name || v.model || v.ieee, model: v.model, vendor: v.vendor,
        kind: v.kind, caps: v.caps, values: v.values, battery: Number.isFinite(v.values.battery) ? v.values.battery : null, online: v.online, seenAt: v.seenAt });
    }
  }
  return out;
}

/**
 * The command of a plugin { on, bri, ct, xy, hue, sat, cover, pos } → only these keys, checked. Also: one channel of a
 * device with several ({ on, channel }), a thermostat ({ setpoint, mode }) and firmware ({ ota: 'check' | 'update' },
 * alone).
 */
function cleanCommand(set) {
  if (!set || typeof set !== 'object' || Array.isArray(set)) throw new RadioError('invalid', 'set must be an object');
  const out = {};
  const num = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
  if ('on' in set) { if (typeof set.on !== 'boolean') throw new RadioError('invalid', 'on must be true or false'); out.on = set.on; }
  if ('bri' in set) { if (!num(set.bri, 0, 100)) throw new RadioError('invalid', 'bri: 0…100'); out.bri = set.bri; }
  if ('ct' in set) { if (!num(set.ct, 100, 1000)) throw new RadioError('invalid', 'ct: mired'); out.ct = set.ct; }
  if ('hue' in set) { if (!num(set.hue, 0, 65535)) throw new RadioError('invalid', 'hue: 0…65535'); out.hue = set.hue; }
  if ('sat' in set) { if (!num(set.sat, 0, 254)) throw new RadioError('invalid', 'sat: 0…254'); out.sat = set.sat; }
  if ('xy' in set) { if (!(Array.isArray(set.xy) && set.xy.length === 2 && set.xy.every((x) => num(x, 0, 1)))) throw new RadioError('invalid', 'xy: [x, y]'); out.xy = set.xy; }
  if ('cover' in set) { if (!['open', 'close', 'stop'].includes(set.cover)) throw new RadioError('invalid', 'cover: open | close | stop'); out.cover = set.cover; }
  if ('pos' in set) { if (!num(set.pos, 0, 100)) throw new RadioError('invalid', 'pos: 0…100'); out.pos = set.pos; }
  if ('channel' in set) {
    if (typeof set.channel !== 'string' || !Z_CHANNEL_RE.test(set.channel) || typeof set.on !== 'boolean') throw new RadioError('invalid', 'channel: a channel name with on true or false');
    out.channel = set.channel;
  }
  if ('setpoint' in set) { if (!num(set.setpoint, 0, 50)) throw new RadioError('invalid', 'setpoint: 0…50 °C'); out.setpoint = set.setpoint; }
  if ('mode' in set) { if (!Z_MODES.includes(set.mode)) throw new RadioError('invalid', 'mode: ' + Z_MODES.join(' | ')); out.mode = set.mode; }
  if ('ota' in set) {
    if (!Z_OTA_ACTIONS.includes(set.ota) || Object.keys(out).length) throw new RadioError('invalid', 'ota: check | update, nothing else with it');
    out.ota = set.ota;
  }
  if (!Object.keys(out).length) throw new RadioError('invalid', 'nothing to do');
  return out;
}

/** gc.radio.command(id, set) — switch a zigbee2mqtt device through its gateway. */
async function zigbeeCommand(id, set) {
  const m = /^z2m:([0-9a-f]{16})$/.exec(String(id || ''));
  if (!m) throw new RadioError('invalid', 'id: z2m:<16 hex digits>');
  const ieee = m[1].match(/../g).join(':');
  const row = db().prepare(`SELECT z.peer_id FROM gateway_zigbee_devices z JOIN peers p ON p.id = z.peer_id AND p.enabled = 1 WHERE z.ieee = ? ORDER BY z.reported_at DESC LIMIT 1`).get(ieee);
  if (!row || !z2mWanted(settingsOf(row.peer_id))) throw new RadioError('not_found', 'no such device');
  const body = { ieee, set: cleanCommand(set) };
  const r = await mgmt(row.peer_id, '/api/radio/zigbee/set', body, 8000);
  if (!r) throw new RadioError('gateway_unreachable', 'the gateway does not answer');
  if (r.status === 202) return { accepted: true };
  if (r.status === 404) throw new RadioError('not_found', 'the gateway does not know this device');
  if (r.status === 400) throw new RadioError('invalid', 'the device cannot do that');
  const err = r.body && typeof r.body.error === 'string' ? r.body.error : null;
  throw new RadioError(ANSWERS[err] || 'gateway_error', err || ('gateway answered ' + r.status));
}

/** "Entfernen" in the tab: the device leaves the Zigbee network (zigbee2mqtt). */
async function removeZigbee(peerId, ieee) {
  const m = typeof ieee === 'string' ? ieee.toLowerCase() : '';
  if (!IEEE_MAC_RE.test(m)) throw new RadioError('invalid', 'invalid device address');
  const g = gatewayOf(peerId);
  needSupport(g);
  const r = await mgmt(g.id, '/api/radio/zigbee/remove', { ieee: m }, 8000);
  if (!r) throw new RadioError('gateway_unreachable', 'the gateway does not answer');
  if (r.status === 202) return { accepted: true };
  if (r.status === 404) throw new RadioError('not_found', 'the gateway does not know this device');
  const err = r.body && typeof r.body.error === 'string' ? r.body.error : null;
  throw new RadioError(ANSWERS[err] || 'gateway_error', err || ('gateway answered ' + r.status));
}

/** every hour: sensors nobody took over and nobody heard for a day go; zigbee2mqtt devices not reported for 30 days too */
function housekeeping(now = Date.now()) {
  const a = db().prepare('DELETE FROM gateway_ble_sensors WHERE accepted = 0 AND COALESCE(seen_at, 0) < ?').run(now - KEEP_UNACCEPTED_MS).changes;
  const b = db().prepare('DELETE FROM gateway_zigbee_devices WHERE reported_at < ?').run(now - KEEP_ZIGBEE_MS).changes;
  return a + b;
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

/** Does the gateway know zigbee2mqtt, Thread and sensor keys? Its capability `radio-stacks` says so. */
function stacksSupported(tel) {
  return !!(supported(tel) && tel.capabilities.includes('radio-stacks'));
}

/** Can the gateway take sticks set by hand? Its capability `radio-stick-assign` says so. */
function assignSupported(tel) {
  return !!(supported(tel) && tel.capabilities.includes('radio-stick-assign'));
}

function needStacks(g) {
  const tel = needSupport(g);
  if (!stacksSupported(tel)) throw new RadioError('gateway_unsupported', 'the gateway is too old for zigbee2mqtt and Thread (newer than ' + LAST_WITHOUT_STACKS + ')');
  return tel;
}

// only for the hint texts (the switch goes by the capability): the last gateway release without them
const LAST_WITHOUT_STACKS = '1.31.0';
const LAST_WITHOUT_ASSIGN = '1.33.1';
const ANSWERS = { not_running: 'not_running', key_needed: 'key_needed', feature_disabled: 'unavailable', deconz_failed: 'deconz_failed', invalid_request: 'invalid',
  has_network: 'has_network', no_network: 'no_network', otbr_failed: 'otbr_failed', not_found: 'not_found' };

async function zigbeeCall(peerId, p, body) {
  const g = gatewayOf(peerId);
  needSupport(g);
  const r = await mgmt(g.id, p, body, 8000);
  if (!r) throw new RadioError('gateway_unreachable', 'the gateway does not answer');
  if (r.status === 202) return { accepted: true };
  const err = r.body && typeof r.body.error === 'string' ? r.body.error : null;
  throw new RadioError(ANSWERS[err] || 'gateway_error', err || ('gateway answered ' + r.status));
}

/** "Anlernen starten": deCONZ / zigbee2mqtt accepts new devices for `seconds` (180). */
function pair(peerId, seconds = 180) {
  const s = Number.isInteger(seconds) && seconds >= 60 && seconds <= 254 ? seconds : 180;
  return zigbeeCall(peerId, '/api/radio/zigbee/pair', { seconds: s });
}
/** deCONZ takes new API keys for 60 s (the Smart Home plugin gets its own). */
function unlock(peerId) { return zigbeeCall(peerId, '/api/radio/zigbee/unlock', {}); }
/** "Erneut versuchen" after key_needed. */
function retry(peerId) { return zigbeeCall(peerId, '/api/radio/zigbee/retry', {}); }

// ─── Thread (OpenThread Border Router on the gateway) ──────────────────

const NETWORK_NAME_RE = /^[A-Za-z0-9 ._-]{1,16}$/;

/** "Netz anlegen": a new Thread network (name optional, the rest random). */
function threadForm(peerId, name) {
  const n = name == null || name === '' ? null : String(name).trim();
  if (n !== null && !NETWORK_NAME_RE.test(n)) throw new RadioError('invalid', 'name: up to 16 letters, digits, space . _ -');
  const g = gatewayOf(peerId);
  needStacks(g);
  return zigbeeCall(g.id, '/api/radio/thread/form', n ? { name: n } : {});
}

/** "Vorhandenem Netz beitreten": the active dataset of another border router (TLV hex) — passed through, never stored or logged. */
function threadJoin(peerId, dataset) {
  const d = typeof dataset === 'string' ? dataset.trim().toLowerCase().replace(/\s+/g, '') : '';
  if (!TLV_RE.test(d)) throw new RadioError('invalid_dataset', 'dataset: the TLV hex string of another border router');
  const g = gatewayOf(peerId);
  needStacks(g);
  return zigbeeCall(g.id, '/api/radio/thread/join', { dataset: d });
}

/** The active dataset (TLV hex) for a Matter controller — on request only, never stored. */
async function threadDataset(peerId) {
  const g = gatewayOf(peerId);
  needStacks(g);
  const r = await mgmt(g.id, '/api/radio/thread/dataset', {}, 8000);
  if (!r) throw new RadioError('gateway_unreachable', 'the gateway does not answer');
  if (r.status === 200 && r.body && typeof r.body.dataset === 'string' && TLV_RE.test(r.body.dataset)) return { dataset: r.body.dataset };
  const err = r.body && typeof r.body.error === 'string' ? r.body.error : null;
  throw new RadioError(ANSWERS[err] || 'gateway_error', err || ('gateway answered ' + r.status));
}

/** The live state of the gateway (the tab "Funk"), null when it does not answer. */
async function liveStatus(peerId) {
  const r = await mgmt(peerId, '/api/radio/status', {}, 4000);
  if (!r || r.status !== 200 || !r.body || !r.body.radio) return null;
  const t = telemetryRadio({ features: { radio: r.body.radio } });
  const list = Array.isArray(r.body.radio.zigbeeDevices) ? r.body.radio.zigbeeDevices : null;
  if (t && list) t.zigbeeDevices = list.slice(0, MAX_ZIGBEE).map(cleanZigbeeDevice).filter(Boolean).map((z) => ({ ...z, seenAt: iso(z.seenAt) }));
  return t;
}

// ─── Sticks set by hand ────────────────────────────────────────────────

/** What a stick can do for a radio, from the detection: 'ok' | 'fit' (probably not) | 'no_adapter' (zigbee2mqtt cannot drive it). */
function stickFit(s, use, stack) {
  if (!s || use === 'none' || use === 'auto') return 'ok';
  if (use === 'zigbee') {
    if (stack === 'zigbee2mqtt') return s.z2m ? (s.kind === 'thread' ? 'fit' : 'ok') : 'no_adapter';
    return s.deconz ? 'ok' : 'fit';
  }
  return s.thread || s.kind === 'thread' ? 'ok' : 'fit';
}

/**
 * The rows of the list "Funksticks": every stick the gateway sees (without Bluetooth) and every
 * stick set by hand that is not plugged in, each with its choice and the hints for it — hints,
 * never bans (pure: settings + the radio view of the telemetry).
 *   hints: missing (chosen, not plugged in: the radio waits for it), second (another stick has this
 *   radio already), radio_off (the chosen radio is off), fit (the detection says it does not fit,
 *   used anyway), no_adapter (zigbee2mqtt cannot drive it), firmware (a multi stick: its firmware
 *   decides Zigbee or Thread), port (no serial number: the choice holds for the USB socket),
 *   by_hand_only (the gateway does not report stable ids yet — older gateway)
 */
function stickPlan(settings, radio) {
  const s = settings || normalizeSettings(null);
  const r = radio || { sticks: [], missing: [] };
  const chosen = new Map(s.sticks.map((e) => [e.id, e]));
  const stack = s.stack || 'deconz';
  const zigbeeOn = s.zigbee !== false;
  const radioOn = (use) => (use === 'zigbee' ? zigbeeOn : use === 'thread' ? s.thread === true : true);
  const rows = [];
  const firstFor = {};
  const present = (r.sticks || []).filter((x) => x.kind !== 'bluetooth');
  // the stick chosen first for a radio (order of the setting) that is plugged in
  for (const e of s.sticks) {
    if ((e.use === 'zigbee' || e.use === 'thread') && !firstFor[e.use] && present.some((x) => x.id === e.id)) firstFor[e.use] = e.id;
  }
  for (const x of present) {
    const e = x.id ? chosen.get(x.id) : null;
    const choice = e ? e.use : 'auto';
    const hints = [];
    if (choice === 'zigbee' || choice === 'thread') {
      if (firstFor[choice] !== x.id) hints.push('second');
      else if (!radioOn(choice)) hints.push('radio_off');
      else {
        const fit = stickFit(x, choice, stack);
        if (fit !== 'ok') hints.push(fit);
      }
      if (x.kind === 'multi') hints.push('firmware');
    }
    if (x.note && STICK_NOTES.includes(x.note) && !hints.includes(x.note)) hints.unshift(x.note);
    if (x.idKind === 'port') hints.push('port');
    rows.push({ id: x.id, idKind: x.idKind, model: x.model, kind: x.kind, bus: x.bus, tty: x.tty, deconz: x.deconz, z2m: x.z2m, thread: x.thread,
      use: x.use, choice, present: true, hints });
  }
  for (const e of s.sticks) {
    if (present.some((x) => x.id === e.id)) continue;
    rows.push({ id: e.id, idKind: /^port:/.test(e.id) ? 'port' : (/^uart:/.test(e.id) ? 'uart' : 'serial'), model: e.model, kind: null, bus: /^uart:/.test(e.id) ? 'uart' : 'usb',
      tty: null, deconz: false, z2m: null, thread: false, use: null, choice: e.use, present: false, hints: e.use === 'none' ? [] : ['missing'] });
  }
  return rows;
}

/** "Funksticks": set one stick by hand ({ id, use: auto | zigbee | thread | none }); auto forgets it. */
function setStick(peerId, body, { ip, user } = {}) {
  const b = body && typeof body === 'object' ? body : {};
  if (typeof b.id !== 'string' || !STICK_ID_RE.test(b.id)) throw new RadioError('invalid', 'id: the stable id of a stick');
  if (!STICK_CHOICES.includes(b.use)) throw new RadioError('invalid', 'use: auto, zigbee, thread or none');
  const g = gatewayOf(peerId);
  const tel = needSupport(g);
  if (!assignSupported(tel)) throw new RadioError('gateway_unsupported', 'the gateway is too old to set sticks by hand (newer than ' + LAST_WITHOUT_ASSIGN + ')');
  const cur = settingsOf(g.id).sticks;
  const t = telemetryRadio(tel);
  const seen = t ? t.sticks.find((x) => x.id === b.id) : null;
  const known = cur.find((e) => e.id === b.id);
  if (!seen && !known) throw new RadioError('not_found', 'the gateway does not report this stick');
  const model = (seen && seen.model) || (known && known.model) || null;
  // a new choice goes to the end (the first chosen for a radio wins), a changed one keeps its place
  let next;
  if (b.use === 'auto') next = cur.filter((e) => e.id !== b.id);
  else if (known) next = cur.map((e) => (e.id === b.id ? { id: e.id, use: b.use, model } : e));
  else next = cur.concat([{ id: b.id, use: b.use, model }]);
  if (next.length > MAX_STICK_CHOICES) throw new RadioError('invalid', `up to ${MAX_STICK_CHOICES} sticks set by hand`);
  require('./gatewayFeatures').set(g.id, { radio: { sticks: next } }, { ip, user });
  return { sticks: stickPlan(settingsOf(g.id), t) };
}

// ─── Overview (card "Funktionen", tab "Funk") ──────────────────────────

/** Does the compose file of this gateway need the deconz service? (a deCONZ stick is there, or Zigbee was switched on) */
function composeWantsZigbee(peerId) {
  try {
    const g = gatewayOf(peerId);
    const s = settingsOf(g.id);
    if (s.stack === 'zigbee2mqtt') return false;
    const t = telemetryRadio(require('./gatewayFeatures').telemetryOf(g));
    if (t && t.sticks.some((x) => x.deconz)) return true;
    return s.zigbee === true;
  } catch { return false; }
}
/** … the zigbee2mqtt service? (zigbee2mqtt chosen) */
function composeWantsZ2m(peerId) {
  try { return z2mWanted(settingsOf(gatewayOf(peerId).id)); } catch { return false; }
}
/** … the otbr service? (Thread switched on) */
function composeWantsThread(peerId) {
  try { return settingsOf(gatewayOf(peerId).id).thread === true; } catch { return false; }
}

/** What needs one step outside: the compose file (Synology/Linux) when a wanted radio service is missing. */
function composeHint(t, platform) {
  if (!t) return null;
  const missing = (svc) => svc !== 'managed' && svc !== 'image';
  const z = t.zigbee;
  const stick = t.sticks.some((s) => s.deconz);
  const wantDeconz = (t.stack || 'deconz') === 'deconz' && (stick || z.want);
  const zt = t.zigbee2mqtt;
  const th = t.thread || {};
  const needs = [];
  if (wantDeconz && missing(z.service)) needs.push(z.service);
  if (zt && zt.want && zt.state !== 'off' && zt.state !== 'mqtt_off' && zt.state !== 'mqtt_missing' && zt.state !== 'no_stick' && missing(zt.service)) needs.push(zt.service);
  if (th.supported && th.want && th.state !== 'off' && th.state !== 'no_stick' && th.state !== 'stick_busy' && missing(th.service)) needs.push(th.service);
  if (!needs.length) return null;
  if (platform === 'rpi') return needs.every((svc) => svc === 'absent') ? null : 'image';
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
  const zt = t && t.zigbee2mqtt;
  const z2m = s.stack === 'zigbee2mqtt';
  return {
    zigbee: s.zigbee,
    ble: s.ble,
    stack: s.stack,
    thread: s.thread,
    enabled: !!(s.ble || s.thread || (z2m ? z2mWanted(s) : (t ? t.zigbee.want : s.zigbee === true))),
    supported: supported(tel),
    stacksSupported: stacksSupported(tel),
    minGateway: MIN_GATEWAY,
    platform,
    sticks: t ? t.sticks : [],
    state: t ? {
      zigbee: z2m ? (zt ? zt.state : 'off') : t.zigbee.state,
      service: z2m ? (zt ? zt.service : 'missing') : t.zigbee.service,
      devices: z2m ? (zt ? zt.devices : null) : t.zigbee.devices,
      model: z2m ? (zt ? zt.model : null) : t.zigbee.model,
      ble: t.ble.state, bleSensors: t.ble.sensors, thread: t.thread.sticks,
      ...(t.thread.supported ? { threadState: t.thread.state } : {}),
    } : null,
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
  let edge = null;
  try {
    const es = require('./edge/store').settings(g.id);
    edge = { edgeEnabled: es.edgeEnabled, mqttEnabled: es.mqttEnabled };
  } catch (e) { logger.debug({ err: e.message }, 'edge settings unavailable'); }
  const platform = platformOf(g.id, tel);
  const settings = settingsOf(g.id);
  let zigbeeDevices = [];
  if (settings.stack === 'zigbee2mqtt') zigbeeDevices = radio && Array.isArray(radio.zigbeeDevices) ? radio.zigbeeDevices : zigbeeDevicesOf(g.id);
  if (radio) delete radio.zigbeeDevices;
  const memTotal = Number(hw.mem_total || tel.mem_total) || null;
  return {
    gateway: { id: g.id, name: g.name, version: typeof tel.gateway_version === 'string' ? tel.gateway_version : null, model: typeof hw.model === 'string' ? hw.model : null, platform,
      imageVersion: typeof hw.image_version === 'string' ? hw.image_version : null, memTotal },
    settings,
    supported: supported(tel),
    stacksSupported: stacksSupported(tel),
    assignSupported: assignSupported(tel),
    minGateway: MIN_GATEWAY,
    lastWithoutStacks: LAST_WITHOUT_STACKS,
    lastWithoutAssign: LAST_WITHOUT_ASSIGN,
    live: fresh,
    radio,
    sticks: stickPlan(settings, radio),
    sensors: sensorsOf(g.id),
    zigbeeDevices,
    smarthome,
    edge,
    compose: composeHint(radio, platform),
  };
}

const HOST_CODES = { invalid: 'ERR_INVALID', not_found: 'ERR_NOT_FOUND', not_running: 'ERR_RADIO_NOT_RUNNING', gateway_unreachable: 'ERR_GATEWAY_UNREACHABLE', gateway_unsupported: 'ERR_RADIO_NOT_RUNNING', unavailable: 'ERR_RADIO_NOT_RUNNING', gateway_error: 'ERR_GATEWAY_UNREACHABLE' };

module.exports = {
  MIN_GATEWAY, MAX_SENSORS, LAST_WITHOUT_STACKS, LAST_WITHOUT_ASSIGN, RadioError, HOST_CODES,
  normalizeSettings, normalizeSticks, patchSticks, stickPlan, setStick, assignSupported, configPayload, telemetryRadio, cleanSensor, ingestBle, sensorsOf, setSensor, removeSensor, pluginSensors,
  keysRev, keysFor, ingestZigbee, zigbeeDevicesOf, pluginZigbee, zigbeeCommand, removeZigbee, cleanCommand,
  threadForm, threadJoin, threadDataset,
  housekeeping, pair, unlock, retry, liveStatus, overview, view, composeWantsZigbee, composeWantsZ2m, composeWantsThread, composeHint, supported, stacksSupported, platformOf,
};
