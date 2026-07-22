'use strict';

// MySkoda login flow, ported from the Python `myskoda` reference library.
// The API is unofficial; scripts/skoda-spike.js is the live ground truth.

const crypto = require('node:crypto');
const { CookieJar, requestWithJar, followRedirects } = require('./skodaHttp');

const CLIENT_ID = '7f045eee-7003-4379-9968-9355ed2adb06@apps_vw-dilab_com';
const REDIRECT_URI = 'myskoda://redirect/login/';
const IDENT_BASE = 'https://identity.vwgroup.io';
const API_BASE = 'https://mysmob.api.connect.skoda-auto.cz';
const SCOPES = 'address badge birthdate cars driversLicense dealers email mileage mbb nationalIdentifier openid phone profession profile vin';
const FORM_HEADERS = { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html' };

class SkodaAuthError extends Error {
  constructor(message, code) { super(message); this.name = 'SkodaAuthError'; this.code = code; }
}

function generatePkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function parseIdk(html) {
  const csrf = html.match(/csrf_token:\s*['"]([^'"]+)['"]/);
  const tpl = html.match(/templateModel:\s*(\{.*?\})\s*,?\s*\n/s);
  if (!csrf || !tpl) throw new SkodaAuthError('cannot parse identity page', 'SKODA_AUTH_FLOW_CHANGED');
  let templateModel;
  try { templateModel = JSON.parse(tpl[1]); } catch {
    throw new SkodaAuthError('cannot parse templateModel', 'SKODA_AUTH_FLOW_CHANGED');
  }
  return { csrfToken: csrf[1], templateModel };
}

function parseFragment(location) {
  const hash = location.split('#')[1] || '';
  return Object.fromEntries(new URLSearchParams(hash));
}

function formBody(fields) { return new URLSearchParams(fields).toString(); }

async function exchangeCode(code, verifier, fetchImpl) {
  const res = await fetchImpl(`${API_BASE}/api/v1/authentication/exchange-authorization-code?tokenType=CONNECT`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ code, redirectUri: REDIRECT_URI, verifier }),
  });
  if (res.status === 429) throw new SkodaAuthError('rate limited', 'SKODA_RATE_LIMITED');
  if (res.status >= 400) throw new SkodaAuthError(`code exchange failed (${res.status})`, 'SKODA_LOGIN_FAILED');
  const json = await res.json();
  return { accessToken: json.accessToken, refreshToken: json.refreshToken, idToken: json.idToken };
}

async function login(email, password, { fetchImpl = fetch } = {}) {
  const jar = new CookieJar();
  const { verifier, challenge } = generatePkce();
  const nonce = crypto.randomBytes(16).toString('base64url');

  const authorizeUrl = `${IDENT_BASE}/oidc/v1/authorize?` + new URLSearchParams({
    client_id: CLIENT_ID,
    nonce,
    redirect_uri: REDIRECT_URI,
    response_type: 'code id_token',
    scope: SCOPES,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();

  const start = await followRedirects(jar, authorizeUrl, { method: 'GET', headers: { accept: 'text/html' } }, { fetchImpl });
  const emailIdk = parseIdk(await start.res.text());

  const identifierRes = await followRedirects(jar,
    `${IDENT_BASE}/signin-service/v1/${CLIENT_ID}/login/identifier`,
    { method: 'POST', headers: FORM_HEADERS, body: formBody({
      _csrf: emailIdk.csrfToken,
      relayState: emailIdk.templateModel.relayState,
      hmac: emailIdk.templateModel.hmac,
      email,
    }) }, { fetchImpl });
  const pwIdk = parseIdk(await identifierRes.res.text());

  const finish = await followRedirects(jar,
    `${IDENT_BASE}/signin-service/v1/${CLIENT_ID}/login/authenticate`,
    { method: 'POST', headers: FORM_HEADERS, body: formBody({
      _csrf: pwIdk.csrfToken,
      relayState: pwIdk.templateModel.relayState,
      hmac: pwIdk.templateModel.hmac,
      email,
      password,
    }) }, { stopPrefix: 'myskoda://', fetchImpl });

  if (!finish.location.startsWith('myskoda://')) {
    if (finish.location.includes('terms-and-conditions')) {
      throw new SkodaAuthError('terms acceptance required in MySkoda app', 'SKODA_TERMS_REQUIRED');
    }
    throw new SkodaAuthError('login did not reach redirect (wrong credentials?)', 'SKODA_LOGIN_FAILED');
  }
  const { code } = parseFragment(finish.location);
  if (!code) throw new SkodaAuthError('no code in redirect', 'SKODA_AUTH_FLOW_CHANGED');
  return exchangeCode(code, verifier, fetchImpl);
}

async function refresh(refreshToken, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`${API_BASE}/api/v1/authentication/refresh-token?tokenType=CONNECT`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ token: refreshToken }),
  });
  if (res.status === 429) throw new SkodaAuthError('rate limited', 'SKODA_RATE_LIMITED');
  if (res.status >= 400) throw new SkodaAuthError(`refresh failed (${res.status})`, 'SKODA_LOGIN_FAILED');
  const json = await res.json();
  return { accessToken: json.accessToken, refreshToken: json.refreshToken, idToken: json.idToken };
}

module.exports = {
  SkodaAuthError, generatePkce, parseIdk, parseFragment, login, refresh,
  CLIENT_ID, REDIRECT_URI, IDENT_BASE, API_BASE,
};
