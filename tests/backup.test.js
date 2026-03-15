'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

// Use a temp DB for tests
const tmpDb = path.join(__dirname, 'test-backup.db');
process.env.GC_DB_PATH = tmpDb;
process.env.GC_ENCRYPTION_KEY = 'a'.repeat(64);

describe('backup service', () => {
  let backup, getDb, closeDb, encrypt;

  before(() => {
    const conn = require('../src/db/connection');
    getDb = conn.getDb;
    closeDb = conn.closeDb;
    const { runMigrations } = require('../src/db/migrations');
    runMigrations();
    encrypt = require('../src/utils/crypto').encrypt;
    backup = require('../src/services/backup');

    // Pre-mock WG/Caddy so restore doesn't try real system calls
    require('../src/services/peers').rewriteWgConfig = async () => {};
    require('../src/services/routes').syncToCaddy = async () => {};
  });

  after(() => {
    closeDb();
    try { fs.unlinkSync(tmpDb); } catch {}
  });

  function clearData() {
    const db = getDb();
    db.prepare('DELETE FROM routes').run();
    db.prepare('DELETE FROM peers').run();
    db.prepare('DELETE FROM settings').run();
    db.prepare('DELETE FROM webhooks').run();
  }

  it('creates a backup with correct structure', () => {
    clearData();
    const db = getDb();
    db.prepare("INSERT INTO peers (name, public_key, private_key_encrypted, preshared_key_encrypted, allowed_ips, enabled) VALUES (?, ?, ?, ?, ?, 1)")
      .run('test-peer', 'pubkey123', encrypt('privkey'), encrypt('psk'), '10.8.0.2/32');
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run('test_key', 'test_value');
    db.prepare("INSERT INTO webhooks (url, events, description, enabled) VALUES (?, ?, ?, 1)")
      .run('https://example.com/hook', '*', 'Test hook');

    const result = backup.createBackup();

    assert.equal(result.version, 2);
    assert.ok(result.created_at);
    assert.equal(result.data.peers.length, 1);
    assert.equal(result.data.peers[0].name, 'test-peer');
    assert.equal(result.data.peers[0].private_key, 'privkey');
    assert.equal(result.data.peers[0].preshared_key, 'psk');
    assert.equal(result.data.settings.length, 1);
    assert.equal(result.data.webhooks.length, 1);
  });

  it('validates backup structure', () => {
    assert.ok(backup.validateBackup(null).length > 0);
    assert.ok(backup.validateBackup({}).length > 0);
    assert.ok(backup.validateBackup({ version: 999, data: {} }).length > 0);

    const valid = {
      version: 2,
      created_at: new Date().toISOString(),
      data: { peers: [], routes: [], settings: [], webhooks: [] },
    };
    assert.equal(backup.validateBackup(valid).length, 0);
  });

  it('rejects peers without required fields', () => {
    const bad = {
      version: 2,
      data: {
        peers: [{ name: null }],
        routes: [],
        settings: [],
        webhooks: [],
      },
    };
    const errors = backup.validateBackup(bad);
    assert.ok(errors.some(e => e.includes('Peer #1')));
  });

  it('returns backup summary', () => {
    const data = {
      version: 2,
      created_at: '2026-01-01T00:00:00.000Z',
      data: {
        peers: [{ name: 'a' }, { name: 'b' }],
        routes: [{ domain: 'x.com' }],
        settings: [{ key: 'k', value: 'v' }],
        webhooks: [],
      },
    };
    const summary = backup.getBackupSummary(data);
    assert.equal(summary.peers, 2);
    assert.equal(summary.routes, 1);
    assert.equal(summary.settings, 1);
    assert.equal(summary.webhooks, 0);
  });

  it('roundtrip: backup and restore produces same data', async () => {
    clearData();
    const db = getDb();

    // Insert test data
    db.prepare("INSERT INTO peers (name, public_key, private_key_encrypted, preshared_key_encrypted, allowed_ips, dns, persistent_keepalive, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, 1)")
      .run('peer1', 'pk1', encrypt('priv1'), encrypt('psk1'), '10.8.0.2/32', '1.1.1.1', 25);
    db.prepare("INSERT INTO peers (name, public_key, private_key_encrypted, preshared_key_encrypted, allowed_ips, dns, persistent_keepalive, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, 0)")
      .run('peer2', 'pk2', encrypt('priv2'), encrypt('psk2'), '10.8.0.3/32', '8.8.8.8', 15);

    const peerId = db.prepare("SELECT id FROM peers WHERE name = 'peer1'").get().id;
    db.prepare("INSERT INTO routes (domain, target_ip, target_port, peer_id, https_enabled, enabled) VALUES (?, ?, ?, ?, 1, 1)")
      .run('test.example.com', '10.8.0.2', 8080, peerId);

    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run('theme', 'dark');
    db.prepare("INSERT INTO webhooks (url, events, description, enabled) VALUES (?, ?, ?, 1)")
      .run('https://hooks.example.com', '*', 'My hook');

    // Create backup
    const backupData = backup.createBackup();

    // Clear everything
    clearData();
    assert.equal(db.prepare('SELECT COUNT(*) as c FROM peers').get().c, 0);

    // Restore
    const result = await backup.restoreBackup(backupData);
    assert.equal(result.peers, 2);
    assert.equal(result.routes, 1);
    assert.equal(result.settings, 1);
    assert.equal(result.webhooks, 1);

    // Verify restored data
    const restoredPeers = db.prepare('SELECT * FROM peers ORDER BY name').all();
    assert.equal(restoredPeers.length, 2);
    assert.equal(restoredPeers[0].name, 'peer1');
    assert.equal(restoredPeers[0].enabled, 1);
    assert.equal(restoredPeers[1].name, 'peer2');
    assert.equal(restoredPeers[1].enabled, 0);

    // Verify route links back to peer
    const restoredRoutes = db.prepare('SELECT r.*, p.name as peer_name FROM routes r LEFT JOIN peers p ON r.peer_id = p.id').all();
    assert.equal(restoredRoutes.length, 1);
    assert.equal(restoredRoutes[0].domain, 'test.example.com');
    assert.equal(restoredRoutes[0].peer_name, 'peer1');

    // Verify settings
    const s = db.prepare("SELECT value FROM settings WHERE key = 'theme'").get();
    assert.equal(s.value, 'dark');
  });

  it('rejects invalid backup on restore', async () => {
    await assert.rejects(
      () => backup.restoreBackup({ version: 999 }),
      /validation failed/
    );
  });
});
