'use strict';
const crypto = require('crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const { setup, teardown } = require('./helpers/setup');

let app;
beforeEach(async () => { await setup(); app = require('../src/app').createApp(); });
afterEach(teardown);

async function portalHtml() {
  const res = await supertest(app).get('/portal').expect(200);
  return res.text;
}

test('status strip keeps .c-device class (portal.js hydrateDevice guard) + device IDs', async () => {
  const h = await portalHtml();
  assert.match(h, /class="[^"]*\bstrip\b[^"]*"/, 'status .strip present');
  assert.match(h, /class="[^"]*\bc-device\b[^"]*"/, '.c-device class retained for JS guard');
  for (const id of ['deviceStatus', 'deviceAddress', 'deviceDns', 'deviceHandshake', 'deviceKv']) {
    assert.ok(h.includes('id="' + id + '"'), 'kept id ' + id);
  }
});

test('control-first order: Klima (c-midea) appears before Dienste (c-services)', async () => {
  const h = await portalHtml();
  assert.ok(h.indexOf('c-midea') < h.indexOf('c-services'), 'Klima before Dienste');
  assert.ok(h.indexOf('c-smarthome') < h.indexOf('c-services'), 'SmartHome before Dienste');
});

test('portal.css uses full-width wrapper 1560', async () => {
  const res = await supertest(app).get('/css/portal.css').expect(200);
  assert.ok(res.text.includes('max-width:1560px') || res.text.includes('max-width: 1560px'), '.wrap widened to 1560');
});
