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
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
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

function bad(field, msg) { return new OffsiteError('INVALID_CONFIG', `${field}: ${msg}`); }

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
function checkUrl(v, field) {
  let u;
  try { u = new URL(String(v || '').trim()); } catch { throw bad(field, 'must be an http(s) URL'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw bad(field, 'must be an http(s) URL');
  if (u.username || u.password) throw bad(field, 'must not contain credentials — use the username/password fields');
  return u.toString();
}

/**
 * Normalise a config for `type`. `prev` = stored config (secrets kept when the
 * input omits them or sends '').
 */
function normalizeConfig(type, input, prev = {}) {
  const c = input && typeof input === 'object' ? input : {};
  const keep = (field) => {
    const v = checkSecret(c[field], field);
    if (v === undefined || v === '') return prev[field] || '';
    return v;
  };
  switch (type) {
    case 'sftp':
      return {
        host: checkHost(str(c.host)),
        port: checkPort(c.port, 22),
        username: checkUser(c.username, true),
        path: checkPath(c.path),
      };
    case 'smb': {
      const share = String(c.share || '').trim();
      if (!SHARE_RE.test(share)) throw bad('share', 'required (letters, digits, space and . _ $ -)');
      const domain = c.domain === undefined || c.domain === null ? '' : String(c.domain).trim();
      if (domain && !DOMAIN_RE.test(domain)) throw bad('domain', 'invalid');
      const cfg = {
        host: checkHost(str(c.host)),
        port: checkPort(c.port, 445),
        share,
        path: checkPath(c.path),
        username: checkUser(c.username, false),
        password: c.clear_password === true ? '' : keep('password'),
        domain,
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
      return cfg;
    }
    case 'webdav':
      return {
        url: checkUrl(c.url, 'url'),
        username: checkUser(c.username, false),
        password: c.clear_password === true ? '' : keep('password'),
      };
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
    last_verify_at: row.last_verify_at || null,
    last_verify_status: row.last_verify_status || null,
    last_verify: parseVerifyDetail(row.last_verify_detail),
    created_at: row.created_at,
  };
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
  return getDb().prepare('SELECT * FROM backup_targets ORDER BY id').all().map(toApi);
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
  if (row.type === 'sftp' && (prev.host !== cfg.host || Number(prev.port) !== Number(cfg.port))) {
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

async function testTarget(id) {
  const row = getRow(id);
  if (!row) throw new OffsiteError('NOT_FOUND', 'target not found', 404);
  const { cfg, t, ctx } = transportFor(row);
  const detail = await t.test(cfg, ctx);
  return detail;
}

async function listRemoteFiles(id) {
  const row = getRow(id);
  if (!row) throw new OffsiteError('NOT_FOUND', 'target not found', 404);
  const { cfg, t, ctx } = transportFor(row);
  const files = await t.list(cfg, ctx);
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

const MAX_VERIFY_BYTES = 128 * 1024 * 1024; // a GateControl archive is gzip'd JSON
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

    const files = (await t.list(cfg, ctx))
      .filter((f) => REMOTE_NAME_RE.test(f.name))
      .sort((a, b) => b.name.localeCompare(a.name));
    if (files.length === 0) throw new OffsiteError('NO_REMOTE_BACKUP', 'no GateControl archive on this target yet', 409);
    const newest = files[0];
    if (Number(newest.size) > MAX_VERIFY_BYTES) {
      throw new OffsiteError('CORRUPT', `archive is larger than ${Math.round(MAX_VERIFY_BYTES / 1048576)} MB — not read back`, 400);
    }

    const buf = await t.download(cfg, newest.name, ctx);
    if (!Buffer.isBuffer(buf) || buf.length === 0) throw new OffsiteError('CORRUPT', 'the archive came back empty', 400);
    if (buf.length > MAX_VERIFY_BYTES) throw new OffsiteError('CORRUPT', 'archive too large', 400);

    let archive;
    try {
      archive = await gcbk.decryptBackup(buf, passphrase);
    } catch (err) {
      if (err instanceof gcbk.GcbkError) {
        const code = err.code === 'DECRYPT_FAILED' ? 'DECRYPT_FAILED' : 'CORRUPT';
        throw new OffsiteError(code, err.message, 400);
      }
      throw err;
    }

    const data = archive.payload.backup;
    const errors = require('../backup').validateBackup(data);
    if (errors.length > 0) {
      throw new OffsiteError('CORRUPT', `the archive is not a usable backup: ${errors.slice(0, 3).join('; ')}`, 400);
    }
    const summary = require('../backup').getBackupSummary(data);
    const counts = {
      routes: summary.routes, peers: summary.peers, users: summary.users, settings: summary.settings,
    };

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

    const result = {
      file: newest.name,
      size: buf.length,
      created_at: createdAt,
      gc_version: gcVersion,
      include_key: includeKey,
      counts,
      warnings,
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
  const job = prevRun.catch(() => {}).then(async () => {
    const row = getRow(id);
    if (!row) throw new OffsiteError('NOT_FOUND', 'target not found', 404);
    publish(row.id, 'running', { file: name });
    try {
      const { cfg, t, ctx } = transportFor(row);
      await t.upload(cfg, name, buf, ctx);
      let deleted = 0;
      try { deleted = await applyRetention(row, cfg, t, ctx); }
      catch (err) { logger.warn({ target: row.id, err: shortError(err) }, 'Off-site retention failed (upload itself succeeded)'); }
      recordResult(row.id, 'ok', null);
      publish(row.id, 'ok', { file: name });
      logger.info({ target: row.id, type: row.type, file: name, size: buf.length, deleted }, 'Off-site backup uploaded');
      return { status: 'ok', file: name, deleted };
    } catch (err) {
      const msg = shortError(err);
      recordResult(row.id, 'failed', msg);
      publish(row.id, 'failed', { file: name, error: msg });
      logger.warn({ target: row.id, type: row.type, err: msg }, 'Off-site backup upload failed');
      try {
        require('../activity').log('offsite_backup_failed', `Off-site backup to "${row.name}" failed: ${msg}`, { source: 'system', severity: 'error' });
      } catch { /* activity log unavailable */ }
      const e = err instanceof OffsiteError ? err : new OffsiteError('UPLOAD_FAILED', msg, 502);
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
  const backup = JSON.parse(fs.readFileSync(localFile, 'utf8'));
  const { include_key: includeKey } = getOffsiteSettings();
  const config = require('../../../config/default');
  return gcbk.encryptBackup(backup, {
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
    try { await uploadTo(t.id, name, buf); uploaded++; } catch { failed++; }
  }
  return { uploaded, failed, skipped: null };
}

/**
 * POST /targets/:id/run — upload the newest local backup now (a fresh one is
 * created when none exists yet).
 */
async function runTarget(id) {
  const row = getRow(id);
  if (!row) throw new OffsiteError('NOT_FOUND', 'target not found', 404);
  const autobackup = require('../autobackup');
  let files = autobackup.listBackupFiles();
  if (files.length === 0) {
    autobackup.runBackup({ offsite: false });
    files = autobackup.listBackupFiles();
  }
  if (files.length === 0) throw new OffsiteError('NO_LOCAL_BACKUP', 'no local backup available', 409);
  const localFile = path.join(autobackup.BACKUP_DIR, files[0].filename);
  const buf = await buildArchive(localFile);
  return uploadTo(row.id, remoteNameFor(localFile), buf);
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
  listRemoteFiles,
  verifyTarget,
  staleVerifications,
  VERIFY_STALE_MS,
  runTarget,
  uploadAfterBackup,
  buildArchive,
  remoteNameFor,
  l4Candidates,
};
