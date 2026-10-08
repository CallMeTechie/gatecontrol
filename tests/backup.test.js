'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

// Use a temp DB for tests
// Die Test-DB liegt in os.tmpdir(), nicht im Repo-Baum: die CI checkt
// unprivilegiert aus und der lokale Lauf mountet /app read-only —
// eine DB neben den Testdateien schlägt dort fehl (und nur dort).
const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gc-test-backup-')), 'test.db');
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

    assert.equal(result.version, 5);
    assert.ok(result.created_at);
    assert.equal(result.data.peers.length, 1);
    assert.equal(result.data.peers[0].name, 'test-peer');
    assert.ok(result.data.peers[0].private_key_encrypted, 'should have encrypted private key');
    assert.ok(result.data.peers[0].preshared_key_encrypted, 'should have encrypted preshared key');
    assert.equal(result.data.peers[0].private_key, undefined, 'should not have plaintext private key');
    assert.equal(result.data.peers[0].preshared_key, undefined, 'should not have plaintext preshared key');
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

  it('roundtrip: service bundles survive backup/restore with re-mapped ids', async () => {
    clearData();
    const db = getDb();
    db.prepare('DELETE FROM service_bundles').run();

    const bundleId = db.prepare(
      "INSERT INTO service_bundles (name, domain) VALUES ('SSH Service', 'ssh.example.com')"
    ).run().lastInsertRowid;
    db.prepare(
      "INSERT INTO routes (domain, target_ip, target_port, bundle_id, enabled) VALUES ('ssh.example.com', '10.8.0.5', 80, ?, 1)"
    ).run(bundleId);
    db.prepare(
      "INSERT INTO routes (domain, target_ip, target_port, route_type, l4_protocol, l4_listen_port, l4_tls_mode, bundle_id, enabled) " +
      "VALUES (NULL, '10.8.0.5', 22, 'l4', 'tcp', '2022', 'none', ?, 1)"
    ).run(bundleId);

    const data = backup.createBackup();
    assert.equal(data.data.service_bundles.length, 1);
    assert.equal(data.data.service_bundles[0].bundle_ref, bundleId);

    await backup.restoreBackup(data);

    const restoredBundle = db.prepare('SELECT * FROM service_bundles').get();
    assert.equal(restoredBundle.name, 'SSH Service');
    const members = db.prepare('SELECT * FROM routes WHERE bundle_id = ?').all(restoredBundle.id);
    assert.equal(members.length, 2, 'both members re-link to the restored bundle');
  });

  it('restores pre-bundle backups without a service_bundles key', async () => {
    clearData();
    const db = getDb();
    db.prepare('DELETE FROM service_bundles').run();
    const data = backup.createBackup();
    delete data.data.service_bundles;
    await backup.restoreBackup(data);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM service_bundles').get().c, 0);
  });

  // Former built-in integrations (Smart Home, Klimaanlage, Fahrzeuge — plugins
  // now): their tables wait for the import, so backups carry them.
  it('roundtrip: built-in integration tables survive with re-mapped users and routes', async () => {
    clearData();
    const db = getDb();
    for (const t of ['smarthome_resource_owners', 'smarthome_resources', 'smarthome_gateways', 'midea_device_owners', 'midea_devices', 'skoda_vehicle_owners', 'skoda_vehicles', 'skoda_accounts']) db.prepare(`DELETE FROM ${t}`).run();
    db.prepare("DELETE FROM users WHERE username = 'ada'").run();
    const ada = db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('ada', 'x', 'user')").run().lastInsertRowid;
    const route = db.prepare("INSERT INTO routes (domain, target_ip, target_port, enabled) VALUES ('phoscon.example.com', '10.8.0.5', 80, 1)").run().lastInsertRowid;
    db.prepare('INSERT INTO smarthome_gateways (id, name, route_id, api_key_enc) VALUES (4, ?, ?, ?)').run('GW', route, encrypt('deconz-key'));
    db.prepare("INSERT INTO smarthome_resources (id, gateway_id, deconz_id, deconz_type, kind, name) VALUES (9, 4, '1', 'lights', 'light', 'L')").run();
    db.prepare('INSERT INTO smarthome_resource_owners (resource_id, user_id) VALUES (9, ?)').run(ada);
    db.prepare("INSERT INTO midea_devices (id, name, device_sn, token_enc) VALUES (2, 'AC', 'sn', ?)").run(encrypt('tok'));
    db.prepare('INSERT INTO midea_device_owners (midea_device_id, user_id) VALUES (2, ?)').run(ada);
    db.prepare("INSERT INTO skoda_accounts (id, email, password_enc) VALUES (1, 'a@b.c', ?)").run(encrypt('pw'));
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255]);
    db.prepare("INSERT INTO skoda_vehicles (id, account_id, vin, image) VALUES (7, 1, 'TMB1', ?)").run(png);
    db.prepare('INSERT INTO skoda_vehicle_owners (skoda_vehicle_id, user_id) VALUES (7, ?)').run(ada);

    const data = backup.createBackup();
    const b = data.data.builtin_integrations;
    assert.deepEqual(Object.keys(b).sort(), ['midea_device_owners', 'midea_devices', 'skoda_accounts', 'skoda_vehicle_owners', 'skoda_vehicles',
      'smarthome_gateways', 'smarthome_resource_owners', 'smarthome_resources', 'smarthome_rules']);
    assert.equal(b.smarthome_gateways[0].route_domain, 'phoscon.example.com');
    assert.ok(!('route_id' in b.smarthome_gateways[0]));
    assert.deepEqual(b.smarthome_resource_owners.map((o) => [o.resource_id, o.user_name, o.user_id]), [[9, 'ada', undefined]]);
    assert.equal(b.skoda_vehicles[0].image_base64, png.toString('base64'));
    assert.equal(JSON.stringify(b).includes('deconz-key'), false, 'secrets stay encrypted');

    // ids of users and routes change on a restore
    db.prepare("UPDATE users SET id = id + 500 WHERE username = 'ada'").run();
    db.prepare('DELETE FROM smarthome_gateways').run();
    await backup.restoreBackup(data);
    const newAda = db.prepare("SELECT id FROM users WHERE username = 'ada'").get().id;
    const newRoute = db.prepare("SELECT id FROM routes WHERE domain = 'phoscon.example.com'").get().id;
    const gw = db.prepare('SELECT * FROM smarthome_gateways').get();
    assert.deepEqual([gw.id, gw.name, gw.route_id], [4, 'GW', newRoute]);
    assert.equal(require('../src/utils/crypto').decrypt(gw.api_key_enc), 'deconz-key');
    for (const [t, col, id] of [['smarthome_resource_owners', 'resource_id', 9], ['midea_device_owners', 'midea_device_id', 2], ['skoda_vehicle_owners', 'skoda_vehicle_id', 7]]) {
      assert.deepEqual(db.prepare(`SELECT ${col} AS r, user_id AS u FROM ${t}`).all().map((x) => [x.r, x.u]), [[id, newAda]], t);
    }
    assert.ok(Buffer.from(db.prepare('SELECT image FROM skoda_vehicles WHERE id = 7').get().image).equals(png));
    assert.equal(db.prepare('SELECT COUNT(*) c FROM smarthome_resources').get().c, 1);
  });

  it('a backup without the built-in part leaves those tables untouched; unknown tables are refused', async () => {
    const db = getDb();
    const before = db.prepare('SELECT COUNT(*) c FROM smarthome_resources').get().c;
    const data = backup.createBackup();
    delete data.data.builtin_integrations;
    await backup.restoreBackup(data);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM smarthome_resources').get().c, before);
    const bad = backup.createBackup();
    bad.data.builtin_integrations = { users: [] };
    assert.ok(backup.validateBackup(bad).some((e) => /builtin_integrations\.users is unknown/.test(e)));
    bad.data.builtin_integrations = { skoda_vehicles: 'x' };
    assert.ok(backup.validateBackup(bad).some((e) => /must be a list of rows/.test(e)));
  });
});
