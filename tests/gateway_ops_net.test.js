'use strict';

// Gateway › Betrieb & Netz: the note for a gateway without Docker (Proxmox LXC,
// no edge container) in the row "Edge-Plugins & MQTT", and the pages that read
// GET /:id/discovered without the licence feature (an empty list with
// licensed: false instead of a failed request).

const crypto = require('node:crypto');
process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setup, teardown } = require('./helpers/setup');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const de = JSON.parse(read('src/i18n/de.json'));
const en = JSON.parse(read('src/i18n/en.json'));

let db, gateways, features;

before(async () => {
  await setup();
  db = require('../src/db/connection').getDb();
  gateways = require('../src/services/gateways');
  features = require('../src/services/gatewayFeatures');
  require('../src/services/license')._overrideForTest({ gateway_peers: -1 });
});
after(() => teardown());

async function gateway(name, platform, telemetry) {
  const gw = await gateways.createGateway({ name, platform });
  db.prepare('UPDATE gateway_meta SET last_health = ? WHERE peer_id = ?').run(JSON.stringify({ telemetry }), gw.peer.id);
  return gw.peer.id;
}

describe('row "Edge-Plugins & MQTT": a gateway without Docker has no edge container', () => {
  it('Proxmox LXC (platform of the assistant, or telemetry.runtime native) → edge.native; the switch itself stays', async () => {
    const lxc = await gateway('ops-lxc', 'proxmox', { gateway_version: '1.34.0', edge: null });
    const nat = await gateway('ops-native', null, { gateway_version: '1.35.0', runtime: 'native', edge: null });
    const syn = await gateway('ops-syn', 'synology', { gateway_version: '1.35.0', runtime: 'container', edge: { deployed: true } });
    const vm = await gateway('ops-pve-vm', 'proxmox', { gateway_version: '1.35.0', runtime: 'container', edge: null });
    assert.equal(features.overview(lxc).edge.native, true);
    assert.equal(features.overview(nat).edge.native, true);
    assert.equal(features.overview(syn).edge.native, false);
    assert.equal(features.overview(vm).edge.native, false, 'Docker in a VM on Proxmox');
    const o = features.overview(lxc).edge;
    assert.deepEqual(Object.keys(o).sort(), ['enabled', 'mqtt', 'native']);
  });
});

describe('GET /:id/discovered without the licence: the pages show a note, not an error', () => {
  const GW_JS = read('public/js/gateways.js');
  const MODAL_JS = read('public/js/domain-modal.js');

  it('gateway page: the card "Erkannte Geräte" shows the licence note and switches the scan button off', () => {
    const i = GW_JS.indexOf('function showLocked()');
    assert.ok(i > 0);
    const body = GW_JS.slice(i, GW_JS.indexOf('function loadCached()', i));
    assert.match(body, /scanBtn\.disabled = true/);
    assert.match(body, /T\('gateways\.discovery\.feature_locked'/);
    assert.match(body, /list\.replaceChildren\(hint\)/);
    const load = GW_JS.slice(GW_JS.indexOf('function loadCached()', i), GW_JS.indexOf("scanBtn.addEventListener('click'", i));
    assert.match(load, /if \(d\.ok && d\.licensed === false\) \{ showLocked\(\); return; \}/);
    // a server from before `licensed` answered 403: the same note, no "(…)" with the raw error
    assert.match(load, /if \(r\.status === 403\) \{ showLocked\(\); return; \}/);
    for (const d of [de, en]) assert.ok(d['gateways.discovery.feature_locked']);
  });

  it('the answer of the licence middleware is recognised by its `feature`, not by its translated sentence', () => {
    assert.match(GW_JS, /if \(d && d\.feature === 'gateway_lan_discovery'\) return T\('gateways\.discovery\.feature_locked'/);
    // the sentence itself is translated — matching on it could never work in German
    assert.doesNotMatch(de['error.license.feature_not_available'], /not licensed|feature_not_available|gateway_lan_discovery/i);
  });

  it('route dialog: licensed: false → the licence hint', () => {
    assert.match(MODAL_JS, /if \(res && res\.licensed === false\) setHint\(t\('zones\.discovery\.hint_license'\)\);/);
    for (const d of [de, en]) assert.ok(d['zones.discovery.hint_license']);
  });

  it('migration dialog: the address suggestions simply stay empty', () => {
    const js = read('public/js/gateway-pools-ui.js');
    assert.match(js, /\/discovered', \{ credentials: 'same-origin' \}\)\s*\.then\(\(r\) => \(r\.ok \? r\.json\(\) : null\)\)\.then\(\(d\) => \{\s*if \(!d \|\| !Array\.isArray\(d\.devices\)\) return;/);
  });
});
