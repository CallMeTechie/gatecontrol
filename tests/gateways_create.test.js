'use strict';

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');

process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

describe('gateways.createGateway', () => {
  let gateways, db;

  before(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-gw-'));
    process.env.GC_DB_PATH = path.join(tmp, 'test.db');
    process.env.GC_DATA_DIR = tmp;
    ['../config/default', '../src/db/connection', '../src/db/migrations', '../src/services/gateways', '../src/services/license']
      .forEach(p => { try { delete require.cache[require.resolve(p)]; } catch (_) {} });
    require('../src/db/migrations').runMigrations();
    gateways = require('../src/services/gateways');
    db = require('../src/db/connection').getDb();
  });

  it('creates peer with peer_type=gateway and gateway_meta row', async () => {
    const result = await gateways.createGateway({ name: 'homelab-gw', apiPort: 9876 });
    assert.ok(result.peer.id > 0);
    assert.equal(result.peer.peer_type, 'gateway');

    const meta = db.prepare('SELECT * FROM gateway_meta WHERE peer_id=?').get(result.peer.id);
    assert.ok(meta);
    assert.equal(meta.api_port, 9876);
    assert.ok(meta.api_token_hash);
    assert.ok(meta.push_token_encrypted);
  });

  it('returns plaintext api_token and push_token (for gateway.env)', async () => {
    // Override license cache to allow more gateways for this specific test
    const license = require('../src/services/license');
    license._overrideForTest && license._overrideForTest({ gateway_peers: 10 });

    const result = await gateways.createGateway({ name: 'gw2', apiPort: 9876 });
    assert.match(result.apiToken, /^gc_gw_[a-f0-9]{64}$/);
    assert.match(result.pushToken, /^[a-f0-9]{64}$/);
    assert.notEqual(result.apiToken, result.pushToken);
  });

  it('api_token_hash is SHA-256 of api_token (sha256: prefix)', async () => {
    const license = require('../src/services/license');
    license._overrideForTest && license._overrideForTest({ gateway_peers: 10 });

    const result = await gateways.createGateway({ name: 'gw3', apiPort: 9876 });
    const expectedHash = 'sha256:' + crypto.createHash('sha256').update(result.apiToken).digest('hex');
    const meta = db.prepare('SELECT api_token_hash FROM gateway_meta WHERE peer_id=?').get(result.peer.id);
    assert.equal(meta.api_token_hash, expectedHash);
  });

  it('enforces license limit gateway_peers', async () => {
    // Force license to community fallback (gateway_peers=1) and count existing gateways.
    const license = require('../src/services/license');
    license._overrideForTest && license._overrideForTest({ gateway_peers: 1 });

    await assert.rejects(async () => {
      for (let i = 0; i < 3; i++) {
        await gateways.createGateway({ name: `gw-over-${i}`, apiPort: 9876 });
      }
    }, /gateway_peers|license/i);
  });
});
