'use strict';
// Peers / Clients page (docs/feature-peers-page.md): GET /api/peers?type=,
// the counts for the licence line, the batch actions "group" and "tag",
// the sidebar badge (clients only) and the sidebar section of plugins.
const crypto = require('crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown, getAgent, getCsrf } = require('./helpers/setup');

let peers, getDb;
beforeEach(async () => { await setup(); peers = require('../src/services/peers'); getDb = require('../src/db/connection').getDb; });
afterEach(teardown);

async function client(name) { return (await peers.create({ name })).id; }
function gateway(name, ip, enabled = 1) {
  const db = getDb();
  const id = db.prepare("INSERT INTO peers (name, public_key, allowed_ips, enabled, peer_type) VALUES (?, ?, ?, ?, 'gateway')")
    .run(name, crypto.randomBytes(32).toString('base64'), ip + '/32', enabled).lastInsertRowid;
  db.prepare("INSERT INTO gateway_meta (peer_id, api_port, api_token_hash, push_token_encrypted, created_at, alive) VALUES (?, 9876, ?, 'e', 0, 1)")
    .run(id, crypto.randomBytes(8).toString('hex'));
  return id;
}

test('GET /api/peers?type=client leaves the gateways out; ?type=gateway only them; without type every peer', async () => {
  const a = await client('laptop'); const b = await client('phone');
  const g = gateway('pi', '10.8.0.250');
  const agent = getAgent();
  const c = (await agent.get('/api/v1/peers?type=client').expect(200)).body;
  assert.deepEqual(c.peers.map((p) => p.id).sort(), [a, b].sort());
  assert.deepEqual(c.counts, { clients: 2, gateways: 1, total: 3 });
  const gw = (await agent.get('/api/v1/peers?type=gateway').expect(200)).body;
  assert.deepEqual(gw.peers.map((p) => p.id), [g]);
  const all = (await agent.get('/api/v1/peers').expect(200)).body;
  assert.equal(all.peers.length, 3);
  const junk = (await agent.get('/api/v1/peers?type=bogus').expect(200)).body;
  assert.equal(junk.peers.length, 3, 'an unknown type is ignored');
});

test('the counts include disabled peers (like the vpn_peers licence count)', async () => {
  await client('one');
  gateway('off', '10.8.0.251', 0);
  const c = (await getAgent().get('/api/v1/peers?type=client').expect(200)).body;
  assert.deepEqual(c.counts, { clients: 1, gateways: 1, total: 2 });
});

test('batch "group" puts every peer into the group; null clears; an unknown group is 400', async () => {
  const a = await client('g1'); const b = await client('g2');
  const gid = getDb().prepare("INSERT INTO peer_groups (name) VALUES ('Familie')").run().lastInsertRowid;
  const agent = getAgent(); const csrf = getCsrf();
  const r = await agent.post('/api/v1/peers/batch').set('X-CSRF-Token', csrf).send({ action: 'group', ids: [a, b], group_id: gid }).expect(200);
  assert.equal(r.body.affected, 2);
  assert.equal(getDb().prepare('SELECT group_id FROM peers WHERE id = ?').get(b).group_id, gid);
  await agent.post('/api/v1/peers/batch').set('X-CSRF-Token', csrf).send({ action: 'group', ids: [a], group_id: null }).expect(200);
  assert.equal(getDb().prepare('SELECT group_id FROM peers WHERE id = ?').get(a).group_id, null);
  await agent.post('/api/v1/peers/batch').set('X-CSRF-Token', csrf).send({ action: 'group', ids: [a], group_id: 99999 }).expect(400);
});

test('batch "tag" adds the tag once (case-insensitive) and registers it; bad tags are 400', async () => {
  const a = await client('t1'); const b = await client('t2');
  await peers.update(a, { tags: 'Arbeit, server' });
  const agent = getAgent(); const csrf = getCsrf();
  const r = await agent.post('/api/v1/peers/batch').set('X-CSRF-Token', csrf).send({ action: 'tag', ids: [a, b], tag: 'SERVER' }).expect(200);
  assert.equal(r.body.affected, 1, 'peer a already had it');
  assert.equal(getDb().prepare('SELECT tags FROM peers WHERE id = ?').get(a).tags, 'Arbeit, server');
  assert.equal(getDb().prepare('SELECT tags FROM peers WHERE id = ?').get(b).tags, 'SERVER');
  assert.ok(getDb().prepare("SELECT 1 FROM tags WHERE name = 'SERVER' COLLATE NOCASE").get(), 'in the registry');
  for (const tag of ['', 'a,b', '<x>', 'x'.repeat(65)]) {
    await agent.post('/api/v1/peers/batch').set('X-CSRF-Token', csrf).send({ action: 'tag', ids: [a], tag }).expect(400);
  }
});

test('batch: unknown action, bad ids and missing peers are refused', async () => {
  const a = await client('x1');
  const agent = getAgent(); const csrf = getCsrf();
  await agent.post('/api/v1/peers/batch').set('X-CSRF-Token', csrf).send({ action: 'rename', ids: [a] }).expect(400);
  await agent.post('/api/v1/peers/batch').set('X-CSRF-Token', csrf).send({ action: 'tag', ids: ['1'], tag: 'x' }).expect(400);
  await agent.post('/api/v1/peers/batch').set('X-CSRF-Token', csrf).send({ action: 'tag', ids: [a, 987654], tag: 'x' }).expect(404);
  assert.equal(getDb().prepare('SELECT tags FROM peers WHERE id = ?').get(a).tags || '', '', 'nothing changed');
});

test('sidebar badge counts active clients only; the Gateways badge is absent while no gateway is offline', async () => {
  await client('c1'); const c2 = await client('c2');
  await peers.update(c2, { enabled: false });
  gateway('gw', '10.8.0.252');
  const html = (await getAgent().get('/dashboard').expect(200)).text;
  assert.match(html, /id="peer-count-badge">1</);
  assert.doesNotMatch(html, /id="gw-offline-badge"/);
});

test('plugin sidebar section: manifest ui.nav.section, the built-in mapping, else "apps"', () => {
  const manifest = require('../src/services/plugins/manifest');
  const hello = JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname, 'fixtures', 'plugins', 'hello', 'plugin.json'), 'utf8'));
  const withSection = (sec) => { const m = JSON.parse(JSON.stringify(hello)); m.ui.nav.section = sec; return manifest.validate(m); };
  assert.equal(withSection('home').manifest.ui.nav.section, 'home');
  assert.equal(withSection('devices').manifest.ui.nav.section, 'devices');
  const unknown = withSection('kitchen');
  assert.deepEqual(unknown.errors, [], 'an unknown section is ignored, not an error');
  assert.equal(unknown.manifest.ui.nav.section, undefined);
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src', 'services', 'plugins', 'index.js'), 'utf8');
  assert.match(src, /'gatecontrol-proxmox': 'devices'/);
  assert.match(src, /'gatecontrol-smarthome': 'home'/);
  assert.match(src, /return NAV_SECTION_BUILTIN\[p\.id\] \|\| 'apps';/);
});
