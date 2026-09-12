'use strict';

// services/hostTemplates.js — the printer template must produce exactly the
// exposures printerPreset.buildBundleInput produces today (EWS on, 9100+631).

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

process.env.NODE_ENV = 'test';
process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

describe('domain zones: host templates', () => {
  let templates, hosts, preset, routes, db, gwId;

  before(() => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-zones-tpl-'));
    process.env.GC_DB_PATH = path.join(tmp, 'test.db');
    process.env.GC_DATA_DIR = tmp;
    require('../src/db/migrations').runMigrations();
    require('../src/services/caddyConfig').syncToCaddy = async () => true;
    require('../src/services/license')._overrideForTest({ http_routes: 100, l4_routes: 100, gateway_tcp_routing: true });
    templates = require('../src/services/hostTemplates');
    hosts = require('../src/services/hosts');
    preset = require('../src/services/printerPreset');
    routes = require('../src/services/routes');
    db = require('../src/db/connection').getDb();
    gwId = db.prepare("INSERT INTO peers (name, public_key, allowed_ips, enabled, peer_type) VALUES ('gw', 'k', '10.8.0.9/32', 1, 'gateway')").run().lastInsertRowid;
  });

  function presetExposures() {
    const input = { name: 'Printer', near_peer_id: gwId, printer_ip: '192.168.1.45', print_ports: [9100, 631], ews: { enabled: true, domain: 'drucker.example.com' } };
    const listenPorts = new Map(input.print_ports.map((tp) => [tp, preset.allocatePrintListenPort(tp, { excludeRouteIds: [] })]));
    const b = preset.buildBundleInput(input, listenPorts);
    return { http: b.http, l4: b.l4 };
  }

  it('printer template = printerPreset.buildBundleInput exposures', () => {
    assert.deepEqual(hosts.toBundleExposures(templates.expand('printer')), presetExposures());
  });

  it('printer template follows allocatePrintListenPort when 9100 is taken', async () => {
    await routes.create({ route_type: 'l4', l4_protocol: 'tcp', l4_listen_port: '9100', l4_tls_mode: 'none', external_enabled: 0,
      target_kind: 'gateway', target_peer_id: gwId, target_lan_host: '192.168.1.99', target_lan_port: 9100, target_port: 9100 }, { skipSync: true });
    const exp = hosts.toBundleExposures(templates.expand('printer'));
    assert.deepEqual(exp, presetExposures());
    assert.notEqual(exp.l4.find((e) => e.target_port === 9100).l4_listen_port, '9100');
  });

  it('nas, proxmox and ssh templates', () => {
    const nas = templates.expand('nas');
    assert.deepEqual(nas[0], { type: 'http', target_port: 5001, backend_https: true });
    assert.equal(nas[1].type, 'tcp');
    assert.equal(nas[1].target_port, 22);
    assert.equal(nas[1].listen_port, '2022', 'SSH listens on the first free port from 2022 (22 is reserved)');
    assert.deepEqual(templates.expand('proxmox'), [{ type: 'http', target_port: 8006, backend_https: true }]);
    const ssh = templates.expand('ssh');
    assert.equal(ssh.length, 1);
    assert.equal(ssh[0].target_port, 22);
  });

  it('suggests the next free SSH listen port', async () => {
    await routes.create({ route_type: 'l4', l4_protocol: 'tcp', l4_listen_port: '2022', l4_tls_mode: 'none', external_enabled: 0,
      target_kind: 'gateway', target_peer_id: gwId, target_lan_host: '192.168.1.98', target_lan_port: 22, target_port: 22 }, { skipSync: true });
    assert.equal(templates.expand('ssh')[0].listen_port, '2023');
  });

  it('lists all templates and rejects unknown ones', () => {
    const list = templates.list();
    assert.deepEqual(list.map((t) => t.id), ['printer', 'nas', 'proxmox', 'ssh']);
    for (const t of list) assert.ok(Array.isArray(t.entries) && t.entries.length > 0);
    assert.throws(() => templates.expand('toaster'), (err) => err.statusCode === 400);
  });
});
