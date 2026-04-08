'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown } = require('./helpers/setup');

let agent, csrf;

before(async () => {
  const ctx = await setup();
  agent = ctx.agent;
  csrf = ctx.csrfToken;
});

after(() => teardown());

describe('RDP API', () => {
  let rdpRouteId;

  it('GET /api/v1/rdp returns empty list initially', async () => {
    const res = await agent.get('/api/v1/rdp').expect(200);
    assert.equal(res.body.ok, true);
    assert.ok(Array.isArray(res.body.routes));
    assert.equal(res.body.routes.length, 0);
  });

  it('POST /api/v1/rdp creates RDP route', async () => {
    const res = await agent
      .post('/api/v1/rdp')
      .set('X-CSRF-Token', csrf)
      .send({
        name: 'Test-Server',
        host: '192.168.1.50',
        port: 3389,
        access_mode: 'internal',
        credential_mode: 'none',
      })
      .expect(201);
    assert.equal(res.body.ok, true);
    assert.ok(res.body.route.id);
    assert.equal(res.body.route.name, 'Test-Server');
    assert.equal(res.body.route.port, 3389);
    rdpRouteId = res.body.route.id;
  });

  it('POST /api/v1/rdp validates required fields', async () => {
    const res = await agent
      .post('/api/v1/rdp')
      .set('X-CSRF-Token', csrf)
      .send({ port: 3389 })
      .expect(400);
    assert.equal(res.body.ok, false);
    assert.ok(res.body.fields);
  });

  it('POST /api/v1/rdp validates port range', async () => {
    const res = await agent
      .post('/api/v1/rdp')
      .set('X-CSRF-Token', csrf)
      .send({ name: 'Bad Port', host: '10.0.0.1', port: 99999 })
      .expect(400);
    assert.equal(res.body.ok, false);
  });

  it('POST /api/v1/rdp validates MAC address format', async () => {
    const res = await agent
      .post('/api/v1/rdp')
      .set('X-CSRF-Token', csrf)
      .send({ name: 'Bad MAC', host: '10.0.0.1', port: 3389, wol_mac_address: 'invalid' })
      .expect(400);
    assert.equal(res.body.ok, false);
  });

  it('GET /api/v1/rdp/:id returns route', async () => {
    const res = await agent.get(`/api/v1/rdp/${rdpRouteId}`).expect(200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.route.name, 'Test-Server');
  });

  it('GET /api/v1/rdp/:id returns 404 for missing', async () => {
    const res = await agent.get('/api/v1/rdp/99999').expect(404);
    assert.equal(res.body.ok, false);
  });

  it('PATCH /api/v1/rdp/:id updates route', async () => {
    const res = await agent
      .patch(`/api/v1/rdp/${rdpRouteId}`)
      .set('X-CSRF-Token', csrf)
      .send({ name: 'Updated-Server', port: 3392 })
      .expect(200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.route.name, 'Updated-Server');
    assert.equal(res.body.route.port, 3392);
  });

  it('PUT /api/v1/rdp/:id/toggle toggles enabled', async () => {
    const res = await agent
      .put(`/api/v1/rdp/${rdpRouteId}/toggle`)
      .set('X-CSRF-Token', csrf)
      .expect(200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.route.enabled, false);
  });

  it('GET /api/v1/rdp/status returns bulk status', async () => {
    const res = await agent.get('/api/v1/rdp/status').expect(200);
    assert.equal(res.body.ok, true);
  });

  it('GET /api/v1/rdp/history returns empty history', async () => {
    const res = await agent.get('/api/v1/rdp/history').expect(200);
    assert.equal(res.body.ok, true);
    assert.ok(Array.isArray(res.body.history));
  });

  it('GET /api/v1/rdp/pubkey returns server public key', async () => {
    const res = await agent.get('/api/v1/rdp/pubkey').expect(200);
    assert.equal(res.body.ok, true);
    assert.ok(res.body.publicKey.includes('BEGIN PUBLIC KEY'));
  });

  it('DELETE /api/v1/rdp/:id deletes route', async () => {
    await agent
      .delete(`/api/v1/rdp/${rdpRouteId}`)
      .set('X-CSRF-Token', csrf)
      .expect(200);
    await agent.get(`/api/v1/rdp/${rdpRouteId}`).expect(404);
  });
});
