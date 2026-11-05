'use strict';

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');

process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const { computeConfigHash: libHash } = require('@callmetechie/gatecontrol-config-hash');

describe('gateways.computeConfigHash', () => {
  let gateways, gwPeerId;

  before(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-gw-hash-'));
    process.env.GC_DB_PATH = path.join(tmp, 'test.db');
    process.env.GC_DATA_DIR = tmp;
    ['../config/default', '../src/db/connection', '../src/db/migrations', '../src/services/gateways', '../src/services/license']
      .forEach(p => { try { delete require.cache[require.resolve(p)]; } catch (_) {} });
    require('../src/db/migrations').runMigrations();
    gateways = require('../src/services/gateways');

    const license = require('../src/services/license');
    license._overrideForTest && license._overrideForTest({ gateway_peers: 10 });

    const gw = await gateways.createGateway({ name: 'gw-hash', apiPort: 9876 });
    gwPeerId = gw.peer.id;
  });

  it('hash matches library computation (byte-identical) for a config without features', () => {
    const { features, ...cfg } = gateways.getGatewayConfig(gwPeerId);
    assert.ok(features, 'the config pull carries features (phase 3a)');
    assert.equal(gateways.hashOfConfig(cfg), libHash(cfg));
  });

  it('features go into the hash: sha256(libHash + "\\n" + stableJson(features))', () => {
    const cfg = gateways.getGatewayConfig(gwPeerId);
    const { features, ...rest } = cfg;
    const expected = 'sha256:' + crypto.createHash('sha256').update(libHash(rest) + '\n' + gateways.stableJson(features), 'utf8').digest('hex');
    assert.equal(gateways.computeConfigHash(gwPeerId), expected);
    // the library alone would ignore them (schema strip)
    assert.equal(libHash(cfg), libHash(rest));
    // a switch changes the hash
    const before = gateways.computeConfigHash(gwPeerId);
    require('../src/services/gatewayFeatures').set(gwPeerId, { inetq: { speedtest: 'hourly' } });
    assert.notEqual(gateways.computeConfigHash(gwPeerId), before);
  });

  it('the gateway computes the same hash (gatecontrol-gateway src/features/config.js, 92e1468)', () => {
    // a copy of the gateway's own code — if the gateway changes it, this test is the reminder
    function gwStableJson(v) {
      if (v === null || typeof v !== 'object') return JSON.stringify(v);
      if (Array.isArray(v)) return '[' + v.map((x) => (x === undefined ? 'null' : gwStableJson(x))).join(',') + ']';
      const parts = [];
      for (const k of Object.keys(v).sort()) {
        if (v[k] === undefined) continue;
        parts.push(JSON.stringify(k) + ':' + gwStableJson(v[k]));
      }
      return '{' + parts.join(',') + '}';
    }
    function gwConfigHash(cfgBody, libComputeHash) {
      const { features, ...rest } = cfgBody || {};
      const lib = libComputeHash(rest);
      if (features === undefined) return lib;
      return 'sha256:' + crypto.createHash('sha256').update(lib + '\n' + gwStableJson(features), 'utf8').digest('hex');
    }
    // what the gateway does with the pull: the body without config_hash, through JSON
    require('../src/services/gatewayFeatures').set(gwPeerId, { ups: { enabled: true, host: '192.168.1.10', name: 'ups' }, inetq: { targets: ['9.9.9.9', '1.1.1.1'] } });
    const { config_hash: _h, ...pulled } = JSON.parse(JSON.stringify({ ...gateways.getGatewayConfig(gwPeerId), config_hash: 'x' }));
    assert.equal(gwConfigHash(pulled, libHash), gateways.computeConfigHash(gwPeerId));
  });

  it('stableJson sorts keys at every level and keeps array order', () => {
    assert.equal(gateways.stableJson({ b: 1, a: { d: [2, 1], c: null } }), '{"a":{"c":null,"d":[2,1]},"b":1}');
  });

  it('hash stable across repeated calls', () => {
    const a = gateways.computeConfigHash(gwPeerId);
    const b = gateways.computeConfigHash(gwPeerId);
    assert.equal(a, b);
  });

  it('hash format is sha256:<64-hex>', () => {
    const hash = gateways.computeConfigHash(gwPeerId);
    assert.match(hash, /^sha256:[0-9a-f]{64}$/);
  });
});
