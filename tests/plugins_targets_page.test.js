'use strict';

// Zugriffsziele from the plugin's own admin page (permissions.network.assignTargets,
// since 1.324.0, docs/plugins.md "Network"): window.GC.targets in the admin frames,
// the admin API …/page-targets with the same checks and records as the card under
// Einstellungen › Plugins › <plugin> › Zugriffsziele — and the fixes around it
// (GC.openSettings leaves no dim behind, the route picker starts without a choice).

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { helloPackage, HELLO } = require('./helpers/plugins');
const { setup, teardown, getCsrf } = require('./helpers/setup');

let agent, csrf, runtime, plugins, db;
const API = '/api/v1/plugins';
const manifestOf = () => JSON.parse(fs.readFileSync(path.join(HELLO, 'plugin.json'), 'utf8'));

function withAssign(version) {
  const m = manifestOf();
  return helloPackage({ overrides: { version, permissions: { ...m.permissions, network: { ...m.permissions.network, assignTargets: true } } } });
}

async function install(buf) {
  const r = await agent.post(API + '/inspect').set('X-CSRF-Token', csrf).set('Content-Type', 'application/octet-stream').send(buf).expect(200);
  assert.equal(r.body.canInstall, true, JSON.stringify(r.body.checks));
  await agent.post(API + '/install').set('X-CSRF-Token', csrf).send({ token: r.body.token, accept: true }).expect(200);
  assert.equal(await runtime.waitRunning('hello'), true);
}

function peer(name, ip, type = 'client') {
  return Number(db.prepare('INSERT INTO peers (name, public_key, allowed_ips, enabled, peer_type) VALUES (?, ?, ?, 1, ?)').run(name, 'pk-' + name, ip + '/32', type).lastInsertRowid);
}
function route(fields) {
  const f = { route_type: 'http', target_ip: '', target_port: 80, enabled: 1, ...fields };
  const cols = Object.keys(f);
  return Number(db.prepare(`INSERT INTO routes (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map((c) => f[c])).lastInsertRowid);
}

let gwRoute, peerRoute, nas;

before(async () => {
  ({ agent } = await setup());
  csrf = getCsrf();
  runtime = require('../src/services/plugins/runtime');
  plugins = require('../src/services/plugins');
  db = require('../src/db/connection').getDb();
  await install(helloPackage());
  const gw = peer('Gateway Wohnung', '10.8.0.20', 'gateway');
  nas = peer('NAS', '10.8.0.31');
  gwRoute = route({ domain: 'jellyfin.example.com', target_kind: 'gateway', target_peer_id: gw, target_lan_host: '192.168.2.151', target_lan_port: 8096, target_port: 8096, https_enabled: 1 });
  peerRoute = route({ domain: 'media.example.test', peer_id: nas, target_ip: '10.8.0.31', target_port: 8920, backend_https: 1, https_enabled: 0 });
});
after(async () => {
  await plugins.stop();
  teardown();
});

describe('plugin.json', () => {
  const { validate } = require('../src/services/plugins/manifest');
  it('assignTargets needs homeTargets and is a boolean', () => {
    const m = manifestOf();
    const net = (n) => validate({ ...m, permissions: { ...m.permissions, network: n } });
    assert.equal(net({ ...m.permissions.network, assignTargets: true }).ok, true);
    assert.ok(net({ internet: [], assignTargets: true }).errors.includes('permissions.network.assignTargets: needs homeTargets'));
    assert.ok(net({ ...m.permissions.network, assignTargets: 'yes' }).errors.includes('permissions.network.assignTargets: invalid'));
  });
});

describe('without the permission', () => {
  it('the API refuses and the frame has no GC.targets', async () => {
    const r = await agent.get(API + '/hello/page-targets').expect(403);
    assert.equal(r.body.code, 'not_allowed');
    await agent.put(API + '/hello/page-targets/gateway').set('X-CSRF-Token', csrf).send({ assigned: [] }).expect(403);
    const f = await agent.get('/plugins/hello/frame/main').expect(200);
    assert.match(f.text, /if \(false\) api\.targets = targetsApi;/);
    const v = await agent.get(API + '/hello').expect(200);
    assert.equal(v.body.plugin.assignTargets, false);
    assert.equal(v.body.plugin.permissions.network.assignTargets, undefined);
  });
});

describe('with permissions.network.assignTargets', () => {
  before(async () => { await install(withAssign('1.0.1')); });

  it('is shown as a permission and the admin frame gets GC.targets', async () => {
    const v = await agent.get(API + '/hello').expect(200);
    assert.equal(v.body.plugin.permissions.network.assignTargets, true);
    assert.equal(v.body.plugin.assignTargets, true);
    const f = await agent.get('/plugins/hello/frame/main').expect(200);
    assert.match(f.text, /if \(true\) api\.targets = targetsApi;/);
  });

  it('lists the declared targets with routes (domain, HTTPS, backend) and peers', async () => {
    const r = await agent.get(API + '/hello/page-targets').expect(200);
    assert.deepEqual(r.body.targets.map((t) => [t.id, t.multiple, t.assigned.length]), [['gateway', false, 0], ['device', true, 0]]);
    const gw = r.body.routes.find((x) => x.id === gwRoute);
    assert.equal(gw.domain, 'jellyfin.example.com');
    assert.equal(gw.https, true);
    assert.equal(gw.gateway, true);
    assert.deepEqual(gw.backend, { scheme: 'http', host: '192.168.2.151', port: 8096, via: 'gateway' });
    const pr = r.body.routes.find((x) => x.id === peerRoute);
    assert.equal(pr.https, false);
    assert.deepEqual(pr.backend, { scheme: 'https', host: '10.8.0.31', port: 8920, via: 'peer' });
    assert.ok(r.body.peers.some((p) => p.id === nas && p.ip === '10.8.0.31'));
  });

  it('assigns a route like the card and records it', async () => {
    const r = await agent.put(API + '/hello/page-targets/gateway').set('X-CSRF-Token', csrf).send({ assigned: [{ kind: 'route', routeId: gwRoute }] }).expect(200);
    assert.deepEqual(r.body.assigned.map((a) => [a.kind, a.routeId, a.display]), [['route', gwRoute, 'jellyfin.example.com']]);
    const card = await agent.get(API + '/hello/targets').expect(200);
    assert.deepEqual(card.body.declared.find((d) => d.id === 'gateway').assigned.map((a) => a.routeId), [gwRoute]);
    const log = db.prepare("SELECT message, details, source FROM activity_log WHERE event_type = 'plugin_target_changed' ORDER BY id DESC LIMIT 1").get();
    assert.equal(log.source, 'admin');
    assert.match(log.message, /on the plugin’s page/);
    assert.equal(JSON.parse(log.details).via, 'plugin_page');
  });

  it('the same checks: unknown routes, too many, undeclared targets, CSRF', async () => {
    const u = await agent.put(API + '/hello/page-targets/gateway').set('X-CSRF-Token', csrf).send({ assigned: [{ kind: 'route', routeId: 999999 }] }).expect(400);
    assert.equal(u.body.code, 'unknown_route');
    const m = await agent.put(API + '/hello/page-targets/gateway').set('X-CSRF-Token', csrf)
      .send({ assigned: [{ kind: 'route', routeId: gwRoute }, { kind: 'route', routeId: peerRoute }] }).expect(400);
    assert.equal(m.body.code, 'too_many_targets');
    const n = await agent.put(API + '/hello/page-targets/nope').set('X-CSRF-Token', csrf).send({ assigned: [] }).expect(400);
    assert.equal(n.body.code, 'unknown_target');
    await agent.put(API + '/hello/page-targets/gateway').send({ assigned: [] }).expect(403);
  });

  it('an address stays the administrator’s: kept or removed, never added', async () => {
    const add = await agent.put(API + '/hello/page-targets/device').set('X-CSRF-Token', csrf).send({ assigned: [{ kind: 'host', host: '192.168.1.60', port: 6444 }] }).expect(400);
    assert.equal(add.body.code, 'invalid_target');
    await agent.put(API + '/hello/targets/device').set('X-CSRF-Token', csrf).send({ assigned: [{ kind: 'host', host: '192.168.1.60', port: 6444 }] }).expect(200);
    const cur = (await agent.get(API + '/hello/page-targets').expect(200)).body.targets.find((t) => t.id === 'device').assigned;
    const keep = await agent.put(API + '/hello/page-targets/device').set('X-CSRF-Token', csrf).send({ assigned: cur.concat([{ kind: 'peer', peerId: nas, port: 6444 }]) }).expect(200);
    assert.deepEqual(keep.body.assigned.map((a) => a.kind), ['host', 'peer']);
    const changed = await agent.put(API + '/hello/page-targets/device').set('X-CSRF-Token', csrf)
      .send({ assigned: [{ kind: 'host', host: '192.168.1.61', port: 6444 }, { kind: 'peer', peerId: nas, port: 6444 }] }).expect(400);
    assert.equal(changed.body.code, 'invalid_target');
    const removed = await agent.put(API + '/hello/page-targets/device').set('X-CSRF-Token', csrf).send({ assigned: [{ kind: 'peer', peerId: nas, port: 6444 }] }).expect(200);
    assert.deepEqual(removed.body.assigned.map((a) => a.kind), ['peer']);
  });

  it('the portal frame never gets GC.targets', () => {
    const frame = require('../src/services/plugins/frame');
    const doc = frame.document({ html: '', lang: 'de' });
    assert.match(doc, /if \(false\) api\.targets = targetsApi;/);
    assert.match(frame.document({ html: '', lang: 'de', targets: true }), /if \(true\) api\.targets = targetsApi;/);
  });
});

describe('page scripts', () => {
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', 'js', f), 'utf8');
  it('plugin-bridge.js: GC.targets only for data-plugin-targets on admin pages, through …/page-targets', () => {
    const src = read('plugin-bridge.js');
    assert.match(src, /frame\.getAttribute\('data-plugin-targets'\) != null && base\.indexOf\('\/api\/v1\/plugins\/'\) === 0/);
    assert.match(src, /base\.replace\(\/api\\\/\$\/, 'page-targets'\)/);
    assert.match(src, /m\.type === 'gc-targets' && Number\.isInteger\(m\.id\)\) targetOp\(m\)/);
  });
  it('plugin-bridge.js: GC.openSettings ends the frame’s dim and the page’s dialogs, the top window loads', () => {
    const src = read('plugin-bridge.js');
    assert.match(src, /m\.type === 'gc-settings'\) \{\s*\/\/[^\n]*\n\s*if \(pluginId && !base\.includes\('\/portal\/'\)\) \{ setModal\(false\); openPluginTab\(pluginId, 'settings'\); \}/);
    assert.match(src, /function openPluginTab\(pluginId, tab\) \{[\s\S]*?closeDialogs\(\);[\s\S]*?topWindow\(\)\.location\.assign/);
    assert.match(src, /if \(frameGone\(\)\) setModal\(false\)/);
  });
  it('plugins-page.js: the route and peer pickers start without a choice, Zuweisen only with one', () => {
    const src = read('plugins-page.js');
    assert.match(src, /pick\('plugins\.tg\.pick_route'\)/);
    assert.match(src, /pick\('plugins\.tg\.pick_peer'\)/);
    assert.match(src, /add\.disabled = !v;/);
    assert.match(src, /if \(p\.assignTargets\) attrs\['data-plugin-targets'\] = '';/);
    for (const l of ['de', 'en']) {
      const s = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'i18n', l + '.json'), 'utf8'));
      for (const k of ['plugins.tg.pick_route', 'plugins.tg.pick_peer', 'plugins.perm.assign_targets', 'plugins.perm.assign_targets_on', 'plugins.err.target_not_allowed']) assert.ok(s[k], l + ' ' + k);
    }
  });
  it('plugins-ui.js: assignTargets is a sensitive permission row', () => {
    const P = require('../public/js/plugins-ui.js');
    const perm = { network: { internet: [], homeTargets: [{ id: 'x', label: 'X', protocols: ['http'] }], discovery: null, assignTargets: true } };
    assert.ok(P.permRows(perm, (k) => k).some((r) => r.label === 'plugins.perm.assign_targets'));
    assert.ok(P.sensitivePerms(perm).includes('plugins.perm.assign_targets'));
  });
});
