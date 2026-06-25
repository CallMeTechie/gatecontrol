'use strict';
const crypto = require('crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const { setup, teardown, getAgent, getCsrf } = require('./helpers/setup');
let peers, getDb, app;
beforeEach(async () => { await setup(); peers = require('../src/services/peers'); getDb = require('../src/db/connection').getDb; app = require('../src/app').createApp(); });
afterEach(teardown);
async function mk(n){ return (await peers.create({ name: n })).id; }
function seedUser(n){ return getDb().prepare("INSERT INTO users (username,password_hash,role) VALUES (?,?,'admin')").run(n,'x').lastInsertRowid; }

test('batch-owner sets owner for many (hits bulk handler: body.affected)', async () => {
  const uid = seedUser('bob'); const a = await mk('p1'); const b = await mk('p2');
  const agent = getAgent(); const csrf = getCsrf();
  const r = await agent.post('/api/v1/peers/batch-owner').set('X-CSRF-Token', csrf).send({ peer_ids: [a, b], user_id: uid }).expect(200);
  assert.equal(r.body.ok, true); assert.equal(r.body.affected, 2);
  assert.equal(getDb().prepare('SELECT user_id FROM peers WHERE id=?').get(a).user_id, uid);
});
test('batch-owner user_id null clears ownership', async () => {
  const uid = seedUser('carol'); const a = await mk('p3'); const agent = getAgent(); const csrf = getCsrf();
  await agent.post('/api/v1/peers/batch-owner').set('X-CSRF-Token', csrf).send({ peer_ids: [a], user_id: uid }).expect(200);
  await agent.post('/api/v1/peers/batch-owner').set('X-CSRF-Token', csrf).send({ peer_ids: [a], user_id: null }).expect(200);
  assert.equal(getDb().prepare('SELECT user_id FROM peers WHERE id=?').get(a).user_id, null);
});
test('batch-owner rejects empty/too-large peer_ids and bad user_id (400)', async () => {
  const agent = getAgent(); const csrf = getCsrf();
  await agent.post('/api/v1/peers/batch-owner').set('X-CSRF-Token', csrf).send({ peer_ids: [], user_id: null }).expect(400);
  await agent.post('/api/v1/peers/batch-owner').set('X-CSRF-Token', csrf).send({ peer_ids: Array.from({length:501},(_,i)=>i+1), user_id: null }).expect(400);
  await agent.post('/api/v1/peers/batch-owner').set('X-CSRF-Token', csrf).send({ peer_ids: [1], user_id: 999999 }).expect(400);
});
test('batch-owner without auth/CSRF is rejected (401/403)', async () => {
  const res = await supertest(app).post('/api/v1/peers/batch-owner').send({ peer_ids: [1], user_id: null });
  assert.ok([401, 403].includes(res.status), `expected 401/403, got ${res.status}`);
});
