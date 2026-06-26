'use strict';
const crypto = require('crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown, getAgent } = require('./helpers/setup');
let pihole, license;
beforeEach(async () => { await setup(); pihole = require('../src/services/pihole'); license = require('../src/services/license'); license._overrideForTest({ pihole_integration: true }); });
afterEach(teardown);

test('GET /pihole/top-clients caps display at 10 even when cache holds more', async () => {
  pihole.getCache = () => ({ instances:[{id:'p1',connected:true}], attribution:'per_peer', lastSyncAt:1,
    topClients: Array.from({length:15}, (_,i)=>({ ip:'10.8.0.'+(i+1), count:15-i, peerId:null, peerName:null })) });
  const r = await getAgent().get('/api/v1/pihole/top-clients').expect(200);
  assert.ok(Array.isArray(r.body.data));
  assert.ok(r.body.data.length <= 10, 'display must be capped at 10, got ' + r.body.data.length);
});
