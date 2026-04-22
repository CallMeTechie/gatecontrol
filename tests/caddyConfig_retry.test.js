'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');

process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

// Covers the retry-wiring bug: the admin-configured retry_match_status
// must actually land inside reverse_proxy.load_balancing.retry_match, and
// try_duration has to be present, otherwise Caddy silently ignores retries.

describe('caddyConfig: retry-match wiring', () => {
  let buildCaddyConfig, db;

  function freshEnv() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-caddy-retry-'));
    process.env.GC_DB_PATH = path.join(tmp, 'test.db');
    process.env.GC_DATA_DIR = tmp;
    [
      '../config/default',
      '../src/db/connection',
      '../src/db/migrations',
      '../src/services/caddyConfig',
    ].forEach((p) => { try { delete require.cache[require.resolve(p)]; } catch (_) {} });
    require('../src/db/migrations').runMigrations();
    db = require('../src/db/connection').getDb();
    ({ buildCaddyConfig } = require('../src/services/caddyConfig'));
  }

  function insertHttpRoute({ retry_enabled, retry_count, retry_match_status }) {
    const info = db.prepare(`
      INSERT INTO peers (name, public_key, private_key_encrypted, preshared_key_encrypted, allowed_ips, enabled)
      VALUES ('peer', 'pk', 'enc', 'enc', '10.8.0.10/32', 1)
    `).run();
    const peerId = info.lastInsertRowid;
    db.prepare(`
      INSERT INTO routes (domain, peer_id, target_ip, target_port, https_enabled, enabled, route_type, target_kind,
        retry_enabled, retry_count, retry_match_status)
      VALUES ('app.example.com', ?, '10.8.0.10', '5000', 1, 1, 'http', 'peer', ?, ?, ?)
    `).run(peerId, retry_enabled ? 1 : 0, retry_count, retry_match_status);
  }

  function routeHandlers(cfg) {
    const routes = cfg.apps.http.servers.srv0.routes;
    const entry = routes.find(r => r.match && r.match[0] && r.match[0].host && r.match[0].host.includes('app.example.com'));
    assert.ok(entry, 'route for app.example.com missing from srv0');
    // compound routes nest handlers via subroute; single-handler routes expose them directly
    if (entry.handle[0] && entry.handle[0].handler === 'subroute') {
      return entry.handle[0].routes[0].handle;
    }
    return entry.handle;
  }

  it('sets retries + try_duration + retry_match when retry_enabled', () => {
    freshEnv();
    insertHttpRoute({ retry_enabled: true, retry_count: 4, retry_match_status: '502,503,504' });
    const cfg = buildCaddyConfig();
    const handlers = routeHandlers(cfg);
    const rp = handlers.find(h => h.handler === 'reverse_proxy');
    assert.ok(rp, 'reverse_proxy handler missing');
    assert.ok(rp.load_balancing, 'load_balancing missing');
    assert.equal(rp.load_balancing.retries, 4);
    assert.ok(rp.load_balancing.try_duration, 'try_duration must be set or retries do nothing');
    assert.deepEqual(rp.load_balancing.retry_match, [{ status_code: [502, 503, 504] }]);
  });

  it('drops invalid / out-of-range codes silently', () => {
    freshEnv();
    insertHttpRoute({ retry_enabled: true, retry_count: 3, retry_match_status: '502, abc, 99, 700, 503' });
    const cfg = buildCaddyConfig();
    const rp = routeHandlers(cfg).find(h => h.handler === 'reverse_proxy');
    assert.deepEqual(rp.load_balancing.retry_match, [{ status_code: [502, 503] }]);
  });

  it('omits retry_match entirely when codes are empty', () => {
    freshEnv();
    insertHttpRoute({ retry_enabled: true, retry_count: 3, retry_match_status: '' });
    const cfg = buildCaddyConfig();
    const rp = routeHandlers(cfg).find(h => h.handler === 'reverse_proxy');
    assert.equal(rp.load_balancing.retries, 3);
    assert.ok(rp.load_balancing.try_duration);
    assert.equal(rp.load_balancing.retry_match, undefined);
  });

  it('adds nothing retry-related when retry_enabled = 0', () => {
    freshEnv();
    insertHttpRoute({ retry_enabled: false, retry_count: 3, retry_match_status: '502,503,504' });
    const cfg = buildCaddyConfig();
    const rp = routeHandlers(cfg).find(h => h.handler === 'reverse_proxy');
    assert.ok(!rp.load_balancing || rp.load_balancing.retries === undefined);
    assert.ok(!rp.load_balancing || rp.load_balancing.retry_match === undefined);
  });
});
