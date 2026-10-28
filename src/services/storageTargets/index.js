'use strict';

// Storage targets (docs/storage-targets.md): places outside GateControl's
// own data folder where it can keep files — a folder of this server (another
// disk), a NAS over SMB or WebDAV, an S3-compatible bucket, a folder in Google
// Drive or OneDrive (an account the administrator connects with OAuth,
// services/cloudAccounts/ — its token is the target's secret). The plugin media
// store moves the files of a plugin's areas there (media.js, plugin.json
// `media.areas`); nothing else uses them yet.
//
// One row per target in `storage_targets`: kind, label, the settings
// (config_json) and the secret fields (password, secret key) as JSON
// encrypted with GC_ENCRYPTION_KEY (utils/crypto, like the directory
// secrets) — never sent to the browser or a plugin, the admin API only says
// whether they are set. check() writes, reads and deletes a small test file
// and asks for the free space; the result is kept on the row.

const crypto = require('node:crypto');
const path = require('node:path');
const { getDb } = require('../../db/connection');
const { encrypt, decrypt } = require('../../utils/crypto');
const logger = require('../../utils/logger');
const { StorageError } = require('./errors');
const net = require('./net');

const KINDS = ['local', 'smb', 'webdav', 's3', 'gdrive', 'onedrive'];
const SECRET_FIELDS = { local: [], smb: ['password'], webdav: ['password'], s3: ['secretAccessKey'], gdrive: [], onedrive: [] };
// kinds that hold sealed blocks only (no readable files): remote object stores and cloud drives
const BLOCKS_ONLY = new Set(['s3', 'gdrive', 'onedrive']);
// cloud drives: the account is connected with OAuth (cloudAccounts), the token is the secret
const CLOUD = { gdrive: 'google', onedrive: 'microsoft' };
const CLOUD_ID_RE = { gdrive: /^[A-Za-z0-9_-]{1,200}$/, onedrive: /^[A-Za-z0-9!._-]{1,200}$/ };
const LABEL_MAX = 60;
const MAX_TARGETS = 50;
const CHECK_BYTES = 64 * 1024 + 17; // more than one media chunk, not a multiple of it
const HOST_RE = /^(?=.{1,253}$)[a-z0-9_](?:[a-z0-9_-]{0,62})(?:\.[a-z0-9_](?:[a-z0-9_-]{0,62}))*$/i;
const SHARE_RE = /^[^\\/"<>|?*:\u0000-\u001f]{1,80}$/;
const SEG_RE = /^[^\\/"<>|?*:\u0000-\u001f]{1,120}$/;
const USER_RE = /^[^\u0000-\u001f]{0,120}$/;
const BUCKET_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const REGION_RE = /^[a-z0-9-]{2,40}$/;
// a folder of this server may not be one of the system's own
const SYSTEM_DIRS = ['/bin', '/boot', '/dev', '/etc', '/lib', '/lib32', '/lib64', '/libx32', '/proc', '/root', '/run', '/sbin', '/sys', '/usr', '/var/lib', '/var/run', '/app'];

function invalid(field, message) { return new StorageError('invalid', message || `${field}: invalid`, { field }); }

function dataRoot() { return require('../plugins/constants').dataRoot(); }

// ─── Validation ─────────────────────────────────

function str(v) { return v == null ? '' : String(v).trim(); }

function folderPath(v, field) {
  const segs = str(v).replace(/\\/g, '/').split('/').filter(Boolean);
  if (segs.length > 16 || segs.some((s) => !SEG_RE.test(s) || s === '.' || s === '..')) throw invalid(field);
  return segs.join('/');
}

function localPath(v) {
  const p = str(v);
  if (!p || !path.isAbsolute(p) || p.length > 400 || /[\u0000-\u001f]/.test(p)) throw invalid('path');
  const n = path.resolve(p);
  if (n === '/' || SYSTEM_DIRS.some((d) => n === d || n.startsWith(d + '/'))) throw invalid('path', 'a system folder cannot be a storage target');
  // inside GateControl's data folder only below <data>/storage (never plugin code, data or media)
  const root = path.resolve(dataRoot());
  if (n === root || (n.startsWith(root + '/') && !n.startsWith(path.join(root, 'storage') + '/'))) {
    throw invalid('path', 'inside the data folder only below ' + path.join(root, 'storage'));
  }
  return n;
}

function httpUrl(v, field) {
  let u;
  try { u = new URL(str(v)); } catch { throw invalid(field); }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password || u.search || u.hash || u.href.length > 400) throw invalid(field);
  return u;
}

function port(v, dflt) {
  if (v == null || v === '') return dflt;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw invalid('port');
  return n;
}

/** A target's own trust anchor (PEM, one or more certificates) or null. */
function tlsCa(v) {
  const text = str(v);
  if (!text) return null;
  if (text.length > 64 * 1024) throw invalid('tlsCa');
  try { return net.parseCa(text).map((c) => c.pem).join('\n'); } catch { throw invalid('tlsCa'); }
}

/** SMB: where to connect — host (+ port), a VPN peer or an L4 route. */
function via(v, input) {
  const k = v && v.kind ? v.kind : 'host';
  if (k === 'host') {
    const host = str(input.host).toLowerCase().replace(/^\[|\]$/g, '');
    if (!(require('../plugins/netPolicy').isIpLiteral(host) || HOST_RE.test(host))) throw invalid('host');
    return { kind: 'host', host, port: port(input.port, 445) };
  }
  if (k === 'peer') {
    const peerId = Number(v.peerId);
    if (!Number.isSafeInteger(peerId) || !getDb().prepare('SELECT 1 FROM peers WHERE id = ?').get(peerId)) throw invalid('via');
    return { kind: 'peer', peerId, port: port(input.port, 445) };
  }
  if (k === 'route') {
    const routeId = Number(v.routeId);
    const r = Number.isSafeInteger(routeId) ? getDb().prepare('SELECT route_type FROM routes WHERE id = ?').get(routeId) : null;
    if (!r || r.route_type !== 'l4') throw invalid('via', 'an L4 route');
    return { kind: 'route', routeId };
  }
  throw invalid('via');
}

/**
 * Admin input → { label, config, secret } (secret: only the fields given;
 * an empty or missing secret field keeps the stored one — `prev`).
 */
function normalise(kind, input, prev = null) {
  if (!KINDS.includes(kind)) throw invalid('kind');
  const i = input && typeof input === 'object' ? input : {};
  const label = str(i.label);
  if (!label || label.length > LABEL_MAX || /[\u0000-\u001f]/.test(label)) throw invalid('label');
  let config;
  if (CLOUD[kind]) return normaliseCloud(kind, i, label, prev);
  if (kind === 'local') config = { path: localPath(i.path) };
  else if (kind === 'smb') {
    const share = str(i.share);
    if (!SHARE_RE.test(share)) throw invalid('share');
    if (!USER_RE.test(str(i.username)) || !USER_RE.test(str(i.domain)) || /[=\n]/.test(str(i.username) + str(i.domain))) throw invalid('username');
    const v = via(i.via, i);
    config = { via: v, share, folder: folderPath(i.folder, 'folder'), username: str(i.username), domain: str(i.domain) };
  } else if (kind === 'webdav') {
    const u = httpUrl(i.url, 'url');
    if (!USER_RE.test(str(i.username)) || str(i.username).includes(':')) throw invalid('username');
    config = { url: u.href, username: str(i.username), tlsCa: tlsCa(i.tlsCa) };
  } else {
    const u = httpUrl(i.endpoint, 'endpoint');
    const bucket = str(i.bucket);
    if (!BUCKET_RE.test(bucket)) throw invalid('bucket');
    const region = str(i.region) || 'us-east-1';
    if (!REGION_RE.test(region)) throw invalid('region');
    const keyId = str(i.accessKeyId);
    if (!/^[A-Za-z0-9+/=_-]{3,128}$/.test(keyId)) throw invalid('accessKeyId');
    config = { endpoint: u.origin + u.pathname.replace(/\/+$/, ''), region, bucket, prefix: folderPath(i.prefix, 'prefix'),
      pathStyle: i.pathStyle !== false, accessKeyId: keyId, tlsCa: tlsCa(i.tlsCa) };
  }
  const secret = Object.assign({}, prev || {});
  for (const f of SECRET_FIELDS[kind]) {
    const v = i[f];
    if (v == null || v === '') continue;
    if (typeof v !== 'string' || v.length > 512 || /[\n\r\u0000]/.test(v)) throw invalid(f);
    secret[f] = v;
  }
  for (const f of SECRET_FIELDS[kind]) {
    if (f === 'password' && kind !== 's3') continue; // an SMB / WebDAV account may have no password
    if (!secret[f]) throw invalid(f, `${f} is required`);
  }
  return { label, config, secret };
}

/**
 * Google Drive / OneDrive: { draft (a freshly connected account, cloudAccounts.draft),
 * folderId, folderPath, driveId (OneDrive) } — a new target needs a draft, an
 * existing one keeps its token (`prev`) unless a draft connects it again.
 */
function normaliseCloud(kind, i, label, prev) {
  const cloud = require('../cloudAccounts');
  let secret = prev && prev.refresh ? Object.assign({}, prev) : null;
  let account = str(i.account) || null;
  if (i.draft != null && i.draft !== '') {
    const d = cloud.draft(String(i.draft));
    if (!d || d.provider !== CLOUD[kind]) throw invalid('draft', 'connect the account again');
    secret = Object.assign({}, d.token);
    account = d.account;
  }
  if (!secret) throw invalid('draft', 'connect the account first');
  const folderId = str(i.folderId);
  if (!CLOUD_ID_RE[kind].test(folderId)) throw invalid('folderId');
  const folderPath = str(i.folderPath).slice(0, 400).replace(/[\u0000-\u001f]/g, '') || '/';
  const config = { account: (account || '').slice(0, 200), folderId, folderPath };
  if (kind === 'onedrive') {
    const driveId = str(i.driveId);
    if (driveId && !CLOUD_ID_RE.onedrive.test(driveId)) throw invalid('folderId');
    config.driveId = driveId || null;
  }
  return { label, config, secret };
}

// ─── Rows ───────────────────────────────────────

function rowOf(id) {
  const n = Number(id);
  return Number.isSafeInteger(n) ? getDb().prepare('SELECT * FROM storage_targets WHERE id = ?').get(n) || null : null;
}

function configOf(row) {
  try { return JSON.parse(row.config_json || '{}'); } catch { return {}; }
}

/** The stored secret fields, {} when none / not decryptable (another GC_ENCRYPTION_KEY). */
function secretOf(row) {
  if (!row.secret_enc) return {};
  try { return JSON.parse(decrypt(String(row.secret_enc))); } catch { return {}; }
}

/** A short address for lists ("smb://nas/drive/Familie"). */
function display(kind, cfg) {
  if (kind === 'local') return cfg.path;
  if (kind === 'webdav') return cfg.url;
  if (kind === 's3') return `${cfg.endpoint.replace(/^https?:\/\//, '')}/${cfg.bucket}${cfg.prefix ? '/' + cfg.prefix : ''}`;
  if (CLOUD[kind]) return `${kind === 'gdrive' ? 'Google Drive' : 'OneDrive'} · ${cfg.account || '?'} · ${cfg.folderPath || '/'}`;
  const v = cfg.via || {};
  let host = v.host;
  if (v.kind === 'peer') {
    const p = getDb().prepare('SELECT name FROM peers WHERE id = ?').get(v.peerId);
    host = p ? p.name : `#${v.peerId}`;
  } else if (v.kind === 'route') {
    const r = getDb().prepare('SELECT domain, l4_listen_port FROM routes WHERE id = ?').get(v.routeId);
    host = r ? `${r.domain || 'L4'}:${r.l4_listen_port}` : `#${v.routeId}`;
  }
  return `smb://${host}${v.kind !== 'route' && v.port && v.port !== 445 ? ':' + v.port : ''}/${cfg.share}${cfg.folder ? '/' + cfg.folder : ''}`;
}

// what keeps a target in use (plugins/mediaAreas.js registers the areas assigned to it)
const usageProviders = [];
function registerUsage(fn) { usageProviders.push(fn); }

/** [{ kind: 'area', plugin, area, label }] — what uses target `id`. */
function usedBy(id) {
  const out = [];
  // the media areas register themselves when loaded — make sure they are
  try { require('../plugins/mediaAreas'); } catch (e) { logger.warn({ err: e.message }, 'media areas not loaded'); }
  for (const fn of usageProviders) {
    try { out.push(...(fn(Number(id)) || [])); } catch (e) { logger.warn({ err: e.message }, 'storage target usage lookup failed'); }
  }
  return out;
}

/** The certificates of a target's own trust anchor, for the page. */
function caInfo(pem) {
  if (!pem) return null;
  try { return net.parseCa(pem).map((c) => ({ subject: c.subject, fingerprint: c.fingerprint, validTo: c.validTo })); } catch { return null; }
}

/** What the admin API answers for a row — never a secret. */
function view(row) {
  const cfg = configOf(row);
  const sec = secretOf(row);
  const secretSet = {};
  for (const f of SECRET_FIELDS[row.kind] || []) secretSet[f] = !!sec[f];
  const pub = Object.assign({}, cfg);
  return {
    id: row.id, kind: row.kind, label: row.label, config: pub, secretSet,
    needsSecret: !!row.secret_enc && !Object.keys(sec).length,
    display: display(row.kind, cfg),
    tlsCaInfo: caInfo(cfg.tlsCa),
    encrypted: BLOCKS_ONLY.has(row.kind),
    ranges: row.kind !== 'smb',
    check: row.checked_at ? { at: row.checked_at, ok: row.check_ok === 1, error: row.check_error || null,
      free: row.free_bytes == null ? null : row.free_bytes, total: row.total_bytes == null ? null : row.total_bytes } : null,
    usedBy: usedBy(row.id),
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function list() {
  return getDb().prepare('SELECT * FROM storage_targets ORDER BY label COLLATE NOCASE, id').all().map(view);
}

function get(id) {
  const r = rowOf(id);
  return r ? view(r) : null;
}

function create(kind, input) {
  if (getDb().prepare('SELECT COUNT(*) AS n FROM storage_targets').get().n >= MAX_TARGETS) throw new StorageError('limit', 'too many storage targets');
  const { label, config, secret } = normalise(kind, input);
  const r = getDb().prepare(`INSERT INTO storage_targets (kind, label, config_json, secret_enc) VALUES (?, ?, ?, ?)`)
    .run(kind, label, JSON.stringify(config), Object.keys(secret).length ? encrypt(JSON.stringify(secret)) : null);
  return get(r.lastInsertRowid);
}

/**
 * Change a target. The kind stays; a secret field left empty keeps the
 * stored one. Changing where it points (path, host, share, URL, bucket …)
 * is refused while an area uses it — files would be lost from view.
 */
function update(id, input) {
  const row = rowOf(id);
  if (!row) throw new StorageError('not_found', 'no such storage target');
  const { label, config, secret } = normalise(row.kind, input, secretOf(row));
  const before = configOf(row);
  const moved = JSON.stringify(placeOf(row.kind, before)) !== JSON.stringify(placeOf(row.kind, config));
  if (moved && usedBy(row.id).length) throw new StorageError('in_use', 'in use: the place cannot change');
  getDb().prepare(`UPDATE storage_targets SET label = ?, config_json = ?, secret_enc = ?, updated_at = datetime('now'),
    checked_at = CASE WHEN ? THEN NULL ELSE checked_at END WHERE id = ?`)
    .run(label, JSON.stringify(config), Object.keys(secret).length ? encrypt(JSON.stringify(secret)) : null, moved ? 1 : 0, row.id);
  return get(row.id);
}

/** The settings that say WHERE the files are (not how to sign in). */
function placeOf(kind, cfg) {
  if (kind === 'local') return [cfg.path];
  if (kind === 'smb') return [cfg.via, cfg.share, cfg.folder];
  if (kind === 'webdav') return [cfg.url];
  if (CLOUD[kind]) return [cfg.account, cfg.driveId || null, cfg.folderId];
  return [cfg.endpoint, cfg.bucket, cfg.prefix, cfg.pathStyle];
}

function remove(id) {
  const row = rowOf(id);
  if (!row) return false;
  if (usedBy(row.id).length) throw new StorageError('in_use', 'still in use');
  getDb().prepare('DELETE FROM storage_targets WHERE id = ?').run(row.id);
  return true;
}

// ─── Drivers ────────────────────────────────────

/** SMB: the address and port to dial for `via` (peer IP, L4 route listener). */
function smbDial(v) {
  if (v.kind === 'host') return { host: v.host, port: v.port || 445 };
  if (v.kind === 'peer') {
    const p = getDb().prepare('SELECT allowed_ips, enabled FROM peers WHERE id = ?').get(v.peerId);
    if (!p || p.enabled !== 1) throw new StorageError('unreachable', 'the peer is missing or switched off');
    return { host: String(p.allowed_ips || '').split(',')[0].split('/')[0].trim(), port: v.port || 445 };
  }
  const r = require('../routes').getById(v.routeId);
  if (!r || !r.enabled || r.route_type !== 'l4') throw new StorageError('unreachable', 'the route is missing or switched off');
  if (r.target_kind === 'gateway' && r.target_peer_ip) return { host: String(r.target_peer_ip).split('/')[0], port: Number(r.l4_listen_port) };
  if (r.peer_id) {
    const p = getDb().prepare('SELECT allowed_ips FROM peers WHERE id = ?').get(r.peer_id);
    return { host: p ? String(p.allowed_ips || '').split(',')[0].split('/')[0].trim() : null, port: Number(r.target_port) };
  }
  return { host: r.target_ip, port: Number(r.target_port) };
}

function driverModule(kind) {
  switch (kind) {
    case 'local': return require('./drivers/local');
    case 'smb': return require('./drivers/smb');
    case 'webdav': return require('./drivers/webdav');
    case 's3': return require('./drivers/s3');
    case 'gdrive': return require('./drivers/gdrive');
    case 'onedrive': return require('./drivers/onedrive');
    default: throw new StorageError('invalid', 'unknown kind', { field: 'kind' });
  }
}

/** A driver for a stored row or for a { kind, config, secret } not saved yet. */
async function driverOf(t) {
  const kind = t.kind;
  const cfg = t.config || configOf(t);
  const sec = t.secret || secretOf(t);
  if (t.secret_enc && !Object.keys(sec).length) throw new StorageError('auth', 'the stored secret cannot be decrypted — enter it again');
  const c = Object.assign({}, cfg);
  if (kind === 'smb') {
    const d = smbDial(cfg.via);
    if (!d.host || !d.port) throw new StorageError('unreachable', 'no address');
    try { c.dial = { address: (await net.resolve(d.host, d.port)).address, port: d.port }; } catch (e) { throw StorageError.from(e); }
  }
  if (CLOUD[kind]) {
    if (!sec.refresh) throw new StorageError('auth', 'the account has to be connected again');
    // a refreshed token is kept: on the row of a stored target, else in the settings being checked
    const id = t.id;
    c.saveToken = (tok) => {
      if (id) getDb().prepare('UPDATE storage_targets SET secret_enc = ? WHERE id = ?').run(encrypt(JSON.stringify(tok)), id);
      else if (t.secret) Object.assign(t.secret, tok);
    };
  }
  return driverModule(kind).create(c, sec);
}

/** The driver of target `id` (throws not_found). */
async function open(id) {
  const row = rowOf(id);
  if (!row) throw new StorageError('not_found', 'no such storage target');
  return driverOf(row);
}

/** A readable over a Buffer for driver.put. */
function bufferSource(buf) {
  const { Readable } = require('node:stream');
  return { length: buf.length, open: (start, end) => Readable.from([buf.subarray(start, end + 1)]) };
}

async function collect(stream) {
  const parts = [];
  for await (const c of stream) parts.push(c);
  return Buffer.concat(parts);
}

/**
 * Check a target: reach it, write a test file, read it back whole and as a
 * range, delete it, ask for the free space.
 * → { ok, error: code|null, message, free, total, steps: [{ step, ok }] }
 */
async function runCheck(t) {
  const steps = [];
  const step = async (name, fn) => {
    try { const v = await fn(); steps.push({ step: name, ok: true }); return v; } catch (e) {
      steps.push({ step: name, ok: false });
      throw StorageError.from(e);
    }
  };
  const key = `.gatecontrol-check-${crypto.randomBytes(8).toString('hex')}`;
  const data = crypto.randomBytes(CHECK_BYTES);
  let d;
  let written = false;
  try {
    d = await step('connect', () => driverOf(t));
    await step('folder', () => d.prepare());
    await step('write', async () => { await d.put(key, bufferSource(data)); written = true; });
    await step('read', async () => {
      const h = await d.head(key);
      if (!h || h.size !== data.length) throw new StorageError('failed', 'the test file has the wrong size');
      const back = await collect(await d.get(key, null));
      if (!back.equals(data)) throw new StorageError('failed', 'the test file came back different');
      const part = await collect(await d.get(key, { start: 65530, end: 65540 }));
      if (!part.equals(data.subarray(65530, 65541))) throw new StorageError('failed', 'a part of the test file came back different');
    });
    await step('delete', async () => { await d.remove(key); written = false; });
    const s = await d.space();
    return { ok: true, error: null, message: null, free: s.free, total: s.total, steps };
  } catch (e) {
    if (written && d) { try { await d.remove(key); } catch { /* best effort */ } }
    const err = StorageError.from(e);
    return { ok: false, error: err.code, message: err.message, free: null, total: null, steps };
  }
}

/** Check a stored target and keep the result on its row. */
async function check(id) {
  const row = rowOf(id);
  if (!row) throw new StorageError('not_found', 'no such storage target');
  const r = await runCheck(row);
  getDb().prepare(`UPDATE storage_targets SET checked_at = datetime('now'), check_ok = ?, check_error = ?, free_bytes = ?, total_bytes = ? WHERE id = ?`)
    .run(r.ok ? 1 : 0, r.ok ? null : `${r.error}: ${String(r.message || '').slice(0, 300)}`, r.free, r.total, row.id);
  return r;
}

/** Check settings before they are saved ("Prüfen" in the dialog); for an existing target its stored secret fills the gaps. */
async function checkInput(kind, input, id = null) {
  const prev = id ? rowOf(id) : null;
  if (id && (!prev || prev.kind !== kind)) throw new StorageError('not_found', 'no such storage target');
  const { config, secret } = normalise(kind, input, prev ? secretOf(prev) : null);
  return runCheck({ kind, config, secret });
}

module.exports = {
  KINDS, SECRET_FIELDS, BLOCKS_ONLY, CLOUD, StorageError, normalise, list, get, create, update, remove, check, checkInput, open, driverOf,
  registerUsage, usedBy, display, bufferSource, rowOf, configOf, secretOf,
};
