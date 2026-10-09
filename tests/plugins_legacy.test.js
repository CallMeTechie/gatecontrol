'use strict';

// Built-in → plugin migration (docs/plugins.md "Built-in data import",
// src/services/plugins/legacy.js): Smart Home is no longer built in, its
// tables stay. Without the plugin the dashboard and Settings → Plugins show
// an upgrade notice and the old page leads to Settings → Plugins; the
// first-party plugin mapped to the dataset (gatecontrol-smarthome) gets a
// one-time snapshot of exactly those tables (deCONZ API keys decrypted for
// the hand-over only, read straight from the tables), its routes become the
// plugin's home-target assignments, the import is recorded and re-runnable.
// Also: gc.settings.setSecret and the portalVisible hook.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { helloPackage, HELLO } = require('./helpers/plugins');
const { setup, teardown, getCsrf } = require('./helpers/setup');

let agent, csrf, runtime, plugins, legacy, db, adminId;
const API = '/api/v1/plugins';
const ID = 'gatecontrol-smarthome';
const SECRET_KEY = 'deconz-api-key-7f3a9c';

const helloManifest = JSON.parse(fs.readFileSync(path.join(HELLO, 'plugin.json'), 'utf8'));
function smarthomeManifest() {
  const perms = JSON.parse(JSON.stringify(helloManifest.permissions));
  perms.network.homeTargets[0].multiple = true;
  return { id: ID, name: { de: 'Smart Home', en: 'Smart Home' }, permissions: perms };
}

async function install(buf) {
  const r = await agent.post(API + '/inspect').set('X-CSRF-Token', csrf).set('Content-Type', 'application/octet-stream').send(buf).expect(200);
  assert.equal(r.body.canInstall, true, JSON.stringify(r.body.checks));
  await agent.post(API + '/install').set('X-CSRF-Token', csrf).send({ token: r.body.token, accept: true }).expect(200);
}
const pcall = (id, p, method = 'get', body) => {
  const req = agent[method](`${API}/${id}/api${p}`);
  if (method !== 'get') req.set('X-CSRF-Token', csrf);
  return body ? req.send(body) : req;
};
const importNow = (id = ID) => agent.post(`${API}/${id}/legacy/import`).set('X-CSRF-Token', csrf).send({ confirm: true });

function route(domain, peerId) {
  return Number(db.prepare(`INSERT INTO routes (domain, route_type, target_kind, target_peer_id, target_lan_host, target_lan_port, target_ip, target_port, enabled)
    VALUES (?, 'http', 'gateway', ?, '192.168.1.50', 80, '', 80, 1)`).run(domain, peerId).lastInsertRowid);
}

let routeA, routeB;

before(async () => {
  ({ agent } = await setup());
  require('../src/services/license')._overrideForTest({ smarthome: true });
  csrf = getCsrf();
  runtime = require('../src/services/plugins/runtime');
  plugins = require('../src/services/plugins');
  legacy = require('../src/services/plugins/legacy');
  db = require('../src/db/connection').getDb();
  adminId = db.prepare("SELECT id FROM users WHERE username = 'admin'").get().id;
  const { encrypt } = require('../src/utils/crypto');
  const gwPeer = Number(db.prepare("INSERT INTO peers (name, public_key, allowed_ips, enabled, peer_type) VALUES ('GW', 'pk-gw', '10.8.0.20/32', 1, 'gateway')").run().lastInsertRowid);
  routeA = route('phoscon-a.example.com', gwPeer);
  routeB = route('phoscon-b.example.com', gwPeer);
  // built-in Smart Home data: two gateways, resources, an owner, a rule
  db.prepare("INSERT INTO smarthome_gateways (id, name, route_id, api_key_enc, enabled) VALUES (1, 'Wohnung', ?, ?, 1)").run(routeA, encrypt(SECRET_KEY));
  db.prepare("INSERT INTO smarthome_gateways (id, name, route_id, api_key_enc, enabled) VALUES (2, 'Garten', ?, NULL, 0)").run(routeB);
  db.prepare(`INSERT INTO smarthome_resources (id, gateway_id, deconz_id, deconz_type, uniqueid, kind, name, capabilities_json, state_json)
    VALUES (10, 1, '3', 'lights', 'aa:bb', 'light', 'Stehlampe', '{"on":true,"bri":true,"color":"ct"}', '{"on":true,"bri":40}')`).run();
  db.prepare(`INSERT INTO smarthome_resources (id, gateway_id, deconz_id, deconz_type, kind, name, capabilities_json)
    VALUES (11, 1, '1/2', 'scenes', 'scene', 'Wohnzimmer · Abend', '{"group_id":"1","scene_id":"2"}')`).run();
  db.prepare('INSERT INTO smarthome_resource_owners (resource_id, user_id) VALUES (10, ?)').run(adminId);
  db.prepare(`INSERT INTO smarthome_rules (id, gateway_id, name, enabled, definition_json, deconz_rule_id) VALUES (5, 1, 'Flur', 1, ?, '17')`)
    .run(JSON.stringify({ triggers: [], actions: [{ kind: 'light', resourceId: 10, set: { on: true } }] }));
});
after(async () => {
  await plugins.stop();
  teardown();
});

describe('built-in Smart Home data without the plugin', () => {
  it('nothing of the former built-in is left: page → Settings → Plugins, API gone, no sidebar entry', async () => {
    const page = await agent.get('/smarthome').expect(302);
    assert.equal(page.headers.location, '/settings#plugins');
    assert.equal((await agent.get('/smarthome/rules').expect(302)).headers.location, '/settings#plugins');
    const api = await agent.get('/api/v1/smarthome/gateways').expect(410);
    assert.deepEqual([api.body.code, api.body.plugin], ['moved_to_plugin', ID]);
    await agent.post('/api/v1/smarthome/gateways').set('X-CSRF-Token', csrf).send({}).expect(410);
    await agent.get('/api/v1/portal/smarthome').expect(404);
    const dash = await agent.get('/dashboard').expect(200);
    assert.doesNotMatch(dash.text, /href="\/smarthome"/);
    assert.doesNotMatch(dash.text, /nav-section-label">Integrations</, 'no integrations group without a plugin');
  });

  it('the dashboard and Settings → Plugins say that Smart Home is a plugin now (data kept)', async () => {
    assert.deepEqual(legacy.pendingMoves().map((m) => [m.pluginId, m.dataset, m.counts]),
      [[ID, 'smarthome', { gateways: 2, resources: 2, owners: 1, rules: 1 }]]);
    const releases = 'https://github.com/CallMeTechie/gatecontrol-plugins/releases?q=gatecontrol-smarthome&amp;expanded=true';
    for (const url of ['/dashboard', '/settings']) {
      const html = (await agent.get(url).expect(200)).text;
      assert.match(html, /data-builtin-moved="gatecontrol-smarthome"/, url);
      assert.match(html, /Smart Home is a plugin now\. Install “Smart Home”/, url);
      assert.ok(html.includes(`href="${releases}"`), url);
      assert.doesNotMatch(html, /data-builtin-moved="gatecontrol-(midea|skoda)"/, url + ': only datasets with data');
    }
    // the dashboard leads to the catalogue's install button in Settings → Plugins
    const dash = (await agent.get('/dashboard').expect(200)).text;
    assert.match(dash, /<a href="\/settings\?install=gatecontrol-smarthome#plugins" class="db-btn db-btn-primary">Install now<\/a>/);
    process.env.GC_PLUGIN_CATALOG = 'off';
    try {
      const off = (await agent.get('/dashboard').expect(200)).text;
      assert.match(off, /<a href="\/settings#plugins" class="db-btn db-btn-primary">Go to plugins<\/a>/, 'without the catalogue: the plugin list');
    } finally { delete process.env.GC_PLUGIN_CATALOG; }
  });
});

describe('an unsigned build of the mapped id', () => {
  it('may not import (status says why) and does not replace the built-in while it cannot run', async () => {
    await agent.put(API + '/policy').set('X-CSRF-Token', csrf).send({ allowUnsigned: true, confirm: 'ERLAUBEN' }).expect(200);
    await install(helloPackage({ sign: false, overrides: smarthomeManifest() }));
    assert.equal(await runtime.waitRunning(ID), true);
    const st = await agent.get(`${API}/${ID}/legacy`).expect(200);
    assert.equal(st.body.legacy.eligible, false);
    assert.equal(st.body.legacy.reason, 'unsigned');
    assert.equal(st.body.legacy.available, true);
    assert.deepEqual(st.body.legacy.counts, { gateways: 2, resources: 2, owners: 1, rules: 1 });
    const r = await importNow().expect(409);
    assert.equal(r.body.code, 'legacy_unsigned');
    // installed → the old page leads to it and the upgrade notice is gone
    assert.equal((await agent.get('/smarthome').expect(302)).headers.location, '/plugins/gatecontrol-smarthome');
    assert.deepEqual(legacy.pendingMoves(), []);
    await agent.put(API + '/policy').set('X-CSRF-Token', csrf).send({ allowUnsigned: false }).expect(200);
    await agent.post(`${API}/${ID}/uninstall`).set('X-CSRF-Token', csrf).send({ mode: 'wipe', confirm: 'Smart Home' }).expect(200);
  });
});

describe('the signed first-party plugin', () => {
  before(async () => {
    await install(helloPackage({ overrides: smarthomeManifest() }));
    assert.equal(await runtime.waitRunning(ID), true);
  });

  it('is offered the import of the built-in data', async () => {
    const r = await agent.get(`${API}/${ID}/legacy`).expect(200);
    assert.deepEqual({ ...r.body.legacy, counts: undefined }, { dataset: 'smarthome', eligible: true, reason: null, available: true, counts: undefined, imported: null, running: true });
    const other = await agent.get(`${API}/hello-none/legacy`).expect(404);
    assert.equal(other.body.code, 'not_found');
  });

  it('the import needs an explicit confirmation', async () => {
    await agent.post(`${API}/${ID}/legacy/import`).set('X-CSRF-Token', csrf).send({}).expect(400);
    await agent.post(`${API}/${ID}/legacy/import`).set('X-CSRF-Token', csrf).send({ confirm: 'yes' }).expect(400);
  });

  it('hands exactly the mapped tables to the plugin, with the routes turned into target assignments', async () => {
    const r = await importNow().expect(200);
    assert.deepEqual(r.body.counts, { gateways: 2, resources: 2, owners: 1, rules: 1 });
    assert.equal(r.body.targetsAdded, 2);
    const snap = (await pcall(ID, '/legacy').expect(200)).body.snapshot;
    assert.equal(snap.schema, 1);
    assert.equal(snap.dataset, 'smarthome');
    assert.deepEqual(Object.keys(snap).sort(), ['dataset', 'exportedAt', 'gateways', 'owners', 'resources', 'rules', 'schema']);
    assert.deepEqual(snap.gateways.map((g) => [g.id, g.name, g.enabled, g.api_key, g.target && g.target.index]),
      [[1, 'Wohnung', true, SECRET_KEY, 0], [2, 'Garten', false, null, 1]]);
    assert.equal(snap.gateways[0].target.label, 'phoscon-a.example.com');
    assert.ok(!('route_id' in snap.gateways[0]), 'route ids stay in the host');
    assert.deepEqual(snap.resources[0].capabilities, { on: true, bri: true, color: 'ct' });
    assert.deepEqual(snap.resources[0].state, { on: true, bri: 40 });
    assert.deepEqual(snap.owners.map((o) => [o.resource_id, o.user_id]), [[10, adminId]]);
    assert.equal(snap.rules[0].deconz_rule_id, '17');
    assert.deepEqual(snap.rules[0].definition.actions[0].set, { on: true });
    const t = await agent.get(`${API}/${ID}/targets`).expect(200);
    assert.deepEqual(t.body.declared[0].assigned.map((a) => [a.kind, a.routeId]), [['route', routeA], ['route', routeB]]);
  });

  it('is recorded, logged without the secret, and idempotent when re-run', async () => {
    let st = (await agent.get(`${API}/${ID}/legacy`).expect(200)).body.legacy;
    assert.equal(st.imported.runs, 1);
    assert.deepEqual(st.imported.counts, { gateways: 2, resources: 2, owners: 1, rules: 1 });
    const r = await importNow().expect(200);
    assert.equal(r.body.targetsAdded, 0, 'routes already assigned are reused');
    st = r.body.legacy;
    assert.equal(st.imported.runs, 2);
    const t = await agent.get(`${API}/${ID}/targets`).expect(200);
    assert.equal(t.body.declared[0].assigned.length, 2);
    const logs = (await agent.get(`${API}/${ID}/logs`).expect(200)).body.logs.map((l) => l.message).join('\n');
    assert.match(logs, /built-in data imported \(smarthome\): 2 gateways, 2 resources, 1 owners, 1 rules/);
    const activity = db.prepare("SELECT message, details FROM activity_log WHERE event_type = 'plugin_legacy_imported'").all();
    assert.equal(activity.length, 2);
    assert.ok(!JSON.stringify(activity).includes(SECRET_KEY));
    assert.ok(!logs.includes(SECRET_KEY));
  });

  it('a plugin refusing the snapshot is reported, nothing recorded', async () => {
    await pcall(ID, '/kv', 'post', { key: 'legacy-refuse', value: true }).expect(200);
    const r = await importNow().expect(502);
    assert.equal(r.body.code, 'legacy_failed');
    await pcall(ID, '/kv', 'post', { key: 'legacy-refuse', value: false }).expect(200);
    assert.equal((await agent.get(`${API}/${ID}/legacy`)).body.legacy.imported.runs, 2);
  });

  it('the former pages lead to the plugin, which is listed under "Integrationen"; no upgrade notice', async () => {
    const page = await agent.get('/smarthome').expect(302);
    assert.equal(page.headers.location, '/plugins/gatecontrol-smarthome');
    const rules = await agent.get('/smarthome/rules').expect(302);
    assert.equal(rules.headers.location, '/plugins/gatecontrol-smarthome/rules');
    const dash = await agent.get('/plugins/gatecontrol-smarthome').expect(200);
    assert.doesNotMatch(dash.text, /href="\/smarthome"/);
    assert.match(dash.text, /nav-section-label">Integrations<\/div>\s*<a href="\/plugins\/gatecontrol-smarthome"/);
    assert.doesNotMatch(dash.text, /nav-section-label">Plugins</);
    assert.doesNotMatch((await agent.get('/dashboard').expect(200)).text, /data-builtin-moved=/);
  });

  it('switched off: still the plugin page, the built-in data is untouched', async () => {
    await agent.post(`${API}/${ID}/disable`).set('X-CSRF-Token', csrf).expect(200);
    assert.equal((await agent.get('/smarthome').expect(302)).headers.location, '/plugins/gatecontrol-smarthome');
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM smarthome_resources').get().c, 2);
    const st = (await agent.get(`${API}/${ID}/legacy`)).body.legacy;
    assert.equal(st.running, false);
    assert.equal((await importNow().expect(409)).body.code, 'legacy_not_running');
    await agent.post(`${API}/${ID}/enable`).set('X-CSRF-Token', csrf).expect(200);
    assert.equal(await runtime.waitRunning(ID), true);
  });

  const marker = () => db.prepare("SELECT value FROM settings WHERE key = 'plugins.legacy_imported.smarthome'").get();
  const noticeShown = async () => {
    const out = [];
    for (const url of ['/dashboard', '/settings']) out.push(/data-builtin-moved=/.test((await agent.get(url).expect(200)).text));
    return out;
  };

  it('a successful import leaves a marker that outlives the plugin', () => {
    assert.match(marker().value, /^\d{4}-\d\d-\d\dT/);
    assert.equal(legacy.everImported(ID), true);
    assert.equal(legacy.everImported('gatecontrol-midea'), false);
  });

  it('uninstall "Daten behalten": the notice does not come back (the built-in data was imported)', async () => {
    await agent.post(`${API}/${ID}/uninstall`).set('X-CSRF-Token', csrf).send({ mode: 'keep' }).expect(200);
    assert.ok(db.prepare('SELECT COUNT(*) AS c FROM smarthome_gateways').get().c > 0, 'the built-in tables stay');
    assert.deepEqual(legacy.pendingMoves(), []);
    assert.deepEqual(await noticeShown(), [false, false]);
    // an installation that imported before the marker existed: its kept record is enough
    db.prepare("DELETE FROM settings WHERE key = 'plugins.legacy_imported.smarthome'").run();
    assert.deepEqual(legacy.pendingMoves(), []);
  });

  it('reinstalled after "Daten behalten": the import stays re-runnable', async () => {
    await install(helloPackage({ overrides: smarthomeManifest() }));
    assert.equal(await runtime.waitRunning(ID), true);
    const st = (await agent.get(`${API}/${ID}/legacy`).expect(200)).body.legacy;
    assert.deepEqual([st.available, st.eligible, st.imported && st.imported.runs], [true, true, 2]);
    assert.equal((await importNow().expect(200)).body.legacy.imported.runs, 3);
    assert.ok(marker(), 'the re-run sets the marker again');
  });

  it('uninstall "Alles löschen" forgets the import record, the notice still stays away; a fresh install is offered the import again', async () => {
    await agent.post(`${API}/${ID}/uninstall`).set('X-CSRF-Token', csrf).send({ mode: 'wipe', confirm: 'Smart Home' }).expect(200);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM plugin_legacy_imports').get().c, 0);
    assert.deepEqual(legacy.pendingMoves(), []);
    assert.deepEqual(await noticeShown(), [false, false]);
    assert.equal((await agent.get('/smarthome').expect(302)).headers.location, '/settings#plugins');
    await install(helloPackage({ overrides: smarthomeManifest() }));
    assert.equal(await runtime.waitRunning(ID), true);
    const st = (await agent.get(`${API}/${ID}/legacy`).expect(200)).body.legacy;
    assert.deepEqual([st.available, st.eligible, st.imported], [true, true, null], 'offered as not imported yet');
    assert.equal((await importNow().expect(200)).body.legacy.imported.runs, 1);
    await agent.post(`${API}/${ID}/uninstall`).set('X-CSRF-Token', csrf).send({ mode: 'wipe', confirm: 'Smart Home' }).expect(200);
    assert.deepEqual(legacy.pendingMoves(), []);
  });
});

describe('host API additions', () => {
  before(async () => {
    await install(helloPackage());
    assert.equal(await runtime.waitRunning('hello'), true);
  });

  it('gc.settings.setSecret stores a value encrypted, readable only by the plugin', async () => {
    await pcall('hello', '/secret', 'post', { key: 'gw.1.apikey', value: 's3cr3t-value' }).expect(200);
    assert.equal((await pcall('hello', '/secret?key=gw.1.apikey').expect(200)).body.value, 's3cr3t-value');
    const raw = await require('../src/services/plugins/storage').forPlugin('hello').call('settings.all', {});
    assert.equal(typeof raw.values['gw.1.apikey'].enc, 'string');
    assert.ok(!JSON.stringify(raw.values).includes('s3cr3t-value'));
    const ui = await agent.get(`${API}/hello/settings`).expect(200);
    assert.ok(!('gw.1.apikey' in ui.body.values), 'never shown in the settings form');
    // a declared non-secret setting cannot be turned into a secret; bad keys are refused
    assert.equal((await pcall('hello', '/secret', 'post', { key: 'greeting', value: 'x' }).expect(400)).body.code, 'ERR_INVALID');
    assert.equal((await pcall('hello', '/secret', 'post', { key: '__proto__', value: 'x' }).expect(400)).body.code, 'ERR_INVALID');
    await pcall('hello', '/secret', 'post', { key: 'gw.1.apikey', value: null }).expect(200);
    assert.equal((await pcall('hello', '/secret?key=gw.1.apikey').expect(200)).body.value, null);
  });

  it('portalVisible hides a plugin portal tab for viewers with nothing to see', async () => {
    const user = { id: adminId, name: 'admin', role: 'admin', portal: true };
    assert.deepEqual((await plugins.portalTabsFor(user, 'de')).map((t) => t.id), ['hello']);
    await pcall('hello', '/kv', 'post', { key: 'portal-viewers', value: [999] }).expect(200);
    assert.deepEqual(await plugins.portalTabsFor(user, 'de'), []);
    await pcall('hello', '/kv', 'post', { key: 'portal-viewers', value: [adminId] }).expect(200);
    assert.deepEqual((await plugins.portalTabsFor(user, 'de')).map((t) => t.id), ['hello']);
  });

  it('a plugin without a mapped dataset has no import', async () => {
    assert.equal((await agent.get(`${API}/hello/legacy`).expect(200)).body.legacy, null);
    assert.equal((await importNow('hello').expect(404)).body.code, 'not_found');
  });
});
