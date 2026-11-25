'use strict';

// Licence fallback without damage (docs/feature-license-eol.md §1): when a
// licence key falls back to Community — licence server unreachable beyond the
// 14-day grace, or the licence revoked / expired — the NEWEST peers and routes
// over the limit are switched off (never deleted) and marked; a valid licence
// switches them back on by itself. Before the fallback the dashboard warns
// with the days left. A token for an older main version (`maj`) says
// "Upgrade nötig" instead of locking silently.

require('./helpers/test-env');

const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { runMigrations } = require('../src/db/migrations');
const { getDb } = require('../src/db/connection');
const config = require('../config/default');
const settings = require('../src/services/settings');
const license = require('../src/services/license');
const v2 = require('../src/services/licenseV2');

const V2_URL = 'https://lic.test/api/v2/licenses';
const JWKS_URL = 'https://lic.test/api/licenses/keys';
const DAY = 86400;

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const JWK = { kty: 'OKP', crv: 'Ed25519', kid: 'key-a', use: 'sig', alg: 'EdDSA', x: publicKey.export({ format: 'jwk' }).x };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function signEd(payload) {
  const h = b64({ typ: 'JWT', alg: 'EdDSA', kid: 'key-a' });
  const p = b64(payload);
  return `${h}.${p}.${crypto.sign(null, Buffer.from(h + '.' + p), privateKey).toString('base64url')}`;
}
const now = () => Math.floor(Date.now() / 1000);
let FP;

function appClaims(over = {}) {
  return {
    iss: 'callmetechie.de', sub: 'lic:1', pid: 1, kind: 'app', plan: 'pro-monthly',
    features: { vpn_peers: -1, http_routes: -1, l4_routes: -1 },
    fp: FP, iat: now(), exp: now() + 7 * DAY, lat: now() + 30 * DAY, upd: 0, ...over,
  };
}
function okResponse(token = signEd(appClaims())) {
  return {
    status: 200,
    body: { valid: true, license: { plan: 'pro-monthly', features: {}, max_activations: 2, active_activations: 1 }, token, plugins: [] },
  };
}

const server = { v2: () => okResponse() };
const realFetch = global.fetch;
global.fetch = async (url) => {
  const u = String(url);
  let r;
  if (u === V2_URL + '/validate') r = server.v2();
  else if (u === JWKS_URL) r = { status: 200, body: { keys: [JWK] } };
  else return new Response('{}', { status: 404 });
  if (r === 'network') throw new TypeError('fetch failed');
  return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'Content-Type': 'application/json' } });
};

async function flush() { for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r)); }

function seedState(token, lastOkAgoMs = 0) {
  v2.saveState(config.license.key, { token, plugins: [], now: Date.now() - lastOkAgoMs, activations: 1, max_activations: 2 });
  v2.markActive();
}

let seq = 0;
function addPeer(name, ageDays) {
  seq += 1;
  getDb().prepare(`INSERT INTO peers (name, public_key, allowed_ips, enabled, created_at) VALUES (?, ?, ?, 1, datetime('now', ?))`)
    .run(name, 'pk' + seq + crypto.randomBytes(8).toString('hex'), `10.8.0.${seq + 1}/32`, `-${ageDays} days`);
}
function addRoute(domain, ageDays) {
  getDb().prepare(`INSERT INTO routes (domain, target_ip, target_port, route_type, enabled, created_at) VALUES (?, '10.0.0.1', 80, 'http', 1, datetime('now', ?))`)
    .run(domain, `-${ageDays} days`);
}
const peerRows = () => getDb().prepare('SELECT name, enabled, license_disabled FROM peers ORDER BY name').all().map((r) => ({ ...r }));
const routeRows = () => getDb().prepare('SELECT domain, enabled, license_disabled FROM routes ORDER BY domain').all().map((r) => ({ ...r }));

before(() => {
  runMigrations();
  FP = license._getHardwareFingerprint();
  config.license.serverV2 = V2_URL;
  config.license.jwksUrl = JWKS_URL;
  config.license.eolUrl = '';
  config.license.eolFile = '';
});

after(() => { global.fetch = realFetch; license.stopLicenseRefresh(); });

beforeEach(() => {
  license._resetV2ForTest();
  license._applyLicenseForTest(null);
  config.license.key = 'GATE-AAAA-BBBB-CCCC';
  config.license.signingKey = '';
  config.license.pubkeys = '';
  server.v2 = () => okResponse();
  const db = getDb();
  db.prepare('DELETE FROM peers').run();
  db.prepare('DELETE FROM routes').run();
  seq = 0;
  // Community: 3 peers, 1 HTTP route — four peers and two routes are one / one over it
  addPeer('p1-oldest', 40);
  addPeer('p2', 30);
  addPeer('p3', 20);
  addPeer('p4-newest', 10);
  addRoute('a-old.example.test', 30);
  addRoute('b-new.example.test', 5);
});

describe('fallback switches off the newest, keeps everything, and restores', () => {
  it('a revoked licence (403): newest peer / route off and marked, nothing deleted', async () => {
    await applyPro();
    server.v2 = () => ({ status: 403, body: { valid: false, error: 'license_invalid', message: 'revoked' } });
    await license.refreshLicenseInBackground();
    await flush();
    assert.equal(license.getPlan(), 'community');
    assert.equal(license.getLicenseInfo().fallback_reason, 'revoked');
    assert.deepEqual(peerRows(), [
      { name: 'p1-oldest', enabled: 1, license_disabled: 0 },
      { name: 'p2', enabled: 1, license_disabled: 0 },
      { name: 'p3', enabled: 1, license_disabled: 0 },
      { name: 'p4-newest', enabled: 0, license_disabled: 1 },
    ]);
    assert.deepEqual(routeRows(), [
      { domain: 'a-old.example.test', enabled: 1, license_disabled: 0 },
      { domain: 'b-new.example.test', enabled: 0, license_disabled: 1 },
    ]);
    assert.deepEqual(license.licenseDisabledCounts(), { peers: 1, routes: 1, pools: 0 });

    // a new licence: everything comes back on by itself, the marks are gone
    server.v2 = () => okResponse();
    await license.validateLicense();
    await flush();
    assert.equal(license.getPlan(), 'pro-monthly');
    assert.equal(license.getLicenseInfo().fallback_reason, null);
    assert.ok(peerRows().every((r) => r.enabled === 1 && r.license_disabled === 0), JSON.stringify(peerRows()));
    assert.ok(routeRows().every((r) => r.enabled === 1 && r.license_disabled === 0), JSON.stringify(routeRows()));
  });

  it('licence server unreachable: warning with the days left, then the soft fallback, then the restore', async () => {
    // 10 days since the last success, token exp passed → 4 days of grace left
    seedState(signEd(appClaims({ exp: now() - 60 })), 10 * DAY * 1000);
    server.v2 = () => 'network';
    const info = await license.validateLicense();
    assert.equal(info.verification, 'signed_offline');
    assert.equal(info.offline.days_left, 4);
    assert.ok(Date.parse(info.offline.fallback_at) > Date.now());
    assert.ok(peerRows().every((r) => r.enabled === 1), 'nothing switched off during the grace');

    const problems = await require('../src/services/dashboardProblems').list({ access: null });
    const off = problems.problems.find((p) => p.kind === 'license_offline');
    assert.ok(off, JSON.stringify(problems.problems));
    assert.equal(off.severity, 'warning');
    assert.equal(off.license.days_left, 4);
    assert.equal(off.href, '/settings/lizenz');

    // beyond the grace: Community, the newest over the limit are only switched off
    setLastOk(15 * DAY * 1000);
    await license.refreshLicenseInBackground();
    await flush();
    assert.equal(license.getPlan(), 'community');
    assert.equal(license.getLicenseInfo().fallback_reason, 'offline');
    assert.deepEqual(peerRows().filter((r) => !r.enabled).map((r) => r.name), ['p4-newest']);
    const after = await require('../src/services/dashboardProblems').list({ access: null });
    const fb = after.problems.find((p) => p.kind === 'license_fallback');
    assert.ok(fb, JSON.stringify(after.problems));
    assert.equal(fb.severity, 'error');
    assert.deepEqual(fb.license, { reason: 'offline', peers: 1, routes: 1, pools: 0 });

    // the licence server answers again
    server.v2 = () => okResponse();
    await license.refreshLicenseInBackground();
    await flush();
    assert.equal(license.getPlan(), 'pro-monthly');
    assert.ok(peerRows().every((r) => r.enabled === 1 && r.license_disabled === 0), JSON.stringify(peerRows()));
    const clean = await require('../src/services/dashboardProblems').list({ access: null });
    assert.equal(clean.problems.filter((p) => String(p.kind).startsWith('license_')).length, 0);
  });

  it('3 days or less left: the warning is an error', async () => {
    seedState(signEd(appClaims({ exp: now() - 60 })), 12 * DAY * 1000);
    server.v2 = () => 'network';
    await license.validateLicense();
    const problems = await require('../src/services/dashboardProblems').list({ access: null });
    const off = problems.problems.find((p) => p.kind === 'license_offline');
    assert.equal(off.license.days_left, 2);
    assert.equal(off.severity, 'error');
  });

  it('restore stops at the limit and brings the oldest back first', async () => {
    await applyPro();
    server.v2 = () => ({ status: 403, body: { valid: false, error: 'license_invalid' } });
    // two more peers → three newest off
    addPeer('p5', 5);
    addPeer('p6', 1);
    await license.refreshLicenseInBackground();
    await flush();
    assert.deepEqual(peerRows().filter((r) => !r.enabled).map((r) => r.name), ['p4-newest', 'p5', 'p6']);
    // a licence with 5 peers: the two oldest of them come back
    server.v2 = () => okResponse(signEd(appClaims({ features: { vpn_peers: 5, http_routes: -1, l4_routes: 0 } })));
    await license.validateLicense();
    await flush();
    assert.deepEqual(peerRows().filter((r) => !r.enabled).map((r) => r.name), ['p6']);
    assert.equal(peerRows().find((r) => r.name === 'p6').license_disabled, 1, 'still waiting');
  });

  it('switching one on by hand clears its mark — turned off again, it stays off', async () => {
    await applyPro();
    server.v2 = () => ({ status: 403, body: { valid: false, error: 'license_invalid' } });
    await license.refreshLicenseInBackground();
    await flush();
    const db = getDb();
    db.prepare("UPDATE peers SET enabled = 0 WHERE name = 'p1-oldest'").run();      // admin turns one off …
    db.prepare("UPDATE peers SET enabled = 1 WHERE name = 'p4-newest'").run();      // … and the marked one on
    assert.equal(peerRows().find((r) => r.name === 'p4-newest').license_disabled, 0, 'trigger cleared the mark');
    db.prepare("UPDATE peers SET enabled = 0 WHERE name = 'p4-newest'").run();      // later off again by hand
    server.v2 = () => okResponse();
    await license.validateLicense();
    await flush();
    const rows = peerRows();
    assert.equal(rows.find((r) => r.name === 'p4-newest').enabled, 0, 'turned off by hand — not the licence\'s');
    assert.equal(rows.find((r) => r.name === 'p1-oldest').enabled, 0);
  });

  it('removing the licence switches off softly; activating one restores', async () => {
    seedState(signEd(appClaims()));
    await license.validateLicense();
    await license.removeLicense();
    assert.equal(peerRows().filter((r) => r.license_disabled === 1).length, 1);
    assert.equal(getDb().prepare('SELECT COUNT(*) AS c FROM peers').get().c, 4, 'nothing deleted');
    const problems = await require('../src/services/dashboardProblems').list({ access: null });
    const fb = problems.problems.find((p) => p.kind === 'license_fallback');
    assert.equal(fb.severity, 'warning');
    assert.equal(fb.license.reason, null);
    config.license.key = 'GATE-AAAA-BBBB-CCCC';
    await license.validateLicense();
    assert.ok(peerRows().every((r) => r.enabled === 1));
  });
});

describe('main version claim (maj)', () => {
  it('a token without maj counts for every version', async () => {
    server.v2 = () => okResponse(signEd(appClaims()));
    const info = await license.validateLicense();
    assert.equal(info.plan, 'pro-monthly');
    assert.equal(info.upgrade_required, null);
  });

  it('maj equal to (or above) the installed main version applies', async () => {
    server.v2 = () => okResponse(signEd(appClaims({ maj: license.OWN_MAJOR })));
    assert.equal((await license.validateLicense()).plan, 'pro-monthly');
    license._resetV2ForTest();
    server.v2 = () => okResponse(signEd(appClaims({ maj: license.OWN_MAJOR + 1 })));
    assert.equal((await license.validateLicense()).plan, 'pro-monthly');
  });

  it('a token for an older main version: "Upgrade nötig", Community, soft fallback, token kept', async () => {
    license._setOwnMajorForTest(2); // this build is 2.x, the token is for 1.x
    try {
      server.v2 = () => okResponse(signEd(appClaims({ maj: 1 })));
      const info = await license.validateLicense();
      assert.equal(info.plan, 'community');
      assert.deepEqual(info.upgrade_required, { licensed: 1, installed: 2 });
      assert.equal(info.fallback_reason, 'upgrade');
      assert.notEqual(settings.get('license.v2.token'), '', 'the token is kept for the upgrade');
      assert.deepEqual(peerRows().filter((r) => !r.enabled).map((r) => r.name), ['p4-newest'], 'soft fallback');
      const problems = await require('../src/services/dashboardProblems').list({ access: null });
      const up = problems.problems.find((p) => p.kind === 'license_upgrade');
      assert.deepEqual(up.license, { licensed: 1, installed: 2 });
      assert.equal(problems.problems.find((p) => p.kind === 'license_fallback').license.reason, null, 'upgrade has its own row');

      // the upgrade licence (maj 2) applies and restores
      server.v2 = () => okResponse(signEd(appClaims({ maj: 2 })));
      const up2 = await license.validateLicense();
      assert.equal(up2.plan, 'pro-monthly');
      assert.equal(up2.upgrade_required, null);
      assert.ok(peerRows().every((r) => r.enabled === 1));
    } finally {
      license._setOwnMajorForTest(null);
    }
  });

  it('maj 0 or not an integer is ignored', async () => {
    license._setOwnMajorForTest(2);
    try {
      for (const maj of [0, -1, '1', 1.5]) {
        license._resetV2ForTest();
        server.v2 = () => okResponse(signEd(appClaims({ maj })));
        assert.equal((await license.validateLicense()).plan, 'pro-monthly', String(maj));
      }
    } finally {
      license._setOwnMajorForTest(null);
    }
  });
});

/** A licence in force first (as on a running server), then the change under test. */
async function applyPro() {
  seedState(signEd(appClaims()));
  await license.validateLicense();
  await flush();
  assert.equal(license.getPlan(), 'pro-monthly');
}

function setLastOk(msAgo) {
  const rec = JSON.parse(settings.get('license.v2.token'));
  rec.last_ok_at = Date.now() - msAgo;
  settings.set('license.v2.token', JSON.stringify(rec));
}
