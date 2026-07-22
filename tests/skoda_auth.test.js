'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const auth = require('../src/services/skoda/skodaAuth');
const { emailPage, passwordPage } = require('./fixtures/skoda/idk_login_page');

test('generatePkce returns base64url verifier and matching S256 challenge', () => {
  const { verifier, challenge } = auth.generatePkce();
  assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
  const expected = crypto.createHash('sha256').update(verifier).digest('base64url');
  assert.equal(challenge, expected);
});

test('parseIdk extracts csrf token and template model', () => {
  const idk = auth.parseIdk(emailPage);
  assert.equal(idk.csrfToken, 'csrf-123');
  assert.equal(idk.templateModel.hmac, 'hmac-abc');
  assert.equal(idk.templateModel.relayState, 'relay-xyz');
  assert.equal(idk.templateModel.postAction, 'login/identifier');
});

test('parseIdk throws SKODA_AUTH_FLOW_CHANGED on unexpected html', () => {
  assert.throws(() => auth.parseIdk('<html>maintenance</html>'), (e) => e.code === 'SKODA_AUTH_FLOW_CHANGED');
});

test('parseFragment reads code from myskoda redirect (fragment)', () => {
  const params = auth.parseFragment('myskoda://redirect/login/#code=THECODE&token_type=bearer&id_token=IDT');
  assert.equal(params.code, 'THECODE');
  assert.equal(params.id_token, 'IDT');
});

test('parseFragment reads code from query (response_type=code)', () => {
  // Real Skoda behaviour: response_type=code returns the code as a query param.
  const params = auth.parseFragment('myskoda://redirect/login/?state=x&code=QCODE');
  assert.equal(params.code, 'QCODE');
});

function htmlRes(body) {
  return { status: 200, headers: new Headers({ 'content-type': 'text/html' }), text: async () => body, json: async () => ({}) };
}
function redirectRes(location, setCookies = []) {
  const h = new Headers({ location });
  for (const c of setCookies) h.append('set-cookie', c);
  return { status: 302, headers: h, text: async () => '', json: async () => ({}) };
}
function jsonRes(obj, status = 200) {
  return { status, headers: new Headers({ 'content-type': 'application/json' }), json: async () => obj, text: async () => JSON.stringify(obj) };
}

test('login walks the full flow and exchanges the code', async () => {
  const seen = [];
  const fetchImpl = async (url, opts = {}) => {
    seen.push({ url, method: opts.method || 'GET', body: opts.body });
    if (url.startsWith(auth.IDENT_BASE + '/oidc/v1/authorize')) return htmlRes(emailPage);
    if (url.includes('/login/identifier')) return htmlRes(passwordPage);
    if (url.includes('/login/authenticate')) return redirectRes(auth.IDENT_BASE + '/oidc/v1/oauth/sso?x=1', ['SESSION=s1']);
    // response_type=code → code comes back as a QUERY param on the redirect
    if (url.includes('/oidc/v1/oauth/sso')) return redirectRes('myskoda://redirect/login/?code=THECODE');
    if (url.startsWith(auth.API_BASE + '/api/v1/authentication/exchange-authorization-code')) {
      return jsonRes({ accessToken: 'AT', refreshToken: 'RT', idToken: 'IDT' });
    }
    throw new Error('unexpected url ' + url);
  };
  const tokens = await auth.login('a@b.c', 'pw', { fetchImpl });
  assert.deepEqual(tokens, { accessToken: 'AT', refreshToken: 'RT', idToken: 'IDT' });
  // authorize request must use the real Skoda params
  const authorize = seen.find((s) => s.url.includes('/oidc/v1/authorize'));
  assert.match(authorize.url, /response_type=code(&|$)/);
  assert.match(authorize.url, /code_challenge_method=s256/);
  assert.match(authorize.url, /prompt=login/);
  const exchange = seen.find((s) => s.url.includes('exchange-authorization-code'));
  const body = JSON.parse(exchange.body);
  assert.equal(body.code, 'THECODE');
  assert.equal(body.redirectUri, auth.REDIRECT_URI);
  assert.ok(body.verifier);
  const identifierPost = seen.find((s) => s.url.includes('/login/identifier'));
  assert.match(identifierPost.body, /email=a%40b.c/);
  assert.match(identifierPost.body, /hmac=hmac-abc/);
  const authPost = seen.find((s) => s.url.includes('/login/authenticate'));
  assert.match(authPost.body, /hmac=hmac-def/);
  assert.match(authPost.body, /password=pw/);
});

test('login maps terms-and-conditions redirect to SKODA_TERMS_REQUIRED', async () => {
  const fetchImpl = async (url, opts = {}) => {
    if (url.startsWith(auth.IDENT_BASE + '/oidc/v1/authorize')) return htmlRes(emailPage);
    if (url.includes('/login/identifier')) return htmlRes(passwordPage);
    if (url.includes('/login/authenticate')) return redirectRes(auth.IDENT_BASE + '/signin-service/v1/terms-and-conditions?x=1');
    return htmlRes('<html>terms</html>');
  };
  await assert.rejects(auth.login('a@b.c', 'pw', { fetchImpl }), (e) => e.code === 'SKODA_TERMS_REQUIRED');
});

test('login maps wrong password (re-rendered login page) to SKODA_LOGIN_FAILED', async () => {
  const fetchImpl = async (url, opts = {}) => {
    if (url.startsWith(auth.IDENT_BASE + '/oidc/v1/authorize')) return htmlRes(emailPage);
    if (url.includes('/login/identifier')) return htmlRes(passwordPage);
    if (url.includes('/login/authenticate')) return htmlRes(passwordPage); // no redirect => login failed
    throw new Error('unexpected ' + url);
  };
  await assert.rejects(auth.login('a@b.c', 'wrong', { fetchImpl }), (e) => e.code === 'SKODA_LOGIN_FAILED');
});

test('refresh posts refresh token and returns new tokens', async () => {
  let seenBody = null;
  const fetchImpl = async (url, opts = {}) => {
    assert.ok(url.startsWith(auth.API_BASE + '/api/v1/authentication/refresh-token'));
    seenBody = JSON.parse(opts.body);
    return jsonRes({ accessToken: 'AT2', refreshToken: 'RT2', idToken: 'IDT2' });
  };
  const tokens = await auth.refresh('RT1', { fetchImpl });
  assert.equal(seenBody.token, 'RT1');
  assert.equal(tokens.accessToken, 'AT2');
});

test('refresh maps 429 to SKODA_RATE_LIMITED', async () => {
  const fetchImpl = async () => jsonRes({}, 429);
  await assert.rejects(auth.refresh('RT1', { fetchImpl }), (e) => e.code === 'SKODA_RATE_LIMITED');
});
