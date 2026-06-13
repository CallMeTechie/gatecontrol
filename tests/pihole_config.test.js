'use strict';
const crypto = require('crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown } = require('./helpers/setup');
let cfg;
beforeEach(async () => { await setup(); cfg = require('../src/services/piholeConfig'); });
afterEach(teardown);

test('save encrypts app_password; load decrypts; redact hides it', () => {
  cfg.save({ enabled: true, sync_interval_sec: 30, manage_dns_chain: true,
    instances: [{ id:'p1', label:'DNS1', url:'http://10.8.0.5:8080', dns_ip:'10.8.0.5', app_password:'secret', verify_tls:true }] });
  const loaded = cfg.load();
  assert.equal(loaded.instances[0].app_password, 'secret', 'decrypted for internal use');
  const red = cfg.redact(loaded);
  assert.equal(red.instances[0].app_password, undefined);
  assert.equal(red.instances[0].password_set, true);
});

test('load returns defaults when unset', () => {
  const d = cfg.load();
  assert.equal(d.enabled, false);
  assert.deepEqual(d.instances, []);
});
