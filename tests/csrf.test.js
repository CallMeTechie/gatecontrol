'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { injectCsrfToken, ensureCsrfToken } = require('../src/middleware/csrf');

function makeReq({ session } = {}) {
  return { session, body: {}, headers: {}, cookies: {} };
}
function makeRes() {
  return { locals: {} };
}
function runMiddleware(mw, req, res) {
  return new Promise((resolve, reject) => {
    mw(req, res, (err) => (err ? reject(err) : resolve()));
  });
}

describe('injectCsrfToken — anti session-pollution', () => {
  test('no session → empty token, does NOT touch session', async () => {
    const req = makeReq({ session: undefined });
    const res = makeRes();
    await runMiddleware(injectCsrfToken, req, res);
    assert.equal(res.locals.csrfToken, '');
  });

  test('anonymous session (no userId, no existing token) → empty token, no session write', async () => {
    const session = {};
    const req = makeReq({ session });
    const res = makeRes();
    await runMiddleware(injectCsrfToken, req, res);
    assert.equal(res.locals.csrfToken, '');
    assert.equal(session.csrfToken, undefined,
      'fresh anon visit must not write csrfToken into the session — that is what created the bot-pollution rows');
  });

  test('session with existing token → surface it without re-generating', async () => {
    const session = { csrfToken: 'preexisting-token-abc' };
    const req = makeReq({ session });
    const res = makeRes();
    await runMiddleware(injectCsrfToken, req, res);
    assert.equal(res.locals.csrfToken, 'preexisting-token-abc');
    assert.equal(session.csrfToken, 'preexisting-token-abc', 'must not rotate');
  });

  test('authenticated session without token → mint one', async () => {
    const session = { userId: 7 };
    const req = makeReq({ session });
    const res = makeRes();
    await runMiddleware(injectCsrfToken, req, res);
    assert.ok(res.locals.csrfToken, 'authenticated user must receive a token');
    assert.equal(typeof res.locals.csrfToken, 'string');
    assert.ok(res.locals.csrfToken.length >= 32);
    assert.equal(session.csrfToken, res.locals.csrfToken,
      'minted token must be persisted to session for the POST roundtrip');
  });
});

describe('ensureCsrfToken — explicit anon-visitor mint', () => {
  test('with session: mints and exposes token', () => {
    const session = {};
    const req = makeReq({ session });
    const res = makeRes();
    ensureCsrfToken(req, res);
    assert.ok(res.locals.csrfToken);
    assert.equal(typeof res.locals.csrfToken, 'string');
    assert.equal(session.csrfToken, res.locals.csrfToken);
  });

  test('no session: no-op (does not throw)', () => {
    const req = makeReq({ session: undefined });
    const res = makeRes();
    ensureCsrfToken(req, res);
    assert.equal(res.locals.csrfToken, undefined);
  });
});
