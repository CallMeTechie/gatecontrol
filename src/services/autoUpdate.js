'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const settings = require('./settings');
const logger = require('../utils/logger');
const pkg = require('../../package.json');

// /data resolution: production sets GC_DATA_PATH (config/default.js), the test
// helper tests/helpers/setup.js sets GC_DATA_DIR — accept BOTH (R1-fix #1).
const DATA_DIR = process.env.GC_DATA_PATH || process.env.GC_DATA_DIR || '/data';
const STATE_FILE = path.join(DATA_DIR, '.auto-update-state.json');
const CONFIG_FILE = path.join(DATA_DIR, '.auto-update-config.json');
const FLAG_FILE = path.join(DATA_DIR, 'pending-update');

const VALID_MODES = ['auto', 'manual'];
const TRIGGER_COOLDOWN_MS = 30 * 1000;

function staleAfterMs() {
  const raw = parseInt(settings.get('auto_update.stale_after_min', '60'), 10);
  const min = (isNaN(raw) || raw <= 0) ? 60 : raw;
  return min * 60 * 1000;
}
function getMode() {
  const m = settings.get('auto_update.mode', 'auto');
  return VALID_MODES.includes(m) ? m : 'auto';
}
// Atomic write (temp + rename) so update.sh never reads a half-written file;
// clean up the temp on failure (R1-fix: no temp leak on read-only/full /data).
function writeAtomic(file, content) {
  const tmp = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try { fs.writeFileSync(tmp, content, { mode: 0o644 }); fs.renameSync(tmp, file); }
  catch (err) { try { fs.unlinkSync(tmp); } catch {} throw err; }
}
// ── Maintenance window (docs/feature-release-b.md §6) ──────────────────────
// Setting auto_update.window = JSON {enabled,start,end,tz}. In auto mode the
// host's update.sh deploys a new :latest only while the local time in `tz`
// lies in [start, end) — end < start spans midnight. The window is projected
// into .auto-update-config.json ONLY when enabled, so an older update.sh (and
// a disabled window) behave exactly as before. tz is restricted to the IANA
// charset because update.sh passes it as TZ= to date(1).
const DEFAULT_WINDOW = Object.freeze({ enabled: false, start: '03:00', end: '05:00', tz: 'Europe/Berlin' });
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const TZ_RE = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+){0,2}$/;

function isValidTz(tz) {
  if (typeof tz !== 'string' || tz.length > 64 || !TZ_RE.test(tz)) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}
/** @returns {string|null} error text or null */
function validateWindow(w) {
  if (!w || typeof w !== 'object' || Array.isArray(w)) return 'window must be an object';
  if (w.enabled !== undefined && typeof w.enabled !== 'boolean') return 'window.enabled must be a boolean';
  for (const k of ['start', 'end']) {
    if (w[k] !== undefined && (typeof w[k] !== 'string' || !HHMM_RE.test(w[k]))) return `window.${k} must be HH:MM (00:00-23:59)`;
  }
  if (w.tz !== undefined && !isValidTz(w.tz)) return 'window.tz must be an IANA time zone (e.g. Europe/Berlin)';
  return null;
}
function getWindow() {
  let stored = null;
  try { stored = JSON.parse(settings.get('auto_update.window', 'null')); } catch { stored = null; }
  const w = { ...DEFAULT_WINDOW, ...(stored && typeof stored === 'object' ? stored : {}) };
  if (!HHMM_RE.test(w.start)) w.start = DEFAULT_WINDOW.start;
  if (!HHMM_RE.test(w.end)) w.end = DEFAULT_WINDOW.end;
  if (!isValidTz(w.tz)) w.tz = DEFAULT_WINDOW.tz;
  return { enabled: w.enabled === true, start: w.start, end: w.end, tz: w.tz };
}
function minutesOf(hhmm) { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; }
/** Same rule as update.sh: [start, end), over midnight when end < start, start == end = always. */
function isInWindow(w, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: w.tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(now);
  const hh = Number(parts.find((p) => p.type === 'hour').value) % 24;
  const mm = Number(parts.find((p) => p.type === 'minute').value);
  const cur = hh * 60 + mm;
  const s = minutesOf(w.start);
  const e = minutesOf(w.end);
  if (s === e) return true;
  return s < e ? (cur >= s && cur < e) : (cur >= s || cur < e);
}
function writeConfigFile(mode, win = getWindow()) {
  const cfg = { mode };
  if (win.enabled) cfg.window = { start: win.start, end: win.end, tz: win.tz };
  writeAtomic(CONFIG_FILE, JSON.stringify(cfg) + '\n');
}
function setWindow(input) {
  const err = validateWindow(input);
  if (err) { const e = new Error(err); e.code = 'INVALID_WINDOW'; throw e; }
  const next = { ...getWindow(), ...input };
  if (next.enabled && next.start === next.end) {
    const e = new Error('window.start and window.end must differ'); e.code = 'INVALID_WINDOW'; throw e;
  }
  // Host file first (same rule as setMode): a failed write changes nothing.
  writeConfigFile(getMode(), next);
  settings.set('auto_update.window', JSON.stringify(next));
  return next;
}

// "Update"/"Rollback" e-mails (services/updateNotify.js); default on.
function getNotifyEmail() { return settings.get('notify.update_email', 'true') !== 'false'; }
function setNotifyEmail(v) { settings.set('notify.update_email', v ? 'true' : 'false'); return getNotifyEmail(); }

function setMode(mode) {
  if (!VALID_MODES.includes(mode)) throw new Error('invalid mode');
  // Write the host-facing config file FIRST; if it throws we never change the
  // setting, so the DB and host file can't silently diverge (R1-fix #12).
  writeConfigFile(mode);
  settings.set('auto_update.mode', mode);
  settings.set('auto_update.mode_changed_at', new Date().toISOString());
  if (mode === 'auto') { try { fs.unlinkSync(FLAG_FILE); } catch {} } // drop orphan trigger
  return { mode };
}
function requestUpdate() {
  // Auto mode with a maintenance window: "Update now" drops the same flag;
  // update.sh then deploys immediately instead of waiting for the window.
  if (getMode() !== 'manual' && !getWindow().enabled) return { queued: false, reason: 'not_manual_mode' };
  if (getStatus().status !== 'active') return { queued: false, reason: 'stale_no_cron' }; // R1-fix #10
  const last = settings.get('auto_update.last_trigger_at', null);
  if (last && (Date.now() - new Date(last).getTime()) < TRIGGER_COOLDOWN_MS) {
    return { queued: false, reason: 'cooldown' };                                          // R1-fix #6
  }
  const request_id = crypto.randomUUID();
  writeAtomic(FLAG_FILE, JSON.stringify({ request_id, requested_at: new Date().toISOString() }) + '\n');
  settings.set('auto_update.last_trigger_at', new Date().toISOString());
  return { queued: true, request_id };
}
// update.sh writes bad_image/bad_version with a strict charset; re-check here
// anyway (the marker lives on a host-writable volume).
function markerRef(v) { return typeof v === 'string' && /^[A-Za-z0-9._:+-]{1,128}$/.test(v) ? v : null; }

// ── update.sh version (docs/feature-next-package.md §S2.2) ─────────────────
// The host script writes its own marker version into the state file; the image
// carries the same marker in the vendored copy. host_version === null means an
// update.sh from before the marker (or no run yet) — the UI then asks for a
// one-off reinstall. matches is only true when both numbers are known and equal.
function markerVersion(v) {
  return Number.isInteger(v) && v >= 0 && v <= 999999999 ? v : null;
}
function updateShInfo(marker) {
  let imageVersion = null;
  try { imageVersion = require('./systemSetup').updateShVersion(); } catch { imageVersion = null; }
  const hostVersion = markerVersion(marker && marker.update_sh);
  return {
    update_sh: {
      host_version: hostVersion,
      image_version: imageVersion,
      matches: hostVersion !== null && imageVersion !== null && hostVersion === imageVersion,
    },
  };
}
function readMarker() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return null; }   // missing/unreadable/corrupt → not_configured
}
function getStatus() {
  const mode = getMode();
  const running_version = pkg.version;
  const marker = readMarker();
  if (!marker || !marker.checked_at) {
    return { status: 'not_configured', mode, mode_mismatch: false, mode_pending: false, age_s: null, last_action: null, running_version, ...windowInfo(), ...updateShInfo(null) };
  }
  const checkedAt = new Date(marker.checked_at).getTime();
  const now = Date.now();
  const age_s = Math.max(0, Math.round((now - checkedAt) / 1000));
  // Future timestamp (host clock ahead) is suspect → stale, not active (R1-fix #10).
  const fresh = checkedAt <= now + 60000 && (now - checkedAt) <= staleAfterMs();
  const status = fresh ? 'active' : 'stale';
  const changedAt = new Date(settings.get('auto_update.mode_changed_at', '1970-01-01T00:00:00.000Z')).getTime();
  const modeDiffers = !!marker.mode && marker.mode !== mode;
  const mode_mismatch = modeDiffers && checkedAt > changedAt;  // a run AFTER the change still used old mode
  const mode_pending  = modeDiffers && checkedAt <= changedAt; // change not yet picked up by a run (neutral)
  // last_action "rolled_back": the new image failed its health check and the
  // previous one was restored; "failed" + bad_image: the rollback failed too.
  return { status, mode, mode_mismatch, mode_pending, age_s, checked_at: marker.checked_at,
    last_action: marker.action || null, marker_mode: marker.mode || null, running_version,
    bad_image: markerRef(marker.bad_image), bad_version: markerRef(marker.bad_version), ...windowInfo(), ...updateShInfo(marker) };
}
function windowInfo() {
  const window = getWindow();
  let window_open = null;
  if (window.enabled) { try { window_open = isInWindow(window); } catch { window_open = null; } }
  return { window, window_open, notify_email: getNotifyEmail() };
}
// Boot sync: baseline mode_changed_at to install time if unset (so the gate
// isn't anchored at epoch, R1-fix #9), then project the mode onto the volume.
function syncConfigFileOnBoot() {
  if (!settings.get('auto_update.mode_changed_at', null)) {
    settings.set('auto_update.mode_changed_at', new Date().toISOString());
  }
  try { writeConfigFile(getMode()); }
  catch (err) { logger.warn({ err: err.message }, 'auto-update: could not write config file'); }
}
module.exports = {
  getStatus, getMode, setMode, requestUpdate, syncConfigFileOnBoot,
  getWindow, setWindow, validateWindow, isInWindow, getNotifyEmail, setNotifyEmail,
  readMarker, updateShInfo, STATE_FILE, CONFIG_FILE,
};
