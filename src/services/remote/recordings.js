'use strict';

// Recordings of gc.remote sessions (stage 3 of the plugin "Fernzugriff", docs/plugins.md
// "Remote access", docs/feature-remote-access.md). Optional: only when the plugin asks for one
// (gc.remote.session({ record: true })), and only with the hint on the session page.
//
//   * The drive: config.remoteRecordings.dir (/recordings — the volume remote-recordings of
//     docker-compose.yml, mounted at the same path in this container and in guacd). Without it
//     available() says no_drive and nothing is recorded.
//   * SSH in the terminal of the core (term.js): asciicast v2 — the OUTPUT only (what the
//     terminal showed; keystrokes are not stored, a password the target asks for without echo
//     never appears), written here encrypted at once.
//   * RDP / VNC / SSH and Telnet over guacd: guacd's own recording (recording-path) into
//     <dir>/guac/<id>.guac; when the session ended the file is sealed in one sequential pass
//     (read once, written once, one file at a time) and the plain file goes. Nothing is
//     converted — the browser plays the .guac file itself (Guacamole.SessionRecording).
//     guacd only sees the drive once update.sh brought it up with the new compose file: it
//     writes $DATA/.remote-recordings-state.json ({ "guacd": true }).
//   * Encrypted like plugin media (services/plugins/media.js): a random key per file, wrapped
//     with a key derived from the server secret (HKDF), AES-256-GCM in 64 KiB chunks, each with
//     its own nonce (prefix ‖ index) and the chunk index plus a "last" flag as additional data.
//     Writes go out a whole chunk at a time — the slow disk of a small VPS sees few, large writes.
//   * Limits: all recordings together at most maxGb (GC_REMOTE_REC_MAX_GB, default 10 GB — a full
//     drive answers available: false, reason full, and stops a running terminal recording); each
//     recording is kept at most `days` (GC_REMOTE_REC_DAYS, default 30); the plugin may delete
//     earlier (gc.remote.recordings.remove).
//   * Playback: gc.remote.recordings.stream(id, { user }) → a single-use ticket of the session
//     page (/remote/session/<ref>, the same page and the same GC.openSession of the frame) for
//     exactly that person — the plugin decides who may watch (administrator or owner). Each
//     opened playback is logged (remote_recording_viewed) and reported to the plugin.
//
// No secret and no key ever lands in the metadata: rows hold ids, sizes, times and the
// wrapped file key.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { StringDecoder } = require('node:string_decoder');
const config = require('../../../config/default');
const logger = require('../../utils/logger');

class RecordingError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

const ID_RE = /^rr_[0-9a-f]{32}$/;
const MAGIC = Buffer.from('GCR1', 'latin1');
const PREFIX_LEN = 8;
const HEADER_LEN = MAGIC.length + PREFIX_LEN;
const CHUNK = 64 * 1024;
const TAG_LEN = 16;
const FORMATS = Object.freeze({ asciicast: { sub: 'cast', type: 'application/x-asciicast' }, guac: { sub: 'sealed', type: 'application/octet-stream' } });
const SWEEP_MS = 3600 * 1000;
const RAW_UNKNOWN_MS = 3600 * 1000;
const RAW_LEFT_MS = 24 * 3600 * 1000;
const SEAL_PAUSE_MS = 50;

function db() { return require('../../db/connection').getDb(); }
function cfg() { return config.remoteRecordings || { dir: '/recordings', maxGb: 10, days: 30 }; }
function root() { return path.resolve(String(cfg().dir || '/recordings')); }
function dataDir() { return process.env.GC_DATA_PATH || process.env.GC_DATA_DIR || '/data'; }
function maxBytes() { const g = Number(cfg().maxGb); return (Number.isFinite(g) && g > 0 ? g : 10) * 1024 * 1024 * 1024; }
function keepDays() { const d = Number(cfg().days); return Number.isInteger(d) && d >= 1 ? Math.min(d, 3650) : 30; }

function assertId(id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new RecordingError('invalid', 'invalid recording id');
  return id;
}

/** The sealed file of a recording — built from the checked id only, never from a stored path. */
function sealedPath(id, format) {
  const f = FORMATS[format] || FORMATS.asciicast;
  return path.join(root(), f.sub, assertId(id) + '.gcr');
}
/** guacd's plain file of a recording (until it is sealed). */
function rawGuacPath(id) { return path.join(root(), 'guac', assertId(id) + '.guac'); }
/** The folder guacd writes into (its recording-path). */
function guacDir() { return path.join(root(), 'guac'); }

// ─── Keys (like plugin media, another HKDF label) ───

let masterCache = null;
function masterKey() {
  const secret = String(config.app.secret);
  if (!masterCache || masterCache.secret !== secret) {
    masterCache = { secret, key: Buffer.from(crypto.hkdfSync('sha256', secret, 'gatecontrol', 'remote-recording-v1', 32)) };
  }
  return masterCache.key;
}

function wrapKey(key, id) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', masterKey(), iv);
  c.setAAD(Buffer.from('remote-recording-key:' + id));
  const ct = Buffer.concat([c.update(key), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}

function unwrapKey(enc, id) {
  const buf = Buffer.from(String(enc || ''), 'base64');
  if (buf.length !== 12 + TAG_LEN + 32) throw new RecordingError('corrupt', 'recording key');
  const d = crypto.createDecipheriv('aes-256-gcm', masterKey(), buf.subarray(0, 12));
  d.setAAD(Buffer.from('remote-recording-key:' + id));
  d.setAuthTag(buf.subarray(12, 12 + TAG_LEN));
  return Buffer.concat([d.update(buf.subarray(12 + TAG_LEN)), d.final()]);
}

function nonce(prefix, index) {
  const n = Buffer.alloc(12);
  prefix.copy(n, 0);
  n.writeUInt32BE(index, PREFIX_LEN);
  return n;
}
function aad(index, last) { return Buffer.from(`${index}:${last ? 1 : 0}`); }

function sealChunk(key, prefix, index, last, plain) {
  const c = crypto.createCipheriv('aes-256-gcm', key, nonce(prefix, index));
  c.setAAD(aad(index, last));
  return Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
}

function openChunk(key, prefix, index, last, sealed) {
  const d = crypto.createDecipheriv('aes-256-gcm', key, nonce(prefix, index));
  d.setAAD(aad(index, last));
  d.setAuthTag(sealed.subarray(sealed.length - TAG_LEN));
  return Buffer.concat([d.update(sealed.subarray(0, sealed.length - TAG_LEN)), d.final()]);
}

/**
 * Writes a sealed file chunk by chunk: a chunk is written once the NEXT byte arrives (so the
 * last one is known at close) — one full 64 KiB write at a time.
 */
class SealedWriter {
  constructor(file, key) {
    this.key = key;
    this.prefix = crypto.randomBytes(PREFIX_LEN);
    this.fd = fs.openSync(file, 'wx', 0o600);
    fs.writeSync(this.fd, Buffer.concat([MAGIC, this.prefix]));
    this.buf = [];
    this.len = 0;
    this.index = 0;
    this.plain = 0;
    this.sealed = HEADER_LEN;
    this.closed = false;
  }
  write(data) {
    if (this.closed || !data || !data.length) return;
    this.buf.push(data);
    this.len += data.length;
    this.plain += data.length;
    while (this.len > CHUNK) this.flushChunk(false);
  }
  take(n) {
    const all = Buffer.concat(this.buf, this.len);
    const out = all.subarray(0, n);
    const rest = all.subarray(n);
    this.buf = rest.length ? [Buffer.from(rest)] : [];
    this.len = rest.length;
    return out;
  }
  flushChunk(last) {
    const plain = this.take(Math.min(CHUNK, this.len));
    const sealed = sealChunk(this.key, this.prefix, this.index++, last, plain);
    fs.writeSync(this.fd, sealed);
    this.sealed += sealed.length;
  }
  close() {
    if (this.closed) return;
    try { this.flushChunk(true); } finally {
      this.closed = true;
      try { fs.closeSync(this.fd); } catch { /* closed */ }
    }
  }
}

/** The plaintext of a sealed file, chunk by chunk (a recording cut off by a restart: up to its last whole chunk). */
async function* plainChunks(file, key) {
  const fh = await fs.promises.open(file, 'r');
  try {
    const size = (await fh.stat()).size;
    const head = Buffer.alloc(HEADER_LEN);
    await fh.read(head, 0, HEADER_LEN, 0);
    if (!head.subarray(0, MAGIC.length).equals(MAGIC)) throw new RecordingError('corrupt', 'not a recording');
    const prefix = Buffer.from(head.subarray(MAGIC.length));
    let pos = HEADER_LEN;
    let index = 0;
    const step = CHUNK + TAG_LEN;
    while (pos < size) {
      const n = Math.min(step, size - pos);
      const buf = Buffer.alloc(n);
      await fh.read(buf, 0, n, pos);
      const last = pos + n >= size;
      let plain;
      try { plain = openChunk(key, prefix, index, last, buf); } catch (e) {
        // the file ends without its "last" chunk (the server stopped during the recording): keep what is whole
        if (!last) throw e;
        plain = openChunk(key, prefix, index, false, buf);
      }
      yield plain;
      pos += n;
      index++;
    }
  } finally { await fh.close(); }
}

// ─── The drive ───

function driveOk() {
  try {
    const st = fs.statSync(root());
    if (!st.isDirectory()) return false;
    fs.accessSync(root(), fs.constants.W_OK);
    return true;
  } catch { return false; }
}

/** guacd sees the drive (update.sh reports it after `docker compose up` with the new compose file). */
function guacdMounted() {
  try {
    const st = JSON.parse(fs.readFileSync(path.join(dataDir(), '.remote-recordings-state.json'), 'utf8'));
    return !!(st && st.guacd === true);
  } catch { return false; }
}

/** The folders of the drive; guac/ open for guacd (another user inside its container: write + enter, no listing). */
function prepare() {
  if (!driveOk()) return false;
  try {
    for (const sub of ['cast', 'sealed']) fs.mkdirSync(path.join(root(), sub), { recursive: true, mode: 0o700 });
    fs.mkdirSync(guacDir(), { recursive: true });
    fs.chmodSync(guacDir(), 0o733);
    return true;
  } catch (e) {
    logger.warn({ err: e.message }, 'remote recordings: drive not prepared');
    return false;
  }
}

function usedBytes() {
  try { return db().prepare('SELECT COALESCE(SUM(bytes), 0) AS b FROM remote_recordings').get().b; } catch { return 0; }
}

/**
 * gc.remote.recordings.available() → { available, reason, engines: { term, guac }, usedBytes, maxBytes, days }
 * reason: null | no_drive | full. engines.guac: guacd writes recordings too (RDP, VNC, Telnet, SSH over guacd).
 */
function available() {
  const drive = driveOk();
  const used = drive ? usedBytes() : 0;
  const max = maxBytes();
  const full = used >= max;
  const ok = drive && !full;
  return {
    available: ok, reason: !drive ? 'no_drive' : (full ? 'full' : null),
    engines: { term: ok, guac: ok && guacdMounted() },
    usedBytes: used, maxBytes: max, days: keepDays(),
  };
}

/** May a session of this engine be recorded now? → null | the reason */
function refusal(engine) {
  const a = available();
  if (!a.available) return a.reason;
  if (engine === 'guac' && !a.engines.guac) return 'guacd_no_drive';
  return null;
}

// ─── Recording ───

function newId() { return 'rr_' + crypto.randomBytes(16).toString('hex'); }

function insertRow(id, o, format, keyEnc) {
  db().prepare(`INSERT INTO remote_recordings (id, plugin_id, session_id, target_id, user_id, protocol, format, bytes, path, started_at, key_enc, status, plain_bytes)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, datetime('now'), ?, 'recording', 0)`)
    .run(id, o.pluginId, o.sessionId || null, o.targetId || null, o.userId || null, o.protocol || null, format,
      path.relative(root(), format === 'guac' ? rawGuacPath(id) : sealedPath(id, format)), keyEnc);
}

/**
 * The asciicast of a terminal session → { id, output(buf), resize(cols, rows), close() }.
 * Throws when the drive is missing or full. Header: version, size, start time and TERM only.
 */
function beginCast(o) {
  const why = refusal('term');
  if (why) throw new RecordingError('recording_unavailable', why);
  prepare();
  const id = newId();
  const key = crypto.randomBytes(32);
  const w = new SealedWriter(sealedPath(id, 'asciicast'), key);
  insertRow(id, o, 'asciicast', wrapKey(key, id));
  const t0 = process.hrtime.bigint();
  const started = Date.now();
  const budget = Math.max(0, maxBytes() - usedBytes());
  const dec = new StringDecoder('utf8');
  let stopped = false;
  const at = () => Math.round(Number(process.hrtime.bigint() - t0) / 1e6) / 1000;
  const line = (arr) => {
    if (stopped) return;
    w.write(Buffer.from(JSON.stringify(arr) + '\n', 'utf8'));
    if (w.sealed + w.len >= budget) { stopped = true; logger.warn({ recording: id }, 'remote recording stopped: the drive limit is reached'); }
  };
  w.write(Buffer.from(JSON.stringify({ version: 2, width: o.cols || 80, height: o.rows || 24, timestamp: Math.floor(started / 1000), env: { TERM: String(o.term || 'xterm-256color').slice(0, 40) } }) + '\n'));
  let done = false;
  return {
    id,
    output(buf) { const s = dec.write(buf); if (s) line([at(), 'o', s]); },
    resize(cols, rows) { line([at(), 'r', `${cols}x${rows}`]); },
    close() {
      if (done) return;
      done = true;
      const tail = dec.end();
      if (tail) line([at(), 'o', tail]);
      try { w.close(); } catch (e) { logger.warn({ err: e.message, recording: id }, 'remote recording not closed'); }
      const dur = Math.max(0, Math.round((Date.now() - started) / 1000));
      db().prepare("UPDATE remote_recordings SET status = 'ready', bytes = ?, plain_bytes = ?, ended_at = datetime('now'), duration_seconds = ? WHERE id = ?")
        .run(w.sealed, w.plain, dur, id);
    },
  };
}

/**
 * A guacd recording, planned when the token is minted → { id, settings } — the settings go into
 * the guacd connection (recording-path / -name; keystrokes are not recorded). The row comes with
 * the tunnel (startGuac); a token nobody used leaves nothing behind. Sealed by finishGuac.
 */
function planGuac() {
  const why = refusal('guac');
  if (why) throw new RecordingError('recording_unavailable', why);
  if (!prepare()) throw new RecordingError('recording_unavailable', 'no_drive');
  const id = newId();
  return {
    id,
    settings: { 'recording-path': guacDir(), 'recording-name': id + '.guac', 'create-recording-path': 'false', 'recording-include-keys': 'false' },
  };
}

/** The tunnel of a planned guacd recording opened: its row (status recording). */
function startGuac(id, o) {
  assertId(id);
  insertRow(id, o, 'guac', wrapKey(crypto.randomBytes(32), id));
}

function setSession(id, sessionId) {
  try { db().prepare('UPDATE remote_recordings SET session_id = COALESCE(session_id, ?) WHERE id = ?').run(sessionId, assertId(id)); } catch { /* gone */ }
}

const sealQueue = [];
let sealing = false;

/** The session of a guacd recording ended: seal its file (queued, one at a time). */
function finishGuac(id, { durationSeconds = null } = {}) {
  try {
    assertId(id);
    db().prepare("UPDATE remote_recordings SET status = 'sealing', ended_at = COALESCE(ended_at, datetime('now')), duration_seconds = COALESCE(?, duration_seconds) WHERE id = ? AND status = 'recording'")
      .run(Number.isInteger(durationSeconds) ? durationSeconds : null, id);
  } catch { return; }
  if (!sealQueue.includes(id)) sealQueue.push(id);
  runQueue();
}

function runQueue() {
  if (sealing) return;
  const id = sealQueue.shift();
  if (!id) return;
  sealing = true;
  sealOne(id).catch((e) => {
    logger.warn({ err: e.message, recording: id }, 'remote recording not sealed');
    try { db().prepare("UPDATE remote_recordings SET status = 'failed' WHERE id = ?").run(id); } catch { /* db closed */ }
  }).finally(() => {
    sealing = false;
    const t = setTimeout(runQueue, SEAL_PAUSE_MS);
    if (t.unref) t.unref();
  });
}

async function sealOne(id) {
  const row = db().prepare('SELECT * FROM remote_recordings WHERE id = ?').get(id);
  if (!row || row.format !== 'guac') return;
  const raw = rawGuacPath(id);
  let st;
  try { st = await fs.promises.stat(raw); } catch {
    db().prepare("UPDATE remote_recordings SET status = 'failed' WHERE id = ?").run(id);
    return;
  }
  const key = unwrapKey(row.key_enc, id);
  const out = sealedPath(id, 'guac');
  fs.mkdirSync(path.dirname(out), { recursive: true, mode: 0o700 });
  try { fs.unlinkSync(out); } catch { /* none */ }
  const w = new SealedWriter(out, key);
  const fh = await fs.promises.open(raw, 'r');
  try {
    const buf = Buffer.alloc(CHUNK);
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, CHUNK, null);
      if (!bytesRead) break;
      w.write(Buffer.from(buf.subarray(0, bytesRead)));
    }
    w.close();
  } catch (e) {
    try { w.close(); } catch { /* closed */ }
    try { fs.unlinkSync(out); } catch { /* gone */ }
    throw e;
  } finally { await fh.close(); }
  await fs.promises.unlink(raw).catch(() => {});
  db().prepare("UPDATE remote_recordings SET status = 'ready', bytes = ?, plain_bytes = ?, path = ? WHERE id = ?")
    .run(w.sealed, st.size, path.relative(root(), out), id);
}

// ─── The host API ───

function iso(v) {
  if (!v) return null;
  const s = String(v);
  const ms = Date.parse(/^\d{4}-\d{2}-\d{2} /.test(s) ? s.replace(' ', 'T') + 'Z' : s);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function view(r) {
  return {
    id: r.id, sessionId: r.session_id, targetId: r.target_id, userId: r.user_id, protocol: r.protocol, format: r.format,
    status: r.status || 'ready', bytes: r.bytes, durationSeconds: r.duration_seconds == null ? null : r.duration_seconds,
    startedAt: iso(r.started_at), endedAt: iso(r.ended_at), createdAt: iso(r.created_at),
  };
}

/** gc.remote.recordings.list({ targetId?, sessionId?, userId?, limit? }) → [recording] (newest first) */
function list(plugin, a) {
  const o = a && typeof a === 'object' ? a : {};
  const where = ['plugin_id = ?'];
  const params = [plugin.id];
  if (o.targetId != null) { where.push('target_id = ?'); params.push(String(o.targetId)); }
  if (o.sessionId != null) { where.push('session_id = ?'); params.push(Number(o.sessionId)); }
  if (o.userId != null) { where.push('user_id = ?'); params.push(Number(o.userId)); }
  const limit = Math.max(1, Math.min(500, Number(o.limit) || 100));
  return db().prepare(`SELECT * FROM remote_recordings WHERE ${where.join(' AND ')} ORDER BY created_at DESC, rowid DESC LIMIT ${limit}`).all(...params).map(view);
}

function rowOf(plugin, id) {
  assertId(id);
  return db().prepare('SELECT * FROM remote_recordings WHERE id = ? AND plugin_id = ?').get(id, plugin.id) || null;
}

/**
 * gc.remote.recordings.stream(id, { user }) → { ref, url, expiresAt, format } — a single-use ticket
 * (60 s) of the session page for this person; the page plays the recording. The plugin decides
 * who may watch (administrator or owner).
 */
function stream(plugin, id, a) {
  const r = rowOf(plugin, id);
  if (!r) throw new RecordingError('not_found', 'no such recording of this plugin');
  if (r.status !== 'ready') throw new RecordingError('recording_unavailable', r.status === 'failed' ? 'failed' : 'not_ready');
  const o = a && typeof a === 'object' ? a : {};
  return require('./sessions').createPlayback(plugin, { user: o.user, recording: view(r) });
}

function unlinkFiles(r) {
  const files = [sealedPath(r.id, r.format === 'guac' ? 'guac' : 'asciicast')];
  if (r.format === 'guac') files.push(rawGuacPath(r.id));
  for (const f of files) { try { fs.unlinkSync(f); } catch { /* gone */ } }
}

function drop(r, reason, pluginId) {
  unlinkFiles(r);
  db().prepare('DELETE FROM remote_recordings WHERE id = ?').run(r.id);
  try {
    require('../activity').log('remote_recording_deleted', `Remote recording deleted (${reason}) of plugin "${pluginId || r.plugin_id}"`, {
      source: 'plugin', severity: 'info', details: { plugin: pluginId || r.plugin_id, recording: r.id, targetId: r.target_id, reason },
    });
  } catch { /* best-effort */ }
}

/** gc.remote.recordings.remove(id) → { removed } — the file goes with the row. */
function remove(plugin, id) {
  const r = rowOf(plugin, id);
  if (!r) return { removed: false };
  if (r.status === 'recording' || r.status === 'sealing') throw new RecordingError('busy', 'the recording is still being written');
  drop(r, 'plugin', plugin.id);
  return { removed: true };
}

/** The core only: the decrypted content of a ready recording → { type, size, format, chunks() } | null */
function content(pluginId, id) {
  assertId(id);
  const r = db().prepare("SELECT * FROM remote_recordings WHERE id = ? AND plugin_id = ? AND status = 'ready'").get(id, pluginId);
  if (!r) return null;
  const file = sealedPath(r.id, r.format === 'guac' ? 'guac' : 'asciicast');
  const key = unwrapKey(r.key_enc, r.id);
  return { type: (FORMATS[r.format] || FORMATS.asciicast).type, size: r.plain_bytes || null, format: r.format, chunks: () => plainChunks(file, key) };
}

/** "Alles löschen" of a plugin: rows and files. */
function forget(pluginId) {
  let rows = [];
  try { rows = db().prepare('SELECT id, format FROM remote_recordings WHERE plugin_id = ?').all(pluginId); } catch { return; }
  for (const r of rows) unlinkFiles(r);
  try { db().prepare('DELETE FROM remote_recordings WHERE plugin_id = ?').run(pluginId); } catch { /* table missing */ }
}

/** Hourly: recordings older than `days` go; plain guacd files nobody knows (or left behind) go. */
function sweep(now = Date.now()) {
  let n = 0;
  const cutoff = new Date(now - keepDays() * 86400000).toISOString().slice(0, 19).replace('T', ' ');
  try {
    for (const r of db().prepare("SELECT * FROM remote_recordings WHERE created_at < ? AND status IN ('ready', 'failed')").all(cutoff)) { drop(r, 'retention'); n++; }
  } catch { return n; }
  let files = [];
  try { files = fs.readdirSync(guacDir()); } catch { return n; }
  for (const f of files) {
    const m = /^(rr_[0-9a-f]{32})\.guac$/.exec(f);
    const p = path.join(guacDir(), path.basename(f));
    let st;
    try { st = fs.lstatSync(p); } catch { continue; }
    if (!st.isFile()) continue;
    const known = m ? db().prepare('SELECT status FROM remote_recordings WHERE id = ?').get(m[1]) : null;
    const age = now - st.mtimeMs;
    const busy = known && (known.status === 'recording' || known.status === 'sealing');
    if ((!known && age > RAW_UNKNOWN_MS) || (known && !busy && age > RAW_LEFT_MS)) {
      try { fs.unlinkSync(p); } catch { /* gone */ }
    }
  }
  return n;
}

/** Server start: recordings of the last run end — a terminal file keeps its whole chunks, a guacd file is sealed. */
function recover() {
  let rows = [];
  try { rows = db().prepare("SELECT id, format FROM remote_recordings WHERE status IN ('recording', 'sealing')").all(); } catch { return; }
  for (const r of rows) {
    if (r.format === 'guac') {
      db().prepare("UPDATE remote_recordings SET status = 'recording' WHERE id = ?").run(r.id);
      finishGuac(r.id);
      continue;
    }
    let size = 0;
    try { size = fs.statSync(sealedPath(r.id, 'asciicast')).size; } catch { size = 0; }
    db().prepare("UPDATE remote_recordings SET status = ?, bytes = ?, ended_at = COALESCE(ended_at, datetime('now')) WHERE id = ?")
      .run(size > HEADER_LEN ? 'ready' : 'failed', size, r.id);
  }
}

let sweepTimer = null;
/** Server start (server.js): the folders, the recordings of the last run, the hourly retention. */
function startTimers() {
  if (sweepTimer) return;
  try { prepare(); recover(); } catch (e) { logger.debug({ err: e.message }, 'remote recordings: recovery skipped'); }
  sweepTimer = setInterval(() => { try { sweep(); } catch { /* db closed */ } }, SWEEP_MS);
  if (sweepTimer.unref) sweepTimer.unref();
}

function _idleForTest() {
  return new Promise((resolve) => {
    const t = setInterval(() => { if (!sealing && !sealQueue.length) { clearInterval(t); resolve(); } }, 10);
  });
}

module.exports = {
  available, refusal, list, stream, remove, forget, content, beginCast, planGuac, startGuac, finishGuac, setSession, sweep, recover, prepare, startTimers,
  guacDir, rawGuacPath, sealedPath, view, RecordingError, ID_RE, CHUNK, _idleForTest,
};
