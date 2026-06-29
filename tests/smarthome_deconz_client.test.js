'use strict';
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

let origFetch;
beforeEach(() => { origFetch = global.fetch; });
afterEach(() => { global.fetch = origFetch; });

function mockFetch(handler) { global.fetch = async (url, opts) => handler(url, opts); }
function jsonRes(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, async json() { return body; }, async text() { return JSON.stringify(body); } };
}

const { createClient, briToDeconz, briFromDeconz } = require('../src/services/smarthome/deconzClient');

test('bri normalization both directions', () => {
  assert.equal(briToDeconz(0), 0);
  assert.equal(briToDeconz(100), 254);
  assert.equal(briFromDeconz(254), 100);
  assert.equal(briFromDeconz(0), 0);
});

test('acquireApiKey returns key on success', async () => {
  mockFetch((url, opts) => { assert.equal(opts.method, 'POST'); assert.match(url, /\/api$/); return jsonRes([{ success: { username: 'ABC123' } }]); });
  const { apiKey } = await createClient({ baseUrl: 'http://gw' }).acquireApiKey();
  assert.equal(apiKey, 'ABC123');
});

test('acquireApiKey maps link-button error (type 101)', async () => {
  mockFetch(() => jsonRes([{ error: { type: 101, description: 'link button not pressed' } }]));
  await assert.rejects(() => createClient({ baseUrl: 'http://gw' }).acquireApiKey(), (e) => e.code === 'DECONZ_LINK_BUTTON_NOT_PRESSED');
});

test('getLights GETs /api/<key>/lights', async () => {
  mockFetch((url) => { assert.equal(url, 'http://gw/api/KEY/lights'); return jsonRes({ '1': { name: 'L', state: { on: true } } }); });
  const lights = await createClient({ baseUrl: 'http://gw', apiKey: 'KEY' }).getLights();
  assert.equal(lights['1'].name, 'L');
});

test('setLightState normalizes bri and PUTs state', async () => {
  let sent;
  mockFetch((url, opts) => { sent = { url, body: JSON.parse(opts.body) }; return jsonRes([{ success: {} }]); });
  await createClient({ baseUrl: 'http://gw', apiKey: 'KEY' }).setLightState('5', { on: true, bri: 50 });
  assert.equal(sent.url, 'http://gw/api/KEY/lights/5/state');
  assert.equal(sent.body.on, true);
  assert.equal(sent.body.bri, 127); // round(50/100*254)
});

test('setGroupState uses /action endpoint', async () => {
  let url;
  mockFetch((u) => { url = u; return jsonRes([{ success: {} }]); });
  await createClient({ baseUrl: 'http://gw', apiKey: 'KEY' }).setGroupState('2', { on: false });
  assert.equal(url, 'http://gw/api/KEY/groups/2/action');
});

// Delta tests: headers forwarded on GET and PUT
test('custom headers sent on GET request', async () => {
  let capturedHeaders;
  mockFetch((url, opts) => { capturedHeaders = opts.headers; return jsonRes({ '1': { name: 'L' } }); });
  await createClient({ baseUrl: 'http://gw', apiKey: 'KEY', headers: { 'X-Gateway-Target-Domain': 'phoscon.example.com' } }).getLights();
  assert.equal(capturedHeaders['X-Gateway-Target-Domain'], 'phoscon.example.com');
});

test('custom headers sent on PUT request', async () => {
  let capturedHeaders;
  mockFetch((url, opts) => { capturedHeaders = opts.headers; return jsonRes([{ success: {} }]); });
  await createClient({ baseUrl: 'http://gw', apiKey: 'KEY', headers: { 'X-Gateway-Target-Domain': 'phoscon.example.com' } }).setLightState('1', { on: true });
  assert.equal(capturedHeaders['X-Gateway-Target-Domain'], 'phoscon.example.com');
});

// Delta tests: getConfig
test('getConfig GETs /api/<key>/config when apiKey present', async () => {
  let url;
  mockFetch((u) => { url = u; return jsonRes({ name: 'GW', swversion: '2.27.2' }); });
  await createClient({ baseUrl: 'http://gw', apiKey: 'KEY' }).getConfig();
  assert.equal(url, 'http://gw/api/KEY/config');
});

test('getConfig GETs /api/config when no apiKey', async () => {
  let url;
  mockFetch((u) => { url = u; return jsonRes({ name: 'GW', swversion: '2.27.2' }); });
  await createClient({ baseUrl: 'http://gw' }).getConfig();
  assert.equal(url, 'http://gw/api/config');
});
