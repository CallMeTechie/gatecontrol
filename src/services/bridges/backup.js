'use strict';

// The bridges' state in the GateControl backup (docs/feature-messenger-bridges.md, "Backup"), stage 5.
//
// What has to be kept: the homeserver's database (RocksDB), the bridge's database (SQLite with the WhatsApp session
// keys of every linked person), the master key in /data/bridges/secrets.json (all tokens and the seal of the inbox
// derive from it) and which room is whose chat (bridge_rooms).
//
//   consistent   a running RocksDB or SQLite file is never copied. This process has no Docker access, so update.sh
//                (marker 8) does it on the host when the server asks ("bridges_backup":"<id>" in the config file,
//                once a night at BACKUP_TIME in the time zone of the update window, or "Jetzt sichern"): it stops the
//                bridge and the homeserver, packs their data folders into backup/state-<id>.tar, starts them again
//                and reports in .bridges-backup.json. The messengers hold messages back in the meantime (the probe:
//                the homeserver needs about 4 s to open its database).
//   encrypted    the server takes that file at once (ingest): AES-256-GCM with a key of its own, the key itself
//                encrypted with GC_ENCRYPTION_KEY (utils/crypto — an off-site re-key converts it like every other
//                secret), the plain file deleted. Only the encrypted snapshot (backup/state.enc + state.json) stays,
//                and only it goes into a backup (data.bridges). The master key travels encrypted the same way.
//   restore      a backup with data.bridges puts the master key and the rooms back and leaves the snapshot for
//                update.sh decrypted as backup/restore-<id>.tar ("bridges_restore":"<id>"): it checks every name in
//                it, stops the containers, keeps the current data folders as *.prev, unpacks, starts. Rooms of a
//                person whose account got another id on the restore are left out (their chats start anew after a
//                new link) — the internal Matrix account is named after the id.
//
// Never in a log or an answer: the key, a token, a name of a person or a contact.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');
const settings = require('../settings');
const logger = require('../../utils/logger');

const ID_RE = /^[0-9a-f]{12}$/;
const HHMM_RE = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const BACKUP_TIME = '03:10';
const RESULTS = ['ok', 'failed', 'not_running', 'invalid'];
const VERSION = 1;
// a restore file the host did not take within a day is deleted again
const RESTORE_KEEP_MS = 86400000;

function bridges() { return require('./index'); }
function dataDir() { return require('../autoUpdate').DATA_DIR; }
function dir() { return path.join(bridges().dir(), 'backup'); }
const metaFile = () => path.join(dir(), 'state.json');
const encFile = () => path.join(dir(), 'state.enc');

function readJson(file) { try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return j && typeof j === 'object' ? j : null; } catch { return null; } }

function writeAtomic(file, text) {
  const tmp = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try { fs.writeFileSync(tmp, text, { mode: 0o600 }); fs.renameSync(tmp, file); }
  catch (err) { try { fs.unlinkSync(tmp); } catch { /* never written */ } throw err; }
}

// ─── schedule ──────────────────────────────────────────

function backupTime() { const t = settings.get('bridges.backup_time', BACKUP_TIME); return HHMM_RE.test(t) ? t : BACKUP_TIME; }
function setBackupTime(t) { if (!HHMM_RE.test(String(t || ''))) throw Object.assign(new Error('backupTime: HH:MM'), { code: 'ERR_INVALID' }); settings.set('bridges.backup_time', t); }

/** The time zone of the night (the update window's, Einstellungen › Updates). */
function timeZone() { try { return require('../autoUpdate').getWindow().tz; } catch { return 'Europe/Berlin'; } }

/** Local "YYYY-MM-DD" and minutes after midnight of `now` in `tz`. */
function localOf(now, tz) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const g = (t) => (parts.find((p) => p.type === t) || {}).value;
  return { day: `${g('year')}-${g('month')}-${g('day')}`, min: (Number(g('hour')) % 24) * 60 + Number(g('minute')) };
}

function requested() { const r = settings.get('bridges.backup_req', ''); return ID_RE.test(r) ? r : null; }
function restoreRequested() { const r = settings.get('bridges.restore_req', ''); return ID_RE.test(r) ? r : null; }

/** Ask update.sh for a snapshot now (the switch "Jetzt sichern", or the night). → the request id */
function request(reason = 'now') {
  const id = crypto.randomBytes(6).toString('hex');
  settings.set('bridges.backup_req', id);
  settings.set('bridges.backup_req_at', new Date().toISOString());
  settings.set('bridges.backup_req_reason', reason === 'night' ? 'night' : 'now');
  try { require('../autoUpdate').syncConfigFile(); } catch { /* written at the next change */ }
  return id;
}

/** What update.sh shall do about backups: { backup: id | null, restore: id | null } (the config file). */
function wish() { return { backup: requested(), restore: restoreRequested() }; }

/** Every few minutes while the bridges are wanted: take what update.sh left, ask for tonight's snapshot. Never throws. */
async function tick(now = new Date()) {
  try { await ingest(); } catch (err) { logger.warn({ err: err.message }, 'bridges backup: snapshot not taken over'); }
  try { ingestRestore(); } catch (err) { logger.warn({ err: err.message }, 'bridges backup: restore result not read'); }
  try {
    if (!bridges().wanted().length || requested()) return;
    const tz = timeZone();
    const here = localOf(now, tz);
    const [h, m] = backupTime().split(':').map(Number);
    if (here.min < h * 60 + m) return;
    // once per night: the last request (or the last snapshot) is from before today's time
    const last = settings.get('bridges.backup_night', '');
    if (last === here.day) return;
    settings.set('bridges.backup_night', here.day);
    request('night');
  } catch (err) { logger.warn({ err: err.message }, 'bridges backup: not asked for'); }
}

// ─── ingest: the plain snapshot of update.sh → encrypted ──

function sealKey() { return crypto.randomBytes(32); }

/** Encrypt `src` into `dst` (AES-256-GCM). → { iv, tag, bytes } */
async function encryptFile(src, dst, key) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  let bytes = 0;
  const count = new Transform({ transform(chunk, _e, cb) { bytes += chunk.length; cb(null, chunk); } });
  await pipeline(fs.createReadStream(src), count, c, fs.createWriteStream(dst, { flags: 'wx', mode: 0o600 }));
  return { iv: iv.toString('hex'), tag: c.getAuthTag().toString('hex'), bytes };
}

/** Decrypt a stream of an encrypted snapshot into `dst`; throws on a wrong key or a changed file (GCM tag). */
async function decryptInto(source, dst, key, iv, tag) {
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'hex'));
  d.setAuthTag(Buffer.from(tag, 'hex'));
  try { await pipeline(source, d, fs.createWriteStream(dst, { flags: 'wx', mode: 0o600 })); }
  catch (err) { await fsp.rm(dst, { force: true }); throw err; }
}

/** What update.sh reported last (.bridges-backup.json): { id, result, at, bytes } — known values only. */
function hostReport() {
  const j = readJson(path.join(dataDir(), '.bridges-backup.json'));
  if (!j || !ID_RE.test(String(j.id || ''))) return null;
  const n = Number(j.bytes);
  return {
    id: j.id, result: RESULTS.includes(j.result) ? j.result : 'failed',
    at: typeof j.at === 'string' && !Number.isNaN(Date.parse(j.at)) ? new Date(j.at).toISOString() : null,
    bytes: Number.isSafeInteger(n) && n >= 0 ? n : null,
  };
}

/** Take a snapshot update.sh left: encrypt it, forget the plain file. → true when one was taken */
async function ingest() {
  const rep = hostReport();
  const req = requested();
  if (!rep || !req || rep.id !== req) return false;
  const plain = path.join(dir(), `state-${rep.id}.tar`);
  if (rep.result !== 'ok') {
    settings.set('bridges.backup_error', rep.result);
    settings.set('bridges.backup_req', '');
    await fsp.rm(plain, { force: true });
    logger.warn({ result: rep.result }, 'bridges backup: the host made no snapshot');
    return false;
  }
  let st;
  try { st = fs.lstatSync(plain); } catch { return false; }
  if (!st.isFile()) { await fsp.rm(plain, { force: true }); return false; }
  const key = sealKey();
  const tmp = `${encFile()}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  let sealed;
  try { sealed = await encryptFile(plain, tmp, key); }
  catch (err) { await fsp.rm(tmp, { force: true }); throw err; }
  finally { await fsp.rm(plain, { force: true }); }
  const meta = {
    version: VERSION, id: rep.id, at: rep.at || new Date().toISOString(), bytes: sealed.bytes, iv: sealed.iv, tag: sealed.tag,
    key_enc: require('../../utils/crypto').encrypt(key.toString('hex')),
  };
  fs.renameSync(tmp, encFile());
  writeAtomic(metaFile(), JSON.stringify(meta) + '\n');
  settings.set('bridges.backup_req', '');
  settings.set('bridges.backup_error', '');
  logger.info({ bytes: sealed.bytes }, 'bridges backup: snapshot taken over, encrypted');
  return true;
}

/** The last encrypted snapshot: { id, at, bytes, iv, tag, key_enc } or null. */
function snapshot() {
  const m = readJson(metaFile());
  if (!m || m.version !== VERSION || !ID_RE.test(String(m.id || '')) || !/^[0-9a-f]{24}$/.test(String(m.iv || '')) || !/^[0-9a-f]{32}$/.test(String(m.tag || ''))
    || typeof m.key_enc !== 'string') return null;
  try { if (fs.statSync(encFile()).size !== m.bytes) return null; } catch { return null; }
  return m;
}

/** For the administration: { time, timeZone, lastAt, bytes, requested, error, restore } — no key, no name. */
function status() {
  const s = snapshot();
  const err = settings.get('bridges.backup_error', '');
  const rr = readJson(path.join(dataDir(), '.bridges-restore.json'));
  return {
    time: backupTime(), timeZone: timeZone(), lastAt: s ? s.at : null, bytes: s ? s.bytes : null,
    requested: !!requested(), error: RESULTS.includes(err) && err !== 'ok' ? err : null,
    restore: restoreRequested() ? { state: 'waiting' } : (rr && ID_RE.test(String(rr.id || '')) ? { state: rr.result === 'ok' ? 'done' : 'failed', at: typeof rr.at === 'string' ? rr.at : null } : null),
  };
}

// ─── the part of a GateControl backup ──────────────────

/**
 * data.bridges of a backup (async): the master key and the rooms always (once the bridges were ever on), the snapshot
 * when there is one — as a FileBase64Value of a hard link, so a snapshot taken over meanwhile does not mix in. The
 * object has a non-enumerable release() that removes the link. null when the bridges were never switched on.
 */
async function exportPart() {
  const b = bridges();
  const key = b.masterKey();
  if (!key) return null;
  const { encrypt } = require('../../utils/crypto');
  const db = require('../../db/connection').getDb();
  let rooms = [];
  try {
    rooms = db.prepare('SELECT r.room_id, r.ref, r.user_id, u.username AS user_name, r.network, r.kind, r.state, r.created_at, r.updated_at FROM bridge_rooms r JOIN users u ON u.id = r.user_id ORDER BY r.created_at').all();
  } catch (err) { logger.warn({ err: err.message }, 'bridges backup: rooms not exported'); }
  const part = { version: VERSION, created_at: new Date().toISOString(), master_key_enc: encrypt(key), rooms, snapshot: null };
  let link = null;
  const s = snapshot();
  if (s) {
    link = path.join(dir(), `export-${crypto.randomBytes(6).toString('hex')}.enc`);
    try {
      fs.linkSync(encFile(), link);
      const { FileBase64Value } = require('../../utils/jsonStream');
      part.snapshot = { id: s.id, at: s.at, bytes: s.bytes, iv: s.iv, tag: s.tag, key_enc: s.key_enc, data: new FileBase64Value(link, s.bytes) };
    } catch (err) { link = null; logger.warn({ err: err.message }, 'bridges backup: snapshot not in this backup'); }
  }
  Object.defineProperty(part, 'release', { enumerable: false, value: async () => { if (link) { const l = link; link = null; await fsp.rm(l, { force: true }); } } });
  return part;
}

const isB64 = (v) => typeof v === 'string' || (v && typeof v === 'object' && typeof v.decodedChunks === 'function');

/** Structure of data.bridges (absent = fine). */
function validate(part) {
  if (part === undefined || part === null) return [];
  if (typeof part !== 'object' || Array.isArray(part)) return ['Invalid backup: bridges must be an object'];
  const e = [];
  if (part.version !== VERSION) e.push('Invalid backup: bridges.version is unknown');
  if (typeof part.master_key_enc !== 'string') e.push('Invalid backup: bridges.master_key_enc missing');
  if (!Array.isArray(part.rooms) || part.rooms.length > 100000) e.push('Invalid backup: bridges.rooms must be a list');
  const s = part.snapshot;
  if (s != null && (typeof s !== 'object' || !ID_RE.test(String(s.id || '')) || !/^[0-9a-f]{24}$/.test(String(s.iv || '')) || !/^[0-9a-f]{32}$/.test(String(s.tag || ''))
    || typeof s.key_enc !== 'string' || !isB64(s.data))) e.push('Invalid backup: bridges.snapshot is damaged');
  return e;
}

/** The encrypted values of data.bridges, for backup.validateEncryptedFields: [[label, ciphertext]]. */
function encryptedFields(part) {
  if (!part || typeof part !== 'object') return [];
  const out = [];
  if (typeof part.master_key_enc === 'string') out.push(['bridges master key', part.master_key_enc]);
  if (part.snapshot && typeof part.snapshot.key_enc === 'string') out.push(['bridges snapshot key', part.snapshot.key_enc]);
  return out;
}

/**
 * Put data.bridges back (after the main restore: users first). → { state: 'none' | 'keys' | 'restoring', rooms, skipped }
 * @param {{ userIdByName: (name:string) => number|undefined }} o
 */
async function restorePart(part, { userIdByName } = {}) {
  if (!part || typeof part !== 'object') return { state: 'none', rooms: 0, skipped: 0 };
  const { decrypt } = require('../../utils/crypto');
  const b = bridges();
  const key = decrypt(part.master_key_enc);
  b.writeMasterKey(key);
  const db = require('../../db/connection').getDb();
  let rooms = 0;
  let skipped = 0;
  db.transaction(() => {
    for (const t of ['bridge_rooms', 'bridge_inbox', 'bridge_backlog', 'bridge_txns', 'bridge_media']) {
      try { db.prepare(`DELETE FROM ${t}`).run(); } catch { /* an older schema */ }
    }
    const ins = db.prepare('INSERT INTO bridge_rooms (room_id, ref, user_id, network, kind, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    for (const r of Array.isArray(part.rooms) ? part.rooms : []) {
      if (!r || typeof r.room_id !== 'string' || typeof r.ref !== 'string' || !Number.isSafeInteger(r.user_id)) { skipped++; continue; }
      const uid = userIdByName ? userIdByName(r.user_name) : r.user_id;
      // the internal account is @gc_<id>: a person with another id now cannot take the room along
      if (uid !== r.user_id) { skipped++; continue; }
      try { ins.run(r.room_id, r.ref, uid, String(r.network || ''), String(r.kind || 'direct'), String(r.state || 'joined'), Number(r.created_at) || Date.now(), Number(r.updated_at) || Date.now()); rooms++; }
      catch { skipped++; }
    }
  })();
  b._forget();
  const s = part.snapshot;
  if (!s || !isB64(s.data)) return { state: 'keys', rooms, skipped };
  fs.mkdirSync(dir(), { recursive: true, mode: 0o700 });
  const target = path.join(dir(), `restore-${s.id}.tar`);
  await fsp.rm(target, { force: true });
  const dataKey = Buffer.from(decrypt(s.key_enc), 'hex');
  const { Readable } = require('node:stream');
  const source = typeof s.data === 'string' ? Readable.from([Buffer.from(s.data, 'base64')]) : Readable.from(s.data.decodedChunks());
  await decryptInto(source, target, dataKey, s.iv, s.tag);
  settings.set('bridges.restore_req', s.id);
  settings.set('bridges.restore_req_at', new Date().toISOString());
  try { require('../autoUpdate').syncConfigFile(); } catch { /* written at the next change */ }
  logger.info({ rooms, skipped }, 'bridges backup: state restored here, the host puts the data folders back');
  return { state: 'restoring', rooms, skipped };
}

/** What update.sh did with a restore (.bridges-restore.json): the request ends, the plain file goes. */
function ingestRestore(now = Date.now()) {
  const id = restoreRequested();
  if (!id) return;
  const j = readJson(path.join(dataDir(), '.bridges-restore.json'));
  const file = path.join(dir(), `restore-${id}.tar`);
  const at = Date.parse(settings.get('bridges.restore_req_at', '')) || now;
  if ((j && j.id === id) || now - at > RESTORE_KEEP_MS) {
    settings.set('bridges.restore_req', '');
    try { fs.rmSync(file, { force: true }); } catch { /* gone */ }
    if (!(j && j.id === id)) logger.warn('bridges backup: the host did not restore the bridges within a day — given up');
  }
}

/** For the backup overview: { snapshot, at, bytes } of a backup's part. */
function summaryOf(part) {
  if (!part || typeof part !== 'object') return null;
  const s = part.snapshot;
  return { snapshot: !!(s && isB64(s.data)), at: s && typeof s.at === 'string' ? s.at : null, bytes: s && Number.isSafeInteger(s.bytes) ? s.bytes : null, rooms: Array.isArray(part.rooms) ? part.rooms.length : 0 };
}

module.exports = {
  ID_RE, BACKUP_TIME, backupTime, setBackupTime, timeZone, localOf, request, requested, wish, tick, ingest, ingestRestore,
  snapshot, status, exportPart, validate, encryptedFields, restorePart, summaryOf, encryptFile, decryptInto, dir,
};
