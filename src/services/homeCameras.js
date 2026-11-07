'use strict';

// Kameras im Heimnetz (phase 3c, step 4 — the gateway's docs/cameras.md).
// The gateways find ONVIF/RTSP cameras, take snapshots, watch the cameras' own
// motion events, record clips (stream copy) onto a storage at the gateway
// host and hand live video out through their management API. The server
// keeps the cameras (password encrypted with the server key), the switch
// per gateway, the gateways' reports and the events; plugins use it through
// gc.cameras (permissions.cameras — the plugin "Tür & Kamera").
//
//   switch per gateway: gateway_features.settings.cameras { enabled, subnets, storagePath }
//     (services/gatewayFeatures.js) → features.cameras of the config pull
//   GET  /api/v1/gateway/cameras/credentials   credentialsFor()  (never in the config pull)
//   POST /api/v1/gateway/cameras/report        ingestReport()
//   POST /api/v1/gateway/cameras/events        ingestEvents()     → hook cameraEvent of the plugins
//   GET  /camera-media/<token>/<file>          mediaRequest()     (no session: the token is the permission)
//   management calls to the gateway (gateways.mgmtCall / mgmtRequest): /api/cameras/*
//
// Live video only for clients in the VPN (or in the server's own LAN): the
// request reference of the plugin call (requestRefs) tells where it comes
// from; elsewhere a new snapshot every 10 s (the design: "Unterwegs ohne VPN
// zeigt die App alle 10 Sekunden ein neues Standbild").

const crypto = require('node:crypto');
const ipaddr = require('ipaddr.js');
const { getDb } = require('../db/connection');
const logger = require('../utils/logger');

const MIN_GATEWAY = '1.28.0';
const MAX_PER_GATEWAY = 16;
const KINDS = ['person', 'vehicle', 'animal', 'motion'];
const RECORD = ['motion', 'away', 'never'];
const STREAMS = ['main', 'sub'];
const DEFAULT_CAMERA = Object.freeze({ record: 'motion', events: ['person', 'vehicle', 'animal'], retentionDays: 14, stream: 'main', audio: false });
const ID_RE = /^c[0-9a-f]{15}$/;
const EVENT_RE = /^e[0-9a-f]{15}$/;
const PROFILE_RE = /^[A-Za-z0-9._:-]{1,64}$/;
const ONVIF_PATH_RE = /^\/[A-Za-z0-9._~/-]{0,127}$/;
const RTSP_PATH_RE = /^\/[A-Za-z0-9._~/%&=?+:;,-]{0,255}$/;
const STATES = ['ok', 'unreachable', 'auth_failed', 'not_allowed', 'no_stream', 'tls_untrusted', 'error', 'starting'];
// the clip folder at the gateway host (compose file only): an absolute path, no "..", no spaces or shell characters
const STORAGE_PATH_RE = /^\/[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+){0,15}\/?$/;
const MOUNTS = ['folder', 'volume', 'none'];
const STREAM_STATES = ['running', 'idle', 'starting', 'error', 'service_missing'];
const EVENT_STATES = ['pullpoint', 'unsupported', 'off', 'error'];
const SERVICES = ['managed', 'absent', 'missing'];
const SNAP_EVERY_S = 10;
const LIVE_TTL_S = 600;
const SNAP_TTL_S = 600;
const CLIP_TTL_S = 3600;
const KEEP_EVENTS_MS = 90 * 86400_000;
const PUSH_IMAGE_MAX = 300 * 1024;
const MEM_BASE_MB = 50;
const MEM_PER_CAMERA_MB = 50;
const HOOK_MS = 5000;
const FILES = {
  snap: ['snapshot.jpg'],
  live: ['index.m3u8', 'init.mp4', 'live.mp4', 'snapshot.jpg'],
  clip: ['clip.mp4', 'thumb.jpg'],
};
const SEG_RE = /^s[0-9]{1,9}\.m4s$/;

class CameraError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

function db() { return getDb(); }
function json(s, d = null) { try { return s ? JSON.parse(s) : d; } catch { return d; } }
function iso(ms) { return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null; }
function fail(code, message) { throw new CameraError(code, message); }

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
  return Number.isFinite(t) ? t : null;
}

/** 10/8, 172.16/12, 192.168/16 */
function isPrivate(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(ip || ''));
  if (!m) return false;
  const o = m.slice(1).map(Number);
  if (o.some((x) => x > 255)) return false;
  return o[0] === 10 || (o[0] === 172 && o[1] >= 16 && o[1] <= 31) || (o[0] === 192 && o[1] === 168);
}

/** '192.168.20.0/24' → normalised CIDR (RFC 1918, /16…/30) or null */
function cidr(v) {
  const m = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(String(v || '').trim());
  if (!m || !isPrivate(m[1])) return null;
  const p = Number(m[2]);
  if (p < 16 || p > 30) return null;
  const n = m[1].split('.').reduce((a, o) => ((a << 8) + Number(o)) >>> 0, 0);
  const mask = (~(0xffffffff >>> p)) >>> 0;
  const net = (n & mask) >>> 0;
  return `${[24, 16, 8, 0].map((s) => (net >>> s) & 255).join('.')}/${p}`;
}

// ─── Settings (part of the gateway's features) ─────────────────────────

/** '/volume1/kameras/' → '/volume1/kameras', or null (not an absolute, plain path; '..' anywhere; ≤ 200 characters). */
function storagePath(v) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (!t || t.length > 200 || !STORAGE_PATH_RE.test(t) || t.split('/').some((x) => x === '.' || x === '..')) return null;
  return t.length > 1 ? t.replace(/\/$/, '') : null;
}

/** features.cameras of the stored gateway settings (any shape) → { enabled, subnets, storagePath } */
function normalizeSettings(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const subnets = Array.isArray(r.subnets) ? [...new Set(r.subnets.map(cidr).filter(Boolean))].slice(0, 8) : [];
  return { enabled: r.enabled === true, subnets, storagePath: storagePath(r.storagePath) };
}

/** One field of PUT /api/v1/gateways/:id/features { cameras: { … } } → the value (throws code invalid / invalid_host). */
function patchField(f, val) {
  if (f === 'enabled') {
    if (typeof val !== 'boolean') throw Object.assign(new Error('cameras.enabled: must be true or false'), { code: 'invalid' });
    return val;
  }
  if (f === 'subnets') {
    if (!Array.isArray(val) || val.length > 8 || !val.every((x) => cidr(x))) {
      throw Object.assign(new Error('cameras.subnets: up to 8 private networks (RFC 1918, /16…/30)'), { code: 'invalid_host' });
    }
    return [...new Set(val.map(cidr))];
  }
  if (f === 'storagePath') {
    // null / '' = the Docker volume cam-recordings (the default)
    if (val === null || val === '') return null;
    const p = storagePath(val);
    if (!p) throw Object.assign(new Error('cameras.storagePath: an absolute folder of the gateway host like /volume1/kameras (letters, digits, . _ - @ +; no spaces, no "..")'), { code: 'invalid' });
    return p;
  }
  throw Object.assign(new Error(`cameras.${f}: unknown`), { code: 'invalid' });
}

function settingsOf(peerId) { return require('./gatewayFeatures').get(peerId).cameras; }

/** Settings of one camera (any shape) → the complete, valid ones. */
function cameraSettings(raw, base = DEFAULT_CAMERA) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const days = Number.isInteger(r.retentionDays) && r.retentionDays >= 1 && r.retentionDays <= 90 ? r.retentionDays : base.retentionDays;
  return {
    record: RECORD.includes(r.record) ? r.record : base.record,
    events: Array.isArray(r.events) ? KINDS.filter((k) => r.events.includes(k)) : base.events.slice(),
    retentionDays: days,
    stream: STREAMS.includes(r.stream) ? r.stream : base.stream,
    audio: typeof r.audio === 'boolean' ? r.audio : base.audio,
  };
}

/** A settings patch of the host API → checked (ERR_INVALID on wrong types) and merged. */
function patchSettings(current, patch) {
  if (patch == null) return current;
  if (typeof patch !== 'object' || Array.isArray(patch)) fail('invalid', 'settings must be an object');
  const out = { ...current };
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'record') { if (!RECORD.includes(v)) fail('invalid', 'settings.record: motion, away or never'); out.record = v; }
    else if (k === 'events') { if (!Array.isArray(v) || !v.every((x) => KINDS.includes(x))) fail('invalid', 'settings.events: person, vehicle, animal, motion'); out.events = KINDS.filter((x) => v.includes(x)); }
    else if (k === 'retentionDays') { if (!Number.isInteger(v) || v < 1 || v > 90) fail('invalid', 'settings.retentionDays: 1…90'); out.retentionDays = v; }
    else if (k === 'stream') { if (!STREAMS.includes(v)) fail('invalid', 'settings.stream: main or sub'); out.stream = v; }
    else if (k === 'audio') { if (typeof v !== 'boolean') fail('invalid', 'settings.audio: true or false'); out.audio = v; }
    else fail('invalid', `settings.${k}: unknown`);
  }
  return out;
}

// ─── Presence (record "away") ──────────────────────────────────────────

/** true = everybody known is away, false = somebody is at home, null = unknown (nobody agreed / no state). */
function nobodyHome() {
  try {
    const list = require('./homePresence').list();
    if (!list.length) return null;
    return list.every((p) => p.home === false);
  } catch { return null; }
}

let lastNobody;
/** A person's presence changed (homePresence.emit): tell the gateways with cameras when "nobody at home" flips. */
function presenceChanged() {
  const now = nobodyHome();
  if (now === lastNobody) return;
  lastNobody = now;
  try {
    const rows = db().prepare("SELECT peer_id FROM gateway_features WHERE settings LIKE '%\"cameras\"%'").all();
    for (const r of rows) if (settingsOf(r.peer_id).enabled) require('./gatewayFeatures').notifyGateway(r.peer_id);
  } catch (e) { logger.debug({ err: e.message }, 'cameras: presence push failed'); }
}

// ─── Cameras (rows) ────────────────────────────────────────────────────

function rowsOf(peerId) {
  return db().prepare('SELECT * FROM home_cameras WHERE peer_id = ? ORDER BY created_at').all(peerId);
}

function rowOf(id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) fail('not_found', 'no such camera');
  const r = db().prepare('SELECT * FROM home_cameras WHERE id = ?').get(id);
  if (!r) fail('not_found', 'no such camera');
  return r;
}

/**
 * Changes whenever a camera's access data may have changed → the gateway fetches them again. Built from
 * the cameras and their update times only (every change of user or password sets updated_at) — never
 * from the password or its ciphertext.
 */
function credRev(rows) {
  const h = crypto.createHash('sha256');
  for (const r of rows) h.update(`${r.id}\n${r.updated_at}\n`);
  return h.digest('hex').slice(0, 16);
}

/** features.cameras of the config pull (no passwords — they come from credentialsFor). */
function configPayload(peerId) {
  const s = settingsOf(peerId);
  if (!s.enabled) return { enabled: false };
  const rows = rowsOf(peerId);
  return {
    enabled: true,
    nobodyHome: nobodyHome(),
    credRev: credRev(rows),
    subnets: s.subnets.slice(),
    cameras: rows.map((r) => {
      const st = cameraSettings(json(r.settings, {}));
      return {
        id: r.id, name: r.name, host: r.host,
        onvif: r.onvif_port ? { port: r.onvif_port, path: r.onvif_path || '/onvif/device_service', ...(r.onvif_tls === 1 ? { tls: true } : {}) } : null,
        rtsp: r.rtsp_port && r.rtsp_path ? { port: r.rtsp_port, path: r.rtsp_path } : null,
        profile: r.profile || null, stream: st.stream, record: st.record, events: st.events, retentionDays: st.retentionDays, audio: st.audio,
        tlsInsecure: r.tls_insecure === 1,
        codec: r.codec === 'h264' || r.codec === 'h265' ? r.codec : null,
      };
    }),
  };
}

function decryptPassword(r) {
  if (!r.password_enc) return '';
  try { return require('../utils/crypto').decrypt(r.password_enc); } catch (e) { logger.warn({ camera: r.id }, 'cameras: password not readable'); return ''; }
}

/** GET /api/v1/gateway/cameras/credentials — only the cameras of this gateway. */
function credentialsFor(peerId) {
  if (!settingsOf(peerId).enabled) return { rev: null, cameras: {} };
  const rows = rowsOf(peerId);
  const cameras = {};
  for (const r of rows) cameras[r.id] = { user: r.username || '', password: decryptPassword(r) };
  return { rev: credRev(rows), cameras };
}

// ─── Reports of the gateway ────────────────────────────────────────────

function cleanError(e) {
  if (!e || typeof e !== 'object') return null;
  return { code: typeof e.code === 'string' && /^[a-z0-9_]{1,40}$/.test(e.code) ? e.code : 'error', at: Number.isSafeInteger(e.at) ? e.at : null };
}

function cleanStorage(s) {
  const x = s && typeof s === 'object' ? s : {};
  const n = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);
  const mount = MOUNTS.includes(x.mount) ? x.mount : null;
  return {
    free: n(x.free), total: n(x.total), used: n(x.used), clips: n(x.clips), problem: ['disk_low', 'not_writable'].includes(x.problem) ? x.problem : null,
    // gateway ≥ 1.29.0: where /recordings lies (a folder of the host, a Docker volume, nowhere = in the container)
    mount, folder: mount === 'folder' ? clean(x.folder, 160) || null : null, volume: mount === 'volume' ? clean(x.volume, 128) || null : null,
  };
}

function cleanCameraState(c) {
  return {
    state: STATES.includes(c.state) ? c.state : 'error',
    problem: typeof c.problem === 'string' && /^[a-z_]{1,32}$/.test(c.problem) ? c.problem : null,
    events: EVENT_STATES.includes(c.events) ? c.events : 'off',
    kinds: Array.isArray(c.kinds) ? KINDS.filter((k) => c.kinds.includes(k)) : [],
    codec: c.codec === 'h264' || c.codec === 'h265' ? c.codec : null,
    width: Number.isInteger(c.width) && c.width > 0 && c.width < 20000 ? c.width : null,
    height: Number.isInteger(c.height) && c.height > 0 && c.height < 20000 ? c.height : null,
    // gateway ≥ 1.29.0: has the stream a sound track (SDP)? null = unknown
    audio: typeof c.audio === 'boolean' ? c.audio : null,
    stream: STREAM_STATES.includes(c.stream) ? c.stream : 'idle',
    recording: c.recording === true,
    snapshotAt: isoOrNull(c.snapshotAt),
    lastEventAt: isoOrNull(c.lastEventAt),
  };
}

/** POST /api/v1/gateway/cameras/report { at, service, storage, cameras } */
function ingestReport(peerId, body, now = Date.now()) {
  const b = body && typeof body === 'object' ? body : {};
  if (!Array.isArray(b.cameras)) fail('invalid', 'cameras must be a list');
  const report = { service: SERVICES.includes(b.service) ? b.service : 'missing', storage: cleanStorage(b.storage) };
  const d = db();
  let n = 0;
  d.transaction(() => {
    d.prepare(`INSERT INTO home_camera_gateways (peer_id, report, reported_at) VALUES (?, ?, ?)
      ON CONFLICT(peer_id) DO UPDATE SET report = excluded.report, reported_at = excluded.reported_at`).run(peerId, JSON.stringify(report), now);
    const up = d.prepare('UPDATE home_cameras SET state = ?, codec = COALESCE(?, codec), kinds = ?, manufacturer = COALESCE(?, manufacturer), model = COALESCE(?, model), firmware = COALESCE(?, firmware) WHERE id = ? AND peer_id = ?');
    for (const c of b.cameras.slice(0, MAX_PER_GATEWAY)) {
      if (!c || typeof c !== 'object' || typeof c.id !== 'string' || !ID_RE.test(c.id)) continue;
      const st = cleanCameraState(c);
      const info = c.info && typeof c.info === 'object' ? c.info : {};
      n += up.run(JSON.stringify({ ...st, at: now }), st.codec, JSON.stringify(st.kinds), clean(info.manufacturer, 48) || null, clean(info.model, 48) || null, clean(info.firmware, 48) || null, c.id, peerId).changes;
    }
  })();
  return { cameras: n };
}

function rank(k) { return KINDS.length - KINDS.indexOf(k); }

/** POST /api/v1/gateway/cameras/events { events: [...] } (≤ 32) */
function ingestEvents(peerId, body, now = Date.now()) {
  const b = body && typeof body === 'object' ? body : {};
  if (!Array.isArray(b.events)) fail('invalid', 'events must be a list');
  const d = db();
  const hooks = [];
  let n = 0;
  d.transaction(() => {
    for (const e of b.events.slice(0, 32)) {
      if (!e || typeof e !== 'object' || typeof e.id !== 'string' || !EVENT_RE.test(e.id) || typeof e.cameraId !== 'string' || !ID_RE.test(e.cameraId)) continue;
      const cam = d.prepare('SELECT id, name, peer_id FROM home_cameras WHERE id = ? AND peer_id = ?').get(e.cameraId, peerId);
      if (!cam) continue;
      const kinds = Array.isArray(e.kinds) ? KINDS.filter((k) => e.kinds.includes(k)) : [];
      const kind = KINDS.includes(e.kind) ? e.kind : (kinds.slice().sort((a, x) => rank(x) - rank(a))[0] || 'motion');
      const started = isoOrNull(e.startedAt);
      if (!started || started > now + 60_000) continue;
      const ended = isoOrNull(e.endedAt);
      const clip = e.clip && typeof e.clip === 'object' && Number.isSafeInteger(e.clip.ms) && e.clip.ms > 0 && Number.isSafeInteger(e.clip.bytes) && e.clip.bytes > 0 ? { ms: Math.min(e.clip.ms, 3600_000), bytes: e.clip.bytes } : null;
      const nobody = e.nobodyHome === true ? 1 : (e.nobodyHome === false ? 0 : null);
      const old = d.prepare('SELECT kind, ended_at FROM home_camera_events WHERE id = ?').get(e.id);
      if (old) {
        d.prepare(`UPDATE home_camera_events SET kind = ?, kinds = ?, ended_at = COALESCE(?, ended_at), clip_ms = COALESCE(?, clip_ms), clip_bytes = COALESCE(?, clip_bytes),
          has_thumb = MAX(has_thumb, ?), updated_at = ? WHERE id = ? AND peer_id = ?`)
          .run(kind, JSON.stringify(kinds), ended, clip ? clip.ms : null, clip ? clip.bytes : null, e.thumb === true ? 1 : 0, now, e.id, peerId);
      } else {
        d.prepare(`INSERT INTO home_camera_events (id, camera_id, peer_id, kind, kinds, started_at, ended_at, nobody_home, clip_ms, clip_bytes, has_thumb, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(e.id, cam.id, peerId, kind, JSON.stringify(kinds), started, ended, nobody, clip ? clip.ms : null, clip ? clip.bytes : null, e.thumb === true ? 1 : 0, now, now);
      }
      n++;
      const phase = e.phase === 'end' ? 'end' : (old ? 'update' : 'start');
      if (!old || old.kind !== kind || (phase === 'end' && !old.ended_at)) {
        hooks.push({ id: e.id, cameraId: cam.id, camera: cam.name, gatewayId: peerId, kind, kinds, phase, at: iso(started), nobodyHome: nobody === null ? null : nobody === 1, clip });
      }
    }
  })();
  for (const h of hooks) emit(h);
  return { events: n };
}

// ─── Plugins (hook cameraEvent) ────────────────────────────────────────

function hasPermission(p) {
  return !!(p && p.manifest && p.manifest.permissions && p.manifest.permissions.cameras === true);
}

function cameraPlugins() {
  try {
    const registry = require('./plugins/registry');
    const runtime = require('./plugins/runtime');
    const plugins = require('./plugins');
    return registry.list().filter(hasPermission).filter((p) => {
      try { return plugins.evaluate(p).run && runtime.info(p.id).state === 'running'; } catch { return false; }
    });
  } catch { return []; }
}

/** An event started, changed its kind or ended → hook cameraEvent of every running plugin with the permission (never awaited). */
function emit(ev) {
  for (const p of cameraPlugins()) {
    try {
      require('./plugins/runtime').call(p.id, 'cameraEvent', ev, module.exports._hookMs || HOOK_MS).catch((e) => {
        try { require('./plugins/registry').addLog(p.id, e && e.stopped ? 'debug' : 'warn', 'cameraEvent failed: ' + String((e && e.message) || e).slice(0, 200)); } catch { /* db closed */ }
      });
    } catch (e) { logger.debug({ err: e.message }, 'cameraEvent hook not delivered'); }
  }
  try { require('./eventBus').publish('camera_event', { camera_id: ev.cameraId, kind: ev.kind, phase: ev.phase }); } catch { /* best-effort */ }
}

// ─── Management calls (server → gateway) ───────────────────────────────

function gw() { return require('./gateways'); }

function supported(tel) {
  return !!(tel && Array.isArray(tel.capabilities) && tel.capabilities.includes('cameras'));
}

/** The gateway for a plugin call: a gateway with the function switched on, supported, online. */
function needGateway(peerId) {
  const gf = require('./gatewayFeatures');
  const g = gf.gatewayPeer(peerId);
  if (!g) fail('not_found', 'no such gateway');
  if (!supported(gf.telemetryOf(g))) fail('unsupported', `the gateway is too old for cameras (from ${MIN_GATEWAY})`);
  if (!settingsOf(g.id).enabled) fail('unsupported', 'cameras are switched off on this gateway (Gateway › Funktionen)');
  const alive = db().prepare('SELECT alive FROM gateway_meta WHERE peer_id = ?').get(g.id);
  if (!alive || alive.alive !== 1) fail('offline', 'the gateway is offline');
  return g;
}

const MGMT_ERRORS = {
  auth_failed: 'auth', not_allowed: 'not_allowed', unreachable: 'unreachable', not_onvif: 'unreachable', no_stream: 'no_stream', tls_untrusted: 'tls',
  invalid_request: 'invalid', unknown_camera: 'not_found', not_ready: 'not_ready', feature_disabled: 'unsupported', service_missing: 'service_missing',
};

async function mgmt(peerId, path, body, timeoutMs = 8000) {
  const r = await gw().mgmtCall(peerId, path, body || {}, timeoutMs, { maxBytes: 2 * 1024 * 1024 });
  if (!r) fail('offline', 'the gateway does not answer');
  if (r.status >= 200 && r.status < 300) return r.body || {};
  const err = r.body && typeof r.body.error === 'string' ? r.body.error : null;
  fail(MGMT_ERRORS[err] || 'gateway_error', err || ('gateway answered ' + r.status));
  return null;
}

// ─── Host API (gc.cameras) ─────────────────────────────────────────────

function gatewaysWithCameras() {
  const rows = db().prepare(`SELECT p.id, p.name, gm.alive, gm.last_health FROM peers p JOIN gateway_meta gm ON gm.peer_id = p.id
    WHERE p.peer_type = 'gateway' AND p.enabled = 1 ORDER BY p.name COLLATE NOCASE`).all();
  return rows.map((r) => {
    const h = json(r.last_health, {}) || {};
    const tel = h.telemetry && typeof h.telemetry === 'object' ? h.telemetry : {};
    const s = settingsOf(r.id);
    const rep = db().prepare('SELECT report FROM home_camera_gateways WHERE peer_id = ?').get(r.id);
    const report = rep ? json(rep.report, {}) : {};
    const t = tel.features && tel.features.cameras && typeof tel.features.cameras === 'object' ? tel.features.cameras : {};
    return {
      id: r.id, name: r.name, online: r.alive === 1, supported: supported(tel), enabled: s.enabled,
      service: SERVICES.includes(t.service) ? t.service : (report.service || null),
      storage: report.storage || cleanStorage(t.storage),
      hint: hardwareHint(tel, rowsOf(r.id)),
    };
  }).filter((g) => g.supported || g.enabled);
}

/** gc.cameras.available() */
function available() {
  const gateways = gatewaysWithCameras();
  return { available: gateways.some((g) => g.enabled && g.supported), gateways };
}

function cameraView(r, gwName) {
  const st = json(r.state, null);
  const s = cameraSettings(json(r.settings, {}));
  const alive = db().prepare('SELECT alive FROM gateway_meta WHERE peer_id = ?').get(r.peer_id);
  return {
    id: r.id, gatewayId: r.peer_id, gateway: gwName, name: r.name, host: r.host,
    source: r.onvif_port ? 'onvif' : 'rtsp', https: r.onvif_tls === 1, tlsInsecure: r.tls_insecure === 1, manufacturer: r.manufacturer || null, model: r.model || null,
    state: st ? st.state : 'starting', problem: st ? st.problem : null,
    online: !!(alive && alive.alive === 1) && !!st && st.state === 'ok',
    codec: (st && st.codec) || r.codec || null, width: st ? st.width : null, height: st ? st.height : null,
    hasAudio: st && typeof st.audio === 'boolean' ? st.audio : null,
    stream: st ? st.stream : null,
    events: { supported: st ? st.events !== 'unsupported' : null, state: st ? st.events : null, kinds: json(r.kinds, []) },
    settings: s,
    snapshotAt: st ? iso(st.snapshotAt) : null, lastEventAt: st ? iso(st.lastEventAt) : null,
  };
}

/** gc.cameras.list() — every camera of every enabled gateway. */
function list() {
  const rows = db().prepare(`SELECT c.*, p.name AS gw_name FROM home_cameras c JOIN peers p ON p.id = c.peer_id AND p.enabled = 1
    ORDER BY p.name COLLATE NOCASE, c.name COLLATE NOCASE`).all();
  return rows.map((r) => cameraView(r, r.gw_name));
}

/** gc.cameras.discover({ gatewayId? }) — WS-Discovery on one or every gateway with the function. */
async function discover({ gatewayId } = {}) {
  const gws = gatewayId != null ? [needGateway(Number(gatewayId))] : gatewaysWithCameras().filter((g) => g.enabled && g.supported && g.online);
  const known = new Map(db().prepare('SELECT id, peer_id, host FROM home_cameras').all().map((r) => [`${r.peer_id}:${r.host}`, r.id]));
  const found = [];
  await Promise.all(gws.map(async (g) => {
    try {
      const r = await mgmt(g.id, '/api/cameras/discover', {}, 12000);
      for (const x of (Array.isArray(r.found) ? r.found : []).slice(0, 64)) {
        if (!x || !isPrivate(x.host)) continue;
        found.push({
          gatewayId: g.id, gateway: g.name, host: x.host,
          port: Number.isInteger(x.port) ? x.port : 80, path: typeof x.path === 'string' && ONVIF_PATH_RE.test(x.path) ? x.path : '/onvif/device_service',
          manufacturer: clean(x.manufacturer, 48) || null, model: clean(x.hardware, 48) || null, name: clean(x.name, 48) || null,
          cameraId: known.get(`${g.id}:${x.host}`) || null,
        });
      }
    } catch (e) { if (gatewayId != null) throw e; }
  }));
  return { found };
}

function cleanAccess(a) {
  const user = a.user == null ? '' : a.user;
  const password = a.password == null ? '' : a.password;
  if (typeof user !== 'string' || user.length > 64 || typeof password !== 'string' || password.length > 128 || /[\r\n\0]/.test(user + password)) {
    fail('invalid', 'user ≤ 64, password ≤ 128 characters, no line breaks');
  }
  return { user, password };
}

/** The address part of a test/add call → { host, onvifPort, onvifPath, rtspUrl } (checked; never a credential in the URL kept). */
function cleanTarget(a) {
  if (typeof a.rtspUrl === 'string' && a.rtspUrl.trim()) {
    let u;
    try { u = new URL(a.rtspUrl.trim()); } catch { fail('invalid', 'rtspUrl: rtsp://address[:port]/path'); }
    if (u.protocol !== 'rtsp:' || u.hash || !isPrivate(u.hostname)) fail('invalid_host', 'rtspUrl: rtsp:// to a private IPv4 address (RFC 1918) of the home network');
    const path = (u.pathname || '/') + u.search;
    if (!RTSP_PATH_RE.test(path)) fail('invalid', 'rtspUrl: invalid path');
    const port = u.port ? Number(u.port) : 554;
    return { host: u.hostname, rtsp: { port, path }, rtspUrl: `rtsp://${u.hostname}:${port}${path}`, urlUser: u.username ? decodeURIComponent(u.username) : null, urlPassword: u.password ? decodeURIComponent(u.password) : null };
  }
  const host = typeof a.host === 'string' ? a.host.trim() : '';
  if (!isPrivate(host)) fail('invalid_host', 'host: a private IPv4 address (RFC 1918) of the home network');
  const onvifPort = a.onvifPort == null ? null : a.onvifPort;
  if (onvifPort !== null && !(Number.isInteger(onvifPort) && onvifPort > 0 && onvifPort < 65536)) fail('invalid', 'onvifPort: 1…65535');
  const onvifPath = a.onvifPath == null ? null : a.onvifPath;
  if (onvifPath !== null && !(typeof onvifPath === 'string' && ONVIF_PATH_RE.test(onvifPath))) fail('invalid', 'onvifPath: a path like /onvif/device_service');
  if (a.onvifTls != null && typeof a.onvifTls !== 'boolean') fail('invalid', 'onvifTls: true or false');
  return { host, onvifPort, onvifPath, onvifTls: a.onvifTls === true };
}

/** gc.cameras.test(): the gateway connects and answers device, profiles and a test picture (nothing stored). */
async function test(a0) {
  const a = a0 && typeof a0 === 'object' ? a0 : {};
  const g = needGateway(Number(a.gatewayId));
  const target = cleanTarget(a);
  const acc = cleanAccess(a);
  if (a.tlsInsecure != null && typeof a.tlsInsecure !== 'boolean') fail('invalid', 'tlsInsecure: true or false');
  // "Zertifikat nicht prüfen" only when the administrator chose it (gateway ≥ 1.29.0; older ones ignore both)
  const tls = { ...(target.onvifTls ? { onvifTls: true } : {}), ...(a.tlsInsecure === true ? { tlsInsecure: true } : {}) };
  const body = target.rtsp
    ? { rtspUrl: target.rtspUrl, user: acc.user || target.urlUser || '', password: acc.password || target.urlPassword || '' }
    : { host: target.host, ...(target.onvifPort ? { onvifPort: target.onvifPort } : {}), ...(target.onvifPath ? { onvifPath: target.onvifPath } : {}), ...tls, user: acc.user, password: acc.password, ...(typeof a.profile === 'string' && PROFILE_RE.test(a.profile) ? { profile: a.profile } : {}) };
  const r = await mgmt(g.id, '/api/cameras/probe', body, 45000);
  return { gateway: { id: g.id, name: g.name }, ...probeView(r) };
}

function probeView(r) {
  const snap = r.snapshot && typeof r.snapshot.data === 'string' && r.snapshot.data.length <= 1.5 * 1024 * 1024 ? { data: r.snapshot.data, mime: 'image/jpeg' } : null;
  const info = r.info && typeof r.info === 'object' ? r.info : {};
  return {
    ok: r.ok === true, source: r.source === 'rtsp' ? 'rtsp' : 'onvif', host: isPrivate(r.host) ? r.host : null,
    onvif: r.onvif && Number.isInteger(r.onvif.port) ? { port: r.onvif.port, path: ONVIF_PATH_RE.test(r.onvif.path || '') ? r.onvif.path : '/onvif/device_service', tls: r.onvif.tls === true } : null,
    tlsInsecure: r.tlsInsecure === true,
    info: { manufacturer: clean(info.manufacturer, 48) || null, model: clean(info.model, 48) || null, firmware: clean(info.firmware, 48) || null },
    profile: typeof r.profile === 'string' && PROFILE_RE.test(r.profile) ? r.profile : null,
    profiles: (Array.isArray(r.profiles) ? r.profiles : []).slice(0, 8).filter((p) => p && PROFILE_RE.test(String(p.token))).map((p) => ({
      token: p.token, name: clean(p.name, 48) || p.token, codec: ['h264', 'h265'].includes(p.codec) ? p.codec : 'other',
      width: Number.isInteger(p.width) ? p.width : null, height: Number.isInteger(p.height) ? p.height : null,
    })),
    rtsp: r.rtsp && Number.isInteger(r.rtsp.port) && RTSP_PATH_RE.test(String(r.rtsp.path)) ? { port: r.rtsp.port, path: r.rtsp.path } : null,
    events: { supported: !!(r.events && r.events.supported), kinds: r.events && Array.isArray(r.events.kinds) ? KINDS.filter((k) => r.events.kinds.includes(k)) : [] },
    codec: ['h264', 'h265'].includes(r.codec) ? r.codec : null,
    width: Number.isInteger(r.width) && r.width > 0 && r.width < 20000 ? r.width : null,
    height: Number.isInteger(r.height) && r.height > 0 && r.height < 20000 ? r.height : null,
    audio: typeof r.audio === 'boolean' ? r.audio : null,
    snapshot: snap,
  };
}

function newId() { return 'c' + crypto.randomBytes(8).toString('hex').slice(0, 15); }

/** gc.cameras.add(): test first, store only when the gateway reached the camera. */
async function add(plugin, a0) {
  const a = a0 && typeof a0 === 'object' ? a0 : {};
  const name = clean(a.name, 60);
  if (!name) fail('invalid', 'name: 1…60 characters');
  const settings = patchSettings(cameraSettings({}), a.settings);
  const g = needGateway(Number(a.gatewayId));
  if (rowsOf(g.id).length >= MAX_PER_GATEWAY) fail('limit', `at most ${MAX_PER_GATEWAY} cameras per gateway`);
  const target = cleanTarget(a);
  const acc = cleanAccess(a);
  const user = acc.user || target.urlUser || '';
  const password = acc.password || target.urlPassword || '';
  const probe = await test({ ...a, user, password, rtspUrl: target.rtsp ? target.rtspUrl : null });
  if (!probe.ok) fail('unreachable', 'the camera did not answer the test');
  const id = newId();
  const now = Date.now();
  const enc = password ? require('../utils/crypto').encrypt(password) : null;
  const onvif = probe.source === 'onvif' ? (probe.onvif || { port: target.onvifPort || 80, path: target.onvifPath || '/onvif/device_service', tls: target.onvifTls }) : null;
  const onvifTls = !!(onvif && onvif.tls);
  db().prepare(`INSERT INTO home_cameras (id, peer_id, name, host, onvif_port, onvif_path, onvif_tls, tls_insecure, rtsp_port, rtsp_path, profile, username, password_enc, manufacturer, model, firmware, codec, kinds, settings, state, plugin_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`).run(
    id, g.id, name, target.host, onvif ? onvif.port : null, onvif ? onvif.path : null, onvifTls ? 1 : 0, onvifTls && a.tlsInsecure === true ? 1 : 0,
    target.rtsp ? target.rtsp.port : null, target.rtsp ? target.rtsp.path : null,
    typeof a.profile === 'string' && PROFILE_RE.test(a.profile) ? a.profile : probe.profile, user || null, enc, probe.info.manufacturer, probe.info.model, probe.info.firmware,
    probe.codec, JSON.stringify(probe.events.kinds), JSON.stringify(settings), plugin && plugin.id ? plugin.id : null, now, now);
  audit('camera_added', `Camera "${name}" added on gateway "${g.name}"`, { peer_id: g.id, camera: id, plugin: plugin && plugin.id });
  require('./gatewayFeatures').notifyGateway(g.id);
  const r = rowOf(id);
  return { camera: cameraView(r, g.name), snapshot: probe.snapshot };
}

/** gc.cameras.update(id, { name?, user?, password?, profile?, tlsInsecure?, settings? }) */
function update(id, p0) {
  const r = rowOf(id);
  const p = p0 && typeof p0 === 'object' && !Array.isArray(p0) ? p0 : fail('invalid', 'patch must be an object');
  const sets = [];
  const vals = [];
  if ('name' in p) { const n = clean(p.name, 60); if (!n) fail('invalid', 'name: 1…60 characters'); sets.push('name = ?'); vals.push(n); }
  if ('user' in p || 'password' in p) {
    const acc = cleanAccess({ user: 'user' in p ? p.user : r.username, password: 'password' in p ? p.password : '' });
    if ('user' in p) { sets.push('username = ?'); vals.push(acc.user || null); }
    if ('password' in p) { sets.push('password_enc = ?'); vals.push(acc.password ? require('../utils/crypto').encrypt(acc.password) : null); }
  }
  if ('profile' in p) {
    if (p.profile !== null && !(typeof p.profile === 'string' && PROFILE_RE.test(p.profile))) fail('invalid', 'profile: an ONVIF profile token');
    sets.push('profile = ?'); vals.push(p.profile);
  }
  if ('tlsInsecure' in p) {
    if (typeof p.tlsInsecure !== 'boolean') fail('invalid', 'tlsInsecure: true or false');
    // "Zertifikat nicht prüfen": changes the access → the gateway resolves the camera again (updated_at)
    sets.push('tls_insecure = ?'); vals.push(p.tlsInsecure ? 1 : 0);
  }
  if ('settings' in p) { sets.push('settings = ?'); vals.push(JSON.stringify(patchSettings(cameraSettings(json(r.settings, {})), p.settings))); }
  if (!sets.length) fail('invalid', 'nothing to change');
  sets.push('updated_at = ?'); vals.push(Date.now());
  db().prepare(`UPDATE home_cameras SET ${sets.join(', ')} WHERE id = ?`).run(...vals, r.id);
  require('./gatewayFeatures').notifyGateway(r.peer_id);
  const n = rowOf(r.id);
  const g = db().prepare('SELECT name FROM peers WHERE id = ?').get(n.peer_id);
  return cameraView(n, g ? g.name : null);
}

/** gc.cameras.remove(id, { deleteClips? }) */
async function remove(id, o = {}) {
  const r = rowOf(id);
  if (o && o.deleteClips === true) {
    const ids = db().prepare('SELECT id FROM home_camera_events WHERE camera_id = ?').all(r.id).map((x) => x.id);
    for (let i = 0; i < ids.length; i += 100) {
      try { await mgmt(r.peer_id, '/api/cameras/events/delete', { ids: ids.slice(i, i + 100) }, 15000); } catch (e) { logger.info({ err: e.message }, 'cameras: clips not deleted on the gateway'); break; }
    }
  }
  db().prepare('DELETE FROM home_cameras WHERE id = ?').run(r.id);
  audit('camera_removed', `Camera "${r.name}" removed`, { peer_id: r.peer_id, camera: r.id });
  require('./gatewayFeatures').notifyGateway(r.peer_id);
  return { removed: true };
}

const snapCache = new Map(); // camera id → { at, data }

/** The newest picture (≤ maxBytes) of a camera → Buffer; a short cache keeps many viewers off the gateway. */
async function snapshotBytes(id, maxBytes = 4 * 1024 * 1024) {
  const r = rowOf(id);
  const c = snapCache.get(r.id);
  if (c && Date.now() - c.at < 2000 && c.data.length <= maxBytes) return { data: c.data, at: c.taken };
  const res = await gw().mgmtBinary(r.peer_id, '/api/cameras/snapshot', { method: 'POST', body: { id: r.id, maxBytes }, maxBytes: maxBytes + 1024, totalMs: 20000, headerMs: 20000 })
    .catch((e) => fail(e.code === 'too_large' ? 'too_large' : 'offline', 'the gateway does not answer'));
  if (res.status !== 200 || !/^image\/jpeg/.test(res.type) || res.body.length < 4 || res.body[0] !== 0xff || res.body[1] !== 0xd8) {
    let err = null;
    try { err = JSON.parse(res.body.toString('utf8')).error; } catch { err = null; }
    fail(MGMT_ERRORS[err] || 'not_ready', err || 'no picture');
  }
  const taken = Date.parse(String(res.headers['x-snapshot-at'] || '')) || Date.now();
  snapCache.set(r.id, { at: Date.now(), data: res.body, taken });
  if (snapCache.size > 64) snapCache.delete(snapCache.keys().next().value);
  return { data: res.body, at: taken };
}

/** gc.cameras.snapshot(id, { maxBytes }) → { data (base64), mime, at } — default ≤ 300 KB (a push picture). */
async function snapshot(id, o = {}) {
  const max = Number.isInteger(o && o.maxBytes) ? Math.max(16 * 1024, Math.min(4 * 1024 * 1024, o.maxBytes)) : PUSH_IMAGE_MAX;
  const s = await snapshotBytes(id, max);
  return { data: s.data.toString('base64'), mime: 'image/jpeg', at: iso(s.at) };
}

// ─── Media tokens (/camera-media/<token>/<file>) ───────────────────────

let tokenKey = null;
function key() {
  if (tokenKey) return tokenKey;
  let base = '';
  try { base = String(require('../../config/default').encryption.key || ''); } catch { base = ''; }
  tokenKey = base ? crypto.createHmac('sha256', base).update('gatecontrol camera media v1').digest() : crypto.randomBytes(32);
  return tokenKey;
}
const b64u = (b) => Buffer.from(b).toString('base64url');

/** kind snap | live | clip, subject camera or event id, plugin, seconds valid → token */
function sign(kind, subject, pluginId, ttlS) {
  const body = b64u(JSON.stringify({ k: kind, s: subject, p: pluginId, e: Math.floor(Date.now() / 1000) + ttlS }));
  return body + '.' + b64u(crypto.createHmac('sha256', key()).update(body).digest());
}

function verify(token) {
  const m = /^([A-Za-z0-9_-]{16,400})\.([A-Za-z0-9_-]{43})$/.exec(String(token || ''));
  if (!m) return null;
  const want = crypto.createHmac('sha256', key()).update(m[1]).digest();
  const got = Buffer.from(m[2], 'base64url');
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
  const p = json(Buffer.from(m[1], 'base64url').toString('utf8'));
  if (!p || !FILES[p.k] || typeof p.s !== 'string' || !Number.isSafeInteger(p.e) || p.e < Date.now() / 1000) return null;
  return p;
}

function url(token, file) { return `/camera-media/${token}/${file}`; }

/** gc.cameras.snapshotUrl(id) → { url, expiresAt } */
function snapshotUrl(pluginId, id) {
  const r = rowOf(id);
  return { url: url(sign('snap', r.id, pluginId, SNAP_TTL_S), 'snapshot.jpg'), expiresAt: iso(Date.now() + SNAP_TTL_S * 1000), every: SNAP_EVERY_S };
}

/** 'vpn' | 'lan' | 'internet' of the request behind a plugin call (requestRefs). */
function netOfRequest(ctx) {
  if (!ctx || !ctx.ip) return 'internet';
  try {
    if (require('./homeNetwork').viaOf(ctx.ip) === 'tunnel') return 'vpn';
    let a = ipaddr.parse(String(ctx.ip));
    if (a.kind() === 'ipv6' && a.isIPv4MappedAddress()) a = a.toIPv4Address();
    return ['private', 'uniqueLocal', 'loopback'].includes(a.range()) ? 'lan' : 'internet';
  } catch { return 'internet'; }
}

/** gc.cameras.live(id, req) — live video only in the VPN / the server's LAN, else a snapshot every 10 s. */
async function live(pluginId, id, ctx) {
  const r = rowOf(id);
  const net = netOfRequest(ctx);
  const snap = url(sign('snap', r.id, pluginId, SNAP_TTL_S), 'snapshot.jpg');
  if (net === 'internet') return { mode: 'snapshot', snapshot: snap, every: SNAP_EVERY_S, reason: 'vpn_required', via: net };
  const out = await mgmt(r.peer_id, '/api/cameras/live', { id: r.id }, 8000);
  const tok = sign('live', r.id, pluginId, LIVE_TTL_S);
  const st = cameraSettings(json(r.settings, {}));
  return {
    mode: 'live', via: net, ready: out.ready === true, hls: url(tok, 'index.m3u8'), mp4: url(tok, 'live.mp4'), snapshot: url(tok, 'snapshot.jpg'),
    codec: typeof out.codec === 'string' && /^[a-z0-9., ]{1,80}$/i.test(out.codec) ? out.codec : null, audio: st.audio && audioOf(r) !== false, every: SNAP_EVERY_S,
    expiresAt: iso(Date.now() + LIVE_TTL_S * 1000),
  };
}

/** The last report's sound track of a camera: true / false / null (unknown, older gateway). */
function audioOf(r) {
  const st = json(r.state, null);
  return st && typeof st.audio === 'boolean' ? st.audio : null;
}

function eventView(e, pluginId) {
  const gone = e.clip_gone === 1;
  const tok = pluginId ? sign('clip', e.id, pluginId, CLIP_TTL_S) : null;
  return {
    id: e.id, cameraId: e.camera_id, camera: e.cam_name || null, kind: e.kind, kinds: json(e.kinds, []),
    startedAt: iso(e.started_at), endedAt: iso(e.ended_at), nobodyHome: e.nobody_home === null ? null : e.nobody_home === 1,
    clip: e.clip_ms && !gone ? { ms: e.clip_ms, bytes: e.clip_bytes } : null,
    thumbUrl: tok && e.has_thumb === 1 && !gone ? url(tok, 'thumb.jpg') : null,
    clipUrl: tok && e.clip_ms && !gone ? url(tok, 'clip.mp4') : null,
  };
}

/** gc.cameras.events({ cameraId?, since?, until?, kinds?, limit? }) — newest first. */
function events(pluginId, q0 = {}) {
  const q = q0 && typeof q0 === 'object' ? q0 : {};
  const where = [];
  const vals = [];
  if (q.cameraId != null) { if (typeof q.cameraId !== 'string' || !ID_RE.test(q.cameraId)) fail('invalid', 'cameraId'); where.push('e.camera_id = ?'); vals.push(q.cameraId); }
  const t = (v, k) => { if (v == null) return null; const x = typeof v === 'number' ? v : Date.parse(v); if (!Number.isFinite(x)) fail('invalid', k + ': ISO time'); return x; };
  const since = t(q.since, 'since');
  const until = t(q.until, 'until');
  if (since !== null) { where.push('e.started_at >= ?'); vals.push(since); }
  if (until !== null) { where.push('e.started_at < ?'); vals.push(until); }
  if (q.kinds != null) {
    if (!Array.isArray(q.kinds) || !q.kinds.every((k) => KINDS.includes(k))) fail('invalid', 'kinds');
    if (q.kinds.length) { where.push(`e.kind IN (${q.kinds.map(() => '?').join(',')})`); vals.push(...q.kinds); }
  }
  const limit = Number.isInteger(q.limit) ? Math.max(1, Math.min(200, q.limit)) : 50;
  const rows = db().prepare(`SELECT e.*, c.name AS cam_name FROM home_camera_events e JOIN home_cameras c ON c.id = e.camera_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY e.started_at DESC LIMIT ?`).all(...vals, limit);
  return rows.map((e) => eventView(e, pluginId));
}

/** gc.cameras.deleteEvent(id) — the event and its clip on the gateway. */
async function deleteEvent(id) {
  if (typeof id !== 'string' || !EVENT_RE.test(id)) fail('invalid', 'event id');
  const e = db().prepare('SELECT id, peer_id FROM home_camera_events WHERE id = ?').get(id);
  if (!e) fail('not_found', 'no such event');
  try { await mgmt(e.peer_id, '/api/cameras/events/delete', { ids: [id] }, 10000); } catch (err) { if (err.code !== 'offline') throw err; }
  db().prepare('DELETE FROM home_camera_events WHERE id = ?').run(id);
  return { deleted: true };
}

// ─── /camera-media/<token>/<file> ──────────────────────────────────────

const TYPES = { m3u8: 'application/vnd.apple.mpegurl', mp4: 'video/mp4', m4s: 'video/iso.segment', jpg: 'image/jpeg' };

// The token is the permission and no cookie is used: every origin may read the media — also the sandboxed plugin
// frames (opaque origin "null"), whose MSE player fetches live.mp4 (Firefox has no HLS of its own).
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'Content-Length, Content-Range, X-Snapshot-At' };

function mediaError(res, status) {
  res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...CORS });
  return res.status(status).type('text/plain').send(status === 404 ? 'not found' : 'unavailable');
}

/** Pipe one answer of the gateway on (status, type, length, range — nothing else of its headers). */
async function pipe(req, res, peerId, path, { range = false, cache = 'no-store' } = {}) {
  const ctrl = new AbortController();
  res.on('close', () => ctrl.abort());
  let up;
  try { up = await gw().mgmtRequest(peerId, path, { headers: range && req.headers.range ? { range: req.headers.range } : {}, signal: ctrl.signal, headerMs: 20000 }); } catch { return mediaError(res, 502); }
  if (up.statusCode !== 200 && up.statusCode !== 206) { up.resume(); return mediaError(res, up.statusCode === 404 ? 404 : 502); }
  const ext = path.split('?')[0].split('.').pop();
  res.status(up.statusCode).set({
    'Content-Type': TYPES[ext] || 'application/octet-stream', 'Cache-Control': cache, 'X-Content-Type-Options': 'nosniff',
    'Cross-Origin-Resource-Policy': 'cross-origin', 'Content-Security-Policy': "default-src 'none'", ...CORS,
  });
  for (const h of ['content-length', 'content-range', 'accept-ranges']) if (up.headers[h]) res.set(h, String(up.headers[h]));
  up.on('error', () => res.destroy());
  up.pipe(res);
  return undefined;
}

/** GET /camera-media/:token/:file */
async function mediaRequest(req, res) {
  const tok = verify(req.params.token);
  const file = String(req.params.file || '');
  if (!tok || !(FILES[tok.k].includes(file) || (tok.k === 'live' && SEG_RE.test(file)))) return mediaError(res, 404);
  let p = null;
  try { p = require('./plugins/registry').get(tok.p); } catch { p = null; }
  if (!hasPermission(p)) return mediaError(res, 404);
  if (tok.k === 'clip') {
    const e = db().prepare('SELECT id, peer_id, clip_gone FROM home_camera_events WHERE id = ?').get(tok.s);
    if (!e || e.clip_gone === 1) return mediaError(res, 404);
    return pipe(req, res, e.peer_id, `/api/cameras/events/${e.id}/${file}`, { range: file === 'clip.mp4', cache: 'private, max-age=3600' });
  }
  const cam = db().prepare('SELECT id, peer_id FROM home_cameras WHERE id = ?').get(tok.s);
  if (!cam) return mediaError(res, 404);
  if (file === 'snapshot.jpg') {
    try {
      const s = await snapshotBytes(cam.id);
      res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'cross-origin', 'X-Snapshot-At': iso(s.at), ...CORS });
      return res.send(s.data);
    } catch { return mediaError(res, 502); }
  }
  if (file === 'live.mp4') {
    const left = Math.max(10, Math.min(300, tok.e - Math.floor(Date.now() / 1000)));
    return pipe(req, res, cam.peer_id, `/api/cameras/${cam.id}/live.mp4?s=${left}`);
  }
  return pipe(req, res, cam.peer_id, `/api/cameras/${cam.id}/live/${file}`);
}

// ─── Overview (row "Kameras", admin API) ───────────────────────────────

/** A hint for weak hardware (never a ban): Pi 3 B+/3/Zero → 1 camera with motion detection, Pi 4 → 4. */
function hardwareHint(tel, rows) {
  const board = require('./gatewayFeatures').boardOf(tel && tel.hardware && tel.hardware.model);
  const max = board === 'pi3bplus' || board === 'pi3' || board === 'pi_zero' ? 1 : (board === 'pi4' ? 4 : null);
  if (!max) return null;
  const motion = rows.filter((r) => cameraSettings(json(r.settings, {})).record !== 'never').length;
  return { key: max === 1 ? 'one_motion' : 'four_motion', max, motion, over: motion > max, board };
}

function telemetryCameras(tel) {
  const t = tel && tel.features && tel.features.cameras;
  if (!t || typeof t !== 'object') return null;
  return {
    enabled: t.enabled === true, service: SERVICES.includes(t.service) ? t.service : 'missing',
    state: ['off', 'service_missing', 'running', 'error'].includes(t.state) ? t.state : 'off',
    cameras: Number.isInteger(t.cameras) ? t.cameras : 0, recording: Number.isInteger(t.recording) ? t.recording : 0,
    storage: cleanStorage(t.storage), error: cleanError(t.error),
  };
}

/**
 * Is the chosen clip folder in use? (gateway ≥ 1.29.0 reports where /recordings lies)
 *   'ok'        the folder (or, without a choice, the Docker volume) is mounted
 *   'compose'   a folder is chosen, the gateway still uses the volume / another folder → the new compose file
 *   'container' /recordings is no mount at all: clips would go with the next update
 *   null        unknown (older gateway, switched off, Raspberry Pi image)
 */
function storageState(s, storage, platform) {
  if (!s || !s.enabled || !storage || !storage.mount || platform === 'rpi') return null;
  if (storage.mount === 'none') return 'container';
  if (!s.storagePath) return 'ok';
  if (storage.mount !== 'folder' || !storage.folder) return 'compose';
  // the gateway sees the path inside its file system (Synology: /kameras for /volume1/kameras)
  const f = storage.folder.replace(/\/$/, '');
  return f && f !== '/' && (s.storagePath === f || s.storagePath.endsWith(f)) ? 'ok' : 'compose';
}

/** The clip folder for the compose file of this gateway (null: the Docker volume cam-recordings). */
function composeStoragePath(peerId) {
  try { return settingsOf(peerId).storagePath || null; } catch { return null; }
}

/** Does the compose file of this gateway need the service kameras? (switched on) */
function composeWantsCameras(peerId) {
  try { return settingsOf(peerId).enabled; } catch { return false; }
}

function composeHint(t, s, platform) {
  if (!s || !s.enabled) return null;
  const service = t ? t.service : 'missing';
  if (service === 'managed') return null;
  if (platform === 'rpi') return service === 'absent' ? null : 'image';
  return 'compose';
}

/** The part of the memory estimate: ffmpeg + the ring per camera (≈ 150 MB with two cameras). */
function memoryPart(peerId, s) {
  if (!s || !s.cameras || !s.cameras.enabled) return null;
  const n = db().prepare('SELECT COUNT(*) AS n FROM home_cameras WHERE peer_id = ?').get(peerId).n;
  return { key: 'cameras', mb: MEM_BASE_MB + MEM_PER_CAMERA_MB * Math.max(1, n), cameras: n };
}

/** The part of features.overview for the row "Kameras". */
function overview(peerId) {
  const gf = require('./gatewayFeatures');
  const g = gf.needGateway(peerId);
  const tel = gf.telemetryOf(g);
  const s = settingsOf(g.id);
  const rows = rowsOf(g.id);
  const t = telemetryCameras(tel);
  const rep = db().prepare('SELECT report FROM home_camera_gateways WHERE peer_id = ?').get(g.id);
  const report = rep ? json(rep.report, {}) : {};
  let plugin = null;
  try {
    const p = require('./plugins/registry').get('gatecontrol-door');
    plugin = p ? { installed: true, enabled: p.enabled === true, cameras: hasPermission(p) } : { installed: false, enabled: false, cameras: false };
  } catch { plugin = null; }
  const platform = require('./homeRadio').platformOf(g.id, tel);
  const storage = report.storage || (t ? t.storage : null);
  return {
    enabled: s.enabled, subnets: s.subnets, storagePath: s.storagePath, supported: supported(tel), minGateway: MIN_GATEWAY, platform,
    storageState: storageState(s, storage, platform),
    count: rows.length, names: rows.slice(0, 6).map((r) => r.name),
    service: t ? t.service : null, state: t ? t.state : null,
    storage,
    hint: hardwareHint(tel, rows),
    compose: composeHint(t, s, platform),
    plugin,
  };
}

/** GET /api/v1/gateways/:id/cameras — everything of this gateway, live from the gateway when it answers. */
async function view(peerId) {
  const gf = require('./gatewayFeatures');
  const g = gf.needGateway(peerId);
  const ov = overview(g.id);
  let live = null;
  if (ov.supported && ov.enabled) {
    try { live = (await mgmt(g.id, '/api/cameras/status', {}, 5000)).cameras || null; } catch { live = null; }
  }
  const cams = rowsOf(g.id).map((r) => cameraView(r, g.name));
  return { gateway: { id: g.id, name: g.name }, ...ov, cameras: cams, live: live ? { service: live.service, storage: cleanStorage(live.storage), discovered: Array.isArray(live.discovered) ? live.discovered.length : 0 } : null };
}

// ─── Housekeeping ──────────────────────────────────────────────────────

/** Hourly: clips past their camera's retention are gone on the gateway; events after 90 days go. */
function housekeeping(now = Date.now()) {
  const d = db();
  let n = 0;
  for (const r of d.prepare('SELECT id, settings FROM home_cameras').all()) {
    const days = cameraSettings(json(r.settings, {})).retentionDays;
    n += d.prepare('UPDATE home_camera_events SET clip_gone = 1 WHERE camera_id = ? AND clip_gone = 0 AND started_at < ?').run(r.id, now - (days + 1) * 86400_000).changes;
  }
  n += d.prepare('DELETE FROM home_camera_events WHERE started_at < ?').run(now - KEEP_EVENTS_MS).changes;
  return n;
}

function audit(event, text, details) {
  try { require('./activity').log(event, text, { source: 'plugin', severity: 'info', details }); } catch { /* best-effort */ }
}

const HOST_CODES = {
  invalid: 'ERR_INVALID', invalid_host: 'ERR_CAMERA_NOT_ALLOWED', not_allowed: 'ERR_CAMERA_NOT_ALLOWED', not_found: 'ERR_NOT_FOUND',
  offline: 'ERR_CAMERA_OFFLINE', unsupported: 'ERR_CAMERA_UNSUPPORTED', auth: 'ERR_CAMERA_AUTH', unreachable: 'ERR_CAMERA_UNREACHABLE',
  no_stream: 'ERR_CAMERA_UNREACHABLE', limit: 'ERR_CAMERA_LIMIT', not_ready: 'ERR_CAMERA_NOT_READY', service_missing: 'ERR_CAMERA_SERVICE_MISSING',
  too_large: 'ERR_CAMERA_NOT_READY', gateway_error: 'ERR_CAMERA_UNREACHABLE', tls: 'ERR_CAMERA_TLS',
};

module.exports = {
  MIN_GATEWAY, MAX_PER_GATEWAY, KINDS, DEFAULT_CAMERA, CameraError, HOST_CODES, SNAP_EVERY_S,
  normalizeSettings, patchField, cameraSettings, patchSettings, configPayload, credentialsFor, credRev, nobodyHome, presenceChanged,
  ingestReport, ingestEvents, emit, available, list, discover, test, add, update, remove, snapshot, snapshotBytes, snapshotUrl, live, events, deleteEvent,
  sign, verify, mediaRequest, netOfRequest, overview, view, memoryPart, composeWantsCameras, composeHint, telemetryCameras, hardwareHint, supported, housekeeping,
  storagePath, storageState, composeStoragePath,
  _resetForTest() { snapCache.clear(); tokenKey = null; lastNobody = undefined; },
};
