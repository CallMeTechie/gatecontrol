'use strict';

// Routenschutz (services/routeGuard.js) and VPN misuse (services/vpnGuard.js):
// risk per route, "Nur über VPN", "Ist Absicht" (void after a change), the
// defaults for new routes, the API; endpoint flapping and new countries
// (fake country lookup — no network).

const crypto = require('node:crypto');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown, getAgent, getCsrf } = require('./helpers/setup');

let agent, csrf, db, guard, vpn, license, caddy, routes;
const GET = (p) => agent.get('/api/v1' + p);
const PUT = (p, b) => agent.put('/api/v1' + p).set('X-CSRF-Token', csrf).send(b);
const POST = (p, b) => agent.post('/api/v1' + p).set('X-CSRF-Token', csrf).send(b || {});
const DEL = (p) => agent.delete('/api/v1' + p).set('X-CSRF-Token', csrf);

function insertRoute(domain, extra = {}) {
  const cols = { domain, target_ip: '10.0.0.5', target_port: 80, route_type: 'http', https_enabled: 0, external_enabled: 1, ...extra };
  const keys = Object.keys(cols);
  return db.prepare(`INSERT INTO routes (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...keys.map((k) => cols[k])).lastInsertRowid;
}
const byId = (id) => guard.overview().routes.find((r) => r.id === id);

before(async () => {
  await setup();
  agent = getAgent();
  csrf = getCsrf();
  db = require('../src/db/connection').getDb();
  guard = require('../src/services/routeGuard');
  vpn = require('../src/services/vpnGuard');
  license = require('../src/services/license');
  caddy = require('../src/services/caddyConfig');
  routes = require('../src/services/routes');
  caddy.syncToCaddy = async () => {};
});

after(() => { teardown(); });

beforeEach(() => {
  db.prepare('DELETE FROM route_guard_acks').run();
  db.prepare('DELETE FROM routes').run();
  db.prepare("DELETE FROM settings WHERE key IN ('routeguard.defaults', 'vpnguard.config', 'ip2location.api_key')").run();
  license._overrideForTest({ waf: false, ip_access_control: false, rate_limiting: false });
});

test('risk: admin interface without login is high, open gallery is "check", login / VPN is low', () => {
  const prox = insertRoute('proxmox.example.de', { target_ip: '192.168.178.20', target_port: 8006 });
  const fotos = insertRoute('fotos.example.de', { target_port: 2342 });
  const nas = insertRoute('nas.example.de', { external_enabled: 0, target_port: 5001 });
  const cloud = insertRoute('cloud.example.de', { basic_auth_enabled: 1, basic_auth_user: 'a', basic_auth_password_hash: 'x' });
  const ssh = db.prepare("INSERT INTO routes (domain, target_ip, target_port, route_type, l4_protocol, l4_listen_port, external_enabled) VALUES (NULL, '10.0.0.6', 22, 'l4', 'tcp', '2222', 1)").run().lastInsertRowid;
  const off = insertRoute('router.example.de', { enabled: 0 });
  assert.equal(byId(prox).risk, 'high');
  assert.deepEqual(byId(prox).reasons, ['admin_port', 'no_login', 'no_waf']);
  assert.equal(byId(fotos).risk, 'check');
  assert.equal(byId(nas).risk, 'low');
  assert.equal(byId(nas).access, 'vpn');
  assert.equal(byId(cloud).risk, 'low');
  assert.equal(byId(cloud).auth.kind, 'basic');
  assert.equal(byId(ssh).risk, 'high');
  assert.equal(byId(off).risk, 'low');
  const ov = guard.overview();
  assert.equal(ov.stats.total, 5);
  assert.equal(ov.stats.open, 3);
  assert.deepEqual(ov.attention.slice(0, 2).map((a) => a.risk), ['high', 'high'], 'high first');
  assert.ok(ov.attention.slice(0, 2).some((a) => a.id === prox));
  assert.equal(ov.attention.length, 3);
});

test('a name like "router" counts like an admin port', () => {
  const id = insertRoute('router.example.de', { target_port: 80 });
  assert.equal(byId(id).risk, 'high');
  assert.equal(byId(id).reasons[0], 'admin_name');
});

test('"Ist Absicht" confirms, a change of the route asks again', () => {
  const id = insertRoute('fotos.example.de');
  guard.acknowledge(id, 1);
  assert.equal(byId(id).risk, 'ack');
  assert.ok(!guard.overview().attention.some((a) => a.id === id));
  db.prepare('UPDATE routes SET target_port = 8080 WHERE id = ?').run(id);
  assert.equal(byId(id).risk, 'check', 'another target → asked again');
  guard.acknowledge(id, 1);
  guard.unacknowledge(id);
  assert.equal(byId(id).risk, 'check');
});

test('"Nur über VPN" sets external_enabled = 0 through the bulk update', async () => {
  const id = insertRoute('proxmox.example.de', { target_port: 8006 });
  const r = await guard.vpnOnly(id, 1);
  assert.equal(r.access, 'vpn');
  assert.equal(r.risk, 'low');
  assert.equal(db.prepare('SELECT external_enabled FROM routes WHERE id = ?').get(id).external_enabled, 0);
});

test('peer ACL with listed devices counts as "nur bestimmte Geräte"', () => {
  const id = insertRoute('grafana.example.de', { acl_enabled: 1 });
  db.prepare("INSERT INTO peers (name, public_key, private_key_encrypted, allowed_ips) VALUES ('p1', 'k1', 'x', '10.8.0.9/32')").run();
  const pid = db.prepare("SELECT id FROM peers WHERE name = 'p1'").get().id;
  db.prepare('INSERT INTO route_peer_acl (route_id, peer_id) VALUES (?, ?)').run(id, pid);
  assert.equal(byId(id).access, 'peers');
  assert.equal(byId(id).risk, 'low');
  db.prepare('DELETE FROM peers WHERE id = ?').run(pid);
});

test('defaults: validated, licence-gated, applied to fields a new route leaves open', async () => {
  assert.deepEqual(guard.getDefaults(), { access: 'vpn', waf: false, countries: 'all', rate_limit: 0 });
  assert.throws(() => guard.setDefaults({ waf: true }), (e) => e.feature === 'waf');
  assert.throws(() => guard.setDefaults({ access: 'lan' }), (e) => e.field === 'access');
  license._overrideForTest({ waf: true, ip_access_control: true, rate_limiting: true });
  assert.throws(() => guard.setDefaults({ countries: 'de_eu' }), (e) => e.code === 'geo_key', 'countries need a Geo-IP key');
  db.prepare("INSERT INTO settings (key, value) VALUES ('ip2location.api_key', 'k')").run();
  guard.setDefaults({ access: 'internet', waf: true, countries: 'dach', rate_limit: 300 });
  const d = guard.applyDefaults({}, { routeType: 'http' });
  assert.equal(d.external_enabled, true);
  assert.equal(d.waf_enabled, true);
  assert.equal(d.ip_filter_mode, 'whitelist');
  assert.deepEqual(d.ip_filter_rules.map((r) => r.value), ['DE', 'AT', 'CH']);
  assert.equal(d.rate_limit_requests, 300);
  // explicit values win
  const e = guard.applyDefaults({ external_enabled: false, ip_filter_enabled: false, rate_limit_enabled: false }, { routeType: 'http', hasWafInput: true });
  assert.equal(e.external_enabled, false);
  assert.equal(e.waf_enabled, undefined);
  assert.equal(e.ip_filter_enabled, false);
  // L4: only the access
  assert.deepEqual(guard.applyDefaults({}, { routeType: 'l4' }), { external_enabled: true });
  // routes.create uses them
  const route = await routes.create({ domain: 'neu.example.de', target_ip: '10.0.0.7', target_port: 80, https_enabled: false });
  const row = db.prepare('SELECT * FROM routes WHERE id = ?').get(route.id);
  assert.equal(row.external_enabled, 1);
  assert.equal(row.waf_enabled, 1);
  assert.equal(row.rate_limit_enabled, 1);
  assert.equal(row.rate_limit_requests, 300);
  assert.equal(row.ip_filter_enabled, 1);
});

test('API: overview, defaults with field errors, actions', async () => {
  const id = insertRoute('proxmox.example.de', { target_port: 8006 });
  let r = await GET('/settings/route-guard');
  assert.equal(r.status, 200);
  assert.equal(r.body.attention[0].risk, 'high');
  assert.equal(r.body.vpn.two_places, 'warn');
  r = await PUT('/settings/route-guard', { defaults: { rate_limit: -1 } });
  assert.equal(r.status, 400);
  assert.ok(r.body.fields.rate_limit);
  r = await PUT('/settings/route-guard', { vpn: { two_places: 'block', new_country: 'off' } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.vpn, { two_places: 'block', new_country: 'off' });
  r = await POST(`/settings/route-guard/routes/${id}/ack`);
  assert.equal(r.body.route.risk, 'ack');
  r = await DEL(`/settings/route-guard/routes/${id}/ack`);
  assert.equal(r.body.route.risk, 'high');
  r = await POST(`/settings/route-guard/routes/${id}/vpn-only`);
  assert.equal(r.status, 200);
  assert.equal(r.body.route.access, 'vpn');
  r = await POST('/settings/route-guard/routes/999999/ack');
  assert.equal(r.status, 404);
});

// ─── VPN misuse ─────────────────────────────────────

test('flapping: back and forth between two addresses, not a phone that roams', () => {
  const at = Date.now();
  const flip = [];
  for (let i = 0; i < 8; i++) flip.push({ ip: i % 2 ? '91.1.1.1' : '85.2.2.2', at: at - (8 - i) * 60e3 });
  assert.deepEqual(vpn.flapping(flip, at).ips.sort(), ['85.2.2.2', '91.1.1.1']);
  const roam = [{ ip: '91.1.1.1', at: at - 600e3 }, { ip: '85.2.2.2', at: at - 300e3 }, { ip: '91.1.1.1', at: at - 60e3 }];
  assert.equal(vpn.flapping(roam, at), null);
  assert.equal(vpn.endpointIp('192.168.1.5:51820'), null, 'private endpoints are ignored');
  assert.equal(vpn.endpointIp('[2a01:4f8::1]:51820'), '2a01:4f8::1');
});

test('observe: warns once for a shared key, blocks when set so, warns for a new country', async () => {
  db.prepare("INSERT INTO peers (name, public_key, private_key_encrypted, allowed_ips, enabled) VALUES ('Handy', 'KEYA', 'x', '10.8.0.10/32', 1)").run();
  const peer = db.prepare("SELECT id, name FROM peers WHERE public_key = 'KEYA'").get();
  const byKey = new Map([['KEYA', peer]]);
  const countries = { '91.1.1.1': 'DE', '85.2.2.2': 'DE', '45.3.3.3': 'RU' };
  vpn._resetForTest({ lookup: async (ip) => countries[ip] || null });
  db.prepare("DELETE FROM activity_log WHERE event_type LIKE 'vpn_%'").run();
  const t0 = Date.now() - 10 * 60e3;
  for (let i = 0; i < 12; i++) {
    await vpn.observe([{ publicKey: 'KEYA', endpoint: (i % 2 ? '91.1.1.1' : '85.2.2.2') + ':51820' }], byKey, t0 + i * 30e3);
  }
  const shared = db.prepare("SELECT * FROM activity_log WHERE event_type = 'vpn_key_shared'").all();
  assert.equal(shared.length, 1, 'once, not on every poll');
  assert.equal(JSON.parse(shared[0].details).blocked, false);
  // a new country
  await vpn.observe([{ publicKey: 'KEYA', endpoint: '45.3.3.3:51820' }], byKey, t0 + 13 * 30e3);
  const nc = db.prepare("SELECT * FROM activity_log WHERE event_type = 'vpn_new_country'").all();
  assert.equal(nc.length, 1);
  assert.equal(JSON.parse(nc[0].details).country, 'RU');
  // block mode: the peer is switched off
  vpn.setConfig({ two_places: 'block' });
  vpn._resetForTest({ lookup: async () => null });
  const peersSvc = require('../src/services/peers');
  const origToggle = peersSvc.toggle;
  let toggled = null;
  peersSvc.toggle = async (id) => { toggled = id; db.prepare('UPDATE peers SET enabled = 0 WHERE id = ?').run(id); };
  try {
    for (let i = 0; i < 12; i++) {
      await vpn.observe([{ publicKey: 'KEYA', endpoint: (i % 2 ? '91.1.1.1' : '85.2.2.2') + ':51820' }], byKey, t0 + i * 30e3);
    }
  } finally { peersSvc.toggle = origToggle; }
  assert.equal(toggled, peer.id);
  db.prepare('DELETE FROM peers WHERE id = ?').run(peer.id);
});

test('settings start page: open routes appear under "Braucht deine Aufmerksamkeit" with the state of both pages', () => {
  insertRoute('proxmox.example.de', { target_port: 8006 });
  insertRoute('fotos.example.de');
  const ov = require('../src/services/settingsOverview').build({ lang: 'de' });
  const kinds = ov.attention.map((r) => r.kind);
  assert.ok(kinds.includes('route_open_high'));
  assert.ok(kinds.includes('route_open_check'));
  assert.equal(ov.attention.find((r) => r.kind === 'route_open_high').href, '/settings/routenschutz');
  assert.equal(ov.states.routenschutz.key, 'st.state.routes_open');
  assert.equal(ov.states.ipsperre.key, 'st.state.blocked_now');
});

test('backup: confirmations travel by domain, bans by hand are kept', () => {
  const id = insertRoute('fotos.example.de');
  guard.acknowledge(id, 1);
  const acks = guard.exportBackup();
  assert.equal(acks.length, 1);
  db.prepare('DELETE FROM route_guard_acks').run();
  assert.equal(guard.restoreBackup(acks), 1);
  assert.equal(byId(id).risk, 'ack');
  const ipBlock = require('../src/services/ipBlock');
  ipBlock.banManual({ ip: '185.220.102.0/24', hours: null });
  const bans = ipBlock.exportBackup();
  db.prepare('DELETE FROM ip_blocks').run();
  assert.equal(ipBlock.restoreBackup(bans), 1);
  assert.deepEqual(ipBlock.check('185.220.102.9'), { by: 'ban' });
  db.prepare('DELETE FROM ip_blocks').run();
  ipBlock.rebuild();
});
