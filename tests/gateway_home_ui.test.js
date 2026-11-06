'use strict';

// Tabs "DNS-Filter" / "Zwischenspeicher" and their rows in the card
// "Funktionen" (public/js/gateway-home.js, gateway-home-kit.js, phase 3b):
// the pure rules, every text in German and English, no innerHTML, the page
// loads the scripts and the tabs are in the address.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const K = require('../public/js/gateway-home-kit');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const de = JSON.parse(read('src/i18n/de.json'));
const en = JSON.parse(read('src/i18n/en.json'));
const both = (k) => typeof de[k] === 'string' && typeof en[k] === 'string';

describe('gateway-home-kit', () => {
  it('days: ranges, single days, every day', () => {
    const n = de['gwh.days.short'].split(',');
    assert.equal(n.length, 7);
    assert.equal(en['gwh.days.short'].split(',').length, 7);
    assert.equal(K.daysLabel([1, 2, 3, 4, 5], n, 'täglich'), 'Mo–Fr');
    assert.equal(K.daysLabel([6, 7], n, 'täglich'), 'Sa–So');
    assert.equal(K.daysLabel([1, 3, 5], n, 'täglich'), 'Mo, Mi, Fr');
    assert.equal(K.daysLabel([5, 1, 2, 3], n, 'täglich'), 'Mo–Mi, Fr');
    assert.equal(K.daysLabel([1, 2, 3, 4, 5, 6, 7], n, 'täglich'), 'täglich');
    assert.equal(K.daysLabel([], n, 'x'), '');
    assert.equal(K.scheduleTitle({ days: [1, 2, 3, 4, 5], from: '21:00', to: '07:00' }, n, 'x'), 'Mo–Fr 21:00 – 07:00');
    assert.equal(K.overnight({ from: '21:00', to: '07:00' }), true);
    assert.equal(K.overnight({ from: '08:00', to: '12:00' }), false);
  });

  it('domains from free text', () => {
    assert.deepEqual(K.parsePatterns('Anton.App\nhttps://www.schule.de/login, *.schulportal.hessen.de; anton.app  foo.de:443'),
      ['anton.app', 'www.schule.de', '*.schulportal.hessen.de', 'foo.de']);
    assert.deepEqual(K.parsePatterns(''), []);
  });

  it('sizes, memory, the router check, the IPv6 address for the router', () => {
    assert.deepEqual(K.bytesParts(18.4e9), { value: 18.4, unit: 'GB', digits: 1 });
    assert.deepEqual(K.bytesParts(700e6), { value: 700, unit: 'MB', digits: 0 });
    assert.equal(K.bytesParts(-1), null);
    assert.equal(K.gibLabel(50 * 1024 ** 3), '50 GB');
    assert.equal(K.dnsMemMb([{ lists: ['ads'] }, { lists: ['ads', 'malware'] }], [{ id: 'ads', entries: 78000 }, { id: 'malware', entries: 195000 }, { id: 'adult', entries: 92000 }]), 25 + Math.round((273000 * 8) / 1048576));
    assert.deepEqual(K.routerCheck({ gateway: { telemetry: { state: 'running' } }, router: { asking: 23, missing: [{ name: 'TV' }], missingCount: 4 } }),
      { answers: 'ok', asking: 23, missing: [{ name: 'TV' }], missingCount: 4, ok: false });
    assert.equal(K.routerCheck({ gateway: { telemetry: { state: 'running' } }, router: { asking: 3, missing: [], missingCount: 0 } }).ok, true);
    assert.equal(K.routerCheck({ gateway: { telemetry: { state: 'port_busy' } }, router: {} }).answers, 'busy');
    assert.equal(K.routerCheck({ gateway: { telemetry: null }, router: {} }).answers, 'unknown');
    assert.equal(K.pickV6(['fe80::1', '2a02:810::5', 'fd00::ba27:ebff:fe12:3456']), 'fd00::ba27:ebff:fe12:3456');
    assert.equal(K.pickV6(['fe80::1', '2a02:810::5']), '2a02:810::5');
    assert.equal(K.pickV6(['fe80::1']), null);
  });
});

describe('texts (German and English)', () => {
  const src = read('public/js/gateway-home.js');

  it('every literal gwh./gwn./gwe. key of the module exists in both languages', () => {
    const keys = new Set();
    // (a literal followed by `+` is the start of a key family: checked below)
    for (const m of src.matchAll(/'((?:gwh|gwn|gwe)\.[a-z0-9_.]+[a-z0-9_])'(?!\s*\+)/g)) keys.add(m[1]);
    assert.ok(keys.size > 150, String(keys.size));
    const missing = [...keys].filter((k) => !both(k));
    assert.deepEqual(missing, []);
  });

  it('the dynamic families: lists, categories, kinds, providers, routers and their steps, states, tabs', () => {
    const cat = require('../src/services/homeDnsCatalog');
    for (const l of cat.LISTS) assert.ok(both('gwh.list.' + l.id + '.name') && both('gwh.list.' + l.id + '.desc'), l.id);
    for (const c of cat.CATEGORY_IDS) assert.ok(both('gwh.cat.' + c), c);
    for (const k of K.KINDS) assert.ok(both('gwh.kinds.' + k) && both('gwh.kinds.' + k + '_d'), k);
    for (const p of cat.PROVIDER_IDS) assert.ok(both('gwh.up.provider.' + p) && both('gwh.up.desc.' + p), p);
    for (const r of K.ROUTERS) {
      assert.ok(both('gwh.router.type.' + r), r);
      const steps = Object.keys(de).filter((k) => k.startsWith('gwh.router.' + r + '.s'));
      assert.ok(steps.length >= 3, r);
      for (const s of steps) assert.ok(both(s), s);
    }
    for (const s of ['running', 'running_n', 'waiting', 'port_busy', 'no_address', 'error', 'starting', 'off', 'down']) assert.ok(both('gwh.state.' + s), s);
    // the home cache's states of the gateway (gateway side 18) and the reasons of "Domain prüfen" (gateway side 13)
    for (const s of ['port_busy', 'no_address', 'path_unwritable', 'path_not_allowed', 'no_secret']) assert.ok(both('gwh.cstate.' + s) && both('gwh.cache.st_' + s), s);
    for (const r of ['local', 'always_allow', 'profile_allow', 'paused', 'no_profile', 'profile_deny', 'schedule', 'schedule_category', 'list', 'canary', 'default']) assert.ok(both('gwh.reason.' + r), r);
    for (const tab of ['dns', 'cache']) assert.ok(both('gwe.tabs.' + tab), tab);
    for (const e of ['not_found', 'invalid', 'invalid_domain', 'invalid_url', 'invalid_name', 'invalid_schedule', 'invalid_member', 'invalid_path', 'name_taken', 'too_many', 'default_profile']) assert.ok(both('gwh.err.' + e), e);
    for (const p of ['home_internet', 'home_internet_on', 'home_cache', 'home_cache_on']) assert.ok(both('plugins.perm.' + p), p);
    assert.equal(de['gwh.days.long'].split(',').length, 7);
  });

  it('the IPv6 step without an address has its own text', () => {
    assert.ok(both('gwh.router.fritzbox.s4_no6') && both('gwh.router.other.s4_no6'));
  });
});

describe('page wiring', () => {
  it('no innerHTML / insertAdjacentHTML / document.write', () => {
    for (const f of ['public/js/gateway-home.js', 'public/js/gateway-home-kit.js']) {
      const s = read(f);
      assert.equal(/\.(?:innerHTML|outerHTML)\b|insertAdjacentHTML|document\.write/.test(s), false, f);
    }
  });

  it('the gateways page loads the scripts and hands the texts over; the tabs are in the address', () => {
    const njk = read('templates/aurora/pages/gateways.njk');
    assert.ok(njk.includes('/js/gateway-home-kit.js') && njk.includes('/js/gateway-home.js'));
    assert.ok(njk.indexOf('/js/gateway-home.js') < njk.indexOf('/js/gateways.js'));
    assert.match(njk, /data-prefixes="[^"]*gwh\./);
    assert.ok(read('src/routes/index.js').includes("'gwh.'"));
    const EK = require('../public/js/gateway-edge-kit');
    assert.deepEqual(EK.TABS, ['overview', 'features', 'net', 'inet', 'dns', 'cache', 'radio', 'edge', 'mqtt']);
    assert.deepEqual(EK.parseHash('#gw/7/dns'), { id: '7', tab: 'dns' });
    assert.equal(EK.hashFor(7, 'cache'), '#gw/7/cache');
    assert.ok(read('public/js/gateways.js').includes("['features', 'net', 'inet', 'dns', 'cache', 'radio', 'edge', 'mqtt']"));
  });
});
