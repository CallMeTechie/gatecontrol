'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { requireAuth, guestOnly } = require('../src/middleware/auth');

function mockReq(overrides = {}) {
  const req = {
    session: {},
    path: '/api/test',
    baseUrl: '',
    ...overrides,
  };
  // Ensure originalUrl is set for auth middleware
  if (!req.originalUrl) req.originalUrl = (req.baseUrl || '') + req.path;
  return req;
}

function mockRes() {
  const res = {
    statusCode: 200,
    redirectUrl: null,
    jsonData: null,
    status(code) { res.statusCode = code; return res; },
    json(data) { res.jsonData = data; return res; },
    redirect(url) { res.redirectUrl = url; return res; },
  };
  return res;
}

describe('requireAuth', () => {
  it('calls next() when user is authenticated', () => {
    const req = mockReq({ session: { userId: 1 } });
    const res = mockRes();
    let called = false;
    requireAuth(req, res, () => { called = true; });
    assert.ok(called);
  });

  it('returns 401 JSON for unauthenticated API requests', () => {
    const req = mockReq({ path: '/api/peers' });
    const res = mockRes();
    requireAuth(req, res, () => { assert.fail('should not call next'); });
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.jsonData, { ok: false, error: 'Unauthorized' });
  });

  it('redirects to /login for unauthenticated page requests', () => {
    const req = mockReq({ path: '/dashboard' });
    const res = mockRes();
    requireAuth(req, res, () => { assert.fail('should not call next'); });
    assert.equal(res.redirectUrl, '/login');
  });

  it('handles missing session gracefully', () => {
    const req = mockReq({ session: null, path: '/dashboard' });
    const res = mockRes();
    requireAuth(req, res, () => { assert.fail('should not call next'); });
    assert.equal(res.redirectUrl, '/login');
  });
});

describe('guestOnly', () => {
  it('calls next() when user is not authenticated', () => {
    const req = mockReq();
    const res = mockRes();
    let called = false;
    guestOnly(req, res, () => { called = true; });
    assert.ok(called);
  });

  it('redirects to / when user is authenticated', () => {
    const req = mockReq({ session: { userId: 1 } });
    const res = mockRes();
    guestOnly(req, res, () => { assert.fail('should not call next'); });
    assert.equal(res.redirectUrl, '/');
  });
});
