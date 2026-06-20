'use strict';
process.env.NODE_ENV = 'test'; // MUST be first
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path'); const fs = require('node:fs'); const os = require('node:os'); const crypto = require('node:crypto');
process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

// A gateway whose push_token_encrypted is undecryptable (partial enrollment /
// corrupt row) must NOT crash the server when an admin triggers a push action.
// decrypt() throws "Invalid ciphertext format"; the push helpers must treat that
// as "gateway unreachable" (their existing no-row sentinel), not let it escape.
describe('gateway push-token decrypt is non-fatal', () => {
  let gateways, db, peerId;
  before(() => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-ptd-'));
    process.env.GC_DB_PATH = path.join(tmp, 'test.db'); process.env.GC_DATA_DIR = tmp;
    require('../src/db/migrations').runMigrations();
    gateways = require('../src/services/gateways');
    db = require('../src/db/connection').getDb();
    peerId = db.prepare("INSERT INTO peers (name,public_key,allowed_ips,enabled,peer_type) VALUES ('gw','k1','10.8.0.9/32',1,'gateway')").run().lastInsertRowid;
    db.prepare(`INSERT INTO gateway_meta (peer_id, api_port, api_token_hash, push_token_encrypted, created_at)
      VALUES (?, 9876, 'h', 'not-valid-ciphertext', strftime('%s','now')*1000)`).run(peerId);
  });

  it('notifyLanScan resolves null instead of throwing', async () => {
    const r = await gateways.notifyLanScan(peerId, { request_id: 'x', subnets: ['192.168.2.0/24'], category_mode: 'include', categories: [], active_scan: false, timeout_ms: 1000 });
    assert.equal(r, null);
  });
  it('probeGatewayTarget resolves null instead of throwing', async () => {
    const r = await gateways.probeGatewayTarget(peerId, '192.168.2.10', 445);
    assert.equal(r, null);
  });
  it('notifySelfUpdate resolves { ok: false } instead of throwing', async () => {
    const r = await gateways.notifySelfUpdate(peerId, { request_id: 'x', target_version: '1.0.0' });
    assert.deepEqual(r, { ok: false });
  });
  it('notifyConfigChanged resolves without throwing', async () => {
    await assert.doesNotReject(async () => { await gateways.notifyConfigChanged(peerId); });
  });
});
