'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const cloud = require('../src/services/midea/mideaCloud');
const mideaAc = require('../src/services/midea/mideaAc');

// Fixed per-session AES key/IV (hex, 16 bytes each) for deterministic transport tests.
// These stand in for what login() derives from the cloud's accessToken/randomData.
const TEST_AES_KEY = '0123456789abcdef0123456789abcdef';
const TEST_AES_IV = 'fedcba9876543210fedcba9876543210';

// Same codec sendCommand uses for `order`/`reply`: AES-128-CBC, PKCS7, derived IV.
function cbcEncHex(keyHex, ivHex, buf) {
  const c = crypto.createCipheriv('aes-128-cbc', Buffer.from(keyHex, 'hex'), Buffer.from(ivHex, 'hex'));
  c.setAutoPadding(true);
  return Buffer.concat([c.update(buf), c.final()]).toString('hex');
}
// Encode a frame buffer as the cloud would return it: comma-decimal ASCII, then session-key CBC.
function encReply(frameBuf) {
  return cbcEncHex(TEST_AES_KEY, TEST_AES_IV, Buffer.from(Array.from(frameBuf).join(','), 'ascii'));
}

test('APP_VARIANTS expose public constants, not secrets', () => {
  assert.equal(cloud.APP_VARIANTS.msmarthome.appId, '1010');
  assert.equal(cloud.APP_VARIANTS.nethome.appId, '1017');
  assert.ok(cloud.APP_VARIANTS.nethome.appKey);   // public app key present
});

test('computeUdpid matches the real msmart vector (big-endian device id)', () => {
  // device_id 147334558165565 → big-endian 6-byte id = 86000000aa3d
  // udpid = strxor(sha256(idBytes)[:16], sha256(idBytes)[16:]).hex
  // This is the SHARP vector — verified against the V3 discovery response tail.
  const idBytes = Buffer.from('86000000aa3d', 'hex');
  assert.equal(cloud.computeUdpid(idBytes), '4fbe0d4139de99cc88a0285e14657045');
  // little-endian sibling, for completeness:
  assert.equal(cloud.computeUdpid(Buffer.from('3daa00000086', 'hex')), 'b617531f693d3380eed45a7fa2e257b2');
});

test('getToken builds idBytes for both endians without RangeError', async () => {
  const c = new cloud.MideaCloud('msmarthome');
  // Stub the network: always return an empty tokenlist so both endianness
  // branches run their buffer construction, then fall through to NO_TOKEN.
  const calls = [];
  c._request = async (endpoint, body) => { calls.push(body.udpid); return { tokenlist: [] }; };
  await assert.rejects(
    () => c.getToken('147334558165565'),
    (e) => e.code === 'MIDEA_CLOUD_NO_TOKEN',
  );
  // Both endianness udpids were attempted (no synchronous RangeError aborted it).
  assert.equal(calls.length, 2);
});

test('MSmartHome request body sends NUMERIC format/clientType (cloud.py types)', async () => {
  const c = new cloud.MideaCloud('msmarthome');
  let sent;
  const origFetch = global.fetch;
  global.fetch = async (_url, opts) => { sent = JSON.parse(opts.body); return { status: 200, json: async () => ({ code: '0', data: {} }) }; };
  try {
    await c._requestMSmart('/v1/user/login/id/get', { loginAccount: 'a@b.de' });
  } finally { global.fetch = origFetch; }
  // The Midea cloud rejects "2"/"1" (strings) with "value is illegal" — these must be numbers.
  assert.strictEqual(sent.format, 2);
  assert.strictEqual(sent.clientType, 1);
  assert.equal(typeof sent.format, 'number');
  assert.equal(typeof sent.clientType, 'number');
  // common fields present + passthrough data merged
  assert.equal(sent.appId, '1010');
  assert.equal(sent.language, 'en_US');
  assert.equal(sent.loginAccount, 'a@b.de');
  assert.ok(sent.stamp && sent.reqId && sent.deviceId);
});

test('sendCommand posts the encrypted frame to the transparent-send endpoint with applianceCode', async () => {
  const c = new cloud.MideaCloud('msmarthome');
  c.session = { accessToken: 'tok', aesKey: TEST_AES_KEY, aesIv: TEST_AES_IV };
  let sent;
  const orig = global.fetch;
  global.fetch = async (url, opts) => {
    sent = { url: String(url), body: opts.body, headers: opts.headers };
    // A valid synchronous reply so sendCommand resolves rather than throws.
    const reply = encReply(Buffer.from([0xaa, 0x01, 0x02, 0x03]));
    return { status: 200, json: async () => ({ code: '0', data: { reply } }) };
  };
  try {
    const frame = mideaAc.buildQuery({ messageId: 1 });
    await c.sendCommand('153931628798542', frame);
  } finally { global.fetch = orig; }

  assert.match(sent.url, /transparent\/send/);
  assert.ok(sent.headers.sign && sent.headers.random);   // HMAC signature headers present
  const body = JSON.parse(sent.body);
  // Device addressing is the NUMERIC applianceCode string — NOT applianceId/deviceId-as-address.
  assert.strictEqual(body.applianceCode, '153931628798542');
  assert.equal(typeof body.applianceCode, 'string');
  assert.strictEqual(body.applianceId, undefined);
  // Encrypted command embedded as a hex string + the exact request-specific flags.
  assert.equal(typeof body.order, 'string');
  assert.match(body.order, /^[0-9a-f]+$/);
  assert.strictEqual(body.funId, 0);
  assert.strictEqual(body.waitResp, true);
  assert.strictEqual(body.isFull, false);
});

test('sendCommand decrypts the synchronous reply into the original frame buffer', async () => {
  const c = new cloud.MideaCloud('msmarthome');
  c.session = { accessToken: 'tok', aesKey: TEST_AES_KEY, aesIv: TEST_AES_IV };
  // A real AC frame as the device's synchronous reply; sendCommand must round-trip it byte-for-byte.
  const replyFrame = Buffer.from(mideaAc.buildQuery({ messageId: 7 }));
  const reply = encReply(replyFrame);
  const orig = global.fetch;
  global.fetch = async () => ({ status: 200, json: async () => ({ code: '0', data: { reply } }) });
  let out;
  try {
    out = await c.sendCommand('153931628798542', mideaAc.buildQuery({ messageId: 1 }));
  } finally { global.fetch = orig; }
  assert.ok(Buffer.isBuffer(out));
  assert.deepEqual(out, replyFrame);
});

test('sendCommand retries on Midea code 3176 and then returns the buffer', async () => {
  const c = new cloud.MideaCloud('msmarthome');
  c.session = { accessToken: 'tok', aesKey: TEST_AES_KEY, aesIv: TEST_AES_IV };
  c.sendCommandBackoffMs = 1;   // keep the retry backoff tiny — no real 1.5s sleep in tests
  const replyFrame = Buffer.from([0xaa, 0x10, 0x20, 0x30]);
  const reply = encReply(replyFrame);
  let calls = 0;
  const orig = global.fetch;
  global.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return { status: 200, json: async () => ({ code: '3176', msg: 'The asyn reply does not exist' }) };
    }
    return { status: 200, json: async () => ({ code: '0', data: { reply } }) };
  };
  let out;
  try {
    out = await c.sendCommand('153931628798542', mideaAc.buildQuery({ messageId: 1 }));
  } finally { global.fetch = orig; }
  assert.equal(calls, 2);
  assert.deepEqual(out, replyFrame);
});

test('live login + listDevices', { skip: !process.env.GC_MIDEA_CLOUD }, async () => {
  const { email, password, app } = JSON.parse(process.env.GC_MIDEA_CLOUD);
  const c = new cloud.MideaCloud(app);
  await c.login(email, password);
  const devs = await c.listDevices();
  assert.ok(Array.isArray(devs));
});
