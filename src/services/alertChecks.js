'use strict';

// Hourly checks (src/server.js): backup reminder and resource thresholds
// (CPU, RAM, disk — Settings → Benachrichtigungen → "Regelmäßige Prüfungen").
//
// Each check writes an activity entry (backup_reminder / resource_alert), and
// activity.log hands it to the notification settings: mail to the one
// recipient when the row is ticked, webhooks subscribed to the type.
//
// De-duplication: a check that stays above its threshold alerts once, then
// again only every REALERT_MS (24 h) while it is still above. When the value
// falls back below threshold − HYSTERESIS the resource is "recovered"
// (resource_recovered, info) and the next crossing alerts at once. The state
// survives restarts (setting alerts.check_state, JSON; never sent to clients).
//
// Disk usage comes from the same source as GET /api/v1/system/resources
// (services/system.js getResources().disk — `df /`).

const settings = require('./settings');

const K_STATE = 'alerts.check_state';
const REALERT_MS = 24 * 60 * 60 * 1000;
const HYSTERESIS = 5; // percentage points

const RESOURCES = [
  { id: 'cpu', key: 'alerts.resource_cpu_threshold', label: 'CPU', read: (r) => r && r.cpu && r.cpu.percent },
  { id: 'ram', key: 'alerts.resource_ram_threshold', label: 'RAM', read: (r) => r && r.memory && r.memory.percent },
  { id: 'disk', key: 'alerts.resource_disk_threshold', label: 'Disk', read: (r) => r && r.disk && r.disk.percent },
];

function threshold(key) {
  const n = parseInt(settings.get(key, '0'), 10);
  return Number.isFinite(n) && n > 0 && n <= 100 ? n : 0;
}

/**
 * Pure: one check step. `prev` = { active, since, lastAlert } or undefined.
 * → { action: 'alert' | 'realert' | 'recovered' | null, state }
 * `over` = the value is above the threshold, `clear` = it is low enough to
 * count as recovered (below threshold − hysteresis).
 */
function step(prev, { over, clear, now }) {
  const p = prev && prev.active ? prev : null;
  if (over) {
    if (!p) return { action: 'alert', state: { active: true, since: now, lastAlert: now } };
    if (now - (p.lastAlert || 0) >= REALERT_MS) return { action: 'realert', state: { ...p, lastAlert: now } };
    return { action: null, state: p };
  }
  if (p && clear) return { action: 'recovered', state: { active: false } };
  return { action: null, state: p || { active: false } };
}

function readState() {
  try {
    const s = JSON.parse(settings.get(K_STATE, '{}'));
    return s && typeof s === 'object' && !Array.isArray(s) ? s : {};
  } catch { return {}; }
}

function fmtBytes(n) {
  if (!Number.isFinite(n)) return '?';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (i ? v.toFixed(1) : String(v)) + ' ' + u[i];
}

/**
 * Run all checks once. `deps` for tests: { now, resources (async fn),
 * lastBackupAt (fn → ms|null), log (fn(type, message, options)) }.
 * Returns the actions taken, e.g. [{ check: 'disk', action: 'alert' }].
 */
async function run(deps = {}) {
  const now = deps.now != null ? deps.now : Date.now();
  const log = deps.log || ((type, message, options) => require('./activity').log(type, message, options));
  const state = readState();
  const actions = [];

  // ── Backup reminder ──
  const backupDays = Math.max(0, parseInt(settings.get('alerts.backup_reminder_days', '0'), 10) || 0);
  if (backupDays > 0) {
    const last = deps.lastBackupAt ? deps.lastBackupAt() : lastBackupAt();
    const daysSince = last == null ? null : Math.floor((now - last) / 86400000);
    const over = daysSince == null || daysSince >= backupDays;
    const r = step(state.backup, { over, clear: !over, now });
    state.backup = r.state;
    if (r.action === 'alert' || r.action === 'realert') {
      log('backup_reminder', daysSince == null
        ? `No backup yet (reminder after ${backupDays} days)`
        : `No backup in ${daysSince} days (threshold: ${backupDays})`, {
        source: 'system', severity: 'warning', details: { days_since: daysSince, threshold: backupDays },
      });
      actions.push({ check: 'backup', action: r.action });
    } else if (r.action === 'recovered') {
      actions.push({ check: 'backup', action: r.action });
    }
  } else {
    delete state.backup;
  }

  // ── Resources ──
  const active = RESOURCES.map((res) => ({ ...res, threshold: threshold(res.key) })).filter((x) => x.threshold > 0);
  for (const res of RESOURCES) if (!active.some((a) => a.id === res.id)) delete state[res.id];
  if (active.length) {
    let data = null;
    try { data = await (deps.resources ? deps.resources() : require('./system').getResources({ consumer: 'alerts' })); } catch { data = null; }
    for (const res of active) {
      const value = res.read(data);
      if (!Number.isFinite(value)) continue; // no reading (e.g. df failed) — keep the state
      const over = value > res.threshold;
      const r = step(state[res.id], { over, clear: value < res.threshold - HYSTERESIS, now });
      state[res.id] = r.state;
      if (!r.action) continue;
      const details = { resource: res.id, percent: value, threshold: res.threshold };
      if (res.id === 'disk' && data && data.disk) Object.assign(details, { used: data.disk.used, total: data.disk.total });
      if (r.action === 'recovered') {
        log('resource_recovered', `${res.label} usage back to ${value}% (threshold ${res.threshold}%)`, {
          source: 'system', severity: 'success', details,
        });
      } else {
        const extra = res.id === 'disk' && data && data.disk ? ` (${fmtBytes(data.disk.used)} of ${fmtBytes(data.disk.total)})` : '';
        log('resource_alert', `${res.label} usage ${value}% exceeds threshold ${res.threshold}%${extra}`, {
          source: 'system', severity: 'warning', details: { ...details, repeat: r.action === 'realert' },
        });
      }
      actions.push({ check: res.id, action: r.action });
    }
  }

  settings.set(K_STATE, JSON.stringify(state));
  return actions;
}

function lastBackupAt() {
  const row = require('../db/connection').getDb()
    .prepare("SELECT created_at FROM activity_log WHERE event_type IN ('backup_created', 'autobackup_created') ORDER BY created_at DESC LIMIT 1").get();
  return row ? new Date(row.created_at + 'Z').getTime() : null;
}

module.exports = { run, step, REALERT_MS, HYSTERESIS, K_STATE, RESOURCES };
