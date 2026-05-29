'use strict';
process.env.NODE_ENV = 'test';
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-au-'));
process.env.GC_DATA_PATH = dataDir;
process.env.GC_DB_PATH = path.join(dataDir, 'test.db');
process.env.GC_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
process.env.GC_LOG_LEVEL = 'silent';
delete require.cache[require.resolve('../config/default')];

const { runMigrations } = require('../src/db/migrations');
const { closeDb } = require('../src/db/connection');
before(() => { runMigrations(); });
after(() => { closeDb(); try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {} });

const au = require('../src/services/autoUpdate');
const settings = require('../src/services/settings');

const STATE = path.join(dataDir, '.auto-update-state.json');
const CONFIG = path.join(dataDir, '.auto-update-config.json');
const FLAG = path.join(dataDir, 'pending-update');

function writeMarker(obj) { fs.writeFileSync(STATE, JSON.stringify(obj)); }

beforeEach(() => {
  for (const f of [STATE, CONFIG, FLAG]) { try { fs.unlinkSync(f); } catch {} }
  settings.set('auto_update.mode', 'auto');
  settings.set('auto_update.mode_changed_at', '2000-01-01T00:00:00.000Z');
});

describe('autoUpdate.getStatus', () => {
  it('not_configured when no marker', () => {
    assert.equal(au.getStatus().status, 'not_configured');
  });
  it('active when marker is fresh', () => {
    writeMarker({ checked_at: new Date().toISOString(), action: 'noop', mode: 'auto', ok: true });
    const s = au.getStatus();
    assert.equal(s.status, 'active');
    assert.equal(s.mode, 'auto');
    assert.ok(s.age_s >= 0 && s.age_s < 120);
  });
  it('stale when marker older than threshold', () => {
    const old = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
    writeMarker({ checked_at: old, action: 'noop', mode: 'auto', ok: true });
    assert.equal(au.getStatus().status, 'stale');
  });
  it('flags last_action failed', () => {
    writeMarker({ checked_at: new Date().toISOString(), action: 'failed', mode: 'auto', ok: false });
    const s = au.getStatus();
    assert.equal(s.status, 'active');
    assert.equal(s.last_action, 'failed');
  });
});

describe('autoUpdate.getStatus — mode_mismatch timing gate', () => {
  it('NO mismatch right after a mode change (marker predates change) → mode_pending', () => {
    settings.set('auto_update.mode', 'manual');
    settings.set('auto_update.mode_changed_at', new Date().toISOString());
    // marker written BEFORE the change still says auto
    writeMarker({ checked_at: new Date(Date.now() - 60000).toISOString(), action: 'noop', mode: 'auto', ok: true });
    const s = au.getStatus();
    assert.equal(s.mode_mismatch, false);
    assert.equal(s.mode_pending, true);     // neutral "applies next run" state
  });
  it('mismatch when a run AFTER the change still used the old mode', () => {
    settings.set('auto_update.mode', 'manual');
    settings.set('auto_update.mode_changed_at', new Date(Date.now() - 120000).toISOString());
    writeMarker({ checked_at: new Date().toISOString(), action: 'noop', mode: 'auto', ok: true });
    assert.equal(au.getStatus().mode_mismatch, true);
  });
});

describe('autoUpdate.setMode', () => {
  it('persists setting + writes config file + stamps mode_changed_at', () => {
    au.setMode('manual');
    assert.equal(settings.get('auto_update.mode'), 'manual');
    assert.equal(JSON.parse(fs.readFileSync(CONFIG, 'utf8')).mode, 'manual');
    assert.ok(settings.get('auto_update.mode_changed_at'));
  });
  it('rejects invalid mode', () => {
    assert.throws(() => au.setMode('nope'), /invalid/i);
  });
  it('removes orphan pending-update when switching to auto', () => {
    fs.writeFileSync(FLAG, '{}');
    au.setMode('auto');
    assert.equal(fs.existsSync(FLAG), false);
  });
});

describe('autoUpdate.requestUpdate', () => {
  function freshActiveManual() {
    settings.set('auto_update.mode', 'manual');
    settings.set('auto_update.last_trigger_at', '2000-01-01T00:00:00.000Z');
    writeMarker({ checked_at: new Date().toISOString(), action: 'noop', mode: 'manual', ok: true });
  }
  it('queues + writes flag when manual & active', () => {
    freshActiveManual();
    const r = au.requestUpdate();
    assert.equal(r.queued, true);
    assert.ok(fs.existsSync(FLAG));
  });
  it('refuses when not active (no/stale cron) — stale_no_cron', () => {
    settings.set('auto_update.mode', 'manual');   // no marker → not_configured
    const r = au.requestUpdate();
    assert.equal(r.queued, false);
    assert.equal(r.reason, 'stale_no_cron');
  });
  it('refuses in auto mode — not_manual_mode', () => {
    settings.set('auto_update.mode', 'auto');
    assert.equal(au.requestUpdate().reason, 'not_manual_mode');
  });
  it('cooldown blocks a rapid second trigger', () => {
    freshActiveManual();
    assert.equal(au.requestUpdate().queued, true);
    const r2 = au.requestUpdate();   // immediately again
    assert.equal(r2.queued, false);
    assert.equal(r2.reason, 'cooldown');
  });
});

describe('autoUpdate.getStatus — versions & not_configured', () => {
  it('always reports running_version from package.json', () => {
    assert.equal(au.getStatus().running_version, require('../package.json').version);
  });
});
