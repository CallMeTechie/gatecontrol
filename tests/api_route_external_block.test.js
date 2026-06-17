'use strict';
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown, getAgent, getCsrf } = require('./helpers/setup');

let agent, csrf;
beforeEach(async () => { await setup(); agent = getAgent(); csrf = getCsrf(); });
afterEach(teardown);

const MINIMAL = { domain: 'block-api.example.com', target_ip: '93.184.216.34', target_port: 80 };

test('custom action without body → 400', async () => {
  const res = await agent.post('/api/v1/routes').set('X-CSRF-Token', csrf)
    .send({ ...MINIMAL, external_block_action: 'custom' });
  assert.equal(res.status, 400, JSON.stringify(res.body));
});

test('redirect to the route host itself → 400 (loop guard, case-insensitive)', async () => {
  const res = await agent.post('/api/v1/routes').set('X-CSRF-Token', csrf)
    .send({ ...MINIMAL, domain: 'Loop.Example.com', external_block_action: 'redirect',
            external_block_redirect_url: 'https://loop.example.com/x' });
  assert.equal(res.status, 400, JSON.stringify(res.body));
});

test('custom body over 16 KB → 400', async () => {
  const big = '<p>' + 'a'.repeat(16400) + '</p>';
  const res = await agent.post('/api/v1/routes').set('X-CSRF-Token', csrf)
    .send({ ...MINIMAL, domain: 'big.example.com', external_block_action: 'custom', external_block_body: big });
  assert.equal(res.status, 400, JSON.stringify(res.body));
});

test('valid not_found → 201 and persisted', async () => {
  const res = await agent.post('/api/v1/routes').set('X-CSRF-Token', csrf)
    .send({ ...MINIMAL, domain: 'ok.example.com', external_block_action: 'not_found' });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const id = res.body.route.id;
  const get = await agent.get(`/api/v1/routes/${id}`);
  assert.equal(get.body.route.external_block_action, 'not_found');
});

test('PUT custom WITHOUT resending body keeps persisted body → 200 (no false 400)', async () => {
  const c = await agent.post('/api/v1/routes').set('X-CSRF-Token', csrf)
    .send({ ...MINIMAL, domain: 'keep.example.com', external_block_action: 'custom', external_block_body: '<h1>x</h1>' });
  const id = c.body.route.id;
  const put = await agent.put(`/api/v1/routes/${id}`).set('X-CSRF-Token', csrf)
    .send({ external_block_action: 'custom' }); // body NOT resent
  assert.equal(put.status, 200, JSON.stringify(put.body));
});

// ── Task 6: GET/PUT /api/settings/route-block-default ──────────────────────

test('GET/PUT /api/v1/settings/route-block-default roundtrip', async () => {
  const put = await agent.put('/api/v1/settings/route-block-default').set('X-CSRF-Token', csrf)
    .send({ action: 'redirect', redirect_url: 'https://elsewhere.example.org/x' });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  const get = await agent.get('/api/v1/settings/route-block-default');
  assert.equal(get.body.data.action, 'redirect');
  assert.equal(get.body.data.redirect_url, 'https://elsewhere.example.org/x');
});

test('PUT route-block-default custom without body → 400', async () => {
  const res = await agent.put('/api/v1/settings/route-block-default').set('X-CSRF-Token', csrf)
    .send({ action: 'custom' });
  assert.equal(res.status, 400, JSON.stringify(res.body));
});

test('PUT route-block-default invalid redirect_url → 400', async () => {
  const res = await agent.put('/api/v1/settings/route-block-default').set('X-CSRF-Token', csrf)
    .send({ action: 'redirect', redirect_url: 'not-a-url' });
  assert.equal(res.status, 400, JSON.stringify(res.body));
});
