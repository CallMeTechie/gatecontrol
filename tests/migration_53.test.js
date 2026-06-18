// tests/migration_53.test.js
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

describe('Migration 53: rdp_routes protocol generalization', () => {
  const cols = () => db.pragma('table_info(rdp_routes)').map((c) => c.name);

  it('adds protocol + browser columns', () => {
    const c = cols();
    for (const name of [
      'protocol', 'browser_enabled', 'browser_enable_sftp', 'sftp_host',
      'sftp_port', 'sftp_username', 'sftp_disable_download', 'sftp_disable_upload',
      'browser_enable_audio', 'audio_servername', 'browser_clipboard',
    ]) {
      assert.ok(c.includes(name), `missing column ${name}`);
    }
  });

  it('backfills existing rows to protocol=rdp with safe security defaults', () => {
    const id = db.prepare(
      "INSERT INTO rdp_routes (name, host, port) VALUES ('legacy', '10.0.0.9', 3389)"
    ).run().lastInsertRowid;
    const row = db.prepare('SELECT * FROM rdp_routes WHERE id = ?').get(id);
    assert.equal(row.protocol, 'rdp');
    assert.equal(row.browser_enabled, 0);
    assert.equal(row.browser_clipboard, 0);
    assert.equal(row.sftp_disable_download, 1);
    assert.equal(row.sftp_disable_upload, 1);
  });

  it('allows NULL in the new columns (restore-of-old-backup safety)', () => {
    const id = db.prepare(
      "INSERT INTO rdp_routes (name, host, port, protocol, browser_enabled) VALUES ('restored', '10.0.0.10', 3389, NULL, NULL)"
    ).run().lastInsertRowid;
    const row = db.prepare('SELECT protocol, browser_enabled FROM rdp_routes WHERE id = ?').get(id);
    assert.equal(row.protocol, null);
    assert.equal(row.browser_enabled, null);
  });
});
