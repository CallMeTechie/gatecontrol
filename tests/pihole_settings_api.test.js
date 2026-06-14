'use strict';
const crypto = require('crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
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

test('dns_port round-trips through PUT then GET', async () => {
  const put = await agent.put('/api/v1/settings/pihole').set('X-CSRF-Token', csrf).send({
    enabled: true, sync_interval_sec: 30, manage_dns_chain: true,
    instances: [{ id: 'p2', label: 'DNS2', url: 'http://10.8.0.5:8080', dns_ip: '10.8.0.5', dns_port: 5335, app_password: 'secret', verify_tls: true }],
  });
  assert.equal(put.status, 200);
  const get = await agent.get('/api/v1/settings/pihole');
  assert.equal(get.status, 200);
  assert.equal(get.body.data.instances[0].dns_port, 5335);
});

test('PUT rejects non-array instances', async () => {
  const res = await agent.put('/api/v1/settings/pihole').set('X-CSRF-Token', csrf).send({ enabled:true, instances:'nope' });
  assert.equal(res.status, 400);
});

test('unlicensed pihole does NOT block other settings routes', async () => {
  license._overrideForTest({ pihole_integration: false });
  const res = await agent.get('/api/v1/settings/dns');
  assert.notEqual(res.status, 403);
});

test('POST /settings/pihole/test/:id uses the STORED password', async () => {
  license._overrideForTest({ pihole_integration: true });
  // mock pihole
  let gotPassword = null;
  const server = http.createServer((req, res) => {
    if (req.url === '/api/auth' && req.method === 'DELETE') { res.statusCode = 204; res.end(); return; }
    if (req.url === '/api/auth') { let b=''; req.on('data',c=>b+=c); req.on('end',()=>{ gotPassword = JSON.parse(b||'{}').password; res.end(JSON.stringify({ session:{ sid:'S', valid:true, validity:300 } })); }); return; }
    if (req.url.startsWith('/api/info/version')) { res.end(JSON.stringify({ version:{ core:{ local:{ version:'v6.4.2' } } } })); return; }
    res.statusCode=404; res.end('{}');
  });
  await new Promise(r => server.listen(0, r));
  const url = 'http://127.0.0.1:' + server.address().port;
  try {
    await agent.put('/api/v1/settings/pihole').set('X-CSRF-Token', csrf).send({
      enabled:true, instances:[{ id:'x1', label:'L', url, dns_ip:'10.0.0.1', app_password:'storedpw', verify_tls:true }] });
    const res = await agent.post('/api/v1/settings/pihole/test/x1').set('X-CSRF-Token', csrf).send({});
    assert.equal(res.status, 200);
    assert.equal(res.body.data.connected, true);
    assert.equal(gotPassword, 'storedpw', 'must authenticate with the STORED password');
    const nf = await agent.post('/api/v1/settings/pihole/test/nope').set('X-CSRF-Token', csrf).send({});
    assert.equal(nf.status, 404);
  } finally { await new Promise(r => server.close(r)); }
});
