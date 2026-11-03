'use strict';

// Virus scan (Einstellungen › Sicherheit › Virenscan, docs: FEATURES.md
// "Malware Scan", plugin contract docs/feature-malware-scan-contract.md).
//
// Every file a plugin gets through GateControl's media store (gc.media:
// uploads of apps / portal / frames, resumable uploads, public upload links,
// gc.media.fetch, cloud imports, mail attachments) is checked right after it
// is stored, before anyone can open it:
//
//   Grundschutz (always, no memory): file-type rules (rules.js) and the local
//                 list of known malware by SHA-256 (hashlist.js, MalwareBazaar)
//   a scanner     (licence `malware_scanning`): ClamAV through clamd
//                 (clamd.js — on this server as the optional container
//                 "clamav", or in the network) or an own scanner through ICAP
//                 (icap.js)
//
// State per file (plugin_media.scan_state): pending → clean | infected |
// unscannable; NULL / 'unchecked' = not checked (from before, or the source is
// switched off). plugin_media.scan_blocked = 1: the file is not served
// (gate(): 423 scan_pending / quarantined / scan_blocked) — media.send,
// media.readRange and everything built on them (public links, ZIPs, mail
// sending, AI, previews, hand-over, copies). A finding is quarantined (30
// days, then deleted), only marked, or deleted at once — the setting
// "Bei einem Fund". A scanner that cannot be reached: "Später prüfen" keeps
// the file (Grundschutz checked, served) and checks it again every 5 minutes;
// "Uploads anhalten" refuses the upload (503 scan_unavailable).
//
// The upload waits for the result up to BUDGET_MS; a larger file stays
// pending (not served) and is finished in the background (plugins hear it
// through the hook mediaScanned). The bytes are read chunk by chunk from the
// sealed file and streamed to the scanner — never held in memory, never sent
// anywhere but the configured scanner; the main thread only decrypts chunks.

const crypto = require('node:crypto');
const settings = require('../settings');
const logger = require('../../utils/logger');
const rules = require('./rules');
const hashlist = require('./hashlist');
const clamd = require('./clamd');
const icap = require('./icap');
const N = require('./net');

const K_CONFIG = 'scan.config';
const K_STATE = 'scan.state';
const SOURCES = ['drive_link', 'drive_own', 'gatedrop', 'mail', 'messenger', 'other'];
const EXTERNAL = new Set(['drive_link', 'gatedrop', 'mail', 'messenger']);
const ENGINES = ['none', 'clamav_local', 'clamav_net', 'icap'];
const ACTIONS = ['quarantine', 'mark', 'delete'];
const QUARANTINE_DAYS = 30;
const BUDGET_MS = 15000;
const RETRY_MS = 5 * 60e3;
const CONCURRENCY = 2;
const STALE_DAYS = 2;
const LOCAL_ADDRESS = '127.0.0.1:3310';
const PLUGIN_SOURCES = { 'gatecontrol-drive': 'drive', 'gatecontrol-gatedrop': 'gatedrop', 'gatecontrol-mail': 'mail', 'gatecontrol-messenger': 'messenger' };

const DEFAULTS = Object.freeze({
  engine: 'none', address: '', icap_service: 'avscan', unreachable: 'later',
  sources: { drive_link: true, drive_own: true, gatedrop: true, mail: true, messenger: true, other: false },
  action: 'quarantine', unscannable: 'mark', notify: true, max_mb: 200, archive_depth: 5, rescan: 'nightly', sig_check_h: 2,
});

class ScanError extends Error {
  constructor(code, message, status = 400, field = null) { super(message || code); this.code = code; this.statusCode = status; this.field = field; }
}

function db() { return require('../../db/connection').getDb(); }
function media() { return require('../plugins/media'); }
function licensed() { try { return require('../license').hasFeature('malware_scanning'); } catch { return false; } }

// ─── Settings ──────────────────────────────────────────

function getConfig() {
  let c = {};
  try { c = JSON.parse(settings.get(K_CONFIG, '{}')) || {}; } catch { c = {}; }
  const out = JSON.parse(JSON.stringify(DEFAULTS));
  if (ENGINES.includes(c.engine)) out.engine = c.engine;
  if (typeof c.address === 'string') out.address = c.address.slice(0, 300);
  if (typeof c.icap_service === 'string' && /^[A-Za-z0-9._~\-/]{1,100}$/.test(c.icap_service)) out.icap_service = c.icap_service;
  if (['later', 'hold'].includes(c.unreachable)) out.unreachable = c.unreachable;
  for (const s of SOURCES) if (c.sources && typeof c.sources[s] === 'boolean') out.sources[s] = c.sources[s];
  if (ACTIONS.includes(c.action)) out.action = c.action;
  if (['mark', 'block'].includes(c.unscannable)) out.unscannable = c.unscannable;
  if (typeof c.notify === 'boolean') out.notify = c.notify;
  if (Number.isInteger(c.max_mb) && c.max_mb >= 1 && c.max_mb <= 4096) out.max_mb = c.max_mb;
  if (Number.isInteger(c.archive_depth) && c.archive_depth >= 1 && c.archive_depth <= 10) out.archive_depth = c.archive_depth;
  if (['nightly', 'weekly', 'off'].includes(c.rescan)) out.rescan = c.rescan;
  if ([2, 6, 24].includes(c.sig_check_h)) out.sig_check_h = c.sig_check_h;
  return out;
}

/** The scanner in force (none without the licence). */
function engineOf(cfg = getConfig()) { return cfg.engine !== 'none' && licensed() ? cfg.engine : 'none'; }

function scannerAddress(cfg) {
  const engine = engineOf(cfg);
  if (engine === 'none') return null;
  const raw = engine === 'clamav_local' ? (cfg.address || LOCAL_ADDRESS) : cfg.address;
  if (engine === 'icap') {
    const a = N.parseAddress(raw, { defaultPort: 1344, scheme: 'icap' });
    return { ...a, service: a.service || cfg.icap_service };
  }
  return N.parseAddress(raw, { defaultPort: 3310 });
}

function setConfig(input) {
  const b = input && typeof input === 'object' ? input : {};
  const cur = getConfig();
  const next = JSON.parse(JSON.stringify(cur));
  const bad = (field, msg) => { throw new ScanError('invalid', msg, 400, field); };
  if (b.engine !== undefined) {
    if (!ENGINES.includes(b.engine)) bad('engine', 'unknown scanner');
    if (b.engine !== 'none' && b.engine !== cur.engine && !licensed()) throw Object.assign(new ScanError('license', 'a scanner needs the licence malware_scanning', 403, 'engine'), { feature: 'malware_scanning' });
    next.engine = b.engine;
  }
  if (b.address !== undefined) {
    const a = String(b.address || '').trim();
    if (a) {
      try { N.parseAddress(a, { defaultPort: next.engine === 'icap' ? 1344 : 3310, scheme: 'icap' }); } catch (e) { bad('address', e.message); }
    }
    next.address = a;
  }
  if (b.icap_service !== undefined) {
    if (!/^[A-Za-z0-9._~\-/]{1,100}$/.test(String(b.icap_service))) bad('icap_service', 'invalid service name');
    next.icap_service = String(b.icap_service);
  }
  if (b.unreachable !== undefined) { if (!['later', 'hold'].includes(b.unreachable)) bad('unreachable', 'later or hold'); next.unreachable = b.unreachable; }
  if (b.sources !== undefined) {
    if (!b.sources || typeof b.sources !== 'object') bad('sources', 'sources must be an object');
    // only the known sources are written (keys from the request never become property names)
    if (Object.keys(b.sources).some((k) => !SOURCES.includes(k))) bad('sources', 'unknown source');
    for (const src of SOURCES) {
      if (!Object.prototype.hasOwnProperty.call(b.sources, src)) continue;
      const v = b.sources[src];
      if (typeof v !== 'boolean') bad('sources', 'true or false');
      next.sources[src] = v;
    }
  }
  if (b.action !== undefined) { if (!ACTIONS.includes(b.action)) bad('action', 'quarantine, mark or delete'); next.action = b.action; }
  if (b.unscannable !== undefined) { if (!['mark', 'block'].includes(b.unscannable)) bad('unscannable', 'mark or block'); next.unscannable = b.unscannable; }
  if (b.notify !== undefined) { if (typeof b.notify !== 'boolean') bad('notify', 'true or false'); next.notify = b.notify; }
  if (b.max_mb !== undefined) { const n = Number(b.max_mb); if (!Number.isInteger(n) || n < 1 || n > 4096) bad('max_mb', '1 … 4096 MB'); next.max_mb = n; }
  if (b.archive_depth !== undefined) { const n = Number(b.archive_depth); if (!Number.isInteger(n) || n < 1 || n > 10) bad('archive_depth', '1 … 10'); next.archive_depth = n; }
  if (b.rescan !== undefined) { if (!['nightly', 'weekly', 'off'].includes(b.rescan)) bad('rescan', 'nightly, weekly or off'); next.rescan = b.rescan; }
  if (b.sig_check_h !== undefined) { const n = Number(b.sig_check_h); if (![2, 6, 24].includes(n)) bad('sig_check_h', '2, 6 or 24'); next.sig_check_h = n; }
  if (['clamav_net', 'icap'].includes(next.engine) && !next.address) bad('address', 'the address of the scanner is missing');
  if (b.abusech_key !== undefined) hashlist.setKey(b.abusech_key);
  settings.set(K_CONFIG, JSON.stringify(next));
  // "ClamAV auf diesem Server": the host's update.sh starts / stops the container
  if (next.engine !== cur.engine) { try { require('../autoUpdate').syncConfigFile(); } catch { /* best-effort */ } }
  if (b.abusech_key) setImmediate(() => { hashlist.refresh({ force: true }).catch(() => {}); });
  _state.down = null;
  return getConfig();
}

// ─── Sources ───────────────────────────────────────────

/**
 * Which switch of "Was geprüft wird" a stored file belongs to. `kind`: how it
 * came in — 'upload' (app / portal / frame), 'link' (public upload link),
 * 'host' (made by the host for the plugin: mail), 'fetch', 'cloud', 'copy'.
 */
function sourceOf(pluginId, kind) {
  const p = PLUGIN_SOURCES[pluginId];
  if (p === 'drive') return kind === 'link' ? 'drive_link' : 'drive_own';
  if (p) return p;
  return 'other';
}

function isExternal(source, kind) { return EXTERNAL.has(source) || (source === 'other' && (kind === 'link' || kind === 'host' || kind === 'fetch')); }

// ─── The scan ──────────────────────────────────────────

const _state = { queue: [], running: 0, inflight: new Map(), down: null, timers: [], lastSig: null, testMode: process.env.NODE_ENV === 'test' };

function readerOf(row) {
  const M = media();
  return async (start, end) => {
    const parts = [];
    for await (const p of M.readRangeRaw(row, start, Math.min(end, row.bytes - 1))) parts.push(p);
    return Buffer.concat(parts);
  };
}

function engineTimeout(bytes) { return 60000 + Math.ceil(bytes / (1024 * 1024)) * 1000; }

async function runEngine(row, cfg) {
  const engine = engineOf(cfg);
  const addr = scannerAddress(cfg);
  const src = row.bytes ? media().readRangeRaw(row, 0, row.bytes - 1) : [];
  if (engine === 'icap') return { ...(await icap.scan(addr, src, { name: row.name || row.id, timeoutMs: engineTimeout(row.bytes) })), engine: 'icap' };
  return { ...(await clamd.scan(addr, src, { timeoutMs: engineTimeout(row.bytes) })), engine: 'clamav' };
}

/**
 * Check one stored row. → { state, finding, engine, detail, reason, known }
 * state 'pending' with `deferred` when the scanner was unreachable.
 */
async function check(row, { source, kind, cfg = getConfig() } = {}) {
  if (db().prepare('SELECT 1 FROM scan_exceptions WHERE sha256 = ?').get(row.sha256)) return { state: 'clean', engine: 'exception' };
  const external = isExternal(source, kind);
  const read = readerOf(row);
  const g = await rules.check({ name: row.name || '', mime: row.mime, size: row.bytes, read, external, maxDepth: cfg.archive_depth });
  const known = hashlist.lookup(row.sha256);
  if (known) return { state: 'infected', finding: known.signature ? `MalwareBazaar: ${known.signature}` : 'MalwareBazaar', engine: 'hashlist', known: true, detail: g.detail || null };
  if (g.verdict === 'infected') return { state: 'infected', finding: g.finding, engine: 'grundschutz', detail: g.detail };
  const engine = engineOf(cfg);
  const mediaOnly = source === 'drive_own' && /^(image|video|audio)\//.test(String(row.mime || ''));
  if (engine !== 'none' && !mediaOnly) {
    if (row.bytes > cfg.max_mb * 1024 * 1024) return { state: 'unscannable', reason: 'too_large', engine: 'grundschutz', detail: { kind: 'too_large', max_mb: cfg.max_mb } };
    try {
      const r = await runEngine(row, cfg);
      noteUp();
      if (r.verdict === 'infected') return { state: 'infected', finding: r.finding, engine: r.engine };
      if (r.verdict === 'unscannable') return { state: 'unscannable', reason: r.reason, engine: r.engine, detail: { kind: r.reason } };
      if (g.verdict === 'unscannable') return { state: 'unscannable', reason: g.reason, engine: 'grundschutz', detail: g.detail };
      return { state: 'clean', engine: r.engine };
    } catch (e) {
      noteDown(e);
      return { state: 'pending', deferred: true, engine: 'grundschutz', reason: 'scanner_unreachable', grundschutz: g };
    }
  }
  if (g.verdict === 'unscannable') return { state: 'unscannable', reason: g.reason, engine: 'grundschutz', detail: g.detail };
  return { state: 'clean', engine: 'grundschutz' };
}

function activity(type, message, details, severity = 'warning') {
  try { require('../activity').log(type, message, { source: 'system', severity, details }); } catch { /* best-effort */ }
}

function noteDown(err) {
  const now = Date.now();
  if (!_state.down) {
    _state.down = { since: now, error: String(err && (err.code || err.message) || 'unreachable').slice(0, 120) };
    activity('malware_scanner_unreachable', `Virus scanner not reachable: ${_state.down.error}`, { error: _state.down.error, code: 'scanner_unreachable' });
  }
}
function noteUp() { _state.down = null; }

function ownerName(id) {
  if (id == null) return null;
  try { const u = db().prepare('SELECT username, display_name FROM users WHERE id = ?').get(id); return u ? (u.display_name || u.username) : null; } catch { return null; }
}

function setRow(id, patch) {
  const cols = Object.keys(patch);
  db().prepare(`UPDATE plugin_media SET ${cols.map((c) => `${c} = @${c}`).join(', ')} WHERE id = @id`).run({ ...patch, id });
}

/** Write the outcome of a check: the row, the finding (history / quarantine), the action. → the stored state. */
function apply(row, res, { source, kind, sender = null, cfg = getConfig(), background = false } = {}) {
  const now = Date.now();
  const base = { scan_source: source, scan_at: now, scan_engine: res.engine || null };
  if (res.state === 'clean') {
    setRow(row.id, { ...base, scan_state: 'clean', scan_blocked: 0, scan_finding: null });
    db().prepare("UPDATE scan_findings SET state = 'clean', resolved_at = ? WHERE media_id = ? AND state IN ('quarantined', 'marked', 'unscannable', 'blocked')").run(now, row.id);
  } else if (res.state === 'pending') {
    // scanner unreachable: Grundschutz passed → served meanwhile, checked again later
    setRow(row.id, { ...base, scan_state: 'pending', scan_blocked: 0, scan_finding: null });
  } else if (res.state === 'unscannable') {
    const block = cfg.unscannable === 'block';
    setRow(row.id, { ...base, scan_state: 'unscannable', scan_blocked: block ? 1 : 0, scan_finding: res.reason || null });
    record(row, { source, sender, finding: res.reason || 'unscannable', engine: res.engine, detail: res.detail, state: block ? 'blocked' : 'unscannable' });
  } else if (res.state === 'infected') {
    const action = cfg.action;
    const detail = { ...(res.detail || {}), known: !!res.known || !!hashlist.lookup(row.sha256) };
    if (action === 'delete') {
      record(row, { source, sender, finding: res.finding, engine: res.engine, detail, state: 'deleted' });
      try { media().remove(row.plugin, row.id); } catch (e) { logger.warn({ err: e.message }, 'virus scan: file not deleted'); }
    } else {
      setRow(row.id, { ...base, scan_state: 'infected', scan_blocked: action === 'quarantine' ? 1 : 0, scan_finding: res.finding });
      record(row, { source, sender, finding: res.finding, engine: res.engine, detail, state: action === 'quarantine' ? 'quarantined' : 'marked',
        expires: action === 'quarantine' ? now + QUARANTINE_DAYS * 86400e3 : null });
    }
    if (cfg.notify) {
      tellOwner(row, res.finding, action);
      activity('malware_found', `Malware found: ${row.name || row.id} (${res.finding})`, {
        name: row.name || null, plugin: row.plugin, source, finding: res.finding, action, mediaId: row.id,
        user: ownerName(row.owner_user_id), userId: row.owner_user_id == null ? null : row.owner_user_id, code: 'malware_found',
      });
    }
  }
  if (background) tellPlugin(row, res.state);
  return res.state;
}

/** "auch die Person, die die Datei hatte": one message into the owner's inbox (notification centre). */
function tellOwner(row, finding, action) {
  if (row.owner_user_id == null) return;
  try {
    const text = require('../notify/text');
    const lang = text.userLang(row.owner_user_id) || text.serverLang();
    const name = row.name || row.id;
    require('../notify/hub').publish({
      eventId: 'malware_owner', eventType: 'malware_found', topic: 'admin_notice', source: 'scan', priority: 'high',
      title: text.t(lang, 'push.scan.owner_title'),
      body: text.t(lang, action === 'delete' ? 'push.scan.owner_body_deleted' : 'push.scan.owner_body', { name, finding }),
      data: { route: 'inbox' }, collapseKey: null, ttlS: 7 * 86400, target: { type: 'users', ids: [row.owner_user_id] },
    }, { rule: null, route: { users: [row.owner_user_id] } });
  } catch (err) { logger.debug({ err: err.message }, 'virus scan: owner not told'); }
}

function record(row, { source, sender, finding, engine, detail, state, expires = null }) {
  db().prepare("UPDATE scan_findings SET state = 'superseded', resolved_at = ? WHERE media_id = ? AND state IN ('quarantined', 'marked', 'unscannable', 'blocked')").run(Date.now(), row.id);
  db().prepare(`INSERT INTO scan_findings (media_id, plugin, source, name, mime, bytes, sha256, owner_user_id, sender, finding, engine, detail, state, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(row.id, row.plugin, source, row.name || null, row.mime, row.bytes, row.sha256,
    row.owner_user_id == null ? null : row.owner_user_id, sender ? String(sender).slice(0, 200) : null, String(finding || '').slice(0, 200),
    engine || null, detail ? JSON.stringify(detail).slice(0, 2000) : null, state, Date.now(), expires);
}

/** Tell the plugin (hook mediaScanned) — fire and forget, only for a result after the upload answered. */
function tellPlugin(row, state) {
  try {
    const r = db().prepare('SELECT scan_state, scan_blocked, scan_finding FROM plugin_media WHERE id = ?').get(row.id);
    const payload = { mediaId: row.id, state: r ? r.scan_state : 'deleted', blocked: r ? !!r.scan_blocked : true, finding: r ? r.scan_finding : null };
    require('../plugins/runtime').call(row.plugin, 'mediaScanned', payload, 5000).catch(() => {});
    require('../eventBus').publish('scan', { plugin: row.plugin, mediaId: row.id, state: payload.state });
  } catch { /* best-effort */ }
  return state;
}

function freshRow(id) { return db().prepare('SELECT * FROM plugin_media WHERE id = ?').get(id) || null; }

/**
 * Right after a file was stored (media.js writeFile / storePart). Waits up to
 * BUDGET_MS. → { state, blocked, finding, deleted?, hold? }
 */
async function afterStore(mediaId, { kind = 'upload', sender = null, budgetMs = BUDGET_MS } = {}) {
  const row = freshRow(mediaId);
  if (!row) return { state: 'deleted', blocked: true, deleted: true };
  const cfg = getConfig();
  const source = sourceOf(row.plugin, kind);
  if (!cfg.sources[source]) {
    setRow(row.id, { scan_state: 'unchecked', scan_blocked: 0, scan_source: source, scan_at: Date.now() });
    return { state: 'unchecked', blocked: false, finding: null };
  }
  setRow(row.id, { scan_state: 'pending', scan_blocked: 1, scan_source: source });
  const ctx = { source, kind, sender, cfg };
  let done = false;
  const job = (async () => {
    let res;
    try { res = await check(row, ctx); } catch (e) {
      logger.warn({ err: e && e.message, media: row.id }, 'virus scan: check failed');
      res = { state: 'unscannable', reason: 'error', engine: 'grundschutz', detail: { kind: 'error' } };
    }
    if (res.state === 'pending' && cfg.unreachable === 'hold') return { ...res, hold: true };
    const state = apply(row, res, { ...ctx, background: done });
    if (res.state === 'pending') enqueue(row.id, ctx);
    return { ...res, state };
  })();
  _state.inflight.set(row.id, job);
  job.finally(() => _state.inflight.delete(row.id)).catch(() => {});
  const timer = new Promise((resolve) => { const t = setTimeout(() => resolve(null), budgetMs); if (t.unref) t.unref(); });
  const res = await Promise.race([job, timer]);
  done = true;
  if (!res) return { state: 'pending', blocked: true, finding: null };
  if (res.hold) return { state: 'pending', blocked: true, hold: true };
  const after = freshRow(row.id);
  if (!after) return { state: 'infected', blocked: true, deleted: true, finding: res.finding };
  return { state: after.scan_state, blocked: !!after.scan_blocked, finding: after.scan_finding || null };
}

/** Is the row servable? → null or { code, status }. */
function gate(row) {
  if (!row || !row.scan_blocked) return null;
  if (row.scan_state === 'pending') return { code: 'scan_pending', status: 423 };
  if (row.scan_state === 'infected') return { code: 'quarantined', status: 423 };
  return { code: 'scan_blocked', status: 423 };
}

/** What gc.media.info shows of a row. */
function infoOf(row) {
  if (!row) return null;
  return { state: row.scan_state || 'unchecked', blocked: !!row.scan_blocked, finding: row.scan_finding || null, at: row.scan_at ? new Date(row.scan_at).toISOString() : null };
}

// ─── Queue (later checks, rescans) ─────────────────────

function enqueue(id, ctx = {}) {
  if (_state.queue.some((q) => q.id === id)) return;
  _state.queue.push({ id, ctx });
  pump();
}

function pump() {
  while (_state.running < CONCURRENCY && _state.queue.length) {
    const job = _state.queue.shift();
    _state.running++;
    rescanOne(job.id, job.ctx).catch(() => {}).finally(() => { _state.running--; pump(); });
  }
}

/** Check a stored row again (queue, "Erneut prüfen", nightly). → the new state. */
async function rescanOne(id, { kind = null } = {}) {
  const row = freshRow(id);
  if (!row) return 'deleted';
  const cfg = getConfig();
  const source = row.scan_source || sourceOf(row.plugin, kind);
  const res = await check(row, { source, kind, cfg });
  if (res.state === 'pending') return 'pending';
  return apply(row, res, { source, kind, cfg, background: true });
}

/** Retry the files a scanner could not check (every RETRY_MS). */
function retryPending() {
  try {
    // without a scanner the check ends with the Grundschutz — pending rows then
    // only come from a restart in the middle of a check
    const rows = db().prepare("SELECT id FROM plugin_media WHERE scan_state = 'pending' ORDER BY scan_at LIMIT 200").all();
    for (const r of rows) if (!_state.inflight.has(r.id)) enqueue(r.id);
    return rows.length;
  } catch (err) { logger.debug({ err: err.message }, 'virus scan: retry failed'); return 0; }
}

/** Nightly: Drive files of the last 30 days again, with the newest signatures. */
async function nightly({ now = Date.now() } = {}) {
  const cfg = getConfig();
  if (cfg.rescan === 'off' || engineOf(cfg) === 'none') return 0;
  const since = new Date(now - 30 * 86400e3).toISOString();
  const rows = db().prepare(`SELECT id FROM plugin_media WHERE plugin = 'gatecontrol-drive' AND created_at >= ?
    AND (scan_state IS NULL OR scan_state IN ('clean', 'unchecked', 'pending', 'unscannable')) AND bytes <= ?`).all(since, cfg.max_mb * 1024 * 1024);
  let n = 0;
  for (const r of rows) {
    try { await rescanOne(r.id, { kind: 'upload' }); n++; } catch { /* next */ }
    if (_state.down) break;
  }
  setScanState({ last_rescan: now, last_rescan_files: n });
  return n;
}

// ─── Quarantine and history ────────────────────────────

function findingRow(id) {
  const f = db().prepare('SELECT * FROM scan_findings WHERE id = ?').get(Number(id));
  if (!f) throw new ScanError('not_found', 'finding not found', 404);
  return f;
}

function toApi(f) {
  let detail = null;
  try { detail = f.detail ? JSON.parse(f.detail) : null; } catch { detail = null; }
  return {
    id: f.id, mediaId: f.media_id, plugin: f.plugin, source: f.source, name: f.name, mime: f.mime, bytes: f.bytes, sha256: f.sha256,
    user: ownerName(f.owner_user_id), sender: f.sender, finding: f.finding, engine: f.engine, detail, state: f.state,
    createdAt: new Date(f.created_at).toISOString(), expiresAt: f.expires_at ? new Date(f.expires_at).toISOString() : null,
    resolvedAt: f.resolved_at ? new Date(f.resolved_at).toISOString() : null,
  };
}

function quarantine() { return db().prepare("SELECT * FROM scan_findings WHERE state = 'quarantined' ORDER BY created_at DESC").all().map(toApi); }

function history({ limit = 200 } = {}) {
  return db().prepare("SELECT * FROM scan_findings WHERE state <> 'quarantined' ORDER BY created_at DESC LIMIT ?").all(Math.min(500, limit)).map(toApi);
}

function audit(type, message, details, userId) {
  try { require('../activity').log(type, message, { source: 'admin', severity: 'info', details: { ...details, userId } }); } catch { /* best-effort */ }
}

/** "Erneut prüfen" of a finding. */
async function recheck(id) {
  const f = findingRow(id);
  if (!f.media_id || !freshRow(f.media_id)) throw new ScanError('gone', 'the file is gone', 410);
  await rescanOne(f.media_id);
  return toApi(findingRow(id));
}

/** "Löschen": the file goes, the finding stays in the history. */
function deleteFinding(id, userId = null) {
  const f = findingRow(id);
  const row = f.media_id ? freshRow(f.media_id) : null;
  if (row) media().remove(row.plugin, row.id);
  db().prepare("UPDATE scan_findings SET state = 'deleted', resolved_at = ?, resolved_by = ? WHERE id = ?").run(Date.now(), userId, f.id);
  audit('malware_deleted', `Quarantined file deleted: ${f.name || f.media_id}`, { finding: f.finding, sha256: f.sha256 }, userId);
  if (row) tellPlugin(row, 'deleted');
  return toApi(findingRow(id));
}

/** "Trotzdem freigeben": served again, the checksum becomes an exception, logged. */
function release(id, userId = null) {
  const f = findingRow(id);
  db().prepare('INSERT OR REPLACE INTO scan_exceptions (sha256, finding, name, created_at, created_by) VALUES (?, ?, ?, ?, ?)').run(f.sha256, f.finding, f.name, Date.now(), userId);
  const row = f.media_id ? freshRow(f.media_id) : null;
  if (row) setRow(row.id, { scan_state: 'clean', scan_blocked: 0, scan_finding: null, scan_engine: 'exception', scan_at: Date.now() });
  db().prepare("UPDATE scan_findings SET state = 'released', resolved_at = ?, resolved_by = ? WHERE id = ?").run(Date.now(), userId, f.id);
  try {
    require('../activity').log('malware_released', `Quarantined file released anyway: ${f.name || f.media_id} (${f.finding})`, {
      source: 'admin', severity: 'warning', details: { finding: f.finding, sha256: f.sha256, name: f.name, userId },
    });
  } catch { /* best-effort */ }
  if (row) tellPlugin(row, 'clean');
  return toApi(findingRow(id));
}

/** Quarantine older than 30 days: the files go. */
function expire(now = Date.now()) {
  const old = db().prepare("SELECT * FROM scan_findings WHERE state = 'quarantined' AND expires_at IS NOT NULL AND expires_at <= ?").all(now);
  for (const f of old) {
    const row = f.media_id ? freshRow(f.media_id) : null;
    if (row && row.scan_blocked) {
      try { media().remove(row.plugin, row.id); } catch { /* gone */ }
      tellPlugin(row, 'deleted'); // contract: "Quarantäne abgelaufen" → mediaScanned state 'deleted'
    }
    db().prepare("UPDATE scan_findings SET state = 'deleted', resolved_at = ? WHERE id = ?").run(now, f.id);
  }
  db().prepare('DELETE FROM scan_findings WHERE created_at < ? AND state <> \'quarantined\'').run(now - 365 * 86400e3);
  return old.length;
}

// ─── Scanner state and updates ─────────────────────────

function scanState() { try { return JSON.parse(settings.get(K_STATE, '{}')) || {}; } catch { return {}; } }
function setScanState(patch) { settings.set(K_STATE, JSON.stringify({ ...scanState(), ...patch })); }

/** Ask the scanner (version, signatures), the published versions. Never throws. */
async function scannerInfo(cfg = getConfig(), { latest = true } = {}) {
  const engine = engineOf(cfg);
  const out = { engine, configured: cfg.engine, licensed: licensed(), reachable: null, error: null, version: null, daily: null, dailyAt: null, latest: null, updateAvailable: false, signaturesOld: false };
  if (engine === 'none') return out;
  let addr;
  try { addr = scannerAddress(cfg); } catch (e) { out.reachable = false; out.error = e.code || 'address_invalid'; return out; }
  try {
    if (engine === 'icap') {
      const o = await icap.options(addr);
      out.reachable = true;
      out.version = o.service || null;
      out.istag = o.istag || null;
    } else {
      const v = await clamd.version(addr);
      out.reachable = true;
      Object.assign(out, { version: v.engine, daily: v.daily, dailyAt: v.dailyAt });
      if (latest) {
        out.latest = await clamd.latest();
        if (out.latest && v.engine && clamd.older(v.engine, out.latest.engine)) out.updateAvailable = true;
      }
      out.signaturesOld = !!(v.dailyAt && Date.now() - Date.parse(v.dailyAt) > STALE_DAYS * 86400e3);
    }
    noteUp();
  } catch (e) {
    out.reachable = false;
    out.error = e.code || 'unreachable';
  }
  _state.lastSig = { at: Date.now(), info: out };
  return out;
}

/** "Signaturen jetzt aktualisieren": clamd reloads what freshclam fetched; the malware list is fetched. */
async function refreshSignatures() {
  const cfg = getConfig();
  const out = { hashlist: await hashlist.refresh({ force: true }), reload: null };
  if (['clamav_local', 'clamav_net'].includes(engineOf(cfg))) {
    try { out.reload = (await clamd.reload(scannerAddress(cfg))) || 'RELOADING'; } catch (e) { out.reload = null; out.error = e.code || 'unreachable'; }
  }
  setScanState({ refreshed_at: Date.now() });
  return out;
}

/** Periodic: scanner state (every sig_check_h hours), stale warning once a day. */
async function signatureCheck() {
  const cfg = getConfig();
  const st = scanState();
  if (st.sig_checked_at && Date.now() - st.sig_checked_at < cfg.sig_check_h * 3600e3) return null;
  const info = await scannerInfo(cfg);
  setScanState({ sig_checked_at: Date.now() });
  // a newer daily published than the scanner has: let clamd pick up what freshclam fetched
  if (info.reachable && info.latest && info.daily && info.latest.daily > info.daily && ['clamav_local', 'clamav_net'].includes(info.engine)) {
    try { await clamd.reload(scannerAddress(cfg)); } catch { /* next time */ }
  }
  if (info.signaturesOld && (!st.stale_warned_at || Date.now() - st.stale_warned_at > 86400e3)) {
    setScanState({ stale_warned_at: Date.now() });
    activity('malware_signatures_old', `Virus signatures are older than ${STALE_DAYS} days`, { dailyAt: info.dailyAt, code: 'signatures_old' });
  }
  await hashlist.refresh().catch(() => {});
  return info;
}

/** EICAR through the same checks (nothing is stored). */
async function eicarTest() {
  const cfg = getConfig();
  const buf = Buffer.from(rules.EICAR);
  const read = async (s, e) => buf.subarray(s, e + 1);
  const g = await rules.check({ name: 'eicar.com', mime: 'application/octet-stream', size: buf.length, read, external: false, maxDepth: cfg.archive_depth });
  const out = { grundschutz: g.verdict === 'infected' ? g.finding : null, engine: engineOf(cfg), scanner: null, error: null };
  if (out.engine !== 'none') {
    try {
      const addr = scannerAddress(cfg);
      const r = out.engine === 'icap' ? await icap.scan(addr, [buf], { name: 'eicar.com', timeoutMs: 30000 }) : await clamd.scan(addr, [buf], { timeoutMs: 30000 });
      out.scanner = r.verdict === 'infected' ? r.finding : null;
      noteUp();
    } catch (e) { out.error = e.code || 'unreachable'; }
  }
  return out;
}

/** "Verbindung testen". */
async function testConnection(input) {
  const cfg = { ...getConfig(), ...(input && typeof input === 'object' ? input : {}) };
  if (cfg.engine === 'none') return { ok: true, engine: 'none' };
  if (!licensed()) throw Object.assign(new ScanError('license', 'a scanner needs the licence malware_scanning', 403, 'engine'), { feature: 'malware_scanning' });
  let addr;
  try {
    const raw = cfg.engine === 'clamav_local' ? (cfg.address || LOCAL_ADDRESS) : cfg.address;
    addr = cfg.engine === 'icap' ? { ...N.parseAddress(raw, { defaultPort: 1344, scheme: 'icap' }) } : N.parseAddress(raw, { defaultPort: 3310 });
    if (cfg.engine === 'icap' && !addr.service) addr.service = cfg.icap_service;
  } catch (e) { throw new ScanError(e.code || 'address_invalid', e.message, 400, 'address'); }
  try {
    if (cfg.engine === 'icap') return { ok: true, engine: 'icap', ...(await icap.options(addr)) };
    const v = await clamd.version(addr);
    return { ok: true, engine: 'clamav', version: v.engine, daily: v.daily, dailyAt: v.dailyAt };
  } catch (e) {
    return { ok: false, error: e.code || 'unreachable', message: String(e.message || '').slice(0, 200) };
  }
}

// ─── ClamAV on this server ─────────────────────────────

const CLAMAV_STATES = ['running', 'starting', 'failed', 'stopped'];
const CLAMAV_ERRORS = ['low_memory', 'start_failed'];
const CLAMAV_SCRIPT = 3; // update.sh marker that starts the container itself

/**
 * What the host did about "ClamAV auf diesem Server" (update.sh writes
 * .clamav-state.json on the /data volume, every 5 minutes while it is chosen).
 * → { state, error, checkedAt, script: { host, needed }, cron }
 */
function localStatus() {
  const au = require('../autoUpdate');
  const path = require('node:path');
  let file = null;
  try { file = JSON.parse(require('node:fs').readFileSync(path.join(au.DATA_DIR, '.clamav-state.json'), 'utf8')); } catch { file = null; }
  let cron = 'not_configured';
  let host = null;
  try { const st = au.getStatus(); cron = st.status; host = st.update_sh ? st.update_sh.host_version : null; } catch { /* unknown */ }
  const ok = file && typeof file === 'object';
  const checkedAt = ok && typeof file.checked_at === 'string' && !Number.isNaN(Date.parse(file.checked_at)) ? new Date(file.checked_at).toISOString() : null;
  return {
    state: ok && CLAMAV_STATES.includes(file.state) ? file.state : null,
    error: ok && CLAMAV_ERRORS.includes(file.error) ? file.error : null,
    checkedAt,
    script: { host, needed: CLAMAV_SCRIPT },
    cron,
  };
}

// ─── Page ──────────────────────────────────────────────

function stats(now = Date.now()) {
  const since = now - 30 * 86400e3;
  const checked = db().prepare("SELECT COUNT(*) AS n, SUM(CASE WHEN scan_source IN ('drive_link', 'gatedrop', 'mail', 'messenger') THEN 1 ELSE 0 END) AS ext FROM plugin_media WHERE scan_at >= ? AND scan_state IN ('clean', 'infected', 'unscannable')").get(since);
  const found = db().prepare("SELECT state, COUNT(*) AS n FROM scan_findings WHERE created_at >= ? AND state IN ('quarantined', 'marked', 'deleted', 'released') GROUP BY state").all(since);
  const unscannable = db().prepare("SELECT COUNT(*) AS n FROM scan_findings WHERE created_at >= ? AND state IN ('unscannable', 'blocked')").get(since).n;
  const by = Object.fromEntries(found.map((r) => [r.state, r.n]));
  return {
    checked30d: checked.n || 0, external30d: checked.ext || 0,
    found30d: (by.quarantined || 0) + (by.marked || 0) + (by.deleted || 0) + (by.released || 0),
    quarantined: db().prepare("SELECT COUNT(*) AS n FROM scan_findings WHERE state = 'quarantined'").get().n,
    deleted30d: by.deleted || 0, unscannable30d: unscannable,
    pending: db().prepare("SELECT COUNT(*) AS n FROM plugin_media WHERE scan_state = 'pending'").get().n,
  };
}

/** GET /api/v1/settings/scan */
async function view({ ask = true } = {}) {
  const cfg = getConfig();
  const info = ask ? await scannerInfo(cfg) : (_state.lastSig ? _state.lastSig.info : { engine: engineOf(cfg), reachable: null });
  const st = scanState();
  return {
    config: { ...cfg, abusech_key_set: hashlist.info().keySet },
    licensed: licensed(),
    scanner: info,
    down: _state.down ? { since: new Date(_state.down.since).toISOString(), error: _state.down.error } : null,
    hashlist: hashlist.info(),
    stats: stats(),
    quarantine: quarantine(),
    lastRescan: st.last_rescan ? new Date(st.last_rescan).toISOString() : null,
    refreshedAt: st.refreshed_at ? new Date(st.refreshed_at).toISOString() : null,
    localAddress: LOCAL_ADDRESS,
    local: cfg.engine === 'clamav_local' ? localStatus() : null,
  };
}

// ─── Lifecycle ─────────────────────────────────────────

function nightlyDue(now = new Date()) {
  const cfg = getConfig();
  if (cfg.rescan === 'off') return false;
  if (now.getHours() !== 3 || now.getMinutes() < 30) return false;
  if (cfg.rescan === 'weekly' && now.getDay() !== 0) return false;
  const last = scanState().last_rescan;
  return !last || now.getTime() - last > 20 * 3600e3;
}

function start() {
  if (_state.timers.length) return;
  // files a restart caught in the middle of their check are checked again
  // (retryPending below picks up every pending row)
  const every = (ms, fn) => { const t = setInterval(() => { Promise.resolve().then(fn).catch(() => {}); }, ms); if (t.unref) t.unref(); _state.timers.push(t); };
  every(RETRY_MS, retryPending);
  every(10 * 60e3, () => { if (nightlyDue()) return nightly(); return null; });
  every(15 * 60e3, signatureCheck);
  every(3600e3, () => expire());
  const t = setTimeout(() => { retryPending(); signatureCheck().catch(() => {}); expire(); }, 30e3);
  if (t.unref) t.unref();
}

function stop() {
  for (const t of _state.timers) clearInterval(t);
  _state.timers = [];
}

/** Backup: the checksums released by an administrator. */
function exportBackup() {
  try { return db().prepare('SELECT sha256, finding, name, created_at FROM scan_exceptions').all(); } catch { return []; }
}
function restoreBackup(list) {
  if (!Array.isArray(list)) return 0;
  let n = 0;
  for (const e of list) {
    if (!e || !/^[0-9a-f]{64}$/.test(String(e.sha256))) continue;
    db().prepare('INSERT OR REPLACE INTO scan_exceptions (sha256, finding, name, created_at, created_by) VALUES (?, ?, ?, ?, NULL)').run(e.sha256, e.finding || null, e.name || null, Number(e.created_at) || Date.now());
    n++;
  }
  return n;
}

function _resetForTest() {
  stop();
  _state.queue = [];
  _state.running = 0;
  _state.inflight.clear();
  _state.down = null;
  _state.lastSig = null;
}

module.exports = {
  SOURCES, ENGINES, ACTIONS, QUARANTINE_DAYS, BUDGET_MS, LOCAL_ADDRESS, ScanError,
  getConfig, setConfig, engineOf, sourceOf, isExternal,
  afterStore, check, gate, infoOf, rescanOne, retryPending, nightly, nightlyDue,
  quarantine, history, recheck, deleteFinding, release, expire,
  scannerInfo, localStatus, refreshSignatures, signatureCheck, eicarTest, testConnection, stats, view,
  start, stop, exportBackup, restoreBackup, hashOf: (b) => crypto.createHash('sha256').update(b).digest('hex'),
  _state, _resetForTest,
};
