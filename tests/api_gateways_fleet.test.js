'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path'); const fs = require('node:fs'); const os = require('node:os');
const http = require('node:http'); const crypto = require('node:crypto');
process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
process.env.NODE_ENV = 'test';

describe('gateways fleet service', () => {
  let gateways, db, mock, mockPort, peerId;
  before(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-fleet-'));
    process.env.GC_DB_PATH = path.join(tmp, 'test.db'); process.env.GC_DATA_DIR = tmp;
    ['../config/default','../src/db/connection','../src/db/migrations','../src/services/gateways','../src/services/license','../src/services/gatewayRelease']
      .forEach(p => { try { delete require.cache[require.resolve(p)]; } catch (_) {} });
    require('../src/db/migrations').runMigrations();
    require('../src/services/license')._overrideForTest?.({ gateway_peers: 10, gateway_fleet: true });
    gateways = require('../src/services/gateways');
    db = require('../src/db/connection').getDb();
    mock = http.createServer((req, res) => {
      if (req.url === '/api/status') { res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ overall_healthy: false, route_reachability: [{ route_id: 1, reachable: false }] })); }
      else { res.writeHead(404); res.end(); }
    });
    await new Promise(r => mock.listen(0, '127.0.0.1', r));
    mockPort = mock.address().port;
    const gw = await gateways.createGateway({ name: 'fleet-gw', apiPort: mockPort });
    peerId = gw.peer.id;
    db.prepare('UPDATE peers SET allowed_ips = ? WHERE id = ?').run('127.0.0.1/32', peerId);
    db.prepare('UPDATE gateway_meta SET last_health = ? WHERE peer_id = ?')
      .run(JSON.stringify({ overall_healthy: true, telemetry: { gateway_version: '1.8.0' }, hostname: 'gw1' }), peerId);
  });
  after(() => { mock && mock.close(); });

  it('_mergeHealth applies fresh self-check but keeps telemetry/hostname', () => {
    const merged = gateways._mergeHealth(
      { overall_healthy: true, telemetry: { gateway_version: '1.8.0' }, hostname: 'gw1' },
      { overall_healthy: false, route_reachability: [{ route_id: 1, reachable: false }] });
    assert.equal(merged.overall_healthy, false);
    assert.deepEqual(merged.telemetry, { gateway_version: '1.8.0' });
    assert.equal(merged.hostname, 'gw1');
    assert.equal(merged.route_reachability.length, 1);
  });
  it('returns null for a non-gateway peer id', async () => { assert.equal(await gateways.refreshHealth(999999), null); });
  it('on success merges fresh health, keeps telemetry, feeds the state machine', async () => {
    const r = await gateways.refreshHealth(peerId);
    assert.equal(r.reachable, true);
    const lh = JSON.parse(db.prepare('SELECT last_health FROM gateway_meta WHERE peer_id = ?').get(peerId).last_health);
    assert.equal(lh.overall_healthy, false);
    assert.equal(lh.telemetry.gateway_version, '1.8.0');
    assert.notEqual(gateways.getHealthStatus(peerId), 'offline');
  });
  it('on connect failure reports unreachable; repeated failures converge the SM to offline', async () => {
    db.prepare('UPDATE gateway_meta SET api_port = 1 WHERE peer_id = ?').run(peerId); // port 1 → ECONNREFUSED
    const r = await gateways.refreshHealth(peerId);
    assert.equal(r.reachable, false);                              // immediate honest result
    for (let i = 0; i < 4; i++) await gateways.refreshHealth(peerId); // each feeds ONE failure (no pump)
    assert.equal(gateways.getHealthStatus(peerId), 'offline');     // SM converges via hysteresis
  });
});
