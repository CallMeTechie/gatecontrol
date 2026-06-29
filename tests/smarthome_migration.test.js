'use strict';
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown } = require('./helpers/setup');
const { getDb } = require('../src/db/connection');

beforeEach(async () => { await setup(); });
afterEach(async () => { await teardown(); });

function cols(table) {
  return getDb().prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name);
}

test('smarthome tables exist with expected columns', () => {
  for (const t of ['smarthome_gateways', 'smarthome_resources', 'smarthome_resource_owners', 'smarthome_rules']) {
    assert.ok(getDb().prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t), `${t} missing`);
  }
  assert.ok(cols('smarthome_gateways').includes('api_key_enc'));
  assert.ok(cols('smarthome_gateways').includes('route_id'));
  assert.ok(cols('smarthome_resources').includes('capabilities_json'));
  assert.ok(cols('smarthome_resources').includes('uniqueid'));
  assert.ok(cols('smarthome_rules').includes('deconz_clip_sensor_id'));
});

test('smarthome_resources has unique index on (gateway_id, deconz_type, deconz_id)', () => {
  const idx = getDb().prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='smarthome_resources'").all().map((r) => r.name);
  assert.ok(idx.includes('idx_smarthome_resources_uniq'));
});
