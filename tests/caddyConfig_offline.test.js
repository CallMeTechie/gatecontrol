'use strict';

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-cc-off-'));
process.env.GC_DB_PATH = path.join(tmp, 'test.db');
process.env.GC_DATA_DIR = tmp;

let buildCaddyConfig;

before(() => {
  require('../src/db/migrations').runMigrations();
  buildCaddyConfig = require('../src/services/caddyConfig').buildCaddyConfig;
});

describe('caddyConfig: gateway-offline maintenance page', () => {
  it('route with gateway_offline=true serves static 502 response', () => {
    const routes = [{
      id: 1, domain: 'nas.example.com', route_type: 'http',
      target_kind: 'gateway', target_peer_ip: '10.8.0.5',
      target_lan_host: '192.168.1.10', target_lan_port: 5001,
      target_port: 8080,
      enabled: 1, https_enabled: 1,
      gateway_offline: true, gateway_name: 'homelab-gw',
    }];
    const cfg = buildCaddyConfig(routes);
    const json = JSON.stringify(cfg);
    assert.ok(json.includes('502') || json.includes('static_response'));
    assert.ok(json.includes('homelab-gw'));
  });
});
