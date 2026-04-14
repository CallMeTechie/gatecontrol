'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { setup, teardown, getAgent, getCsrf } = require('./helpers/setup');

let agent, csrf;
let hasWg = false;
try { execFileSync('wg', ['--version']); hasWg = true; } catch {}

before(async () => {
  const ctx = await setup();
  agent = ctx.agent;
  csrf = ctx.csrfToken;
});

after(() => teardown());

// ─── Auth ───────────────────────────────────────────
describe('Auth', () => {
  it('returns 401 for unauthenticated API requests', async () => {
    const supertest = require('supertest');
    const { createApp } = require('../src/app');
    const freshAgent = supertest(createApp());
    await freshAgent.get('/api/v1/peers').expect(401);
  });

  it('returns dashboard for authenticated user', async () => {
    await agent.get('/dashboard').expect(200);
  });
});

// ─── Peers API ──────────────────────────────────────
describe('Peers API', () => {
  it('GET /api/v1/peers returns list', async () => {
    const res = await agent.get('/api/v1/peers').expect(200);
    assert.equal(res.body.ok, true);
    assert.ok(Array.isArray(res.body.peers));
  });

  it('POST /api/v1/peers validates name', async () => {
    const res = await agent
      .post('/api/v1/peers')
      .set('X-CSRF-Token', csrf)
      .send({ name: '' })
      .expect(400);
    assert.equal(res.body.ok, false);
    assert.ok(res.body.fields);
    assert.ok(res.body.fields.name);
  });

  // Peer CRUD requires WireGuard tools (wg genkey/pubkey)
  it('POST /api/v1/peers creates a peer (requires wg)', { skip: !hasWg }, async () => {
    const res = await agent
      .post('/api/v1/peers')
      .set('X-CSRF-Token', csrf)
      .send({ name: 'test-peer', description: 'Test peer' })
      .expect(201);
    assert.equal(res.body.ok, true);
  });
});

// ─── Routes API ─────────────────────────────────────
describe('Routes API', () => {
  it('GET /api/v1/routes returns list', async () => {
    const res = await agent.get('/api/v1/routes').expect(200);
    assert.equal(res.body.ok, true);
    assert.ok(Array.isArray(res.body.routes));
  });

  it('POST /api/v1/routes validates fields', async () => {
    const res = await agent
      .post('/api/v1/routes')
      .set('X-CSRF-Token', csrf)
      .send({ domain: 'invalid', target_port: 99999 })
      .expect(400);
    assert.equal(res.body.ok, false);
    assert.ok(res.body.fields);
  });

  it('POST /api/v1/routes validates empty domain', async () => {
    const res = await agent
      .post('/api/v1/routes')
      .set('X-CSRF-Token', csrf)
      .send({ domain: '', target_port: 8080 })
      .expect(400);
    assert.equal(res.body.ok, false);
    assert.ok(res.body.fields.domain);
  });

  // Route CRUD requires Caddy (syncToCaddy fails without it)
  it('POST /api/v1/routes creates a route (requires Caddy)', { skip: !hasWg }, async () => {
    const res = await agent
      .post('/api/v1/routes')
      .set('X-CSRF-Token', csrf)
      .send({ domain: 'test.example.com', target_port: 8080 })
      .expect(201);
    assert.equal(res.body.ok, true);
  });
});

// ─── Dashboard API ──────────────────────────────────
describe('Dashboard API', () => {
  it('GET /api/v1/dashboard/stats returns stats', async () => {
    const res = await agent.get('/api/v1/dashboard/stats').expect(200);
    assert.equal(res.body.ok, true);
    assert.ok(res.body.peers !== undefined);
    assert.ok(res.body.routes !== undefined);
    assert.ok(res.body.monitoring !== undefined);
  });

  it('GET /api/v1/dashboard/traffic returns chart data', async () => {
    const res = await agent.get('/api/v1/dashboard/traffic?period=1h').expect(200);
    assert.equal(res.body.ok, true);
    assert.ok(Array.isArray(res.body.data));
  });
});

// ─── Settings API ───────────────────────────────────
describe('Settings API', () => {
  it('GET /api/v1/settings/profile returns profile', async () => {
    const res = await agent.get('/api/v1/settings/profile').expect(200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.profile.username, 'admin');
  });

  it('GET /api/v1/settings/security returns security settings', async () => {
    const res = await agent.get('/api/v1/settings/security').expect(200);
    assert.equal(res.body.ok, true);
    assert.ok(res.body.data.lockout !== undefined);
    assert.ok(res.body.data.password !== undefined);
  });

  it('PUT /api/v1/settings/security updates settings', async () => {
    const res = await agent
      .put('/api/v1/settings/security')
      .set('X-CSRF-Token', csrf)
      .send({ lockout: { max_attempts: 10 } })
      .expect(200);
    assert.equal(res.body.ok, true);
  });

  it('GET /api/v1/settings/data returns data settings', async () => {
    const res = await agent.get('/api/v1/settings/data').expect(200);
    assert.equal(res.body.ok, true);
    assert.ok(res.body.data.retention_traffic_days !== undefined);
  });

  it('GET /api/v1/settings/monitoring returns monitoring settings', async () => {
    const res = await agent.get('/api/v1/settings/monitoring').expect(200);
    assert.equal(res.body.ok, true);
  });

  it('GET /api/v1/settings/alerts returns alert settings', async () => {
    const res = await agent.get('/api/v1/settings/alerts').expect(200);
    assert.equal(res.body.ok, true);
  });

  it('GET /api/v1/settings/lockout returns locked accounts', async () => {
    const res = await agent.get('/api/v1/settings/lockout').expect(200);
    assert.equal(res.body.ok, true);
    assert.ok(Array.isArray(res.body.locked));
  });

  it('GET /api/v1/settings/ip2location returns api key status', async () => {
    const res = await agent.get('/api/v1/settings/ip2location').expect(200);
    assert.equal(res.body.ok, true);
  });
});

// ─── Profile Theme API ─────────────────────────────
describe('Profile Theme API', () => {
  it('PUT /api/v1/settings/profile accepts theme field', async () => {
    const res = await agent
      .put('/api/v1/settings/profile')
      .set('X-CSRF-Token', csrf)
      .send({ theme: 'pro' })
      .expect(200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.profile.theme, 'pro');
  });

  it('GET /api/v1/settings/profile returns updated theme', async () => {
    const res = await agent.get('/api/v1/settings/profile').expect(200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.profile.theme, 'pro');
  });

  it('PUT /api/v1/settings/profile switches back to default', async () => {
    const res = await agent
      .put('/api/v1/settings/profile')
      .set('X-CSRF-Token', csrf)
      .send({ theme: 'default' })
      .expect(200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.profile.theme, 'default');
  });

  it('PUT /api/v1/settings/profile rejects invalid theme', async () => {
    const res = await agent
      .put('/api/v1/settings/profile')
      .set('X-CSRF-Token', csrf)
      .send({ theme: 'nonexistent' })
      .expect(400);
    assert.equal(res.body.ok, false);
  });

  it('PUT /api/v1/settings/profile with theme does not affect other fields', async () => {
    const res = await agent
      .put('/api/v1/settings/profile')
      .set('X-CSRF-Token', csrf)
      .send({ theme: 'pro', display_name: 'Theme Test' })
      .expect(200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.profile.theme, 'pro');
    assert.equal(res.body.profile.display_name, 'Theme Test');

    // Reset
    await agent
      .put('/api/v1/settings/profile')
      .set('X-CSRF-Token', csrf)
      .send({ theme: 'default', display_name: 'admin' });
  });
});

// ─── Webhooks API ───────────────────────────────────
describe('Webhooks API', () => {
  let webhookId;

  it('POST /api/v1/webhooks creates webhook', async () => {
    const res = await agent
      .post('/api/v1/webhooks')
      .set('X-CSRF-Token', csrf)
      .send({ url: 'https://example.com/hook', description: 'Test' })
      .expect(201);
    assert.equal(res.body.ok, true);
    webhookId = res.body.webhook.id;
  });

  it('GET /api/v1/webhooks returns webhooks', async () => {
    const res = await agent.get('/api/v1/webhooks').expect(200);
    assert.equal(res.body.ok, true);
    assert.ok(res.body.webhooks.length >= 1);
  });

  it('PUT /api/v1/webhooks/:id/toggle toggles webhook', async () => {
    const res = await agent
      .put('/api/v1/webhooks/' + webhookId + '/toggle')
      .set('X-CSRF-Token', csrf)
      .expect(200);
    assert.equal(res.body.ok, true);
  });

  it('DELETE /api/v1/webhooks/:id deletes webhook', async () => {
    const res = await agent
      .delete('/api/v1/webhooks/' + webhookId)
      .set('X-CSRF-Token', csrf)
      .expect(200);
    assert.equal(res.body.ok, true);
  });
});

// ─── Logs API ───────────────────────────────────────
describe('Logs API', () => {
  it('GET /api/v1/logs/activity returns logs', async () => {
    const res = await agent.get('/api/v1/logs/activity').expect(200);
    assert.ok(res.body.entries !== undefined);
    assert.ok(res.body.total !== undefined);
  });

  it('GET /api/v1/logs/recent returns recent logs', async () => {
    const res = await agent.get('/api/v1/logs/recent?limit=5').expect(200);
    assert.ok(Array.isArray(res.body.entries));
  });
});

// ─── System API ─────────────────────────────────────
describe('System API', () => {
  it('GET /api/v1/system/resources returns system info', async () => {
    const res = await agent.get('/api/v1/system/resources').expect(200);
    assert.equal(res.body.ok, true);
  });
});

// ─── Health Endpoint ────────────────────────────────
describe('Health', () => {
  it('GET /health returns status', async () => {
    const res = await agent.get('/health');
    // May be 200 or 503 depending on WireGuard availability
    assert.ok([200, 503].includes(res.status));
    assert.equal(res.body.db, true);
  });
});

// ─── Backup API ─────────────────────────────────────
describe('Backup API', () => {
  it('GET /api/v1/settings/backup downloads backup', async () => {
    const res = await agent.get('/api/v1/settings/backup').expect(200);
    assert.ok(res.headers['content-disposition']);
  });
});

// ─── Pro Theme Rendering ─────────────────────────────
describe('Pro Theme Rendering', () => {
  before(async () => {
    await agent
      .put('/api/v1/settings/profile')
      .set('X-CSRF-Token', csrf)
      .send({ theme: 'pro' })
      .expect(200);
  });

  after(async () => {
    await agent
      .put('/api/v1/settings/profile')
      .set('X-CSRF-Token', csrf)
      .send({ theme: 'default' })
      .expect(200);
  });

  const pages = [
    'dashboard',
    'peers',
    'routes',
    'rdp',
    'users',
    'logs',
    'settings',
    'certificates',
    'profile',
  ];

  for (const page of pages) {
    it(`GET /${page} renders with pro.css`, async () => {
      const res = await agent.get(`/${page}`).expect(200);
      assert.ok(
        res.text.includes('pro.css'),
        `Expected pro.css in /${page} response`
      );
    });
  }
});
