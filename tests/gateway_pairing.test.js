'use strict';

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');

process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

describe('gateways pairing-code', () => {
  let gateways, db;

  before(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-pair-'));
    process.env.GC_DB_PATH = path.join(tmp, 'test.db');
    process.env.GC_DATA_DIR = tmp;
    ['../config/default', '../src/db/connection', '../src/db/migrations',
     '../src/services/gateways', '../src/services/license']
      .forEach(p => { try { delete require.cache[require.resolve(p)]; } catch (_) {} });
    require('../src/db/migrations').runMigrations();
    gateways = require('../src/services/gateways');
    db = require('../src/db/connection').getDb();
  });

  it('createPairingCode returns code in XXXX-XXXX-XXXX-XXXX@host format', async () => {
    const gw = await gateways.createGateway({ name: 'pair-gw-1', apiPort: 9876 });
    const { code, token, expiresAt } = gateways.createPairingCode(gw.peer.id);

    assert.match(code, /^[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}$/);
    assert.match(token, /^[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}@.+$/);
    assert.equal(token.split('@')[0], code);
    assert.ok(expiresAt > Date.now());
    assert.ok(expiresAt <= Date.now() + 11 * 60 * 1000); // 10 min + a hair
  });

  it('persists only the SHA-256 hash, never the cleartext code', async () => {
    const gw = await gateways.createGateway({ name: 'pair-gw-2', apiPort: 9876 });
    const { code } = gateways.createPairingCode(gw.peer.id);

    const rows = db.prepare('SELECT code_hash FROM gateway_pairing_codes WHERE peer_id=?').all(gw.peer.id);
    assert.equal(rows.length, 1);
    assert.notEqual(rows[0].code_hash, code, 'hash must not equal cleartext code');
    const expectedHash = crypto.createHash('sha256').update(code).digest('hex');
    assert.equal(rows[0].code_hash, expectedHash);
  });

  it('regenerating a code invalidates the previous one (single-active)', async () => {
    const gw = await gateways.createGateway({ name: 'pair-gw-3', apiPort: 9876 });
    const first = gateways.createPairingCode(gw.peer.id);
    const second = gateways.createPairingCode(gw.peer.id);
    assert.notEqual(first.code, second.code);

    const rows = db.prepare('SELECT code_hash FROM gateway_pairing_codes WHERE peer_id=?').all(gw.peer.id);
    assert.equal(rows.length, 1, 'only the latest code should remain');

    // Old code can no longer be redeemed
    assert.throws(() => gateways.redeemPairingCode(first.code, '127.0.0.1'),
      err => err.code === 'invalid_or_expired');
  });

  it('redeemPairingCode returns env content and consumes the code', async () => {
    const gw = await gateways.createGateway({ name: 'pair-gw-4', apiPort: 9876 });
    const { code } = gateways.createPairingCode(gw.peer.id);

    const { envContent } = gateways.redeemPairingCode(code, '203.0.113.7');
    assert.match(envContent, /^GC_SERVER_URL=/m);
    assert.match(envContent, /^GC_API_TOKEN=gc_gw_[a-f0-9]{64}/m);
    assert.match(envContent, /^GC_GATEWAY_TOKEN=[a-f0-9]{64}/m);
    assert.match(envContent, /^WG_PRIVATE_KEY=/m);

    const row = db.prepare('SELECT consumed_at, consumed_from_ip FROM gateway_pairing_codes WHERE peer_id=?').get(gw.peer.id);
    assert.ok(row.consumed_at > 0);
    assert.equal(row.consumed_from_ip, '203.0.113.7');
  });

  it('a redeemed code cannot be redeemed twice', async () => {
    const gw = await gateways.createGateway({ name: 'pair-gw-5', apiPort: 9876 });
    const { code } = gateways.createPairingCode(gw.peer.id);

    gateways.redeemPairingCode(code, '127.0.0.1');
    assert.throws(() => gateways.redeemPairingCode(code, '127.0.0.1'),
      err => err.code === 'invalid_or_expired');
  });

  it('rejects an expired code without consuming it', async () => {
    const gw = await gateways.createGateway({ name: 'pair-gw-6', apiPort: 9876 });
    const { code } = gateways.createPairingCode(gw.peer.id);

    // Backdate expires_at to one second ago.
    db.prepare('UPDATE gateway_pairing_codes SET expires_at = ? WHERE peer_id = ?')
      .run(Date.now() - 1000, gw.peer.id);

    assert.throws(() => gateways.redeemPairingCode(code, '127.0.0.1'),
      err => err.code === 'invalid_or_expired');

    const row = db.prepare('SELECT consumed_at FROM gateway_pairing_codes WHERE peer_id=?').get(gw.peer.id);
    assert.equal(row.consumed_at, null, 'expired code must not be marked consumed');
  });

  it('rejects malformed input strings before any DB lookup', async () => {
    for (const bad of ['', 'not-a-code', 'AAAA-BBBB-CCCC', 'ZZZZ-ZZZZ-ZZZZ-ZZZZ', 12345, null, undefined]) {
      assert.throws(() => gateways.redeemPairingCode(bad, '127.0.0.1'),
        err => err.code === 'invalid_or_expired',
        `should reject: ${JSON.stringify(bad)}`);
    }
  });

  it('redemption rotates the gateway tokens (old api_token stops working)', async () => {
    const gw = await gateways.createGateway({ name: 'pair-gw-7', apiPort: 9876 });
    const { hashToken } = require('../src/middleware/gatewayAuth');
    const oldHash = db.prepare('SELECT api_token_hash FROM gateway_meta WHERE peer_id=?').get(gw.peer.id).api_token_hash;
    assert.equal(oldHash, hashToken(gw.apiToken));

    const { code } = gateways.createPairingCode(gw.peer.id);
    gateways.redeemPairingCode(code, '127.0.0.1');

    const newHash = db.prepare('SELECT api_token_hash FROM gateway_meta WHERE peer_id=?').get(gw.peer.id).api_token_hash;
    assert.notEqual(newHash, oldHash, 'redemption must rotate the api_token');
  });

  it('rejects pairing-code creation for non-gateway peers', async () => {
    // Insert a non-gateway peer directly
    const r = db.prepare(`
      INSERT INTO peers (name, public_key, allowed_ips, peer_type)
      VALUES ('regular-peer', ?, '10.8.0.99/32', 'regular')
    `).run(crypto.randomBytes(32).toString('base64'));
    assert.throws(() => gateways.createPairingCode(r.lastInsertRowid),
      /not_a_gateway/);
  });

  it('cleanupExpiredPairingCodes removes only past-due rows', async () => {
    const gw = await gateways.createGateway({ name: 'pair-gw-8', apiPort: 9876 });
    gateways.createPairingCode(gw.peer.id);
    db.prepare('UPDATE gateway_pairing_codes SET expires_at = ? WHERE peer_id = ?')
      .run(Date.now() - 1000, gw.peer.id);

    const before = db.prepare('SELECT COUNT(*) AS c FROM gateway_pairing_codes WHERE peer_id=?').get(gw.peer.id).c;
    assert.equal(before, 1);

    const removed = gateways.cleanupExpiredPairingCodes();
    assert.ok(removed >= 1);

    const after = db.prepare('SELECT COUNT(*) AS c FROM gateway_pairing_codes WHERE peer_id=?').get(gw.peer.id).c;
    assert.equal(after, 0);
  });
});
