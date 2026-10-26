'use strict';

// Drive-Server-Kern 5 (docs/plugins.md "Licences", since 1.206.0):
//   * tier and seats of a first-party licence: gc.license.info() → the most
//     people of each kind (family / business / combo), the licence tab;
//   * gc.license.refresh(): the licence at once after a purchase, at most
//     once a minute, only with a licence key;
//   * plugin.json storage.maxMB: a database up to 4 GB, the admin sees the limit;
//   * the catalog symbol "cloud".

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { helloPackage, HELLO } = require('./helpers/plugins');
const { setup, teardown, getCsrf } = require('./helpers/setup');

let agent, csrf, runtime, plugins, license, licensing, registry, manifest, storage, catalog, config;
const API = '/api/v1/plugins';
const PID = 'hello-drive';
const MB = 1024 * 1024;
const helloManifest = JSON.parse(fs.readFileSync(path.join(HELLO, 'plugin.json'), 'utf8'));

let refreshCalls = 0;
let deliver = null; // entitlements the stubbed licence refresh delivers

async function install(buf) {
  const r = await agent.post(API + '/inspect').set('X-CSRF-Token', csrf).set('Content-Type', 'application/octet-stream').send(buf).expect(200);
  assert.equal(r.body.canInstall, true, JSON.stringify(r.body.checks));
  return (await agent.post(API + '/install').set('X-CSRF-Token', csrf).send({ token: r.body.token, accept: true }).expect(200)).body;
}
const gc = async (fn, ...args) => (await agent.post(`${API}/${PID}/api/gc`).set('X-CSRF-Token', csrf).send({ fn, args })).body;
const ent = (over) => ({ slug: PID, name: 'Drive', source: 'license', key_masked: 'GCDR-••••-••••-0001', valid: true, error: null, expires_at: null, updates_until: null,
  tier: null, seats: null, ...over });

before(async () => {
  ({ agent } = await setup());
  csrf = getCsrf();
  runtime = require('../src/services/plugins/runtime');
  plugins = require('../src/services/plugins');
  license = require('../src/services/license');
  licensing = require('../src/services/plugins/licensing');
  registry = require('../src/services/plugins/registry');
  manifest = require('../src/services/plugins/manifest');
  storage = require('../src/services/plugins/storage');
  catalog = require('../src/services/plugins/catalog');
  config = require('../config/default');
  config.license.key = 'GATE-DRIV-E000-0001';
  license._setPluginEntitlementsForTest([ent({ tier: 'family', seats: { included: 5, family: 2, business: 0 } })]);
  licensing._setRefreshForTest(async () => { refreshCalls++; if (deliver) license._setPluginEntitlementsForTest(deliver); });
  await install(helloPackage({ overrides: { id: PID, license: { required: true }, storage: { maxMB: 1024 } } }));
  assert.equal(await runtime.waitRunning(PID), true);
});
beforeEach(() => {
  refreshCalls = 0;
  deliver = null;
  licensing._setRefreshForTest(async () => { refreshCalls++; if (deliver) license._setPluginEntitlementsForTest(deliver); });
});
after(async () => {
  licensing._setRefreshForTest(null);
  license._setPluginEntitlementsForTest([]);
  config.license.key = '';
  await plugins.stop();
  teardown();
});

describe('gc.license.info: tier and seats', () => {
  it('family: included + booked family people; status() stays as it was', async () => {
    license._setPluginEntitlementsForTest([ent({ tier: 'family', seats: { included: 5, family: 2, business: 0 } })]);
    const r = await gc('license.info');
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(r.result, {
      required: true, valid: true, state: 'valid', expiresAt: null, source: 'license', tier: 'family',
      seats: { total: 7, family: 7, business: 0, included: 5, extra: { family: 2, business: 0 } },
    });
    assert.deepEqual((await gc('license.status')).result, { required: true, licensed: true, state: 'valid', expiresAt: null });
  });

  it('business and combo (the included people are shared)', () => {
    const p = registry.get(PID);
    license._setPluginEntitlementsForTest([ent({ tier: 'business', seats: { included: 5, family: 9, business: 3 } })]);
    assert.deepEqual(licensing.info(p).seats, { total: 8, family: 0, business: 8, included: 5, extra: { family: 0, business: 3 } }, 'family seats do not count for business');
    license._setPluginEntitlementsForTest([ent({ tier: 'combo', seats: { included: 5, family: 2, business: 1 } })]);
    assert.deepEqual(licensing.info(p).seats, { total: 8, family: 7, business: 6, included: 5, extra: { family: 2, business: 1 } });
    assert.equal(licensing.info(p).tier, 'combo');
  });

  it('no tier in the licence (lifetime, plan, older licence server) → tier and seats null', () => {
    const p = registry.get(PID);
    license._setPluginEntitlementsForTest([ent({ source: 'lifetime' })]);
    assert.deepEqual([licensing.info(p).valid, licensing.info(p).tier, licensing.info(p).seats], [true, null, null]);
  });

  it('an invalid licence never names people', () => {
    const p = registry.get(PID);
    license._setPluginEntitlementsForTest([ent({ valid: false, error: 'expired', tier: 'family', seats: { included: 5, family: 0, business: 0 } })]);
    const i = licensing.info(p);
    assert.deepEqual([i.valid, i.state, i.tier, i.seats], [false, 'expired', null, null]);
  });

  it('a plugin that needs no licence: valid, nothing named', () => {
    const p = { id: 'x', signature: 'trusted', manifest: { license: { required: false } } };
    assert.deepEqual(licensing.info(p), { required: false, valid: true, state: 'not_required', expiresAt: null, source: null, tier: null, seats: null });
  });

  it('the licence tab of the administrator gets tier and seats', async () => {
    license._setPluginEntitlementsForTest([ent({ tier: 'combo', seats: { included: 5, family: 2, business: 1 } })]);
    const r = await agent.get(`${API}/${PID}`).expect(200);
    assert.deepEqual([r.body.plugin.license.tier, r.body.plugin.license.seats], ['combo', { included: 5, family: 2, business: 1 }]);
  });
});

describe('gc.license.refresh', () => {
  it('fetches the licence now (new seats), then not again within a minute', async () => {
    license._setPluginEntitlementsForTest([ent({ tier: 'family', seats: { included: 5, family: 0, business: 0 } })]);
    deliver = [ent({ tier: 'family', seats: { included: 5, family: 3, business: 0 } })];
    let r = await gc('license.refresh');
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(refreshCalls, 1);
    assert.equal(r.result.refreshed, true);
    assert.equal(r.result.seats.total, 8);
    r = await gc('license.refresh');
    assert.deepEqual([refreshCalls, r.result.refreshed, r.result.seats.total], [1, false, 8], 'throttled');
    // after the gap it runs again
    const p = registry.get(PID);
    const later = await licensing.refresh(p, { now: Date.now() + licensing.REFRESH_GAP_MS + 1000 });
    assert.deepEqual([refreshCalls, later.refreshed], [2, true]);
  });

  it('without a GateControl licence key nothing is fetched', async () => {
    const key = config.license.key;
    config.license.key = '';
    try {
      const r = await licensing.refresh(registry.get(PID), { now: Date.now() + 10 * licensing.REFRESH_GAP_MS });
      assert.deepEqual([refreshCalls, r.refreshed], [0, false]);
    } finally { config.license.key = key; }
  });

  it('a plugin that needs no licence never triggers a refresh', async () => {
    const r = await licensing.refresh({ id: 'x', signature: 'trusted', manifest: { license: { required: false } } }, { now: Date.now() + 20 * licensing.REFRESH_GAP_MS });
    assert.deepEqual([refreshCalls, r.refreshed, r.valid], [0, false, true]);
  });
});

describe('plugin.json storage.maxMB', () => {
  const check = (storageDecl, perms) => {
    const m = JSON.parse(JSON.stringify(helloManifest));
    m.storage = storageDecl;
    if (perms) Object.assign(m.permissions, perms);
    return manifest.validate(m);
  };

  it('256 … 4096 MB, only with permissions.storage; default 256 MB', () => {
    assert.equal(check({ maxMB: 4096 }).manifest.storage.maxBytes, 4096 * MB);
    assert.equal(check({ maxMB: 256 }).manifest.storage.maxBytes, 256 * MB);
    for (const bad of [{ maxMB: 4097 }, { maxMB: 255 }, { maxMB: 1.5 }, { maxMB: '1024' }, {}, { maxMB: 512, extra: 1 }, [], 'big']) {
      const r = check(bad);
      assert.equal(r.ok, false, JSON.stringify(bad));
      assert.ok(r.errors.some((e) => /^storage/.test(e)), r.errors.join(', '));
    }
    const r = check({ maxMB: 512 }, { storage: false });
    assert.ok(r.errors.includes('storage: needs permissions.storage'), r.errors.join(', '));
    const m = JSON.parse(JSON.stringify(helloManifest));
    assert.equal(manifest.validate(m).manifest.storage.maxBytes, 256 * MB, 'default');
  });

  it('the database of the plugin gets that limit; the admin sees it', async () => {
    assert.equal(storage.maxBytesOf(PID), 1024 * MB);
    assert.equal(storage.forPlugin(PID).maxBytes, 1024 * MB);
    const r = await agent.get(`${API}/${PID}`).expect(200);
    assert.equal(r.body.plugin.storageDbMaxBytes, 1024 * MB);
    // the plugin's own data still works with the new limit
    const kv = await agent.post(`${API}/${PID}/api/kv`).set('X-CSRF-Token', csrf).send({ key: 'k', value: 'v' });
    assert.equal(kv.status, 200);
    assert.equal(storage.maxBytesOf('no-such-plugin'), 256 * MB);
  });

  it('an update with another limit reopens the database with it', async () => {
    license._setPluginEntitlementsForTest([ent({ tier: 'family', seats: { included: 5, family: 0, business: 0 } })]);
    await install(helloPackage({ overrides: { id: PID, version: '9.9.9', license: { required: true }, storage: { maxMB: 2048 } } }));
    assert.equal(await runtime.waitRunning(PID), true);
    assert.equal(storage.forPlugin(PID).maxBytes, 2048 * MB);
    assert.equal(storage.maxBytesOf(PID), 2048 * MB);
    const kv = await agent.get(`${API}/${PID}/api/kv`).query({ key: 'k' }).expect(200);
    assert.equal(kv.body.value, 'v', 'the data stays');
  });
});

describe('catalog symbol "cloud"', () => {
  it('is a known catalog and detail symbol, with a path in the page', () => {
    assert.ok(catalog.ICONS.has('cloud'));
    const PUI = require('../public/js/plugins-ui.js');
    assert.match(PUI.ICON_PATHS.cloud, /^M/);
    assert.match(PUI.DETAIL_ICON_PATHS.cloud, /^M/);
    assert.equal(PUI.iconPath({ icon: 'cloud' }, null), PUI.ICON_PATHS.cloud);
  });
});
