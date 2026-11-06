'use strict';

// Live state of a gateway (src/services/gatewayLiveState.js): reachable is not
// the routing flag — a gateway in its pool's failback cooldown is online with a
// failback hint; an update GateControl asked for shows "updating" and holds the
// offline alarm back (released late when the gateway does not come back in
// time); the "going down" notice of the gateway shows "restarting" at once;
// the API answers keep their old fields and get the new ones.

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown, getAgent } = require('./helpers/setup');

const MIN = 60_000;

describe('gatewayLiveState.derive (pure)', () => {
  const LS = require('../src/services/gatewayLiveState');
  const NOW = 10_000_000_000;
  const thr = 90_000;
  const d = (row, ctx) => LS.derive(row, { now: NOW, thresholdMs: thr, ...ctx });

  it('never heard of → unknown, not reachable', () => {
    const s = d({ alive: 1 });
    assert.equal(s.state, 'unknown');
    assert.equal(s.reachable, false);
  });

  it('heartbeat within the threshold → online, reachable', () => {
    const s = d({ alive: 1, last_seen_at: NOW - 20_000 });
    assert.equal(s.state, 'online');
    assert.equal(s.reachable, true);
    assert.equal(s.failback_at, null);
  });

  it('back after an outage, routes still in the failback cooldown → online + failback_at (not offline)', () => {
    const rec = NOW - 2 * MIN;
    const s = d({ alive: 0, went_down_at: NOW - 10 * MIN, recovered_first_hb_at: rec, last_seen_at: NOW - 5000 }, { cooldownS: 900, takesRoutes: true });
    assert.equal(s.state, 'online');
    assert.equal(s.reachable, true);
    assert.equal(s.alive, false, 'the routing flag is still down');
    assert.equal(s.failback_at, rec + 900_000);
    assert.equal(s.failback_takes_routes, true);
    // the cooldown is over (the next evaluation flips alive): no hint any more
    assert.equal(d({ alive: 0, went_down_at: 1, recovered_first_hb_at: NOW - 20 * MIN, last_seen_at: NOW - 5000 }, { cooldownS: 900 }).failback_at, null);
    // a gateway in no pool has no cooldown: plain online
    assert.equal(d({ alive: 0, went_down_at: 1, recovered_first_hb_at: NOW - 1000, last_seen_at: NOW - 1000 }, { cooldownS: 0 }).failback_at, null);
  });

  it('no heartbeat within the threshold → offline since the last sign of life', () => {
    const s = d({ alive: 1, last_seen_at: NOW - 91_000 });
    assert.equal(s.state, 'offline');
    assert.equal(s.reachable, false);
    assert.equal(s.offline_since, NOW - 91_000);
  });

  it('an update GateControl asked for → updating until it is back or the time is up', () => {
    const row = { alive: 0, last_seen_at: NOW - 3 * MIN, update_request_id: 'r1', update_requested_at: NOW - 5 * MIN };
    const s = d(row, { updateState: 'updating', updateTimeoutMs: 15 * MIN });
    assert.equal(s.state, 'updating');
    assert.equal(s.restart_reason, 'update');
    assert.equal(s.reachable, false);
    // window: the tracking timeout, or 10 min after the last heartbeat (slow pull) — whichever is later
    assert.equal(s.expected_back_by, Math.max(NOW + 10 * MIN, NOW - 3 * MIN + LS.RESTART_GRACE_MS));
    // the tracking timed out, but it went silent late in the window: still its grace
    const late = d({ ...row, last_seen_at: NOW - 2 * MIN, update_requested_at: NOW - 16 * MIN }, { updateState: 'unknown', updateTimeoutMs: 15 * MIN });
    assert.equal(late.state, 'updating');
    // the time is up → plain offline
    const over = d({ ...row, last_seen_at: NOW - 12 * MIN, update_requested_at: NOW - 30 * MIN }, { updateState: 'unknown', updateTimeoutMs: 15 * MIN });
    assert.equal(over.state, 'offline');
    // an old request that never got cleared does not make a later outage an update
    const stale = d({ ...row, last_seen_at: NOW - 3 * MIN, update_requested_at: NOW - 3 * 24 * 60 * MIN }, { updateState: 'unknown', updateTimeoutMs: 15 * MIN });
    assert.equal(stale.state, 'offline');
    // done / failed: it reported back
    assert.equal(d(row, { updateState: 'done', updateTimeoutMs: 15 * MIN }).state, 'offline');
    // still heartbeating while it pulls → online
    assert.equal(d({ ...row, last_seen_at: NOW - 5000 }, { updateState: 'updating' }).state, 'online');
  });

  it('"going down" notice → restarting at once, the next heartbeat ends it, the grace ends it', () => {
    const s = d({ alive: 1, last_seen_at: NOW - 10_000, going_down_at: NOW - 5000, going_down_reason: 'restart' });
    assert.equal(s.state, 'restarting', 'no waiting for the heartbeat to go stale');
    assert.equal(s.reachable, false);
    assert.equal(s.expected_back_by, NOW - 5000 + LS.RESTART_GRACE_MS);
    assert.equal(s.offline_since, NOW - 5000);
    assert.equal(d({ alive: 1, last_seen_at: NOW - 1000, going_down_at: NOW - 5000, going_down_reason: 'restart' }).state, 'online');
    assert.equal(d({ alive: 0, last_seen_at: NOW - 12 * MIN, going_down_at: NOW - LS.RESTART_GRACE_MS - 1 }).state, 'offline');
    assert.equal(d({ alive: 1, last_seen_at: NOW - 10_000, going_down_at: NOW - 5000, going_down_reason: 'update' }).state, 'updating');
  });

  it('restartExpected: only an update holds the alarm back', () => {
    const upd = { update_request_id: 'r', update_requested_at: NOW - MIN, last_seen_at: NOW - MIN };
    assert.equal(LS.restartExpected(upd, { now: NOW, updateState: 'updating', updateTimeoutMs: 15 * MIN }).kind, 'update');
    assert.equal(LS.restartExpected({ last_seen_at: NOW - MIN, going_down_at: NOW - 30_000, going_down_reason: 'restart' }, { now: NOW }), null);
    assert.equal(LS.restartExpected({ last_seen_at: NOW - MIN, going_down_at: NOW - 30_000, going_down_reason: 'update' }, { now: NOW }).kind, 'update');
    assert.equal(LS.restartExpected({ last_seen_at: NOW - MIN }, { now: NOW }), null);
  });

  it('legacyStatus: the old `status` field from the live state', () => {
    const on = { state: 'online', reachable: true };
    assert.equal(LS.legacyStatus(on, 'unknown', true), 'online', 'no waiting for four heartbeats');
    assert.equal(LS.legacyStatus(on, 'offline', true), 'online', 'no 5-minute hysteresis once the heartbeat is healthy');
    assert.equal(LS.legacyStatus(on, 'offline', false), 'offline', 'a heartbeat reporting listener_failed stays offline');
    assert.equal(LS.legacyStatus({ state: 'updating', reachable: false }, 'online', true), 'offline');
    assert.equal(LS.legacyStatus({ state: 'unknown', reachable: false }, 'unknown', true), 'unknown');
  });
});

describe('gateway live state: alarms, API, pool, dashboard', () => {
  let db, gatewayHealth, gateways, LS, activity, agent;
  const TOKEN = 'gc_gw_' + 'b'.repeat(64);

  before(async () => {
    await setup();
    require('../src/services/caddyConfig').syncToCaddy = async () => {};
    db = require('../src/db/connection').getDb();
    gatewayHealth = require('../src/services/gatewayHealth');
    gateways = require('../src/services/gateways');
    LS = require('../src/services/gatewayLiveState');
    activity = (type, peerId) => db.prepare('SELECT * FROM activity_log WHERE event_type = ? ORDER BY id').all(type)
      .filter((r) => { try { const d = JSON.parse(r.details || '{}'); return d.peerId === peerId || d.peer_id === peerId; } catch { return false; } });
    agent = getAgent();
  });
  after(teardown);

  let nextId = 500;
  function gateway(extra) {
    const id = nextId++;
    db.prepare("INSERT INTO peers (id, name, public_key, peer_type, allowed_ips, enabled) VALUES (?, ?, ?, 'gateway', ?, 1)")
      .run(id, 'gw' + id, 'pk' + id, '10.8.1.' + (id % 250) + '/32');
    db.prepare(`INSERT INTO gateway_meta (peer_id, api_port, api_token_hash, push_token_encrypted, alive, last_seen_at, created_at)
      VALUES (?, 9876, ?, 'e', 1, ?, strftime('%s','now')*1000)`).run(id, 'h' + id, Date.now());
    if (extra) db.prepare(`UPDATE gateway_meta SET ${Object.keys(extra).map((k) => k + ' = ?').join(', ')} WHERE peer_id = ?`).run(...Object.values(extra), id);
    gatewayHealth.evaluatePeer(id);
    return id;
  }
  const goStale = (id, ago = 100_000) => db.prepare('UPDATE gateway_meta SET last_seen_at = ? WHERE peer_id = ?').run(Date.now() - ago, id);
  const heartbeat = (id) => db.prepare('UPDATE gateway_meta SET last_seen_at = ? WHERE peer_id = ?').run(Date.now(), id);
  async function evaluate(id) {
    const { transition } = gatewayHealth.evaluatePeer(id);
    if (transition) await gatewayHealth._onTransition(id, transition);
    return transition;
  }
  beforeEach(() => { LS._resetForTest(); });

  it('an outage without an update: gateway_down as before, no hold', async () => {
    const id = gateway();
    goStale(id);
    assert.equal(await evaluate(id), 'alive_to_down');
    assert.equal(activity('gateway_down', id).length, 1);
    assert.equal(db.prepare('SELECT down_alarm_held_at FROM gateway_meta WHERE peer_id = ?').get(id).down_alarm_held_at, null);
  });

  it('an update GateControl asked for: no gateway_down while it restarts, no gateway_alive when it is back', async () => {
    const id = gateway();
    gateways.markUpdateRequested(id, 'req-1', '1.30.0');
    goStale(id);
    assert.equal(LS.forPeer(id).state, 'updating');
    assert.equal(await evaluate(id), 'alive_to_down');
    assert.equal(activity('gateway_down', id).length, 0, 'the offline alarm is held back');
    assert.equal(activity('gateway_update_restart', id).length, 1);
    assert.ok(db.prepare('SELECT down_alarm_held_at FROM gateway_meta WHERE peer_id = ?').get(id).down_alarm_held_at);
    // back: first heartbeat → online at once (the routing goes through its cooldown: none here)
    heartbeat(id);
    assert.equal(await evaluate(id), 'down_to_cooldown');
    assert.equal(LS.forPeer(id).state, 'online');
    assert.equal(LS.forPeer(id).reachable, true);
    assert.equal(await evaluate(id), 'cooldown_to_alive');
    assert.equal(activity('gateway_alive', id).length, 0, 'no "online again" alarm for an outage nobody was told about');
    assert.equal(activity('gateway_update_back', id).length, 1);
    assert.equal(db.prepare('SELECT down_alarm_held_at FROM gateway_meta WHERE peer_id = ?').get(id).down_alarm_held_at, null);
  });

  it('the update takes too long: the held alarm is sent late, then the state is plain offline', async () => {
    const id = gateway();
    gateways.markUpdateRequested(id, 'req-2', '1.30.0');
    goStale(id);
    await evaluate(id);
    assert.equal(activity('gateway_down', id).length, 0);
    // still expected: nothing released
    assert.deepEqual(gatewayHealth.releaseHeldAlarms().filter((r) => r.peerId === id), []);
    // the time is up (request 40 min ago, last heartbeat 20 min ago)
    db.prepare('UPDATE gateway_meta SET update_requested_at = ?, last_seen_at = ? WHERE peer_id = ?').run(Date.now() - 40 * MIN, Date.now() - 20 * MIN, id);
    assert.equal(LS.forPeer(id).state, 'offline');
    const rel = gatewayHealth.releaseHeldAlarms().filter((r) => r.peerId === id);
    assert.deepEqual(rel, [{ peerId: id, path: 'health' }]);
    const down = activity('gateway_down', id);
    assert.equal(down.length, 1);
    assert.equal(JSON.parse(down[0].details).after_update, true);
    // released once only
    assert.deepEqual(gatewayHealth.releaseHeldAlarms().filter((r) => r.peerId === id), []);
    // and when it comes back after all: the normal "online" alarm (somebody was told it was away)
    heartbeat(id);
    await evaluate(id);
    await evaluate(id);
    assert.equal(activity('gateway_alive', id).length, 1);
  });

  it('legacy sliding window (gateway in no pool): its offline alarm is held during an update too', () => {
    const id = gateway();
    gateways.markUpdateRequested(id, 'req-3', null);
    for (let i = 0; i < 4; i++) gateways.recordProbeResult(id, true);
    gateways._forceCooldownExhaustedForTest(id);
    for (let i = 0; i < 3; i++) gateways.recordProbeResult(id, false);
    assert.equal(gateways.getHealthStatus(id), 'offline');
    assert.equal(activity('gateway_offline', id).length, 0);
    assert.ok(db.prepare('SELECT offline_alarm_held_at FROM gateway_meta WHERE peer_id = ?').get(id).offline_alarm_held_at);
    // the update is over without the gateway: released late
    db.prepare('UPDATE gateway_meta SET update_requested_at = ?, last_seen_at = ? WHERE peer_id = ?').run(Date.now() - 40 * MIN, Date.now() - 20 * MIN, id);
    gatewayHealth.releaseHeldAlarms();
    assert.equal(activity('gateway_offline', id).length, 1);
  });

  it('GET /api/v1/gateways: old fields kept, live state added; failback cooldown shows online', async () => {
    const pool = require('../src/services/gatewayPool');
    const a = gateway();
    const b = gateway();
    const poolId = pool.createPool({ name: 'LivePool', mode: 'failover', failback_cooldown_s: 900 });
    pool.addMember(poolId, a, 1);
    pool.addMember(poolId, b, 2);
    // a was down and is back since 1 min: the routing waits 15 min
    db.prepare('UPDATE gateway_meta SET alive = 0, went_down_at = ?, recovered_first_hb_at = ?, last_seen_at = ? WHERE peer_id = ?')
      .run(Date.now() - 10 * MIN, Date.now() - MIN, Date.now() - 2000, a);
    const res = await agent.get('/api/v1/gateways').expect(200);
    const g = res.body.gateways.find((x) => x.peer_id === a);
    for (const k of ['peer_id', 'name', 'status', 'last_seen_at', 'health', 'routes', 'update_state', 'never_connected']) assert.ok(k in g, 'old field ' + k);
    assert.equal(g.status, 'online', 'reachable — not offline for the whole failback cooldown');
    assert.equal(g.state, 'online');
    assert.equal(g.reachable, true);
    assert.equal(g.alive, false);
    assert.ok(Math.abs(g.failback_at - (Date.now() - MIN + 900_000)) < 5000);
    assert.equal(g.failback_takes_routes, true, 'the first member takes the pool routes back');
    assert.ok('health_status' in g && 'expected_back_by' in g && 'offline_since' in g);

    // pool page: still "recovering" by the routing, reachable by the live state
    const st = (await agent.get('/api/v1/gateway-pools/state').expect(200)).body;
    const m = st.pools.find((p) => p.id === poolId).members.find((x) => x.peer_id === a);
    assert.equal(m.state, 'recovering');
    assert.equal(m.live_state, 'online');
    assert.equal(m.reachable, true);
    assert.equal(m.failback_takes_routes, true);

    // dashboard: no "gateway offline" problem for it
    const problems = require('../src/services/dashboardProblems');
    const res2 = await problems.list({ access: null });
    const rows = Array.isArray(res2) ? res2 : (res2.problems || []);
    assert.equal(rows.some((p) => p.kind === 'gateway_offline' && p.gateway && p.gateway.peer_id === a), false);
    // … but one whose heartbeat is gone is (before the watchdog has ticked)
    goStale(b, 5 * MIN);
    const res3 = await problems.list({ access: null });
    assert.equal((Array.isArray(res3) ? res3 : res3.problems).some((p) => p.kind === 'gateway_offline' && p.gateway && p.gateway.peer_id === b), true);
  });

  it('POST /api/v1/gateway/going-down: restarting at once, the next heartbeat ends it; SSE event on change', async () => {
    const { hashToken } = require('../src/middleware/gatewayAuth');
    const id = gateway({ api_token_hash: hashToken(TOKEN) });
    const supertest = require('supertest');
    const app = require('../src/app').createApp();
    const eventBus = require('../src/services/eventBus');
    const events = [];
    const listener = (e) => { if (e.type === 'gateway' && e.payload.peerId === id) events.push(e.payload); };
    eventBus.subscribe(listener);
    try {
      LS.publishChanges([id]); // remember the current state (online)
      await supertest(app).post('/api/v1/gateway/going-down').set('Authorization', 'Bearer ' + TOKEN).send({ reason: 'restart' }).expect(200);
      assert.equal(LS.forPeer(id).state, 'restarting');
      assert.deepEqual(events.map((e) => [e.state, e.transition]), [['restarting', 'live_state']]);
      assert.equal(activity('gateway_down', id).length, 0);
      assert.equal(activity('gateway_going_down', id).length, 1);
      const g = (await agent.get('/api/v1/gateways').expect(200)).body.gateways.find((x) => x.peer_id === id);
      assert.equal(g.state, 'restarting');
      assert.equal(g.status, 'offline', 'old field: not reachable');
      assert.ok(g.expected_back_by > Date.now());
      // back
      await supertest(app).post('/api/v1/gateway/heartbeat').set('Authorization', 'Bearer ' + TOKEN).send({ tcp_listeners: [] }).expect(200);
      assert.equal(LS.forPeer(id).state, 'online');
      assert.deepEqual(events.map((e) => e.state), ['restarting', 'online']);
      // a gateway that says it stops for an update
      await supertest(app).post('/api/v1/gateway/going-down').set('Authorization', 'Bearer ' + TOKEN).send({ reason: 'update' }).expect(200);
      assert.equal(LS.forPeer(id).state, 'updating');
      // without a token: refused
      await supertest(app).post('/api/v1/gateway/going-down').send({ reason: 'update' }).expect(401);
    } finally {
      eventBus.unsubscribe(listener);
    }
  });

  it('display tick: offline is published once the heartbeat is older than the threshold', () => {
    const id = gateway();
    const eventBus = require('../src/services/eventBus');
    const events = [];
    const listener = (e) => { if (e.type === 'gateway' && e.payload.peerId === id) events.push(e.payload.state); };
    eventBus.subscribe(listener);
    try {
      LS.publishChanges();
      assert.deepEqual(events, [], 'the first look only remembers');
      goStale(id);
      LS.publishChanges();
      assert.deepEqual(events, ['offline'], 'without waiting for the watchdog');
      LS.publishChanges();
      assert.deepEqual(events, ['offline'], 'no repeat without a change');
    } finally {
      eventBus.unsubscribe(listener);
    }
  });
});
