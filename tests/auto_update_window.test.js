'use strict';

// Maintenance window + update e-mail switch on /api/v1/system/auto-update
// (docs/feature-release-b.md §6). The host side (update.sh) is covered by
// tests/update_sh.test.sh; this file covers validation, persistence, the
// projection into .auto-update-config.json and the server-side window rule.

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setup, teardown, getAgent, getCsrf } = require('./helpers/setup');

let au;
let settings;
let CONFIG;
let STATE;

before(async () => {
  await setup();
  au = require('../src/services/autoUpdate');
  settings = require('../src/services/settings');
  CONFIG = au.CONFIG_FILE;
  STATE = au.STATE_FILE;
});
after(() => teardown());

const put = (body) => getAgent().put('/api/v1/system/auto-update').set('X-CSRF-Token', getCsrf()).send(body);
const readCfg = () => JSON.parse(fs.readFileSync(CONFIG, 'utf8'));

beforeEach(() => {
  settings.set('auto_update.window', JSON.stringify({ enabled: false, start: '03:00', end: '05:00', tz: 'Europe/Berlin' }));
  settings.set('auto_update.mode', 'auto');
  for (const f of [STATE]) { try { fs.unlinkSync(f); } catch {} }
});

describe('isInWindow', () => {
  const w = (start, end, tz = 'UTC') => ({ enabled: true, start, end, tz });
  const at = (hhmm) => new Date(`2026-09-14T${hhmm}:00Z`);
  it('[start, end) on the same day', () => {
    assert.equal(au.isInWindow(w('03:00', '05:00'), at('03:00')), true);
    assert.equal(au.isInWindow(w('03:00', '05:00'), at('04:59')), true);
    assert.equal(au.isInWindow(w('03:00', '05:00'), at('05:00')), false);
    assert.equal(au.isInWindow(w('03:00', '05:00'), at('02:59')), false);
  });
  it('over midnight', () => {
    assert.equal(au.isInWindow(w('23:00', '02:00'), at('23:30')), true);
    assert.equal(au.isInWindow(w('23:00', '02:00'), at('01:59')), true);
    assert.equal(au.isInWindow(w('23:00', '02:00'), at('02:00')), false);
    assert.equal(au.isInWindow(w('23:00', '02:00'), at('12:00')), false);
  });
  it('uses the configured time zone', () => {
    // 01:30 UTC = 03:30 CEST (September)
    assert.equal(au.isInWindow(w('03:00', '05:00', 'Europe/Berlin'), at('01:30')), true);
    assert.equal(au.isInWindow(w('03:00', '05:00', 'UTC'), at('01:30')), false);
  });
});

describe('PUT /api/v1/system/auto-update { window }', () => {
  it('GET returns the window (disabled default) and notify_email', async () => {
    const res = await getAgent().get('/api/v1/system/auto-update');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.window, { enabled: false, start: '03:00', end: '05:00', tz: 'Europe/Berlin' });
    assert.equal(res.body.window_open, null);
    assert.equal(res.body.notify_email, true);
  });

  it('enabling writes the window into .auto-update-config.json', async () => {
    const res = await put({ window: { enabled: true, start: '02:30', end: '04:00', tz: 'Europe/Berlin' } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.window, { enabled: true, start: '02:30', end: '04:00', tz: 'Europe/Berlin' });
    assert.equal(typeof res.body.window_open, 'boolean');
    assert.deepEqual(readCfg(), { mode: 'auto', window: { start: '02:30', end: '04:00', tz: 'Europe/Berlin' } });
  });

  it('a mode change keeps the window in the file', async () => {
    await put({ window: { enabled: true, start: '22:00', end: '01:00', tz: 'UTC' } });
    await put({ mode: 'manual' });
    assert.deepEqual(readCfg(), { mode: 'manual', window: { start: '22:00', end: '01:00', tz: 'UTC' } });
    await put({ mode: 'auto' });
  });

  it('disabling removes the window from the file (older update.sh semantics)', async () => {
    await put({ window: { enabled: true } });
    const res = await put({ window: { enabled: false } });
    assert.equal(res.body.window.enabled, false);
    assert.deepEqual(readCfg(), { mode: 'auto' });
  });

  it('partial window updates merge with the stored window', async () => {
    await put({ window: { enabled: true, start: '01:00', end: '02:00', tz: 'UTC' } });
    const res = await put({ window: { end: '03:15' } });
    assert.deepEqual(res.body.window, { enabled: true, start: '01:00', end: '03:15', tz: 'UTC' });
  });

  for (const [label, window] of [
    ['bad time', { enabled: true, start: '24:00', end: '05:00' }],
    ['no zero padding', { start: '3:00' }],
    ['unknown tz', { tz: 'Mars/Olympus' }],
    ['shell in tz', { tz: '$(reboot)' }],
    ['tz path traversal', { tz: '../../etc/passwd' }],
    ['enabled not boolean', { enabled: 'yes' }],
    ['array', []],
    ['start == end', { enabled: true, start: '04:00', end: '04:00' }],
  ]) {
    it(`rejects ${label} with 400 INVALID_WINDOW and changes nothing`, async () => {
      const before = settings.get('auto_update.window');
      const res = await put({ window });
      assert.equal(res.status, 400);
      assert.equal(res.body.code, 'INVALID_WINDOW');
      assert.equal(settings.get('auto_update.window'), before);
    });
  }

  it('notify_email toggles notify.update_email', async () => {
    let res = await put({ notify_email: false });
    assert.equal(res.status, 200);
    assert.equal(res.body.notify_email, false);
    assert.equal(settings.get('notify.update_email'), 'false');
    res = await put({ notify_email: true });
    assert.equal(res.body.notify_email, true);
    res = await put({ notify_email: 'no' });
    assert.equal(res.status, 400);
  });

  it('empty body → 400', async () => {
    const res = await put({});
    assert.equal(res.status, 400);
  });
});

describe('POST /api/v1/system/auto-update/trigger with a window', () => {
  it('auto mode without window → 409 (unchanged)', async () => {
    const res = await getAgent().post('/api/v1/system/auto-update/trigger').set('X-CSRF-Token', getCsrf()).send({});
    assert.equal(res.status, 409);
  });
  it('auto mode with window + live cron → queues the flag ("update now")', async () => {
    await put({ window: { enabled: true, start: '03:00', end: '05:00', tz: 'UTC' } });
    fs.writeFileSync(STATE, JSON.stringify({ checked_at: new Date().toISOString(), action: 'waiting_window', mode: 'auto', ok: true }));
    settings.set('auto_update.last_trigger_at', '2000-01-01T00:00:00.000Z');
    const res = await getAgent().post('/api/v1/system/auto-update/trigger').set('X-CSRF-Token', getCsrf()).send({});
    assert.equal(res.status, 200);
    assert.equal(res.body.queued, true);
    assert.ok(fs.existsSync(path.join(path.dirname(CONFIG), 'pending-update')));
    const st = await getAgent().get('/api/v1/system/auto-update');
    assert.equal(st.body.last_action, 'waiting_window');
  });
});
