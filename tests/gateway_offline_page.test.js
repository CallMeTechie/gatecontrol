'use strict';

// Offline page of a gateway in no pool (src/services/gateways.js "Offline page
// of a gateway in no pool", caddyConfig: offlineGateways).
//
// A gateway restarts: after the down threshold the probes of the server fail
// and its routes serve the offline page. It used to keep that page until five
// minutes after it went away — the sliding window's cooldown — although the
// gateway had long been back, and the PATCH that should restore the route
// carried the bare word `revert` (no JSON: Caddy's admin API refuses it).
// Now: the first heartbeat takes the page back, through a normal sync.

const { describe, it, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown } = require('./helpers/setup');

let gateways, gatewayPool, caddyConfig, caddySync, getDb, StateMachine;
let syncs;

function addGateway(db, id, name) {
  db.prepare("INSERT INTO peers (id, name, public_key, peer_type, allowed_ips, enabled) VALUES (?, ?, ?, 'gateway', ?, 1)")
    .run(id, name, 'pk' + id, `10.8.0.${id}/32`);
  db.prepare(`INSERT INTO gateway_meta (peer_id, api_port, api_token_hash, push_token_encrypted, last_seen_at, alive, created_at)
    VALUES (?, 9876, ?, 'e', ?, 1, ?)`).run(id, 'h' + id, Date.now(), Date.now());
}
function addRoute(db, domain, peerId) {
  return db.prepare(`INSERT INTO routes (domain, target_ip, target_port, route_type, target_kind, target_peer_id, target_lan_host, target_lan_port, enabled, https_enabled)
    VALUES (?, '10.8.0.5', 8080, 'http', 'gateway', ?, '192.168.1.10', 8123, 1, 1)`).run(domain, peerId).lastInsertRowid;
}
/** The handler chain Caddy gets for a route (by its @id), found anywhere in the config. */
function handlersOf(cfg, routeId) {
  let found = null;
  (function walk(n) {
    if (found || !n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (n['@id'] === 'gc_route_' + routeId) { found = n; return; }
    Object.values(n).forEach(walk);
  })(cfg);
  return found ? JSON.stringify(found.handle) : null;
}
const healthy = { tcp_listeners: [], http_proxy_healthy: true };
/** Three failed probes after a calm phase: the window says offline. */
function goAway(id) {
  for (let i = 0; i < 4; i++) gateways.handleHeartbeat(id, healthy);
  assert.equal(gateways.getHealthStatus(id), 'online');
  gateways._forceCooldownExhaustedForTest(id);
  for (let i = 0; i < 3; i++) gateways.recordProbeResult(id, false);
  assert.equal(gateways.getHealthStatus(id), 'offline');
}

beforeEach(async () => {
  await setup();
  gateways = require('../src/services/gateways');
  gatewayPool = require('../src/services/gatewayPool');
  caddyConfig = require('../src/services/caddyConfig');
  caddySync = require('../src/services/caddySync');
  getDb = require('../src/db/connection').getDb;
  StateMachine = require('../src/services/gatewayHealth').StateMachine;
  gateways._resetSmCacheForTest();
  syncs = mock.method(caddySync, 'requestCaddySync', async () => true);
});
afterEach(async () => {
  syncs.mock.restore();
  gateways._resetSmCacheForTest();
  await teardown();
});

describe('sliding window: the gateway\'s own heartbeat ends "offline" at once', () => {
  function offlineMachine() {
    const sm = new StateMachine();
    for (let i = 0; i < 4; i++) sm.recordHeartbeat(true);
    sm._lastTransitionAt = Date.now() - 10 * 60 * 1000;
    for (let i = 0; i < 3; i++) sm.recordHeartbeat(false);
    assert.equal(sm.status, 'offline');
    return sm;
  }

  it('a healthy heartbeat of the gateway itself: online, inside the cooldown and with one sample', () => {
    const sm = offlineMachine();
    sm.recordHeartbeat(true, { direct: true });
    assert.equal(sm.status, 'online');
    assert.equal(sm._transitions[sm._transitions.length - 1].to, 'online');
  });

  it('a probe that gets through keeps the old rule (four of five, after the cooldown)', () => {
    const sm = offlineMachine();
    for (let i = 0; i < 5; i++) sm.recordHeartbeat(true);
    assert.equal(sm.status, 'offline', 'inside the cooldown');
    sm._lastTransitionAt = Date.now() - 10 * 60 * 1000;
    sm.recordHeartbeat(true);
    assert.equal(sm.status, 'online');
  });

  it('a heartbeat that reports a failure does not end it', () => {
    const sm = offlineMachine();
    sm.recordHeartbeat(false, { direct: true });
    assert.equal(sm.status, 'offline');
  });

  it('the failures of the outage cannot flip it straight back; the cooldown holds for the way down', () => {
    const sm = offlineMachine();
    sm.recordHeartbeat(true, { direct: true });
    sm.recordHeartbeat(false);
    sm.recordHeartbeat(false);
    assert.equal(sm.status, 'online', 'two failures after the recovery are not three of the window');
    sm.recordHeartbeat(false);
    assert.equal(sm.status, 'online', 'three of them, but inside the cooldown of the recovery');
    sm._lastTransitionAt = Date.now() - 10 * 60 * 1000;
    sm.recordHeartbeat(false);
    assert.equal(sm.status, 'offline');
  });
});

describe('offline page of a gateway in no pool', () => {
  it('away → the routes serve the page; the first heartbeat takes it back (not five minutes later)', () => {
    const db = getDb();
    addGateway(db, 5, 'homelab-gw');
    addGateway(db, 6, 'other-gw');
    const mine = addRoute(db, 'nas.example.com', 5);
    const other = addRoute(db, 'cam.example.com', 6);

    assert.match(handlersOf(caddyConfig.buildCaddyConfig(), mine), /reverse_proxy/);
    goAway(5);
    assert.deepEqual([...gateways.offlinePagePeerIds()], [5]);
    assert.equal(syncs.mock.callCount(), 1, 'one sync for the page');

    let cfg = caddyConfig.buildCaddyConfig();
    const page = handlersOf(cfg, mine);
    assert.match(page, /static_response/);
    assert.match(page, /"status_code":502/);
    assert.match(page, /homelab-gw/);
    assert.doesNotMatch(page, /reverse_proxy/);
    assert.match(handlersOf(cfg, other), /reverse_proxy/, 'the other gateway\'s route is untouched');

    // the gateway is back: ONE heartbeat, seconds after the window went offline
    gateways.handleHeartbeat(5, healthy);
    assert.equal(gateways.getHealthStatus(5), 'online');
    assert.equal(gateways.offlinePagePeerIds().size, 0);
    assert.equal(syncs.mock.callCount(), 2, 'one sync to take it back');
    cfg = caddyConfig.buildCaddyConfig();
    assert.match(handlersOf(cfg, mine), /reverse_proxy/);
    assert.doesNotMatch(handlersOf(cfg, mine), /static_response/);

    // further heartbeats change nothing and ask for no sync
    gateways.handleHeartbeat(5, healthy);
    assert.equal(syncs.mock.callCount(), 2);
  });

  it('a config built while the gateway is away keeps the page (any other sync in between)', () => {
    const db = getDb();
    addGateway(db, 5, 'homelab-gw');
    const mine = addRoute(db, 'nas.example.com', 5);
    goAway(5);
    for (let i = 0; i < 3; i++) assert.match(handlersOf(caddyConfig.buildCaddyConfig(), mine), /static_response/);
  });

  it('a heartbeat that reports a failed listener takes the page back too: the gateway answers', () => {
    const db = getDb();
    addGateway(db, 5, 'homelab-gw');
    const mine = addRoute(db, 'nas.example.com', 5);
    goAway(5);
    gateways.handleHeartbeat(5, { tcp_listeners: [{ port: 2222, status: 'listener_failed' }] });
    assert.equal(gateways.getHealthStatus(5), 'offline', 'the window keeps its word about the health');
    assert.equal(gateways.offlinePagePeerIds().size, 0);
    assert.match(handlersOf(caddyConfig.buildCaddyConfig(), mine), /reverse_proxy/);
    // and heartbeats alone (a broken listener, the gateway there) never put the page up
    for (let i = 0; i < 5; i++) gateways.handleHeartbeat(5, { tcp_listeners: [{ port: 2222, status: 'listener_failed' }] });
    assert.equal(gateways.offlinePagePeerIds().size, 0);
  });

  it('single probes do not switch the page back and forth', () => {
    const db = getDb();
    addGateway(db, 5, 'homelab-gw');
    addRoute(db, 'nas.example.com', 5);
    goAway(5);
    const n = syncs.mock.callCount();
    gateways.recordProbeResult(5, true);
    gateways.recordProbeResult(5, false);
    gateways.recordProbeResult(5, true);
    assert.deepEqual([...gateways.offlinePagePeerIds()], [5]);
    assert.equal(syncs.mock.callCount(), n, 'no sync for single probes');
  });

  it('a pool member never gets the page: its routes move to a sibling', () => {
    const db = getDb();
    addGateway(db, 5, 'gw-a');
    addGateway(db, 6, 'gw-b');
    const mine = addRoute(db, 'nas.example.com', 5);
    const pool = gatewayPool.createPool({ name: 'home', mode: 'failover', failback_cooldown_s: 60 });
    gatewayPool.addMember(pool, 5, 1);
    gatewayPool.addMember(pool, 6, 2);
    goAway(5);
    assert.equal(gateways.offlinePagePeerIds().size, 0);
    assert.equal(syncs.mock.callCount(), 0);
    assert.match(handlersOf(caddyConfig.buildCaddyConfig(), mine), /reverse_proxy/);
  });

  it('the page speaks the language of the instance, not the keys', () => {
    require('../src/middleware/i18n').loadLocales();
    const html = caddyConfig.renderMaintenancePage({ gateway_name: 'homelab-gw', gateway_last_seen: '2026-05-04 14:32 UTC' });
    assert.doesNotMatch(html, /gateway_offline_heading|gateway_offline_message|gateway_last_seen_label/);
    assert.match(html, /Home Gateway/);
    assert.match(html, /2026-05-04 14:32 UTC/);
  });
});
