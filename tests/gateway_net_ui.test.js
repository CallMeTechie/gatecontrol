'use strict';

// Tabs "Netzwerk" / "Internet" and the card "Funktionen dieses Gateways"
// (public/js/gateway-net.js, gateway-net-kit.js): the pure rules, every text
// in German and English, no innerHTML, the page loads the scripts.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const K = require('../public/js/gateway-net-kit');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const de = JSON.parse(read('src/i18n/de.json'));
const en = JSON.parse(read('src/i18n/en.json'));

describe('gateway-net-kit', () => {
  it('the address of the UPS server: private IPv4, or a unique local IPv6 address (a home network without IPv4)', () => {
    for (const v of ['192.168.1.10', ' 10.0.0.1 ', '172.16.0.1', '172.31.255.254', 'fd00::10', 'fd12:3456:789a:1::10', 'FC00:0:0:0:0:0:0:1']) assert.equal(K.upsHostOk(v), true, v);
    for (const v of ['8.8.8.8', '172.32.0.1', '192.168.1.300', '192.168.1', 'fe80::1', '2a02:8070::5', 'fd00::1%eth0', '[fd00::10]', 'fd00:::1', 'fd00::1::2', 'fd00:1:2:3:4:5:6:7:8', 'fd00:1', '::1', 'nas.local', '', null, undefined]) {
      assert.equal(K.upsHostOk(v), false, String(v));
    }
    // what the dialog lets through, the server takes — and the other way round for the same samples
    const { isPrivateIpv4, isUlaIpv6 } = require('../src/utils/validate');
    for (const v of ['192.168.1.10', '10.0.0.1', 'fd00::10', 'fd12:3456:789a:1::10', '8.8.8.8', 'fe80::1', '2a02::1', 'fd00:1', '::1']) {
      assert.equal(K.upsHostOk(v), isPrivateIpv4(v) || isUlaIpv6(v), v);
    }
    const js = read('public/js/gateway-net.js');
    assert.match(js, /if \(!K\.upsHostOk\(host\.value\)\) \{ U\.showErr\(err, t\('gwn\.err\.invalid_ups_host'\)\)/);
    for (const k of ['gwn.err.invalid_ups_host', 'gwn.err.ups_host_ipv6', 'gwn.ups.host_hint']) {
      assert.ok(de[k] && en[k], k);
      assert.match(de[k] + en[k], /IPv6/, k);
    }
  });

  it('risky ports: telnet always, SMB not on a NAS', () => {
    assert.deepEqual(K.risksOf({ vendor: 'Brother', ports: [{ port: 80 }, { port: 23 }, { port: 631 }] }), [{ port: 23, key: 'telnet' }]);
    assert.deepEqual(K.risksOf({ vendor: 'Synology', ports: [{ port: 445 }, { port: 5001 }] }), []);
    assert.deepEqual(K.risksOf({ vendor: 'Intel', hostname: 'diskstation', ports: [{ port: 445 }] }), []);
    assert.deepEqual(K.risksOf({ vendor: 'Intel', name: 'Büro-PC', ports: [{ port: 445 }, { port: 3389 }] }), [{ port: 445, key: 'smb' }, { port: 3389, key: 'rdp' }]);
    assert.deepEqual(K.risksOf({ ports: null }), []);
    for (const r of K.RISKY) {
      for (const d of [de, en]) {
        assert.ok(d['gwn.risk.' + r.key + '.name'], r.key);
        assert.ok(d['gwn.risk.' + r.key + '.text'], r.key);
      }
    }
  });

  it('search and filter of the list, the order', () => {
    const list = [
      { mac: 'a', ip: '192.168.1.10', vendor: 'Synology', name: 'NAS Büro', status: 'known', online: true, ports: [{ port: 445 }] },
      { mac: 'b', ip: '192.168.1.77', vendor: 'Espressif', status: 'new', online: true, ports: [] },
      { mac: 'c', ip: '192.168.1.9', vendor: 'LG', status: 'watch', online: false, ports: null, ownerUserId: 2, ownerName: 'Anna' },
    ];
    assert.deepEqual(K.filterDevices(list, 'espr', 'all').map((x) => x.mac), ['b']);
    assert.deepEqual(K.filterDevices(list, '192.168.1.1', 'all').map((x) => x.mac), ['a']);
    assert.deepEqual(K.filterDevices(list, 'anna', 'all').map((x) => x.mac), ['c']);
    assert.deepEqual(K.filterDevices(list, '', 'online').map((x) => x.mac), ['a', 'b']);
    assert.deepEqual(K.filterDevices(list, '', 'ports').map((x) => x.mac), ['a']);
    assert.deepEqual(K.filterDevices(list, '', 'owned').map((x) => x.mac), ['c']);
    assert.deepEqual(K.filterDevices(list, '', 'watch').map((x) => x.mac), ['c']);
    assert.deepEqual(K.filterDevices(list, '', 'bogus').length, 3);
    assert.deepEqual(K.sortDevices(list).map((x) => x.mac), ['b', 'a', 'c']);
    assert.deepEqual(K.kpis(list), { total: 3, online: 2, fresh: 1, risky: 0 });
    for (const f of K.FILTERS) assert.ok(de['gwn.filter.' + f] && en['gwn.filter.' + f], f);
  });

  it('UPS states and outage causes', () => {
    assert.equal(K.upsState('OL'), 'online');
    assert.equal(K.upsState('OL CHRG'), 'online');
    assert.equal(K.upsState('OB DISCHRG'), 'battery');
    assert.equal(K.upsState('OB LB'), 'low');
    assert.equal(K.upsState(''), 'unknown');
    assert.equal(K.onBattery('OB'), true);
    assert.equal(K.onBattery('OL'), false);
    for (const s of ['online', 'battery', 'low', 'unknown']) assert.ok(de['gwn.ups.state.' + s] && en['gwn.ups.state.' + s], s);
    assert.equal(K.causeKey('isp'), 'isp');
    assert.equal(K.causeKey('weird'), 'unknown');
    for (const c of ['router', 'isp', 'unknown']) assert.ok(de['gwn.cause.' + c] && en['gwn.cause.' + c] && de['push.inet.cause_' + c], c);
    assert.equal(K.minutes(0, 7 * 60000), 7);
  });

  it('chart geometry: gaps, outage bands, a round upper end', () => {
    const t0 = 1_700_000_000_000;
    const pts = [0, 1, 2, 10, 11].map((i) => ({ t: t0 + i * 300000, rtt: 10 + i }));
    const g = K.chartGeometry(pts, [{ start: t0 + 4 * 300000, end: t0 + 6 * 300000 }], { from: t0, to: t0 + 12 * 300000, range: '24h' });
    assert.equal(g.lines.length, 2, 'a gap of 8 buckets splits the line');
    assert.equal(g.bands.length, 1);
    assert.equal(g.max, 50);
    assert.ok(g.bands[0].w > 0);
    const empty = K.chartGeometry([], [], { from: t0, to: t0 + 1000 });
    assert.deepEqual(empty.lines, []);
    assert.deepEqual(K.summary(pts), { min: 10, max: 21, avg: 15, loss: null });
    assert.equal(K.summary([]), null);
    for (const r of K.RANGES) assert.ok(de['gwn.hist.r_' + r] && en['gwn.hist.r_' + r], r);
  });
});

describe('gateway-net.js', () => {
  const src = read('public/js/gateway-net.js');

  it('every text key exists in German and English', () => {
    const keys = new Set(src.match(/'gwn\.[a-z0-9_.]+[a-z0-9_]'/g).map((s) => s.slice(1, -1)));
    for (const k of ['gwn.set.plan_off', 'gwn.set.plan_4x', 'gwn.set.plan_hourly', 'gwn.speed.plan_off', 'gwn.speed.plan_4x', 'gwn.speed.plan_hourly',
      'gwn.feat.mem_ok', 'gwn.feat.mem_tight', 'gwn.feat.mem_too_much', 'gwn.status.known', 'gwn.status.watch', 'gwe.tabs.net', 'gwe.tabs.inet']) keys.add(k);
    for (const k of keys) {
      if (k.endsWith('.') || k.endsWith('_')) continue;
      assert.ok(de[k], 'de ' + k);
      assert.ok(en[k], 'en ' + k);
    }
  });

  it('no innerHTML / insertAdjacentHTML / document.write', () => {
    const code = src.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
    assert.equal(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(code), false);
    assert.equal(/innerHTML|outerHTML|insertAdjacentHTML/.test(read('public/js/gateway-net-kit.js')), false);
  });

  it('the Pi 3 B+ hint says about 300 Mbit/s (not 90)', () => {
    assert.match(de['gwn.speed.limit_pi3bplus'], /300 Mbit\/s über Kabel/);
    assert.match(en['gwn.speed.limit_pi3bplus'], /300 Mbit\/s over cable/);
    assert.equal(/\b90 Mbit/.test(de['gwn.speed.limit_pi3bplus'] + en['gwn.speed.limit_pi3bplus']), false);
  });

  it('the page loads the scripts in order and hands over the gwn.* strings', () => {
    const tpl = read('templates/aurora/pages/gateways.njk');
    const order = ['gateway-edge-kit.js', 'gateway-edge.js', 'gateway-net-kit.js', 'gateway-net.js', 'gateway-home-kit.js', 'gateway-home.js', 'gateway-radio-kit.js', 'gateway-radio.js', 'gateways.js'].map((f) => tpl.indexOf('/js/' + f));
    assert.ok(order.every((i) => i > 0));
    assert.deepEqual(order.slice().sort((a, b) => a - b), order);
    assert.match(tpl, /data-prefixes="gwiz\. gwe\. gwn\. gwh\. gwp\. gwr\. gwd\. gateway_pools\. common\."/);
    assert.match(read('src/routes/index.js'), /GWIZ_I18N_PREFIXES = \['gwiz\.', 'gwe\.', 'gwn\.', 'gwh\.', 'gwp\.', 'gwr\.', 'gwd\.', 'gateway_pools\.', 'common\.'\]/);
    // the pool kit before gateway-net.js (it groups the tab "Funktionen"), the pool views before gateways.js
    assert.ok(tpl.indexOf('/js/gateway-pool-kit.js') > 0 && tpl.indexOf('/js/gateway-pool-kit.js') < tpl.indexOf('/js/gateway-net.js'));
    assert.ok(tpl.indexOf('/js/gateway-pools-ui.js') > tpl.indexOf('/js/gateway-home.js') && tpl.indexOf('/js/gateway-pools-ui.js') < tpl.indexOf('/js/gateways.js?'));
  });

  it('the tabs: Übersicht, Funktionen, Netzwerk, Internet, DNS-Filter, Zwischenspeicher, Funk, Edge-Plugins, MQTT', () => {
    const EK = require('../public/js/gateway-edge-kit');
    assert.deepEqual(EK.TABS, ['overview', 'features', 'net', 'inet', 'dns', 'cache', 'radio', 'edge', 'mqtt']);
    assert.equal(EK.hashFor(7, 'features'), '#gw/7/features');
    assert.equal(EK.hashFor(7, 'net'), '#gw/7/net');
    assert.deepEqual(EK.parseHash('#gw/7/inet'), { id: '7', tab: 'inet' });
  });
});
