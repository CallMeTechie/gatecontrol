'use strict';

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');

process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

describe('crypto: master key rotation marks gateways needs_repair', () => {
  let gateways, cryptoUtils, peerId;

  before(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-rot-'));
    process.env.GC_DB_PATH = path.join(tmp, 'test.db');
    process.env.GC_DATA_DIR = tmp;
    ['../config/default', '../src/db/connection', '../src/db/migrations', '../src/services/gateways', '../src/services/license', '../src/utils/crypto']
      .forEach(p => { try { delete require.cache[require.resolve(p)]; } catch (_) {} });
    require('../src/db/migrations').runMigrations();
    gateways = require('../src/services/gateways');
    cryptoUtils = require('../src/utils/crypto');

    const license = require('../src/services/license');
    license._overrideForTest && license._overrideForTest({ gateway_peers: 10 });

    const gw = await gateways.createGateway({ name: 'rot-gw', apiPort: 9876 });
    peerId = gw.peer.id;
  });

  it('after rotateMasterKey, all gateway_meta get needs_repair=1', () => {
    if (!cryptoUtils.rotateMasterKey) {
      assert.fail('rotateMasterKey not implemented');
    }
    cryptoUtils.rotateMasterKey();
    const db = require('../src/db/connection').getDb();
    const row = db.prepare('SELECT needs_repair FROM gateway_meta WHERE peer_id=?').get(peerId);
    assert.equal(row.needs_repair, 1);
  });
});
