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

test('createDevice persists transport + cloud_appliance_id', () => {
  const d = devices.createDevice({ name: 'AC-Cloud', device_sn: 'cloud-1', transport: 'cloud', cloud_appliance_id: '153931628798542' });
  assert.equal(d.transport, 'cloud');
  assert.equal(d.cloud_appliance_id, '153931628798542');
  const got = devices.getDevice(d.id);
  assert.equal(got.transport, 'cloud');
  assert.equal(got.cloud_appliance_id, '153931628798542');
});
test('default transport is lan', () => {
  const d = devices.createDevice({ name: 'AC-Lan', device_sn: 'lan-x' });
  assert.equal(d.transport, 'lan');
});

// ── Orchestrator transport switch (Task 3) ──────────────────────────────────

// Frame parsed by mideaAc.parseState → targetTemp 21, mode 'cool', power true.
const CLOUD_SAMPLE = Buffer.from(
  'aa23ac00000000000303c00145660000003c0010045c6b20000000000000000000020d79', 'hex',
);

function preconfigureCloudSession() {
  // Provide a session so withCloud()→ensure() skips the real login() call.
  devices.saveConfig({
    app: 'msmarthome', email: 't@e.st', password: 'pw',
    session: { accessToken: 'tok', aesKey: '00'.repeat(16), aesIv: '11'.repeat(16) },
  });
}

test('getState for a cloud device routes through mideaCloud.sendCommand, not LanDevice', async () => {
  const midea = require('../src/services/midea');
  const cloud = require('../src/services/midea/mideaCloud');
  preconfigureCloudSession();
  const d = devices.createDevice({ name: 'C', device_sn: 'c-1', transport: 'cloud', cloud_appliance_id: '999' });
  const calls = [];
  const orig = cloud.MideaCloud.prototype.sendCommand;
  cloud.MideaCloud.prototype.sendCommand = async function (applianceCode, frame) {
    calls.push({ applianceCode, frame });
    return CLOUD_SAMPLE;       // returning a frame proves the LAN path never ran (would connect/timeout)
  };
  try {
    const st = await midea.getState(d.id);
    assert.equal(st.targetTemp, 21.0);                  // parsed from the stubbed cloud frame
    assert.equal(calls.length, 1);                      // exactly one cloud round-trip (the query)
    assert.equal(calls[0].applianceCode, '999');        // addressed by cloud_appliance_id
    assert.equal(calls[0].frame[9], 0x03);              // FRAME_QUERY frame type
  } finally {
    cloud.MideaCloud.prototype.sendCommand = orig;
    midea.stopPolling();
  }
});

test('getState for a cloud device serves cached state within TTL (no second cloud round-trip / re-login)', async () => {
  const midea = require('../src/services/midea');
  const cloud = require('../src/services/midea/mideaCloud');
  preconfigureCloudSession();
  const d = devices.createDevice({ name: 'C3', device_sn: 'c-3', transport: 'cloud', cloud_appliance_id: '555' });
  let calls = 0;
  const orig = cloud.MideaCloud.prototype.sendCommand;
  cloud.MideaCloud.prototype.sendCommand = async function () { calls += 1; return CLOUD_SAMPLE; };
  try {
    const a = await midea.getState(d.id);   // cold → one cloud round-trip, populates cache
    const b = await midea.getState(d.id);   // warm → served from cache, no cloud call
    assert.equal(calls, 1, 'second getState within TTL must not hit the cloud');
    assert.deepEqual(b, a);                 // identical state returned from cache
  } finally {
    cloud.MideaCloud.prototype.sendCommand = orig;
    midea.stopPolling();
  }
});

test('setState for a cloud device does inline read-modify-write via sendCommand, not LanDevice', async () => {
  const midea = require('../src/services/midea');
  const cloud = require('../src/services/midea/mideaCloud');
  preconfigureCloudSession();
  const d = devices.createDevice({ name: 'C2', device_sn: 'c-2', transport: 'cloud', cloud_appliance_id: '777' });
  const frameTypes = [];
  const orig = cloud.MideaCloud.prototype.sendCommand;
  cloud.MideaCloud.prototype.sendCommand = async function (applianceCode, frame) {
    frameTypes.push(frame[9]);
    return CLOUD_SAMPLE;
  };
  try {
    const st = await midea.setState(d.id, { targetTemp: 23 });
    assert.deepEqual(frameTypes, [0x03, 0x02]);         // read (query) then write (control) in one lock
    assert.equal(st.targetTemp, 21.0);                  // parsed from the stubbed control response
  } finally {
    cloud.MideaCloud.prototype.sendCommand = orig;
    midea.stopPolling();
  }
});

// ── Task 5: minimal cloud footprint ────────────────────────────────────────

test('pollTick skips cloud devices (no cloud sendCommand) but polls lan devices', async () => {
  const midea = require('../src/services/midea');
  const cloud = require('../src/services/midea/mideaCloud');
  let cloudCalls = 0;
  const origSend = cloud.MideaCloud.prototype.sendCommand;
  cloud.MideaCloud.prototype.sendCommand = async () => { cloudCalls++; return Buffer.alloc(0); };
  try {
    devices.createDevice({ name: 'C', device_sn: 'c-2', transport: 'cloud', cloud_appliance_id: '1', enabled: true });
    await midea.pollTick();                  // ein Tick, ohne Timer
    assert.equal(cloudCalls, 0);             // Cloud-Gerät NICHT automatisch gepollt
  } finally { cloud.MideaCloud.prototype.sendCommand = origSend; midea.stopPolling(); }
});

test('getStatus includes transport per device and cloud_needs_reauth boolean', () => {
  const midea = require('../src/services/midea');
  devices.createDevice({ name: 'AC-T', device_sn: 'lan-t', ip: '10.0.0.1' });
  const status = midea.getStatus();
  assert.equal(typeof status.cloud_needs_reauth, 'boolean');
  assert.ok(status.devices.length > 0);
  assert.ok('transport' in status.devices[0]);
});

test('cloud_needs_reauth is set true when getState receives MIDEA_CLOUD_2FA_REQUIRED', async () => {
  const midea = require('../src/services/midea');
  const cloud = require('../src/services/midea/mideaCloud');
  preconfigureCloudSession();
  const d = devices.createDevice({ name: 'C3', device_sn: 'c-3', transport: 'cloud', cloud_appliance_id: '2FA' });
  const origSend = cloud.MideaCloud.prototype.sendCommand;
  cloud.MideaCloud.prototype.sendCommand = async () => {
    const e = new Error('2FA required');
    e.code = 'MIDEA_CLOUD_2FA_REQUIRED';
    throw e;
  };
  try {
    await midea.getState(d.id);
    assert.equal(midea.getStatus().cloud_needs_reauth, true);
  } finally {
    // Reset cloudNeedsReauth so it does not leak into subsequent tests.
    cloud.MideaCloud.prototype.sendCommand = async () => CLOUD_SAMPLE;
    await midea.getState(d.id);           // success path sets cloudNeedsReauth = false
    cloud.MideaCloud.prototype.sendCommand = origSend;
    midea.stopPolling();
  }
});

test('cloud_needs_reauth resets to false after successful getState following a 2FA error', async () => {
  const midea = require('../src/services/midea');
  const cloud = require('../src/services/midea/mideaCloud');
  preconfigureCloudSession();
  const d = devices.createDevice({ name: 'C4', device_sn: 'c-4r', transport: 'cloud', cloud_appliance_id: '2FA-RESET' });
  const origSend = cloud.MideaCloud.prototype.sendCommand;
  try {
    // Step 1: trigger 2FA → flag becomes true.
    cloud.MideaCloud.prototype.sendCommand = async () => {
      const e = new Error('2FA required');
      e.code = 'MIDEA_CLOUD_2FA_REQUIRED';
      throw e;
    };
    await midea.getState(d.id);
    assert.equal(midea.getStatus().cloud_needs_reauth, true, '2FA error sets flag');
    // Step 2: successful command → flag clears to false.
    cloud.MideaCloud.prototype.sendCommand = async () => CLOUD_SAMPLE;
    await midea.getState(d.id);
    assert.equal(midea.getStatus().cloud_needs_reauth, false, 'successful call clears flag');
  } finally {
    cloud.MideaCloud.prototype.sendCommand = origSend;
    midea.stopPolling();
  }
});

test('setState sets cloud_needs_reauth when the write sendCommand throws MIDEA_CLOUD_2FA_REQUIRED', async () => {
  const midea = require('../src/services/midea');
  const cloud = require('../src/services/midea/mideaCloud');
  preconfigureCloudSession();
  const d = devices.createDevice({ name: 'C5', device_sn: 'c-5w', transport: 'cloud', cloud_appliance_id: 'SET-2FA' });
  const origSend = cloud.MideaCloud.prototype.sendCommand;
  let callCount = 0;
  cloud.MideaCloud.prototype.sendCommand = async (_applianceCode, _frame) => {
    callCount++;
    if (callCount === 1) return CLOUD_SAMPLE;   // read (query) succeeds
    const e = new Error('2FA required on write');
    e.code = 'MIDEA_CLOUD_2FA_REQUIRED';
    throw e;                                     // write (control) triggers 2FA
  };
  try {
    await midea.setState(d.id, { targetTemp: 23 });
    assert.equal(midea.getStatus().cloud_needs_reauth, true, '2FA on setState write sets flag');
  } finally {
    // Reset cloudNeedsReauth for isolation.
    cloud.MideaCloud.prototype.sendCommand = async () => CLOUD_SAMPLE;
    await midea.getState(d.id);
    cloud.MideaCloud.prototype.sendCommand = origSend;
    midea.stopPolling();
  }
});
