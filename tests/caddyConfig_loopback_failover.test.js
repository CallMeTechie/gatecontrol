'use strict';

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-cc-loop-'));
process.env.GC_DB_PATH = path.join(tmp, 'test.db');
process.env.GC_DATA_DIR = tmp;

let buildCaddyConfig;
before(() => {
  require('../src/db/migrations').runMigrations();
  buildCaddyConfig = require('../src/services/caddyConfig').buildCaddyConfig;
});

function gwTarget(config, domain) {
  const srv = config.apps.http.servers;
  for (const name of Object.keys(srv)) {
    for (const r of srv[name].routes) {
      const match = (r.match || []).some(m => (m.host || []).includes(domain));
      if (!match) continue;
      const rp = (r.handle || []).find(h => h.handler === 'reverse_proxy');
      if (rp && rp.headers && rp.headers.request && rp.headers.request.set) {
        const v = rp.headers.request.set['X-Gateway-Target'];
        if (v) return v[0];
      }
    }
  }
  return null;
}
function statusFor(config, domain) {
  const srv = config.apps.http.servers;
  for (const name of Object.keys(srv)) {
    for (const r of srv[name].routes) {
      const match = (r.match || []).some(m => (m.host || []).includes(domain));
      if (!match) continue;
      const sr = (r.handle || []).find(h => h.handler === 'static_response');
      if (sr) return sr.status_code;
    }
  }
  return null;
}

const base = {
  route_type: 'http', target_kind: 'gateway', target_lan_port: 8096,
  target_port: 8080, enabled: 1, https_enabled: 1,
};

describe('caddyConfig: loopback failover resolution', () => {
  it('home serving (original_peer_id NULL) keeps 127.0.0.1', () => {
    const routes = [{ ...base, id: 1, domain: 'jelly.example.com',
      target_peer_allowed_ips: '10.8.0.2/32', target_lan_host: '127.0.0.1', original_peer_id: null }];
    const cfg = buildCaddyConfig(routes, { gatewayProxyPort: 8080 });
    assert.equal(gwTarget(cfg, 'jelly.example.com'), '127.0.0.1:8096');
  });
  it('failed over + home_lan_ip known → home LAN IP', () => {
    const routes = [{ ...base, id: 2, domain: 'jelly2.example.com',
      target_peer_allowed_ips: '10.8.0.3/32', target_lan_host: '127.0.0.1',
      original_peer_id: 7, home_lan_ip: '192.168.2.228' }];
    const cfg = buildCaddyConfig(routes, { gatewayProxyPort: 8080 });
    assert.equal(gwTarget(cfg, 'jelly2.example.com'), '192.168.2.228:8096');
  });
  it('failed over + home_lan_ip unknown → 502 maintenance page', () => {
    const routes = [{ ...base, id: 3, domain: 'jelly3.example.com',
      target_peer_allowed_ips: '10.8.0.3/32', target_lan_host: '127.0.0.1',
      original_peer_id: 7, home_lan_ip: null }];
    const cfg = buildCaddyConfig(routes, { gatewayProxyPort: 8080 });
    assert.equal(statusFor(cfg, 'jelly3.example.com'), 502);
  });
  it('127.0.0.x/8 is treated as loopback', () => {
    const routes = [{ ...base, id: 4, domain: 'jelly4.example.com',
      target_peer_allowed_ips: '10.8.0.3/32', target_lan_host: '127.0.1.1',
      original_peer_id: 7, home_lan_ip: '192.168.2.50' }];
    const cfg = buildCaddyConfig(routes, { gatewayProxyPort: 8080 });
    assert.equal(gwTarget(cfg, 'jelly4.example.com'), '192.168.2.50:8096');
  });
  it('non-loopback target is never rewritten, even when failed over', () => {
    const routes = [{ ...base, id: 5, domain: 'real.example.com',
      target_peer_allowed_ips: '10.8.0.3/32', target_lan_host: '192.168.1.10',
      original_peer_id: 7, home_lan_ip: '192.168.2.228' }];
    const cfg = buildCaddyConfig(routes, { gatewayProxyPort: 8080 });
    assert.equal(gwTarget(cfg, 'real.example.com'), '192.168.1.10:8096');
  });
});
