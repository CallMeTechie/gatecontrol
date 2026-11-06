'use strict';

// "Nur docker-compose.yml herunterladen" on the gateway page:
// POST /api/v1/gateways/:id/compose → the assistant's compose for the
// gateway's platform/network, without gateway.env and without rotating the
// gateway's tokens (the running gateway keeps its connection).

const crypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const { setup, teardown, getCsrf } = require('./helpers/setup');
const kit = require('../public/js/gateway-kit');

let ctx, agent, csrf, db, license;
const post = (url, body) => agent.post(url).set('X-CSRF-Token', csrf).send(body || {});
const hashes = (id) => db.prepare('SELECT api_token_hash, push_token_encrypted FROM gateway_meta WHERE peer_id = ?').get(id);

async function gateway(name, platform) {
  const body = { name, is_gateway: true };
  if (platform) body.platform = platform;
  return (await post('/api/v1/peers', body).expect(201)).body.peer.id;
}

before(async () => {
  ctx = await setup();
  agent = ctx.agent;
  csrf = getCsrf();
  db = require('../src/db/connection').getDb();
  license = require('../src/services/license');
  license._overrideForTest({ gateway_peers: 20, http_routes: -1, gateway_http_targets: -1 });
});
after(() => teardown());

describe('POST /api/v1/gateways/:id/compose', () => {
  it('Synology gateway → its compose as a file, tokens untouched, no gateway.env', async () => {
    const id = await gateway('NAS Flur', 'synology');
    const before = hashes(id);
    const r = await post(`/api/v1/gateways/${id}/compose`).expect(200);
    assert.match(r.headers['content-type'], /^application\/yaml; charset=utf-8/);
    assert.match(r.headers['content-disposition'], /attachment; filename="docker-compose\.yml"/);
    assert.match(r.headers['cache-control'], /no-store/);
    assert.equal(r.text, kit.buildCompose({ platform: 'synology', network: 'host' }));
    assert.doesNotMatch(r.text, /GC_API_TOKEN|GC_PUSH_TOKEN|PrivateKey/);
    assert.deepEqual(hashes(id), before, 'tokens must not be rotated');
  });

  it('platform from the assistant: linux and proxmox → linux profile; body overrides; bridge', async () => {
    const lin = await gateway('Linux Keller', 'linux');
    assert.equal((await post(`/api/v1/gateways/${lin}/compose`).expect(200)).text, kit.buildCompose({ platform: 'linux', network: 'host' }));
    const pve = await gateway('PVE', 'proxmox');
    assert.equal((await post(`/api/v1/gateways/${pve}/compose`).expect(200)).text, kit.buildCompose({ platform: 'linux', network: 'host' }));
    assert.equal((await post(`/api/v1/gateways/${lin}/compose`, { platform: 'synology' }).expect(200)).text,
      kit.buildCompose({ platform: 'synology', network: 'host' }));
    assert.equal((await post(`/api/v1/gateways/${lin}/compose`, { network: 'bridge' }).expect(200)).text,
      kit.buildCompose({ platform: 'linux', network: 'bridge' }));
  });

  it('unknown platform (older gateway) or Pi image → must choose (400 platform_required)', async () => {
    const old = await gateway('gw-alt');
    let r = await post(`/api/v1/gateways/${old}/compose`).expect(400);
    assert.equal(r.body.error, 'platform_required');
    const pi = await gateway('Pi', 'rpi');
    r = await post(`/api/v1/gateways/${pi}/compose`).expect(400);
    assert.equal(r.body.error, 'platform_required');
    assert.equal((await post(`/api/v1/gateways/${old}/compose`, { platform: 'linux', network: 'host' }).expect(200)).text,
      kit.buildCompose({ platform: 'linux', network: 'host' }));
  });

  it('only the listed profiles (400 invalid_option), nothing echoed', async () => {
    const id = await gateway('NAS 2', 'synology');
    for (const body of [{ platform: 'rpi' }, { platform: 'windows' }, { network: 'macvlan' }, { platform: ['synology'] },
      { network: { x: 1 } }, { platform: 'synology\n- evil' }]) {
      const r = await post(`/api/v1/gateways/${id}/compose`, body).expect(400);
      assert.equal(r.body.error, 'invalid_option', JSON.stringify(body));
    }
  });

  it('without CSRF → 403; unknown gateway → 404; plain peer → 404', async () => {
    const id = await gateway('NAS 3', 'synology');
    await agent.post(`/api/v1/gateways/${id}/compose`).send({}).expect(403);
    await post('/api/v1/gateways/999999/compose').expect(404);
    const peer = (await post('/api/v1/peers', { name: 'laptop' }).expect(201)).body.peer.id;
    await post(`/api/v1/gateways/${peer}/compose`).expect(404);
  });

  it('API token → 403 session_required (session only, like the NAS package)', async () => {
    const id = await gateway('NAS 4', 'synology');
    const { rawToken } = require('../src/services/tokens').create({ name: 'compose-tok', scopes: ['full-access'] }, '127.0.0.1');
    const r = await supertest(ctx.app).post(`/api/v1/gateways/${id}/compose`).set('X-Api-Token', rawToken).send({});
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'session_required');
  });
});
