'use strict';

// End of life (docs/feature-license-eol.md): a signed eol.json — signed with a
// key of the licence server's JWKS, nothing else — makes licences without an
// end (lat 0) valid without the licence server; scope "all" also lets
// subscriptions run until their paid end. Nothing else is accepted.

require('./helpers/test-env');

const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const jwt = require('jsonwebtoken');

const { runMigrations } = require('../src/db/migrations');
const config = require('../config/default');
const settings = require('../src/services/settings');
const license = require('../src/services/license');
const v2 = require('../src/services/licenseV2');
const eol = require('../src/services/licenseEol');

const V2_URL = 'https://lic.test/api/v2/licenses';
const JWKS_URL = 'https://lic.test/api/licenses/keys';
const EOL_URL = 'https://lic.test/api/eol/gatecontrol';
const EOL_URL2 = 'https://mirror.example.test/eol.json';
const DAY = 86400;

function keypair(kid) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return { kid, privateKey, jwk: { kty: 'OKP', crv: 'Ed25519', kid, use: 'sig', alg: 'EdDSA', x: publicKey.export({ format: 'jwk' }).x } };
}
const KEY_A = keypair('key-a');
const KEY_OTHER = keypair('key-other');
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function signEd(payload, key = KEY_A, header = {}) {
  const h = b64({ typ: 'JWT', alg: 'EdDSA', kid: key.kid, ...header });
  const p = b64(payload);
  return `${h}.${p}.${crypto.sign(null, Buffer.from(h + '.' + p), key.privateKey).toString('base64url')}`;
}
const now = () => Math.floor(Date.now() / 1000);
let FP;

function eolClaims(over = {}) {
  return { iss: 'callmetechie.de', kind: 'eol', v: 1, product: 'gatecontrol', scope: 'lifetime', iat: now() - 60,
    message: { de: 'GateControl wird eingestellt.', en: 'GateControl is discontinued.' }, ...over };
}
const eolFile = (over = {}, key = KEY_A, header = {}) => JSON.stringify({ v: 1, product: 'gatecontrol', token: signEd(eolClaims(over), key, header) });

function appClaims(over = {}) {
  return { iss: 'callmetechie.de', sub: 'lic:1', pid: 1, kind: 'app', plan: 'lifetime',
    features: { vpn_peers: -1, http_routes: -1, webhooks: true }, fp: FP, iat: now() - 40 * DAY, exp: now() - 33 * DAY, lat: 0, upd: 0, ...over };
}
function pluginClaims(over = {}) {
  return { iss: 'callmetechie.de', sub: 'lifetime:4', pid: 9, kind: 'plugin', plan: 'plugin', fp: FP, iat: now() - 40 * DAY, exp: now() - 33 * DAY, lat: 0, upd: 0, ...over };
}

const server = { v2: () => 'network', eol: () => ({ status: 404, body: '' }), eol2: () => ({ status: 404, body: '' }), calls: [] };
const realFetch = global.fetch;
global.fetch = async (url) => {
  const u = String(url);
  let kind;
  if (u === V2_URL + '/validate') kind = 'v2';
  else if (u === JWKS_URL) kind = 'jwks';
  else if (u === EOL_URL) kind = 'eol';
  else if (u === EOL_URL2) kind = 'eol2';
  else return new Response('{}', { status: 404 });
  server.calls.push(kind);
  const r = kind === 'jwks' ? { status: 200, body: { keys: [KEY_A.jwk] } } : server[kind]();
  if (r === 'network') throw new TypeError('fetch failed');
  const body = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
  return new Response(body, { status: r.status, headers: { 'Content-Type': 'application/json' } });
};
const count = (k) => server.calls.filter((c) => c === k).length;
async function flush() { for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r)); }

function seedState(token, { lastOkAgoDays = 33, plugins = [] } = {}) {
  v2.saveState(config.license.key, { token, plugins, now: Date.now() - lastOkAgoDays * DAY * 1000, activations: 1, max_activations: 2 });
  v2.markActive();
}

let tmpDir;
before(() => {
  runMigrations();
  FP = license._getHardwareFingerprint();
  config.license.serverV2 = V2_URL;
  config.license.jwksUrl = JWKS_URL;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-eol-'));
});
after(() => { global.fetch = realFetch; license.stopLicenseRefresh(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

beforeEach(() => {
  license._resetV2ForTest();
  license._applyLicenseForTest(null);
  config.license.key = 'GATE-AAAA-BBBB-CCCC';
  config.license.pubkeys = '';
  config.license.eolFile = path.join(tmpDir, 'none.json');
  config.license.eolUrl = '';
  server.v2 = () => 'network';
  server.eol = () => ({ status: 404, body: '' });
  server.eol2 = () => ({ status: 404, body: '' });
  server.calls = [];
});

describe('EOL file verification', () => {
  it('accepts the wrapper and the bare token', async () => {
    const r = await eol.verify(eolFile());
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.eol.scope, 'lifetime');
    assert.deepEqual(r.eol.message, { de: 'GateControl wird eingestellt.', en: 'GateControl is discontinued.' });
    assert.equal((await eol.verify(signEd(eolClaims({ scope: 'all', message: 'Ende' })))).eol.message.en, 'Ende');
    assert.equal((await eol.verify('﻿' + signEd(eolClaims({ message: undefined })) + '\n')).ok, true);
  });

  it('accepts the website format (format, typ "eol", header typ gc-eol+jwt, kid, jti)', async () => {
    const claims = { iss: 'callmetechie.de', typ: 'eol', v: 1, kid: 'key-a', jti: 'eol-1', product: 'gatecontrol', scope: 'lifetime',
      iat: now() - 60, message: { de: 'Eingestellt.', en: 'Discontinued.' } };
    const file = JSON.stringify({ format: 'gatecontrol-eol', v: 1, product: 'gatecontrol', token: signEd(claims, KEY_A, { typ: 'gc-eol+jwt' }) });
    const r = await eol.verify(file);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.eol.scope, 'lifetime');
    assert.equal((await eol.verify(signEd({ ...claims, kid: 'key-b' }, KEY_A, { typ: 'gc-eol+jwt' }))).reason, 'kid', 'payload kid must match');
    assert.equal((await eol.verify(signEd(claims, KEY_A, { typ: 'other' }))).reason, 'typ');
    assert.equal((await eol.verify(signEd({ ...claims, kind: 'app' }, KEY_A))).reason, 'kind', 'never an app token');
    // and as a licence token it is worthless
    assert.equal((await v2.verifyToken(signEd({ ...claims, fp: FP, exp: now() + DAY }), { fingerprint: FP, kind: 'app' })).reason, 'kind');
  });

  it('a self-made file is never accepted', async () => {
    // signed with another key under the trusted kid
    assert.equal((await eol.verify(eolFile({}, KEY_OTHER, { kid: 'key-a' }))).reason, 'signature');
    // a key that is not in the JWKS
    assert.equal((await eol.verify(eolFile({}, KEY_OTHER))).reason, 'kid');
    // HS256 / none
    assert.equal((await eol.verify(jwt.sign(eolClaims(), 'secret', { algorithm: 'HS256', header: { kid: 'key-a' } }))).reason, 'alg');
    assert.equal((await eol.verify(`${b64({ alg: 'none', kid: 'key-a' })}.${b64(eolClaims())}.AAAA`)).reason, 'alg');
    // payload changed after signing
    const t = signEd(eolClaims()).split('.');
    t[1] = b64(eolClaims({ scope: 'all' }));
    assert.equal((await eol.verify(t.join('.'))).reason, 'signature');
    // a signature of the wrong length (cut / padded) or empty
    const good = signEd(eolClaims()).split('.');
    const sig = Buffer.from(good[2], 'base64url');
    for (const bad of [sig.subarray(0, 63), Buffer.concat([sig, Buffer.from([0])]), Buffer.alloc(1)]) {
      assert.equal((await eol.verify([good[0], good[1], bad.toString('base64url')].join('.'))).reason, 'signature');
    }
    // an unsigned wrapper
    assert.equal((await eol.verify(JSON.stringify({ v: 1, product: 'gatecontrol', scope: 'all' }))).reason, 'malformed');
  });

  it('rejects wrong claims', async () => {
    const cases = [
      [{ iss: 'evil.example' }, 'iss'], [{ kind: 'app' }, 'kind'], [{ v: 2 }, 'version'], [{ product: 'other' }, 'product'],
      [{ scope: 'everything' }, 'scope'], [{ iat: undefined }, 'iat'], [{ iat: now() + 3 * DAY }, 'iat'], [{ iat: 1.5 }, 'iat'],
      [{ message: 'x'.repeat(1001) }, 'message'], [{ message: { de: 5 } }, 'message'], [{ message: [] }, 'message'],
    ];
    for (const [over, reason] of cases) {
      assert.equal((await eol.verify(eolFile(over))).reason, reason, JSON.stringify(over));
    }
    assert.equal((await eol.verify('x'.repeat(eol.MAX_FILE_BYTES + 1))).reason, 'malformed');
    assert.equal((await eol.verify('{not json')).reason, 'malformed');
  });

  it('an EOL token is no licence token, and a licence token no EOL file', async () => {
    assert.equal((await v2.verifyToken(signEd(eolClaims({ fp: FP, exp: now() + DAY })), { fingerprint: FP, kind: 'app' })).reason, 'kind');
    assert.equal((await eol.verify(signEd(appClaims()))).reason, 'kind');
  });

  it('pinned keys (GC_LICENSE_PUBKEYS) bind the EOL file too', async () => {
    config.license.pubkeys = JSON.stringify({ keys: [KEY_OTHER.jwk] });
    assert.equal((await eol.verify(eolFile())).reason, 'kid');
    assert.equal((await eol.verify(eolFile({}, KEY_OTHER))).ok, true);
  });
});

describe('EOL in force', () => {
  it('without EOL a lifetime licence falls back after the grace; with EOL it stays, without asking the licence server', async () => {
    seedState(signEd(appClaims()));
    assert.equal((await license.validateLicense()).plan, 'community');

    assert.equal((await eol.importText(eolFile(), 'upload')).ok, true);
    server.calls = [];
    const info = await license.validateLicense();
    await flush();
    assert.equal(info.plan, 'lifetime');
    assert.equal(info.verification, 'eol');
    assert.equal(info.eol.scope, 'lifetime');
    assert.equal(info.eol.source, 'upload');
    assert.equal(count('v2'), 0, 'no online check');
    await license.refreshLicenseInBackground();
    assert.equal(count('v2'), 0, 'not in the daily check either');
    assert.equal(license.getPlan(), 'lifetime');
  });

  it('even a 403 cannot take it back once the EOL is in force (no online check at all)', async () => {
    seedState(signEd(appClaims()));
    await eol.importText(eolFile(), 'upload');
    server.v2 = () => ({ status: 403, body: { valid: false, error: 'license_invalid' } });
    await license.validateLicense();
    await license.refreshLicenseInBackground();
    assert.equal(license.getPlan(), 'lifetime');
    assert.notEqual(settings.get('license.v2.token'), '');
  });

  it('scope lifetime leaves subscriptions alone; scope all lets them run until their paid end', async () => {
    seedState(signEd(appClaims({ plan: 'pro-monthly', lat: now() + 20 * DAY })));
    await eol.importText(eolFile({ scope: 'lifetime' }), 'upload');
    assert.equal((await license.validateLicense()).plan, 'community', 'normal grace for a subscription');

    await eol.importText(eolFile({ scope: 'all' }), 'upload');
    const info = await license.validateLicense();
    assert.equal(info.plan, 'pro-monthly');
    assert.equal(info.verification, 'eol');

    // its paid end passed → over
    license._resetV2ForTest();
    seedState(signEd(appClaims({ plan: 'pro-monthly', lat: now() - 60 })));
    await eol.importText(eolFile({ scope: 'all' }), 'upload');
    assert.equal((await license.validateLicense()).plan, 'community');
  });

  it('plugins: lifetime ones stay valid, a subscription plugin keeps its normal rules', async () => {
    const plugins = [
      { slug: 'gatecontrol-midea', name: 'Klima', source: 'lifetime', valid: true, token: signEd(pluginClaims()) },
      { slug: 'gatecontrol-skoda', name: 'Fahrzeuge', source: 'license', key_masked: 'GCSK-****', valid: true,
        token: signEd(pluginClaims({ sub: 'lic:7', lat: now() + 30 * DAY })) },
      { slug: 'gatecontrol-old', name: 'Alt', source: 'license', valid: true, token: signEd(pluginClaims({ sub: 'lic:8', lat: now() - DAY })) },
    ];
    seedState(signEd(appClaims()), { plugins });
    await eol.importText(eolFile({ scope: 'lifetime' }), 'upload');
    await license.validateLicense();
    const by = Object.fromEntries(license.getPluginEntitlements().map((e) => [e.slug, e]));
    assert.equal(by['gatecontrol-midea'].valid, true);
    assert.equal(by['gatecontrol-skoda'].valid, false, 'subscription beyond the 14-day grace');
    assert.equal(by['gatecontrol-old'].error, 'expired');

    await eol.importText(eolFile({ scope: 'all' }), 'upload');
    await license.validateLicense();
    const by2 = Object.fromEntries(license.getPluginEntitlements().map((e) => [e.slug, e]));
    assert.equal(by2['gatecontrol-skoda'].valid, true, 'until its paid end');
    assert.equal(by2['gatecontrol-old'].valid, false);
    // the plugin licence state says valid, not "unreachable"
    const licensing = require('../src/services/plugins/licensing');
    const st = licensing.status({ id: 'gatecontrol-midea', signature: 'trusted', manifest: { license: { required: true } } });
    assert.equal(st.state, 'valid');
    assert.equal(st.licensed, true);
  });

  it('a stored file is verified again at every start (tampering is noticed)', async () => {
    await eol.importText(eolFile(), 'upload');
    const rec = JSON.parse(settings.get('license.eol'));
    const parts = rec.token.split('.');
    parts[1] = b64(eolClaims({ scope: 'all' }));
    settings.set('license.eol', JSON.stringify({ ...rec, token: parts.join('.') }));
    assert.equal(await eol.load(), null);
    assert.equal(eol.isActive(), false);
  });

  it('the file at GC_LICENSE_EOL_FILE is read at start and cannot be removed in the UI', async () => {
    const file = path.join(tmpDir, 'eol.json');
    fs.writeFileSync(file, eolFile({ scope: 'all' }));
    config.license.eolFile = file;
    seedState(signEd(appClaims()));
    const info = await license.validateLicense();
    assert.equal(info.verification, 'eol');
    assert.equal(info.eol.source, 'file');
    await eol.remove();
    assert.equal(eol.state().source, 'file');
    fs.writeFileSync(file, eolFile({}, KEY_OTHER, { kid: 'key-a' }));
    assert.equal(await eol.load(), null, 'a forged file there is rejected');
  });

  it('removing the import ends it', async () => {
    seedState(signEd(appClaims()));
    await eol.importText(eolFile(), 'upload');
    assert.equal((await license.validateLicense()).plan, 'lifetime');
    await eol.remove();
    assert.equal((await license.validateLicense()).plan, 'community');
    assert.equal(license.getLicenseInfo().eol, null);
  });
});

describe('EOL fetch', () => {
  it('404 → nothing; a published file is taken over; throttled; only with a licence key', async () => {
    config.license.eolUrl = `${EOL_URL},${EOL_URL2}`;
    assert.equal(await eol.maybeFetch(), false);
    assert.deepEqual(server.calls, ['eol', 'eol2']);
    assert.equal(await eol.maybeFetch(), false);
    assert.equal(count('eol'), 1, 'throttled');

    server.eol2 = () => ({ status: 200, body: eolFile() });
    assert.equal(await eol.maybeFetch({ force: true }), true);
    assert.equal(eol.state().source, 'fetch');
    assert.equal(await eol.maybeFetch({ force: true }), false, 'nothing more to fetch once in force');

    eol._resetForTest();
    server.calls = [];
    config.license.key = '';
    assert.equal(await eol.maybeFetch({ force: true }), false);
    assert.equal(server.calls.length, 0, 'no request without a licence key');
  });

  it('a forged or oversized published file is ignored', async () => {
    config.license.eolUrl = EOL_URL;
    server.eol = () => ({ status: 200, body: eolFile({}, KEY_OTHER, { kid: 'key-a' }) });
    assert.equal(await eol.maybeFetch({ force: true }), false);
    server.eol = () => ({ status: 200, body: 'x'.repeat(eol.MAX_FILE_BYTES + 10) });
    assert.equal(await eol.maybeFetch({ force: true }), false);
    server.eol = () => 'network';
    assert.equal(await eol.maybeFetch({ force: true }), false);
    assert.equal(eol.isActive(), false);
    assert.equal(settings.get('license.eol'), '');
  });

  it('only https URLs are asked', async () => {
    config.license.eolUrl = 'http://lic.test/api/v2/licenses/eol';
    assert.equal(await eol.maybeFetch({ force: true }), false);
    assert.equal(server.calls.length, 0);
  });

  it('a file published while the licence is offline puts the licence back in force', async () => {
    config.license.eolUrl = EOL_URL;
    seedState(signEd(appClaims()));
    server.eol = () => ({ status: 200, body: eolFile() });
    await license.validateLicense();   // community (grace over), the fetch runs in the background
    for (let i = 0; i < 20 && license.getPlan() !== 'lifetime'; i++) await flush();
    assert.equal(license.getPlan(), 'lifetime');
    assert.equal(license.getLicenseInfo().verification, 'eol');
  });
});
