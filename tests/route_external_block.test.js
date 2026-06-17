'use strict';
const { test, before } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

// --- Global migrated DB (REQUIRED for buildCaddyConfig/service tests) ---
// buildCaddyConfig() calls getDb() + accessRules.anyRulesExist() unconditionally
// (caddyConfig.js:171/196), so it needs a MIGRATED global connection — a local
// :memory: handle is NOT enough. Mirror tests/caddyConfig_contract.test.js:36-46.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-eblock-'));
process.env.GC_DB_PATH = path.join(tmpDir, 'test.db');
process.env.GC_DATA_DIR = tmpDir;
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || 'a'.repeat(64);
process.env.GC_SECRET = process.env.GC_SECRET || 'b'.repeat(64);

before(() => {
  require('../src/db/migrations').runMigrations(); // migrate the GLOBAL connection
});

const Database = require('better-sqlite3');
const { migrations } = require('../src/db/migrationList');

// Pure-schema helper for the migration column tests (independent :memory: handle).
function applyAll(db) {
  for (const m of migrations) db.exec(m.sql);
}

test('migration 52 adds external_block_* columns with inherit default', () => {
  const db = new Database(':memory:');
  applyAll(db);
  db.prepare("INSERT INTO routes (domain, target_ip, target_port, route_type) VALUES ('r.example.com','127.0.0.1',80,'http')").run();
  const row = db.prepare("SELECT external_block_action, external_block_body, external_block_redirect_url FROM routes WHERE domain='r.example.com'").get();
  assert.strictEqual(row.external_block_action, 'inherit');
  assert.strictEqual(row.external_block_body, null);
  assert.strictEqual(row.external_block_redirect_url, null);
  db.close();
});

test('routes.create/update persist external_block_* at the correct columns', async () => {
  const routes = require('../src/services/routes');
  // create() mit gesetzten Block-Feldern
  // Use port 8080 (not in blockedPorts) so 127.0.0.1 passes the loopback guard.
  const created = await routes.create({
    domain: 'svc.example.com', target_ip: '127.0.0.1', target_port: 8080, route_type: 'http',
    external_block_action: 'custom', external_block_body: '<h1>nope</h1>',
  });
  const id = created.id ?? created;
  const r = routes.getById(id);
  // Bindings korrekt → action/body landen in den richtigen Spalten (nicht verschoben)
  assert.strictEqual(r.external_block_action, 'custom');
  assert.strictEqual(r.external_block_body, '<h1>nope</h1>');
  assert.strictEqual(r.target_ip, '127.0.0.1', 'binding shift would corrupt target_ip');

  // update() ändert die Aktion
  await routes.update(id, { external_block_action: 'redirect', external_block_redirect_url: 'https://example.org/x' });
  const u = routes.getById(id);
  assert.strictEqual(u.external_block_action, 'redirect');
  assert.strictEqual(u.external_block_redirect_url, 'https://example.org/x');
});
