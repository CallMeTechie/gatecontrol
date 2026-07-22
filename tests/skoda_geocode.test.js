'use strict';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const geo = require('../src/services/skoda/skodaGeocode');

beforeEach(() => geo._resetForTest());

function jsonRes(obj, status = 200) {
  return { status, ok: status < 400, headers: new Headers({ 'content-type': 'application/json' }), json: async () => obj };
}

test('reverseGeocode builds a compact label from nominatim address', async () => {
  let seenUrl = null; let seenHeaders = null;
  const fetchImpl = async (url, opts) => {
    seenUrl = url; seenHeaders = opts.headers;
    return jsonRes({ address: { road: 'Hauptstraße', house_number: '5', postcode: '50667', city: 'Köln', country: 'Deutschland' } });
  };
  const label = await geo.reverseGeocode(50.9413, 6.9583, { fetchImpl });
  assert.equal(label, 'Hauptstraße 5, 50667 Köln');
  assert.match(seenUrl, /^https:\/\/nominatim\.openstreetmap\.org\/reverse\?/);
  assert.match(seenUrl, /lat=50\.9413/);
  assert.match(seenUrl, /format=jsonv2/);
  assert.ok(seenHeaders['user-agent'] && /GateControl/i.test(seenHeaders['user-agent']));
});

test('reverseGeocode falls back to display_name when address parts are sparse', async () => {
  const fetchImpl = async () => jsonRes({ display_name: 'Some Place, Region, Country', address: {} });
  assert.equal(await geo.reverseGeocode(1, 2, { fetchImpl }), 'Some Place, Region, Country');
});

test('reverseGeocode caches by rounded coordinate (no second fetch within ~110m)', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return jsonRes({ address: { city: 'Köln' } }); };
  await geo.reverseGeocode(50.94131, 6.95832, { fetchImpl });
  await geo.reverseGeocode(50.94119, 6.95841, { fetchImpl }); // same 3-decimal bucket
  assert.equal(calls, 1);
});

test('reverseGeocode returns null and caches null on HTTP error', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return jsonRes({}, 500); };
  assert.equal(await geo.reverseGeocode(10, 10, { fetchImpl }), null);
  assert.equal(await geo.reverseGeocode(10, 10, { fetchImpl }), null); // cached null
  assert.equal(calls, 1);
});

test('reverseGeocode returns null for invalid coordinates without fetching', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return jsonRes({}); };
  assert.equal(await geo.reverseGeocode(null, 6, { fetchImpl }), null);
  assert.equal(await geo.reverseGeocode(999, 6, { fetchImpl }), null);
  assert.equal(calls, 0);
});

test('reverseGeocode returns null on fetch rejection (timeout/network)', async () => {
  const fetchImpl = async () => { throw new Error('aborted'); };
  assert.equal(await geo.reverseGeocode(48.1, 11.5, { fetchImpl }), null);
});
