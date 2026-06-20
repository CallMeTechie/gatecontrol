// tests/printer_preset.test.js
'use strict';
const { describe, it, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path'); const fs = require('node:fs'); const os = require('node:os'); const crypto = require('node:crypto');
process.env.NODE_ENV = 'test'; // MUST be first — no-ops the real Caddy sync (Global Constraints)
process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

describe('printerPreset port allocation', () => {
  let preset, db;
  before(() => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-pp-'));
    process.env.GC_DB_PATH = path.join(tmp, 'test.db'); process.env.GC_DATA_DIR = tmp;
    require('../src/db/migrations').runMigrations();
    require('../src/services/license')._overrideForTest({ l4_routes: 100, http_routes: 100, gateway_tcp_routing: true, gateway_scan_egress: true });
    preset = require('../src/services/printerPreset');
    db = require('../src/db/connection').getDb();
  });
  it('allocatePrintListenPort returns the target port when free', () => {
    assert.equal(preset.allocatePrintListenPort(9100, {}), 9100);
  });
  it('allocatePrintListenPort returns the next free port when target is taken (R3-M2)', async () => {
    const pid = db.prepare("INSERT INTO peers (name,public_key,allowed_ips,enabled,peer_type) VALUES ('gwp','kp','10.8.0.30/32',1,'gateway')").run().lastInsertRowid;
    await require('../src/services/routes').create({ route_type: 'l4', l4_protocol: 'tcp', l4_listen_port: '9100', l4_tls_mode: 'none', external_enabled: 0, target_kind: 'gateway', target_peer_id: pid, target_lan_host: '192.168.2.99', target_lan_port: 9100, target_port: 9100 }, { skipSync: true });
    const p = preset.allocatePrintListenPort(9100, {});
    assert.notEqual(p, 9100); assert.ok(p > 9100);
  });
  it('allocateEgressHighPort returns 14450 when none exist', () => {
    assert.equal(preset.allocateEgressHighPort(1), 14450);
  });
  it('allocateEgressHighPort skips an occupied port at the same peer', () => {
    db.prepare("INSERT INTO egress_routes (name,near_peer_id,vip_ip,vip_prefix,lan_listen_port,target_route_id,allowed_source_ips,enabled) VALUES ('x',7,'192.168.2.250',24,14450,1,'[]',1)").run();
    assert.equal(preset.allocateEgressHighPort(7), 14451);
  });
});
