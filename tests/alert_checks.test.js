'use strict';

// services/alertChecks.js — the hourly backup reminder and the CPU/RAM/disk
// thresholds: alert once, re-alert after 24 h while still above, "recovered"
// below threshold − hysteresis, state survives between runs.

const crypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown } = require('./helpers/setup');

let A, settings;
before(async () => {
  await setup();
  A = require('../src/services/alertChecks');
  settings = require('../src/services/settings');
});
after(() => teardown());

const H = 3600 * 1000;
function harness(disk, extra) {
  const logged = [];
  const deps = {
    now: 0,
    resources: async () => Object.assign({ cpu: { percent: 10 }, memory: { percent: 10 }, disk: { percent: disk.value, used: 90 * 2 ** 30, total: 100 * 2 ** 30 } }, extra || {}),
    lastBackupAt: () => null,
    log: (type, message, options) => logged.push({ type, message, options }),
  };
  return { deps, logged };
}

describe('step (pure)', () => {
  it('alert → nothing → realert after 24 h → recovered → alert again', () => {
    let r = A.step(undefined, { over: true, clear: false, now: 0 });
    assert.equal(r.action, 'alert');
    r = A.step(r.state, { over: true, clear: false, now: H });
    assert.equal(r.action, null);
    r = A.step(r.state, { over: true, clear: false, now: A.REALERT_MS });
    assert.equal(r.action, 'realert');
    // between threshold − hysteresis and threshold: still active, no event
    r = A.step(r.state, { over: false, clear: false, now: A.REALERT_MS + H });
    assert.equal(r.action, null);
    assert.equal(r.state.active, true);
    r = A.step(r.state, { over: false, clear: true, now: A.REALERT_MS + 2 * H });
    assert.equal(r.action, 'recovered');
    r = A.step(r.state, { over: true, clear: false, now: A.REALERT_MS + 3 * H });
    assert.equal(r.action, 'alert');
  });
  it('never active and below → no event', () => {
    assert.equal(A.step(undefined, { over: false, clear: true, now: 0 }).action, null);
  });
});

describe('run: disk threshold', () => {
  beforeEach(() => {
    settings.set(A.K_STATE, '{}');
    settings.set('alerts.backup_reminder_days', '0');
    settings.set('alerts.resource_cpu_threshold', '0');
    settings.set('alerts.resource_ram_threshold', '0');
    settings.set('alerts.resource_disk_threshold', '85');
  });

  it('alerts once above the threshold with used/total, deduplicates, re-alerts after 24 h', async () => {
    const disk = { value: 91 };
    const { deps, logged } = harness(disk);
    assert.deepEqual(await A.run(deps), [{ check: 'disk', action: 'alert' }]);
    assert.equal(logged.length, 1);
    assert.equal(logged[0].type, 'resource_alert');
    assert.match(logged[0].message, /Disk usage 91% exceeds threshold 85% \(90\.0 GB of 100\.0 GB\)/);
    assert.equal(logged[0].options.details.resource, 'disk');
    assert.equal(logged[0].options.details.repeat, false);

    deps.now = H;
    assert.deepEqual(await A.run(deps), []);
    deps.now = 23 * H;
    assert.deepEqual(await A.run(deps), []);
    assert.equal(logged.length, 1, 'no repeat within 24 h');

    deps.now = 24 * H;
    assert.deepEqual(await A.run(deps), [{ check: 'disk', action: 'realert' }]);
    assert.equal(logged[1].options.details.repeat, true);
  });

  it('recovers only below threshold − hysteresis, then alerts again at once', async () => {
    const disk = { value: 90 };
    const { deps, logged } = harness(disk);
    await A.run(deps);
    disk.value = 83; // below 85 but above 80
    deps.now = H;
    assert.deepEqual(await A.run(deps), []);
    disk.value = 79;
    deps.now = 2 * H;
    assert.deepEqual(await A.run(deps), [{ check: 'disk', action: 'recovered' }]);
    assert.equal(logged[1].type, 'resource_recovered');
    disk.value = 86;
    deps.now = 3 * H;
    assert.deepEqual(await A.run(deps), [{ check: 'disk', action: 'alert' }]);
  });

  it('exactly at the threshold is not over it; threshold 0 disables the check', async () => {
    const disk = { value: 85 };
    const { deps, logged } = harness(disk);
    assert.deepEqual(await A.run(deps), []);
    settings.set('alerts.resource_disk_threshold', '0');
    disk.value = 99;
    assert.deepEqual(await A.run(deps), []);
    assert.equal(logged.length, 0);
  });

  it('no reading (df failed) keeps the state and logs nothing', async () => {
    const disk = { value: 95 };
    const { deps, logged } = harness(disk);
    await A.run(deps);
    deps.resources = async () => ({ cpu: { percent: 1 }, memory: { percent: 1 }, disk: null });
    deps.now = 30 * H;
    assert.deepEqual(await A.run(deps), []);
    assert.equal(JSON.parse(settings.get(A.K_STATE)).disk.active, true);
    assert.equal(logged.length, 1);
  });

  it('the state survives between runs (stored in the settings)', async () => {
    const disk = { value: 95 };
    const { deps } = harness(disk);
    await A.run(deps);
    const stored = JSON.parse(settings.get(A.K_STATE));
    assert.equal(stored.disk.active, true);
    // a second harness (≈ a restart) does not alert again
    const second = harness(disk);
    second.deps.now = H;
    assert.deepEqual(await A.run(second.deps), []);
  });
});

describe('run: backup reminder and CPU/RAM', () => {
  beforeEach(() => {
    settings.set(A.K_STATE, '{}');
    settings.set('alerts.resource_disk_threshold', '0');
  });
  it('backup reminder fires once while no backup is newer than the limit', async () => {
    settings.set('alerts.backup_reminder_days', '7');
    const { deps, logged } = harness({ value: 0 });
    deps.lastBackupAt = () => 0;
    deps.now = 8 * 24 * H;
    assert.deepEqual(await A.run(deps), [{ check: 'backup', action: 'alert' }]);
    assert.equal(logged[0].type, 'backup_reminder');
    deps.now += H;
    assert.deepEqual(await A.run(deps), []);
    deps.lastBackupAt = () => deps.now;
    deps.now += H;
    assert.deepEqual(await A.run(deps), [{ check: 'backup', action: 'recovered' }]);
    settings.set('alerts.backup_reminder_days', '0');
  });
  it('cpu and ram use the same rules', async () => {
    settings.set('alerts.resource_cpu_threshold', '50');
    settings.set('alerts.resource_ram_threshold', '50');
    const { deps, logged } = harness({ value: 0 }, { cpu: { percent: 70 }, memory: { percent: 20 } });
    assert.deepEqual(await A.run(deps), [{ check: 'cpu', action: 'alert' }]);
    assert.match(logged[0].message, /^CPU usage 70% exceeds threshold 50%$/);
    settings.set('alerts.resource_cpu_threshold', '0');
    settings.set('alerts.resource_ram_threshold', '0');
  });
});
