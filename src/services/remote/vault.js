'use strict';

// The key vault of gc.remote (docs/plugins.md "Remote access"): passwords and
// SSH keys of remote targets, encrypted with the server key (utils/crypto,
// AES-256-GCM) in the core table remote_vault. A plugin only ever holds a
// HANDLE ("rv_" + 32 hex). Nothing here hands a secret back to a plugin:
// put / info / list / remove answer metadata (which fields are set), and
// resolve() — the plaintext — is for the core alone (session tokens of
// guacd, the ECDH answer of the old app API).

const crypto = require('node:crypto');
const { encrypt, decrypt } = require('../../utils/crypto');

const HANDLE_RE = /^rv_[0-9a-f]{32}$/;
// field → maximum length (characters)
const FIELDS = Object.freeze({ username: 256, password: 1024, domain: 256, privateKey: 16384, passphrase: 1024 });
const LABEL_MAX = 120;
const SOURCE_MAX = 120;
const PER_PLUGIN_MAX = 5000;

class VaultError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

function db() { return require('../../db/connection').getDb(); }

function isHandle(h) { return typeof h === 'string' && HANDLE_RE.test(h); }

function newHandle() { return 'rv_' + crypto.randomBytes(16).toString('hex'); }

/** The secret fields of a put: undefined = not given, null / '' = cleared, a string = set. */
function cleanFields(input) {
  const o = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const out = {};
  for (const [k, max] of Object.entries(FIELDS)) {
    const v = o[k];
    if (v === undefined) continue;
    if (v === null || v === '') { out[k] = null; continue; }
    if (typeof v !== 'string' || v.length > max) throw new VaultError('invalid', `${k}: a string of at most ${max} characters`);
    out[k] = v;
  }
  return out;
}

function kindOf(secret) {
  if (secret.privateKey) return 'ssh_key';
  if (secret.password) return 'password';
  return 'username';
}

function decryptRow(row) {
  try {
    const v = JSON.parse(decrypt(row.secret_enc));
    return v && typeof v === 'object' ? v : null;
  } catch { return null; }
}

/** Metadata only — never a value. */
function metaOf(row, secret = decryptRow(row)) {
  const has = {};
  for (const k of Object.keys(FIELDS)) has[k] = !!(secret && secret[k]);
  return {
    handle: row.handle,
    kind: secret ? kindOf(secret) : 'unreadable',
    label: row.label || null,
    has,
    // the server key changed since the entry was written (a restore from another server): enter it again
    readable: !!secret,
    // the public half of a key made by generate() (version 3) — public by nature, for authorized_keys
    publicKey: secret && typeof secret.publicKey === 'string' ? secret.publicKey : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowOf(pluginId, handle) {
  if (!isHandle(handle)) return null;
  return db().prepare('SELECT * FROM remote_vault WHERE handle = ? AND plugin_id = ?').get(handle, pluginId) || null;
}

function labelOf(v) {
  if (v == null || v === '') return null;
  if (typeof v !== 'string' || v.length > LABEL_MAX) throw new VaultError('invalid', `label: at most ${LABEL_MAX} characters`);
  return v;
}

/**
 * gc.remote.vault.put({ username?, password?, domain?, privateKey?, passphrase?, label?, handle? })
 * New entry, or (with `handle` of this plugin) a change: fields not given stay, null / '' clears.
 * → metadata { handle, kind, label, has, readable, createdAt, updatedAt }
 */
function put(pluginId, input, { source = null } = {}) {
  const o = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const fields = cleanFields(o);
  const label = o.label === undefined ? undefined : labelOf(o.label);
  const now = new Date().toISOString();
  let row = null;
  if (o.handle != null) {
    row = rowOf(pluginId, o.handle);
    if (!row) throw new VaultError('not_found', 'no such vault entry of this plugin');
  } else if (source) {
    row = db().prepare('SELECT * FROM remote_vault WHERE plugin_id = ? AND source = ?').get(pluginId, source) || null;
  }
  if (row) {
    const old = decryptRow(row) || {};
    const next = { ...old };
    for (const [k, v] of Object.entries(fields)) { if (v == null) delete next[k]; else next[k] = v; }
    // a key given by hand replaces a generated one: its public half no longer fits
    if (fields.privateKey !== undefined) delete next.publicKey;
    if (!Object.keys(next).length) throw new VaultError('invalid', 'an entry needs at least one value');
    db().prepare('UPDATE remote_vault SET secret_enc = ?, label = ?, updated_at = ? WHERE handle = ?')
      .run(encrypt(JSON.stringify(next)), label === undefined ? row.label : label, now, row.handle);
    return metaOf(db().prepare('SELECT * FROM remote_vault WHERE handle = ?').get(row.handle), next);
  }
  const secret = {};
  for (const [k, v] of Object.entries(fields)) if (v != null) secret[k] = v;
  if (!Object.keys(secret).length) throw new VaultError('invalid', 'an entry needs at least one value');
  const n = db().prepare('SELECT COUNT(*) AS c FROM remote_vault WHERE plugin_id = ?').get(pluginId).c;
  if (n >= PER_PLUGIN_MAX) throw new VaultError('limit', `at most ${PER_PLUGIN_MAX} vault entries per plugin`);
  const handle = newHandle();
  db().prepare(`INSERT INTO remote_vault (handle, plugin_id, label, source, secret_enc, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(handle, pluginId, label || null, source ? String(source).slice(0, SOURCE_MAX) : null, encrypt(JSON.stringify(secret)), now, now);
  return metaOf(db().prepare('SELECT * FROM remote_vault WHERE handle = ?').get(handle), secret);
}

/**
 * gc.remote.vault.generate({ kind: 'ed25519', label?, username?, handle? }) → metadata + publicKey
 * A new SSH key pair made in the core: the private key goes into the vault (a new entry, or the
 * entry `handle` — its old key and passphrase are replaced, username and password stay), the
 * plugin gets the public key to show for authorized_keys. Never the private key.
 */
function generate(pluginId, input) {
  const o = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const kind = o.kind == null ? 'ed25519' : String(o.kind);
  if (kind !== 'ed25519') throw new VaultError('invalid', 'kind: ed25519');
  if (o.username != null && (typeof o.username !== 'string' || o.username.length > FIELDS.username)) throw new VaultError('invalid', 'username: a string');
  const label = o.label === undefined ? undefined : labelOf(o.label);
  const pair = require('./sshkeys').generateEd25519(label || 'gatecontrol');
  const entry = { privateKey: pair.privateKey, passphrase: null };
  if (o.username) entry.username = o.username;
  if (label !== undefined) entry.label = label;
  if (o.handle != null) entry.handle = o.handle;
  const meta = put(pluginId, entry);
  const row = rowOf(pluginId, meta.handle);
  const secret = decryptRow(row) || {};
  secret.publicKey = pair.publicKey;
  db().prepare('UPDATE remote_vault SET secret_enc = ?, updated_at = ? WHERE handle = ?').run(encrypt(JSON.stringify(secret)), new Date().toISOString(), meta.handle);
  return { ...metaOf(db().prepare('SELECT * FROM remote_vault WHERE handle = ?').get(meta.handle), secret), fingerprint: pair.fingerprint };
}

/** gc.remote.vault.remove(handle) → { removed } */
function remove(pluginId, handle) {
  if (!isHandle(handle)) throw new VaultError('invalid', 'invalid handle');
  const r = db().prepare('DELETE FROM remote_vault WHERE handle = ? AND plugin_id = ?').run(handle, pluginId);
  return { removed: r.changes > 0 };
}

/** gc.remote.vault.info(handle) → metadata | null */
function info(pluginId, handle) {
  if (!isHandle(handle)) throw new VaultError('invalid', 'invalid handle');
  const row = rowOf(pluginId, handle);
  return row ? metaOf(row) : null;
}

/** gc.remote.vault.list() → [metadata] */
function list(pluginId) {
  return db().prepare('SELECT * FROM remote_vault WHERE plugin_id = ? ORDER BY created_at, handle').all(pluginId).map((r) => metaOf(r));
}

/**
 * CORE ONLY — the plaintext of an entry ({ username, password, domain, privateKey, passphrase }
 * as stored), or null (unknown handle, another plugin's handle, unreadable). Never returned
 * through the host API.
 */
function resolve(pluginId, handle) {
  const row = rowOf(pluginId, handle);
  if (!row) return null;
  const s = decryptRow(row);
  return s ? { ...s } : null;
}

/** Everything of a plugin ("Alles löschen"). */
function forget(pluginId) {
  try { db().prepare('DELETE FROM remote_vault WHERE plugin_id = ?').run(pluginId); } catch { /* table missing */ }
}

// ─── Backup (services/backup.js) ─────────────────
// Rows as stored: the ciphertext of this server key. A restore onto a server
// with another key keeps them; they read `readable: false` until entered again.

function exportBackup() {
  try { return db().prepare('SELECT handle, plugin_id, label, source, secret_enc, created_at, updated_at FROM remote_vault ORDER BY plugin_id, handle').all(); } catch { return null; }
}

function restoreBackup(rows) {
  if (!Array.isArray(rows)) return 0;
  const q = db();
  q.prepare('DELETE FROM remote_vault').run();
  const ins = q.prepare(`INSERT OR IGNORE INTO remote_vault (handle, plugin_id, label, source, secret_enc, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  let n = 0;
  for (const r of rows) {
    if (!r || !isHandle(r.handle) || typeof r.plugin_id !== 'string' || r.plugin_id.length > 64 || typeof r.secret_enc !== 'string' || r.secret_enc.length > 64000) continue;
    const str = (v, max) => (typeof v === 'string' && v.length <= max ? v : null);
    const now = new Date().toISOString();
    ins.run(r.handle, r.plugin_id, str(r.label, LABEL_MAX), str(r.source, SOURCE_MAX), r.secret_enc, str(r.created_at, 40) || now, str(r.updated_at, 40) || now);
    n++;
  }
  return n;
}

module.exports = { put, generate, remove, info, list, resolve, forget, exportBackup, restoreBackup, isHandle, VaultError, FIELDS, HANDLE_RE };
