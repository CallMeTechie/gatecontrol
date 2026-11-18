'use strict';

// "Meine Orte" in the backup (services/backup.js): the places with their ids — the plugins keep the reference
// 'profile:<id>' — and "Genutzt von"; a row that breaks the rules of services/places.js is skipped on restore.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown } = require('./helpers/setup');

before(async () => {
  await setup();
  require('../src/services/peers').rewriteWgConfig = async () => {};
  require('../src/services/routes').syncToCaddy = async () => {};
  require('../src/services/caddyConfig').syncToCaddy = async () => true;
});
after(() => teardown());

function db() { return require('../src/db/connection').getDb(); }
const backup = () => require('../src/services/backup');
const places = () => require('../src/services/places');

describe('backup round trip with places', () => {
  let anna, home, work;
  before(() => {
    anna = Number(db().prepare("INSERT INTO users (username, display_name, password_hash, role, enabled) VALUES ('bk-pl-anna', 'Anna', 'hash', 'user', 1)").run().lastInsertRowid);
    home = places().create(anna, { name: 'Zuhause', lat: 50.110922, lon: 8.682127, icon: 'home', radiusM: 120, address: 'Lindenweg 12', visibility: 'family' });
    work = places().create(anna, { name: 'Arbeit', lat: 50.12, lon: 8.69 });
    places().reportUsage('gatecontrol-notizen', { userId: anna, id: work.id, kind: 'task', count: 2 });
  });

  it('exports the places with their ids and the owner by user name; the summary counts them', async () => {
    const b = await backup().createBackup();
    const h = b.data.user_places.find((p) => p.id === home.id);
    assert.deepEqual([h.user_name, h.name, h.icon, h.lat, h.lon, h.radius_m, h.address, h.visibility, h.source],
      ['bk-pl-anna', 'Zuhause', 'home', 50.110922, 8.682127, 120, 'Lindenweg 12', 'family', 'manual']);
    assert.deepEqual(b.data.user_place_usage.filter((x) => x.place_id === work.id).map((x) => [x.plugin, x.kind, x.count]), [['gatecontrol-notizen', 'task', 2]]);
    assert.equal(backup().getBackupSummary(b).user_places, 2);
  });

  it('restores them under the same ids; a broken row is skipped', async () => {
    const b = JSON.parse(JSON.stringify(await backup().createBackup()));
    b.data.user_places.push({ ...b.data.user_places[0], id: 999001, name: 'Null', lat: 0, lon: 0 });
    b.data.user_places.push({ ...b.data.user_places[0], id: 999002, name: 'Zu groß', radius_m: 5000 });
    db().prepare('DELETE FROM user_places').run();
    await backup().restoreBackup(b);
    const uid = db().prepare("SELECT id FROM users WHERE username = 'bk-pl-anna'").get().id;
    const rows = db().prepare('SELECT id, user_id, name FROM user_places ORDER BY id').all();
    assert.deepEqual(rows, [{ id: home.id, user_id: uid, name: 'Zuhause' }, { id: work.id, user_id: uid, name: 'Arbeit' }]);
    assert.deepEqual(db().prepare('SELECT place_id, plugin, kind, count FROM user_place_usage').all(), [{ place_id: work.id, plugin: 'gatecontrol-notizen', kind: 'task', count: 2 }]);
    assert.equal(places().placeFor(home.id, null).ref, `profile:${home.id}`);
  });
});
