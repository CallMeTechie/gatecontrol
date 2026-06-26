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
function seedSession(sid, userId){ getDb().prepare("INSERT INTO sessions (sid,data,expires_at) VALUES (?,?,?)").run(sid, JSON.stringify({ userId, cookie:{} }), Date.now()+86400000); }
function sessionCount(userId){ return getDb().prepare("SELECT COUNT(*) n FROM sessions WHERE json_extract(data,'$.userId')=?").get(userId).n; }

test('deleting a user destroys their sessions; other users\' sessions survive', async () => {
  const victim = seedUser('victim'); const other = seedUser('other');
  seedSession('victim-sid-1', victim); seedSession('victim-sid-2', victim); seedSession('other-sid', other);
  assert.equal(sessionCount(victim), 2);
  const agent = getAgent(); const csrf = getCsrf();
  await agent.delete('/api/v1/users/' + victim).set('X-CSRF-Token', csrf).expect(200);
  assert.equal(sessionCount(victim), 0, 'victim sessions must be gone');
  assert.equal(sessionCount(other), 1, 'other user session must survive');
});
