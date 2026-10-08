'use strict';

// Built-in Fahrzeuge (Škoda) → gatecontrol-skoda (docs/plugins.md "Built-in
// data import", src/services/plugins/legacy.js): the mapped first-party
// plugin gets a one-time snapshot of exactly the skoda_* tables (MySkoda
// password, S-PIN and session tokens decrypted for the hand-over only, the
// render image as base64); a cloud integration has no home target, so no
// assignments are made. While the plugin runs the built-in Fahrzeuge
// (sidebar, page, API, portal part, "Was sieht dieser Nutzer?", polling) is
// off; switched off it is back with its data. Also: portal viewers carry
// `loggedIn` to plugins.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { helloPackage, HELLO } = require('./helpers/plugins');
const { setup, teardown, getCsrf } = require('./helpers/setup');

let agent, csrf, runtime, plugins, legacy, db, adminId;
const API = '/api/v1/plugins';
const ID = 'gatecontrol-skoda';
const PASSWORD = 'myskoda-pw-91c2e7';
const SPIN = '4711';
const ACCESS = 'access-token-5d1b88';
const REFRESH = 'refresh-token-a7c0f3';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const STATE = { capturedAt: '2026-10-01T08:00:00Z', locked: true, soc: 64, rangeKm: 251, position: { lat: 50.1, lon: 8.6 }, climate: { timers: [] } };

const helloManifest = JSON.parse(fs.readFileSync(path.join(HELLO, 'plugin.json'), 'utf8'));
function skodaManifest() {
  return { id: ID, name: { de: 'Fahrzeuge', en: 'Vehicles' }, permissions: JSON.parse(JSON.stringify(helloManifest.permissions)) };
}

async function install(buf) {
  const r = await agent.post(API + '/inspect').set('X-CSRF-Token', csrf).set('Content-Type', 'application/octet-stream').send(buf).expect(200);
  assert.equal(r.body.canInstall, true, JSON.stringify(r.body.checks));
  await agent.post(API + '/install').set('X-CSRF-Token', csrf).send({ token: r.body.token, accept: true }).expect(200);
}
const pcall = (id, p) => agent.get(`${API}/${id}/api${p}`);
const importNow = () => agent.post(`${API}/${ID}/legacy/import`).set('X-CSRF-Token', csrf).send({ confirm: true });
const secrets = [PASSWORD, ACCESS, REFRESH];

before(async () => {
  ({ agent } = await setup());
  require('../src/services/license')._overrideForTest({ skoda_integration: true });
  csrf = getCsrf();
  runtime = require('../src/services/plugins/runtime');
  plugins = require('../src/services/plugins');
  legacy = require('../src/services/plugins/legacy');
  db = require('../src/db/connection').getDb();
  adminId = db.prepare("SELECT id FROM users WHERE username = 'admin'").get().id;
  const { encrypt } = require('../src/utils/crypto');
  // built-in Fahrzeuge data: two accounts (one with S-PIN and session), two vehicles, an owner
  db.prepare(`INSERT INTO skoda_accounts (id, email, password_enc, session_enc, spin_enc, status, backoff_min, next_retry_at)
    VALUES (1, 'ada@example.com', ?, ?, ?, 'ok', 0, NULL)`)
    .run(encrypt(PASSWORD), encrypt(JSON.stringify({ accessToken: ACCESS, refreshToken: REFRESH, idToken: 'id-token' })), encrypt(SPIN));
  db.prepare(`INSERT INTO skoda_accounts (id, email, password_enc, status, status_detail, backoff_min, next_retry_at)
    VALUES (2, 'bob@example.com', ?, 'rate_limited', 'HTTP 429', 60, '2026-10-08T12:00:00Z')`).run(encrypt('other-pw'));
  db.prepare(`INSERT INTO skoda_vehicles (id, account_id, vin, name, model, state_json, image, image_url, fetched_at)
    VALUES (7, 1, 'TMBJJ7NX5MY000001', 'Enyaq', 'Enyaq iV 80', ?, ?, 'https://iprenders.blob.core.windows.net/r/1.png', '2026-10-01 08:01:00')`)
    .run(JSON.stringify(STATE), PNG);
  db.prepare("INSERT INTO skoda_vehicles (id, account_id, vin, name, model) VALUES (8, 2, 'TMBJJ7NX5MY000002', 'Elroq', 'Elroq 85')").run();
  db.prepare('INSERT INTO skoda_vehicle_owners (skoda_vehicle_id, user_id) VALUES (7, ?)').run(adminId);
});
after(async () => {
  await plugins.stop();
  teardown();
});

describe('built-in Fahrzeuge before a plugin replaces them', () => {
  it('run as before', async () => {
    assert.equal(legacy.replaced('skoda'), false);
    const r = await agent.get('/api/v1/skoda').expect(200);
    assert.deepEqual(r.body.vehicles.map((v) => v.name), ['Enyaq', 'Elroq']);
    const page = await agent.get('/skoda').expect(200);
    assert.match(page.text, /href="\/skoda"/);
    assert.equal(require('../src/services/userVisibility').forUser(adminId).portal.some((e) => e.kind === 'skoda'), true);
  });
});

describe('the signed first-party plugin gatecontrol-skoda', () => {
  before(async () => {
    await install(helloPackage({ overrides: skodaManifest() }));
    assert.equal(await runtime.waitRunning(ID), true);
  });

  it('is offered the import of the built-in data', async () => {
    const r = await agent.get(`${API}/${ID}/legacy`).expect(200);
    assert.deepEqual(r.body.legacy, { dataset: 'skoda', eligible: true, reason: null, available: true,
      counts: { accounts: 2, vehicles: 2, owners: 1 }, imported: null, running: true });
  });

  it('hands exactly the skoda tables to the plugin, secrets decrypted, no home target', async () => {
    const r = await importNow().expect(200);
    assert.deepEqual(r.body.counts, { accounts: 2, vehicles: 2, owners: 1 });
    assert.equal(r.body.targetsAdded, 0);
    const snap = (await pcall(ID, '/legacy').expect(200)).body.snapshot;
    assert.equal(snap.schema, 1);
    assert.equal(snap.dataset, 'skoda');
    assert.deepEqual(Object.keys(snap).sort(), ['accounts', 'dataset', 'exportedAt', 'owners', 'schema', 'vehicles']);
    const [a1, a2] = snap.accounts;
    assert.deepEqual([a1.id, a1.email, a1.password, a1.spin, a1.status], [1, 'ada@example.com', PASSWORD, SPIN, 'ok']);
    assert.deepEqual(a1.session, { accessToken: ACCESS, refreshToken: REFRESH }, 'only the tokens the plugin needs');
    assert.deepEqual([a2.password, a2.spin, a2.session, a2.status, a2.status_detail, a2.backoff_min, a2.next_retry_at],
      ['other-pw', null, null, 'rate_limited', 'HTTP 429', 60, '2026-10-08T12:00:00Z']);
    const [v1, v2] = snap.vehicles;
    assert.deepEqual([v1.id, v1.account_id, v1.vin, v1.name, v1.model], [7, 1, 'TMBJJ7NX5MY000001', 'Enyaq', 'Enyaq iV 80']);
    assert.deepEqual(v1.state, STATE);
    assert.equal(Buffer.from(v1.image, 'base64').equals(PNG), true);
    assert.equal(v1.image_url, 'https://iprenders.blob.core.windows.net/r/1.png');
    assert.deepEqual([v2.state, v2.image], [null, null]);
    assert.deepEqual(snap.owners.map((o) => [o.vehicle_id, o.user_id]), [[7, adminId]]);
    const t = await agent.get(`${API}/${ID}/targets`).expect(200);
    assert.ok(t.body.declared.every((d) => d.assigned.length === 0), 'a cloud integration gets no target assignments');
  });

  it('is recorded and logged without any secret', async () => {
    const r = await importNow().expect(200);
    assert.equal(r.body.legacy.imported.runs, 2);
    const logs = (await agent.get(`${API}/${ID}/logs`).expect(200)).body.logs.map((l) => l.message).join('\n');
    assert.match(logs, /built-in data imported \(skoda\): 2 accounts, 2 vehicles, 1 owners/);
    const activity = JSON.stringify(db.prepare("SELECT message, details FROM activity_log WHERE event_type = 'plugin_legacy_imported'").all());
    for (const s of secrets) {
      assert.ok(!logs.includes(s), 'plugin log');
      assert.ok(!activity.includes(s), 'activity log');
    }
  });

  it('replaces the built-in Fahrzeuge while it runs: sidebar, page, API, portal, visibility', async () => {
    assert.equal(legacy.replaced('skoda'), true);
    assert.equal(legacy.replaced('smarthome'), false, 'only the mapped feature');
    const api = await agent.get('/api/v1/skoda').expect(409);
    assert.equal(api.body.code, 'replaced_by_plugin');
    assert.equal(api.body.plugin, ID);
    assert.match(api.body.error, /gatecontrol-skoda/);
    await agent.post('/api/v1/skoda/vehicles/7/command').set('X-CSRF-Token', csrf).send({ action: 'lock' }).expect(409);
    const page = await agent.get('/skoda').expect(302);
    assert.equal(page.headers.location, '/plugins/gatecontrol-skoda');
    const dash = await agent.get('/plugins/gatecontrol-skoda').expect(200);
    assert.doesNotMatch(dash.text, /href="\/skoda"/);
    assert.match(dash.text, /href="\/plugins\/gatecontrol-skoda"/);
    const portal = await agent.get('/api/v1/portal/skoda').expect(200);
    assert.equal(portal.body.data, null);
    assert.equal(portal.body.reason, 'unavailable');
    await agent.get('/api/v1/portal/skoda/vehicles/7/image').expect(404);
    assert.equal(require('../src/services/userVisibility').forUser(adminId).portal.some((e) => e.kind === 'skoda'), false);
  });

  it('the built-in polling stands still', async () => {
    const skoda = require('../src/services/skoda');
    const accounts = require('../src/services/skoda/skodaAccounts');
    assert.equal(skoda.replacedByPlugin(), true);
    const orig = accounts.listAccounts;
    let asked = 0;
    accounts.listAccounts = (...a) => { asked++; return orig(...a); };
    try { skoda.pollTick(); } finally { accounts.listAccounts = orig; }
    assert.equal(asked, 0, 'the poll loop never looks at the accounts');
  });

  it('portal viewers reach the plugin with loggedIn', async () => {
    const r = await agent.get(`/api/v1/portal/plugins/${ID}/api/ping`).expect(200);
    assert.equal(r.body.user.portal, true);
    assert.equal(r.body.user.loggedIn, true, 'a web login counts as signed in');
  });

  it('comes back when the plugin is switched off; the built-in data is untouched', async () => {
    await agent.post(`${API}/${ID}/disable`).set('X-CSRF-Token', csrf).expect(200);
    assert.equal(legacy.replaced('skoda'), false);
    assert.equal(require('../src/services/skoda').replacedByPlugin(), false);
    const r = await agent.get('/api/v1/skoda').expect(200);
    assert.equal(r.body.vehicles.length, 2);
    const page = await agent.get('/skoda').expect(200);
    assert.match(page.text, /href="\/skoda"/);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM skoda_accounts').get().c, 2);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM skoda_vehicle_owners').get().c, 1);
    await agent.post(`${API}/${ID}/enable`).set('X-CSRF-Token', csrf).expect(200);
    assert.equal(await runtime.waitRunning(ID), true);
  });

  it('uninstall "Alles löschen" forgets the import record', async () => {
    await agent.post(`${API}/${ID}/uninstall`).set('X-CSRF-Token', csrf).send({ mode: 'wipe', confirm: 'Fahrzeuge' }).expect(200);
    assert.equal(legacy.replaced('skoda'), false);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM plugin_legacy_imports').get().c, 0);
  });
});
