'use strict';

// Pure rules of the gateway locations (public/js/gateway-location-kit.js) and
// the static parts of the page (template, scripts, strings) —
// docs/feature-gateway-locations.md.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const K = require('../public/js/gateway-location-kit.js');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

describe('gateway-location-kit', () => {
  it('addressLine: street, then postcode and town; empty parts left out', () => {
    assert.equal(K.addressLine({ street: 'Musterweg 12', postal_code: '10115', city: 'Berlin' }), 'Musterweg 12, 10115 Berlin');
    assert.equal(K.addressLine({ city: 'Kiel' }), 'Kiel');
    assert.equal(K.addressLine({ street: ' Hafenstraße  8 ', postal_code: '' }), 'Hafenstraße 8');
    assert.equal(K.addressLine({}), '');
    assert.equal(K.addressLine(null), '');
  });
  it('countryOptions: DE, AT, CH first, every code once; names from Intl', () => {
    const o = K.countryOptions('de');
    assert.deepEqual(o.slice(0, 3).map((c) => c.code), ['DE', 'AT', 'CH']);
    assert.equal(new Set(o.map((c) => c.code)).size, o.length);
    assert.equal(o.length, K.COUNTRIES.length);
    assert.equal(K.countryName('DE', 'de'), 'Deutschland');
    assert.equal(K.countryName('DE', 'en'), 'Germany');
    assert.equal(K.countryName('', 'de'), '');
  });
  it('fleetSections: locations with gateways by name, "Ohne Standort" last, empty locations left out', () => {
    const locs = [{ id: 1, name: 'Zuhause' }, { id: 2, name: 'büro' }, { id: 3, name: 'Ferienwohnung' }];
    const gws = [
      { peer_id: 10, name: 'Pi', location: { id: 1, name: 'Zuhause' } },
      { peer_id: 11, name: 'NAS', location: { id: 1, name: 'Zuhause' } },
      { peer_id: 12, name: 'PVE', location: { id: 2, name: 'büro' } },
      { peer_id: 13, name: 'VM', location: null },
    ];
    const s = K.fleetSections(gws, locs);
    assert.deepEqual(s.map((x) => x.location && x.location.name), ['büro', 'Zuhause', null]);
    assert.deepEqual(s[1].gateways.map((g) => g.peer_id), [10, 11]);
    assert.deepEqual(s[2].gateways.map((g) => g.peer_id), [13]);
    // no gateway without a location → no "Ohne Standort"
    assert.equal(K.fleetSections(gws.slice(0, 3), locs).some((x) => x.location === null), false);
    // a location the list does not know yet (just created) still gets its section
    assert.equal(K.fleetSections([{ peer_id: 1, location: { id: 9, name: 'Neu' } }], []).length, 1);
  });
  it('mode: pools without locations; the stored choice, else locations', () => {
    assert.equal(K.mode('locations', 0), 'pools');
    assert.equal(K.mode(null, 2), 'locations');
    assert.equal(K.mode('pools', 2), 'pools');
    assert.equal(K.mode('nonsense', 1), 'locations');
  });
  it('poolPartners: the other members of the gateway\'s pools, each once, with the pool\'s name', () => {
    const pools = [{ name: 'Zuhause', members: [{ peer_id: 1 }, { peer_id: 2 }] }, { name: 'Zwei', members: [{ peer_id: 2 }, { peer_id: 1 }, { peer_id: 3 }] }];
    const gws = [{ peer_id: 1, name: 'Pi' }, { peer_id: 2, name: 'NAS' }, { peer_id: 3, name: 'VM' }];
    assert.deepEqual(K.poolPartners(pools, 1, gws), { pool: 'Zuhause', partners: [{ peer_id: 2, name: 'NAS' }, { peer_id: 3, name: 'VM' }] });
    assert.deepEqual(K.poolPartners(pools, 9, gws), { pool: null, partners: [] });
    assert.deepEqual(K.poolPartners(null, 1, gws), { pool: null, partners: [] });
  });
  it('check / body: the same rules as the server', () => {
    assert.equal(K.check({ name: 'Zuhause' }), null);
    assert.deepEqual(K.check({ name: ' ' }), { name: 'name_required' });
    assert.deepEqual(K.check({ name: 'x'.repeat(81) }), { name: 'too_long' });
    assert.deepEqual(K.check({ name: 'A', postal_code: '<1>' }), { postal_code: 'postal_invalid' });
    assert.deepEqual(K.check({ name: 'A', country: 'XX' }), { country: 'country_invalid' });
    assert.equal(K.check({ name: 'A', postal_code: 'SW1A 1AA', country: 'gb' }), null);
    assert.deepEqual(K.body({ name: ' Büro ', city: 'Hamburg', country: 'de' }), { name: 'Büro', street: '', postal_code: '', city: 'Hamburg', country: 'DE' });
  });
  it('the server takes what the form sends (services/gatewayLocations.js normalize)', () => {
    const svc = require('../src/services/gatewayLocations');
    const r = svc.normalize(K.body({ name: 'Ferienwohnung', street: 'Strandweg 5', postal_code: '17459', city: 'Koserow', country: 'DE' }));
    assert.equal(r.fields, null);
    assert.deepEqual(r.value, { name: 'Ferienwohnung', street: 'Strandweg 5', postal_code: '17459', city: 'Koserow', country: 'DE' });
    assert.deepEqual(svc.normalize(K.body({ name: 'A' })).value, { name: 'A', street: null, postal_code: null, city: null, country: null });
  });
});

describe('gateways page: locations', () => {
  const tpl = read('templates/aurora/pages/gateways.njk');
  it('the button "Standorte", the assistant\'s location field (no peer group any more)', () => {
    assert.match(tpl, /id="btn-locations"/);
    assert.match(tpl, /<select id="gwz-location">/);
    assert.equal(/gwz-group/.test(tpl), false);
    assert.equal(/gwz-group|peer-groups|group_id/.test(read('public/js/gateway-wizard.js')), false);
    assert.match(tpl, /id="gwz-loc-new" hidden/);
  });
  it('scripts in order: the kit before the assistant, the module after the pools and before gateways.js', () => {
    const i = (f) => tpl.indexOf('/js/' + f + '?');
    assert.ok(i('gateway-location-kit.js') > 0 && i('gateway-location-kit.js') < i('gateway-wizard.js'));
    assert.ok(i('gateway-locations.js') > i('gateway-pools-ui.js') && i('gateway-locations.js') < i('gateways.js'));
  });
  it('no innerHTML in the new scripts', () => {
    for (const f of ['public/js/gateway-locations.js', 'public/js/gateway-location-kit.js']) assert.equal(/innerHTML/.test(read(f)), false, f);
  });
  it('every gwp.loc.* / error.gateway_locations.* / gwiz.s1.loc* string in both languages', () => {
    const de = JSON.parse(read('src/i18n/de.json'));
    const en = JSON.parse(read('src/i18n/en.json'));
    const keys = Object.keys(de).filter((k) => /^(gwp\.loc\.|error\.gateway_locations\.|gwiz\.s1\.loc)/.test(k));
    assert.ok(keys.length > 50, String(keys.length));
    for (const k of keys) assert.ok(en[k] && en[k] !== de[k] || /^(Name|Pools)$/.test(en[k]), k);
    // the codes of the service have a text
    for (const c of ['invalid', 'not_found', 'gateway_not_found', 'name_required', 'name_taken', 'too_long', 'postal_invalid', 'country_invalid']) {
      assert.ok(de['error.gateway_locations.' + c] && en['error.gateway_locations.' + c], c);
    }
    assert.equal(de['gwiz.s1.location_none'], 'Kein Standort');
  });
});
