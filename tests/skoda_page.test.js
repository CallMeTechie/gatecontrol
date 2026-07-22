'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const nodeCrypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || nodeCrypto.randomBytes(32).toString('hex');
const { setup, teardown } = require('./helpers/setup');
let ctx;
before(async () => { ctx = await setup(); });
after(async () => { await teardown(); });

test('GET /skoda renders the admin page', async () => {
  const res = await ctx.agent.get('/skoda');
  assert.equal(res.status, 200);
  assert.match(res.text, /skoda-page/);
  assert.match(res.text, /\/js\/skoda\.js/);
});
