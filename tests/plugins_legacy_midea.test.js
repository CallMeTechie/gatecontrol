'use strict';

// Built-in Klimaanlage → gatecontrol-midea (docs/plugins.md "Übernahme
// eingebauter Daten", src/services/plugins/legacy.js): the mapped
// first-party plugin gets one snapshot of the Midea cloud account
// (password/session decrypted for the hand-over only), midea_devices (LAN
// token/key decrypted) and midea_device_owners; the LAN devices' addresses
// become assignments of the plugin's home target "ac"; while the plugin runs
// the built-in Klimaanlage (sidebar, page, API, portal, polling) is off.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { helloPackage, HELLO } = require('./helpers/plugins');
const { setup, teardown, getCsrf } = require('./helpers/setup');

let agent, csrf, runtime, plugins, legacy, db, adminId;
const API = '/api/v1/plugins';
const ID = 'gatecontrol-midea';
const PASSWORD = 'midea-cloud-pw-91c2';
const TOKEN = 'ab'.repeat(64);
const KEY = 'cd'.repeat(32);
const SESSION = { accessToken: 'tok-5e1f', loginId: 'lid', email: 'ac@example.com', aesKey: '00'.repeat(16), aesIv: '11'.repeat(16) };

const helloManifest = JSON.parse(fs.readFileSync(path.join(HELLO, 'plugin.json'), 'utf8'));
function mideaManifest() {
  const perms = JSON.parse(JSON.stringify(helloManifest.permissions));
  const ac = perms.network.homeTargets.find((t) => t.id === 'device');
  ac.id = 'ac';
  return { id: ID, name: { de: 'Klimaanlage', en: 'Klimaanlage' }, permissions: perms };
}

async function install(buf) {
  const r = await agent.post(API + '/inspect').set('X-CSRF-Token', csrf).set('Content-Type', 'application/octet-stream').send(buf).expect(200);
  assert.equal(r.body.canInstall, true, JSON.stringify(r.body.checks));
  await agent.post(API + '/install').set('X-CSRF-Token', csrf).send({ token: r.body.token, accept: true }).expect(200);
}
const pcall = (p) => agent.get(`${API}/${ID}/api${p}`);
const importNow = () => agent.post(`${API}/${ID}/legacy/import`).set('X-CSRF-Token', csrf).send({ confirm: true });

before(async () => {
  ({ agent } = await setup());
  require('../src/services/license')._overrideForTest({ midea_integration: true });
  csrf = getCsrf();
  runtime = require('../src/services/plugins/runtime');
  plugins = require('../src/services/plugins');
  legacy = require('../src/services/plugins/legacy');
  db = require('../src/db/connection').getDb();
  adminId = db.prepare("SELECT id FROM users WHERE username = 'admin'").get().id;
  const { encrypt } = require('../src/utils/crypto');
  const settings = require('../src/services/settings');
  settings.set('portal.widget.midea', '1');
  // built-in Klimaanlage: the cloud account, a cloud AC, a LAN V3 AC, a LAN AC on a never-reachable address
  settings.set('midea_config', JSON.stringify({ app: 'msmarthome', email: 'ac@example.com', password: encrypt(PASSWORD), session: encrypt(JSON.stringify(SESSION)) }));
  db.prepare(`INSERT INTO midea_devices (id, name, device_sn, transport, cloud_appliance_id, enabled)
    VALUES (1, 'Wohnzimmer', 'cloud-153931628798542', 'cloud', '153931628798542', 1)`).run();
  db.prepare(`INSERT INTO midea_devices (id, name, device_sn, device_id, ip, port, protocol_version, token_enc, key_enc, enabled)
    VALUES (2, 'Büro', 'SN-LAN-2', '151732605161920', '192.168.1.60', 6444, 3, ?, ?, 0)`).run(encrypt(TOKEN), encrypt(KEY));
  db.prepare(`INSERT INTO midea_devices (id, name, device_sn, ip, port, protocol_version)
    VALUES (3, 'Keller', 'lan-127.0.0.1', '127.0.0.1', 6444, 2)`).run();
  db.prepare('INSERT INTO midea_device_owners (midea_device_id, user_id) VALUES (1, ?)').run(adminId);
});
after(async () => {
  await plugins.stop();
  teardown();
});

describe('built-in Klimaanlage before a plugin replaces it', () => {
  it('runs as before', async () => {
    assert.equal(legacy.replaced('midea'), false);
    const r = await agent.get('/api/v1/midea/devices').expect(200);
    assert.deepEqual(r.body.devices.map((d) => d.name), ['Wohnzimmer', 'Büro', 'Keller']);
    const page = await agent.get('/midea').expect(200);
    assert.match(page.text, /href="\/midea"/);
    assert.equal(require('../src/services/midea').replacedByPlugin(), false);
  });
});

describe('the signed first-party plugin gatecontrol-midea', () => {
  before(async () => {
    await install(helloPackage({ overrides: mideaManifest() }));
    assert.equal(await runtime.waitRunning(ID), true);
  });

  it('is offered the import of the built-in data', async () => {
    const r = await agent.get(`${API}/${ID}/legacy`).expect(200);
    assert.deepEqual(r.body.legacy.counts, { cloud: 1, devices: 3, owners: 1 });
    assert.equal(r.body.legacy.dataset, 'midea');
    assert.equal(r.body.legacy.eligible, true);
    assert.equal(r.body.legacy.available, true);
  });

  it('hands over the account, devices and owners; LAN addresses become "ac" targets', async () => {
    const r = await importNow().expect(200);
    assert.deepEqual(r.body.counts, { cloud: 1, devices: 3, owners: 1 });
    assert.equal(r.body.targetsAdded, 1, 'only the reachable LAN address');
    const snap = (await pcall('/legacy').expect(200)).body.snapshot;
    assert.equal(snap.schema, 1);
    assert.equal(snap.dataset, 'midea');
    assert.deepEqual(Object.keys(snap).sort(), ['cloud', 'dataset', 'devices', 'exportedAt', 'owners', 'schema']);
    assert.deepEqual(snap.cloud, [{ app: 'msmarthome', email: 'ac@example.com', password: PASSWORD, session: SESSION }]);
    const [cloud, lan, blocked] = snap.devices;
    assert.deepEqual([cloud.id, cloud.transport, cloud.cloud_appliance_id, cloud.enabled, cloud.target], [1, 'cloud', '153931628798542', true, null]);
    assert.deepEqual([lan.id, lan.transport, lan.device_id, lan.protocol_version, lan.enabled, lan.token, lan.key], [2, 'lan', '151732605161920', 3, false, TOKEN, KEY]);
    assert.deepEqual(lan.target, { id: 'ac', index: 0, label: '192.168.1.60' });
    assert.equal(blocked.target, null, 'a never-reachable address is not assigned');
    for (const d of snap.devices) assert.ok(!('ip' in d) && !('port' in d), 'addresses stay in the host');
    assert.deepEqual(snap.owners.map((o) => [o.device_id, o.user_id]), [[1, adminId]]);
    const t = await agent.get(`${API}/${ID}/targets`).expect(200);
    const ac = t.body.declared.find((d) => d.id === 'ac');
    assert.deepEqual(ac.assigned.map((a) => [a.kind, a.host]), [['host', '192.168.1.60']]);
  });

  it('is idempotent and logged without secrets', async () => {
    const r = await importNow().expect(200);
    assert.equal(r.body.targetsAdded, 0, 'an address already assigned is reused');
    assert.equal(r.body.legacy.imported.runs, 2);
    const logs = (await agent.get(`${API}/${ID}/logs`).expect(200)).body.logs.map((l) => l.message).join('\n');
    assert.match(logs, /built-in data imported \(midea\): 1 cloud, 3 devices, 1 owners/);
    const activity = JSON.stringify(db.prepare("SELECT message, details FROM activity_log WHERE event_type = 'plugin_legacy_imported'").all());
    for (const secret of [PASSWORD, TOKEN, KEY, SESSION.accessToken]) {
      assert.ok(!logs.includes(secret));
      assert.ok(!activity.includes(secret));
    }
  });

  it('replaces the built-in Klimaanlage while it runs: sidebar, page, API, portal, polling', async () => {
    assert.equal(legacy.replaced('midea'), true);
    assert.equal(legacy.replaced('smarthome'), false, 'only its own feature');
    const api = await agent.get('/api/v1/midea/devices').expect(409);
    assert.equal(api.body.code, 'replaced_by_plugin');
    assert.equal(api.body.plugin, ID);
    assert.match(api.body.error, /gatecontrol-midea/);
    const page = await agent.get('/midea').expect(302);
    assert.equal(page.headers.location, '/plugins/gatecontrol-midea');
    const dash = await agent.get('/plugins/gatecontrol-midea').expect(200);
    assert.doesNotMatch(dash.text, /href="\/midea"/);
    const portal = await agent.get('/api/v1/portal/midea').expect(200);
    assert.equal(portal.body.reason, 'unavailable');
    const st = await agent.get('/api/v1/portal/midea/1/state').expect(200);
    assert.equal(st.body.reason, 'unavailable');
    const ctl = await agent.post('/api/v1/portal/midea/1/state').set('X-CSRF-Token', csrf).send({ patch: { power: true } }).expect(200);
    assert.equal(ctl.body.reason, 'unavailable');
    assert.equal(require('../src/services/userVisibility').forUser(adminId).portal.some((e) => e.kind === 'midea'), false);
    const midea = require('../src/services/midea');
    assert.equal(midea.replacedByPlugin(), true);
    await midea.pollTick();
    assert.equal(midea.getStatus().lastPollAt, null, 'the poll loop stands still');
  });

  it('comes back when the plugin is switched off; the built-in data is untouched', async () => {
    await agent.post(`${API}/${ID}/disable`).set('X-CSRF-Token', csrf).expect(200);
    assert.equal(legacy.replaced('midea'), false);
    await agent.get('/api/v1/midea/devices').expect(200);
    const page = await agent.get('/midea').expect(200);
    assert.match(page.text, /href="\/midea"/);
    assert.equal(require('../src/services/userVisibility').forUser(adminId).portal.some((e) => e.kind === 'midea'), true);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM midea_devices').get().c, 3);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM midea_device_owners').get().c, 1);
    assert.ok(require('../src/services/settings').get('midea_config'));
    await agent.post(`${API}/${ID}/enable`).set('X-CSRF-Token', csrf).expect(200);
    assert.equal(await runtime.waitRunning(ID), true);
  });

  it('uninstall "Alles löschen" forgets the import record', async () => {
    await agent.post(`${API}/${ID}/uninstall`).set('X-CSRF-Token', csrf).send({ mode: 'wipe', confirm: 'Klimaanlage' }).expect(200);
    assert.equal(legacy.replaced('midea'), false);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM plugin_legacy_imports').get().c, 0);
  });
});
