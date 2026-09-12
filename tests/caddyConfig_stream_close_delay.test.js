'use strict';

// Every sync is a full POST /load; without stream_close_delay Caddy closes
// all upgraded connections of the replaced config at once, so editing any
// route dropped every open web-terminal / RDP WebSocket.

const { describe, it, before, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
process.env.GC_BASE_URL = 'https://gc.example.com';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-cc-scd-'));
process.env.GC_DB_PATH = path.join(tmp, 'test.db');
process.env.GC_DATA_DIR = tmp;

const config = require('../config/default');
let buildCaddyConfig;

before(() => {
  require('../src/db/migrations').runMigrations();
  buildCaddyConfig = require('../src/services/caddyConfig').buildCaddyConfig;
});

afterEach(() => { config.caddy.streamCloseDelay = '1h'; });

function reverseProxies(node, out = []) {
  if (Array.isArray(node)) node.forEach(n => reverseProxies(n, out));
  else if (node && typeof node === 'object') {
    if (node.handler === 'reverse_proxy') out.push(node);
    Object.values(node).forEach(v => reverseProxies(v, out));
  }
  return out;
}

function hostRoute(cfg, host) {
  for (const srv of Object.values(cfg.apps.http.servers)) {
    const r = srv.routes.find(x => x.match?.some(m => m.host?.includes(host)));
    if (r) return r;
  }
  return null;
}

const ROUTE = {
  id: 1, domain: 'term.example.com', route_type: 'http',
  target_kind: 'peer', target_ip: '10.8.0.7', target_port: 80,
  enabled: 1, https_enabled: 1,
};

describe('caddyConfig: stream_close_delay', () => {
  it('defaults to 1h on user routes', () => {
    const [rp] = reverseProxies(hostRoute(buildCaddyConfig([ROUTE]), 'term.example.com'));
    assert.equal(rp.stream_close_delay, '1h');
  });

  it('is set on the management UI vhost (guacamole WS tunnel)', () => {
    const [rp] = reverseProxies(hostRoute(buildCaddyConfig([ROUTE]), 'gc.example.com'));
    assert.equal(rp.stream_close_delay, '1h');
  });

  it('follows GC_CADDY_STREAM_CLOSE_DELAY', () => {
    config.caddy.streamCloseDelay = '15m';
    const [rp] = reverseProxies(hostRoute(buildCaddyConfig([ROUTE]), 'term.example.com'));
    assert.equal(rp.stream_close_delay, '15m');
  });

  it('"0" omits the field everywhere (Caddy default: close immediately)', () => {
    config.caddy.streamCloseDelay = '0';
    const all = reverseProxies(buildCaddyConfig([ROUTE]));
    assert.ok(all.length > 0);
    assert.ok(all.every(rp => !('stream_close_delay' in rp)));
  });
});
