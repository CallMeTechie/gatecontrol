'use strict';

// Plugin replacement (plugin.json `replaces`, docs/plugins.md "Replacing a
// plugin"): a first-party package under a new id takes over an installed
// plugin — its data folder, records keyed by the old id, the enabled state —
// and removes the old one; old ids resolve to the new plugin. A conflict
// leaves the old plugin as it was. The catalogue offers the new plugin as an
// update of the old one (by hand only, never automatically).

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { helloPackage } = require('./helpers/plugins');
const { setup, teardown, getCsrf } = require('./helpers/setup');

let agent, csrf, plugins, registry, constants, db;
const API = '/api/v1/plugins';

function inspect(buf) {
  return agent.post(API + '/inspect').set('X-CSRF-Token', csrf).set('Content-Type', 'application/octet-stream').send(buf);
}
async function installPkg(buf) {
  const r = await inspect(buf);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.canInstall, true, JSON.stringify(r.body.checks));
  const res = await agent.post(API + '/install').set('X-CSRF-Token', csrf).send({ token: r.body.token, accept: true });
  return { inspect: r.body, res };
}
const NEW = { id: 'hello-neu', version: '2.0.0', name: { de: 'Hallo Neu', en: 'Hello New' }, replaces: ['hello'] };

before(async () => {
  ({ agent } = await setup());
  csrf = getCsrf();
  plugins = require('../src/services/plugins');
  registry = require('../src/services/plugins/registry');
  constants = require('../src/services/plugins/constants');
  db = require('../src/db/connection').getDb();
});
after(async () => {
  await plugins.stop();
  teardown();
});

describe('manifest', () => {
  const manifest = require('../src/services/plugins/manifest');
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'plugins', 'hello', 'plugin.json'), 'utf8'));
  it('replaces: up to three other plugin ids', () => {
    assert.deepEqual(manifest.validate({ ...raw, replaces: ['gatecontrol-midea'] }).manifest.replaces, ['gatecontrol-midea']);
    assert.deepEqual(manifest.validate(raw).manifest.replaces, []);
    for (const bad of ['x', ['Bad_ID'], ['hello'], ['a1', 'a1'], ['a1', 'a2', 'a3', 'a4'], [1]]) {
      const r = manifest.validate({ ...raw, replaces: bad });
      assert.equal(r.ok, false, JSON.stringify(bad));
      assert.ok(r.errors.some((e) => /replaces/.test(e)), JSON.stringify(r.errors));
    }
  });
});

describe('takeover on install', () => {
  let topicOld;
  before(async () => {
    const { res } = await installPkg(helloPackage());
    assert.equal(res.status, 200, JSON.stringify(res.body));
    await agent.post(`${API}/hello/disable`).set('X-CSRF-Token', csrf);
    fs.mkdirSync(path.join(constants.dataDir('hello'), 'files'), { recursive: true });
    fs.writeFileSync(path.join(constants.dataDir('hello'), 'files', 'marker.txt'), 'old data');
    db.prepare("INSERT INTO plugin_targets (plugin_id, target_id, idx, assignment) VALUES ('hello', 'gateway', 0, '{}')").run();
    topicOld = 'plugin:hello:alarm';
    db.prepare('INSERT OR REPLACE INTO notify_subscriptions (user_id, topic, enabled) VALUES (1, ?, 1)').run(topicOld);
    db.prepare("INSERT OR REPLACE INTO notify_rules (event_id) VALUES (?)").run(topicOld);
    db.prepare("INSERT OR REPLACE INTO client_layouts (key, user_id, layout, updated_at) VALUES ('t-replace', NULL, ?, datetime('now'))")
      .run(JSON.stringify({ tiles: [{ plugin: 'hello', id: 'x' }, { plugin: 'hello-world', id: 'y' }] }));
    db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('plugins.media_quota.hello', '5', datetime('now'))").run();
  });

  it('a package signed by somebody else does not take anything over', async () => {
    const r = await inspect(helloPackage({ sign: 'stranger', overrides: NEW })).expect(200);
    assert.equal(r.body.checks.some((c) => c.key === 'replaces'), false);
  });

  it('data already under the new id stops the takeover; the old plugin stays as it was', async () => {
    fs.mkdirSync(path.join(constants.dataDir('hello-neu')), { recursive: true });
    fs.writeFileSync(path.join(constants.dataDir('hello-neu'), 'stray.txt'), 'x');
    const { res } = await installPkg(helloPackage({ overrides: NEW }));
    assert.equal(res.status >= 400, true, JSON.stringify(res.body));
    assert.equal(res.body.code, 'replace_conflict');
    assert.ok(registry.get('hello'));
    assert.ok(!registry.get('hello-neu'));
    assert.equal(fs.readFileSync(path.join(constants.dataDir('hello'), 'files', 'marker.txt'), 'utf8'), 'old data');
    fs.rmSync(constants.dataDir('hello-neu'), { recursive: true, force: true });
  });

  it('moves data and records to the new id and removes the old plugin', async () => {
    const { inspect: info, res } = await installPkg(helloPackage({ overrides: NEW }));
    const check = info.checks.find((c) => c.key === 'replaces');
    assert.ok(check, 'the install dialog says what is taken over');
    assert.equal(res.status, 200, JSON.stringify(res.body));

    assert.ok(!registry.get('hello'));
    const p = registry.get('hello-neu');
    assert.equal(p.version, '2.0.0');
    assert.equal(p.enabled, false, 'keeps the enabled state of the old plugin');
    assert.equal(registry.resolve('hello').id, 'hello-neu');
    assert.equal(fs.existsSync(constants.dataDir('hello')), false);
    assert.equal(fs.readFileSync(path.join(constants.dataDir('hello-neu'), 'files', 'marker.txt'), 'utf8'), 'old data');

    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM plugin_targets WHERE plugin_id = 'hello'").get().n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM plugin_targets WHERE plugin_id = 'hello-neu'").get().n, 1);
    assert.ok(db.prepare('SELECT 1 FROM notify_subscriptions WHERE topic = ?').get('plugin:hello-neu:alarm'));
    assert.equal(db.prepare('SELECT 1 FROM notify_subscriptions WHERE topic = ?').get(topicOld), undefined);
    assert.ok(db.prepare('SELECT 1 FROM notify_rules WHERE event_id = ?').get('plugin:hello-neu:alarm'));
    const layout = JSON.parse(db.prepare("SELECT layout FROM client_layouts WHERE key = 't-replace'").get().layout);
    assert.deepEqual(layout.tiles.map((x) => x.plugin), ['hello-neu', 'hello-world'], 'only the whole id is swapped');
    assert.equal(db.prepare("SELECT value FROM settings WHERE key = 'plugins.media_quota.hello-neu'").get().value, '5');
    assert.equal(fs.existsSync(path.join(constants.pluginsRoot(), 'hello')), false);

    const h = plugins.history()[0];
    assert.equal(h.action, 'replace');
    assert.equal(h.id, 'hello');
    assert.equal(h.source, 'hello-neu');
  });

  it('a later update of the new plugin is an ordinary update', async () => {
    const { res } = await installPkg(helloPackage({ overrides: { ...NEW, version: '2.0.1' } }));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(registry.get('hello-neu').version, '2.0.1');
  });
});

describe('catalogue', () => {
  const catalog = require('../src/services/plugins/catalog');
  const GH = 'https://github.com/CallMeTechie/gatecontrol-plugins/releases/download';
  const entry = (id, version, extra = {}) => ({
    schema: 1, id, version, prerelease: false, gatecontrol: '>=1.0.0', license_required: false, size: 1000, sha256: 'a'.repeat(64),
    url: `${GH}/${id}-v${version}/${id}-${version}.gcplugin`, ...extra,
  });
  const cat = () => catalog.validate({ schema: 1, plugins: {
    'old-one': { id: 'old-one', name: 'Alt', publisher: 'T', versions: [entry('old-one', '1.6.0'), entry('old-one', '1.5.0')] },
    'new-one': { id: 'new-one', name: 'Neu', publisher: 'T', versions: [entry('new-one', '2.0.0', { replaces: ['old-one', 'Bad_ID', 'new-one'] })] },
  } });

  it('keeps `replaces` (bad values dropped) and lists only the new plugin', () => {
    const c = cat();
    assert.deepEqual([...c.plugins.get('new-one').replaces], ['old-one']);
    const v = catalog.view(c, 'de', () => null, '1.185.0');
    assert.deepEqual(v.map((x) => x.id), ['new-one']);
    assert.equal(v[0].state, 'not_installed');
    assert.equal(v[0].replaces, null);
  });

  it('with the old plugin installed, the new one is its update', () => {
    const installed = { 'old-one': { id: 'old-one', name: 'Alt', version: '1.5.0' } };
    const v = catalog.view(cat(), 'de', (id) => installed[id] || null, '1.185.0');
    assert.equal(v[0].state, 'update');
    assert.equal(v[0].installedVersion, '1.5.0');
    assert.deepEqual(v[0].replaces, { id: 'old-one', name: 'Alt', version: '1.5.0' });
  });

  it('updates: offered in place of the old plugin\'s own update, never automatically', async () => {
    const updates = require('../src/services/plugins/updates');
    const c = cat();
    db.prepare("INSERT INTO plugins (id, name, version, publisher, manifest, signature, enabled) VALUES ('old-one', 'Alt', '1.5.0', 'T', '{}', 'trusted', 1)").run();
    try {
      const ups = updates.available(c, 'de').filter((u) => u.id === 'old-one' || u.id === 'new-one');
      assert.equal(ups.length, 1);
      assert.equal(ups[0].id, 'new-one');
      assert.equal(ups[0].kind, 'replace');
      assert.equal(ups[0].from, '1.5.0');
      assert.equal(ups[0].replaces.id, 'old-one');
    } finally {
      db.prepare("DELETE FROM plugins WHERE id = 'old-one'").run();
    }
  });
});
