// tests/migration_56.test.js
'use strict';
const crypto = require('node:crypto');
process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown } = require('./helpers/setup');
const { getDb } = require('../src/db/connection');

let db;
before(async () => { await setup(); db = getDb(); });
after(() => teardown());

describe('Migration 56: phase 2b columns', () => {
  const cols = () => db.pragma('table_info(rdp_routes)').map((c) => c.name);
  it('adds ssh/sftp credential + rdp-audio columns', () => {
    const c = cols();
    for (const k of ['ssh_private_key_encrypted','ssh_passphrase_encrypted','sftp_password_encrypted',
      'sftp_private_key_encrypted','sftp_passphrase_encrypted','rdp_disable_audio']) {
      assert.ok(c.includes(k), 'missing ' + k);
    }
  });
  it('rdp_disable_audio defaults NULL', () => {
    const id = db.prepare("INSERT INTO rdp_routes (name, host, port) VALUES ('m','10.0.0.9',22)").run().lastInsertRowid;
    const row = db.prepare('SELECT rdp_disable_audio FROM rdp_routes WHERE id=?').get(id);
    assert.equal(row.rdp_disable_audio, null);
  });
});
