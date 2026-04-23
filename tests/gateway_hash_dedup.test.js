'use strict';

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');

process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

describe('gatewayAuth.hashToken — format invariants', () => {
  const gatewayAuth = require('../src/middleware/gatewayAuth');

  it('returns sha256:<64-hex> format', () => {
    const h = gatewayAuth.hashToken('any-token');
    assert.match(h, /^sha256:[0-9a-f]{64}$/);
  });

  it('is deterministic for same input', () => {
    assert.equal(
      gatewayAuth.hashToken('gc_gw_abc'),
      gatewayAuth.hashToken('gc_gw_abc')
    );
  });

  it('matches raw sha256 of input with sha256: prefix', () => {
    const input = 'gc_gw_deadbeef';
    const expected = 'sha256:' + crypto.createHash('sha256').update(input).digest('hex');
    assert.equal(gatewayAuth.hashToken(input), expected);
  });
});

describe('gateway token roundtrip — createGateway ↔ requireGateway hash compatibility', () => {
  let gateways, gatewayAuth, db;

  before(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-hashdup-'));
    process.env.GC_DB_PATH = path.join(tmp, 'test.db');
    process.env.GC_DATA_DIR = tmp;
    ['../config/default', '../src/db/connection', '../src/db/migrations',
      '../src/services/gateways', '../src/services/license', '../src/middleware/gatewayAuth']
      .forEach(p => { try { delete require.cache[require.resolve(p)]; } catch (_) {} });
    require('../src/db/migrations').runMigrations();
    gateways = require('../src/services/gateways');
    gatewayAuth = require('../src/middleware/gatewayAuth');
    db = require('../src/db/connection').getDb();
  });

  it('stored api_token_hash equals gatewayAuth.hashToken(apiToken)', async () => {
    const license = require('../src/services/license');
    license._overrideForTest && license._overrideForTest({ gateway_peers: 10 });

    const result = await gateways.createGateway({ name: 'roundtrip-gw', apiPort: 9876 });
    const meta = db.prepare('SELECT api_token_hash FROM gateway_meta WHERE peer_id=?').get(result.peer.id);
    assert.equal(
      meta.api_token_hash,
      gatewayAuth.hashToken(result.apiToken),
      'requireGateway re-computes hash on verify — stored and recomputed MUST match'
    );
  });
});
