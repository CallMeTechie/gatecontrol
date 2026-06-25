'use strict';
const crypto = require('crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown, getAgent, getCsrf } = require('./helpers/setup');
let getDb;
beforeEach(async () => { await setup(); getDb = require('../src/db/connection').getDb; });
afterEach(teardown);
function seedUser(n){ return getDb().prepare("INSERT INTO users (username,password_hash,role) VALUES (?,?,'admin')").run(n,'x').lastInsertRowid; }

test('POST with user_id persists owner (201, body.peer.user_id)', async () => {
  const uid = seedUser('alice'); const agent = getAgent(); const csrf = getCsrf();
  const r = await agent.post('/api/v1/peers').set('X-CSRF-Token', csrf).send({ name: 'devD', user_id: uid }).expect(201);
  assert.equal(r.body.peer.user_id, uid);
});
test('PUT sets user_id and GET reflects owner_name', async () => {
  const uid = seedUser('bob'); const agent = getAgent(); const csrf = getCsrf();
  const c = await agent.post('/api/v1/peers').set('X-CSRF-Token', csrf).send({ name: 'devE' }).expect(201);
  const pid = c.body.peer.id;
  await agent.put('/api/v1/peers/' + pid).set('X-CSRF-Token', csrf).send({ user_id: uid }).expect(200);
  const list = await agent.get('/api/v1/peers').expect(200);
  const row = list.body.peers.find(p => p.id === pid);
  assert.equal(row.user_id, uid); assert.equal(row.owner_name, 'bob');
});
test('PUT rejects a non-existent user_id (400)', async () => {
  const agent = getAgent(); const csrf = getCsrf();
  const c = await agent.post('/api/v1/peers').set('X-CSRF-Token', csrf).send({ name: 'devF' }).expect(201);
  await agent.put('/api/v1/peers/' + c.body.peer.id).set('X-CSRF-Token', csrf).send({ user_id: 999999 }).expect(400);
});
