'use strict';
const crypto = require('crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown, getAgent, getCsrf } = require('./helpers/setup');

let getDb, settings;
beforeEach(async () => { await setup(); getDb = require('../src/db/connection').getDb; settings = require('../src/services/settings'); });
afterEach(teardown);

test('DELETE is blocked while the portal uses the domain', async () => {
  const info = getDb().prepare("INSERT INTO domains (domain, status) VALUES ('domaincaster.com','verified')").run();
  settings.set('portal.base_domain', 'domaincaster.com');
  const agent = getAgent(); const csrf = getCsrf();
  const res = await agent.delete('/api/v1/settings/domains/' + info.lastInsertRowid).set('X-CSRF-Token', csrf);
  assert.ok([400, 409].includes(res.status), `expected 400/409, got ${res.status}`);
  assert.ok(getDb().prepare('SELECT 1 FROM domains WHERE id=?').get(info.lastInsertRowid)); // still there
});

test('DELETE succeeds for an unused domain', async () => {
  const info = getDb().prepare("INSERT INTO domains (domain, status) VALUES ('other.com','verified')").run();
  const agent = getAgent(); const csrf = getCsrf();
  await agent.delete('/api/v1/settings/domains/' + info.lastInsertRowid).set('X-CSRF-Token', csrf).expect(200);
});
