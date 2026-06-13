'use strict';
const crypto = require('crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown, getAgent, getCsrf } = require('./helpers/setup');
const license = require('../src/services/license');
let agent, csrf;
beforeEach(async () => { await setup(); agent = getAgent(); csrf = getCsrf(); license._overrideForTest({ pihole_integration: true }); });
afterEach(teardown);

test('PUT then GET hides the password but reports password_set', async () => {
  const put = await agent.put('/api/v1/settings/pihole').set('X-CSRF-Token', csrf).send({
    enabled: true, sync_interval_sec: 30, manage_dns_chain: true,
    instances: [{ id:'p1', label:'DNS1', url:'http://10.8.0.5:8080', dns_ip:'10.8.0.5', app_password:'secret', verify_tls:true }],
  });
  assert.equal(put.status, 200);
  const get = await agent.get('/api/v1/settings/pihole');
  assert.equal(get.body.data.instances[0].password_set, true);
  assert.equal(get.body.data.instances[0].app_password, undefined);
});

test('PUT with password_set and no new secret preserves the stored password', async () => {
  await agent.put('/api/v1/settings/pihole').set('X-CSRF-Token', csrf).send({
    enabled:true, instances:[{ id:'p1', label:'DNS1', url:'http://10.8.0.5:8080', dns_ip:'10.8.0.5', app_password:'secret', verify_tls:true }] });
  await agent.put('/api/v1/settings/pihole').set('X-CSRF-Token', csrf).send({
    enabled:true, instances:[{ id:'p1', label:'DNS1 renamed', url:'http://10.8.0.5:8080', dns_ip:'10.8.0.5', password_set:true, verify_tls:true }] });
  const cfg = require('../src/services/piholeConfig').load();
  assert.equal(cfg.instances[0].app_password, 'secret', 'password preserved');
  assert.equal(cfg.instances[0].label, 'DNS1 renamed');
});

test('PUT rejects non-array instances', async () => {
  const res = await agent.put('/api/v1/settings/pihole').set('X-CSRF-Token', csrf).send({ enabled:true, instances:'nope' });
  assert.equal(res.status, 400);
});
