'use strict';

// Wake-on-LAN for targets behind a gateway POOL (services/gatewayWake.js): the magic packet goes out through a
// live member of the pool (the active one first, the next one when it fails) — the RDP wake, the auto-wake of the
// monitor and gc.remote.wake alike. The server's own broadcast only when neither a peer nor a pool is set.

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown } = require('./helpers/setup');

const GW_A = 71; // pool member, priority 10 (the active one)
const GW_B = 72; // pool member, priority 20 (the reserve)
const GW_C = 73; // pool member, priority 30, offline
const MAC = 'AA:BB:CC:DD:EE:01';

let agent, csrf, db, gw, gateways, wol, health, monitor;
let poolId, calls, broadcasts, answers, snap;
const orig = {};

function gateway(id, name, alive) {
  db.prepare("INSERT INTO peers (id, name, public_key, peer_type, allowed_ips, enabled) VALUES (?, ?, ?, 'gateway', ?, 1)")
    .run(id, name, 'pk-wake-' + id, `10.8.0.${id}/32`);
  db.prepare(`INSERT INTO gateway_meta (peer_id, api_port, api_token_hash, push_token_encrypted, alive, last_seen_at, created_at)
    VALUES (?, 9876, 'h', 'e', ?, ?, ?)`).run(id, alive ? 1 : 0, Date.now(), Date.now());
}

before(async () => {
  const ctx = await setup();
  agent = ctx.agent;
  csrf = ctx.csrfToken;
  db = require('../src/db/connection').getDb();
  gw = require('../src/services/gatewayWake');
  gateways = require('../src/services/gateways');
  wol = require('../src/services/wol');
  health = require('../src/services/gatewayHealth');
  monitor = require('../src/services/monitor');
  gateway(GW_A, 'wake-a', true);
  gateway(GW_B, 'wake-b', true);
  gateway(GW_C, 'wake-c', false);
  poolId = Number(db.prepare("INSERT INTO gateway_pools (name, failback_cooldown_s) VALUES ('wake-pool', 60)").run().lastInsertRowid);
  const add = db.prepare('INSERT INTO gateway_pool_members (pool_id, peer_id, priority) VALUES (?, ?, ?)');
  add.run(poolId, GW_C, 5); // highest priority, but offline: never asked
  add.run(poolId, GW_A, 10);
  add.run(poolId, GW_B, 20);
});

after(() => teardown());

beforeEach(() => {
  calls = []; broadcasts = []; answers = {};
  snap = { [GW_A]: { alive: true }, [GW_B]: { alive: true }, [GW_C]: { alive: false } };
  orig.notifyWol = gateways.notifyWol;
  orig.send = wol.sendMagicPacket;
  orig.snap = health.getSnapshot;
  gateways.notifyWol = async (peerId, opts) => {
    calls.push([peerId, opts]);
    const a = answers[peerId];
    if (a instanceof Error) throw a;
    return a === undefined ? { success: true, elapsed_ms: 10 } : a;
  };
  wol.sendMagicPacket = async (mac) => { broadcasts.push(mac); };
  health.getSnapshot = () => snap;
});

afterEach(() => {
  gateways.notifyWol = orig.notifyWol;
  wol.sendMagicPacket = orig.send;
  health.getSnapshot = orig.snap;
});

describe('gatewayWake.wakeTarget', () => {
  it('a pinned peer: only that gateway, never the server', async () => {
    const r = await gw.wakeTarget({ peerId: GW_B, mac: MAC, lanHost: '192.168.1.20', lanPort: 3389 });
    assert.equal(r.via, 'gateway');
    assert.equal(r.peerId, GW_B);
    assert.deepEqual(calls.map((c) => c[0]), [GW_B]);
    assert.deepEqual(calls[0][1], { mac: MAC, lan_host: '192.168.1.20', lan_host_port: 3389 });
    assert.equal(broadcasts.length, 0);
  });

  it('a pool: the active member (live, by priority), offline members skipped', async () => {
    const r = await gw.wakeTarget({ poolId, mac: MAC, lanHost: '192.168.1.20' });
    assert.deepEqual([r.via, r.peerId], ['gateway', GW_A]);
    assert.deepEqual(calls.map((c) => c[0]), [GW_A]);
    assert.equal(broadcasts.length, 0);
  });

  it('a pool: a member that fails (no answer, refusal, exception) → the next one', async () => {
    answers[GW_A] = null; // transport error (notifyWol gives null)
    let r = await gw.wakeTarget({ poolId, mac: MAC, lanHost: '192.168.1.20' });
    assert.equal(r.peerId, GW_B);
    assert.deepEqual(calls.map((c) => c[0]), [GW_A, GW_B]);

    calls.length = 0;
    answers[GW_A] = { error: 'mac_not_whitelisted' };
    r = await gw.wakeTarget({ poolId, mac: MAC, lanHost: '192.168.1.20' });
    assert.equal(r.peerId, GW_B);

    calls.length = 0;
    answers[GW_A] = new Error('boom');
    r = await gw.wakeTarget({ poolId, mac: MAC, lanHost: '192.168.1.20' });
    assert.equal(r.peerId, GW_B);
    assert.equal(broadcasts.length, 0);
  });

  it('a pool: sent but the host not up in time is a success (no second packet from another member)', async () => {
    answers[GW_A] = { success: false, reason: 'timeout', sent_on: [] };
    const r = await gw.wakeTarget({ poolId, mac: MAC, lanHost: '192.168.1.20' });
    assert.equal(r.peerId, GW_A);
    assert.equal(calls.length, 1);
  });

  it('after a failover the reserve comes first', async () => {
    snap = { [GW_A]: { alive: false }, [GW_B]: { alive: true }, [GW_C]: { alive: false } };
    const r = await gw.wakeTarget({ poolId, mac: MAC, lanHost: '192.168.1.20' });
    assert.equal(r.peerId, GW_B);
    assert.deepEqual(calls.map((c) => c[0]), [GW_B]);
  });

  it('every member fails → wake_failed, no broadcast of the server', async () => {
    answers[GW_A] = null; answers[GW_B] = { error: 'mac_not_whitelisted' };
    await assert.rejects(gw.wakeTarget({ poolId, mac: MAC, lanHost: '192.168.1.20' }), (e) => e instanceof gw.WakeError && e.code === 'wake_failed');
    assert.deepEqual(calls.map((c) => c[0]), [GW_A, GW_B]);
    assert.equal(broadcasts.length, 0);
  });

  it('a pool without a live member → gateway_offline, no broadcast of the server', async () => {
    snap = { [GW_A]: { alive: false }, [GW_B]: { alive: false }, [GW_C]: { alive: false } };
    await assert.rejects(gw.wakeTarget({ poolId, mac: MAC, lanHost: '192.168.1.20' }), (e) => e.code === 'gateway_offline');
    assert.equal(calls.length, 0);
    assert.equal(broadcasts.length, 0);
  });

  it('neither peer nor pool → the server sends the magic packet itself', async () => {
    const r = await gw.wakeTarget({ mac: MAC });
    assert.equal(r.via, 'server');
    assert.deepEqual(broadcasts, [MAC]);
    assert.equal(calls.length, 0);
  });
});

describe('the callers wake through the pool', () => {
  it('monitor: a pool route that goes down wakes through the active member', async () => {
    const id = Number(db.prepare(`INSERT INTO routes (domain, target_ip, target_port, route_type, target_kind, target_pool_id, target_lan_host, target_lan_port, wol_enabled, wol_mac)
      VALUES ('wake-pool.example.com', '127.0.0.1', 8080, 'http', 'gateway', ?, '192.168.1.30', 5001, 1, ?)`).run(poolId, MAC).lastInsertRowid);
    answers[GW_A] = null;
    monitor.handleRouteDownDetected(id);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(calls.map((c) => c[0]), [GW_A, GW_B]);
    assert.equal(calls[0][1].lan_host, '192.168.1.30');
    assert.equal(calls[0][1].lan_host_port, 5001);
    assert.equal(broadcasts.length, 0);
  });

  function rdpRoute(name, fields) {
    const row = { name, host: '192.168.1.40', port: 3389, access_mode: 'gateway', wol_enabled: 1, wol_mac_address: MAC, ...fields };
    const cols = Object.keys(row);
    const vals = Object.values(row);
    return Number(db.prepare(`INSERT INTO rdp_routes (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...vals).lastInsertRowid);
  }

  it('RDP: a route through a pool wakes through a member of the pool, not the server', async () => {
    const id = rdpRoute('wake-rdp-pool', { gateway_pool_id: poolId });
    answers[GW_A] = null;
    const res = await agent.post(`/api/v1/rdp/${id}/wol`).set('X-CSRF-Token', csrf).expect(200);
    assert.equal(res.body.ok, true);
    assert.match(res.body.message, /via gateway/);
    assert.deepEqual(calls.map((c) => c[0]), [GW_A, GW_B]);
    assert.deepEqual(calls[1][1], { mac: MAC, lan_host: '192.168.1.40', lan_host_port: 3389 });
    assert.equal(broadcasts.length, 0);
  });

  it('RDP: a pool without a live member → 503, no broadcast of the server', async () => {
    const id = rdpRoute('wake-rdp-pool-off', { gateway_pool_id: poolId });
    snap = { [GW_A]: { alive: false }, [GW_B]: { alive: false }, [GW_C]: { alive: false } };
    const res = await agent.post(`/api/v1/rdp/${id}/wol`).set('X-CSRF-Token', csrf).expect(503);
    assert.equal(res.body.ok, false);
    assert.equal(calls.length, 0);
    assert.equal(broadcasts.length, 0);
  });

  it('RDP: a pinned gateway peer still goes through that gateway', async () => {
    const id = rdpRoute('wake-rdp-peer', { gateway_peer_id: GW_B });
    await agent.post(`/api/v1/rdp/${id}/wol`).set('X-CSRF-Token', csrf).expect(200);
    assert.deepEqual(calls.map((c) => c[0]), [GW_B]);
    assert.equal(broadcasts.length, 0);
  });

  it('RDP: an internal route (no gateway) → the server broadcast', async () => {
    const id = rdpRoute('wake-rdp-internal', { access_mode: 'internal' });
    const res = await agent.post(`/api/v1/rdp/${id}/wol`).set('X-CSRF-Token', csrf).expect(200);
    assert.equal(res.body.message, 'Magic packet sent');
    assert.deepEqual(broadcasts, [MAC]);
    assert.equal(calls.length, 0);
  });
});
