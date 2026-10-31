'use strict';

// Licence checks after a failure: a check that failed because the licence
// server could not be reached (network, timeout, 5xx, 429) is retried after
// 5 min, 15 min, 1 h, then hourly — back to daily after a success. A 4xx is
// the server's answer and waits for the daily check. The last check is
// visible as `lastCheck` (API, settings card, plugin licence). Fake timers;
// the licence server is mocked at the fetch level.

const crypto = require('node:crypto');
const { describe, it, before, beforeEach, afterEach, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown, getAgent } = require('./helpers/setup');
const { withoutScripts } = require('./helpers/html');

const config = require('../config/default');
const logger = require('../src/utils/logger');
const license = require('../src/services/license');
const v2 = require('../src/services/licenseV2');
const { backoffDelay, parseRetryAfter, networkReason } = require('../src/utils/checkBackoff');

const V2_URL = 'https://lic.test/api/v2/licenses';
const JWKS_URL = 'https://lic.test/api/licenses/keys';
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const JWK = { kty: 'OKP', crv: 'Ed25519', kid: 'key-a', use: 'sig', alg: 'EdDSA', x: publicKey.export({ format: 'jwk' }).x };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function signEd(payload) {
  const h = b64({ typ: 'JWT', alg: 'EdDSA', kid: 'key-a' });
  const p = b64(payload);
  return `${h}.${p}.${crypto.sign(null, Buffer.from(h + '.' + p), privateKey).toString('base64url')}`;
}
let FP;
const nowSec = () => Math.floor(Date.now() / 1000);
const appToken = () => signEd({
  iss: 'callmetechie.de', sub: 'lic:1', pid: 1, kind: 'app', plan: 'pro-monthly', features: { webhooks: true },
  fp: FP, iat: nowSec(), exp: nowSec() + 7 * 86400, lat: nowSec() + 30 * 86400, upd: 0,
});
const okBody = () => ({
  valid: true, token: appToken(), plugins: [],
  license: { product: 'gatecontrol', plan: 'pro-monthly', features: {}, max_activations: 2, active_activations: 1 },
});

// ── fetch mock: server.v2() → { status, body, headers } | 'network' | Error ──
const server = { v2: () => ({ status: 200, body: okBody() }), calls: 0 };
const realFetch = global.fetch;
global.fetch = async (url) => {
  const u = String(url);
  if (u === JWKS_URL) return new Response(JSON.stringify({ keys: [JWK] }), { status: 200 });
  if (u !== V2_URL + '/validate') return new Response('{}', { status: 404 });
  server.calls += 1;
  const r = server.v2();
  if (r instanceof Error) throw r;
  if (r === 'network') throw new TypeError('fetch failed');
  return new Response(JSON.stringify(r.body || {}), { status: r.status, headers: { 'Content-Type': 'application/json', ...(r.headers || {}) } });
};

// the refresh behind a timer is async — let it settle (setImmediate is not faked)
async function flush() { for (let i = 0; i < 60; i++) await new Promise((r) => setImmediate(r)); }
async function tick(ms) { mock.timers.tick(ms); await flush(); }
const next = () => Date.parse(license.getLicenseInfo().nextCheckAt) - Date.now();

let agent;
before(async () => {
  ({ agent } = await setup());
  FP = license._getHardwareFingerprint();
  config.license.serverV2 = V2_URL;
  config.license.jwksUrl = JWKS_URL;
  config.license.pubkeys = '';
});
after(() => { global.fetch = realFetch; license.stopLicenseRefresh(); license._applyLicenseForTest(null); config.license.key = ''; teardown(); });

/** An install with a verified v2 licence and the daily refresh running. */
async function licensedInstall() {
  license._resetV2ForTest();
  config.license.key = 'GATE-AAAA-BBBB-CCCC';
  server.v2 = () => ({ status: 200, body: okBody() });
  await license.validateLicense();
  assert.equal(license.getLicenseInfo().verification, 'signed');
  license.startLicenseRefresh();
  server.calls = 0;
}

describe('backoff plan (utils/checkBackoff)', () => {
  it('5 min, 15 min, 1 h, then hourly; Retry-After only lengthens the wait', () => {
    assert.deepEqual([1, 2, 3, 4, 9].map((n) => backoffDelay(n)), [5 * MIN, 15 * MIN, HOUR, HOUR, HOUR]);
    assert.equal(backoffDelay(1, 2 * HOUR), 2 * HOUR);
    assert.equal(backoffDelay(1, 10 * 1000), 5 * MIN);
    assert.equal(backoffDelay(1, 30 * DAY), DAY, 'capped at a day');
  });
  it('Retry-After as seconds or HTTP date; short network reasons', () => {
    assert.equal(parseRetryAfter('120'), 120000);
    assert.equal(parseRetryAfter(new Date(1_000_000 + 90000).toUTCString(), 1_000_000), 90000);
    assert.equal(parseRetryAfter('soon'), null);
    assert.equal(parseRetryAfter(null), null);
    assert.equal(networkReason(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } })), 'ENOTFOUND');
    assert.equal(networkReason(Object.assign(new Error('x'), { name: 'TimeoutError' })), 'timeout');
    assert.equal(networkReason(Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } })), 'timeout');
    assert.equal(networkReason(new TypeError('fetch failed https://lic.test/?key=GATE-AAAA')), 'network error');
  });
});

describe('GateControl licence: retry after a failed check', () => {
  let warn, info;
  beforeEach(async () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
    await licensedInstall();
    warn = mock.method(logger, 'warn', () => {});
    info = mock.method(logger, 'info', () => {});
  });
  afterEach(() => { license.stopLicenseRefresh(); mock.restoreAll(); mock.timers.reset(); });

  it('retries 5 min, 15 min, 1 h, then hourly — and returns to the daily rhythm after a success', async () => {
    assert.equal(next(), DAY, 'daily while all is well');
    server.v2 = () => ({ status: 500, body: { error: 'boom' } });
    await tick(DAY);
    assert.equal(server.calls, 1);
    let li = license.getLicenseInfo();
    assert.equal(li.verification, 'signed_offline');
    assert.deepEqual({ ok: li.lastCheck.ok, reason: li.lastCheck.reason }, { ok: false, reason: 'HTTP 500' });
    assert.equal(next(), 5 * MIN);

    await tick(5 * MIN - 1);
    assert.equal(server.calls, 1, 'not before 5 min');
    await tick(1);
    assert.equal(server.calls, 2);
    assert.equal(next(), 15 * MIN);
    await tick(15 * MIN);
    assert.equal(server.calls, 3);
    assert.equal(next(), HOUR);
    await tick(HOUR);
    assert.equal(server.calls, 4);
    assert.equal(next(), HOUR, 'hourly from now on');
    await tick(HOUR);
    assert.equal(server.calls, 5);

    const unreachable = warn.mock.calls.filter((c) => /unreachable/.test(String(c.arguments[0])));
    assert.equal(unreachable.length, 1, 'one warning per outage, not per retry');

    server.v2 = () => ({ status: 200, body: okBody() });
    await tick(HOUR);
    assert.equal(server.calls, 6);
    li = license.getLicenseInfo();
    assert.equal(li.verification, 'signed');
    assert.equal(li.lastCheck.ok, true);
    assert.equal(li.lastCheck.reason, null);
    assert.equal(next(), DAY, 'back to daily');
    const again = info.mock.calls.filter((c) => /reachable again/.test(String(c.arguments[0])));
    assert.equal(again.length, 1);
    await tick(DAY - 1);
    assert.equal(server.calls, 6, 'no retry after the success');
  });

  it('a network error names its code and is retried', async () => {
    server.v2 = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
    await license.refreshLicenseInBackground();
    assert.equal(license.getLicenseInfo().lastCheck.reason, 'ENOTFOUND');
    assert.equal(next(), 5 * MIN);
  });

  it('429 honours Retry-After (longer than the backoff), a short one keeps the backoff', async () => {
    server.v2 = () => ({ status: 429, body: {}, headers: { 'Retry-After': '7200' } });
    await tick(DAY);
    assert.equal(license.getLicenseInfo().lastCheck.reason, 'HTTP 429');
    assert.equal(next(), 2 * HOUR);
    await tick(HOUR);
    assert.equal(server.calls, 1, 'waits as asked');
    server.v2 = () => ({ status: 429, body: {}, headers: { 'Retry-After': '30' } });
    await tick(HOUR);
    assert.equal(server.calls, 2);
    assert.equal(next(), 15 * MIN, 'second retry: 15 min, Retry-After 30 s is shorter');
  });

  it('a 4xx answer is not retried early', async () => {
    server.v2 = () => ({ status: 400, body: { error: 'bad_request' } });
    await tick(DAY);
    assert.equal(server.calls, 1);
    assert.deepEqual([license.getLicenseInfo().lastCheck.ok, license.getLicenseInfo().lastCheck.reason], [false, 'HTTP 400']);
    assert.equal(next(), DAY);
    await tick(DAY - 1);
    assert.equal(server.calls, 1);
  });

  it('a rejection (403 license_invalid) is final: community, no early retry', async () => {
    server.v2 = () => ({ status: 403, body: { error: 'license_invalid', message: 'revoked' } });
    await tick(DAY);
    assert.equal(license.getPlan(), 'community');
    assert.equal(license.getLicenseInfo().lastCheck.reason, 'HTTP 403');
    assert.equal(next(), DAY);
  });

  it('a manual refresh shares the one timer: success → daily from now, failure continues the backoff', async () => {
    server.v2 = () => ({ status: 503, body: {} });
    await license.refreshLicenseInBackground();
    assert.equal(next(), 5 * MIN);
    await license.refreshLicenseInBackground(); // e.g. "Lizenz aktualisieren" meanwhile
    assert.equal(next(), 15 * MIN);
    server.v2 = () => ({ status: 200, body: okBody() });
    await license.refreshLicenseInBackground();
    assert.equal(next(), DAY);
    server.calls = 0;
    await tick(DAY);
    assert.equal(server.calls, 1, 'exactly one scheduled check, no leftover retry timer');
  });

  it('a failed check before startLicenseRefresh (boot) is retried once the refresh starts', async () => {
    license.stopLicenseRefresh();
    server.v2 = () => 'network';
    await license.refreshLicenseInBackground();
    assert.equal(license.getLicenseInfo().nextCheckAt, null, 'nothing scheduled while stopped');
    license.startLicenseRefresh();
    assert.equal(next(), 5 * MIN);
    license.startLicenseRefresh();
    await tick(5 * MIN);
    assert.equal(server.calls, 2, 'started twice, still one timer');
  });
});

describe('lastCheck in the API and the settings card', () => {
  before(async () => { await licensedInstall(); });
  afterEach(() => { mock.restoreAll(); });
  after(() => license.stopLicenseRefresh());

  it('GET /api/v1/license carries lastCheck { at, ok, reason } and nextCheckAt — without key or body', async () => {
    mock.method(logger, 'warn', () => {});
    server.v2 = () => ({ status: 502, body: { error: 'secret upstream detail GATE-AAAA-BBBB-CCCC' } });
    await license.refreshLicenseInBackground();
    const r = await agent.get('/api/v1/license').expect(200);
    assert.equal(r.body.verification, 'signed_offline');
    assert.deepEqual(Object.keys(r.body.lastCheck).sort(), ['at', 'ok', 'reason']);
    assert.equal(r.body.lastCheck.ok, false);
    assert.equal(r.body.lastCheck.reason, 'HTTP 502');
    assert.ok(Number.isFinite(Date.parse(r.body.lastCheck.at)));
    assert.ok(Date.parse(r.body.nextCheckAt) - Date.now() > 4 * MIN && Date.parse(r.body.nextCheckAt) - Date.now() <= 5 * MIN);
    assert.doesNotMatch(JSON.stringify(r.body.lastCheck), /secret|GATE-/);
  });

  it('the licence card names the failed check and the next attempt (offline grace)', async () => {
    const html = withoutScripts((await agent.get('/settings').expect(200)).text);
    const m = html.match(/<div class="st-plan-meta st-lic-lastcheck"[^>]*>([^<]*)<\/div>/);
    assert.ok(m, 'last-check line present');
    assert.match(m[0], /data-reason="HTTP 502"/);
    assert.match(m[1], /HTTP 502/);
    assert.ok(/Letzte Prüfung fehlgeschlagen/.test(m[1]) || /Last check failed/.test(m[1]), m[1]);
    assert.ok(/Nächster Versuch/.test(m[1]) || /Next attempt/.test(m[1]), m[1]);
  });

  it('after a successful check the line is gone', async () => {
    server.v2 = () => ({ status: 200, body: okBody() });
    await license.refreshLicenseInBackground();
    const r = await agent.get('/api/v1/license').expect(200);
    assert.deepEqual([r.body.lastCheck.ok, r.body.lastCheck.reason], [true, null]);
    const html = withoutScripts((await agent.get('/settings').expect(200)).text);
    assert.doesNotMatch(html, /id="st-lic-lastcheck"/);
  });

  it('a first-party plugin in "unreachable" carries the same reason', async () => {
    const licensing = require('../src/services/plugins/licensing');
    server.v2 = () => ({ status: 500, body: {} });
    mock.method(logger, 'warn', () => {});
    await license.refreshLicenseInBackground();
    license._setPluginEntitlementsForTest([{ slug: 'fp-x', name: 'x', source: 'license', key_masked: null, valid: true, error: null, expires_at: null, updates_until: null }]);
    const st = licensing.status({ id: 'fp-x', signature: 'trusted', manifest: { license: { required: true } } });
    assert.equal(st.state, 'unreachable');
    assert.equal(st.lastCheck.reason, 'HTTP 500');
    assert.ok(st.nextCheckAt);
    license._setPluginEntitlementsForTest([]);
  });
});

describe('third-party plugin licence: retry after a failed check', () => {
  const licensing = require('../src/services/plugins/licensing');
  const registry = require('../src/services/plugins/registry');
  const plugin = { id: 'tp-retry', signature: 'unsigned', manifest: { license: { required: true, server: 'https://lic.vendor.example/check' } } };
  let answer;
  let calls = 0;
  before(() => {
    licensing._setTransportForTest(async () => {
      calls += 1;
      if (answer instanceof Error) throw answer;
      return answer;
    });
  });
  beforeEach(() => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
    mock.method(logger, 'warn', () => {});
    mock.method(logger, 'info', () => {});
    mock.method(registry, 'get', (id) => (id === plugin.id ? plugin : null));
    const { encrypt } = require('../src/utils/crypto');
    registry.setLicense(plugin.id, { keyEncrypted: encrypt('VEND-1234-ABCD'), state: { valid: true, expires_at: null, checked_at: new Date().toISOString(), last_ok_at: new Date().toISOString(), error: null } });
    licensing.startRetries();
    calls = 0;
  });
  afterEach(() => { licensing.stopRetries(); mock.restoreAll(); mock.timers.reset(); });
  after(() => { licensing._setTransportForTest(null); registry.removeLicense(plugin.id); });

  it('5xx: unreachable with reason, retried 5 min / 15 min / 1 h, then valid again', async () => {
    answer = { status: 503, json: null, headers: {} };
    let st = await licensing.checkThirdParty(plugin);
    assert.equal(st.state, 'unreachable');
    assert.equal(st.lastCheck.reason, 'HTTP 503');
    assert.equal(Date.parse(st.nextCheckAt) - Date.now(), 5 * MIN);
    await tick(5 * MIN);
    assert.equal(calls, 2);
    st = licensing.status(plugin);
    assert.equal(Date.parse(st.nextCheckAt) - Date.now(), 15 * MIN);
    await tick(15 * MIN);
    assert.equal(calls, 3);
    assert.equal(Date.parse(licensing.status(plugin).nextCheckAt) - Date.now(), HOUR);
    assert.equal(logger.warn.mock.calls.length, 1, 'one warning per outage');
    answer = { status: 200, json: { valid: true, expires_at: null } };
    await tick(HOUR);
    assert.equal(calls, 4);
    st = licensing.status(plugin);
    assert.equal(st.state, 'valid');
    assert.equal(st.lastCheck, undefined);
    assert.equal(logger.info.mock.calls.filter((c) => /reachable again/.test(String(c.arguments[1]))).length, 1);
    await tick(DAY);
    assert.equal(calls, 4, 'no further retry');
  });

  it('a network error is retried; 429 waits for Retry-After', async () => {
    answer = Object.assign(new Error('getaddrinfo ENOTFOUND lic.vendor.example'), { code: 'ENOTFOUND' });
    let st = await licensing.checkThirdParty(plugin);
    assert.equal(st.lastCheck.reason, 'ENOTFOUND');
    answer = { status: 429, json: null, headers: { 'retry-after': '10800' } };
    st = await licensing.checkThirdParty(plugin); // the daily check meanwhile: replaces the pending retry
    assert.equal(st.lastCheck.reason, 'HTTP 429');
    assert.equal(Date.parse(st.nextCheckAt) - Date.now(), 3 * HOUR);
    calls = 0;
    await tick(3 * HOUR - 1);
    assert.equal(calls, 0);
    await tick(1);
    assert.equal(calls, 1, 'one timer only');
  });

  it('a 4xx without a licence answer is not retried early', async () => {
    answer = { status: 401, json: null, headers: {} };
    const st = await licensing.checkThirdParty(plugin);
    assert.equal(st.state, 'unreachable');
    assert.equal(st.lastCheck.reason, 'HTTP 401');
    assert.equal(st.nextCheckAt, null);
    await tick(DAY);
    assert.equal(calls, 1);
  });
});
