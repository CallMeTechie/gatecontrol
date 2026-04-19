'use strict';

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');

process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

describe('gatewayAuth middleware', () => {
  let auth, gateways, peerId, apiToken;

  before(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-gwa-'));
    process.env.GC_DB_PATH = path.join(tmp, 'test.db');
    process.env.GC_DATA_DIR = tmp;
    ['../config/default', '../src/db/connection', '../src/db/migrations', '../src/services/gateways', '../src/services/license', '../src/middleware/gatewayAuth']
      .forEach(p => { try { delete require.cache[require.resolve(p)]; } catch (_) {} });
    require('../src/db/migrations').runMigrations();
    gateways = require('../src/services/gateways');
    auth = require('../src/middleware/gatewayAuth');

    const license = require('../src/services/license');
    license._overrideForTest && license._overrideForTest({ gateway_peers: 10 });

    const gw = await gateways.createGateway({ name: 'auth-gw', apiPort: 9876 });
    peerId = gw.peer.id;
    apiToken = gw.apiToken;
  });

  function mockReqRes(authHeader) {
    const req = { headers: { authorization: authHeader }, gateway: null, ip: '127.0.0.1' };
    let statusCode = null, body = null, nextCalled = false;
    const res = {
      status(c) { statusCode = c; return this; },
      json(b) { body = b; return this; },
    };
    const next = () => { nextCalled = true; };
    return { req, res, next, getStatus: () => statusCode, getBody: () => body, wasNextCalled: () => nextCalled };
  }

  it('accepts valid Bearer token and attaches req.gateway', () => {
    const m = mockReqRes(`Bearer ${apiToken}`);
    auth.requireGateway(m.req, m.res, m.next);
    assert.equal(m.wasNextCalled(), true);
    assert.equal(m.req.gateway.peer_id, peerId);
  });

  it('rejects missing Authorization header with 401', () => {
    const m = mockReqRes(undefined);
    auth.requireGateway(m.req, m.res, m.next);
    assert.equal(m.getStatus(), 401);
    assert.equal(m.wasNextCalled(), false);
  });

  it('rejects invalid token with 403', () => {
    const m = mockReqRes('Bearer gc_gw_0000000000000000000000000000000000000000000000000000000000000000');
    auth.requireGateway(m.req, m.res, m.next);
    assert.equal(m.getStatus(), 403);
  });

  it('rejects wrong-format token with 401', () => {
    const m = mockReqRes('NotBearer xyz');
    auth.requireGateway(m.req, m.res, m.next);
    assert.equal(m.getStatus(), 401);
  });
});
