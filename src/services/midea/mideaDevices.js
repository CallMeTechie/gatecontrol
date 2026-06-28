'use strict';

const { getDb } = require('../../db/connection');
const settings = require('../settings');
const { encrypt, decrypt } = require('../../utils/crypto');
const mideaOwners = require('./mideaOwners');

const CONFIG_KEY = 'midea_config';
const DEFAULT_CONFIG = { app: 'msmarthome', email: '', password: '', session: null };

// Shared non-secret column mapping. Deliberately omits token/key so the
// redacted path never touches ciphertext (and never throws on corrupt data).
function rowToPublic(row) {
  return {
    id: row.id,
    name: row.name,
    device_sn: row.device_sn,
    device_id: row.device_id,
    ip: row.ip,
    port: row.port,
    protocol_version: row.protocol_version,
    model: row.model,
    enabled: row.enabled === 1,
    transport: row.transport,
    cloud_appliance_id: row.cloud_appliance_id,
    last_seen_at: row.last_seen_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function rowToDevice(row) {
  if (!row) return null;
  return {
    ...rowToPublic(row),
    token: row.token_enc ? decrypt(row.token_enc) : null,
    key: row.key_enc ? decrypt(row.key_enc) : null,
  };
}

function listDevices() {
  return getDb().prepare('SELECT * FROM midea_devices ORDER BY id').all().map(rowToDevice);
}

function getDevice(id) {
  return rowToDevice(getDb().prepare('SELECT * FROM midea_devices WHERE id = ?').get(id));
}

// Reads raw rows and computes has_credentials from the encrypted columns
// WITHOUT decrypting — safe even if a stored ciphertext is corrupted.
function listDevicesRedacted() {
  return getDb().prepare('SELECT * FROM midea_devices ORDER BY id').all().map((row) => ({
    ...rowToPublic(row),
    has_credentials: Boolean(row.token_enc && row.key_enc),
  }));
}

function createDevice(data) {
  const db = getDb();
  const info = db.prepare(`
    INSERT INTO midea_devices
      (name, device_sn, device_id, ip, port, protocol_version, token_enc, key_enc, model, enabled, transport, cloud_appliance_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    data.name,
    data.device_sn,
    data.device_id ?? null,
    data.ip ?? null,
    data.port ?? 6444,
    data.protocol_version ?? 3,
    data.token ? encrypt(data.token) : null,
    data.key ? encrypt(data.key) : null,
    data.model ?? null,
    data.enabled === false ? 0 : 1,
    data.transport ?? 'lan',
    data.cloud_appliance_id ?? null,
  );
  return getDevice(info.lastInsertRowid);
}

const FIELD_MAP = { name: 'name', ip: 'ip', port: 'port', model: 'model', device_id: 'device_id', last_seen_at: 'last_seen_at', transport: 'transport', cloud_appliance_id: 'cloud_appliance_id' };

function updateDevice(id, patch) {
  const db = getDb();
  const sets = [];
  const vals = [];
  for (const [k, col] of Object.entries(FIELD_MAP)) {
    if (k in patch) { sets.push(`${col} = ?`); vals.push(patch[k]); }
  }
  if ('enabled' in patch) { sets.push('enabled = ?'); vals.push(patch.enabled ? 1 : 0); }
  if ('token' in patch) { sets.push('token_enc = ?'); vals.push(patch.token ? encrypt(patch.token) : null); }
  if ('key' in patch) { sets.push('key_enc = ?'); vals.push(patch.key ? encrypt(patch.key) : null); }
  if (sets.length) {
    sets.push("updated_at = datetime('now')");
    db.prepare(`UPDATE midea_devices SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
  }
  return getDevice(id);
}

function removeDevice(id) {
  const db = getDb();
  db.transaction(() => {
    mideaOwners.removeAllForDevice(id);               // child first (no own tx)
    db.prepare('DELETE FROM midea_devices WHERE id = ?').run(id);
  })();
  return { ok: true };
}

function loadConfig() {
  const raw = settings.get(CONFIG_KEY);
  if (!raw) return { ...DEFAULT_CONFIG };
  const parsed = JSON.parse(raw);
  // session is an OBJECT stored as encrypt(JSON.stringify(...)). A malformed
  // or legacy (pre-encryption) value must not brick loadConfig — null it so
  // the app simply re-logs in.
  let session = null;
  if (parsed.session) {
    try { session = JSON.parse(decrypt(parsed.session)); } catch { session = null; }
  }
  return {
    ...DEFAULT_CONFIG,
    ...parsed,
    password: parsed.password ? decrypt(parsed.password) : '',
    session,
  };
}

function saveConfig(cfg) {
  const toStore = {
    app: cfg.app || 'msmarthome',
    email: cfg.email || '',
    password: cfg.password ? encrypt(cfg.password) : '',
    session: cfg.session ? encrypt(JSON.stringify(cfg.session)) : null,
  };
  settings.set(CONFIG_KEY, JSON.stringify(toStore));
}

function redactConfig(cfg) {
  const { password, session, ...rest } = cfg;
  return { ...rest, password_set: Boolean(password), session_active: Boolean(session) };
}

module.exports = {
  CONFIG_KEY,
  listDevices, getDevice, listDevicesRedacted,
  createDevice, updateDevice, removeDevice,
  loadConfig, saveConfig, redactConfig,
};
