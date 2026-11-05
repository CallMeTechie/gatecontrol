'use strict';

// Tables of the edge parts (migration 127): gateway switches, plugin ×
// gateway assignments, the log/event ring buffer and the hello / status
// the gateway reported. Plain reads and writes — the rules live in
// services/edge/index.js (admin), state.js (what a gateway should run) and
// hub.js (the connection).

const { getDb } = require('../../db/connection');

// newest entries kept per gateway × plugin (and per gateway for plugin-less notes)
const LOG_KEEP = 500;
const LOG_LINE_MAX = 2048;
const LOG_LEVELS = new Set(['info', 'warn', 'error']);
const LOG_KINDS = new Set(['log', 'event', 'system']);

function db() { return getDb(); }

function json(s, fallback = null) {
  if (s == null) return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
}

/** Is `peerId` an enabled gateway peer? → { id, name } | null */
function gatewayPeer(peerId) {
  const id = Number(peerId);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return db().prepare(`SELECT p.id, p.name FROM peers p JOIN gateway_meta gm ON gm.peer_id = p.id
    WHERE p.id = ? AND p.peer_type = 'gateway' AND p.enabled = 1`).get(id) || null;
}

function gatewayPeers() {
  return db().prepare(`SELECT p.id, p.name FROM peers p JOIN gateway_meta gm ON gm.peer_id = p.id
    WHERE p.peer_type = 'gateway' AND p.enabled = 1 ORDER BY p.name COLLATE NOCASE`).all();
}

const DEFAULTS = Object.freeze({ edgeEnabled: false, mqttEnabled: false, mqttTls: false, allowUnsignedEdge: false });

function settings(peerId) {
  const r = db().prepare('SELECT * FROM gateway_edge WHERE peer_id = ?').get(peerId);
  if (!r) return { ...DEFAULTS, hello: null, helloAt: null, mqttStatus: null, statusAt: null };
  return {
    edgeEnabled: r.edge_enabled === 1, mqttEnabled: r.mqtt_enabled === 1, mqttTls: r.mqtt_tls === 1, allowUnsignedEdge: r.allow_unsigned_edge === 1,
    hello: json(r.hello), helloAt: r.hello_at || null, mqttStatus: json(r.mqtt_status), statusAt: r.status_at || null,
  };
}

function ensureRow(peerId) {
  db().prepare('INSERT OR IGNORE INTO gateway_edge (peer_id, updated_at) VALUES (?, ?)').run(peerId, Date.now());
}

const SETTING_COLS = { edgeEnabled: 'edge_enabled', mqttEnabled: 'mqtt_enabled', mqttTls: 'mqtt_tls', allowUnsignedEdge: 'allow_unsigned_edge' };

/** Write the given boolean switches. */
function setSettings(peerId, patch) {
  ensureRow(peerId);
  for (const [k, col] of Object.entries(SETTING_COLS)) {
    if (typeof patch[k] !== 'boolean') continue;
    db().prepare(`UPDATE gateway_edge SET ${col} = ?, updated_at = ? WHERE peer_id = ?`).run(patch[k] ? 1 : 0, Date.now(), peerId);
  }
  return settings(peerId);
}

function setHello(peerId, hello) {
  ensureRow(peerId);
  db().prepare('UPDATE gateway_edge SET hello = ?, hello_at = ? WHERE peer_id = ?').run(JSON.stringify(hello), Date.now(), peerId);
}

function setMqttStatus(peerId, st) {
  ensureRow(peerId);
  db().prepare('UPDATE gateway_edge SET mqtt_status = ?, status_at = ? WHERE peer_id = ?').run(JSON.stringify(st), Date.now(), peerId);
}

// ─── Assignments ────────────────────────────────

function rowToAssignment(r) {
  if (!r) return null;
  return {
    pluginId: r.plugin_id, peerId: r.peer_id, enabled: r.enabled === 1,
    caps: json(r.caps, {}), capsList: json(r.caps_list, []), capsVersion: r.caps_version || null,
    approvedAt: r.approved_at || null, approvedBy: r.approved_by || null,
    status: json(r.status), statusAt: r.status_at || null, createdAt: r.created_at,
  };
}

function assignment(pluginId, peerId) {
  return rowToAssignment(db().prepare('SELECT * FROM edge_assignments WHERE plugin_id = ? AND peer_id = ?').get(pluginId, peerId));
}

function assignmentsOfGateway(peerId) {
  return db().prepare('SELECT * FROM edge_assignments WHERE peer_id = ? ORDER BY plugin_id').all(peerId).map(rowToAssignment);
}

function assignmentsOfPlugin(pluginId) {
  return db().prepare('SELECT * FROM edge_assignments WHERE plugin_id = ? ORDER BY peer_id').all(pluginId).map(rowToAssignment);
}

/** Switch on with the approved capability snapshot. */
function approve(pluginId, peerId, { caps, capsList, version, by }) {
  const now = Date.now();
  db().prepare(`INSERT INTO edge_assignments (plugin_id, peer_id, enabled, caps, caps_list, caps_version, approved_at, approved_by, created_at)
    VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(plugin_id, peer_id) DO UPDATE SET enabled = 1, caps = excluded.caps, caps_list = excluded.caps_list,
      caps_version = excluded.caps_version, approved_at = excluded.approved_at, approved_by = excluded.approved_by`)
    .run(pluginId, peerId, JSON.stringify(caps || {}), JSON.stringify(capsList || []), version || null, now, by || null, now);
  return assignment(pluginId, peerId);
}

function setAssignmentEnabled(pluginId, peerId, enabled) {
  return db().prepare('UPDATE edge_assignments SET enabled = ? WHERE plugin_id = ? AND peer_id = ?').run(enabled ? 1 : 0, pluginId, peerId).changes > 0;
}

function setAssignmentStatus(pluginId, peerId, status) {
  db().prepare('UPDATE edge_assignments SET status = ?, status_at = ? WHERE plugin_id = ? AND peer_id = ?')
    .run(JSON.stringify(status), Date.now(), pluginId, peerId);
}

function removePlugin(pluginId) {
  db().prepare('DELETE FROM edge_assignments WHERE plugin_id = ?').run(pluginId);
  db().prepare('DELETE FROM edge_logs WHERE plugin_id = ?').run(pluginId);
}

// ─── Ring buffer ────────────────────────────────

function clean(s) {
  // one line, no control characters, bounded
  return String(s == null ? '' : s).replace(/[\0-\x08\x0a-\x1f\x7f]/g, ' ').slice(0, LOG_LINE_MAX);
}

/**
 * @param {number} peerId
 * @param {string|null} pluginId
 * @param {'log'|'event'|'system'} kind
 * @param {'info'|'warn'|'error'} level
 */
function addLog(peerId, pluginId, kind, level, message) {
  const k = LOG_KINDS.has(kind) ? kind : 'system';
  const l = LOG_LEVELS.has(level) ? level : 'info';
  const d = db();
  d.prepare('INSERT INTO edge_logs (peer_id, plugin_id, kind, level, message, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(peerId, pluginId || null, k, l, clean(message), Date.now());
  d.prepare(`DELETE FROM edge_logs WHERE peer_id = ? AND plugin_id IS ? AND id <= (
      SELECT id FROM edge_logs WHERE peer_id = ? AND plugin_id IS ? ORDER BY id DESC LIMIT 1 OFFSET ?)`)
    .run(peerId, pluginId || null, peerId, pluginId || null, LOG_KEEP);
}

/**
 * Newest first. `pluginId` undefined: every entry of the gateway; null: the gateway's own notes.
 * @returns {{id, pluginId, kind, level, message, at}[]}
 */
function logs(peerId, { pluginId, limit = 200, before = null, kind = null } = {}) {
  const lim = Math.max(1, Math.min(500, Number(limit) || 200));
  const where = ['peer_id = ?'];
  const args = [peerId];
  if (pluginId !== undefined) { where.push('plugin_id IS ?'); args.push(pluginId); }
  if (kind && LOG_KINDS.has(kind)) { where.push('kind = ?'); args.push(kind); }
  if (Number.isSafeInteger(Number(before)) && Number(before) > 0) { where.push('id < ?'); args.push(Number(before)); }
  return db().prepare(`SELECT id, plugin_id, kind, level, message, created_at FROM edge_logs WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`)
    .all(...args, lim)
    .map((r) => ({ id: r.id, pluginId: r.plugin_id, kind: r.kind, level: r.level, message: r.message, at: new Date(r.created_at).toISOString() }));
}

module.exports = {
  gatewayPeer, gatewayPeers, settings, setSettings, setHello, setMqttStatus,
  assignment, assignmentsOfGateway, assignmentsOfPlugin, approve, setAssignmentEnabled, setAssignmentStatus, removePlugin,
  addLog, logs, LOG_KEEP, LOG_LINE_MAX,
};
