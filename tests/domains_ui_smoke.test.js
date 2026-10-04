'use strict';
const crypto = require('crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown, getAgent } = require('./helpers/setup');

beforeEach(async () => { await setup(); });
afterEach(teardown);

test('settings page renders the Domains section', async () => {
  const res = await getAgent().get('/settings').expect(200);
  assert.match(res.text, /data-section="domains"/);
  assert.match(res.text, /id="st-dom-list"/);
  assert.match(res.text, /id="st-dom-add"/);
  const visible = res.text.replace(/<script[\s\S]*?<\/script>/g, '');
  assert.doesNotMatch(visible, /settings\.domains\.[a-z_]+|>st\.[a-z_.]+<|"st\.[a-z_.]+"/i); // no raw i18n keys leaked
});
