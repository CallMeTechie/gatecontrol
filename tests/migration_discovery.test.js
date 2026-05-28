'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

test('migration 47 adds gateway_meta discovery columns', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-mig-'));
  process.env.GC_DB_PATH = path.join(tmp, 'test.db');
  process.env.GC_DATA_DIR = tmp;
  ['../config/default', '../src/db/connection', '../src/db/migrations']
    .forEach(p => { try { delete require.cache[require.resolve(p)]; } catch (_) {} });
  require('../src/db/migrations').runMigrations();
  const db = require('../src/db/connection').getDb();
  const cols = db.prepare(`PRAGMA table_info(gateway_meta)`).all().map(c => c.name);
  for (const c of ['discovery_enabled', 'discovery_active_scan', 'discovery_subnets', 'discovery_category_mode', 'discovery_categories']) {
    assert.ok(cols.includes(c), `gateway_meta missing column ${c}`);
  }
  // defaults
  const def = db.prepare(`SELECT dflt_value FROM pragma_table_info('gateway_meta') WHERE name='discovery_category_mode'`).get();
  assert.match(String(def.dflt_value), /include/);
});
