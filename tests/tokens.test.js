'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

// ─── Unit tests: scope checking (no DB needed) ─────────────

describe('Token Scope Logic', () => {
  let tokens;

  before(() => {
    // Minimal env to load the module
    process.env.GC_SECRET = process.env.GC_SECRET || 'test-secret';
    process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    process.env.GC_DB_PATH = process.env.GC_DB_PATH || '/tmp/gc-tokens-test-dummy.db';
    process.env.GC_BASE_URL = process.env.GC_BASE_URL || 'http://localhost:3000';
    process.env.GC_LOG_LEVEL = 'silent';
    tokens = require('../src/services/tokens');
  });

  describe('VALID_SCOPES', () => {
    it('should include client scope', () => {
      assert.ok(tokens.VALID_SCOPES.includes('client'));
    });

    it('should include all expected scopes', () => {
      const expected = ['read-only', 'full-access', 'peers', 'routes', 'settings', 'webhooks', 'logs', 'system', 'backup', 'client'];
      for (const scope of expected) {
        assert.ok(tokens.VALID_SCOPES.includes(scope), `Missing scope: ${scope}`);
      }
    });
  });

  describe('validateScopes', () => {
    it('should accept valid scopes', () => {
      assert.equal(tokens.validateScopes(['client']), null);
      assert.equal(tokens.validateScopes(['full-access']), null);
      assert.equal(tokens.validateScopes(['peers', 'routes']), null);
    });

    it('should reject empty array', () => {
      assert.ok(tokens.validateScopes([]) !== null);
    });

    it('should reject non-array', () => {
      assert.ok(tokens.validateScopes('peers') !== null);
      assert.ok(tokens.validateScopes(null) !== null);
    });

    it('should reject invalid scope names', () => {
      const err = tokens.validateScopes(['peers', 'invalid-scope']);
      assert.ok(err !== null);
      assert.ok(err.includes('invalid-scope'));
    });
  });

  describe('checkScope — full-access', () => {
    it('should allow GET on any endpoint', () => {
      assert.equal(tokens.checkScope(['full-access'], '/api/v1/peers', 'GET'), true);
      assert.equal(tokens.checkScope(['full-access'], '/api/v1/routes', 'GET'), true);
      assert.equal(tokens.checkScope(['full-access'], '/api/v1/client/ping', 'GET'), true);
    });

    it('should allow POST/PUT/DELETE on any endpoint', () => {
      assert.equal(tokens.checkScope(['full-access'], '/api/v1/peers', 'POST'), true);
      assert.equal(tokens.checkScope(['full-access'], '/api/v1/routes/1', 'PUT'), true);
      assert.equal(tokens.checkScope(['full-access'], '/api/v1/tokens/1', 'DELETE'), true);
    });

    it('should work as sole scope (no need to combine with others)', () => {
      assert.equal(tokens.checkScope(['full-access'], '/api/v1/settings', 'POST'), true);
      assert.equal(tokens.checkScope(['full-access'], '/api/v1/backup', 'POST'), true);
    });
  });

  describe('checkScope — read-only', () => {
    it('should allow GET on any endpoint', () => {
      assert.equal(tokens.checkScope(['read-only'], '/api/v1/peers', 'GET'), true);
      assert.equal(tokens.checkScope(['read-only'], '/api/v1/routes', 'GET'), true);
      assert.equal(tokens.checkScope(['read-only'], '/api/v1/dashboard', 'GET'), true);
      assert.equal(tokens.checkScope(['read-only'], '/api/v1/client/config', 'GET'), true);
    });

    it('should deny POST/PUT/DELETE', () => {
      assert.equal(tokens.checkScope(['read-only'], '/api/v1/peers', 'POST'), false);
      assert.equal(tokens.checkScope(['read-only'], '/api/v1/routes/1', 'PUT'), false);
      assert.equal(tokens.checkScope(['read-only'], '/api/v1/peers/1', 'DELETE'), false);
    });
  });

  describe('checkScope — client scope', () => {
    it('should allow GET on /api/v1/client/*', () => {
      assert.equal(tokens.checkScope(['client'], '/api/v1/client/ping', 'GET'), true);
      assert.equal(tokens.checkScope(['client'], '/api/v1/client/config', 'GET'), true);
      assert.equal(tokens.checkScope(['client'], '/api/v1/client/config/check', 'GET'), true);
    });

    it('should allow POST on /api/v1/client/*', () => {
      assert.equal(tokens.checkScope(['client'], '/api/v1/client/register', 'POST'), true);
      assert.equal(tokens.checkScope(['client'], '/api/v1/client/heartbeat', 'POST'), true);
      assert.equal(tokens.checkScope(['client'], '/api/v1/client/status', 'POST'), true);
    });

    it('should deny access to /api/v1/peers', () => {
      assert.equal(tokens.checkScope(['client'], '/api/v1/peers', 'GET'), false);
      assert.equal(tokens.checkScope(['client'], '/api/v1/peers', 'POST'), false);
    });

    it('should deny access to other resources', () => {
      assert.equal(tokens.checkScope(['client'], '/api/v1/routes', 'GET'), false);
      assert.equal(tokens.checkScope(['client'], '/api/v1/settings', 'GET'), false);
      assert.equal(tokens.checkScope(['client'], '/api/v1/system', 'GET'), false);
    });
  });

  describe('checkScope — resource scopes', () => {
    it('peers scope should access /api/v1/peers but not /api/v1/client', () => {
      assert.equal(tokens.checkScope(['peers'], '/api/v1/peers', 'GET'), true);
      assert.equal(tokens.checkScope(['peers'], '/api/v1/peers', 'POST'), true);
      assert.equal(tokens.checkScope(['peers'], '/api/v1/client/ping', 'GET'), false);
    });

    it('routes scope should access /api/v1/routes only', () => {
      assert.equal(tokens.checkScope(['routes'], '/api/v1/routes', 'GET'), true);
      assert.equal(tokens.checkScope(['routes'], '/api/v1/routes/1', 'PUT'), true);
      assert.equal(tokens.checkScope(['routes'], '/api/v1/peers', 'GET'), false);
    });

    it('system scope should cover /api/v1/system, /api/v1/wg, /api/v1/caddy', () => {
      assert.equal(tokens.checkScope(['system'], '/api/v1/system', 'GET'), true);
      assert.equal(tokens.checkScope(['system'], '/api/v1/wg', 'GET'), true);
      assert.equal(tokens.checkScope(['system'], '/api/v1/caddy', 'GET'), true);
    });

    it('settings scope should cover /api/v1/settings and /api/v1/smtp', () => {
      assert.equal(tokens.checkScope(['settings'], '/api/v1/settings', 'GET'), true);
      assert.equal(tokens.checkScope(['settings'], '/api/v1/smtp', 'POST'), true);
    });

    it('should support combining multiple scopes', () => {
      const scopes = ['peers', 'routes'];
      assert.equal(tokens.checkScope(scopes, '/api/v1/peers', 'POST'), true);
      assert.equal(tokens.checkScope(scopes, '/api/v1/routes', 'POST'), true);
      assert.equal(tokens.checkScope(scopes, '/api/v1/settings', 'GET'), false);
    });
  });

  describe('checkScope — edge cases', () => {
    it('should deny when scopes is not an array', () => {
      assert.equal(tokens.checkScope(null, '/api/v1/peers', 'GET'), false);
      assert.equal(tokens.checkScope(undefined, '/api/v1/peers', 'GET'), false);
      assert.equal(tokens.checkScope('peers', '/api/v1/peers', 'GET'), false);
    });

    it('should deny on unmapped paths', () => {
      assert.equal(tokens.checkScope(['peers'], '/api/v1/unknown', 'GET'), false);
    });

    it('dashboard requires read-only or full-access', () => {
      assert.equal(tokens.checkScope(['read-only'], '/api/v1/dashboard', 'GET'), true);
      assert.equal(tokens.checkScope(['full-access'], '/api/v1/dashboard', 'GET'), true);
      assert.equal(tokens.checkScope(['peers'], '/api/v1/dashboard', 'GET'), false);
    });
  });
});

// ─── Integration tests: token CRUD via API ──────────────────

describe('Token API Integration', () => {
  const { setup, teardown, getAgent, getCsrf } = require('./helpers/setup');

  before(async () => {
    await setup();
  });

  after(() => {
    teardown();
  });

  describe('POST /api/v1/tokens', () => {
    it('should create a token with client scope', async () => {
      const agent = getAgent();
      const csrf = getCsrf();
      const res = await agent
        .post('/api/v1/tokens')
        .set('x-csrf-token', csrf)
        .send({ name: 'Test Client Token', scopes: ['client'] })
        .expect(201);
      assert.equal(res.body.ok, true);
      assert.ok(res.body.token.startsWith('gc_'));
      assert.deepEqual(res.body.details.scopes, ['client']);
    });

    it('should create a token with full-access as sole scope', async () => {
      const agent = getAgent();
      const csrf = getCsrf();
      const res = await agent
        .post('/api/v1/tokens')
        .set('x-csrf-token', csrf)
        .send({ name: 'Full Access Token', scopes: ['full-access'] })
        .expect(201);
      assert.equal(res.body.ok, true);
      assert.deepEqual(res.body.details.scopes, ['full-access']);
    });

    it('should reject invalid scopes', async () => {
      const agent = getAgent();
      const csrf = getCsrf();
      const res = await agent
        .post('/api/v1/tokens')
        .set('x-csrf-token', csrf)
        .send({ name: 'Bad Token', scopes: ['nonexistent'] })
        .expect(400);
      assert.equal(res.body.ok, false);
    });

    it('should reject empty scopes', async () => {
      const agent = getAgent();
      const csrf = getCsrf();
      const res = await agent
        .post('/api/v1/tokens')
        .set('x-csrf-token', csrf)
        .send({ name: 'No Scopes', scopes: [] })
        .expect(400);
      assert.equal(res.body.ok, false);
    });

    it('should reject missing name', async () => {
      const agent = getAgent();
      const csrf = getCsrf();
      const res = await agent
        .post('/api/v1/tokens')
        .set('x-csrf-token', csrf)
        .send({ name: '', scopes: ['client'] })
        .expect(400);
      assert.equal(res.body.ok, false);
    });
  });

  describe('GET /api/v1/tokens', () => {
    it('should list created tokens', async () => {
      const agent = getAgent();
      const res = await agent.get('/api/v1/tokens').expect(200);
      assert.equal(res.body.ok, true);
      assert.ok(Array.isArray(res.body.tokens));
      assert.ok(res.body.tokens.length >= 2);
    });
  });

  describe('Token-based auth scope enforcement via API', () => {
    let clientToken;
    let fullToken;

    before(async () => {
      const agent = getAgent();
      const csrf = getCsrf();

      const res1 = await agent
        .post('/api/v1/tokens')
        .set('x-csrf-token', csrf)
        .send({ name: 'Scope Test Client', scopes: ['client'] })
        .expect(201);
      clientToken = res1.body.token;

      const res2 = await agent
        .post('/api/v1/tokens')
        .set('x-csrf-token', csrf)
        .send({ name: 'Scope Test Full', scopes: ['full-access'] })
        .expect(201);
      fullToken = res2.body.token;
    });

    it('client token should access /api/v1/client/ping via X-API-Key', async () => {
      // Use a fresh supertest instance (no cookies) to test pure token auth
      const supertest = require('supertest');
      const res = await supertest(getAgent().app)
        .get('/api/v1/client/ping')
        .set('X-API-Key', clientToken);
      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true);
    });

    it('client token should be denied on /api/v1/peers via X-API-Key', async () => {
      const supertest = require('supertest');
      const res = await supertest(getAgent().app)
        .get('/api/v1/peers')
        .set('X-API-Key', clientToken);
      assert.equal(res.status, 403);
    });

    it('full-access token should access /api/v1/peers via X-API-Key', async () => {
      const supertest = require('supertest');
      const res = await supertest(getAgent().app)
        .get('/api/v1/peers')
        .set('X-API-Key', fullToken);
      assert.equal(res.status, 200);
    });
  });

  describe('DELETE /api/v1/tokens/:id', () => {
    it('should revoke a token', async () => {
      const agent = getAgent();
      const csrf = getCsrf();

      // Create one to delete
      const createRes = await agent
        .post('/api/v1/tokens')
        .set('x-csrf-token', csrf)
        .send({ name: 'To Delete', scopes: ['logs'] })
        .expect(201);

      const id = createRes.body.details.id;
      await agent
        .delete(`/api/v1/tokens/${id}`)
        .set('x-csrf-token', csrf)
        .expect(200);
    });
  });
});
