'use strict';

// Off-site backups (docs/feature-release-b.md §7; license `scheduled_backups`).
//
// After every automatic backup (services/autobackup.runBackup) the JSON backup
// is encrypted once into a GCBK1 archive (gcbk.js) and uploaded to every
// enabled target as gatecontrol-YYYYMMDD-HHmmss.gcbk. Per target the newest
// `keep` archives stay; retention only ever deletes files matching that name
// pattern (never foreign files). Results land in backup_targets.last_* and
// on the SSE channel as `backup` {target_id, status: running|ok|failed}.
//
// Secrets: the per-type config (passwords, S3 secret) is stored as ONE
// ciphertext in backup_targets.config_enc (utils/crypto, GC_ENCRYPTION_KEY);
// API answers carry has_password / has_secret_access_key instead. The
// passphrase (backup.offsite.passphrase_enc) is write-only. Nothing secret is
// ever logged or put into last_error.

const fs = require('node:fs');
const path = require('node:path');
const { getDb } = require('../../db/connection');
const { encrypt, decrypt } = require('../../utils/crypto');
const settings = require('../settings');
const logger = require('../../utils/logger');
const eventBus = require('../eventBus');
const gcbk = require('./gcbk');
const sshKey = require('./sshKey');

const TYPES = ['sftp', 'smb', 's3', 'webdav'];
const TRANSPORTS = {
  sftp: () => require('./sftp'),
  smb: () => require('./smb'),
  s3: () => require('./s3'),
  webdav: () => require('./webdav'),
};
const SECRET_FIELDS = { sftp: [], smb: ['password'], s3: ['secret_access_key'], webdav: ['password'] };
const REMOTE_NAME_RE = /^gatecontrol-\d{8}-\d{6}\.gcbk$/;
const LOCAL_NAME_RE = /^gatecontrol-(\d{8}-\d{6})\.json$/;
const MAX_TARGETS = 10;

const K_PASS = 'backup.offsite.passphrase_enc';
const K_INCLUDE_KEY = 'backup.offsite.include_key';
const K_SSH_PRIV = 'backup.offsite.ssh_private_enc';
const K_SSH_PUB = 'backup.offsite.ssh_public';

class OffsiteError extends Error {
  // `field` names the offending config field of an INVALID_CONFIG error as a
  // stable identifier; the browser must not dig it out of the English message
  // (docs/feature-wave2.md §W1.3).
  constructor(code, message, status = 400, field = null) {
    super(message);
    this.code = code;
    this.status = status;
    if (field) this.field = field;
  }
}

// ── Settings: passphrase + include_key ─────────────────────────────────────

function getOffsiteSettings() {
  return {
    passphrase_set: !!settings.get(K_PASS, ''),
    include_key: settings.get(K_INCLUDE_KEY, 'true') !== 'false',
  };
}

function updateOffsiteSettings({ passphrase, include_key: includeKey } = {}) {
  if (passphrase !== undefined && passphrase !== null && passphrase !== '') {
    if (typeof passphrase !== 'string' || passphrase.length < gcbk.MIN_PASSPHRASE || passphrase.length > 1024) {
      throw new OffsiteError('PASSPHRASE_TOO_SHORT', `passphrase must have ${gcbk.MIN_PASSPHRASE}-1024 characters`);
    }
  }
  if (includeKey !== undefined && typeof includeKey !== 'boolean') {
    throw new OffsiteError('INVALID_INCLUDE_KEY', 'include_key must be a boolean');
  }
  if (typeof passphrase === 'string' && passphrase !== '') settings.set(K_PASS, encrypt(passphrase));
  if (includeKey !== undefined) settings.set(K_INCLUDE_KEY, includeKey ? 'true' : 'false');
  return getOffsiteSettings();
}

function getPassphrase() {
  const enc = settings.get(K_PASS, '');
  if (!enc) return null;
  try { return decrypt(enc); } catch { return null; }
}

// ── SSH key ─────────────────────────────────────────────────────────────────

function ensureSshKey() {
  let pub = settings.get(K_SSH_PUB, '');
  if (pub && settings.get(K_SSH_PRIV, '')) return pub;
  const k = sshKey.generate();
  settings.set(K_SSH_PRIV, encrypt(k.privateKey));
  settings.set(K_SSH_PUB, k.publicKey);
  pub = k.publicKey;
  logger.info('Off-site backup SSH key generated');
  return pub;
}

function rotateSshKey() {
  const k = sshKey.generate();
  settings.set(K_SSH_PRIV, encrypt(k.privateKey));
  settings.set(K_SSH_PUB, k.publicKey);
  logger.info('Off-site backup SSH key rotated');
  return k.publicKey;
}

function sshContext() {
  ensureSshKey();
  try { return { privateKey: decrypt(settings.get(K_SSH_PRIV, '')) }; } catch { return { privateKey: null }; }
}

// ── Validation ─────────────────────────────────────────────────────────────

const HOST_RE = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const IPV6_RE = /^[0-9A-Fa-f:.]+$/;
const USER_RE = /^[A-Za-z0-9._\\@+-]{1,128}$/;
const PATH_RE = /^[A-Za-z0-9._~@+=,()\/ -]{0,255}$/;
const SHARE_RE = /^[A-Za-z0-9._$ -]{1,80}$/;
const DOMAIN_RE = /^[A-Za-z0-9._-]{1,64}$/;

// `error` keeps the English "field: message" wording for API users; `field`
// carries the same field name as a code the user interface can translate.
function bad(field, msg) { return new OffsiteError('INVALID_CONFIG', `${field}: ${msg}`, 400, field); }

function str(v) { return typeof v === 'string' ? v.trim() : v; }

function checkHost(v) {
  if (typeof v !== 'string' || !v || v.length > 253 || v.startsWith('-')) throw bad('host', 'required');
  if (!(HOST_RE.test(v) || (v.includes(':') && IPV6_RE.test(v)))) throw bad('host', 'must be a host name or IP address');
  return v;
}
function checkPort(v, dflt) {
  if (v === undefined || v === null || v === '') return dflt;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw bad('port', 'must be 1-65535');
  return n;
}
function checkPath(v, field = 'path') {
  const p = v === undefined || v === null ? '' : String(v).trim();
  if (!PATH_RE.test(p)) throw bad(field, 'allowed: letters, digits, space and . _ ~ @ + = , ( ) / -');
  if (p.split('/').some((s) => s === '..')) throw bad(field, '".." is not allowed');
  return p;
}
function checkUser(v, required) {
  const u = v === undefined || v === null ? '' : String(v).trim();
  if (!u) { if (required) throw bad('username', 'required'); return ''; }
  if (!USER_RE.test(u) || u.startsWith('-')) throw bad('username', 'contains unsupported characters');
  return u;
}
function checkSecret(v, field) {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string' || v.length > 1024 || /[\r\n\0]/.test(v)) throw bad(field, 'invalid');
  return v;
}
function checkEncrypt(v, dflt) {
  if (v === undefined || v === null) return dflt;
  if (typeof v !== 'boolean') throw bad('encrypt', 'must be true or false');
  return v;
}
function checkUrl(v, field) {
  let u;
  try { u = new URL(String(v || '').trim()); } catch { throw bad(field, 'must be an http(s) URL'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw bad(field, 'must be an http(s) URL');
  if (u.username || u.password) throw bad(field, 'must not contain credentials — use the username/password fields');
  return u.toString();
}

// ── "Verbindung" (via) and the trust anchor — the storage targets' rules ──
// storageTargets/via.js validates and resolves `via` for both features; its
// `invalid` errors become INVALID_CONFIG here, the field name as it is
// ('via', 'routeId', 'port'; tlsCa → tls_ca).

function storageRule(fn) {
  try { return fn(); } catch (e) {
    if (e && e.code === 'invalid') {
      const field = e.field === 'tlsCa' ? 'tls_ca' : (e.field || 'via');
      const raw = String(e.message || '');
      const msg = (raw.startsWith(`${e.field}: `) ? raw.slice(String(e.field).length + 2) : raw) || 'invalid';
      throw bad(field, msg);
    }
    throw e;
  }
}

/** SMB / SFTP: { kind: 'host' } or a peer (its port: via.port, else `port`) / an L4 TCP route. */
function tcpViaOf(c, dflt) {
  const v = c.via && typeof c.via === 'object' ? c.via : null;
  return storageRule(() => require('../storageTargets/via').tcpVia(v, c.port, dflt, { tcpOnly: true })) || { kind: 'host' };
}

/** The host field: required when connecting to it, optional (a name for the share / logs) through a peer or route. */
function hostFor(c, v) {
  if (v.kind === 'host' || (c.host !== undefined && c.host !== null && String(c.host).trim() !== '')) return checkHost(str(c.host));
  return '';
}

/**
 * The password of a storage target the administrator picked in the form
 * ("Speicherziel übernehmen", `password_from_storage_target`: its id) —
 * copied once into this target, never linked. → undefined when none picked.
 */
function storagePassword(c, type) {
  const id = c.password_from_storage_target;
  if (id === undefined || id === null || id === '') return undefined;
  const st = require('../storageTargets');
  const row = st.rowOf(id);
  if (!row || row.kind !== type) throw bad('password_from_storage_target', `no such ${type} storage target`);
  const sec = st.secretOf(row);
  if (row.secret_enc && !Object.keys(sec).length) throw bad('password_from_storage_target', 'its password cannot be decrypted — enter it here');
  return sec.password || '';
}

/**
 * The server a WebDAV / S3 target talks TLS with (host and port, how it is
 * reached): while it stays, so does `tls_seen` (storageTargets/trust.js).
 */
function tlsPlace(type, cfg) {
  try {
    if (type === 'webdav') return JSON.stringify([new URL(cfg.url).host, cfg.via || { kind: 'host' }]);
    if (type === 's3') return JSON.stringify([require('./s3').objectUrl(cfg, '').host, cfg.via || { kind: 'host' }]);
  } catch { /* no URL */ }
  return null;
}

/**
 * `tls_seen` of a WebDAV / S3 config: reached with a trusted certificate
 * before (trust.js — then a certificate is never remembered on its own).
 * Kept while the server stays; false once it changes, and for a new target.
 */
function keepSeen(type, cfg, prev) {
  if (!prev || !Object.keys(prev).length) return false;
  if (tlsPlace(type, cfg) !== tlsPlace(type, prev)) return false;
  return prev.tls_seen; // undefined for a target from before: its last run decides (seenOf)
}

/**
 * Normalise a config for `type`. `prev` = stored config (secrets kept when the
 * input omits them or sends '').
 */
function normalizeConfig(type, input, prev = {}) {
  const c = input && typeof input === 'object' ? input : {};
  const isNew = !prev || !Object.keys(prev).length;
  const keep = (field) => {
    const v = checkSecret(c[field], field);
    if (v === undefined || v === '') {
      const fromStorage = field === 'password' ? storagePassword(c, type) : undefined;
      return fromStorage !== undefined ? fromStorage : (prev[field] || '');
    }
    return v;
  };
  switch (type) {
    case 'sftp': {
      const via = tcpViaOf(c, 22);
      return {
        host: hostFor(c, via),
        port: checkPort(c.port, 22),
        via,
        username: checkUser(c.username, true),
        path: checkPath(c.path),
      };
    }
    case 'smb': {
      const share = String(c.share || '').trim();
      if (!SHARE_RE.test(share)) throw bad('share', 'required (letters, digits, space and . _ $ -)');
      const domain = c.domain === undefined || c.domain === null ? '' : String(c.domain).trim();
      if (domain && !DOMAIN_RE.test(domain)) throw bad('domain', 'invalid');
      const via = tcpViaOf(c, 445);
      const cfg = {
        host: hostFor(c, via),
        port: checkPort(c.port, 445),
        via,
        share,
        path: checkPath(c.path),
        username: checkUser(c.username, false),
        password: c.clear_password === true ? '' : keep('password'),
        domain,
        // SMB3 encryption: on for new targets; a target from before keeps its behaviour until it is changed
        encrypt: checkEncrypt(c.encrypt, isNew ? true : prev.encrypt === true),
      };
      if (/[;"]/.test(cfg.path)) throw bad('path', 'invalid');
      return cfg;
    }
    case 's3': {
      const endpoint = c.endpoint ? checkUrl(c.endpoint, 'endpoint').replace(/\/+$/, '') : '';
      const region = String(c.region || 'us-east-1').trim();
      if (!/^[a-z0-9-]{1,32}$/.test(region)) throw bad('region', 'invalid');
      const bucket = String(c.bucket || '').trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,62}$/.test(bucket)) throw bad('bucket', 'invalid bucket name');
      const prefix = checkPath(c.prefix, 'prefix').replace(/^\/+/, '');
      const akid = String(c.access_key_id || '').trim();
      if (!/^[A-Za-z0-9+/=._-]{3,128}$/.test(akid)) throw bad('access_key_id', 'required');
      const cfg = {
        endpoint, region, bucket, prefix, access_key_id: akid,
        secret_access_key: keep('secret_access_key'),
        path_style: c.path_style === undefined ? !!prev.path_style : c.path_style === true,
      };
      if (!cfg.secret_access_key) throw bad('secret_access_key', 'required');
      // "Verbindung" as for WebDAV: the endpoint still names the server (Host, SNI, certificate)
      const v = c.via && typeof c.via === 'object' ? c.via : null;
      cfg.via = storageRule(() => require('../storageTargets/via').webdavVia(v, undefined, require('./s3').objectUrl(cfg, '')));
      if (cfg.via.kind !== 'host' && !endpoint) throw bad('endpoint', 'required with a connection through a VPN device or a route');
      cfg.tls_ca = storageRule(() => require('../storageTargets').tlsCa(c.tls_ca));
      cfg.tls_seen = keepSeen('s3', cfg, prev);
      return cfg;
    }
    case 'webdav': {
      const url = checkUrl(c.url, 'url');
      const v = c.via && typeof c.via === 'object' ? c.via : null;
      const cfg = {
        url,
        // the URL still names the NAS (scheme, path, Host, SNI, certificate name); `via` only says where to connect
        via: storageRule(() => require('../storageTargets/via').webdavVia(v, undefined, new URL(url))),
        username: checkUser(c.username, false),
        password: c.clear_password === true ? '' : keep('password'),
        tls_ca: storageRule(() => require('../storageTargets').tlsCa(c.tls_ca)),
      };
      cfg.tls_seen = keepSeen('webdav', cfg, prev);
      return cfg;
    }
    default:
      throw new OffsiteError('INVALID_TYPE', `type must be one of ${TYPES.join(', ')}`);
  }
}

/** Config for API answers: secrets replaced by has_* flags. */
function publicConfig(type, cfg) {
  const out = { ...cfg };
  for (const f of SECRET_FIELDS[type] || []) {
    delete out[f];
    out[`has_${f}`] = !!cfg[f];
  }
  if (cfg.tls_ca) out.tls_ca_info = require('../storageTargets').caInfo(cfg.tls_ca);
  delete out.tls_seen; // internal (storageTargets/trust.js)
  return out;
}

// ── Target rows ────────────────────────────────────────────────────────────

function readConfig(row) {
  try { return JSON.parse(decrypt(row.config_enc)); } catch { return null; }
}

function toApi(row) {
  const cfg = readConfig(row);
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    enabled: row.enabled === 1,
    keep: row.keep,
    config: cfg ? publicConfig(row.type, cfg) : null,
    config_error: cfg ? undefined : 'cannot decrypt — the target was saved under another GC_ENCRYPTION_KEY; enter the credentials again',
    last_run_at: row.last_run_at,
    last_status: row.last_status,
    last_error: row.last_error,
    // the English text of transport errors carries the hint; the page shows its own words for it
    last_error_hint: errorHint(row.last_error),
    last_verify_at: row.last_verify_at || null,
    last_verify_status: row.last_verify_status || null,
    last_verify: parseVerifyDetail(row.last_verify_detail),
    created_at: row.created_at,
  };
}

/** The hint of a stored English error text (the page has its own words per hint), or null. */
function errorHint(text) {
  if (!text) return null;
  const trust = require('../storageTargets/trust');
  if (text.includes(require('../storageTargets/via').SELF_HINT_TEXT)) return 'self_address';
  if (text.includes(trust.CHANGED_TEXT)) return 'cert_changed';
  if (text.includes(trust.UNTRUSTED_TEXT)) return 'cert_untrusted';
  if (text.includes(trust.NAME_TEXT)) return 'cert_name';
  if (text.includes(require('./smb').NO_ENCRYPTION_TEXT)) return 'smb_no_encryption';
  return null;
}

function parseVerifyDetail(raw) {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch { return null; }
}

function getRow(id) {
  return getDb().prepare('SELECT * FROM backup_targets WHERE id = ?').get(Number(id));
}

function listTargets() {
  return getDb().prepare('SELECT * FROM backup_targets ORDER BY id').all().map(toApi).map(withIncomplete);
}

// ── Incomplete backups (a plugin part left out, services/plugins/backup.js) ─
// The archive of an upload is the local backup file: its plugins_incomplete
// is noted per target (setting K_INCOMPLETE, { "<id>": { file, plugins } })
// and shown in the target list as `last_incomplete` (null: complete).
const K_INCOMPLETE = 'backup.offsite.incomplete';

function incompleteMap() {
  try { const m = JSON.parse(settings.get(K_INCOMPLETE, '{}') || '{}'); return m && typeof m === 'object' && !Array.isArray(m) ? m : {}; } catch { return {}; }
}

async function noteIncomplete(id, localFile) {
  let list = null;
  try { list = await require('../backup').readIncomplete(localFile); } catch { list = null; }
  const m = incompleteMap();
  if (list && list.length) m[String(id)] = { file: remoteNameFor(localFile), plugins: list };
  else delete m[String(id)];
  try { settings.set(K_INCOMPLETE, JSON.stringify(m)); } catch (err) { logger.warn({ err: shortError(err) }, 'Off-site: incomplete backup not noted'); }
  return list && list.length ? list : [];
}

function withIncomplete(t) {
  const e = t && t.last_status === 'ok' ? incompleteMap()[String(t.id)] : null;
  return { ...t, last_incomplete: e && Array.isArray(e.plugins) && e.plugins.length ? e : null };
}

/** An archive (Buffer) → { data, archive, cleanup } via a temp file: decrypted and read in pieces. */
async function readArchiveBuffer(buf, passphrase) {
  if (!gcbk.isGcbk(buf)) throw new gcbk.GcbkError('NOT_GCBK', 'not a GCBK1 file');
  const up = require('../backupUpload');
  const dir = up.incomingDir();
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  const name = up.newName('verify');
  const file = up.incomingPath(name);
  const cleanup = () => up.removeUpload(name);
  try {
    await fs.promises.writeFile(file, buf, { mode: 0o600, flag: 'wx' });
    const r = await up.readUpload(name, passphrase);
    return { ...r, cleanup };
  } catch (err) { await cleanup(); throw err; }
}

function getTarget(id) {
  const row = getRow(id);
  return row ? toApi(row) : null;
}

function checkName(v) {
  const n = typeof v === 'string' ? v.trim() : '';
  if (!n || n.length > 64 || /[\0-\x1f]/.test(n)) throw new OffsiteError('INVALID_NAME', 'name: 1-64 characters');
  return n;
}
function checkKeep(v, dflt) {
  if (v === undefined || v === null || v === '') return dflt;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 365) throw new OffsiteError('INVALID_KEEP', 'keep must be 1-365');
  return n;
}

function createTarget(body = {}) {
  const type = body.type;
  if (!TYPES.includes(type)) throw new OffsiteError('INVALID_TYPE', `type must be one of ${TYPES.join(', ')}`);
  const count = getDb().prepare('SELECT COUNT(*) AS n FROM backup_targets').get().n;
  if (count >= MAX_TARGETS) throw new OffsiteError('TOO_MANY_TARGETS', `at most ${MAX_TARGETS} targets`, 409);
  const name = checkName(body.name);
  const keep = checkKeep(body.keep, 14);
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') throw new OffsiteError('INVALID_ENABLED', 'enabled must be a boolean');
  const cfg = normalizeConfig(type, body.config);
  if (type === 'sftp') ensureSshKey();
  const info = getDb().prepare(
    'INSERT INTO backup_targets (name, type, config_enc, enabled, keep, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(name, type, encrypt(JSON.stringify(cfg)), body.enabled === false ? 0 : 1, keep, new Date().toISOString());
  return getTarget(info.lastInsertRowid);
}

async function updateTarget(id, body = {}) {
  const row = getRow(id);
  if (!row) throw new OffsiteError('NOT_FOUND', 'target not found', 404);
  if (body.type !== undefined && body.type !== row.type) throw new OffsiteError('TYPE_IMMUTABLE', 'the type of a target cannot change — create a new one', 400);
  const name = body.name !== undefined ? checkName(body.name) : row.name;
  const keep = checkKeep(body.keep, row.keep);
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') throw new OffsiteError('INVALID_ENABLED', 'enabled must be a boolean');
  const prev = readConfig(row) || {};
  let cfg = prev;
  if (body.config !== undefined) cfg = normalizeConfig(row.type, { ...publicConfig(row.type, prev), ...body.config }, prev);
  else if (!readConfig(row)) throw new OffsiteError('INVALID_CONFIG', 'stored config is unreadable — send the full config');
  getDb().prepare('UPDATE backup_targets SET name = ?, config_enc = ?, enabled = ?, keep = ? WHERE id = ?')
    .run(name, encrypt(JSON.stringify(cfg)), body.enabled === undefined ? row.enabled : (body.enabled ? 1 : 0), keep, row.id);
  if (row.type === 'sftp' && (prev.host !== cfg.host || Number(prev.port) !== Number(cfg.port) || JSON.stringify(prev.via || null) !== JSON.stringify(cfg.via || null))) {
    await require('./sftp').forgetHost(prev);
  }
  return getTarget(row.id);
}

async function deleteTarget(id) {
  const row = getRow(id);
  if (!row) throw new OffsiteError('NOT_FOUND', 'target not found', 404);
  getDb().prepare('DELETE FROM backup_targets WHERE id = ?').run(row.id);
  if (row.type === 'sftp') {
    const cfg = readConfig(row);
    if (cfg) await require('./sftp').forgetHost(cfg);
  }
  return true;
}

// ── Transfers ──────────────────────────────────────────────────────────────

const running = new Map(); // target id → promise (one transfer per target)

function transportFor(row) {
  const cfg = readConfig(row);
  if (!cfg) throw new OffsiteError('CONFIG_UNREADABLE', 'stored config cannot be decrypted — enter the credentials again', 409);
  const t = TRANSPORTS[row.type]();
  const ctx = row.type === 'sftp' ? sshContext() : undefined;
  return { cfg, t, ctx };
}

function shortError(err) {
  return String((err && err.message) || err || 'error').replace(/\s+/g, ' ').slice(0, 500);
}

function recordResult(id, status, error) {
  getDb().prepare('UPDATE backup_targets SET last_run_at = ?, last_status = ?, last_error = ? WHERE id = ?')
    .run(new Date().toISOString(), status, error || null, id);
}

function publish(targetId, status, extra = {}) {
  eventBus.publish('backup', { target_id: targetId, status, ...extra });
}

// ── The NAS's certificate (storageTargets/trust.js) ────────────────────────
// WebDAV and S3: after a connection failed on the certificate, what the NAS
// presents is read (the transports' inspectTls). Through a VPN device or a
// route, on the first contact, it is remembered (tls_ca) and the operation
// runs again; otherwise the error carries `tls` (the page's card: "Diesem
// Gerät vertrauen" / "Neues Zertifikat vertrauen", trustTarget) and a hint.
// A certificate that changed is never accepted on its own.

const CERT_TYPES = new Set(['webdav', 's3']);
const CERT_HINTS = { untrusted: 'cert_untrusted', changed: 'cert_changed', name: 'cert_name', expired: 'cert_expired', not_yet_valid: 'cert_not_yet_valid', decrypts: 'cert_decrypts' };
const changeLogged = new Map(); // target id → fingerprint of the changed certificate already in the activity log

/** A TRANSPORT error of a refused certificate (the system's code in `sys`)? */
function isCertError(err) {
  if (!err || err.code !== 'TRANSPORT' || !err.sys) return false;
  return require('../storageTargets/errors').StorageError.from({ code: err.sys, message: '' }).code === 'tls';
}

/** Reached with a trusted certificate before? A target from before `tls_seen`: its last upload decides. */
function seenOf(row, cfg) {
  if (cfg.tls_seen === true || cfg.tls_seen === false) return cfg.tls_seen;
  return row.last_status === 'ok';
}

/** Merge `fields` into the stored config — only while it still names the same server as `used`. */
function patchConfig(row, used, fields) {
  const fresh = getRow(row.id);
  const cur = fresh && readConfig(fresh);
  if (!cur || tlsPlace(row.type, cur) !== tlsPlace(row.type, used)) return false;
  getDb().prepare('UPDATE backup_targets SET config_enc = ? WHERE id = ?').run(encrypt(JSON.stringify({ ...cur, ...fields })), row.id);
  return true;
}

/** After a certificate failure: { state, reason, host, cert (trust.card), auto } or null. */
async function certTrouble(row, cfg, t) {
  if (typeof t.inspectTls !== 'function') return null;
  const trust = require('../storageTargets/trust');
  let diag;
  try { diag = await t.inspectTls(cfg); } catch (err) {
    logger.debug({ target: row.id, err: shortError(err) }, 'Off-site target certificate not readable');
    return null;
  }
  if (!diag || !diag.cert) return null;
  let decrypts = trust.caddyDecrypts(diag);
  const v = cfg.via || { kind: 'host' };
  if (v.kind === 'route') {
    try {
      const r = require('../storageTargets/via').routeOf(v.routeId);
      if (r.route_type === 'l4' && r.l4_tls_mode === 'terminate') decrypts = true;
    } catch { /* the error said why */ }
  }
  const state = trust.assess(diag, { stored: !!cfg.tls_ca, decrypts });
  if (!state) return null;
  const where = t.route(cfg);
  const auto = trust.autoTrust({ state, stored: !!cfg.tls_ca, seen: seenOf(row, cfg), tunnel: state === 'untrusted' && await trust.tunnelled(where.kind, where.dial) });
  return { state, reason: diag.reason, host: diag.host, cert: trust.card(diag.cert), auto };
}

/** The error of a certificate failure with what the page needs: `tls` (the card), `hint`, the activity entry for a change. */
function certError(err, info, row) {
  const trust = require('../storageTargets/trust');
  const text = info.state === 'changed' ? `${trust.CHANGED_TEXT} (new: SHA-256 ${info.cert.fingerprint})`
    : info.state === 'untrusted' ? trust.UNTRUSTED_TEXT : info.state === 'name' ? trust.NAME_TEXT : null;
  if (text) err.message = `${err.message} (${text})`;
  err.hint = CERT_HINTS[info.state] || null;
  err.tls = { state: info.state, reason: info.reason, host: info.host, cert: info.cert };
  if (info.state === 'changed' && changeLogged.get(row.id) !== info.cert.fingerprint) {
    changeLogged.set(row.id, info.cert.fingerprint);
    try {
      require('../activity').log('offsite_target_cert_changed',
        `Off-site backup target "${row.name}": the NAS presents another certificate than the stored one (SHA-256 ${info.cert.fingerprint}) — not accepted until trusted`,
        { source: 'system', severity: 'warning' });
    } catch { /* activity log unavailable */ }
  }
  return err;
}

function isHttps(type, cfg) {
  try { return (type === 'webdav' ? new URL(cfg.url) : require('./s3').objectUrl(cfg, '')).protocol === 'https:'; } catch { return false; }
}

/**
 * Run `fn(cfg)` against target `row` with the certificate handling above.
 * → { value, cfg (the config that worked), trusted (trust.card of a
 * certificate remembered on first contact) | null }
 */
async function withTrust(row, cfg, t, fn) {
  if (!CERT_TYPES.has(row.type)) return { value: await fn(cfg), cfg, trusted: null };
  let value;
  try { value = await fn(cfg); } catch (err) {
    if (!isCertError(err)) throw err;
    const info = await certTrouble(row, cfg, t);
    if (!info) throw err;
    if (!info.auto) throw certError(err, info, row);
    const next = { ...cfg, tls_ca: info.cert.pem.trim() };
    let later = null;
    try { value = await fn(next); } catch (e2) {
      // still refused on the certificate: not only an unknown one — the page asks
      if (isCertError(e2)) throw certError(err, { ...info, auto: false }, row);
      later = e2; // past the certificate (a wrong password …): it is the NAS's, keep it
    }
    patchConfig(row, cfg, { tls_ca: next.tls_ca, tls_seen: true });
    try {
      require('../activity').log('offsite_target_cert_remembered',
        `Off-site backup target "${row.name}": certificate of the NAS remembered on first contact through the VPN (SHA-256 ${info.cert.fingerprint})`,
        { source: 'system', severity: 'info' });
    } catch { /* activity log unavailable */ }
    logger.info({ target: row.id, fingerprint: info.cert.fingerprint }, 'Off-site target: certificate of the NAS remembered on first contact');
    if (later) { later.trusted = info.cert; throw later; }
    return { value, cfg: next, trusted: info.cert };
  }
  if (cfg.tls_seen !== true && isHttps(row.type, cfg)) patchConfig(row, cfg, { tls_seen: true });
  return { value, cfg, trusted: null };
}

/**
 * "Diesem Gerät vertrauen" / "Neues Zertifikat vertrauen" (POST
 * /targets/:id/trust): reads the certificate the NAS presents now and stores
 * it as the target's tls_ca — only when it is the one the page showed
 * (`fingerprint`, SHA-256 hex) and a click may trust it.
 * → { cert (trust.card), replaced } · OffsiteError CERT_MISMATCH 409,
 *   NOT_TRUSTABLE 409 (`reason`), INVALID_FINGERPRINT 400, NOT_FOUND 404
 */
async function trustTarget(id, fingerprint) {
  const row = getRow(id);
  if (!row) throw new OffsiteError('NOT_FOUND', 'target not found', 404);
  const fp = String(fingerprint || '').toLowerCase().replace(/[^0-9a-f]/g, '');
  if (!/^[0-9a-f]{64}$/.test(fp)) throw new OffsiteError('INVALID_FINGERPRINT', 'fingerprint: 64 hex digits (SHA-256)', 400);
  const { cfg, t } = transportFor(row);
  if (!CERT_TYPES.has(row.type) || typeof t.inspectTls !== 'function') throw notTrustable('no_tls');
  let diag;
  try { diag = await t.inspectTls(cfg); } catch (err) { throw new OffsiteError('TRANSPORT_FAILED', shortError(err), 502); }
  if (!diag || !diag.cert) throw notTrustable(diag ? diag.reason : 'no_tls');
  if (diag.cert.fingerprint !== fp) throw new OffsiteError('CERT_MISMATCH', 'the NAS presents another certificate by now — test again', 409);
  const trust = require('../storageTargets/trust');
  if (!diag.reason) return { cert: trust.card(diag.cert), replaced: false, already: true };
  const info = await certTrouble(row, cfg, t);
  if (!info || !trust.trustable(info.state)) throw notTrustable(info ? info.state : diag.reason);
  patchConfig(row, cfg, { tls_ca: diag.cert.pem.trim(), tls_seen: true });
  changeLogged.delete(row.id);
  return { cert: trust.card(diag.cert), replaced: !!cfg.tls_ca };
}

function notTrustable(reason) {
  const e = new OffsiteError('NOT_TRUSTABLE', `this certificate cannot be trusted here (${reason || 'unknown'})`, 409);
  e.reason = reason || null;
  return e;
}

/** POST /targets/:id/test → { detail, trusted (a certificate remembered on first contact) | null }. */
async function testTarget(id) {
  const row = getRow(id);
  if (!row) throw new OffsiteError('NOT_FOUND', 'target not found', 404);
  const { cfg, t, ctx } = transportFor(row);
  const r = await withTrust(row, cfg, t, (c) => t.test(c, ctx));
  return { detail: r.value, trusted: r.trusted };
}

async function listRemoteFiles(id) {
  const row = getRow(id);
  if (!row) throw new OffsiteError('NOT_FOUND', 'target not found', 404);
  const { cfg, t, ctx } = transportFor(row);
  const files = (await withTrust(row, cfg, t, (c) => t.list(c, ctx))).value;
  return files
    .filter((f) => REMOTE_NAME_RE.test(f.name))
    .sort((a, b) => b.name.localeCompare(a.name))
    .map((f) => ({ name: f.name, size: f.size, modified: f.modified || null }));
}

// ── Restore test (docs/feature-next-package.md §S2.1) ──────────────────────
// Fetch the newest archive from the target, decrypt it with the stored
// passphrase and validate it — READ ONLY: nothing on the target and nothing in
// this installation changes (the only write is the result below).
// Warnings are stable codes; the UI has a text per code.

const MAX_VERIFY_BYTES = 1024 * 1024 * 1024; // a GateControl archive is gzip'd JSON (≤ gcbk.MAX_PLAIN_BYTES unzipped)
const VERIFY_STALE_MS = 30 * 24 * 3600 * 1000;
const ARCHIVE_OLD_MS = 48 * 3600 * 1000;

function recordVerify(id, status, detail) {
  try {
    getDb().prepare('UPDATE backup_targets SET last_verify_at = ?, last_verify_status = ?, last_verify_detail = ? WHERE id = ?')
      .run(new Date().toISOString(), status, detail ? JSON.stringify(detail).slice(0, 4000) : null, id);
  } catch (err) {
    logger.warn({ target: id, err: shortError(err) }, 'Could not record the restore-test result');
  }
}

/** Timestamp encoded in gatecontrol-YYYYMMDD-HHmmss.gcbk → ms, or NaN. */
function remoteNameTime(name) {
  const m = /^gatecontrol-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.gcbk$/.exec(String(name || ''));
  if (!m) return NaN;
  return Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`);
}

/**
 * POST /targets/:id/verify — restore test.
 * @returns {Promise<{file,size,created_at,gc_version,include_key,counts,warnings}>}
 * @throws {OffsiteError} NO_REMOTE_BACKUP | PASSPHRASE_NOT_SET | DECRYPT_FAILED
 *                        | CORRUPT | TRANSPORT_FAILED | NOT_FOUND
 */
async function verifyTarget(id) {
  const row = getRow(id);
  if (!row) throw new OffsiteError('NOT_FOUND', 'target not found', 404);
  try {
    const passphrase = getPassphrase();
    if (!passphrase) throw new OffsiteError('PASSPHRASE_NOT_SET', 'set the off-site passphrase first', 409);
    const { cfg, t, ctx } = transportFor(row);
    if (typeof t.download !== 'function') throw new OffsiteError('TRANSPORT_FAILED', 'this target type cannot read archives back', 502);

    const listed = await withTrust(row, cfg, t, (c) => t.list(c, ctx));
    const files = listed.value
      .filter((f) => REMOTE_NAME_RE.test(f.name))
      .sort((a, b) => b.name.localeCompare(a.name));
    if (files.length === 0) throw new OffsiteError('NO_REMOTE_BACKUP', 'no GateControl archive on this target yet', 409);
    const newest = files[0];
    if (Number(newest.size) > MAX_VERIFY_BYTES) {
      throw new OffsiteError('CORRUPT', `archive is larger than ${Math.round(MAX_VERIFY_BYTES / 1048576)} MB — not read back`, 400);
    }

    const buf = await t.download(listed.cfg, newest.name, ctx);
    if (!Buffer.isBuffer(buf) || buf.length === 0) throw new OffsiteError('CORRUPT', 'the archive came back empty', 400);
    if (buf.length > MAX_VERIFY_BYTES) throw new OffsiteError('CORRUPT', 'archive too large', 400);

    let opened;
    try {
      opened = await readArchiveBuffer(buf, passphrase);
    } catch (err) {
      if (err instanceof gcbk.GcbkError) {
        const code = err.code === 'DECRYPT_FAILED' ? 'DECRYPT_FAILED' : 'CORRUPT';
        throw new OffsiteError(code, err.message, 400);
      }
      throw err;
    }
    const { archive } = opened;
    let counts;
    let incomplete;
    try {
      const data = opened.data;
      const errors = require('../backup').validateBackup(data);
      if (errors.length > 0) {
        throw new OffsiteError('CORRUPT', `the archive is not a usable backup: ${errors.slice(0, 3).join('; ')}`, 400);
      }
      const summary = require('../backup').getBackupSummary(data);
      counts = {
        routes: summary.routes, peers: summary.peers, users: summary.users, settings: summary.settings,
      };
      incomplete = summary.plugins_incomplete || [];
    } finally { await opened.cleanup(); }

    const includeKey = !!archive.payload.encryption_key;
    const gcVersion = archive.header.gc_version || archive.payload.gc_version || null;
    const createdAt = archive.header.created_at || archive.payload.created_at || null;

    const warnings = [];
    const at = Date.parse(createdAt) || remoteNameTime(newest.name);
    if (Number.isFinite(at) && Date.now() - at > ARCHIVE_OLD_MS) warnings.push('archive_old');
    if (!includeKey) warnings.push('no_encryption_key');
    if (gcVersion && gcVersion !== require('../../../package.json').version) warnings.push('version_differs');
    if (!counts.routes) warnings.push('no_routes');
    if (!counts.users) warnings.push('no_users');
    if (incomplete.length) warnings.push('plugins_incomplete');

    const result = {
      file: newest.name,
      size: buf.length,
      created_at: createdAt,
      gc_version: gcVersion,
      include_key: includeKey,
      counts,
      warnings,
      plugins_incomplete: incomplete,
    };
    recordVerify(row.id, warnings.length ? 'warning' : 'ok', result);
    logger.info({ target: row.id, type: row.type, file: newest.name, size: buf.length, warnings: warnings.length },
      'Off-site restore test passed');
    publish(row.id, 'verified', { file: newest.name, verify_status: warnings.length ? 'warning' : 'ok' });
    return result;
  } catch (err) {
    const code = err instanceof OffsiteError ? err.code
      : (err && err.code === 'TRANSPORT' ? 'TRANSPORT_FAILED' : 'INTERNAL');
    recordVerify(row.id, 'failed', { code, error: shortError(err) });
    publish(row.id, 'verified', { verify_status: 'failed' });
    if (err && err.code === 'TRANSPORT') {
      const e = new OffsiteError('TRANSPORT_FAILED', shortError(err), 502);
      if (err.hint) e.hint = err.hint;
      if (err.tls) e.tls = err.tls;
      throw e;
    }
    throw err;
  }
}

/**
 * Targets whose restore test is missing or older than 30 days (security check).
 * @returns {{id:number,name:string,last_verify_at:string|null}[]}
 */
function staleVerifications(rows) {
  const now = Date.now();
  return (rows || []).filter((r) => {
    if (String(r.last_verify_status || '') !== 'ok' && String(r.last_verify_status || '') !== 'warning') return true;
    const at = Date.parse(r.last_verify_at || '');
    return !Number.isFinite(at) || now - at > VERIFY_STALE_MS;
  });
}

async function applyRetention(row, cfg, t, ctx) {
  const files = (await t.list(cfg, ctx)).filter((f) => REMOTE_NAME_RE.test(f.name))
    .sort((a, b) => b.name.localeCompare(a.name));
  const doomed = files.slice(row.keep);
  for (const f of doomed) await t.remove(cfg, f.name, ctx);
  return doomed.length;
}

/** Upload one archive buffer to one target (serialised per target). */
async function uploadTo(id, name, buf) {
  const prevRun = running.get(id) || Promise.resolve();
  const job = prevRun.catch(() => { /* previous upload's failure was already reported to its own caller; only serialisation matters here */ }).then(async () => {
    const row = getRow(id);
    if (!row) throw new OffsiteError('NOT_FOUND', 'target not found', 404);
    publish(row.id, 'running', { file: name });
    try {
      const { cfg: stored, t, ctx } = transportFor(row);
      const up = await withTrust(row, stored, t, (c) => t.upload(c, name, buf, ctx));
      const cfg = up.cfg;
      let deleted = 0;
      try { deleted = await applyRetention(row, cfg, t, ctx); }
      catch (err) { logger.warn({ target: row.id, err: shortError(err) }, 'Off-site retention failed (upload itself succeeded)'); }
      recordResult(row.id, 'ok', null);
      publish(row.id, 'ok', { file: name });
      logger.info({ target: row.id, type: row.type, file: name, size: buf.length, deleted }, 'Off-site backup uploaded');
      return { status: 'ok', file: name, deleted, ...(up.trusted ? { trusted: up.trusted } : {}) };
    } catch (err) {
      const msg = shortError(err);
      recordResult(row.id, 'failed', msg);
      publish(row.id, 'failed', { file: name, error: msg });
      logger.warn({ target: row.id, type: row.type, err: msg }, 'Off-site backup upload failed');
      try {
        require('../activity').log('offsite_backup_failed', `Off-site backup to "${row.name}" failed: ${msg}`, { source: 'system', severity: 'error' });
      } catch { /* activity log unavailable */ }
      const e = err instanceof OffsiteError ? err : new OffsiteError('UPLOAD_FAILED', msg, 502);
      if (err && err.hint) e.hint = err.hint;
      if (err && err.tls) e.tls = err.tls;
      throw e;
    }
  });
  running.set(id, job); // set synchronously: the next caller chains behind this job
  try { return await job; } finally { if (running.get(id) === job) running.delete(id); }
}

function remoteNameFor(localFile) {
  const m = LOCAL_NAME_RE.exec(path.basename(localFile));
  return m ? `gatecontrol-${m[1]}.gcbk` : null;
}

/** Encrypt a local JSON backup file into a GCBK1 buffer. */
async function buildArchive(localFile) {
  const passphrase = getPassphrase();
  if (!passphrase) throw new OffsiteError('PASSPHRASE_NOT_SET', 'set the off-site passphrase first', 409);
  const { include_key: includeKey } = getOffsiteSettings();
  const config = require('../../../config/default');
  // streamed from the file (no JSON.parse/stringify of a few hundred MB on the main thread)
  return gcbk.encryptBackupFile(localFile, {
    passphrase,
    encryptionKey: includeKey ? config.encryption.key : undefined,
    gcVersion: require('../../../package.json').version,
  });
}

function hasLicense() {
  try { return require('../license').hasFeature('scheduled_backups'); } catch { return false; }
}

/**
 * Hook for services/autobackup.runBackup: upload the new file to all enabled
 * targets. Never throws (logged + recorded per target).
 */
async function uploadAfterBackup(localFile) {
  const targets = getDb().prepare('SELECT id FROM backup_targets WHERE enabled = 1 ORDER BY id').all();
  if (targets.length === 0) return { uploaded: 0, failed: 0, skipped: 'no_targets' };
  if (!hasLicense()) return { uploaded: 0, failed: 0, skipped: 'unlicensed' };
  const name = remoteNameFor(localFile);
  if (!name) return { uploaded: 0, failed: 0, skipped: 'bad_name' };
  let buf;
  try {
    buf = await buildArchive(localFile);
  } catch (err) {
    const msg = shortError(err);
    for (const t of targets) { recordResult(t.id, 'failed', msg); publish(t.id, 'failed', { error: msg }); }
    logger.warn({ err: msg }, 'Off-site backup skipped');
    return { uploaded: 0, failed: targets.length, skipped: null };
  }
  let uploaded = 0;
  let failed = 0;
  for (const t of targets) {
    try { await uploadTo(t.id, name, buf); uploaded++; await noteIncomplete(t.id, localFile); } catch { failed++; }
  }
  return { uploaded, failed, skipped: null };
}

/**
 * POST /targets/:id/run — upload the newest local backup now (a fresh one is
 * created when none exists yet).
 */
function runTarget(id) {
  return require('../../utils/loopStall').withTask('offsite.run', () => runTargetNow(id));
}

async function runTargetNow(id) {
  const row = getRow(id);
  if (!row) throw new OffsiteError('NOT_FOUND', 'target not found', 404);
  const autobackup = require('../autobackup');
  let files = autobackup.listBackupFiles();
  if (files.length === 0) {
    await autobackup.runBackup({ offsite: false });
    files = autobackup.listBackupFiles();
  }
  if (files.length === 0) throw new OffsiteError('NO_LOCAL_BACKUP', 'no local backup available', 409);
  const localFile = path.join(autobackup.BACKUP_DIR, files[0].filename);
  const buf = await buildArchive(localFile);
  const r = await uploadTo(row.id, remoteNameFor(localFile), buf);
  return { ...r, plugins_incomplete: await noteIncomplete(row.id, localFile) };
}

// ── "Speicherziel übernehmen" ──────────────────────────────────────────────

/**
 * The WebDAV and SMB storage targets (Einstellungen › Plugins › Speicher)
 * the off-site form can take its settings from (GET
 * /targets/storage-sources): address, "Verbindung", user, trust anchor —
 * in this feature's config fields, never a secret (has_password says
 * whether one is stored). Saving with `password_from_storage_target: id`
 * copies that password once (normalizeConfig).
 */
function storageSources() {
  const st = require('../storageTargets');
  let rows;
  try {
    rows = getDb().prepare("SELECT * FROM storage_targets WHERE kind IN ('webdav', 'smb') ORDER BY label COLLATE NOCASE, id").all();
  } catch { return []; }
  return rows.map((row) => {
    const cfg = st.configOf(row);
    const sec = st.secretOf(row);
    let config;
    if (row.kind === 'webdav') {
      config = { url: cfg.url, via: cfg.via && cfg.via.kind ? cfg.via : { kind: 'host' }, username: cfg.username || '', tls_ca: cfg.tlsCa || null };
    } else {
      const v = cfg.via || { kind: 'host' };
      config = {
        host: v.kind === 'host' ? v.host : '',
        port: v.kind === 'host' ? v.port || 445 : (v.kind === 'peer' ? v.port || 445 : null),
        via: v.kind === 'host' ? { kind: 'host' } : v,
        share: cfg.share, path: cfg.folder || '', username: cfg.username || '', domain: cfg.domain || '',
        encrypt: cfg.encrypt === true,
      };
    }
    return {
      id: row.id, kind: row.kind, label: row.label, display: st.display(row.kind, cfg), config,
      has_password: !!sec.password, password_unreadable: !!row.secret_enc && !Object.keys(sec).length,
    };
  });
}

// ── Restore of a JSON backup: the peer / route of a `via` ─────────────────
// The off-site targets are not part of the JSON backup (they stay as they
// are), but a restore numbers peers and routes anew. Before it the peer of
// every `via` is noted by name and the route by domain; afterwards they are
// looked up again (services/backup.restoreBackup) — gone → id 0: the target
// stays, unreachable until edited, like a storage target.

/** [{ id, cfg, peer_name | route_domain }] of the targets with a peer / route. */
function viaSnapshot(db) {
  const out = [];
  let rows;
  try { rows = db.prepare('SELECT id, config_enc FROM backup_targets').all(); } catch { return out; }
  for (const row of rows) {
    const cfg = readConfig(row);
    const v = cfg && cfg.via;
    if (!v || (v.kind !== 'peer' && v.kind !== 'route')) continue;
    const ref = v.kind === 'peer'
      ? { peer_name: (db.prepare('SELECT name FROM peers WHERE id = ?').get(v.peerId) || {}).name || null }
      : { route_domain: (db.prepare('SELECT domain FROM routes WHERE id = ?').get(v.routeId) || {}).domain || null };
    out.push({ id: row.id, cfg, ...ref });
  }
  return out;
}

/** After the restore: the new ids of those peers / routes into the targets. Returns the count changed. */
function remapVia(db, snapshot, { peerIdMap, routeIdByDomain }) {
  let n = 0;
  const upd = db.prepare('UPDATE backup_targets SET config_enc = ? WHERE id = ?');
  for (const s of snapshot || []) {
    const v = { ...s.cfg.via };
    if (v.kind === 'peer') v.peerId = (s.peer_name && peerIdMap.get(s.peer_name)) || 0;
    else v.routeId = (s.route_domain && routeIdByDomain.get(s.route_domain)) || 0;
    try { upd.run(encrypt(JSON.stringify({ ...s.cfg, via: v })), s.id); n++; } catch (err) {
      logger.warn({ target: s.id, err: shortError(err) }, 'backup restore: off-site target connection not updated');
    }
  }
  return n;
}

/**
 * Internal L4 routes a LAN NAS can be reached through (GET
 * /targets/l4-candidates). connect_host is the server's WireGuard address: an
 * internal-only L4 route admits VPN source addresses only, and a local
 * connection to 10.8.0.1 leaves with that source address — 127.0.0.1 would be
 * dropped by the route's remote_ip gate.
 */
function l4Candidates() {
  const config = require('../../../config/default');
  const rows = getDb().prepare(`
    SELECT id, domain, description, l4_protocol, l4_listen_port, l4_tls_mode, external_enabled,
           target_ip, target_port, target_kind, target_lan_host, target_lan_port, enabled
    FROM routes
    WHERE route_type = 'l4' AND (l4_protocol IS NULL OR l4_protocol = 'tcp')
    ORDER BY l4_listen_port
  `).all();
  const out = [];
  for (const r of rows) {
    const port = Number(String(r.l4_listen_port || '').trim());
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue; // port ranges are useless here
    if (r.l4_tls_mode && r.l4_tls_mode !== 'none') continue;
    const tPort = Number(r.target_kind === 'gateway' ? (r.target_lan_port || r.target_port) : r.target_port);
    const suggested = tPort === 22 ? 'sftp' : (tPort === 445 || tPort === 139) ? 'smb' : null;
    out.push({
      route_id: r.id,
      label: r.description || r.domain || `L4 :${port}`,
      listen_port: port,
      target: `${r.target_kind === 'gateway' ? (r.target_lan_host || r.target_ip || '') : (r.target_ip || '')}:${tPort || ''}`,
      internal: r.external_enabled !== 1,
      enabled: r.enabled === 1,
      suggested_type: suggested,
      connect_host: config.wireguard.gatewayIp,
      connect_port: port,
    });
  }
  return out;
}

module.exports = {
  TYPES,
  REMOTE_NAME_RE,
  OffsiteError,
  getOffsiteSettings,
  updateOffsiteSettings,
  getPassphrase,
  ensureSshKey,
  rotateSshKey,
  normalizeConfig,
  publicConfig,
  listTargets,
  getTarget,
  createTarget,
  updateTarget,
  deleteTarget,
  testTarget,
  trustTarget,
  listRemoteFiles,
  verifyTarget,
  staleVerifications,
  VERIFY_STALE_MS,
  runTarget,
  uploadAfterBackup,
  buildArchive,
  remoteNameFor,
  l4Candidates,
  storageSources,
  viaSnapshot,
  remapVia,
};
