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
const { createClient } = require('../src/services/smarthome/deconzClient');
const client = () => createClient({ baseUrl: 'http://gw', apiKey: 'KEY' });

test('createRule POSTs /rules and returns new id', async () => {
  mockFetch((url, opts) => {
    assert.equal(url, 'http://gw/api/KEY/rules');
    assert.equal(opts.method, 'POST');
    assert.match(opts.body, /"conditions"/);
    return jsonRes([{ success: { id: '7' } }]);
  });
  const id = await client().createRule({ name: 'r', conditions: [], actions: [] });
  assert.equal(id, '7');
});

test('createRule throws coded error on deconz error array', async () => {
  mockFetch(() => jsonRes([{ error: { type: 601, description: 'rule limit reached' } }]));
  await assert.rejects(() => client().createRule({}), (e) => e.code === 'DECONZ_ERR_601');
});

test('getRules GETs /rules', async () => {
  mockFetch((url) => { assert.equal(url, 'http://gw/api/KEY/rules'); return jsonRes({ '1': { name: 'r1' } }); });
  const rules = await client().getRules();
  assert.equal(rules['1'].name, 'r1');
});

test('updateRule PUTs /rules/:id', async () => {
  mockFetch((url, opts) => { assert.equal(url, 'http://gw/api/KEY/rules/5'); assert.equal(opts.method, 'PUT'); return jsonRes([{ success: {} }]); });
  await client().updateRule('5', { name: 'x' });
});

test('deleteRule DELETEs /rules/:id', async () => {
  mockFetch((url, opts) => { assert.equal(url, 'http://gw/api/KEY/rules/5'); assert.equal(opts.method, 'DELETE'); return jsonRes([{ success: {} }]); });
  await client().deleteRule('5');
});

test('createSchedule returns id; createClipSensor returns id; setClipSensorState PUTs state', async () => {
  mockFetch((url, opts) => {
    if (url.endsWith('/schedules')) { assert.equal(opts.method, 'POST'); return jsonRes([{ success: { id: 's2' } }]); }
    if (url.endsWith('/sensors')) { assert.equal(opts.method, 'POST'); return jsonRes([{ success: { id: 'c3' } }]); }
    if (url.endsWith('/sensors/c3/state')) { assert.equal(opts.method, 'PUT'); return jsonRes([{ success: {} }]); }
    throw new Error('unexpected ' + url);
  });
  const c = client();
  assert.equal(await c.createSchedule({ time: 'PT00:05:00' }), 's2');
  assert.equal(await c.createClipSensor({ name: 'flag' }), 'c3');
  await c.setClipSensorState('c3', { flag: true });
});

test('deleteClipSensor DELETEs /sensors/:id', async () => {
  mockFetch((url, opts) => { assert.equal(url, 'http://gw/api/KEY/sensors/c3'); assert.equal(opts.method, 'DELETE'); return jsonRes([{ success: {} }]); });
  await client().deleteClipSensor('c3');
});
