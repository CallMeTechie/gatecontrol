'use strict';

// The plugin registry (tables plugins, plugin_licenses, plugin_logs — migration 91).

const { getDb } = require('../../db/connection');
const { LIMITS } = require('./constants');

function rowToPlugin(r) {
  if (!r) return null;
  let manifest = null;
  try { manifest = JSON.parse(r.manifest); } catch { manifest = null; }
  return {
    id: r.id,
    name: r.name,
    version: r.version,
    publisher: r.publisher,
    manifest,
    signature: r.signature,          // 'trusted' | 'untrusted' | 'none'
    signerKey: r.signer_key || null,
    enabled: r.enabled === 1,
    statusReason: r.status_reason || null,
    installedAt: r.installed_at,
    updatedAt: r.updated_at,
  };
}

function list() {
  return getDb().prepare('SELECT * FROM plugins ORDER BY name COLLATE NOCASE').all().map(rowToPlugin);
}

function get(id) {
  return rowToPlugin(getDb().prepare('SELECT * FROM plugins WHERE id = ?').get(id));
}

function upsert({ manifest, signature, signerKey, enabled }) {
  const db = getDb();
  const name = typeof manifest.name === 'string' ? manifest.name : (manifest.name.de || manifest.name.en);
  const exists = db.prepare('SELECT 1 FROM plugins WHERE id = ?').get(manifest.id);
  if (exists) {
    db.prepare(`UPDATE plugins SET name = ?, version = ?, publisher = ?, manifest = ?, signature = ?, signer_key = ?,
      enabled = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(name, manifest.version, manifest.publisher, JSON.stringify(manifest), signature, signerKey || null, enabled ? 1 : 0, manifest.id);
  } else {
    db.prepare(`INSERT INTO plugins (id, name, version, publisher, manifest, signature, signer_key, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(manifest.id, name, manifest.version, manifest.publisher, JSON.stringify(manifest), signature, signerKey || null, enabled ? 1 : 0);
  }
  return get(manifest.id);
}

function setEnabled(id, enabled) {
  getDb().prepare("UPDATE plugins SET enabled = ?, updated_at = datetime('now') WHERE id = ?").run(enabled ? 1 : 0, id);
}

function setStatusReason(id, reason) {
  getDb().prepare('UPDATE plugins SET status_reason = ? WHERE id = ?').run(reason || null, id);
}

function remove(id) {
  const db = getDb();
  db.prepare('DELETE FROM plugins WHERE id = ?').run(id);
  db.prepare('DELETE FROM plugin_logs WHERE plugin_id = ?').run(id);
}

// ─── Licences (third-party) ─────────────────────

function getLicense(id) {
  const r = getDb().prepare('SELECT * FROM plugin_licenses WHERE plugin_id = ?').get(id);
  if (!r) return null;
  let state = null;
  try { state = r.state ? JSON.parse(r.state) : null; } catch { state = null; }
  return { keyEncrypted: r.key_encrypted || null, state };
}

function setLicense(id, { keyEncrypted, state }) {
  const db = getDb();
  const cur = getLicense(id);
  const key = keyEncrypted !== undefined ? keyEncrypted : (cur ? cur.keyEncrypted : null);
  const st = state !== undefined ? state : (cur ? cur.state : null);
  db.prepare(`INSERT INTO plugin_licenses (plugin_id, key_encrypted, state, updated_at) VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(plugin_id) DO UPDATE SET key_encrypted = excluded.key_encrypted, state = excluded.state, updated_at = excluded.updated_at`)
    .run(id, key, st ? JSON.stringify(st) : null);
}

function removeLicense(id) {
  getDb().prepare('DELETE FROM plugin_licenses WHERE plugin_id = ?').run(id);
}

// ─── Logs ───────────────────────────────────────

const LEVELS = new Set(['debug', 'info', 'warn', 'error']);

function addLog(id, level, message) {
  const db = getDb();
  const lvl = LEVELS.has(level) ? level : 'info';
  const msg = String(message == null ? '' : message).replace(/[\0-\x08\x0b-\x1f\x7f]/g, ' ').slice(0, 1000);
  db.prepare('INSERT INTO plugin_logs (plugin_id, level, message, created_at) VALUES (?, ?, ?, ?)').run(id, lvl, msg, Date.now());
  // keep the newest N per plugin
  db.prepare(`DELETE FROM plugin_logs WHERE plugin_id = ? AND id <= (
      SELECT id FROM plugin_logs WHERE plugin_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?)`).run(id, id, LIMITS.logEntriesPerPlugin);
}

function logs(id, limit = 200) {
  return getDb().prepare('SELECT level, message, created_at FROM plugin_logs WHERE plugin_id = ? ORDER BY id DESC LIMIT ?')
    .all(id, Math.max(1, Math.min(500, limit)));
}

module.exports = { list, get, upsert, setEnabled, setStatusReason, remove, getLicense, setLicense, removeLicense, addLog, logs };
