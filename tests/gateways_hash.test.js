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

  it('hash matches library computation (byte-identical)', () => {
    const cfg = gateways.getGatewayConfig(gwPeerId);
    const ourHash = gateways.computeConfigHash(gwPeerId);
    const libComputed = libHash(cfg);
    assert.equal(ourHash, libComputed);
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
