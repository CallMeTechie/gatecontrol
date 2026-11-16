'use strict';

// Pinned SSH host keys of gc.remote (stage 3, docs/plugins.md "Remote access"). One key per
// plugin and target id. The SSH terminal of the core (term.js) and gc.remote.tmux.list check
// every connection against it:
//
//   * no pin yet: the terminal shows the fingerprint and connects only after the person
//     confirmed it ("trust on first use" with a confirmation) — the core pins it then; a list
//     of tmux sessions (no person to ask) answers ERR_REMOTE_HOST_KEY_UNPINNED;
//   * a pin: only that key connects. Another one blocks (host_key_mismatch), lands in the
//     activity log as remote_host_key_changed and stays blocked until the administrator
//     removes the pin (gc.remote.hostKeys.remove) — there is no "connect anyway".
//
// gc.remote.hostKeys.pin lets a plugin pin a key it got another way (the Linux agent reports
// its host key at enrolment).

const { SHA256_RE, ALG_RE } = require('./sshkeys');

class HostKeyError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

const TARGET_RE = /^[A-Za-z0-9._:-]{1,64}$/;
const PER_PLUGIN_MAX = 5000;

function db() { return require('../../db/connection').getDb(); }

function targetIdOf(v) {
  const s = typeof v === 'string' ? v : (v && typeof v === 'object' ? v.id : null);
  if (typeof s !== 'string' || !TARGET_RE.test(s)) throw new HostKeyError('invalid', 'targetId: 1…64 of A-Z a-z 0-9 . _ : -');
  return s;
}

function view(r) {
  return { targetId: r.target_id, alg: r.alg, sha256: r.sha256, source: r.source, pinnedBy: r.pinned_by == null ? null : r.pinned_by, pinnedAt: r.created_at ? new Date(r.created_at + 'Z').toISOString() : null };
}

/** The pin of a target or null. */
function get(pluginId, targetId) {
  const r = db().prepare('SELECT * FROM remote_host_keys WHERE plugin_id = ? AND target_id = ?').get(pluginId, targetIdOf(targetId));
  return r ? view(r) : null;
}

/**
 * gc.remote.hostKeys.pin({ targetId, alg, sha256 }) → the pin. Replaces an existing one (the
 * plugin decided: e.g. the agent of the device reported its new key).
 */
function pin(pluginId, a, { source = 'plugin', userId = null } = {}) {
  const o = a && typeof a === 'object' ? a : {};
  const targetId = targetIdOf(o.targetId);
  const alg = String(o.alg || '');
  const sha256 = String(o.sha256 || '').replace(/^SHA256:/, '').replace(/=+$/, '');
  if (!ALG_RE.test(alg)) throw new HostKeyError('invalid', 'alg: the key type, e.g. ssh-ed25519');
  if (!SHA256_RE.test(sha256)) throw new HostKeyError('invalid', 'sha256: the SHA-256 fingerprint (43 base64 characters)');
  const n = db().prepare('SELECT COUNT(*) AS c FROM remote_host_keys WHERE plugin_id = ?').get(pluginId).c;
  if (n >= PER_PLUGIN_MAX && !get(pluginId, targetId)) throw new HostKeyError('limit', `at most ${PER_PLUGIN_MAX} pinned keys per plugin`);
  db().prepare(`INSERT INTO remote_host_keys (plugin_id, target_id, alg, sha256, source, pinned_by, created_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(plugin_id, target_id) DO UPDATE SET alg = excluded.alg, sha256 = excluded.sha256, source = excluded.source, pinned_by = excluded.pinned_by, created_at = excluded.created_at`)
    .run(pluginId, targetId, alg, sha256, source === 'trust' ? 'trust' : 'plugin', Number.isSafeInteger(userId) ? userId : null);
  try {
    require('../activity').log('remote_host_key_pinned', `SSH host key pinned for "${targetId}" (${alg}) via plugin "${pluginId}"`, {
      source: 'plugin', severity: 'info', details: { plugin: pluginId, targetId, alg, sha256, by: source === 'trust' ? 'person' : 'plugin', userId },
    });
  } catch { /* best-effort */ }
  return get(pluginId, targetId);
}

/** gc.remote.hostKeys.list() → [pin] */
function list(pluginId) {
  return db().prepare('SELECT * FROM remote_host_keys WHERE plugin_id = ? ORDER BY target_id').all(pluginId).map(view);
}

/** gc.remote.hostKeys.remove(targetId) → { removed } — the next connection asks the person again. */
function remove(pluginId, targetId) {
  const r = db().prepare('DELETE FROM remote_host_keys WHERE plugin_id = ? AND target_id = ?').run(pluginId, targetIdOf(targetId));
  return { removed: r.changes > 0 };
}

/**
 * The check of a key the target presented: 'ok' (pinned and equal), 'unpinned', 'mismatch'.
 * A mismatch is logged (once per call) — the caller blocks.
 */
function check(pluginId, targetId, fp, { userId = null, targetName = null } = {}) {
  const p = get(pluginId, targetId);
  if (!p) return 'unpinned';
  if (p.alg === fp.alg && p.sha256 === fp.sha256) return 'ok';
  try {
    require('../activity').log('remote_host_key_changed', `SSH host key of "${targetName || targetId}" changed — connection blocked (plugin "${pluginId}")`, {
      source: 'plugin', severity: 'warning',
      details: { plugin: pluginId, targetId, pinned: { alg: p.alg, sha256: p.sha256 }, presented: { alg: fp.alg, sha256: fp.sha256 }, userId },
    });
  } catch { /* best-effort */ }
  return 'mismatch';
}

function forget(pluginId) {
  try { db().prepare('DELETE FROM remote_host_keys WHERE plugin_id = ?').run(pluginId); } catch { /* table missing */ }
}

// ─── Backup (services/backup.js): a restore keeps the pins, so no key is trusted anew ───

function exportBackup() {
  try { return db().prepare('SELECT plugin_id, target_id, alg, sha256, source, pinned_by, created_at FROM remote_host_keys ORDER BY plugin_id, target_id').all(); } catch { return null; }
}

function restoreBackup(rows) {
  if (!Array.isArray(rows)) return 0;
  const q = db();
  q.prepare('DELETE FROM remote_host_keys').run();
  const ins = q.prepare(`INSERT OR IGNORE INTO remote_host_keys (plugin_id, target_id, alg, sha256, source, pinned_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  let n = 0;
  for (const r of rows) {
    if (!r || typeof r.plugin_id !== 'string' || r.plugin_id.length > 64 || typeof r.target_id !== 'string' || !TARGET_RE.test(r.target_id)) continue;
    if (!ALG_RE.test(String(r.alg || '')) || !SHA256_RE.test(String(r.sha256 || ''))) continue;
    ins.run(r.plugin_id, r.target_id, r.alg, r.sha256, r.source === 'plugin' ? 'plugin' : 'trust', Number.isSafeInteger(r.pinned_by) ? r.pinned_by : null,
      typeof r.created_at === 'string' && r.created_at.length <= 40 ? r.created_at : new Date().toISOString().slice(0, 19).replace('T', ' '));
    n++;
  }
  return n;
}

module.exports = { get, pin, list, remove, check, forget, exportBackup, restoreBackup, HostKeyError, TARGET_RE };
