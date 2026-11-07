'use strict';

// Drucken & Scannen (phase 3c, step 1 — contract "Phase 3c", the gateway's
// docs/print.md). The gateways find the printers and scanners of their home
// network (mDNS, IPP, eSCL) and do the printing and scanning; the server
// keeps what they report, the print queue (24 h) and the scans, and offers
// all of it to plugins through gc.print (permissions.print, hostApi.js) —
// the plugin "Drucken & Scannen" (gatecontrol-print) keeps the rights per
// person, the history and the pages of the portal.
//
//   switch per gateway: gateway_features.settings.print { enabled, manual }
//     (services/gatewayFeatures.js), in the config pull as features.print
//   POST /api/v1/gateway/print/devices          ingestDevices()  the devices a gateway knows
//   GET  /api/v1/gateway/print/jobs             queueFor()       its open jobs (ETag)
//   GET  /api/v1/gateway/print/jobs/:id/file    sendFile()       the file of one
//   POST /api/v1/gateway/print/jobs/:id         jobReport()      sending | printing | waiting | done | failed
//   PUT  /api/v1/gateway/print/scans/:id/pages/:n  storePage()   one scanned page → media of the plugin
//   POST /api/v1/gateway/print/scans/:id        scanReport()     scanning | done | failed
//   GET  /api/v1/gateway/print/ocr/:id/pages/:n  ocrPage()        a page for the text recognition
//   PUT  /api/v1/gateway/print/ocr/:id/document|text  storeOcr()  its searchable PDF and text
//   POST /api/v1/gateway/print/ocr/:id          ocrReport()      running | done | failed
//   management calls to the gateway (gateways.mgmtCall): /api/print/discover,
//   /api/print/jobs (fetch now), /api/print/scan, /api/print/scan/cancel,
//   /api/print/ocr, /api/print/ocr/cancel
//   switches per gateway beside `enabled`: convert (PDF for printers without
//   PDF), ocr ("Texterkennung"), office ("Office-Dateien drucken", the
//   gateway's service office) — gateway docs/print.md
//   the last search of a gateway (`search` of the device report and of
//   telemetry.features.print — gateway docs/print.md "Suche im LAN"): shown in
//   the row "Drucken & Scannen" with "Neu suchen" (discoverOne()) and the
//   addresses an administrator adds by hand (settings.print.manual)
//
// The plugins only name device ids — never an address or a URL: the gateway
// only talks to devices it found itself in its own private LAN (or the
// administrator's `manual` addresses, RFC 1918).

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { getDb } = require('../db/connection');
const logger = require('../utils/logger');
const pdf = require('./printPdf');
const office = require('./printOffice');

const MIN_GATEWAY = '1.24.0';
// text recognition, office files, PCLm, paper and tray (capabilities print-ocr, print-office, print-media — the version is the hint)
const MIN_GATEWAY_P3C = '1.33.0';
const MAX_FILE = 50 * 1024 * 1024;
const MAX_DEVICES = 64;
const MAX_MANUAL = 16;
const MAX_PAGES = 100;
const JOB_TTL_MS = 24 * 3600 * 1000;
const KEEP_MS = 30 * 24 * 3600 * 1000;
const SCAN_STALE_MS = 3 * 60 * 1000;
const OPEN_PER_USER = 20;
const OPEN_STATES = ['queued', 'sending', 'printing', 'waiting'];
const FINAL_STATES = ['done', 'failed', 'canceled', 'expired'];
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const DEVICE_RE = /^[uh]:[0-9a-f]{16,32}$/;
const ERR_RE = /^[a-z][a-z0-9_]{0,39}$/;
const COLOR_RE = /^#[0-9A-F]{6}$/;
const IMAGE_IN = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'image/gif', 'image/tiff'];
const PAGE_TYPES = ['image/jpeg', 'image/png', 'application/pdf'];
const SCAN_MODES = { document: { color: 'gray', resolution: 300 }, photo: { color: 'color', resolution: 300 }, bw: { color: 'bw', resolution: 300 } };
const RESOLUTIONS = [150, 200, 300, 600];
const OCR_STALE_MS = 3 * 60 * 1000;
const OCR_OPEN = ['queued', 'running'];
const OCR_TEXT_MAX = 1024 * 1024;
const OCR_PDF_MAX = 100 * 1024 * 1024;
const MEDIA_RE = /^[a-z0-9]+_[a-z0-9.-]+_[0-9.]+x[0-9.]+(mm|in)$/;
const SOURCE_RE = /^[a-z][a-z0-9-]{0,39}$/;

class PrintError extends Error {
  /** reason (only for `format`): why it cannot be printed — file_type | damaged | printer | gateway_update | convert_off | office_off | office_missing */
  constructor(code, message, reason) { super(message || code); this.code = code; if (reason) this.reason = reason; }
}

// The formats a gateway turns PDF into for a printer without PDF (device report printer.convert, gateway docs/print.md "Umwandeln")
const CONVERT_TARGETS = ['image/pwg-raster', 'image/urf', 'application/pclm', 'image/jpeg'];

function db() { return getDb(); }
function json(s) { try { return s ? JSON.parse(s) : null; } catch { return null; } }
function iso(ms) { return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null; }
function newId(prefix) { return prefix + '_' + crypto.randomBytes(12).toString('base64url'); }

/** Text without control characters, trimmed, at most n characters ('' for a non-string). */
function clean(v, n) {
  if (typeof v !== 'string') return '';
  let out = '';
  for (const ch of v) { const c = ch.codePointAt(0); out += c < 32 || c === 127 ? ' ' : ch; }
  return out.trim().slice(0, n);
}

function isRfc1918(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(ip || ''));
  if (!m) return false;
  const o = m.slice(1).map(Number);
  if (o.some((x) => x > 255)) return false;
  return o[0] === 10 || (o[0] === 172 && o[1] >= 16 && o[1] <= 31) || (o[0] === 192 && o[1] === 168);
}

function jobsDir() { return path.join(require('./plugins/constants').dataRoot(), 'print-jobs'); }
function jobFile(id) {
  if (!ID_RE.test(id)) throw new PrintError('invalid', 'invalid job id');
  return path.join(jobsDir(), id + '.bin');
}
function dropFile(id) { try { fs.rmSync(jobFile(id), { force: true }); } catch (e) { logger.debug({ err: e.message }, 'print job file not removed'); } }

// ─── Settings (part of the gateway's features) ─────────────────────────

/** features.print of the stored settings (any shape) → { enabled, manual } */
function normalizeSettings(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const manual = Array.isArray(r.manual) ? [...new Set(r.manual.filter((x) => typeof x === 'string').map((x) => x.trim()).filter(isRfc1918))].slice(0, 16) : [];
  // convert: PDF for printers without PDF converted on the gateway — on unless switched off;
  // ocr ("Texterkennung") and office ("Office-Dateien drucken"): off unless switched on
  return { enabled: r.enabled === true, manual, convert: r.convert !== false, ocr: r.ocr === true, office: r.office === true };
}

function settingsOf(peerId) { return require('./gatewayFeatures').get(peerId).print; }

/**
 * features.print of the config pull: `convert` only when switched off, `ocr`/`office` only when switched on —
 * the gateway's defaults, so the config hash of every gateway that changed nothing stays.
 */
function configPayload(peerId) {
  const s = settingsOf(peerId);
  return {
    enabled: s.enabled, manual: s.manual.slice(),
    ...(s.convert === false ? { convert: false } : {}), ...(s.ocr ? { ocr: true } : {}), ...(s.office ? { office: true } : {}),
  };
}

/** "docker-compose.yml herunterladen": the service office when „Office-Dateien drucken“ is on for this gateway. */
function composeWantsOffice(peerId) {
  try { const s = settingsOf(peerId); return s.enabled && s.office === true; } catch { return false; }
}

// ─── Devices (gateway → server) ────────────────────────────────────────

const bool = (v) => v === true;
const strList = (v, n, len, re) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && (!re || re.test(x))).slice(0, n).map((x) => x.slice(0, len)) : []);

/** printer.media of a report (paper and trays, gateway ≥ 1.33.0) → { sizes, default, sources, sourceDefault, ready } */
function cleanMedia(m) {
  const o = m && typeof m === 'object' && !Array.isArray(m) ? m : {};
  const sizes = strList(o.sizes, 12, 64, MEDIA_RE);
  const sources = strList(o.sources, 8, 40, SOURCE_RE);
  return {
    sizes,
    default: typeof o.default === 'string' && sizes.includes(o.default) ? o.default : null,
    sources,
    sourceDefault: typeof o.sourceDefault === 'string' && sources.includes(o.sourceDefault) ? o.sourceDefault : null,
    ready: (Array.isArray(o.ready) ? o.ready : []).slice(0, 8).filter((r) => r && typeof r === 'object').map((r) => ({
      size: typeof r.size === 'string' && sizes.includes(r.size) ? r.size : null,
      source: typeof r.source === 'string' && sources.includes(r.source) ? r.source : null,
    })).filter((r) => r.size || r.source),
  };
}

/** One device of a report, checked and cut (all input of the gateway) → the stored view or null. */
function cleanDevice(d) {
  if (!d || typeof d !== 'object' || typeof d.id !== 'string' || !DEVICE_RE.test(d.id)) return null;
  if (!isRfc1918(d.ip)) return null;
  const p = d.printer && typeof d.printer === 'object' ? d.printer : null;
  const s = d.scanner && typeof d.scanner === 'object' ? d.scanner : null;
  if (!p && !s) return null;
  const st = (v, list, dflt) => (list.includes(v) ? v : dflt);
  return {
    id: d.id,
    name: clean(d.name, 120) || d.ip,
    model: clean(d.model, 120) || null,
    ip: d.ip,
    location: clean(d.location, 120) || null,
    source: d.source === 'manual' ? 'manual' : 'mdns',
    online: bool(d.online),
    problem: d.problem === 'cert_changed' ? 'cert_changed' : null,
    printer: p ? {
      state: st(p.state, ['idle', 'processing', 'stopped', 'offline'], 'idle'),
      reasons: strList(p.reasons, 8, 60, /^[a-z0-9-]+$/),
      color: bool(p.color),
      duplex: bool(p.duplex),
      formats: strList(p.formats, 24, 60, /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/),
      copiesMax: Number.isInteger(p.copiesMax) ? Math.max(1, Math.min(999, p.copiesMax)) : 1,
      // a printer without PDF: the format its gateway converts PDF into (null: it cannot — switched off, too old, no matching format)
      convert: CONVERT_TARGETS.includes(p.convert) ? p.convert : null,
      // office files printable here: „Office-Dateien drucken“ on, the gateway's service office runs, PDF goes (gateway ≥ 1.33.0)
      office: bool(p.office),
      media: cleanMedia(p.media),
      markers: (Array.isArray(p.markers) ? p.markers : []).slice(0, 12).filter((m) => m && typeof m === 'object').map((m) => ({
        name: clean(m.name, 60),
        color: typeof m.color === 'string' && COLOR_RE.test(m.color.toUpperCase()) ? m.color.toUpperCase() : null,
        type: clean(m.type, 40) || null,
        level: Number.isInteger(m.level) && m.level >= 0 && m.level <= 100 ? m.level : null,
        low: bool(m.low),
      })),
    } : null,
    scanner: s ? {
      state: st(s.state, ['idle', 'processing', 'stopped', 'offline'], 'idle'),
      platen: bool(s.platen), feeder: bool(s.feeder), duplex: bool(s.duplex),
      color: strList(s.color, 3, 5).filter((c) => ['bw', 'gray', 'color'].includes(c)),
      resolutions: (Array.isArray(s.resolutions) ? s.resolutions : []).filter((r) => Number.isInteger(r) && r >= 50 && r <= 4800).slice(0, 16),
      formats: strList(s.formats, 12, 60, /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/),
      adf: s.adf === 'loaded' || s.adf === 'empty' ? s.adf : null,
    } : null,
    seenAt: Number.isSafeInteger(d.seenAt) ? d.seenAt : null,
  };
}

// ─── The last search of a gateway (its diagnosis) ──────────────────────

const SEARCH_REASONS = ['incomplete', 'no_ipv4', 'other_subnet', 'not_private', 'bad_path', 'too_many'];
const SEARCH_ERRORS = ['no_lan', 'mdns_port_busy', 'mdns_failed', 'legacy_failed'];
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const searches = new Map(); // peer id → the search of its newest device report (the heartbeat carries it as well)

const count = (v) => (Number.isInteger(v) && v >= 0 ? Math.min(v, 100000) : 0);
const ipv4 = (v) => typeof v === 'string' && IPV4_RE.test(v) && v.split('.').every((o) => Number(o) <= 255);

/** `search` of a device report or of telemetry.features.print, checked and cut → the view or null. */
function cleanSearch(s) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return null;
  const dropped = {};
  const dr = s.dropped && typeof s.dropped === 'object' ? s.dropped : {};
  for (const r of SEARCH_REASONS) { const n = count(dr[r]); if (n) dropped[r] = n; }
  return {
    at: Number.isSafeInteger(s.at) && s.at > 0 ? s.at : null,
    interfaces: count(s.interfaces), responses: count(s.responses), responders: count(s.responders),
    services: count(s.services), devices: count(s.devices), dropped,
    hosts: (Array.isArray(s.hosts) ? s.hosts : []).filter((h) => h && typeof h === 'object' && ipv4(h.ip) && SEARCH_REASONS.includes(h.reason)).slice(0, 8)
      .map((h) => ({ ip: h.ip, reason: h.reason, name: clean(h.name, 120) || null, private: isRfc1918(h.ip) })),
    manual: (Array.isArray(s.manual) ? s.manual : []).filter((m) => m && typeof m === 'object' && isRfc1918(m.ip)).slice(0, MAX_MANUAL)
      .map((m) => (m.found === true ? { ip: m.ip, found: true, via: m.via === 'mdns' ? 'mdns' : 'manual' } : { ip: m.ip, found: false, error: m.error === 'no_service' ? 'no_service' : 'unreachable' })),
    errors: (Array.isArray(s.errors) ? s.errors : []).filter((e) => SEARCH_ERRORS.includes(e)).slice(0, 8),
  };
}

/**
 * The newest search of the gateway: from its last device report, else from its
 * heartbeat (also after a restart). `known`: the gateway reports searches at all
 * (its telemetry names `search`, null before the first one) — an older gateway does not.
 */
function searchOf(peerId) {
  const mem = searches.get(peerId) || null;
  let tel = null;
  let known = !!mem;
  try {
    const row = db().prepare('SELECT last_health FROM gateway_meta WHERE peer_id = ?').get(peerId);
    const h = json(row && row.last_health);
    const p = h && h.telemetry && h.telemetry.features && h.telemetry.features.print;
    if (p && typeof p === 'object' && Object.prototype.hasOwnProperty.call(p, 'search')) known = true;
    tel = cleanSearch(p && p.search);
  } catch (e) { logger.debug({ err: e.message }, 'print search of the heartbeat unavailable'); }
  const search = mem && (!tel || (mem.at || 0) >= (tel.at || 0)) ? mem : tel;
  return { search, known };
}

/** "Neu suchen" of one gateway (the row "Drucken & Scannen") → { busy } */
async function discoverOne(peerId) {
  if (!settingsOf(peerId).enabled) throw new PrintError('unavailable', 'Drucken & Scannen is switched off on this gateway');
  const r = await mgmt(peerId, '/api/print/discover', {}, 5000);
  if (!r) throw new PrintError('gateway_unreachable', 'gateway not reachable');
  if (r.status === 409) return { busy: true };
  if (r.status === 404) throw new PrintError('gateway_unsupported', 'the gateway does not know this command yet');
  if (r.status === 503) throw new PrintError('unavailable', 'Drucken & Scannen is not running on the gateway yet');
  if (r.status < 200 || r.status >= 300) throw new PrintError('gateway_error', 'gateway answered ' + r.status);
  return { busy: false };
}

/** POST /api/v1/gateway/print/devices — the complete list of the gateway (rows it no longer names go). */
function ingestDevices(peerId, body, now = Date.now()) {
  const b = body && typeof body === 'object' ? body : {};
  if (!Array.isArray(b.devices)) throw new PrintError('invalid', 'devices must be a list');
  const search = cleanSearch(b.search);
  if (search) searches.set(peerId, search);
  const list = b.devices.slice(0, MAX_DEVICES).map(cleanDevice).filter(Boolean);
  const ids = new Set();
  const d = db();
  d.transaction(() => {
    const up = d.prepare(`INSERT INTO print_devices (peer_id, device_id, data, online, seen_at, reported_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(peer_id, device_id) DO UPDATE SET data = excluded.data, online = excluded.online, seen_at = excluded.seen_at, reported_at = excluded.reported_at`);
    for (const x of list) {
      if (ids.has(x.id)) continue;
      ids.add(x.id);
      up.run(peerId, x.id, JSON.stringify(x), x.online ? 1 : 0, x.seenAt, now);
    }
    const old = d.prepare('SELECT device_id FROM print_devices WHERE peer_id = ?').all(peerId);
    const del = d.prepare('DELETE FROM print_devices WHERE peer_id = ? AND device_id = ?');
    for (const r of old) if (!ids.has(r.device_id)) del.run(peerId, r.device_id);
  })();
  return { devices: ids.size };
}

/** The devices of the gateways with the function on: [{ …view, gatewayId, gateway, gatewayOnline, reportedAt }] */
function allDevices() {
  const rows = db().prepare(`SELECT pd.*, p.name AS gw_name, gm.alive AS gw_alive FROM print_devices pd
    JOIN peers p ON p.id = pd.peer_id AND p.enabled = 1 AND p.peer_type = 'gateway'
    JOIN gateway_meta gm ON gm.peer_id = pd.peer_id`).all();
  const out = [];
  for (const r of rows) {
    if (!settingsOf(r.peer_id).enabled) continue;
    const v = json(r.data);
    if (!v) continue;
    out.push({ ...v, gatewayId: r.peer_id, gateway: r.gw_name, gatewayOnline: r.gw_alive === 1, reportedAt: r.reported_at });
  }
  return out;
}

/**
 * The devices once each (two gateways of one home network find the same
 * printer): the one an online gateway reports, with the device online, the
 * newest report first.
 */
function devices() {
  const best = new Map();
  const rank = (x) => (x.gatewayOnline ? 2 : 0) + (x.online ? 1 : 0);
  for (const x of allDevices()) {
    const cur = best.get(x.id);
    if (!cur || rank(x) > rank(cur) || (rank(x) === rank(cur) && x.reportedAt > cur.reportedAt)) best.set(x.id, x);
  }
  return [...best.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** What a plugin sees of a device. */
function deviceView(x) {
  return {
    id: x.id, name: x.name, model: x.model, location: x.location, ip: x.ip,
    online: !!(x.online && x.gatewayOnline), gatewayId: x.gatewayId, gateway: x.gateway, gatewayOnline: x.gatewayOnline,
    problem: x.problem || null, printer: x.printer, scanner: x.scanner, seenAt: iso(x.seenAt), reportedAt: iso(x.reportedAt),
  };
}

function needDevice(deviceId, kind) {
  if (typeof deviceId !== 'string' || !DEVICE_RE.test(deviceId)) throw new PrintError('invalid', 'invalid device id');
  const d = devices().find((x) => x.id === deviceId);
  if (!d || !d[kind]) throw new PrintError('not_found', kind === 'printer' ? 'no such printer' : 'no such scanner');
  if (!d.gatewayOnline) throw new PrintError('offline', 'the gateway of this device is offline');
  return d;
}

function needUser(id) {
  const uid = Number(id);
  if (!Number.isSafeInteger(uid) || uid <= 0) throw new PrintError('invalid', 'user: a person id');
  const u = db().prepare('SELECT id, username, display_name FROM users WHERE id = ? AND enabled = 1').get(uid);
  if (!u) throw new PrintError('not_found', 'no such person');
  return u;
}

function mgmt(peerId, p, body, timeoutMs) {
  return require('./gateways').mgmtCall(peerId, p, body || {}, timeoutMs);
}

/** "Neu suchen": every gateway with the function on that is online. → { asked } */
async function discover({ retrust = null } = {}) {
  const ids = db().prepare(`SELECT p.id FROM peers p JOIN gateway_meta gm ON gm.peer_id = p.id
    WHERE p.peer_type = 'gateway' AND p.enabled = 1 AND gm.alive = 1`).all().map((r) => r.id).filter((id) => settingsOf(id).enabled);
  const body = typeof retrust === 'string' && DEVICE_RE.test(retrust) ? { retrust } : {};
  const res = await Promise.all(ids.map((id) => mgmt(id, '/api/print/discover', body, 5000)));
  return { asked: res.filter((r) => r && (r.status === 202 || r.status === 409)).length };
}

// ─── Print jobs ────────────────────────────────────────────────────────

function jobView(r) {
  if (!r) return null;
  return {
    id: r.id, deviceId: r.device_id, gatewayId: r.peer_id, user: r.user_id, name: r.name, format: r.format, bytes: r.size,
    pages: r.pages, copies: r.copies, color: r.color === 1, duplex: r.duplex === 1, media: r.media || null, source: r.source || null,
    state: r.state, error: r.error || null, message: r.message || null,
    createdAt: iso(r.created_at), updatedAt: iso(r.updated_at), expiresAt: iso(r.expires_at), doneAt: iso(r.done_at),
  };
}

async function readMedia(plugin, mediaId) {
  const media = require('./plugins/media');
  const r = media.row(plugin.id, mediaId);
  if (!r) throw new PrintError('not_found', 'no such media of this plugin');
  if (r.bytes > MAX_FILE) throw new PrintError('too_large', `at most ${MAX_FILE} bytes`);
  const chunks = [];
  try {
    for await (const c of media.readRange(r, 0, Math.max(0, r.bytes - 1))) chunks.push(c);
  } catch (e) {
    if (e && e.status) throw new PrintError('media_unavailable', e.code || 'media not readable');
    throw e;
  }
  return { row: r, buf: Buffer.concat(chunks) };
}

/** The gateway's last telemetry (heartbeat) or null. */
function telemetryOf(peerId) {
  try {
    const row = db().prepare('SELECT last_health FROM gateway_meta WHERE peer_id = ?').get(peerId);
    const h = json(row && row.last_health);
    return (h && h.telemetry) || null;
  } catch { return null; }
}

/**
 * Why a printer without PDF does not get one (reason of the format error):
 * its gateway is too old to convert, converting is switched off there, or
 * the printer names no format the gateway can make (printer).
 */
function noPdfReason(device) {
  if (!device || !device.gatewayId) return 'printer';
  const sup = require('./gatewayFeatures').support(telemetryOf(device.gatewayId));
  if (!sup.printConvert) return 'gateway_update';
  if (settingsOf(device.gatewayId).convert === false) return 'convert_off';
  return 'printer';
}

/**
 * Why an office file does not go to this printer: its gateway is too old (no print-office), „Office-Dateien
 * drucken“ is off there, its service office is not running yet (being set up, missing in the compose file), or
 * the printer takes no PDF and the gateway cannot convert for it (printer).
 */
function officeReason(device) {
  if (!device || !device.gatewayId) return 'office_off';
  const tel = telemetryOf(device.gatewayId);
  const caps = tel && Array.isArray(tel.capabilities) ? tel.capabilities : [];
  if (!caps.includes('print-office')) return 'gateway_update';
  if (!settingsOf(device.gatewayId).office) return 'office_off';
  const o = tel && tel.features && tel.features.print && tel.features.print.office;
  if (!o || o.service !== 'managed') return 'office_missing';
  return 'printer';
}

/** The type of a file by its content (magic bytes), else by the stored type. */
function typeOf(buf, mime) {
  return pdf.sniff(buf) || String(mime || '').split(';')[0].trim().toLowerCase();
}

/** Plain text → a PDF (Courier, A4) — no LibreOffice needed. */
function textPdf(buf) {
  try { return pdf.textToPdf(office.decodeText(buf)); } catch { throw new PrintError('too_large', 'the text has too many pages'); }
}

/**
 * The bytes in a form the printer takes: PDF as it is (the printer names
 * application/pdf, or its gateway converts PDF — printer.convert), pictures
 * as JPEG (sharp, turned upright) or — for a printer without JPEG — as a PDF
 * page, plain text as a PDF made here, office files (Word, Excel, PowerPoint,
 * OpenDocument, RTF) as they are when the printer's gateway turns them into a
 * PDF (printer.office — „Office-Dateien drucken“). The type counts by the
 * content (%PDF, JPEG, PNG, the parts of a ZIP …), not by the name or the
 * uploaded type. Anything else: format (reason file_type).
 * device: the printer's device (gatewayId) for the reason when it cannot.
 * → { buf, format, pages, estimated? }
 */
async function printable(buf, mime, printer, device = null, name = null) {
  const fmts = printer.formats || [];
  const takes = (f) => !fmts.length || fmts.includes(f);
  const converts = CONVERT_TARGETS.includes(printer.convert);
  let type = typeOf(buf, mime);
  const named = fmts.length ? fmts.join(', ') : 'nothing';
  if (type !== 'application/pdf' && !IMAGE_IN.includes(type) && office.isText(buf, mime, name)) {
    // plain text: a PDF made here, then as any PDF
    const t = textPdf(buf);
    buf = t.pdf;
    type = 'application/pdf';
  }
  const off = type === 'application/pdf' || IMAGE_IN.includes(type) ? null : office.officeInfo(buf);
  if (off) {
    if (!printer.office) throw new PrintError('format', 'office files are printed when „Office-Dateien drucken“ is on for the gateway of this printer', officeReason(device));
    // the pages the file names (Word, PowerPoint, OpenDocument text) — else counted as one until the gateway reports them
    return { buf, format: off.mime, pages: off.pages || 1, estimated: !off.pages };
  }
  if (type === 'application/pdf') {
    const pages = pdf.pdfPages(buf);
    if (!pages) throw new PrintError('format', 'not a readable PDF file', 'damaged');
    if (!takes('application/pdf') && !converts) throw new PrintError('format', `this printer takes no PDF (it names ${named}) and its gateway does not convert it`, noPdfReason(device));
    return { buf, format: 'application/pdf', pages };
  }
  if (IMAGE_IN.includes(type)) {
    let jpeg;
    try {
      jpeg = await require('sharp')(buf, { limitInputPixels: 120e6 }).rotate().flatten({ background: '#ffffff' }).jpeg({ quality: 92 }).toBuffer();
    } catch { throw new PrintError('format', 'the picture cannot be read', 'damaged'); }
    if (takes('image/jpeg')) return { buf: jpeg, format: 'image/jpeg', pages: 1 };
    if (takes('application/pdf') || converts) return { buf: pdf.jpegsToPdf([{ jpeg }]), format: 'application/pdf', pages: 1 };
    throw new PrintError('format', `this printer takes neither JPEG nor PDF (it names ${named})`, noPdfReason(device));
  }
  throw new PrintError('format', 'only PDF files, pictures, plain text and office files can be printed', 'file_type');
}

/**
 * Pages of a file before printing (the plugin's page limit). → { pages, format, estimated? }
 * Office files: the pages the file names, else 1 with estimated: true (the gateway reports the real count).
 */
async function pagesOf(plugin, { mediaId }) {
  const { row, buf } = await readMedia(plugin, mediaId);
  const type = typeOf(buf, row.mime);
  if (type === 'application/pdf') {
    const pages = pdf.pdfPages(buf);
    if (!pages) throw new PrintError('format', 'not a readable PDF file', 'damaged');
    return { pages, format: 'application/pdf' };
  }
  if (IMAGE_IN.includes(type)) return { pages: 1, format: type };
  if (office.isText(buf, row.mime, row.name)) return { pages: textPdf(buf).pages, format: office.TEXT };
  const off = office.officeInfo(buf);
  if (off) return { pages: off.pages || 1, format: off.mime, ...(off.pages ? {} : { estimated: true }) };
  throw new PrintError('format', 'only PDF files, pictures, plain text and office files can be printed', 'file_type');
}

function openJobs(pluginId, userId) {
  return db().prepare(`SELECT COUNT(*) AS n FROM print_jobs WHERE plugin_id = ? AND user_id = ? AND state IN (${OPEN_STATES.map(() => '?').join(',')})`).get(pluginId, userId, ...OPEN_STATES).n;
}

/** Queue a job and tell the gateway (best effort: it fetches the queue every minute anyway). */
async function enqueue(plugin, { device, user, buf, format, pages, name, copies, color, duplex, media = null, source = null }, now = Date.now()) {
  if (buf.length > MAX_FILE) throw new PrintError('too_large', `at most ${MAX_FILE} bytes`);
  if (openJobs(plugin.id, user.id) >= OPEN_PER_USER) throw new PrintError('busy', `at most ${OPEN_PER_USER} open jobs per person`);
  const id = newId('pj');
  fs.mkdirSync(jobsDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(jobFile(id), buf, { mode: 0o600 });
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  db().prepare(`INSERT INTO print_jobs (id, plugin_id, user_id, peer_id, device_id, name, format, size, sha256, pages, copies, color, duplex, media, source, state, created_at, updated_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`)
    .run(id, plugin.id, user.id, device.gatewayId, device.id, name, format, buf.length, sha256, pages, copies, color ? 1 : 0, duplex ? 1 : 0, media, source, now, now, now + JOB_TTL_MS);
  try {
    require('./activity').log('print_job_created', `Print job "${name}" for "${user.display_name || user.username}" on "${device.name}" (plugin "${plugin.id}")`, {
      source: 'plugin', severity: 'info', details: { plugin: plugin.id, job: id, userId: user.id, device: device.id, gateway: device.gatewayId, pages, copies },
    });
  } catch (e) { logger.debug({ err: e.message }, 'print activity not written'); }
  mgmt(device.gatewayId, '/api/print/jobs', {}, 4000).catch(() => {});
  return db().prepare('SELECT * FROM print_jobs WHERE id = ?').get(id);
}

function options(a, printer) {
  const copiesMax = Math.min(99, printer.copiesMax || 99);
  const copies = a.copies == null ? 1 : Number(a.copies);
  if (!Number.isInteger(copies) || copies < 1 || copies > copiesMax) throw new PrintError('invalid', `copies: 1 … ${copiesMax}`);
  if (a.color != null && typeof a.color !== 'boolean') throw new PrintError('invalid', 'color: true or false');
  if (a.duplex != null && typeof a.duplex !== 'boolean') throw new PrintError('invalid', 'duplex: true or false');
  // paper and tray: only what the printer names (gateway ≥ 1.33.0 reports printer.media) — null: its own default
  const m = printer.media || { sizes: [], sources: [] };
  const media = a.media == null || a.media === '' ? null : a.media;
  const source = a.source == null || a.source === '' ? null : a.source;
  if (media != null && (typeof media !== 'string' || !(m.sizes || []).includes(media))) throw new PrintError('invalid', `media: one of ${(m.sizes || []).join(', ') || 'none (the printer names no paper)'}`);
  if (source != null && (typeof source !== 'string' || !(m.sources || []).includes(source))) throw new PrintError('invalid', `source: one of ${(m.sources || []).join(', ') || 'none (the printer names no tray)'}`);
  return { copies, color: a.color === true && !!printer.color, duplex: a.duplex === true && !!printer.duplex, media, source };
}

/** gc.print.submit({ deviceId, mediaId, user, copies?, color?, duplex?, name?, media?, source? }) */
async function submit(plugin, a) {
  const user = needUser(a.user);
  const device = needDevice(a.deviceId, 'printer');
  const opts = options(a, device.printer);
  const { row, buf } = await readMedia(plugin, a.mediaId);
  const p = await printable(buf, row.mime, device.printer, device, row.name);
  const name = clean(a.name, 120) || clean(row.name, 120) || 'GateControl';
  return jobView(await enqueue(plugin, { device, user, ...p, name, ...opts }));
}

/** gc.print.testPage({ deviceId, user }) — a page with the printer's name and colour bars. */
async function testPage(plugin, a, lang = 'de') {
  const user = needUser(a.user);
  const device = needDevice(a.deviceId, 'printer');
  const en = lang === 'en';
  const when = new Date().toLocaleString(en ? 'en-GB' : 'de-DE', { timeZone: require('./gatewayFeatures').timezone() });
  const doc = pdf.testPagePdf({
    title: en ? 'GateControl – test page' : 'GateControl – Testseite',
    device: `${device.name}${device.model && device.model !== device.name ? ' (' + device.model + ')' : ''} · ${device.gateway}`,
    when,
    note: en ? 'If you can read this, printing from GateControl works.' : 'Wenn du das lesen kannst, klappt das Drucken über GateControl.',
    color: !!device.printer.color,
  });
  let p;
  try { p = await printable(doc, 'application/pdf', device.printer, device); } catch (e) {
    if (e.code !== 'format') throw e;
    // a printer without PDF: the same page as a picture (colour bars only — no fonts needed)
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1240" height="1754"><rect width="1240" height="1754" fill="#fff"/>
      <rect x="120" y="300" width="240" height="240" fill="#000"/><rect x="380" y="300" width="240" height="240" fill="#00AEEF"/>
      <rect x="640" y="300" width="240" height="240" fill="#EC008C"/><rect x="900" y="300" width="240" height="240" fill="#FFF200"/>
      <rect x="120" y="620" width="1020" height="8" fill="#000"/></svg>`;
    const img = await require('sharp')(Buffer.from(svg)).jpeg({ quality: 90 }).toBuffer();
    p = await printable(img, 'image/jpeg', device.printer, device);
  }
  return jobView(await enqueue(plugin, { device, user, ...p, name: en ? 'GateControl test page' : 'GateControl Testseite', copies: 1, color: !!device.printer.color, duplex: false }));
}

function ownJob(plugin, id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new PrintError('invalid', 'invalid job id');
  const r = db().prepare('SELECT * FROM print_jobs WHERE id = ? AND plugin_id = ?').get(id, plugin.id);
  if (!r) throw new PrintError('not_found', 'no such job');
  return r;
}

function job(plugin, id) { housekeeping(); return jobView(ownJob(plugin, id)); }

/** gc.print.jobs({ since?, limit?, user? }) — the plugin's jobs, newest change first */
function jobs(plugin, a = {}) {
  housekeeping();
  const since = a.since == null ? 0 : (typeof a.since === 'number' ? a.since : Date.parse(a.since));
  if (!Number.isFinite(since)) throw new PrintError('invalid', 'since: a time');
  const limit = a.limit == null ? 100 : Number(a.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new PrintError('invalid', 'limit: 1 … 500');
  const params = [plugin.id, since];
  let where = 'plugin_id = ? AND updated_at > ?';
  if (a.user != null) { where += ' AND user_id = ?'; params.push(needUser(a.user).id); }
  return db().prepare(`SELECT * FROM print_jobs WHERE ${where} ORDER BY updated_at DESC LIMIT ?`).all(...params, limit).map(jobView);
}

function cancel(plugin, id) {
  const r = ownJob(plugin, id);
  if (r.state !== 'queued' && r.state !== 'waiting') return { canceled: false, state: r.state };
  const now = Date.now();
  db().prepare("UPDATE print_jobs SET state = 'canceled', updated_at = ?, done_at = ? WHERE id = ? AND state IN ('queued','waiting')").run(now, now, r.id);
  dropFile(r.id);
  mgmt(r.peer_id, '/api/print/jobs', {}, 4000).catch(() => {});
  return { canceled: true, state: 'canceled' };
}

/** Jobs past 24 h end (expired; one being printed counts as done), stale scans fail, old rows go. */
function housekeeping(now = Date.now()) {
  const d = db();
  const due = d.prepare(`SELECT id, state FROM print_jobs WHERE expires_at <= ? AND state IN (${OPEN_STATES.map(() => '?').join(',')})`).all(now, ...OPEN_STATES);
  for (const r of due) {
    if (r.state === 'printing') d.prepare("UPDATE print_jobs SET state = 'done', message = 'unconfirmed', updated_at = ?, done_at = ? WHERE id = ?").run(now, now, r.id);
    else d.prepare("UPDATE print_jobs SET state = 'expired', error = COALESCE(error, 'expired'), updated_at = ?, done_at = ? WHERE id = ?").run(now, now, r.id);
    dropFile(r.id);
  }
  d.prepare("UPDATE print_scans SET state = 'failed', error = 'timeout', updated_at = ? WHERE state IN ('requested','scanning') AND updated_at < ?").run(now, now - SCAN_STALE_MS);
  // a text recognition the gateway stopped reporting on (it sends one every minute) ends; a queued one waits up to 30 min
  d.prepare("UPDATE print_ocr SET state = 'failed', error = 'timeout', updated_at = ? WHERE (state = 'running' AND updated_at < ?) OR (state = 'queued' AND updated_at < ?)").run(now, now - OCR_STALE_MS, now - 30 * 60 * 1000);
  d.prepare("DELETE FROM print_ocr WHERE updated_at < ? AND state IN ('done','failed','canceled')").run(now - KEEP_MS);
  d.prepare(`DELETE FROM print_jobs WHERE updated_at < ? AND state IN (${FINAL_STATES.map(() => '?').join(',')})`).run(now - KEEP_MS, ...FINAL_STATES);
  d.prepare("DELETE FROM print_scans WHERE updated_at < ? AND state IN ('done','failed','canceled')").run(now - KEEP_MS);
  return { expired: due.length };
}

/** Files without a job (a crash between file and row, a removed gateway) — hourly. */
function sweepFiles() {
  let names = [];
  try { names = fs.readdirSync(jobsDir()); } catch { return 0; }
  const open = new Set(db().prepare(`SELECT id FROM print_jobs WHERE state IN (${OPEN_STATES.map(() => '?').join(',')})`).all(...OPEN_STATES).map((r) => r.id));
  let n = 0;
  for (const f of names) {
    const id = f.replace(/\.bin$/, '');
    if (f.endsWith('.bin') && ID_RE.test(id) && !open.has(id)) { dropFile(id); n++; }
  }
  return n;
}

// ─── The gateway's side of the queue ───────────────────────────────────

/** GET /api/v1/gateway/print/jobs → { etag, jobs } — only this gateway's open jobs. */
function queueFor(peerId, now = Date.now()) {
  housekeeping(now);
  if (!settingsOf(peerId).enabled) return { etag: '"off"', jobs: [] };
  const rows = db().prepare(`SELECT j.*, u.display_name, u.username FROM print_jobs j LEFT JOIN users u ON u.id = j.user_id
    WHERE j.peer_id = ? AND j.state IN ('queued','sending','printing','waiting') AND j.expires_at > ? ORDER BY j.created_at LIMIT 50`).all(peerId, now);
  const list = rows.map((r) => ({
    id: r.id, deviceId: r.device_id, format: r.format, size: r.size, sha256: r.sha256, copies: r.copies, color: r.color === 1, duplex: r.duplex === 1,
    name: r.name, user: clean(r.display_name || r.username || 'GateControl', 60), expiresAt: r.expires_at,
    media: r.media || null, source: r.source || null,
  }));
  const etag = '"' + crypto.createHash('sha256').update(JSON.stringify(list)).digest('hex').slice(0, 32) + '"';
  return { etag, jobs: list };
}

/** GET /api/v1/gateway/print/jobs/:id/file — only an open job of this gateway. */
function sendFile(peerId, id, res) {
  if (typeof id !== 'string' || !ID_RE.test(id)) return res.status(404).json({ ok: false, error: 'not_found' });
  const r = db().prepare(`SELECT * FROM print_jobs WHERE id = ? AND peer_id = ? AND state IN ('queued','sending','waiting')`).get(id, peerId);
  if (!r) return res.status(404).json({ ok: false, error: 'not_found' });
  let fd;
  try { fd = fs.openSync(jobFile(r.id), 'r'); } catch { return res.status(404).json({ ok: false, error: 'not_found' }); }
  const size = fs.fstatSync(fd).size;
  if (size !== r.size) { fs.closeSync(fd); return res.status(500).json({ ok: false, error: 'file_mismatch' }); }
  res.set({ 'Content-Type': 'application/octet-stream', 'Content-Length': String(size), 'X-Content-SHA256': r.sha256, 'Cache-Control': 'no-store' });
  return fs.createReadStream(null, { fd, start: 0, end: Math.max(0, size - 1), autoClose: true }).on('error', () => res.destroy()).pipe(res);
}

const JOB_NEXT = {
  queued: ['sending', 'printing', 'waiting', 'done', 'failed'],
  waiting: ['sending', 'printing', 'waiting', 'done', 'failed'],
  sending: ['sending', 'printing', 'waiting', 'done', 'failed'],
  printing: ['printing', 'done', 'failed'],
};

/** POST /api/v1/gateway/print/jobs/:id — a state of a job of this gateway. */
function jobReport(peerId, id, body, now = Date.now()) {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new PrintError('not_found');
  const b = body && typeof body === 'object' ? body : {};
  const r = db().prepare('SELECT * FROM print_jobs WHERE id = ? AND peer_id = ?').get(id, peerId);
  if (!r) throw new PrintError('not_found');
  const next = typeof b.state === 'string' ? b.state : '';
  if (!['sending', 'printing', 'waiting', 'done', 'failed'].includes(next)) throw new PrintError('invalid', 'invalid state');
  if (!JOB_NEXT[r.state] || !JOB_NEXT[r.state].includes(next)) return { state: r.state, ignored: true };
  const error = typeof b.error === 'string' && ERR_RE.test(b.error) ? b.error : null;
  const message = clean(b.message, 200) || null;
  const ipp = Number.isInteger(b.ippJobId) && b.ippJobId > 0 ? b.ippJobId : null;
  // an office file: the pages of the PDF the gateway made (the count before was an estimate)
  const pages = office.OFFICE_TYPES.includes(r.format) && Number.isInteger(b.pages) && b.pages >= 1 && b.pages <= 100000 ? b.pages : null;
  const final = next === 'done' || next === 'failed';
  db().prepare(`UPDATE print_jobs SET state = ?, error = ?, message = ?, ipp_job_id = COALESCE(?, ipp_job_id), pages = COALESCE(?, pages), updated_at = ?, done_at = ? WHERE id = ?`)
    .run(next, next === 'done' ? null : error, message, ipp, pages, now, final ? now : null, r.id);
  if (final) dropFile(r.id);
  return { state: next };
}

// ─── Scans ─────────────────────────────────────────────────────────────

function scanView(r) {
  if (!r) return null;
  const pages = (json(r.pages) || []).map((p) => ({ n: p.n, mediaId: p.mediaId, mime: p.mime, bytes: p.bytes, thumb: p.thumb || null }));
  const s = json(r.settings) || {};
  return {
    id: r.id, deviceId: r.device_id, gatewayId: r.peer_id, user: r.user_id, state: r.state === 'requested' ? 'scanning' : r.state,
    error: r.error || null, pages, source: s.source || null, mode: s.mode || null, resolution: s.resolution || null,
    createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
  };
}

/** gc.print.scan({ deviceId, user, source?: platen|feeder, mode?: document|photo|bw, resolution?, duplex? }) */
async function scan(plugin, a) {
  const user = needUser(a.user);
  const device = needDevice(a.deviceId, 'scanner');
  if (device.problem === 'cert_changed') throw new PrintError('cert_changed', 'the certificate of this device changed');
  const sc = device.scanner;
  const source = a.source == null ? (sc.feeder && sc.adf === 'loaded' ? 'feeder' : (sc.platen ? 'platen' : 'feeder')) : a.source;
  if (!['platen', 'feeder'].includes(source)) throw new PrintError('invalid', 'source: platen or feeder');
  if ((source === 'feeder' && !sc.feeder) || (source === 'platen' && !sc.platen)) throw new PrintError('invalid', `this scanner has no ${source === 'feeder' ? 'feeder' : 'glass'}`);
  const mode = a.mode == null ? 'document' : a.mode;
  if (!SCAN_MODES[mode]) throw new PrintError('invalid', 'mode: document, photo or bw');
  const resolution = a.resolution == null ? SCAN_MODES[mode].resolution : Number(a.resolution);
  if (!RESOLUTIONS.includes(resolution)) throw new PrintError('invalid', `resolution: ${RESOLUTIONS.join(', ')}`);
  const active = db().prepare("SELECT COUNT(*) AS n FROM print_scans WHERE plugin_id = ? AND user_id = ? AND state IN ('requested','scanning') AND updated_at > ?").get(plugin.id, user.id, Date.now() - SCAN_STALE_MS).n;
  if (active) throw new PrintError('busy', 'a scan of this person is still running');
  const id = newId('ps');
  const now = Date.now();
  const settings = { source, mode, resolution, duplex: a.duplex === true && source === 'feeder' && sc.duplex };
  db().prepare(`INSERT INTO print_scans (id, plugin_id, user_id, peer_id, device_id, settings, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'requested', ?, ?)`)
    .run(id, plugin.id, user.id, device.gatewayId, device.id, JSON.stringify(settings), now, now);
  // JPEG pages: previews, a PDF of several pages (gc.print.pdf), the AI's look at the first one
  const r = await mgmt(device.gatewayId, '/api/print/scan', {
    scanId: id, deviceId: device.id, source, color: SCAN_MODES[mode].color, resolution, format: 'image/jpeg', duplex: settings.duplex,
  }, 7000);
  if (!r || r.status !== 202) {
    db().prepare('DELETE FROM print_scans WHERE id = ?').run(id);
    if (!r) throw new PrintError('offline', 'the gateway cannot be reached');
    if (r.status === 409) throw new PrintError('busy', 'the scanner is busy');
    if (r.status === 404) throw new PrintError('not_found', 'the gateway does not know this scanner (any more)');
    throw new PrintError('offline', `the gateway answered ${r.status}`);
  }
  return { scanId: id };
}

function ownScan(plugin, id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new PrintError('invalid', 'invalid scan id');
  const r = db().prepare('SELECT * FROM print_scans WHERE id = ? AND plugin_id = ?').get(id, plugin.id);
  if (!r) throw new PrintError('not_found', 'no such scan');
  return r;
}

function scanStatus(plugin, id) { housekeeping(); return scanView(ownScan(plugin, id)); }

async function cancelScan(plugin, id) {
  const r = ownScan(plugin, id);
  if (r.state !== 'requested' && r.state !== 'scanning') return { canceled: false, state: r.state };
  await mgmt(r.peer_id, '/api/print/scan/cancel', { scanId: r.id }, 4000);
  db().prepare("UPDATE print_scans SET state = 'canceled', updated_at = ? WHERE id = ?").run(Date.now(), r.id);
  return { canceled: true, state: 'canceled' };
}

/** A small preview (JPEG ≤ 240 px wide, base64) — null when it cannot be made. */
async function thumbOf(buf, mime) {
  if (mime === 'application/pdf') return null;
  try {
    const t = await require('sharp')(buf, { limitInputPixels: 120e6 }).rotate().resize({ width: 240, withoutEnlargement: true }).jpeg({ quality: 60 }).toBuffer();
    return t.length <= 48 * 1024 ? t.toString('base64') : null;
  } catch { return null; }
}

/**
 * PUT /api/v1/gateway/print/scans/:id/pages/:n — the body is the page (≤ 50 MB,
 * Content-Length required), only for a running scan of this gateway. The page
 * becomes an (unclaimed) media file of the plugin, owned by the person.
 */
async function storePage(peerId, id, n, req) {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new PrintError('not_found');
  const page = Number(n);
  if (!Number.isInteger(page) || page < 1 || page > MAX_PAGES) throw new PrintError('invalid', 'page: 1 … 100');
  const r = db().prepare("SELECT * FROM print_scans WHERE id = ? AND peer_id = ? AND state IN ('requested','scanning')").get(id, peerId);
  if (!r) throw new PrintError('not_found');
  const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (!PAGE_TYPES.includes(mime)) throw new PrintError('unsupported_type', 'image/jpeg, image/png or application/pdf');
  const length = Number(req.headers['content-length']);
  if (!Number.isSafeInteger(length) || length < 1) throw new PrintError('length_required');
  if (length > MAX_FILE) throw new PrintError('too_large');
  const plugin = require('./plugins/registry').get(r.plugin_id);
  if (!plugin) throw new PrintError('not_found');
  // the page in memory once (≤ 50 MB): stored encrypted as media, a preview made from it
  const chunks = [];
  let got = 0;
  for await (const c of req) {
    got += c.length;
    if (got > length) throw new PrintError('too_large');
    chunks.push(c);
  }
  if (got !== length) throw new PrintError('invalid', 'length mismatch');
  const buf = Buffer.concat(chunks);
  const ext = mime === 'application/pdf' ? 'pdf' : (mime === 'image/png' ? 'png' : 'jpg');
  const media = require('./plugins/media');
  let stored;
  try {
    stored = await media.storeBuffer(plugin, buf, { mime, name: `Scan ${page}.${ext}`, owner: r.user_id });
  } catch (e) {
    if (e && e.code === 'quota_exceeded') throw new PrintError('quota');
    if (e && (e.code === 'unsupported_type' || e.code === 'no_media')) throw new PrintError('unsupported_type');
    throw e;
  }
  const thumb = await thumbOf(buf, mime);
  const d = db();
  d.transaction(() => {
    const cur = d.prepare('SELECT pages FROM print_scans WHERE id = ?').get(r.id);
    const pages = (json(cur && cur.pages) || []).filter((p) => p.n !== page);
    pages.push({ n: page, mediaId: stored.mediaId, mime, bytes: buf.length, thumb });
    pages.sort((a, b) => a.n - b.n);
    d.prepare("UPDATE print_scans SET pages = ?, state = 'scanning', updated_at = ? WHERE id = ?").run(JSON.stringify(pages), Date.now(), r.id);
  })();
  return { mediaId: stored.mediaId };
}

/** POST /api/v1/gateway/print/scans/:id — scanning | done | failed */
function scanReport(peerId, id, body, now = Date.now()) {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new PrintError('not_found');
  const b = body && typeof body === 'object' ? body : {};
  const r = db().prepare('SELECT * FROM print_scans WHERE id = ? AND peer_id = ?').get(id, peerId);
  if (!r) throw new PrintError('not_found');
  if (!['scanning', 'done', 'failed'].includes(b.state)) throw new PrintError('invalid', 'invalid state');
  if (r.state !== 'requested' && r.state !== 'scanning') return { state: r.state, ignored: true };
  const error = b.state === 'failed' ? (typeof b.error === 'string' && ERR_RE.test(b.error) ? b.error : 'scan_failed') : null;
  db().prepare('UPDATE print_scans SET state = ?, error = ?, updated_at = ? WHERE id = ?').run(b.state, error, now, r.id);
  return { state: b.state };
}

// ─── A PDF of scanned pages ────────────────────────────────────────────

/** gc.print.pdf({ pages: [mediaId…], user, name, dpi? }) → { mediaId, pages, bytes } (unclaimed, owned by the person) */
async function makePdf(plugin, a) {
  const user = needUser(a.user);
  if (!Array.isArray(a.pages) || !a.pages.length || a.pages.length > MAX_PAGES) throw new PrintError('invalid', `pages: 1 … ${MAX_PAGES} media ids`);
  const dpi = a.dpi == null ? 300 : Number(a.dpi);
  if (!Number.isFinite(dpi) || dpi < 50 || dpi > 1200) throw new PrintError('invalid', 'dpi: 50 … 1200');
  let total = 0;
  const pages = [];
  for (const id of a.pages) {
    const { row, buf } = await readMedia(plugin, id);
    total += buf.length;
    if (total > MAX_FILE) throw new PrintError('too_large', `at most ${MAX_FILE} bytes`);
    let jpeg = buf;
    if (row.mime !== 'image/jpeg' || !pdf.jpegInfo(buf)) {
      if (!IMAGE_IN.includes(row.mime)) throw new PrintError('format', 'only pictures can become PDF pages');
      try { jpeg = await require('sharp')(buf, { limitInputPixels: 120e6 }).rotate().flatten({ background: '#ffffff' }).jpeg({ quality: 88 }).toBuffer(); } catch { throw new PrintError('format', 'a picture cannot be read'); }
    }
    pages.push({ jpeg, dpi });
  }
  const doc = pdf.jpegsToPdf(pages);
  let name = clean(a.name, 120) || 'Scan.pdf';
  if (!/\.pdf$/i.test(name)) name += '.pdf';
  let stored;
  try {
    stored = await require('./plugins/media').storeBuffer(plugin, doc, { mime: 'application/pdf', name, owner: user.id });
  } catch (e) {
    if (e && e.code === 'quota_exceeded') throw new PrintError('quota');
    if (e && (e.code === 'unsupported_type' || e.code === 'no_media')) throw new PrintError('format', 'application/pdf is not among the media types of this plugin');
    if (e && e.code === 'too_large') throw new PrintError('too_large');
    throw e;
  }
  return { mediaId: stored.mediaId, pages: pages.length, bytes: doc.length, name };
}

// ─── Text recognition (searchable PDF) ─────────────────────────────────

/** The text recognition of a gateway: capability print-ocr, „Texterkennung“ on, tesseract in its image. */
function ocrReady(peerId) {
  if (!settingsOf(peerId).enabled || !settingsOf(peerId).ocr) return false;
  const tel = telemetryOf(peerId);
  const caps = tel && Array.isArray(tel.capabilities) ? tel.capabilities : [];
  const o = tel && tel.features && tel.features.print && tel.features.print.ocr;
  return caps.includes('print-ocr') && !!(o && o.available === true);
}

/** The gateways that can recognise text, online — `prefer` (the scanner's gateway) first. */
function ocrGateways(prefer = null) {
  const ids = db().prepare(`SELECT p.id FROM peers p JOIN gateway_meta gm ON gm.peer_id = p.id
    WHERE p.peer_type = 'gateway' AND p.enabled = 1 AND gm.alive = 1`).all().map((r) => r.id).filter(ocrReady);
  return prefer != null && ids.includes(prefer) ? [prefer, ...ids.filter((x) => x !== prefer)] : ids;
}

/** gc.print.ocrAvailable() → { available, gateways } — is there a gateway with „Texterkennung“ on? */
function ocrAvailable() {
  const list = ocrGateways();
  return { available: list.length > 0, gateways: list.length };
}

function ocrView(r) {
  if (!r) return null;
  return {
    id: r.id, user: r.user_id, gatewayId: r.peer_id, state: r.state, page: r.page, pages: (json(r.pages) || []).length,
    error: r.error || null, mediaId: r.state === 'done' ? r.result_media : null, bytes: r.state === 'done' ? r.result_bytes : null,
    text: r.state === 'done' ? (r.text || '') : null, name: r.name, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
  };
}

/**
 * gc.print.ocr({ pages: [mediaId…], user, name, dpi?, deviceId? }) → { ocrId } — a searchable PDF of pictures (the
 * pages of a scan) made by a gateway with „Texterkennung“ on (the scanner's own first). The result comes with
 * gc.print.ocrStatus: the PDF as a media file of the plugin (unclaimed, owned by the person) and the text.
 */
async function ocr(plugin, a) {
  const user = needUser(a.user);
  if (!Array.isArray(a.pages) || !a.pages.length || a.pages.length > MAX_PAGES) throw new PrintError('invalid', `pages: 1 … ${MAX_PAGES} media ids`);
  const dpi = a.dpi == null ? 300 : Number(a.dpi);
  if (!Number.isInteger(dpi) || dpi < 70 || dpi > 1200) throw new PrintError('invalid', 'dpi: 70 … 1200');
  const media = require('./plugins/media');
  for (const id of a.pages) {
    const r = typeof id === 'string' ? media.row(plugin.id, id) : null;
    if (!r) throw new PrintError('not_found', 'no such media of this plugin');
    if (!['image/jpeg', 'image/png'].includes(r.mime)) throw new PrintError('format', 'text recognition reads JPEG and PNG pages');
    if (r.bytes > MAX_FILE) throw new PrintError('too_large', `at most ${MAX_FILE} bytes a page`);
  }
  let prefer = null;
  if (typeof a.deviceId === 'string' && DEVICE_RE.test(a.deviceId)) { const d = devices().find((x) => x.id === a.deviceId); prefer = d ? d.gatewayId : null; }
  const gws = ocrGateways(prefer);
  if (!gws.length) throw new PrintError('ocr_unavailable', 'no gateway with „Texterkennung“ is online');
  const open = db().prepare("SELECT COUNT(*) AS n FROM print_ocr WHERE plugin_id = ? AND user_id = ? AND state IN ('queued','running')").get(plugin.id, user.id).n;
  if (open >= 3) throw new PrintError('busy', 'at most 3 text recognitions per person at a time');
  let name = clean(a.name, 120) || 'Scan.pdf';
  if (!/\.pdf$/i.test(name)) name += '.pdf';
  const id = newId('po');
  const now = Date.now();
  for (const gw of gws) {
    db().prepare(`INSERT OR REPLACE INTO print_ocr (id, plugin_id, user_id, peer_id, pages, dpi, name, state, page, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?)`).run(id, plugin.id, user.id, gw, JSON.stringify(a.pages), dpi, name, now, now);
    const r = await mgmt(gw, '/api/print/ocr', { ocrId: id, pages: a.pages.length, dpi }, 7000);
    if (r && r.status === 202) return { ocrId: id };
    if (r && r.status === 409 && gws.length === 1) { db().prepare('DELETE FROM print_ocr WHERE id = ?').run(id); throw new PrintError('busy', 'the gateway is still busy with other text recognitions'); }
  }
  db().prepare('DELETE FROM print_ocr WHERE id = ?').run(id);
  throw new PrintError('ocr_unavailable', 'no gateway took the text recognition');
}

function ownOcr(plugin, id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new PrintError('invalid', 'invalid ocr id');
  const r = db().prepare('SELECT * FROM print_ocr WHERE id = ? AND plugin_id = ?').get(id, plugin.id);
  if (!r) throw new PrintError('not_found', 'no such text recognition');
  return r;
}

/** gc.print.ocrStatus(id) → { id, state: queued | running | done | failed | canceled, page, pages, error, mediaId, bytes, text } */
function ocrStatus(plugin, id) { housekeeping(); return ocrView(ownOcr(plugin, id)); }

/** gc.print.cancelOcr(id) → { canceled } */
async function cancelOcr(plugin, id) {
  const r = ownOcr(plugin, id);
  if (!OCR_OPEN.includes(r.state)) return { canceled: false, state: r.state };
  await mgmt(r.peer_id, '/api/print/ocr/cancel', { ocrId: r.id }, 4000);
  db().prepare("UPDATE print_ocr SET state = 'canceled', updated_at = ? WHERE id = ?").run(Date.now(), r.id);
  return { canceled: true, state: 'canceled' };
}

function gatewayOcr(peerId, id, states = OCR_OPEN) {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new PrintError('not_found');
  const r = db().prepare(`SELECT * FROM print_ocr WHERE id = ? AND peer_id = ? AND state IN (${states.map(() => '?').join(',')})`).get(id, peerId, ...states);
  if (!r) throw new PrintError('not_found');
  return r;
}

/** GET /api/v1/gateway/print/ocr/:id/pages/:n — one page of an open text recognition of this gateway. */
async function ocrPage(peerId, id, n, res) {
  const r = gatewayOcr(peerId, id);
  const list = json(r.pages) || [];
  const page = Number(n);
  if (!Number.isInteger(page) || page < 1 || page > list.length) throw new PrintError('not_found');
  const plugin = require('./plugins/registry').get(r.plugin_id);
  if (!plugin) throw new PrintError('not_found');
  let m;
  try { m = await readMedia(plugin, list[page - 1]); } catch (e) { throw new PrintError('not_found', e.message); }
  res.set({ 'Content-Type': m.row.mime === 'image/png' ? 'image/png' : 'image/jpeg', 'Content-Length': String(m.buf.length), 'Cache-Control': 'no-store' });
  res.end(m.buf);
}

/**
 * PUT /api/v1/gateway/print/ocr/:id/document — the searchable PDF (≤ 100 MB) → media of the plugin (unclaimed,
 * owned by the person); PUT …/text — the recognised text (≤ 1 MB, UTF-8).
 */
async function storeOcr(peerId, id, kind, req) {
  const r = gatewayOcr(peerId, id);
  if (kind !== 'document' && kind !== 'text') throw new PrintError('not_found');
  const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if ((kind === 'document' && mime !== 'application/pdf') || (kind === 'text' && mime !== 'text/plain')) throw new PrintError('unsupported_type');
  const length = Number(req.headers['content-length']);
  const max = kind === 'document' ? OCR_PDF_MAX : OCR_TEXT_MAX;
  if (!Number.isSafeInteger(length) || length < 1) throw new PrintError('length_required');
  if (length > max) throw new PrintError('too_large');
  const chunks = [];
  let got = 0;
  for await (const c of req) {
    got += c.length;
    if (got > length) throw new PrintError('too_large');
    chunks.push(c);
  }
  if (got !== length) throw new PrintError('invalid', 'length mismatch');
  const buf = Buffer.concat(chunks);
  if (kind === 'text') {
    // control characters other than line breaks and tabs go (the text is for search and questions, never shown raw)
    let text = '';
    for (const ch of buf.toString('utf8').slice(0, OCR_TEXT_MAX)) { const c = ch.codePointAt(0); text += c < 32 && c !== 10 && c !== 9 ? ' ' : (c === 127 ? ' ' : ch); }
    db().prepare('UPDATE print_ocr SET text = ?, updated_at = ? WHERE id = ?').run(text, Date.now(), r.id);
    return { stored: 'text' };
  }
  if (!pdf.pdfPages(buf)) throw new PrintError('invalid', 'not a readable PDF');
  const plugin = require('./plugins/registry').get(r.plugin_id);
  if (!plugin) throw new PrintError('not_found');
  let stored;
  try {
    stored = await require('./plugins/media').storeBuffer(plugin, buf, { mime: 'application/pdf', name: r.name, owner: r.user_id });
  } catch (e) {
    if (e && e.code === 'quota_exceeded') throw new PrintError('quota');
    if (e && (e.code === 'unsupported_type' || e.code === 'no_media')) throw new PrintError('unsupported_type');
    throw e;
  }
  db().prepare('UPDATE print_ocr SET result_media = ?, result_bytes = ?, updated_at = ? WHERE id = ?').run(stored.mediaId, buf.length, Date.now(), r.id);
  return { mediaId: stored.mediaId };
}

/** POST /api/v1/gateway/print/ocr/:id — { state: running | done | failed, page?, pages?, error? } */
function ocrReport(peerId, id, body, now = Date.now()) {
  const b = body && typeof body === 'object' ? body : {};
  const r = gatewayOcr(peerId, id, ['queued', 'running', 'done', 'failed', 'canceled']);
  if (!['running', 'done', 'failed'].includes(b.state)) throw new PrintError('invalid', 'invalid state');
  if (!OCR_OPEN.includes(r.state)) return { state: r.state, ignored: true };
  const page = Number.isInteger(b.page) && b.page >= 0 && b.page <= MAX_PAGES ? b.page : r.page;
  let state = b.state;
  let error = state === 'failed' ? (typeof b.error === 'string' && ERR_RE.test(b.error) ? b.error : 'ocr_failed') : null;
  // done without the PDF (an upload that never came): failed
  if (state === 'done' && !r.result_media) { state = 'failed'; error = 'upload_failed'; }
  db().prepare('UPDATE print_ocr SET state = ?, page = ?, error = ?, updated_at = ? WHERE id = ?').run(state, page, error, now, r.id);
  return { state };
}

// ─── The card "Funktionen" ─────────────────────────────────────────────

/** For gatewayFeatures.overview(): the switch and what this gateway found. */
function overview(peerId) {
  const s = settingsOf(peerId);
  const rows = db().prepare('SELECT data FROM print_devices WHERE peer_id = ?').all(peerId).map((r) => json(r.data)).filter(Boolean);
  let plugin = null;
  try {
    const p = require('./plugins/registry').get('gatecontrol-print');
    plugin = p ? { installed: true, enabled: p.enabled === true } : { installed: false, enabled: false };
  } catch { plugin = null; }
  const last = searchOf(peerId);
  const gf = require('./gatewayFeatures');
  const tel = telemetryOf(peerId);
  const tc = tel && tel.features && tel.features.print && tel.features.print.convert;
  const board = gf.boardOf(tel && tel.hardware && tel.hardware.model);
  const noPdf = (d) => !!(d.printer && Array.isArray(d.printer.formats) && d.printer.formats.length && !d.printer.formats.includes('application/pdf'));
  return {
    enabled: s.enabled,
    manual: s.manual,
    manualMax: MAX_MANUAL,
    devices: rows.slice(0, 12).map((d) => ({
      name: d.name, model: d.model || null, ip: d.ip, source: d.source === 'manual' ? 'manual' : 'mdns',
      printer: !!d.printer, scanner: !!d.scanner, online: !!d.online, problem: d.problem || null,
      // a printer without PDF: converted by this gateway (the format) or not (null)
      noPdf: noPdf(d), convert: noPdf(d) ? (d.printer.convert || null) : null,
    })),
    count: rows.length,
    // the last search; searchKnown false: the gateway is too old to report one ("bitte aktualisieren")
    search: last.search,
    searchKnown: last.known,
    plugin,
    minGateway: MIN_GATEWAY,
    // PDF for printers without PDF (gateway docs/print.md "Umwandeln"): the switch, whether this gateway can,
    // whether its image has the tools (null: not reported yet), a hint for weak hardware (never a ban)
    convert: s.convert,
    convertSupported: gf.support(tel).printConvert,
    convertAvailable: tc && typeof tc.available === 'boolean' ? tc.available : null,
    convertHint: ['pi3bplus', 'pi3', 'pi_zero'].includes(board) ? 'slow' : null,
    minGatewayConvert: gf.MIN_GATEWAY_PRINT_CONVERT,
    // Texterkennung and Office-Dateien drucken (gateway docs/print.md, gateway ≥ MIN_GATEWAY_P3C): the switches, whether
    // this gateway can (capabilities), what it reports, a hint for weak hardware (never a ban)
    ...extrasOf(peerId, s, tel, board),
  };
}

/** The service office does not run: what helps (like the cameras' service kameras). */
function officeCompose(peerId, s, f, tel) {
  if (!s.office || (f && f.service === 'managed')) return null;
  let platform = null;
  try { platform = require('./homeRadio').platformOf(peerId, tel); } catch { platform = null; }
  const service = f ? f.service : 'missing';
  if (platform === 'rpi') return service === 'absent' ? null : 'image';
  return 'compose';
}

/** The part of overview() for text recognition and office files. */
function extrasOf(peerId, s, tel, board) {
  const caps = tel && Array.isArray(tel.capabilities) ? tel.capabilities : [];
  const fp = (tel && tel.features && tel.features.print) || {};
  const o = fp.ocr && typeof fp.ocr === 'object' ? fp.ocr : null;
  const f = fp.office && typeof fp.office === 'object' ? fp.office : null;
  const mem = tel ? Number((tel.hardware && tel.hardware.mem_total) || tel.mem_total) || null : null;
  const weak = ['pi3bplus', 'pi3', 'pi_zero'].includes(board);
  return {
    ocr: s.ocr === true,
    ocrSupported: caps.includes('print-ocr'),
    ocrAvailable: o && typeof o.available === 'boolean' ? o.available : null,
    ocrHint: weak ? 'slow' : null,
    office: s.office === true,
    officeSupported: caps.includes('print-office'),
    // managed: the service office runs; absent: being set up (the image is loading) or missing in the compose file; missing: no compose support
    officeService: f && ['managed', 'absent', 'missing'].includes(f.service) ? f.service : null,
    // ≈ 700 MB on disk, up to ≈ 500 MB RAM while converting: a hint below 2 GB RAM or on a Pi 3/Zero (never a ban)
    officeHint: weak || (mem != null && mem < 2 * 1024 * 1024 * 1024) ? 'small' : null,
    // what the row says while the service does not run: compose (a new docker-compose.yml), image (an older Pi image),
    // null (the Pi image starts it itself — "wird eingerichtet")
    officeCompose: officeCompose(peerId, s, f, tel),
    minGatewayP3c: MIN_GATEWAY_P3C,
  };
}

/** The other plugins and the host API: error codes → host API codes. */
const HOST_CODES = {
  invalid: 'ERR_INVALID', not_found: 'ERR_NOT_FOUND', offline: 'ERR_PRINT_OFFLINE', format: 'ERR_PRINT_FORMAT', too_large: 'ERR_PRINT_TOO_LARGE',
  busy: 'ERR_PRINT_BUSY', quota: 'ERR_MEDIA_QUOTA', media_unavailable: 'ERR_MEDIA_DENIED', cert_changed: 'ERR_PRINT_CERT_CHANGED',
  ocr_unavailable: 'ERR_PRINT_OCR_UNAVAILABLE',
};

module.exports = {
  MIN_GATEWAY, MIN_GATEWAY_P3C, MAX_FILE, JOB_TTL_MS, PrintError, HOST_CODES,
  normalizeSettings, configPayload, composeWantsOffice, ingestDevices, cleanDevice, cleanMedia, cleanSearch, searchOf, devices, deviceView, discover, discoverOne,
  submit, testPage, job, jobs, cancel, pagesOf, printable, housekeeping, sweepFiles,
  queueFor, sendFile, jobReport, scan, scanStatus, cancelScan, storePage, scanReport, makePdf, overview, jobsDir,
  ocr, ocrStatus, cancelOcr, ocrAvailable, ocrReady, ocrPage, storeOcr, ocrReport,
};
