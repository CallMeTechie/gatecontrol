'use strict';

// Gateways page with pools: the pure rules (public/js/gateway-pool-kit.js) and
// the static contract of the new views (gateway-pools-ui.js, gateways.js,
// gateway-net.js): every text exists in German and English with the same
// placeholders, no innerHTML, the tab "Funktionen" carries every switch row.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const PK = require('../public/js/gateway-pool-kit');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const de = JSON.parse(read('src/i18n/de.json'));
const en = JSON.parse(read('src/i18n/en.json'));

const gw = (id, extra) => ({ peer_id: id, name: 'G' + id, status: 'online', routes: [], health: { telemetry: {} }, ...extra });
const tel = (subnets, router) => ({ health: { telemetry: { lan_subnets: subnets.map((cidr) => ({ cidr })), default_gateway_ip: router } } });

describe('gateway-pool-kit: hash, groups, roles, status', () => {
  it('#pool/<id> ↔ { id }; anything else is no pool address', () => {
    assert.deepEqual(PK.parsePoolHash('#pool/7'), { id: 7 });
    assert.equal(PK.parsePoolHash('#pool/0'), null);
    assert.equal(PK.parsePoolHash('#pool/x'), null);
    assert.equal(PK.parsePoolHash('#gw/7'), null);
  });

  it('fleetGroups: one group per pool in priority order, a gateway in two pools in both, the rest single', () => {
    const gws = [gw(1), gw(2), gw(3), gw(4)];
    const pools = [
      { id: 10, members: [{ peer_id: 2, priority: 2 }, { peer_id: 1, priority: 1 }, { peer_id: 99, priority: 3 }] },
      { id: 11, members: [{ peer_id: 2, priority: 1 }, { peer_id: 3, priority: 2 }] },
    ];
    const r = PK.fleetGroups(gws, pools);
    assert.deepEqual(r.groups.map((g) => g.members.map((m) => m.g.peer_id)), [[1, 2], [2, 3]], 'disabled member 99 left out');
    assert.deepEqual(r.singles.map((g) => g.peer_id), [4]);
    assert.deepEqual(PK.poolsOf(pools, 2).map((p) => p.id), [10, 11]);
  });

  it('roleOf: rank, serving / reserve / recovering with minutes / offline; load balancing', () => {
    const pool = { mode: 'failover', members: [{ peer_id: 1, priority: 1, state: 'recovering', failback_at: 1000 + 5 * 60000 - 1 }, { peer_id: 2, priority: 2, state: 'active' }, { peer_id: 3, priority: 3, state: 'offline' }] };
    assert.deepEqual(PK.roleOf(pool, pool.members[1], 1000), { tone: 'blue', key: 'gwp.role.active', params: { n: 2 } });
    assert.deepEqual(PK.roleOf(pool, pool.members[0], 1000), { tone: 'amber', key: 'gwp.role.recovering_in', params: { n: 1, min: 5 } });
    assert.equal(PK.roleOf(pool, pool.members[2]).key, 'gwp.role.offline');
    assert.equal(PK.roleOf({ ...pool, mode: 'load_balancing' }, pool.members[1]).key, 'gwp.role.lb_active');
    assert.equal(PK.roleOf(pool, { peer_id: 4, priority: 9, state: 'standby' }).key, 'gwp.role.standby');
    assert.equal(PK.activeMember({ active_peer_ids: [2], members: pool.members }).peer_id, 2);
    assert.equal(PK.activeMember({ active_peer_ids: [], members: pool.members }), null);
  });

  it('statusTone covers every server status', () => {
    for (const s of ['protected', 'on_reserve', 'no_reserve', 'single', 'down', 'off']) assert.ok(['green', 'amber', 'red', 'grey'].includes(PK.statusTone(s)), s);
    assert.equal(PK.statusTone('protected'), 'green');
    assert.equal(PK.statusTone('down'), 'red');
  });
});

describe('gateway-pool-kit: failback presets and durations', () => {
  it('the presets of the former page, proposal from the platform of the first gateway', () => {
    assert.deepEqual(PK.COOLDOWN_PRESETS.map((p) => p.s), [30, 60, 180, 600, 900, 1800, 3600]);
    assert.equal(PK.proposeCooldown('synology').s, 900);
    assert.equal(PK.proposeCooldown('proxmox').s, 600);
    assert.equal(PK.proposeCooldown('rpi').s, 180);
    assert.equal(PK.proposeCooldown('linux').s, 180);
    assert.equal(PK.proposeCooldown(null).s, 180);
    assert.equal(PK.presetFor(900).key, 'nas');
    assert.equal(PK.presetFor(901), null);
  });
  it('durations in plain words', () => {
    assert.deepEqual(PK.duration(90), { key: 'gwp.dur.s', n: 90 });
    assert.deepEqual(PK.duration(1), { key: 'gwp.dur.s_one', n: 1 });
    assert.deepEqual(PK.duration(180), { key: 'gwp.dur.min', n: 3 });
    assert.deepEqual(PK.duration(900), { key: 'gwp.dur.min', n: 15 });
    assert.deepEqual(PK.duration(3600), { key: 'gwp.dur.h_one', n: 1 });
    assert.deepEqual(PK.duration(7200), { key: 'gwp.dur.h', n: 2 });
  });
});

describe('gateway-pool-kit: same LAN and the hint card', () => {
  it('sameLan: overlapping private subnets, not with different routers, never with itself', () => {
    const a = gw(1, tel(['192.168.178.0/24'], '192.168.178.1'));
    const b = gw(2, tel(['192.168.178.0/24'], '192.168.178.1'));
    const c = gw(3, tel(['192.168.178.0/24'], '192.168.178.254'));
    const d = gw(4, tel(['192.168.0.0/16']));
    const e = gw(5, tel(['10.8.0.0/24', '172.20.0.0/16']));
    assert.equal(PK.sameLan(a, b), '192.168.178.0/24');
    assert.equal(PK.sameLan(a, c), null, 'another router: another household');
    assert.equal(PK.sameLan(a, d), '192.168.0.0/16', 'the wider subnet');
    assert.equal(PK.sameLan(a, e), null);
    assert.equal(PK.sameLan(a, a), null);
    assert.equal(PK.sameLan(gw(6, tel(['8.8.8.0/24'])), gw(7, tel(['8.8.8.0/24']))), null, 'public subnets do not count');
  });
  it('suggestion: the single gateway with most routes, a partner in the same LAN when there is one', () => {
    const a = gw(1, { ...tel(['192.168.1.0/24']), routes: [{ id: 1 }, { id: 2 }] });
    const b = gw(2, tel(['192.168.1.0/24']));
    const c = gw(3, { ...tel(['10.0.0.0/24']), routes: [{ id: 3 }] });
    assert.deepEqual(PK.suggestion([c, a, b]), { g: a, partner: b, lan: '192.168.1.0/24' });
    assert.deepEqual(PK.suggestion([c]), { g: c, partner: null, lan: null });
    assert.equal(PK.suggestion([gw(9, { never_connected: true })]), null);
  });
});

describe('gateway-pool-kit: "Zustand" of a gateway', () => {
  it('all fine: tunnel, routes, sync — ordered problems first', () => {
    const g = gw(1, { health: { config_hash: 'abc', route_reachability: [{ route_id: 1, reachable: true }, { route_id: 2, reachable: true }] } });
    const c = PK.healthChecks(g, { status: 'online', agoText: 'vor 12 s' });
    assert.deepEqual(c.map((x) => x.key), ['gwp.state.tunnel', 'gwp.state.routes', 'gwp.state.synced']);
    assert.equal(PK.overall(c), 'ok');
  });
  it('problems: offline first, unreachable routes, new devices with link, update info', () => {
    const g = gw(1, { update_available: true, health: { route_reachability: [{ route_id: 1, reachable: false }, { route_id: 2, reachable: true }] } });
    const c = PK.healthChecks(g, { status: 'online', fresh: 7, latest: '1.24.0' });
    assert.deepEqual(c.map((x) => [x.tone, x.key]), [['warn', 'gwp.state.routes'], ['warn', 'gwp.state.sync_unknown'], ['warn', 'gwp.state.new'],
      ['info', 'gwp.state.update'], ['ok', 'gwp.state.tunnel']]);
    assert.equal(c.find((x) => x.key === 'gwp.state.new').link, 'net');
    assert.equal(PK.overall(c), 'warn');
    const off = PK.healthChecks(gw(2), { status: 'offline' });
    assert.equal(off[0].key, 'gwp.state.offline');
    assert.equal(PK.overall(off), 'bad');
    assert.deepEqual(PK.healthChecks(gw(3, { never_connected: true }), {}).map((x) => x.key), ['gwp.state.never']);
  });
});

describe('gateway-pool-kit: tab "Funktionen"', () => {
  const d = {
    features: { netwatch: { enabled: true }, inetq: { enabled: false }, presence: { enabled: true }, ups: { enabled: false } },
    dns: { enabled: true }, cache: { enabled: false }, edge: { enabled: true, mqtt: false }, zigbee: null,
    lanDiscovery: { available: true, enabled: false }, timezone: { tz: 'Europe/Berlin' },
    memory: { parts: [{ key: 'gateway', mb: 80 }, { key: 'netwatch', mb: 15 }, { key: 'edge', mb: 70 }, { key: 'mosquitto', mb: 10 }] },
  };
  it('the groups hold every switch row of gateway-net.js / gateway-home.js exactly once', () => {
    const all = PK.FEATURE_GROUPS.flatMap((g) => g.features);
    assert.deepEqual(all.slice().sort(), ['cache', 'dns', 'edge', 'inetq', 'lan', 'netwatch', 'presence', 'timezone', 'ups', 'zigbee']);
    assert.equal(new Set(all).size, all.length);
    const net = read('public/js/gateway-net.js');
    const home = read('public/js/gateway-home.js');
    for (const k of ['netwatch', 'inetq', 'presence', 'ups', 'edge', 'zigbee', 'lan']) assert.match(net, new RegExp("rows\\.set\\('" + k + "'"), k);
    for (const k of ['dns', 'cache', 'timezone']) assert.match(home, new RegExp("'" + k + "'\\)\\);"), k);
    assert.equal(PK.groupOf('dns'), 'wide');
    assert.equal(PK.groupOf('ups'), 'power');
  });
  it('featureStates: on/off of what this gateway has; presence needs the network watch; MQTT needs edge', () => {
    const s = PK.featureStates(d);
    assert.deepEqual(s.filter((x) => x.on).map((x) => x.key), ['netwatch', 'presence', 'dns', 'edge', 'timezone']);
    assert.deepEqual(s.filter((x) => !x.on).map((x) => x.key), ['inetq', 'cache', 'mqtt', 'ups', 'lan']);
    assert.equal(PK.featureStates({ ...d, features: { ...d.features, netwatch: { enabled: false } } }).find((x) => x.key === 'presence').on, false);
    assert.deepEqual(PK.featureStates(null), []);
  });
  it('tabOff: tabs of switched-off functions', () => {
    assert.equal(PK.tabOff(d, 'net'), false);
    assert.equal(PK.tabOff(d, 'inet'), true);
    assert.equal(PK.tabOff(d, 'cache'), true);
    assert.equal(PK.tabOff(d, 'mqtt'), true);
    assert.equal(PK.tabOff(d, 'edge'), false);
    assert.equal(PK.tabOff(d, 'overview'), false);
    assert.equal(PK.tabOff(null, 'net'), false, 'unknown: not muted');
  });
  it('memoryOf: only parts the estimate names (no invented numbers); edge with its broker', () => {
    assert.equal(PK.memoryOf(d, 'netwatch'), 15);
    assert.equal(PK.memoryOf(d, 'edge'), 80);
    assert.equal(PK.memoryOf(d, 'inetq'), null);
    assert.equal(PK.memoryOf(d, 'timezone'), null);
  });
});

describe('the views: texts and safety', () => {
  const files = ['public/js/gateway-pools-ui.js', 'public/js/gateways.js', 'public/js/gateway-net.js', 'public/js/gateway-pool-kit.js', 'templates/aurora/pages/gateways.njk'];
  const placeholders = (s) => (String(s).match(/\{\{\w+\}\}/g) || []).sort();
  it('every gwp.* key exists in de.json and en.json with the same placeholders', () => {
    const keys = new Set();
    for (const f of files) for (const m of read(f).matchAll(/'(gwp\.[a-z0-9_.]+[a-z0-9_])'(?!\s*\+)/g)) keys.add(m[1]);
    // keys built from a prefix
    PK.COOLDOWN_PRESETS.forEach((p) => keys.add('gwp.cool.' + p.key));
    PK.FEATURE_GROUPS.forEach((g) => keys.add('gwp.fgrp.' + g.key));
    for (const k of ['netwatch', 'inetq', 'presence', 'dns', 'cache', 'edge', 'mqtt', 'zigbee', 'ups', 'lan', 'timezone']) keys.add('gwp.fname.' + k);
    for (const k of ['failover', 'failback', 'outage', 'restored', 'change']) { keys.add('gwp.hist.' + k); keys.add('gwp.hist.kind_' + k); }
    for (const k of ['proxy', 'api', 'dns']) { keys.add('gwp.load.' + k + '_ok'); keys.add('gwp.load.' + k + '_bad'); }
    for (const k of ['failover', 'load_balancing']) { keys.add('gwp.mode.' + k); keys.add('gwp.mode.' + k + '_d'); }
    for (const k of ['ok', 'warn', 'bad']) keys.add('gwp.state.overall_' + k);
    for (const k of ['ok', 'warn', 'bad', 'info']) keys.add('gwp.state.tone_' + k);
    for (const k of ['protected', 'on_reserve', 'no_reserve', 'single', 'down', 'off']) { keys.add('gwp.status.' + k); keys.add('gwp.status_short.' + k); }
    for (const k of ['ok', 'tight', 'too_much']) keys.add('gwp.feat.level_' + k);
    for (const k of ['active', 'lb_active', 'standby', 'recovering', 'offline']) keys.add('gwp.mstate.' + k);
    assert.ok(keys.size > 250, String(keys.size));
    for (const k of keys) {
      assert.ok(de[k], 'de ' + k);
      assert.ok(en[k], 'en ' + k);
      assert.deepEqual(placeholders(de[k]), placeholders(en[k]), k);
    }
    for (const k of ['gwe.tabs.features', 'gwe.tabs.off']) assert.ok(de[k] && en[k], k);
  });
  it('no innerHTML / insertAdjacentHTML / document.write in the new scripts', () => {
    for (const f of ['public/js/gateway-pools-ui.js', 'public/js/gateway-pool-kit.js']) {
      const code = read(f).split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
      assert.equal(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(code), false, f);
    }
  });
  it('the head of a gateway: "Mehr" is a real menu button; no "Gateway entfernen" (there is no such action here)', () => {
    const js = read('public/js/gateways.js');
    assert.match(js, /more\.setAttribute\('aria-haspopup', 'menu'\)/);
    assert.match(js, /menu\.setAttribute\('role', 'menu'\)/);
    assert.match(js, /b\.setAttribute\('role', 'menuitem'\)/);
    for (const a of ['compose', 'setup', 'disc-settings', 'pool-add']) assert.ok(js.includes("item('" + a + "'"), a);
    assert.doesNotMatch(js, /gateway_remove|gw-remove/);
  });
  it('"Erkannte Geräte" and "Scan-Ziele" moved to the tab "Netzwerk"', () => {
    const js = read('public/js/gateways.js');
    const ov = js.slice(js.indexOf('function overview('), js.indexOf('function netExtras('));
    assert.doesNotMatch(ov, /discoveredDevicesCard|egressCard/);
    const ex = js.slice(js.indexOf('function netExtras('), js.indexOf('var openTab'));
    assert.match(ex, /discoveredDevicesCard\(g\)/);
    assert.match(ex, /egressCard\(g\)/);
  });
});
