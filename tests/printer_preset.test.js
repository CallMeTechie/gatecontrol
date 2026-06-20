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

describe('printerPreset stage-A validation', () => {
  let preset, db, gwId;
  function gmInsert(pid, telemetry) {
    db.prepare(`INSERT INTO gateway_meta (peer_id, api_port, api_token_hash, push_token_encrypted, created_at, last_health)
      VALUES (?, 9876, 'h', 'e', strftime('%s','now')*1000, ?)`).run(pid, JSON.stringify({ telemetry }));
  }
  before(() => {
    preset = require('../src/services/printerPreset');
    db = require('../src/db/connection').getDb();
    gwId = db.prepare("INSERT INTO peers (name, public_key, allowed_ips, enabled, peer_type) VALUES ('gwA','kA','10.8.0.20/32',1,'gateway')").run().lastInsertRowid;
    gmInsert(gwId, { lan_subnets: [{ cidr: '192.168.2.0/24', primary: true }] });
  });
  function base() { return { near_peer_id: gwId, printer_ip: '192.168.2.45', name: 'EG-Drucker', print_ports: [9100], ews: null, scan: null }; }
  it('rejects an invalid printer IP', () => { assert.throws(() => preset.validateStageA({ ...base(), printer_ip: 'nope' }), /printer_ip/); });
  it('rejects EWS without domain', () => { assert.throws(() => preset.validateStageA({ ...base(), ews: { enabled: true, domain: '' } }), /domain/i); });
  it('rejects zero print ports', () => { assert.throws(() => preset.validateStageA({ ...base(), print_ports: [] }), /print port/i); });
  it('rejects a non-gateway near peer (R1-G1)', () => {
    const pid = db.prepare("INSERT INTO peers (name,public_key,allowed_ips,enabled,peer_type) VALUES ('cli','kc','10.8.0.21/32',1,'client')").run().lastInsertRowid;
    assert.throws(() => preset.validateStageA({ ...base(), near_peer_id: pid }), /enabled gateway/);
  });
  it('rejects scan when the gateway reported no subnets (DA#9 clear message)', () => {
    const pid = db.prepare("INSERT INTO peers (name,public_key,allowed_ips,enabled,peer_type) VALUES ('gwB','kB','10.8.0.22/32',1,'gateway')").run().lastInsertRowid;
    gmInsert(pid, {});
    assert.throws(() => preset.validateStageA({ ...base(), near_peer_id: pid, scan: { enabled: true, vip_ip: '192.168.2.250', target: { mode: 'new', nas_ip: '192.168.2.10', nas_peer_id: pid } } }), /LAN subnets/);
  });
  it('rejects a VIP outside the gateway subnet', () => { assert.throws(() => preset.validateStageA({ ...base(), scan: { enabled: true, vip_ip: '10.0.0.1', target: { mode: 'new', nas_ip: '192.168.2.10', nas_peer_id: gwId } } }), /within the gateway/); });
  it('rejects scan target without a mode (R3-L3)', () => { assert.throws(() => preset.validateStageA({ ...base(), scan: { enabled: true, vip_ip: '192.168.2.250', target: {} } }), /mode/); });
  it('accepts a minimal print-only request', () => { assert.doesNotThrow(() => preset.validateStageA(base())); });
});
