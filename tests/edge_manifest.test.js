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
    assert.match(errorsOf({ ...goodEdge, capabilities: { http: { lan: true, insecure: true } } }).join(), /http: invalid/);
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

  it('http.selfSigned is gone: refused at install with a clear message, never in a state', () => {
    for (const v of [true, false, 'yes']) {
      for (const lan of [true, false]) {
        const errs = errorsOf({ ...goodEdge, capabilities: { http: { lan, selfSigned: v } } }).join();
        assert.match(errs, /edge\.capabilities\.http\.selfSigned: no longer supported/, `${lan} ${v}`);
        assert.match(errs, /pinSha256/);
      }
    }
    // an install or approval snapshot from before (stored manifest JSON) → only http.lan reaches the gateway
    const old = { http: { lan: true, selfSigned: true }, tcp: { lan: true }, udp: { ports: [5683], multicast: [] } };
    assert.deepEqual(edgeManifest.forState(old), { http: { lan: true }, tcp: { lan: true }, udp: { ports: [5683], multicast: [] } });
    assert.deepEqual(edgeManifest.forState({ http: { lan: false, selfSigned: true } }), {});
    assert.deepEqual(edgeManifest.forState(null), {});
    assert.deepEqual(edgeManifest.forState(goodEdge.capabilities), check(goodEdge).manifest.edge.capabilities);
    // no key, no text, no warning for it any more; an old approval listing it changes nothing
    assert.deepEqual(edgeManifest.capabilityList(old), ['http.lan', 'tcp.lan', 'udp.port:5683']);
    assert.ok(edgeManifest.describe(old, 'de').every((x) => x.key !== 'http.selfSigned' && !x.warning));
    assert.deepEqual(edgeManifest.newCapabilities({ http: { lan: true } }, ['http.lan', 'http.selfSigned']), []);
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

describe('edge.optionalCapabilities', () => {
  const opt = (o) => ({ ...goodEdge, optionalCapabilities: o });

  it('the same form as capabilities, normalised; absent → not in the manifest', () => {
    const r = check(opt({ mqtt: { topics: ['zigbee2mqtt/#', 'tasmota/+/state'] } }));
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.deepEqual(r.manifest.edge.optionalCapabilities, { mqtt: { topics: ['zigbee2mqtt/#', 'tasmota/+/state'] } });
    assert.deepEqual(r.manifest.edge.capabilities, check(goodEdge).manifest.edge.capabilities, 'capabilities unchanged');
    assert.equal('optionalCapabilities' in check(goodEdge).manifest.edge, false);
    assert.deepEqual(check(opt({})).manifest.edge.optionalCapabilities, {});
  });

  it('only MQTT topics, tcp.lan and UDP ports/broadcast can be optional; the same rules; nothing that capabilities already holds', () => {
    for (const k of ['mdns', 'http', 'serial']) {
      const v = { mdns: { services: ['_x._tcp'] }, http: { lan: true }, serial: ['zigbee'] }[k];
      assert.match(errorsOf(opt({ [k]: v })).join(), new RegExp('edge\\.optionalCapabilities: ' + k + ' cannot be optional'), k);
    }
    assert.match(errorsOf(opt({ nope: true })).join(), /edge\.optionalCapabilities: nope cannot be optional/);
    assert.match(errorsOf(opt([])).join(), /edge\.optionalCapabilities: invalid/);
    assert.match(errorsOf(opt({ mqtt: { topics: ['#'] } })).join(), /edge\.optionalCapabilities\.mqtt\.topics: invalid topic/);
    assert.match(errorsOf(opt({ mqtt: { topics: ['$SYS/#'] } })).join(), /edge\.optionalCapabilities\.mqtt\.topics: invalid topic/);
    assert.match(errorsOf(opt({ mqtt: { topics: [] } })).join(), /edge\.optionalCapabilities\.mqtt\.topics: invalid/);
    assert.match(errorsOf(opt({ mqtt: { topics: ['a/#', 'a/#'] } })).join(), /edge\.optionalCapabilities\.mqtt\.topics: duplicate/);
    assert.match(errorsOf(opt({ mqtt: { topics: ['shellies/#'] } })).join(), /edge\.optionalCapabilities\.mqtt\.topics: already in capabilities/);
    // the gateway takes ≤ 16 topics per plugin: required and optional together
    const many = Array.from({ length: 16 }, (_, i) => 'x' + i + '/#');
    assert.match(errorsOf(opt({ mqtt: { topics: many } })).join(), /more than 16 together with capabilities/);
    assert.equal(check(opt({ mqtt: { topics: many.slice(0, 15) } })).ok, true);
  });

  it('never part of newCapabilities (no update_pending); keys, approved ones and the state caps', () => {
    const edge = check(opt({ mqtt: { topics: ['zigbee2mqtt/#'] } })).manifest.edge;
    const approved = edgeManifest.capabilityList(edge.capabilities);
    assert.deepEqual(edgeManifest.newCapabilities(edge.capabilities, approved), []);
    assert.deepEqual(edgeManifest.optionalList(edge), ['mqtt.topic:zigbee2mqtt/#']);
    assert.deepEqual(edgeManifest.optionalList({ capabilities: {} }), []);
    assert.deepEqual(edgeManifest.approvedOptional(edge, ['mqtt.topic:zigbee2mqtt/#', 'mqtt.topic:gone/#']), ['mqtt.topic:zigbee2mqtt/#']);
    assert.deepEqual(edgeManifest.approvedOptional(edge, null), []);
    assert.deepEqual(edgeManifest.withOptional(edge.capabilities, ['mqtt.topic:zigbee2mqtt/#']).mqtt, { topics: ['shellies/#', 'zigbee2mqtt/#'] });
    assert.deepEqual(edgeManifest.withOptional({ udp: { ports: [6000], multicast: [] } }, ['mqtt.topic:z/#']), { udp: { ports: [6000], multicast: [] }, mqtt: { topics: ['z/#'] } });
    assert.deepEqual(edgeManifest.withOptional(edge.capabilities, []), edge.capabilities);
    assert.deepEqual(edgeManifest.describe(edge.optionalCapabilities, 'de').map((x) => x.text), ['MQTT-Themen zigbee2mqtt/# am lokalen Broker']);
  });

  // Tuya and the like: TCP to devices in the LAN, UDP ports for the scan and broadcast to them — per gateway
  const zigbeeOnly = { entry: 'edge/index.js', capabilities: { mqtt: { topics: ['shellies/#'] }, udp: { ports: [5683], multicast: [] } } };
  const tuya = { tcp: { lan: true }, udp: { ports: [7000, 6666, 6667], broadcast: true } };

  it('tcp.lan, udp.port:<n> and udp.broadcast as optional keys (normalised, sorted)', () => {
    const r = check({ ...zigbeeOnly, optionalCapabilities: tuya });
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.deepEqual(r.manifest.edge.optionalCapabilities, { tcp: { lan: true }, udp: { ports: [6666, 6667, 7000], multicast: [], broadcast: true } });
    assert.deepEqual(edgeManifest.optionalList(r.manifest.edge), ['tcp.lan', 'udp.broadcast', 'udp.port:6666', 'udp.port:6667', 'udp.port:7000']);
    const de = edgeManifest.describe(r.manifest.edge.optionalCapabilities, 'de');
    assert.equal(de.find((x) => x.key === 'udp.broadcast').text, 'UDP-Broadcast im Heimnetz (nur an die UDP-Ports des Plugins)');
    assert.equal(de.find((x) => x.key === 'tcp.lan').text, 'TCP-Verbindungen zu Geräten im Heimnetz');
    // broadcast alone, its ports from capabilities
    assert.equal(check({ ...zigbeeOnly, optionalCapabilities: { udp: { broadcast: true } } }).ok, true);
    // the gateway feature each key needs
    assert.equal(edgeManifest.optionalFeature('tcp.lan'), 'edge-optional-lan');
    assert.equal(edgeManifest.optionalFeature('udp.port:6667'), 'edge-optional-lan');
    assert.equal(edgeManifest.optionalFeature('udp.broadcast'), 'edge-optional-lan');
    assert.equal(edgeManifest.optionalFeature('mqtt.topic:zigbee2mqtt/#'), 'edge-optional-caps');
  });

  it('optional tcp/udp: kept narrow, never twice, ≤ 16 ports together', () => {
    const e = (o, base = zigbeeOnly) => errorsOf({ ...base, optionalCapabilities: o }).join();
    assert.match(e({ tcp: { lan: false } }), /optionalCapabilities\.tcp: only \{ "lan": true \} can be optional/);
    assert.match(e({ tcp: { lan: true } }, goodEdge), /optionalCapabilities\.tcp: already in capabilities/);
    assert.match(e({ udp: { ports: [5683] } }), /optionalCapabilities\.udp\.ports: already in capabilities/);
    assert.match(e({ udp: { ports: [6000], multicast: ['239.1.2.3'] } }), /optionalCapabilities\.udp\.multicast: cannot be optional/);
    assert.match(e({ udp: { ports: [53] } }), /optionalCapabilities\.udp\.ports: below 1024/);
    assert.match(e({ udp: { ports: [5353] } }), /5353 only through capabilities\.mdns/);
    assert.match(e({ udp: { ports: [6000], broadcast: 'yes' } }), /optionalCapabilities\.udp\.broadcast: invalid/);
    assert.match(e({ udp: { ports: [6000], extra: 1 } }), /optionalCapabilities\.udp: invalid/);
    assert.match(e({ udp: { broadcast: true } }, { entry: 'edge/index.js', capabilities: {} }), /optionalCapabilities\.udp\.broadcast: needs udp\.ports/);
    assert.match(e({ udp: { broadcast: true } }, { entry: 'edge/index.js', capabilities: { udp: { ports: [6000], broadcast: true } } }), /udp\.broadcast: already in capabilities/);
    const many = Array.from({ length: 16 }, (_, i) => 20000 + i);
    assert.match(e({ udp: { ports: many } }), /optionalCapabilities\.udp\.ports: more than 16 together with capabilities/);
    assert.equal(check({ ...zigbeeOnly, optionalCapabilities: { udp: { ports: many.slice(0, 15) } } }).ok, true);
    // as a regular capability: broadcast needs ports, false is dropped
    assert.match(errorsOf({ entry: 'edge/index.js', capabilities: { udp: { broadcast: true } } }).join(), /edge\.capabilities\.udp\.broadcast: needs udp\.ports/);
    assert.deepEqual(check({ entry: 'edge/index.js', capabilities: { udp: { ports: [6000], broadcast: false } } }).manifest.edge.capabilities, { udp: { ports: [6000], multicast: [] } });
    assert.deepEqual(edgeManifest.capabilityList({ udp: { ports: [6000], multicast: [], broadcast: true } }), ['udp.broadcast', 'udp.port:6000']);
  });

  it('withOptional: only the confirmed tcp/udp keys reach the state caps', () => {
    const edge = check({ ...zigbeeOnly, optionalCapabilities: tuya }).manifest.edge;
    assert.deepEqual(edgeManifest.withOptional(edge.capabilities, []), edge.capabilities, 'nothing confirmed: nothing more');
    assert.deepEqual(edgeManifest.withOptional(edge.capabilities, ['tcp.lan']), { ...edge.capabilities, tcp: { lan: true } });
    assert.deepEqual(edgeManifest.withOptional(edge.capabilities, ['udp.port:7000', 'udp.port:6667']).udp, { ports: [5683, 6667, 7000], multicast: [] });
    assert.deepEqual(edgeManifest.withOptional(edge.capabilities, ['udp.port:6666', 'udp.broadcast']).udp, { ports: [5683, 6666], multicast: [], broadcast: true });
    assert.deepEqual(edgeManifest.withOptional({}, ['udp.port:6666']), { udp: { ports: [6666], multicast: [] } });
    assert.deepEqual(edgeManifest.withOptional({}, ['udp.port:abc', 'tcp.lanx']), {}, 'only well-formed keys');
    // the approved keys are filtered against the declaration first (approvedOptional)
    assert.deepEqual(edgeManifest.approvedOptional(edge, ['tcp.lan', 'udp.port:9999', 'http.lan']), ['tcp.lan']);
    // forState keeps broadcast
    assert.deepEqual(edgeManifest.forState({ udp: { ports: [7000], multicast: [], broadcast: true } }), { udp: { ports: [7000], multicast: [], broadcast: true } });
  });
});

describe('migration 161 (edge_optional_capabilities)', () => {
  before(() => { require('../src/db/migrations').runMigrations(); });
  it('exists, has a unique version and adds the two columns', () => {
    const list = require('../src/db/migrationList').migrations;
    const versions = list.map((x) => x.version);
    assert.equal(new Set(versions).size, versions.length, 'every version once');
    assert.ok(Math.max(...versions) >= 161, 'newest migration at least 161');
    assert.equal(list.find((x) => x.version === 161).name, 'edge_optional_capabilities');
    const cols = require('../src/db/connection').getDb().prepare('PRAGMA table_info(edge_assignments)').all().map((c) => c.name);
    assert.ok(cols.includes('opt_caps_list') && cols.includes('opt_requests'), cols.join());
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
    assert.deepEqual(r.plugin.permissions.edge.optionalCapabilities, []);
    const pj = require('./fixtures/plugins/edge-demo/plugin.json');
    const withOpt = plugins.inspect(edgePackage({ overrides: { edge: { ...pj.edge, optionalCapabilities: { mqtt: { topics: ['zigbee2mqtt/#'] } } } } }), 'en');
    assert.equal(withOpt.canInstall, true, JSON.stringify(withOpt.checks));
    assert.deepEqual(withOpt.plugin.permissions.edge.optionalCapabilities.map((x) => x.key), ['mqtt.topic:zigbee2mqtt/#']);
    assert.deepEqual(withOpt.plugin.permissions.edge.capabilities.map((x) => x.key), r.plugin.permissions.edge.capabilities.map((x) => x.key));
  });
});
