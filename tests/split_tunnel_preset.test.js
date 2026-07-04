'use strict';

// Verifies the "Split-Tunneling Voreinstellung" (split-tunnel preset) feature
// actually works end-to-end on the server, not just that validation rejects.
//
// The pre-existing tests (api_settings.test.js) only assert 4xx rejections and
// accept [400, 403] because the shared test license does NOT grant
// `split_tunnel_preset` — so the happy path (feature licensed → save persists →
// served to clients) was never exercised. This suite licenses the feature and
// drives the full chain:
//   admin PUT  /api/v1/settings/split-tunnel   → persist
//   admin GET  /api/v1/settings/split-tunnel   → read back
//   client GET /api/v1/client/split-tunnel     → effective preset delivered to VPN clients
// plus the three resolution branches the client endpoint implements
// (token override > global preset > off) and the license gate.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const { setup, teardown } = require('./helpers/setup');

let app, agent, csrf, license, tokens;

// A valid preset: exclude mode, the two private-network presets the UI ships,
// locked so overrides are forbidden.
const PRESET = {
  mode: 'exclude',
  networks: [
    { cidr: '172.16.0.0/12', label: 'Private 172.x' },
    { cidr: '192.168.0.0/16', label: 'Private 192.x' },
  ],
  locked: true,
};

function cidrs(networks) {
  return (networks || []).map(n => n.cidr).sort();
}

before(async () => {
  const ctx = await setup();
  app = ctx.app;
  agent = ctx.agent;
  csrf = ctx.csrfToken;
  license = require('../src/services/license');
  tokens = require('../src/services/tokens');
  // The base setup override omits both of these — grant them here.
  license._overrideForTest({ split_tunnel_preset: true, api_tokens: true });
});

after(() => teardown());

describe('split-tunnel preset — save persists and is served to clients', () => {
  it('PUT /settings/split-tunnel accepts a valid preset when licensed', async () => {
    const res = await agent
      .put('/api/v1/settings/split-tunnel')
      .set('X-CSRF-Token', csrf)
      .send(PRESET)
      .expect(200);
    assert.equal(res.body.ok, true);
  });

  it('GET /settings/split-tunnel reads back exactly what was saved', async () => {
    const res = await agent.get('/api/v1/settings/split-tunnel').expect(200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.mode, 'exclude');
    assert.equal(res.body.locked, true);
    assert.deepEqual(cidrs(res.body.networks), ['172.16.0.0/12', '192.168.0.0/16']);
  });

  it('GET /client/split-tunnel serves the saved preset to VPN clients (source=global)', async () => {
    // Session-authed agent → no token → global preset branch.
    const res = await agent.get('/api/v1/client/split-tunnel').expect(200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.mode, 'exclude');
    assert.equal(res.body.locked, true);
    assert.equal(res.body.source, 'global');
    assert.deepEqual(cidrs(res.body.networks), ['172.16.0.0/12', '192.168.0.0/16']);
  });

  it('mode=off round-trips to a disabled client preset (source=none)', async () => {
    await agent
      .put('/api/v1/settings/split-tunnel')
      .set('X-CSRF-Token', csrf)
      .send({ mode: 'off', networks: [], locked: false })
      .expect(200);

    const res = await agent.get('/api/v1/client/split-tunnel').expect(200);
    assert.equal(res.body.mode, 'off');
    assert.deepEqual(res.body.networks, []);
    assert.equal(res.body.locked, false);
    assert.equal(res.body.source, 'none');
  });

  it('a token-specific override wins over the global preset (source=token)', async () => {
    // Global is currently 'off' (previous test). The override must still surface.
    const override = { mode: 'include', networks: [{ cidr: '10.9.0.0/24', label: 'Lab' }], locked: false };
    const { rawToken } = tokens.create(
      { name: 'st-override', scopes: ['full-access'], splitTunnelOverride: JSON.stringify(override) },
      '127.0.0.1',
    );

    // Fresh request WITHOUT the admin session cookie — requireAuth checks the
    // session first and would otherwise never enter the token branch.
    const res = await supertest(app)
      .get('/api/v1/client/split-tunnel')
      .set('X-Api-Token', rawToken)
      .expect(200);

    assert.equal(res.body.source, 'token');
    assert.equal(res.body.mode, 'include');
    assert.deepEqual(cidrs(res.body.networks), ['10.9.0.0/24']);
  });

  it('PUT /settings/split-tunnel is refused when the feature is unlicensed (403)', async () => {
    license._overrideForTest({ split_tunnel_preset: false });
    try {
      const res = await agent
        .put('/api/v1/settings/split-tunnel')
        .set('X-CSRF-Token', csrf)
        .send(PRESET)
        .expect(403);
      assert.equal(res.body.ok, false);
    } finally {
      license._overrideForTest({ split_tunnel_preset: true });
    }
  });
});
