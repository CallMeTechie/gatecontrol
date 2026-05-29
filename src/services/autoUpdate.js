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
  const min = parseInt(settings.get('auto_update.stale_after_min', '60'), 10) || 60;
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
function writeConfigFile(mode) {
  writeAtomic(CONFIG_FILE, JSON.stringify({ mode }) + '\n');
}
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
  if (getMode() !== 'manual') return { queued: false, reason: 'not_manual_mode' };
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
function readMarker() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return null; }   // missing/unreadable/corrupt → not_configured
}
function getStatus() {
  const mode = getMode();
  const running_version = pkg.version;
  const marker = readMarker();
  if (!marker || !marker.checked_at) {
    return { status: 'not_configured', mode, mode_mismatch: false, mode_pending: false, age_s: null, last_action: null, running_version };
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
  return { status, mode, mode_mismatch, mode_pending, age_s, checked_at: marker.checked_at,
    last_action: marker.action || null, marker_mode: marker.mode || null, running_version };
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
module.exports = { getStatus, getMode, setMode, requestUpdate, syncConfigFileOnBoot };
