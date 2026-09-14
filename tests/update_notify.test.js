'use strict';

// Update / rollback e-mails (docs/feature-release-b.md §6): recipient
// monitoring.alert_email, switch notify.update_email (default on), once per
// version, once per failure streak of .auto-update-state.json.

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { setup, teardown } = require('./helpers/setup');

let notify;
let settings;
let email;
let db;
let STATE;
const sent = [];
const pkg = require('../package.json');

before(async () => {
  await setup();
  settings = require('../src/services/settings');
  db = require('../src/db/connection').getDb();
  email = require('../src/services/email');
  email.isSmtpConfigured = () => true;
  email.sendMail = async (m) => { sent.push(m); return { messageId: 'x' }; };
  notify = require('../src/services/updateNotify');
  STATE = require('../src/services/autoUpdate').STATE_FILE;
});
after(() => teardown());

beforeEach(() => {
  sent.length = 0;
  settings.set('monitoring.alert_email', 'ops@example.com');
  settings.set('notify.update_email', 'true');
  db.prepare("DELETE FROM settings WHERE key IN ('notify.last_version', 'notify.update_state_last')").run();
  db.prepare("DELETE FROM activity_log WHERE event_type = 'system_start'").run();
  db.prepare("UPDATE users SET language = 'en'").run();
  try { fs.unlinkSync(STATE); } catch {}
});

const marker = (o) => fs.writeFileSync(STATE, JSON.stringify({ mode: 'auto', ok: false, ...o }));
const oldStart = () => db.prepare("INSERT INTO activity_log (event_type, message, created_at) VALUES ('system_start', 'x', datetime('now', '-2 days'))").run();

describe('new version e-mail', () => {
  it('fresh install: records the version, no mail', async () => {
    assert.equal(await notify.checkVersion(), 'recorded');
    assert.equal(sent.length, 0);
    assert.equal(settings.get('notify.last_version'), pkg.version);
    assert.equal(await notify.checkVersion(), 'same');
  });

  it('upgrade from an older version: one mail with the changelog bullets, then never again', async () => {
    settings.set('notify.last_version', '1.124.0');
    assert.equal(await notify.checkVersion(), 'sent');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, 'ops@example.com');
    assert.equal(sent[0].subject, `[GateControl] GateControl updated to v${pkg.version}`);
    assert.match(sent[0].text, new RegExp(`from v1\\.124\\.0 to v${pkg.version.replace(/\./g, '\\.')}`));
    assert.match(sent[0].text, new RegExp(`^v${pkg.version.replace(/\./g, '\\.')}`, 'm'));
    assert.match(sent[0].text, /^- \S/m, 'bullet points from the changelog');
    assert.ok(!/^v1\.124\.0/m.test(sent[0].text), 'the old version itself is not listed');
    assert.equal(await notify.checkVersion(), 'same');
    assert.equal(sent.length, 1);
  });

  it('German subject for a German admin (contract wording)', async () => {
    db.prepare("UPDATE users SET language = 'de'").run();
    settings.set('notify.last_version', '1.124.0');
    await notify.checkVersion();
    assert.equal(sent[0].subject, `[GateControl] GateControl auf v${pkg.version} aktualisiert`);
  });

  it('first start with the feature on an existing installation still mails', async () => {
    oldStart();
    assert.equal(await notify.checkVersion(), 'sent');
    assert.match(sent[0].text, new RegExp(`updated to v${pkg.version.replace(/\./g, '\\.')}`));
  });

  it('downgrade (rollback) is recorded silently', async () => {
    settings.set('notify.last_version', '99.0.0');
    assert.equal(await notify.checkVersion(), 'recorded');
    assert.equal(sent.length, 0);
  });

  it('switch off / no recipient → no mail, but deduplicated', async () => {
    settings.set('notify.update_email', 'false');
    settings.set('notify.last_version', '1.124.0');
    assert.equal(await notify.checkVersion(), 'skipped');
    settings.set('notify.update_email', 'true');
    assert.equal(await notify.checkVersion(), 'same');
    settings.set('monitoring.alert_email', '');
    settings.set('notify.last_version', '1.124.0');
    assert.equal(await notify.checkVersion(), 'skipped');
    assert.equal(sent.length, 0);
  });
});

describe('rollback / failure e-mail', () => {
  it('rolled_back → one mail; rewritten marker of the same bad image → no repeat', async () => {
    marker({ checked_at: '2026-09-14T03:00:00+02:00', action: 'rolled_back', bad_image: 'sha256:bad', bad_version: '1.2.3' });
    assert.equal(await notify.checkState(), 'sent');
    assert.equal(sent[0].subject, '[GateControl] Update to v1.2.3 failed — previous version restored');
    assert.match(sent[0].text, /sha256:bad/);
    assert.equal(await notify.checkState(), 'none', 'same checked_at');
    marker({ checked_at: '2026-09-14T03:05:00+02:00', action: 'rolled_back', bad_image: 'sha256:bad', bad_version: '1.2.3' });
    assert.equal(await notify.checkState(), 'repeat', 'update.sh skip run rewrites the marker');
    assert.equal(sent.length, 1);
  });

  it('a new failure after a success mails again', async () => {
    marker({ checked_at: '2026-09-14T03:00:00Z', action: 'rolled_back', bad_image: 'sha256:bad', bad_version: '1.2.3' });
    await notify.checkState();
    marker({ checked_at: '2026-09-15T03:00:00Z', action: 'updated', ok: true });
    assert.equal(await notify.checkState(), 'none');
    marker({ checked_at: '2026-09-16T03:00:00Z', action: 'rolled_back', bad_image: 'sha256:bad2', bad_version: '1.2.4' });
    assert.equal(await notify.checkState(), 'sent');
    assert.equal(sent.length, 2);
  });

  it('failed with bad image (rollback failed) and plain failed (pull) have their own texts; a streak mails once', async () => {
    marker({ checked_at: '2026-09-14T03:00:00Z', action: 'failed', bad_image: 'sha256:bad', bad_version: '1.2.3' });
    await notify.checkState();
    assert.equal(sent[0].subject, '[GateControl] Update and rollback failed — action required');
    marker({ checked_at: '2026-09-14T04:00:00Z', action: 'failed' });
    await notify.checkState();
    assert.equal(sent[1].subject, '[GateControl] Automatic update failed');
    marker({ checked_at: '2026-09-14T04:05:00Z', action: 'failed' });
    assert.equal(await notify.checkState(), 'repeat');
    assert.equal(sent.length, 2);
  });

  it('noop / waiting_window / missing marker → nothing', async () => {
    assert.equal(await notify.checkState(), 'none');
    marker({ checked_at: '2026-09-14T03:00:00Z', action: 'waiting_window', ok: true });
    assert.equal(await notify.checkState(), 'none');
    assert.equal(sent.length, 0);
  });

  it('switch off → state still tracked, no mail', async () => {
    settings.set('notify.update_email', 'false');
    marker({ checked_at: '2026-09-14T03:00:00Z', action: 'rolled_back', bad_image: 'sha256:x' });
    assert.equal(await notify.checkState(), 'skipped');
    settings.set('notify.update_email', 'true');
    marker({ checked_at: '2026-09-14T03:05:00Z', action: 'rolled_back', bad_image: 'sha256:x' });
    assert.equal(await notify.checkState(), 'repeat');
    assert.equal(sent.length, 0);
  });
});
