'use strict';

// Recordings of gc.remote sessions — the frame of the host API (version 1).
// Recording itself comes with stage 3 of the plugin "Fernzugriff" (guacd with
// a drive for recordings, asciicast for SSH): until then remote_recordings
// stays empty, gc.remote.session({ record: true }) answers
// ERR_REMOTE_RECORDING_UNAVAILABLE and gc.remote.recordings.available()
// says so. list / stream / remove already work on the table, so a plugin
// written against version 1 needs no change when recordings arrive.

class RecordingError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

const ID_RE = /^rr_[0-9a-f]{32}$/;

function db() { return require('../../db/connection').getDb(); }

function view(r) {
  return {
    id: r.id, sessionId: r.session_id, targetId: r.target_id, userId: r.user_id, protocol: r.protocol, format: r.format,
    bytes: r.bytes, startedAt: r.started_at, endedAt: r.ended_at, createdAt: r.created_at,
  };
}

/** gc.remote.recordings.available() → { available, reason } */
function available() {
  return { available: false, reason: 'not_yet' };
}

/** gc.remote.recordings.list({ targetId?, sessionId?, limit? }) → [recording] (newest first) */
function list(plugin, a) {
  const o = a && typeof a === 'object' ? a : {};
  const where = ['plugin_id = ?'];
  const params = [plugin.id];
  if (o.targetId != null) { where.push('target_id = ?'); params.push(String(o.targetId)); }
  if (o.sessionId != null) { where.push('session_id = ?'); params.push(Number(o.sessionId)); }
  const limit = Math.max(1, Math.min(500, Number(o.limit) || 100));
  return db().prepare(`SELECT * FROM remote_recordings WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ${limit}`).all(...params).map(view);
}

function rowOf(plugin, id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new RecordingError('invalid', 'invalid recording id');
  return db().prepare('SELECT * FROM remote_recordings WHERE id = ? AND plugin_id = ?').get(id, plugin.id) || null;
}

/**
 * gc.remote.recordings.stream(id) → { url, expiresAt } — a playback address for the session page
 * of the core. No recording can exist before stage 3: ERR_REMOTE_NOT_FOUND / _UNAVAILABLE.
 */
function stream(plugin, id) {
  const r = rowOf(plugin, id);
  if (!r) throw new RecordingError('not_found', 'no such recording of this plugin');
  throw new RecordingError('recording_unavailable', 'playback is not available on this server yet');
}

/** gc.remote.recordings.remove(id) → { removed } */
function remove(plugin, id) {
  const r = rowOf(plugin, id);
  if (!r) return { removed: false };
  db().prepare('DELETE FROM remote_recordings WHERE id = ?').run(r.id);
  try {
    require('../activity').log('remote_recording_deleted', `Remote recording deleted via plugin "${plugin.id}"`, {
      source: 'plugin', severity: 'info', details: { plugin: plugin.id, recording: r.id, targetId: r.target_id },
    });
  } catch { /* best-effort */ }
  return { removed: true };
}

function forget(pluginId) {
  try { db().prepare('DELETE FROM remote_recordings WHERE plugin_id = ?').run(pluginId); } catch { /* table missing */ }
}

module.exports = { available, list, stream, remove, forget, RecordingError };
