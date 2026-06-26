'use strict';
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const nodeCrypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || nodeCrypto.randomBytes(32).toString('hex');
const { setup, teardown } = require('./helpers/setup');

let devices;
before(async () => {
  await setup();                              // läuft Migrationen + seedet Admin
  devices = require('../src/services/midea/mideaDevices');
});
after(async () => { await teardown(); });
beforeEach(() => {
  for (const d of devices.listDevices()) devices.removeDevice(d.id);
});

test('createDevice + getDevice round-trips and decrypts secrets', () => {
  const d = devices.createDevice({
    name: 'Wohnzimmer', device_sn: 'SN-TEST-1', device_id: '123456',
    ip: '192.168.1.50', protocol_version: 3, token: 'deadbeef', key: 'cafef00d', model: 'PortaSplit',
  });
  assert.equal(d.name, 'Wohnzimmer');
  assert.equal(d.enabled, true);
  const got = devices.getDevice(d.id);
  assert.equal(got.token, 'deadbeef');        // entschlüsselt zurück
  assert.equal(got.key, 'cafef00d');
  assert.equal(got.port, 6444);               // Default
});

test('listDevicesRedacted hides secrets', () => {
  devices.createDevice({ name: 'X', device_sn: 'SN-2', token: 'aa', key: 'bb' });
  const [r] = devices.listDevicesRedacted();
  assert.equal(r.token, undefined);
  assert.equal(r.key, undefined);
  assert.equal(r.has_credentials, true);
});

test('updateDevice patches fields, re-encrypts secrets, toggles enabled, clears token via null', () => {
  const d = devices.createDevice({
    name: 'Old', device_sn: 'SN-UPD', ip: '10.0.0.1', token: 'aaaa', key: 'bbbb',
  });
  devices.updateDevice(d.id, { name: 'NewName', ip: '10.0.0.9', enabled: false, token: 'feedface', key: '00ff' });
  let got = devices.getDevice(d.id);
  assert.equal(got.name, 'NewName');
  assert.equal(got.ip, '10.0.0.9');
  assert.equal(got.enabled, false);
  assert.equal(got.token, 'feedface');        // re-encrypted, round-trips through decrypt
  assert.equal(got.key, '00ff');

  devices.updateDevice(d.id, { token: null });
  got = devices.getDevice(d.id);
  assert.equal(got.token, null);              // cleared
  assert.equal(got.key, '00ff');              // key unchanged
});

test('config save/load encrypts password, redact hides it', () => {
  const settings = require('../src/services/settings');
  const sessionObj = { accessToken: 'tok123', loginId: 'x' };
  devices.saveConfig({ app: 'msmarthome', email: 'a@b.de', password: 'secret', session: sessionObj });
  const cfg = devices.loadConfig();
  assert.equal(cfg.password, 'secret');
  assert.deepEqual(cfg.session, sessionObj);     // round-trips through encryption
  const red = devices.redactConfig(cfg);
  assert.equal(red.password, undefined);
  assert.equal(red.password_set, true);
  assert.equal(red.email, 'a@b.de');
  assert.equal(red.session, undefined);
  assert.equal(red.session_active, true);

  // RAW stored value must be ciphertext (iv:tag:ct), never plaintext secrets.
  const stored = JSON.parse(settings.get('midea_config'));
  assert.ok(!stored.password.includes('secret'), 'password stored as ciphertext');
  assert.ok(!stored.session.includes('tok123'), 'session stored as ciphertext');
  assert.match(stored.session, /^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/);
});

// ── Orchestrator (Task 9) ──────────────────────────────────────────────────

test('withDeviceLock serializes concurrent operations per device', async () => {
  const midea = require('../src/services/midea');
  const order = [];
  const slow = (tag, ms) => midea.withDeviceLock(1, async () => {
    order.push(`start-${tag}`); await new Promise((r) => setTimeout(r, ms)); order.push(`end-${tag}`);
  });
  await Promise.all([slow('a', 30), slow('b', 5)]);
  assert.deepEqual(order, ['start-a', 'end-a', 'start-b', 'end-b']); // b waits for a
});

test('getState returns offline marker when device unreachable', async () => {
  const midea = require('../src/services/midea');
  const d = devices.createDevice({ name: 'Z', device_sn: 'SN-OFF', ip: '127.0.0.1', port: 1, protocol_version: 3, token: 'aa', key: 'bb' });
  const st = await midea.getState(d.id);
  assert.equal(st.offline, true);
});

test('addDevice is transactional: a V3 device with no cloud config persists nothing', async () => {
  const midea = require('../src/services/midea');
  await assert.rejects(() => midea.addDevice({ sn: 'SN-NOCLOUD', ip: '127.0.0.1' }));
  assert.equal(devices.listDevices().some((d) => d.device_sn === 'SN-NOCLOUD'), false);
});

test('getStatus returns the documented shape', () => {
  const midea = require('../src/services/midea');
  const status = midea.getStatus();
  assert.ok(Array.isArray(status.devices));
  assert.ok('lastPollAt' in status);
});

test('startPolling is a no-op under revoked license (feature gate)', () => {
  const license = require('../src/services/license');
  const midea = require('../src/services/midea');
  const saved = license.hasFeature('midea_integration');
  try {
    license._overrideForTest({ midea_integration: false });
    midea.startPolling();                 // ensurePolling must bail: no timer created
    const status = midea.getStatus();
    assert.ok(Array.isArray(status.devices));   // no throw under revoked license
  } finally {
    license._overrideForTest({ midea_integration: saved });
    midea.stopPolling();                  // ensure no timer leaks out of the test
  }
});
