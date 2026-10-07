'use strict';

// Licence server v2: Ed25519-signed tokens, JWKS, revocation, offline grace,
// v1 fallback while v2 is not deployed, plugin entitlements, deactivation.
// The licence server is mocked at the fetch level.

require('./helpers/test-env');

const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');

const { runMigrations } = require('../src/db/migrations');
const config = require('../config/default');
const settings = require('../src/services/settings');
const license = require('../src/services/license');
const v2 = require('../src/services/licenseV2');

const V1_URL = 'https://lic.test/api/licenses/validate';
const V2_URL = 'https://lic.test/api/v2/licenses';
const JWKS_URL = 'https://lic.test/api/licenses/keys';
const V1_SECRET = 'v1-shared-secret-every-customer-sees';

function keypair(kid) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const { x } = publicKey.export({ format: 'jwk' });
  return { kid, privateKey, jwk: { kty: 'OKP', crv: 'Ed25519', kid, use: 'sig', alg: 'EdDSA', x } };
}

const KEY_A = keypair('key-a');
const KEY_B = keypair('key-b');
const KEY_OTHER = keypair('key-other');

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

function signEd(payload, key = KEY_A, headerOverride = {}) {
  const h = b64({ typ: 'JWT', alg: 'EdDSA', kid: key.kid, ...headerOverride });
  const p = b64(payload);
  const sig = crypto.sign(null, Buffer.from(h + '.' + p), key.privateKey).toString('base64url');
  return `${h}.${p}.${sig}`;
}

const now = () => Math.floor(Date.now() / 1000);
let FP;

function appClaims(over = {}) {
  return {
    iss: 'callmetechie.de', sub: 'lic:1', pid: 1, kind: 'app', plan: 'pro-monthly',
    features: { vpn_peers: -1, http_routes: -1, webhooks: true, compression: false },
    fp: FP, iat: now(), exp: now() + 7 * 86400,
    lat: now() + 30 * 86400, upd: now() + 365 * 86400,
    ...over,
  };
}

function pluginClaims(over = {}) {
  return { iss: 'callmetechie.de', sub: 'lic:7', pid: 9, kind: 'plugin', plan: 'plugin', fp: FP, iat: now(), exp: now() + 7 * 86400, lat: 0, upd: 0, ...over };
}

function okResponse({ token = signEd(appClaims()), plugins = [] } = {}) {
  return {
    status: 200,
    body: {
      valid: true,
      license: { product: 'gatecontrol', plan: 'pro-monthly', plan_type: 'subscription', features: {}, expires_at: null, updates_until: null, max_activations: 2, active_activations: 1 },
      token, plugins, server_time: new Date().toISOString(),
    },
  };
}

// ── fetch mock ──
const server = {
  v2: () => okResponse(),
  v1: () => ({ status: 500, body: {} }),
  jwks: () => ({ status: 200, body: { keys: [KEY_A.jwk] } }),
  deactivate: () => ({ status: 200, body: { success: true } }),
  calls: [],
};

function count(kind) { return server.calls.filter((c) => c.kind === kind).length; }

const realFetch = global.fetch;
global.fetch = async (url, opts = {}) => {
  const u = String(url);
  let kind;
  if (u === V2_URL + '/validate') kind = 'v2';
  else if (u === V2_URL + '/deactivate') kind = 'deactivate';
  else if (u === JWKS_URL) kind = 'jwks';
  else if (u === V1_URL) kind = 'v1';
  else return new Response('{}', { status: 404 });
  const body = opts.body ? JSON.parse(opts.body) : null;
  server.calls.push({ kind, body });
  const r = server[kind](body);
  if (r === 'network') throw new TypeError('fetch failed');
  return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'Content-Type': 'application/json' } });
};

// background refreshes are fire-and-forget — let them settle
async function flush() { for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r)); }

function setLastOk(msAgo) {
  const rec = JSON.parse(settings.get('license.v2.token'));
  rec.last_ok_at = Date.now() - msAgo;
  settings.set('license.v2.token', JSON.stringify(rec));
}

function seedState(token, { lastOkAgo = 0, plugins = [] } = {}) {
  v2.saveState(config.license.key, { token, plugins, now: Date.now() - lastOkAgo, activations: 1, max_activations: 2 });
  v2.markActive();
}

before(() => {
  runMigrations();
  FP = license._getHardwareFingerprint();
  config.license.server = V1_URL;
  config.license.serverV2 = V2_URL;
  config.license.jwksUrl = JWKS_URL;
});

after(() => { global.fetch = realFetch; license.stopLicenseRefresh(); });

beforeEach(async () => {
  license._resetV2ForTest();
  license._applyLicenseForTest(null);
  config.license.key = 'GATE-AAAA-BBBB-CCCC';
  config.license.signingKey = '';
  config.license.pubkeys = '';
  server.v2 = () => okResponse();
  server.v1 = () => ({ status: 500, body: {} });
  server.jwks = () => ({ status: 200, body: { keys: [KEY_A.jwk] } });
  server.deactivate = () => ({ status: 200, body: { success: true } });
  server.calls = [];
});

describe('v2 token verification', () => {
  it('accepts a valid EdDSA token', async () => {
    const r = await v2.verifyToken(signEd(appClaims()), { fingerprint: FP, kind: 'app' });
    assert.equal(r.ok, true);
    assert.equal(r.payload.plan, 'pro-monthly');
  });

  it('unknown kid triggers one JWKS refetch, then verifies', async () => {
    settings.set('license.v2.jwks', JSON.stringify({ keys: [KEY_A.jwk], fetched_at: Date.now() - 2 * 3600 * 1000 }));
    server.jwks = () => ({ status: 200, body: { keys: [KEY_B.jwk, KEY_A.jwk] } });
    const r = await v2.verifyToken(signEd(appClaims(), KEY_B), { fingerprint: FP, kind: 'app' });
    assert.equal(r.ok, true);
    assert.equal(count('jwks'), 1);
    // A second unknown kid within the hour does not refetch.
    const r2 = await v2.verifyToken(signEd(appClaims(), KEY_OTHER), { fingerprint: FP, kind: 'app' });
    assert.deepEqual(r2, { ok: false, reason: 'kid' });
    assert.equal(count('jwks'), 1);
  });

  it('rejects a token with a known kid but a forged signature', async () => {
    const forged = signEd(appClaims(), KEY_OTHER, { kid: 'key-a' });
    assert.deepEqual(await v2.verifyToken(forged, { fingerprint: FP, kind: 'app' }), { ok: false, reason: 'signature' });
  });

  it('rejects a token for another fingerprint', async () => {
    const r = await v2.verifyToken(signEd(appClaims({ fp: 'f'.repeat(64) })), { fingerprint: FP, kind: 'app' });
    assert.deepEqual(r, { ok: false, reason: 'fp' });
  });

  it('rejects an expired token unless grace is asked for', async () => {
    const t = signEd(appClaims({ exp: now() - 10 }));
    assert.deepEqual(await v2.verifyToken(t, { fingerprint: FP, kind: 'app' }), { ok: false, reason: 'expired' });
    assert.equal((await v2.verifyToken(t, { fingerprint: FP, kind: 'app', allowExpired: true })).ok, true);
  });

  it('rejects wrong issuer and wrong kind', async () => {
    assert.equal((await v2.verifyToken(signEd(appClaims({ iss: 'evil.example' })), { fingerprint: FP, kind: 'app' })).reason, 'iss');
    assert.equal((await v2.verifyToken(signEd(pluginClaims()), { fingerprint: FP, kind: 'app' })).reason, 'kind');
  });

  it('rejects HS256 and alg=none tokens', async () => {
    const hs = jwt.sign(appClaims(), V1_SECRET, { algorithm: 'HS256', header: { kid: 'key-a' } });
    assert.deepEqual(await v2.verifyToken(hs, { fingerprint: FP, kind: 'app' }), { ok: false, reason: 'alg' });
    const none = `${b64({ alg: 'none', kid: 'key-a' })}.${b64(appClaims())}.`;
    assert.equal((await v2.verifyToken(none, { fingerprint: FP, kind: 'app' })).ok, false);
    const none2 = `${b64({ alg: 'none', kid: 'key-a' })}.${b64(appClaims())}.AAAA`;
    assert.deepEqual(await v2.verifyToken(none2, { fingerprint: FP, kind: 'app' }), { ok: false, reason: 'alg' });
  });

  it('pinned keys (GC_LICENSE_PUBKEYS) are the only accepted keys', async () => {
    config.license.pubkeys = JSON.stringify({ keys: [KEY_B.jwk] });
    assert.deepEqual(await v2.verifyToken(signEd(appClaims(), KEY_A), { fingerprint: FP, kind: 'app' }), { ok: false, reason: 'kid' });
    assert.equal((await v2.verifyToken(signEd(appClaims(), KEY_B), { fingerprint: FP, kind: 'app' })).ok, true);
    assert.equal(count('jwks'), 0);
  });
});

describe('v2 validation flow', () => {
  it('applies a valid signed licence and parses plugin entitlements', async () => {
    license.setPluginKeys(['GCSK-1111-2222-H6KN', ' GCMD-3333-4444-ZZZZ ', 'GCSK-1111-2222-H6KN']);
    server.v2 = () => okResponse({
      plugins: [
        { slug: 'gatecontrol-skoda', name: 'Fahrzeuge', source: 'license', key_masked: 'GCSK-****-****-H6KN', valid: true, expires_at: null, updates_until: null, token: signEd(pluginClaims({ lat: now() + 86400, upd: now() + 2 * 86400 })) },
        { slug: 'gatecontrol-midea', name: 'Klima', source: 'lifetime', key_masked: null, valid: true, expires_at: null, updates_until: null, token: signEd(pluginClaims({ sub: 'lifetime:4' })) },
        { slug: 'gatecontrol-foo', name: 'Foo', source: 'license', key_masked: 'GCMD-****-****-ZZZZ', valid: false, error: 'wrong_product', expires_at: null, updates_until: null, token: null },
        { slug: 'gatecontrol-bar', name: 'Bar', source: 'license', key_masked: null, valid: true, expires_at: null, updates_until: null, token: signEd(pluginClaims({ fp: 'x' })) },
      ],
    });

    const info = await license.validateLicense();
    assert.equal(info.plan, 'pro-monthly');
    assert.equal(info.verification, 'signed');
    assert.equal(license.hasFeature('webhooks'), true);
    assert.equal(license.getFeatureLimit('vpn_peers'), -1);
    assert.ok(info.expires_at && info.updates_until);
    assert.equal(info.activations, 1);
    assert.equal(v2.isActive(), true);

    const sent = server.calls.find((c) => c.kind === 'v2').body;
    assert.deepEqual(sent.plugin_keys, ['GCSK-1111-2222-H6KN', 'GCMD-3333-4444-ZZZZ']);
    assert.equal(sent.product_slug, 'gatecontrol');
    assert.equal(sent.hardware_fingerprint, FP);
    assert.equal(sent.license_key, 'GATE-AAAA-BBBB-CCCC');

    const ents = license.getPluginEntitlements();
    assert.equal(ents.length, 4);
    const by = Object.fromEntries(ents.map((e) => [e.slug, e]));
    assert.equal(by['gatecontrol-skoda'].valid, true);
    assert.equal(by['gatecontrol-skoda'].source, 'license');
    assert.ok(by['gatecontrol-skoda'].expires_at);
    assert.ok(by['gatecontrol-skoda'].updates_until);
    assert.equal(by['gatecontrol-midea'].valid, true);
    assert.equal(by['gatecontrol-midea'].source, 'lifetime');
    assert.equal(by['gatecontrol-midea'].expires_at, null);
    assert.equal(by['gatecontrol-foo'].valid, false);
    assert.equal(by['gatecontrol-foo'].error, 'wrong_product');
    assert.equal(by['gatecontrol-bar'].valid, false);
    assert.equal(by['gatecontrol-bar'].error, 'token_invalid');
    for (const e of ents) assert.equal('token' in e, false, 'tokens never leave the service');
    assert.deepEqual(Object.keys(by['gatecontrol-skoda']).sort(), ['error', 'expires_at', 'name', 'slug', 'source', 'updates_until', 'valid']);
  });

  it('a 403 license_invalid drops the cached licence immediately', async () => {
    await license.validateLicense();
    assert.equal(license.getPlan(), 'pro-monthly');
    server.v2 = () => ({ status: 403, body: { valid: false, error: 'license_invalid', message: 'revoked' } });
    await license.refreshLicenseInBackground();
    assert.equal(license.getPlan(), 'community');
    assert.equal(license.getLicenseInfo().valid, false);
    assert.equal(settings.get('license.v2.token'), '');
    assert.deepEqual(license.getPluginEntitlements(), []);
    // A restart does not resurrect it either.
    await license.validateLicense();
    await flush();
    assert.equal(license.getPlan(), 'community');
  });

  it('a network error within the grace period keeps the licence', async () => {
    seedState(signEd(appClaims({ exp: now() - 60 })), { lastOkAgo: 3 * 86400 * 1000 });
    server.v2 = () => 'network';
    const info = await license.validateLicense();
    assert.equal(info.plan, 'pro-monthly');
    assert.equal(info.verification, 'signed_offline');
  });

  it('429 / 5xx within the token exp keep the licence (cached path)', async () => {
    seedState(signEd(appClaims()), { lastOkAgo: 20 * 86400 * 1000 });
    server.v2 = () => ({ status: 429, body: {} });
    await license.validateLicense();
    await flush();
    assert.equal(license.getPlan(), 'pro-monthly');
    server.v2 = () => ({ status: 502, body: {} });
    await license.refreshLicenseInBackground();
    assert.equal(license.getPlan(), 'pro-monthly');
  });

  it('beyond the grace period falls back to community', async () => {
    seedState(signEd(appClaims({ exp: now() - 60 })), { lastOkAgo: 15 * 86400 * 1000 });
    server.v2 = () => 'network';
    const info = await license.validateLicense();
    assert.equal(info.plan, 'community');
    assert.equal(info.verification, null);
  });

  it('an expired licence (lat) is not kept in grace', async () => {
    seedState(signEd(appClaims({ exp: now() - 60, lat: now() - 30 })), { lastOkAgo: 86400 * 1000 });
    server.v2 = () => 'network';
    assert.equal((await license.validateLicense()).plan, 'community');
  });

  it('a stored token of another licence key is ignored', async () => {
    seedState(signEd(appClaims()));
    config.license.key = 'GATE-OTHER-KEY-0000';
    server.v2 = () => 'network';
    assert.equal((await license.validateLicense()).plan, 'community');
  });

  it('503 / 404 from v2 use the legacy v1 path while v2 never succeeded', async () => {
    config.license.signingKey = V1_SECRET;
    server.v1 = (body) => ({
      status: 200,
      body: {
        valid: true,
        license: { plan: 'pro', features: { webhooks: true }, expires_at: null, active_activations: 1, max_activations: 2 },
        token: jwt.sign({ plan: 'pro', features: { webhooks: true }, fp: body.hardware_fingerprint, lat: 0 }, V1_SECRET, { algorithm: 'HS256', expiresIn: '7d' }),
      },
    });
    for (const status of [503, 404]) {
      license._resetV2ForTest();
      require('fs').rmSync(config.license.tokenPath, { force: true });
      server.v2 = () => ({ status, body: { valid: false, error: 'unavailable' } });
      const info = await license.validateLicense();
      assert.equal(info.plan, 'pro', `v1 used on ${status}`);
      assert.equal(info.verification, 'legacy');
      assert.equal(v2.isActive(), false);
    }
  });

  it('a v2-validated install never downgrades to v1 on a later 503', async () => {
    config.license.signingKey = V1_SECRET;
    await license.validateLicense();
    assert.equal(license.getLicenseInfo().verification, 'signed');
    server.v2 = () => ({ status: 503, body: { valid: false, error: 'unavailable' } });
    server.v1 = () => { throw new Error('v1 must not be asked'); };
    await license.refreshLicenseInBackground();
    assert.equal(license.getPlan(), 'pro-monthly');
    assert.equal(count('v1'), 0);
  });

  it('an HS256 token on the v2 path is never applied', async () => {
    server.v2 = () => okResponse({ token: jwt.sign(appClaims({ plan: 'forged' }), V1_SECRET, { algorithm: 'HS256' }) });
    const info = await license.validateLicense();
    assert.notEqual(info.plan, 'forged');
    assert.equal(v2.isActive(), false);
  });
});

describe('plugin keys and deactivation', () => {
  it('stores plugin keys encrypted and validates input', () => {
    assert.deepEqual(license.setPluginKeys(['GCSK-A', '', 'GCSK-A', 'GCMD-B']), ['GCSK-A', 'GCMD-B']);
    assert.deepEqual(license.getPluginKeys(), ['GCSK-A', 'GCMD-B']);
    assert.ok(!String(settings.get('license.plugin_keys_encrypted')).includes('GCSK-A'));
    assert.throws(() => license.setPluginKeys('GCSK-A'));
    assert.throws(() => license.setPluginKeys(['x'.repeat(201)]));
    license.setPluginKeys([]);
    assert.deepEqual(license.getPluginKeys(), []);
  });

  it('removeLicense deactivates on the server', async () => {
    await license.validateLicense();
    await license.removeLicense();
    const call = server.calls.find((c) => c.kind === 'deactivate');
    assert.deepEqual(call.body, { license_key: 'GATE-AAAA-BBBB-CCCC', hardware_fingerprint: FP });
    assert.equal(license.getPlan(), 'community');
    assert.equal(license.isUnlicensedMode(), true);
  });

  it('removeLicense still removes the licence when deactivation fails', async () => {
    await license.validateLicense();
    server.deactivate = () => 'network';
    await license.removeLicense();
    assert.equal(license.getPlan(), 'community');
    assert.equal(config.license.key, '');
    assert.equal(await license.deactivateLicense('GATE-X'), false);
  });
});
