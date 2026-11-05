'use strict';

// plugin.json `edge` (services/edge/manifest.js, docs/plugins.md "Edge part"):
// the rules of the contract, the capability keys an administrator confirms,
// MQTT filter containment, and that a package with a broken section is refused.

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const edgeManifest = require('../src/services/edge/manifest');
const manifest = require('../src/services/plugins/manifest');

const files = new Set(['server/index.js', 'edge/index.js', 'plugin.json']);
const base = {
  id: 'shelly', name: 'Shelly', version: '1.0.0', publisher: 'Tests', gatecontrol: '>=1.0.0', entry: 'server/index.js',
};
const goodEdge = {
  entry: 'edge/index.js', minGateway: '1.20.0', memoryMb: 48,
  capabilities: {
    udp: { ports: [5683], multicast: ['224.0.1.187'] }, mdns: { services: ['_shelly._tcp'] },
    tcp: { lan: true }, http: { lan: true }, mqtt: { topics: ['shellies/#'] }, serial: ['zigbee'],
  },
};

function check(edge) { return manifest.validate({ ...base, edge }, { files }); }
function errorsOf(edge) { return check(edge).errors; }

describe('edge section', () => {
  it('accepts the contract example and normalises it', () => {
    const r = check(goodEdge);
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.deepEqual(r.manifest.edge, {
      entry: 'edge/index.js', minGateway: '1.20.0', memoryMb: 48,
      capabilities: {
        udp: { ports: [5683], multicast: ['224.0.1.187'] }, mdns: { services: ['_shelly._tcp'] },
        tcp: { lan: true }, http: { lan: true }, mqtt: { topics: ['shellies/#'] }, serial: ['zigbee'],
      },
    });
  });

  it('plugins without edge are unchanged (edge: null)', () => {
    const r = manifest.validate(base, { files });
    assert.equal(r.ok, true);
    assert.equal(r.manifest.edge, null);
  });

  it('defaults: memoryMb 48, no minGateway, no capabilities', () => {
    const r = check({ entry: 'edge/index.js' });
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.deepEqual(r.manifest.edge, { entry: 'edge/index.js', minGateway: null, memoryMb: 48, capabilities: {} });
  });

  it('memoryMb 16…256', () => {
    assert.equal(check({ ...goodEdge, memoryMb: 16 }).ok, true);
    assert.equal(check({ ...goodEdge, memoryMb: 256 }).ok, true);
    for (const v of [15, 257, 48.5, '48']) assert.match(errorsOf({ ...goodEdge, memoryMb: v }).join(), /edge\.memoryMb: invalid/, String(v));
  });

  it('entry: a .js file inside a folder that exists in the package', () => {
    assert.match(errorsOf({ ...goodEdge, entry: 'index.js' }).join(), /edge\.entry: invalid/);
    assert.match(errorsOf({ ...goodEdge, entry: '../edge/index.js' }).join(), /edge\.entry: invalid/);
    assert.match(errorsOf({ ...goodEdge, entry: 'edge/index.ts' }).join(), /edge\.entry: invalid/);
    assert.match(errorsOf({ ...goodEdge, entry: 'edge/main.js' }).join(), /edge\.entry: missing/);
  });

  it('minGateway must be a version', () => {
    assert.match(errorsOf({ ...goodEdge, minGateway: 'latest' }).join(), /edge\.minGateway: invalid/);
  });

  it('udp ports ≥ 1024, never 5353 (only through mdns), ≤ 16, no duplicates', () => {
    assert.match(errorsOf({ ...goodEdge, capabilities: { udp: { ports: [53] } } }).join(), /udp\.ports: below 1024/);
    assert.match(errorsOf({ ...goodEdge, capabilities: { udp: { ports: [5353] } } }).join(), /5353 only through capabilities\.mdns/);
    assert.match(errorsOf({ ...goodEdge, capabilities: { udp: { ports: [6000, 6000] } } }).join(), /udp\.ports: duplicate/);
    assert.match(errorsOf({ ...goodEdge, capabilities: { udp: { ports: Array.from({ length: 17 }, (_, i) => 2000 + i) } } }).join(), /udp\.ports: invalid/);
    assert.match(errorsOf({ ...goodEdge, capabilities: { udp: { ports: [70000] } } }).join(), /udp\.ports: invalid/);
    assert.match(errorsOf({ ...goodEdge, capabilities: { udp: {} } }).join(), /udp: empty/);
  });

  it('multicast only 224.0.0.0/4 without 224.0.0.0/24 (except the mDNS group)', () => {
    assert.equal(check({ ...goodEdge, capabilities: { udp: { multicast: ['239.255.255.250'] } } }).ok, true);
    assert.equal(check({ ...goodEdge, capabilities: { udp: { multicast: ['224.0.0.251'] } } }).ok, true);
    for (const g of ['224.0.0.1', '224.0.0.252', '192.168.1.255', '240.0.0.1', 'ff02::fb', 'x']) {
      assert.match(errorsOf({ ...goodEdge, capabilities: { udp: { multicast: [g] } } }).join(), /udp\.multicast: invalid/, g);
    }
  });

  it('mdns services, tcp/http lan, serial names', () => {
    assert.match(errorsOf({ ...goodEdge, capabilities: { mdns: { services: ['shelly'] } } }).join(), /mdns: invalid/);
    assert.match(errorsOf({ ...goodEdge, capabilities: { tcp: { lan: 'yes' } } }).join(), /tcp: invalid/);
    assert.match(errorsOf({ ...goodEdge, capabilities: { http: { internet: true } } }).join(), /http: invalid/);
    assert.match(errorsOf({ ...goodEdge, capabilities: { http: { lan: false, selfSigned: true } } }).join(), /http\.selfSigned: needs lan/);
    assert.match(errorsOf({ ...goodEdge, capabilities: { http: { lan: true, selfSigned: 'yes' } } }).join(), /http: invalid/);
    assert.match(errorsOf({ ...goodEdge, capabilities: { serial: ['/dev/ttyUSB0'] } }).join(), /serial: invalid/);
    // lan: false is no capability at all
    assert.deepEqual(check({ entry: 'edge/index.js', capabilities: { tcp: { lan: false } } }).manifest.edge.capabilities, {});
  });

  it('mqtt topics: no leading # or +, no $SYS, valid wildcards, ≤ 16', () => {
    for (const t of ['#', '+/x', '$SYS/#', 'a/#/b', 'a/b#', 'a+/b', 'a//b', '']) {
      assert.match(errorsOf({ ...goodEdge, capabilities: { mqtt: { topics: [t] } } }).join(), /mqtt\.topics: invalid/, t);
    }
    assert.equal(check({ ...goodEdge, capabilities: { mqtt: { topics: ['tele/+/STATE', 'zigbee2mqtt/#'] } } }).ok, true);
    assert.match(errorsOf({ ...goodEdge, capabilities: { mqtt: { topics: Array.from({ length: 17 }, (_, i) => 't' + i) } } }).join(), /mqtt\.topics: invalid/);
  });

  it('unknown keys and capabilities are refused', () => {
    assert.match(errorsOf({ ...goodEdge, privileged: true }).join(), /edge: unknown key privileged/);
    assert.match(errorsOf({ ...goodEdge, capabilities: { bluetooth: true } }).join(), /unknown capability bluetooth/);
    assert.match(errorsOf('edge/index.js').join(), /edge: invalid/);
  });
});

describe('capability keys', () => {
  it('flat sorted list, descriptions in both languages', () => {
    const list = edgeManifest.capabilityList(goodEdge.capabilities);
    assert.deepEqual(list, ['http.lan', 'mdns:_shelly._tcp', 'mqtt.topic:shellies/#', 'serial:zigbee', 'tcp.lan', 'udp.multicast:224.0.1.187', 'udp.port:5683']);
    const de = edgeManifest.describe(goodEdge.capabilities, 'de');
    assert.equal(de.find((x) => x.key === 'udp.port:5683').text, 'UDP-Port 5683 im Heimnetz (senden/empfangen)');
    assert.equal(edgeManifest.describe(goodEdge.capabilities, 'en').find((x) => x.key === 'serial:zigbee').text, 'Serial device "zigbee"');
  });

  it('http.selfSigned: an own key, confirmed with a warning', () => {
    const r = check({ entry: 'edge/index.js', capabilities: { http: { lan: true, selfSigned: true } } });
    assert.deepEqual(r.manifest.edge.capabilities, { http: { lan: true, selfSigned: true } });
    assert.deepEqual(edgeManifest.capabilityList(r.manifest.edge.capabilities), ['http.lan', 'http.selfSigned']);
    assert.equal(edgeManifest.describe(r.manifest.edge.capabilities, 'de').find((x) => x.key === 'http.selfSigned').warning, true);
    assert.deepEqual(edgeManifest.newCapabilities(r.manifest.edge.capabilities, ['http.lan']), ['http.selfSigned']);
  });

  it('newCapabilities: only what is not approved yet', () => {
    const approved = ['udp.port:5683', 'http.lan'];
    assert.deepEqual(edgeManifest.newCapabilities({ udp: { ports: [5683], multicast: [] }, http: { lan: true } }, approved), []);
    assert.deepEqual(edgeManifest.newCapabilities({ udp: { ports: [5683, 6000], multicast: [] } }, approved), ['udp.port:6000']);
    // fewer capabilities need no new approval
    assert.deepEqual(edgeManifest.newCapabilities({}, approved), []);
  });

  it('filterCovers: MQTT filter containment', () => {
    const c = edgeManifest.filterCovers;
    assert.equal(c('shellies/#', 'shellies/kitchen/#'), true);
    assert.equal(c('shellies/#', 'shellies/+/relay/0'), true);
    assert.equal(c('shellies/#', 'shellies'), true);
    assert.equal(c('shellies/+/relay', 'shellies/a/relay'), true);
    assert.equal(c('shellies/+/relay', 'shellies/+/relay'), true);
    assert.equal(c('shellies/+/relay', 'shellies/#'), false);
    assert.equal(c('shellies/+', 'shellies/a/b'), false);
    assert.equal(c('shellies/#', 'other/x'), false);
    assert.equal(c('a/b', 'a/+'), false);
  });
});

describe('install of a package with a broken edge section', () => {
  before(() => { require('../src/db/migrations').runMigrations(); });
  it('is refused with the manifest errors', () => {
    // plugin-pack refuses to build it, so put it together by hand (signed: the manifest is what fails)
    const { EDGE_DEMO, trusted } = require('./helpers/plugins');
    const { collect } = require('../scripts/plugin-pack');
    const pkg = require('../src/services/plugins/package');
    const signature = require('../src/services/plugins/signature');
    const files = collect(EDGE_DEMO);
    const raw = JSON.parse(files.get('plugin.json').toString('utf8'));
    files.set('plugin.json', Buffer.from(JSON.stringify({ ...raw, edge: { ...raw.edge, memoryMb: 1024 } })));
    const plugins = require('../src/services/plugins');
    const r = plugins.inspect(pkg.encode(signature.sign(files, trusted.privateSeed)), 'de');
    assert.equal(r.canInstall, false);
    assert.equal(r.token, null);
    const c = r.checks.find((x) => x.key === 'manifest');
    assert.equal(c.status, 'fail');
    assert.match(c.params.errors, /edge\.memoryMb: invalid \(16…256\)/);
  });

  it('a valid one shows memory and capabilities in the install dialog', () => {
    const { edgePackage } = require('./helpers/plugins');
    const plugins = require('../src/services/plugins');
    const r = plugins.inspect(edgePackage(), 'en');
    assert.equal(r.canInstall, true, JSON.stringify(r.checks));
    assert.equal(r.plugin.permissions.edge.memoryMb, 48);
    assert.equal(r.plugin.permissions.edge.minGateway, '1.20.0');
    assert.deepEqual(r.plugin.permissions.edge.capabilities.map((x) => x.key), ['http.lan', 'mqtt.topic:shellies/#', 'udp.multicast:224.0.1.187', 'udp.port:5683']);
  });
});
