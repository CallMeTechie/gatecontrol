'use strict';

// „Videos umwandeln“ (the gateway's docs/transcode.md, contract medien-entwurf/umwandeln-vertrag.md).
// The service `umwandeln` next to a gateway on a NAS turns videos that do not play everywhere (H.264 with
// 10 bit) into H.264 8 bit with the graphics hardware and swaps the file in place; the original stays in
// `.gc-papierkorb` until its time is up. The server keeps the switch per gateway, builds the compose service,
// stores the gateway's reports and hands everything to plugins with permissions.transcode (the plugin
// „Medien“: which files, when, in which order).
//
//   switch per gateway: gateway_features.settings.transcode { enabled, roots, uid, gid, software, trashDays, quality }
//     (services/gatewayFeatures.js) → features.transcode of the config pull
//   POST /api/v1/gateway/transcode/report   ingestReport() → hook transcodeChanged of the plugins
//   management calls to the gateway (gateways.mgmtCall): /api/transcode/*  (gc.transcode.*)
//   compose (public/js/gateway-kit.js buildCompose): the service umwandeln with the folders, the user and the
//     group of the graphics device (composeOptions)

const { getDb } = require('../db/connection');
const logger = require('../utils/logger');

// the first gateway with the capability `transcode`
const MIN_GATEWAY = '1.50.0';
const MAX_ROOTS = 8;
const ROOT_MAX_LEN = 200;
const TRASH_DIR = '.gc-papierkorb';
const WORK_DIR = '.gc-umwandeln';
// a folder of the NAS: segments of letters, digits, space and . _ - @ + ( ) & , ' ! — no ":" (it separates the
// folders in GC_UMW_ROOTS), no "$" (compose would read a variable), no quotes or backslashes (YAML)
const SEG_RE = /^[\p{L}\p{N}._@+()&,'! -]{1,120}$/u;
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const DEFAULTS = Object.freeze({ enabled: false, roots: [], uid: null, gid: null, software: false, trashDays: 14, quality: 23 });
// the group of /dev/dri/renderD128 while the gateway has not reported it (Debian: video = 44)
const DEFAULT_RENDER_GID = 44;
const SERVICES = ['managed', 'absent', 'missing'];
const STATES = ['off', 'service_missing', 'no_roots', 'no_device', 'device_denied', 'no_encoder', 'paused', 'running', 'ready'];
const DEVICES = ['ok', 'denied', 'absent'];
const ROOT_STATES = ['ok', 'readonly', 'missing', 'not_mounted'];
const JOB_STATES = ['queued', 'running', 'paused', 'verifying', 'done', 'failed', 'cancelled'];
const MODES = ['vaapi_icq', 'vaapi_qvbr', 'software'];
const MAX_JOBS = 240;
const MAX_TRASH = 1000;
const HOOK_MS = 5000;
const CODE_RE = /^[a-z][a-z0-9_]{0,39}$/;
const MEDIEN_PLUGIN = 'gatecontrol-medien';

class TranscodeError extends Error {
  /** code: what the host API maps (HOST_CODES); reason: the gateway's own code, passed on to the plugin */
  constructor(code, message, reason) { super(message || code); this.code = code; if (reason) this.reason = reason; }
}

function db() { return getDb(); }
function json(s, d = null) { try { return s ? JSON.parse(s) : d; } catch { return d; } }
function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
function fail(code, message, reason) { throw new TranscodeError(code, message, reason); }
// eslint-disable-next-line no-control-regex
function clean(v, n) { return typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim().slice(0, n) : ''; }
function int(v, min, max, d = null) { return Number.isInteger(v) && v >= min && v <= max ? v : d; }
function num(v, min, max) { return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : null; }
function bytes(v) { return Number.isSafeInteger(v) && v >= 0 ? v : null; }
function isoOrNull(v) {
  if (typeof v !== 'string' || v.length > 40) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}
function code(v) { return typeof v === 'string' && CODE_RE.test(v) ? v : null; }

// ─── Settings (part of the gateway's features) ─────────────────────────

/**
 * A media folder of the gateway host → the folder, or null. Absolute, normalised (no "//", ".", ".." and no
 * trailing "/"), at most 16 levels and 200 characters, plain names (SEG_RE), never one of the service's own
 * folders. Inside the service it has the same path as outside (`/volume2/mediathek:/volume2/mediathek`).
 */
function rootPath(v) {
  if (typeof v !== 'string') return null;
  let t = v.trim();
  if (t.length > 1 && t.endsWith('/')) t = t.slice(0, -1);
  if (!t || t.length > ROOT_MAX_LEN || t[0] !== '/' || t === '/') return null;
  const segs = t.split('/').slice(1);
  if (segs.length > 16) return null;
  for (const s of segs) {
    if (!s || s === '.' || s === '..' || s === TRASH_DIR || s === WORK_DIR || !SEG_RE.test(s) || s !== s.trim()) return null;
  }
  return t;
}

/** A list of folders → the valid ones, without duplicates and without one inside another (the first wins), ≤ 8. */
function rootsOf(list) {
  const out = [];
  for (const r of Array.isArray(list) ? list : []) {
    const p = rootPath(r);
    if (!p || out.some((o) => o === p || p.startsWith(o + '/') || o.startsWith(p + '/'))) continue;
    out.push(p);
    if (out.length >= MAX_ROOTS) break;
  }
  return out;
}

/** features.transcode of the stored gateway settings (any shape) → the complete settings. */
function normalizeSettings(raw) {
  const r = isObj(raw) ? raw : {};
  return {
    enabled: r.enabled === true,
    roots: rootsOf(r.roots),
    // the DSM user of the service (uid, gid): never root
    uid: int(r.uid, 1, 2147483647),
    gid: int(r.gid, 1, 2147483647),
    software: r.software === true,
    trashDays: int(r.trashDays, 1, 365, DEFAULTS.trashDays),
    quality: int(r.quality, 16, 32, DEFAULTS.quality),
  };
}

function invalid(msg) { return Object.assign(new Error(msg), { code: 'invalid' }); }

/** One field of PUT /api/v1/gateways/:id/features { transcode: { … } } → the value (throws code invalid). */
function patchField(f, val) {
  if (f === 'enabled' || f === 'software') {
    if (typeof val !== 'boolean') throw invalid(`transcode.${f}: must be true or false`);
    return val;
  }
  if (f === 'roots') {
    if (!Array.isArray(val) || val.length > MAX_ROOTS) throw invalid(`transcode.roots: up to ${MAX_ROOTS} folders`);
    const out = [];
    for (const r of val) {
      const p = rootPath(r);
      if (!p) throw invalid('transcode.roots: an absolute folder of the gateway host like /volume2/mediathek (letters, digits, space, . _ - @ + ( ) & , \' !; no ":" and no "..")');
      if (out.some((o) => o === p)) continue;
      if (out.some((o) => p.startsWith(o + '/') || o.startsWith(p + '/'))) throw Object.assign(new Error('transcode.roots: one folder inside another'), { code: 'invalid', reason: 'nested' });
      out.push(p);
    }
    return out;
  }
  if (f === 'uid' || f === 'gid') {
    if (val === null || val === '') return null;
    const n = typeof val === 'string' && /^\d{1,10}$/.test(val.trim()) ? Number(val.trim()) : val;
    if (!Number.isInteger(n) || n < 1 || n > 2147483647) throw invalid(`transcode.${f}: a number of the DSM user (1 or more; never 0 = root)`);
    return n;
  }
  if (f === 'trashDays') {
    if (!Number.isInteger(val) || val < 1 || val > 365) throw invalid('transcode.trashDays: 1…365');
    return val;
  }
  if (f === 'quality') {
    if (!Number.isInteger(val) || val < 16 || val > 32) throw invalid('transcode.quality: 16…32');
    return val;
  }
  throw invalid(`transcode.${f}: unknown`);
}

function settingsOf(peerId) { return require('./gatewayFeatures').get(peerId).transcode; }

/**
 * `features.transcode` of the config pull (docs/transcode.md §1): switched off only `{ enabled: false }` (no other
 * gateway's hash changes with the defaults). The fixed parts (verifyDecode, minFreeGb, minFreePct) keep the
 * gateway's defaults.
 */
function configPayload(peerId) {
  const s = settingsOf(peerId);
  if (!s.enabled) return { enabled: false };
  return { enabled: true, roots: s.roots.slice(), software: s.software, trashDays: s.trashDays, quality: s.quality, verifyDecode: true, minFreeGb: 20, minFreePct: 5 };
}

// ─── What the gateway reports ──────────────────────────────────────────

function cleanRoot(r) {
  if (!isObj(r)) return null;
  const path = typeof r.path === 'string' && r.path.length <= 4096 && r.path[0] === '/' ? clean(r.path, 4096) : '';
  if (!path) return null;
  return { path, state: ROOT_STATES.includes(r.state) ? r.state : 'missing', free: bytes(r.free), total: bytes(r.total) };
}

function cleanRoots(list) { return Array.isArray(list) ? list.slice(0, MAX_ROOTS).map(cleanRoot).filter(Boolean) : []; }

function cleanEncoders(list) {
  return Array.isArray(list) ? [...new Set(list.filter((x) => typeof x === 'string' && /^[a-z0-9_]{1,24}$/.test(x)))].slice(0, 8) : [];
}

/** telemetry.features.transcode (docs/transcode.md §6) → the checked, small part; null without one. */
function telemetryTranscode(tel) {
  const t = tel && isObj(tel.features) ? tel.features.transcode : null;
  if (!isObj(t)) return null;
  const jobs = isObj(t.jobs) ? t.jobs : {};
  const cur = isObj(t.current) && typeof t.current.id === 'string' && ID_RE.test(t.current.id) ? t.current : null;
  const trash = isObj(t.trash) ? t.trash : {};
  return {
    enabled: t.enabled === true,
    service: SERVICES.includes(t.service) ? t.service : 'missing',
    state: STATES.includes(t.state) ? t.state : 'off',
    device: DEVICES.includes(t.device) ? t.device : null,
    deviceGid: int(t.deviceGid, 0, 2147483647),
    driver: clean(t.driver, 160) || null,
    encoders: cleanEncoders(t.encoders),
    software: t.software === true,
    ffmpeg: clean(t.ffmpeg, 64) || null,
    roots: cleanRoots(t.roots),
    jobs: { queued: int(jobs.queued, 0, 1e6, 0), done: int(jobs.done, 0, 1e6, 0), failed: int(jobs.failed, 0, 1e6, 0) },
    current: cur ? { id: cur.id, state: JOB_STATES.includes(cur.state) ? cur.state : 'running', percent: num(cur.percent, 0, 100) } : null,
    trash: { count: int(trash.count, 0, 1e7, 0), bytes: bytes(trash.bytes) || 0 },
    arch: clean(t.arch, 16) || null,
    error: code(t.error) || (isObj(t.error) ? code(t.error.code) : null),
  };
}

function cleanCaps(c) {
  if (!isObj(c)) return null;
  return {
    at: isoOrNull(c.at),
    ffmpeg: clean(c.ffmpeg, 64) || null,
    uid: int(c.uid, 0, 2147483647),
    groups: Array.isArray(c.groups) ? c.groups.filter((g) => Number.isInteger(g) && g >= 0 && g <= 2147483647).slice(0, 32) : [],
    device: DEVICES.includes(c.device) ? c.device : null,
    devicePath: clean(c.devicePath, 64) || null,
    deviceGid: int(c.deviceGid, 0, 2147483647),
    deviceMode: typeof c.deviceMode === 'string' && /^[0-7]{3,4}$/.test(c.deviceMode) ? c.deviceMode : null,
    driver: clean(c.driver, 160) || null,
    vaH264Enc: c.vaH264Enc === true,
    encoders: cleanEncoders(c.encoders),
    software: c.software === true,
  };
}

const PROBE_NUM = { bits: [0, 64], width: [0, 20000], height: [0, 20000], level: [0, 1000], fps: [0, 1000], duration: [0, 1e7], video: [0, 64], audio: [0, 64], subtitles: [0, 256], attachments: [0, 1024], pictures: [0, 64], other: [0, 256], chapters: [0, 10000] };
const PROBE_STR = { codec: 32, profile: 48, pixFmt: 32, fieldOrder: 24, container: 64 };

/** result.source / result.output / probe().source: ffprobe facts of a file (fixed fields only). */
function cleanProbe(p) {
  if (!isObj(p)) return null;
  const out = {};
  for (const [k, [lo, hi]] of Object.entries(PROBE_NUM)) { const v = num(p[k], lo, hi); if (v !== null) out[k] = v; }
  for (const [k, n] of Object.entries(PROBE_STR)) { const v = clean(p[k], n); if (v) out[k] = v; }
  const size = bytes(p.size);
  if (size !== null) out.size = size;
  return out;
}

function cleanResult(r) {
  if (!isObj(r)) return null;
  return {
    source: cleanProbe(r.source), output: cleanProbe(r.output),
    mode: MODES.includes(r.mode) ? r.mode : null,
    seconds: num(r.seconds, 0, 1e7),
    trashPath: clean(r.trashPath, 4096) || null,
    restored: isoOrNull(r.restored) || (r.restored === true ? true : null),
    resumed: r.resumed === true,
    freeKb: bytes(r.freeKb), needKb: bytes(r.needKb),
    log: Array.isArray(r.log) ? r.log.filter((x) => typeof x === 'string').slice(-20).map((x) => clean(x, 300)) : [],
  };
}

function cleanJob(j) {
  if (!isObj(j) || typeof j.id !== 'string' || !ID_RE.test(j.id)) return null;
  return {
    id: j.id,
    path: clean(j.path, 4096),
    state: JOB_STATES.includes(j.state) ? j.state : 'failed',
    error: code(j.error),
    percent: num(j.percent, 0, 100), fps: num(j.fps, 0, 10000), speed: num(j.speed, 0, 1000),
    paused: j.paused === true, software: j.software === true,
    submittedAt: isoOrNull(j.submittedAt), startedAt: isoOrNull(j.startedAt), finishedAt: isoOrNull(j.finishedAt),
    result: cleanResult(j.result),
  };
}

function cleanTrash(list) {
  if (!Array.isArray(list)) return null;
  return list.slice(0, MAX_TRASH).map((e) => (isObj(e) && typeof e.id === 'string' && ID_RE.test(e.id)
    ? { id: e.id, at: isoOrNull(e.at), size: bytes(e.size), expiresAt: isoOrNull(e.expiresAt), path: clean(e.path, 4096) } : null)).filter(Boolean);
}

/**
 * The state of the service (answer of /api/transcode/status, body of the report — docs/transcode.md §3) → the
 * checked state. `trash` is null when the body has none (the report leaves it out while it did not change).
 */
function cleanStatus(b) {
  const x = isObj(b) ? b : {};
  const s = isObj(x.settings) ? x.settings : {};
  const p = isObj(x.pause) ? x.pause : {};
  return {
    at: isoOrNull(x.at),
    enabled: x.enabled === true,
    service: SERVICES.includes(x.service) ? x.service : 'missing',
    state: STATES.includes(x.state) ? x.state : 'off',
    caps: cleanCaps(x.caps),
    roots: cleanRoots(x.roots),
    settings: {
      software: s.software === true, trashDays: int(s.trashDays, 1, 365, DEFAULTS.trashDays), quality: int(s.quality, 16, 32, DEFAULTS.quality),
      verifyDecode: s.verifyDecode !== false, minFreeGb: int(s.minFreeGb, 0, 100000, 20), minFreePct: int(s.minFreePct, 0, 90, 5),
    },
    pause: { all: p.all === true, until: isoOrNull(p.until) },
    jobs: Array.isArray(x.jobs) ? x.jobs.slice(0, MAX_JOBS).map(cleanJob).filter(Boolean) : [],
    trash: cleanTrash(x.trash),
  };
}

function rowOf(peerId) {
  try { return db().prepare('SELECT report, trash, reported_at FROM gateway_transcode WHERE peer_id = ?').get(peerId) || null; } catch { return null; }
}

/** The last report of a gateway with the last known trash → the state, or null before the first report. */
function lastReport(peerId) {
  const r = rowOf(peerId);
  if (!r) return null;
  const rep = json(r.report, null);
  if (!isObj(rep)) return null;
  return { ...rep, trash: json(r.trash, []) || [], reportedAt: new Date(r.reported_at).toISOString() };
}

/** POST /api/v1/gateway/transcode/report — store the last report of this gateway, hand it to the plugins. */
function ingestReport(peerId, body, now = Date.now()) {
  if (!isObj(body)) fail('invalid', 'the report must be an object');
  const st = cleanStatus(body);
  const { trash, ...rest } = st;
  db().prepare(`INSERT INTO gateway_transcode (peer_id, report, trash, reported_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(peer_id) DO UPDATE SET report = excluded.report, trash = COALESCE(excluded.trash, gateway_transcode.trash), reported_at = excluded.reported_at`)
    .run(peerId, JSON.stringify(rest), trash ? JSON.stringify(trash) : null, now);
  emit({ gatewayId: peerId, status: lastReport(peerId) });
  return {};
}

// ─── Plugins (hook transcodeChanged) ───────────────────────────────────

function hasPermission(p) {
  return !!(p && p.manifest && p.manifest.permissions && p.manifest.permissions.transcode === true);
}

function transcodePlugins() {
  try {
    const registry = require('./plugins/registry');
    const runtime = require('./plugins/runtime');
    const plugins = require('./plugins');
    return registry.list().filter(hasPermission).filter((p) => {
      try { return plugins.evaluate(p).run && runtime.info(p.id).state === 'running'; } catch { return false; }
    });
  } catch { return []; }
}

/** A report came in → hook transcodeChanged({ gatewayId, status }) of every running plugin with the permission (never awaited). */
function emit(ev) {
  for (const p of transcodePlugins()) {
    try {
      require('./plugins/runtime').call(p.id, 'transcodeChanged', ev, module.exports._hookMs || HOOK_MS).catch((e) => {
        try { require('./plugins/registry').addLog(p.id, e && e.stopped ? 'debug' : 'warn', 'transcodeChanged failed: ' + String((e && e.message) || e).slice(0, 200)); } catch { /* db closed */ }
      });
    } catch (e) { logger.debug({ err: e.message }, 'transcodeChanged hook not delivered'); }
  }
}

// ─── Management calls (server → gateway) ───────────────────────────────

function gw() { return require('./gateways'); }

function supported(tel) {
  return !!(tel && Array.isArray(tel.capabilities) && tel.capabilities.includes('transcode'));
}

function gatewayId(v) {
  const n = typeof v === 'string' && /^\d{1,12}$/.test(v) ? Number(v) : v;
  if (!Number.isSafeInteger(n) || n <= 0) fail('invalid', 'gatewayId: a gateway id', 'invalid_request');
  return n;
}

/** The gateway for a plugin call: known, with the capability, the function switched on, online. */
function needGateway(peerId) {
  const gf = require('./gatewayFeatures');
  const g = gf.gatewayPeer(gatewayId(peerId));
  if (!g) fail('not_found', 'no such gateway', 'unknown_gateway');
  if (!supported(gf.telemetryOf(g))) fail('unsupported', `the gateway is too old for „Videos umwandeln“ (from ${MIN_GATEWAY})`, 'gateway_update');
  if (!settingsOf(g.id).enabled) fail('unsupported', '„Videos umwandeln“ is switched off on this gateway (Gateway › Funktionen)', 'feature_disabled');
  const alive = db().prepare('SELECT alive FROM gateway_meta WHERE peer_id = ?').get(g.id);
  if (!alive || alive.alive !== 1) fail('offline', 'the gateway is offline', 'offline');
  return g;
}

// the gateway's error codes (docs/transcode.md §7) → the kind the host API names; the code itself is the reason
const BY_STATUS = { 400: 'invalid', 404: 'not_found', 409: 'conflict', 422: 'failed', 429: 'busy', 503: 'unsupported', 504: 'timeout' };
const SERVICE_CODES = ['service_missing', 'service_absent'];

async function mgmt(peerId, path, body, timeoutMs = 10000) {
  const r = await gw().mgmtCall(peerId, path, body || {}, timeoutMs, { maxBytes: 4 * 1024 * 1024 });
  if (!r) fail('offline', 'the gateway does not answer', 'offline');
  if (r.status >= 200 && r.status < 300) return isObj(r.body) ? r.body : {};
  const c = r.body && code(r.body.error);
  if (c && SERVICE_CODES.includes(c)) fail('service', c === 'service_missing' ? 'the service umwandeln is missing (new docker-compose.yml)' : 'the service umwandeln is not running', c);
  fail(BY_STATUS[r.status] || 'gateway_error', c || ('gateway answered ' + r.status), c || 'gateway_error');
  return null;
}

function needId(v) {
  if (typeof v !== 'string' || !ID_RE.test(v)) fail('invalid', 'id: [A-Za-z0-9_-]{8,64}', 'invalid_request');
  return v;
}

/** A path for submit/probe: absolute, plain, under one of the folders of this gateway (the gateway and the service check again). */
function needPath(peerId, v) {
  // eslint-disable-next-line no-control-regex
  if (typeof v !== 'string' || !v || v.length > 4096 || v[0] !== '/' || /[\u0000-\u001f\u007f]/.test(v)) fail('invalid', 'path: an absolute path', 'bad_path');
  const segs = v.split('/').slice(1);
  if (segs.some((s) => s === '' || s === '.' || s === '..' || s === TRASH_DIR || s === WORK_DIR)) fail('invalid', 'path: not normalised', 'bad_path');
  if (!settingsOf(peerId).roots.some((r) => v.startsWith(r + '/'))) fail('invalid', 'path: not under a media folder of this gateway', 'outside_roots');
  return v;
}

// ─── Host API (gc.transcode) ───────────────────────────────────────────

/** gc.transcode.available() — the gateways that can (or should) convert, from settings, telemetry and the last report. */
function available() {
  const gf = require('./gatewayFeatures');
  const rows = db().prepare(`SELECT p.id, p.name, gm.alive, gm.last_health FROM peers p JOIN gateway_meta gm ON gm.peer_id = p.id
    WHERE p.peer_type = 'gateway' AND p.enabled = 1 ORDER BY p.name COLLATE NOCASE`).all();
  const gateways = rows.map((r) => {
    const h = json(r.last_health, {}) || {};
    const tel = isObj(h.telemetry) ? h.telemetry : {};
    const s = gf.get(r.id).transcode;
    const t = telemetryTranscode(tel);
    const rep = lastReport(r.id);
    const caps = rep && rep.caps ? rep.caps : (t ? { device: t.device, deviceGid: t.deviceGid, driver: t.driver, encoders: t.encoders, ffmpeg: t.ffmpeg, software: t.software } : null);
    return {
      id: r.id, name: r.name, online: r.alive === 1, supported: supported(tel), minGateway: MIN_GATEWAY, enabled: s.enabled,
      service: rep ? rep.service : (t ? t.service : null),
      state: rep ? rep.state : (t ? t.state : null),
      caps,
      roots: rep && rep.roots.length ? rep.roots : (t && t.roots.length ? t.roots : s.roots.map((p) => ({ path: p, state: null, free: null, total: null }))),
      settings: { roots: s.roots.slice(), software: s.software, trashDays: s.trashDays, quality: s.quality },
      jobs: t ? t.jobs : null, current: t ? t.current : null, trash: t ? t.trash : null,
      reportedAt: rep ? rep.reportedAt : null,
    };
  }).filter((g) => g.supported || g.enabled);
  return { available: gateways.some((g) => g.supported && g.enabled), gateways };
}

/** gc.transcode.report(gatewayId) — the last stored report (no gateway call; null before the first). */
function report(peerId) {
  const gf = require('./gatewayFeatures');
  const g = gf.gatewayPeer(gatewayId(peerId));
  if (!g) fail('not_found', 'no such gateway', 'unknown_gateway');
  return lastReport(g.id);
}

/** gc.transcode.status(gatewayId) — live from the gateway (and stored as its last report). */
async function status(peerId) {
  const g = needGateway(peerId);
  const st = cleanStatus(await mgmt(g.id, '/api/transcode/status', {}));
  const { trash, ...rest } = st;
  try {
    db().prepare(`INSERT INTO gateway_transcode (peer_id, report, trash, reported_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(peer_id) DO UPDATE SET report = excluded.report, trash = COALESCE(excluded.trash, gateway_transcode.trash), reported_at = excluded.reported_at`)
      .run(g.id, JSON.stringify(rest), trash ? JSON.stringify(trash) : null, Date.now());
  } catch (e) { logger.debug({ err: e.message }, 'transcode status not stored'); }
  return { ...st, trash: trash || [] };
}

async function probe(peerId, path) {
  const g = needGateway(peerId);
  const r = await mgmt(g.id, '/api/transcode/probe', { path: needPath(g.id, path) }, 35000);
  return { path: clean(r.path, 4096), source: cleanProbe(r.source), freeKb: bytes(r.freeKb) };
}

async function submit(plugin, a0) {
  const a = isObj(a0) ? a0 : {};
  const g = needGateway(a.gatewayId);
  const body = { id: needId(a.id), path: needPath(g.id, a.path) };
  // software: false forbids the software way for this job; only the administrator allows it (features.transcode.software)
  if (a.software === false) body.software = false;
  if (a.quality !== undefined && a.quality !== null) {
    if (!Number.isInteger(a.quality) || a.quality < 16 || a.quality > 32) fail('invalid', 'quality: 16…32', 'invalid_request');
    body.quality = a.quality;
  }
  const r = await mgmt(g.id, '/api/transcode/submit', body);
  audit('transcode_submitted', `Plugin "${plugin && plugin.id}" submitted a video for conversion on gateway "${g.name}"`, { plugin: plugin && plugin.id, peer_id: g.id, id: body.id });
  return { job: cleanJob(r.job) };
}

async function cancel(peerId, id) {
  const g = needGateway(peerId);
  return { job: cleanJob((await mgmt(g.id, '/api/transcode/cancel', { id: needId(id) })).job) };
}

function pauseView(p) { const x = isObj(p) ? p : {}; return { all: x.all === true, until: isoOrNull(x.until), ...(Array.isArray(x.ids) ? { ids: x.ids.filter((i) => typeof i === 'string' && ID_RE.test(i)).slice(0, 64) } : {}) }; }

async function pause(peerId, o0) {
  const g = needGateway(peerId);
  const o = isObj(o0) ? o0 : {};
  let body;
  if (o.id !== undefined) body = { id: needId(o.id) };
  else {
    body = {};
    if (o.ttlSec !== undefined) {
      if (!Number.isInteger(o.ttlSec) || o.ttlSec < 10 || o.ttlSec > 86400) fail('invalid', 'ttlSec: 10…86400', 'invalid_request');
      body.ttlSec = o.ttlSec;
    }
  }
  return { pause: pauseView((await mgmt(g.id, '/api/transcode/pause', body)).pause) };
}

async function resume(peerId, o0) {
  const g = needGateway(peerId);
  const o = isObj(o0) ? o0 : {};
  const body = o.id !== undefined ? { id: needId(o.id) } : {};
  return { pause: pauseView((await mgmt(g.id, '/api/transcode/resume', body)).pause) };
}

async function ack(peerId, ids) {
  const g = needGateway(peerId);
  if (!Array.isArray(ids) || !ids.length || ids.length > 200) fail('invalid', 'ids: 1…200 job ids', 'invalid_request');
  const r = await mgmt(g.id, '/api/transcode/ack', { ids: ids.map(needId) });
  return { removed: int(r.removed, 0, 1e6, 0) };
}

async function restore(plugin, peerId, id) {
  const g = needGateway(peerId);
  const r = await mgmt(g.id, '/api/transcode/restore', { id: needId(id) }, 35000);
  audit('transcode_restored', `Plugin "${plugin && plugin.id}" restored an original on gateway "${g.name}"`, { plugin: plugin && plugin.id, peer_id: g.id, id });
  return { id, restored: r.restored === true || isoOrNull(r.restored) !== null };
}

async function purge(plugin, peerId, o0) {
  const g = needGateway(peerId);
  const o = isObj(o0) ? o0 : {};
  let body;
  if (o.all === true && o.id === undefined) body = { all: true };
  else if (o.id !== undefined && o.all === undefined) body = { id: needId(o.id) };
  else fail('invalid', 'purge: { id } or { all: true }', 'invalid_request');
  await mgmt(g.id, '/api/transcode/purge', body, 35000);
  audit('transcode_purged', `Plugin "${plugin && plugin.id}" deleted ${body.all ? 'every original' : 'an original'} in the trash on gateway "${g.name}"`, { plugin: plugin && plugin.id, peer_id: g.id, ...body });
  return { purged: true };
}

/**
 * gc.transcode.settings(gatewayId, { trashDays?, quality? }) — the plugin's settings „Papierkorb-Tage“ and
 * „Qualität“ for this gateway's function (the gateway gets them with its next config pull). Switch, folders,
 * user and „ohne Grafik“ stay with the administrator. Works while the function is off as well.
 */
function setSettings(plugin, peerId, p0) {
  const gf = require('./gatewayFeatures');
  const g = gf.gatewayPeer(gatewayId(peerId));
  if (!g) fail('not_found', 'no such gateway', 'unknown_gateway');
  const p = isObj(p0) ? p0 : {};
  const patch = {};
  for (const k of Object.keys(p)) {
    if (k !== 'trashDays' && k !== 'quality') fail('invalid', `settings: ${k} is not the plugin's to change`, 'invalid_request');
    try { patch[k] = patchField(k, p[k]); } catch (e) { fail('invalid', e.message, 'invalid_request'); }
  }
  if (!Object.keys(patch).length) fail('invalid', 'settings: trashDays and/or quality', 'invalid_request');
  const cur = settingsOf(g.id);
  if (Object.keys(patch).every((k) => cur[k] === patch[k])) return { trashDays: cur.trashDays, quality: cur.quality };
  const after = gf.set(g.id, { transcode: patch }, { user: plugin ? 'plugin:' + plugin.id : null }).transcode;
  return { trashDays: after.trashDays, quality: after.quality };
}

// ─── Compose (gateway-kit.js buildCompose) ─────────────────────────────

/** Does the compose file of this gateway need the service umwandeln? (switched on) */
function composeWantsTranscode(peerId) {
  try { return settingsOf(peerId).enabled; } catch { return false; }
}

/**
 * What the service umwandeln of the compose file needs for this gateway (contract §2.1):
 *   { roots, uid, gid, renderGid, device }  renderGid: the group of /dev/dri/renderD128 the gateway reported
 *   (else 44), device false only when the gateway reports none (telemetry device: absent).
 */
function composeOptions(peerId) {
  const s = settingsOf(peerId);
  let t = null;
  try { t = telemetryTranscode(require('./gatewayFeatures').telemetryOf(require('./gatewayFeatures').gatewayPeer(peerId))); } catch { t = null; }
  const rep = lastReport(peerId);
  const caps = rep && rep.caps ? rep.caps : null;
  const gid = caps && caps.deviceGid !== null ? caps.deviceGid : (t && t.deviceGid !== null ? t.deviceGid : null);
  const device = caps && caps.device ? caps.device : (t ? t.device : null);
  return { roots: s.roots.slice(), uid: s.uid, gid: s.gid, renderGid: gid !== null && gid > 0 ? gid : DEFAULT_RENDER_GID, device: device !== 'absent' };
}

// ─── Overview (row "Videos umwandeln", admin API) ──────────────────────

/** The part of features.overview for the row "Videos umwandeln". */
function overview(peerId) {
  const gf = require('./gatewayFeatures');
  const g = gf.needGateway(peerId);
  const tel = gf.telemetryOf(g);
  const s = settingsOf(g.id);
  const t = telemetryTranscode(tel);
  const rep = lastReport(g.id);
  const platform = require('./homeRadio').platformOf(g.id, tel);
  const caps = rep && rep.caps ? rep.caps : null;
  const roots = rep && rep.roots.length ? rep.roots : (t ? t.roots : []);
  const device = (caps && caps.device) || (t && t.device) || null;
  const deviceGid = caps && caps.deviceGid !== null ? caps.deviceGid : (t ? t.deviceGid : null);
  const service = t ? t.service : (rep ? rep.service : null);
  const state = t ? t.state : (rep ? rep.state : null);
  const sup = supported(tel);
  // what is missing, in the order the row names it (hints, never a ban)
  const hints = [];
  if (s.enabled && sup) {
    const arch = t && t.arch;
    if (platform === 'rpi' || (arch && arch !== 'x64')) hints.push('arch');
    if (!s.roots.length) hints.push('roots');
    if (!s.uid || !s.gid) hints.push('user');
    if (device === 'denied') hints.push('device_denied');
    else if (device === 'absent' && !s.software) hints.push('no_device');
    else if (state === 'no_encoder' && !s.software) hints.push('no_encoder');
    if (roots.some((r) => r.state === 'not_mounted')) hints.push('not_mounted');
    if (roots.some((r) => r.state === 'readonly')) hints.push('readonly');
    if (roots.some((r) => r.state === 'missing')) hints.push('missing');
  }
  // a new compose file helps: the service is missing or stopped, a folder is not mounted, the group is missing
  const compose = s.enabled && sup && platform !== 'rpi' && !hints.includes('arch')
    && (service !== 'managed' || hints.includes('not_mounted') || hints.includes('device_denied')) ? 'compose' : null;
  let plugin = null;
  try {
    const p = require('./plugins/registry').get(MEDIEN_PLUGIN);
    plugin = p ? { installed: true, enabled: p.enabled === true, transcode: hasPermission(p) } : { installed: false, enabled: false, transcode: false };
  } catch { plugin = null; }
  return {
    enabled: s.enabled, roots: s.roots, uid: s.uid, gid: s.gid, software: s.software, trashDays: s.trashDays, quality: s.quality,
    supported: sup, minGateway: MIN_GATEWAY, platform,
    service, state, device, deviceGid,
    driver: (caps && caps.driver) || (t && t.driver) || null,
    encoders: caps && caps.encoders.length ? caps.encoders : (t ? t.encoders : []),
    ffmpeg: (caps && caps.ffmpeg) || (t && t.ffmpeg) || null,
    softwareAvailable: caps ? caps.software : (t ? t.software : null),
    arch: t ? t.arch : null,
    rootStates: roots,
    jobs: t ? t.jobs : null, current: t ? t.current : null, trash: t ? t.trash : null,
    renderGid: deviceGid !== null && deviceGid > 0 ? deviceGid : DEFAULT_RENDER_GID,
    hints, compose, plugin,
  };
}

function audit(event, text, details) {
  try { require('./activity').log(event, text, { source: 'plugin', severity: 'info', details }); } catch { /* best-effort */ }
}

const HOST_CODES = {
  invalid: 'ERR_INVALID', not_found: 'ERR_NOT_FOUND', offline: 'ERR_TRANSCODE_OFFLINE', unsupported: 'ERR_TRANSCODE_UNSUPPORTED',
  service: 'ERR_TRANSCODE_SERVICE', conflict: 'ERR_TRANSCODE_CONFLICT', busy: 'ERR_TRANSCODE_BUSY', failed: 'ERR_TRANSCODE_FAILED',
  timeout: 'ERR_TRANSCODE_TIMEOUT', gateway_error: 'ERR_TRANSCODE_FAILED',
};

module.exports = {
  MIN_GATEWAY, MAX_ROOTS, DEFAULTS, DEFAULT_RENDER_GID, TranscodeError, HOST_CODES, MEDIEN_PLUGIN,
  rootPath, rootsOf, normalizeSettings, patchField, configPayload,
  telemetryTranscode, cleanStatus, ingestReport, lastReport, emit, supported,
  available, report, status, probe, submit, cancel, pause, resume, ack, restore, purge, setSettings,
  composeWantsTranscode, composeOptions, overview,
};
