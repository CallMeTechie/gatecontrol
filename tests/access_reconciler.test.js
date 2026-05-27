'use strict';
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, teardown } = require('./helpers/setup');
const { getDb } = require('../src/db/connection');

let reconciler, wireguard, caddySync, peers, accessRules, activity;
let origRemovePeer, origRequestSync, origRewrite, origIsDenied, origLog;
let removeCalls, syncCalls, rewriteCalls, logged;

function insertPeer(name, pk, enabled = 1) {
  return Number(getDb().prepare(
    "INSERT INTO peers (name, public_key, allowed_ips, enabled) VALUES (?, ?, '10.8.0.5/32', ?)"
  ).run(name, pk, enabled).lastInsertRowid);
}
function insertRoute(domain, routeType = 'http') {
  return Number(getDb().prepare(
    "INSERT INTO routes (domain, target_ip, target_port, route_type, enabled) VALUES (?, '10.0.0.1', 80, ?, 1)"
  ).run(domain, routeType).lastInsertRowid);
}
function addRule(targetType, targetId, mode = 'block', schedule = 'Mo-Su 00:00-23:59') {
  return accessRules.createRule({ target_type: targetType, target_id: targetId, mode, schedule });
}

// Mon 2026-06-01 — every clock below lands on a Monday daytime.
const MON10 = new Date(2026, 5, 1, 10, 0, 0);

beforeEach(async () => {
  await setup();
  // Fresh require AFTER setup so the module's lastDenied Set is reset between
  // tests (delete from cache so module state doesn't bleed across tests).
  delete require.cache[require.resolve('../src/services/accessReconciler')];
  reconciler = require('../src/services/accessReconciler');

  wireguard = require('../src/services/wireguard');
  caddySync = require('../src/services/caddySync');
  peers = require('../src/services/peers');
  accessRules = require('../src/services/accessRules');
  activity = require('../src/services/activity');

  origRemovePeer = wireguard.removePeer;
  origRequestSync = caddySync.requestCaddySync;
  origRewrite = peers.rewriteWgConfig;
  origIsDenied = accessRules.isDenied;
  origLog = activity.log;

  removeCalls = [];
  syncCalls = 0;
  rewriteCalls = 0;
  logged = [];

  wireguard.removePeer = async (pk) => { removeCalls.push(pk); return null; };
  caddySync.requestCaddySync = async () => { syncCalls++; };
  peers.rewriteWgConfig = async () => { rewriteCalls++; };
  activity.log = (type, msg, opts) => { logged.push({ type, msg, opts }); };
});

afterEach(() => {
  wireguard.removePeer = origRemovePeer;
  caddySync.requestCaddySync = origRequestSync;
  peers.rewriteWgConfig = origRewrite;
  accessRules.isDenied = origIsDenied;
  activity.log = origLog;
  teardown();
});

test('allow -> deny peer: removePeer(public_key) once + caddy sync + activity-logged', async () => {
  const pid = insertPeer('p1', 'PK_P1=');
  const rid = insertRoute('r1.example.com', 'http');
  addRule('peer', pid);   // block: denied
  addRule('route', rid);  // block: denied (so routesChanged -> sync requested)

  // First reconcile establishes lastDenied as EMPTY then sees these as new.
  // To isolate "allow->deny", prime lastDenied with an empty deny-set via a
  // clock where the rules don't match, then flip. Simpler: prime with no rules.
  accessRules.isDenied = () => false;
  await reconciler.reconcile(MON10);  // baseline: nothing denied
  assert.equal(removeCalls.length, 0);
  assert.equal(syncCalls, 0);

  // Now flip both targets to denied.
  accessRules.isDenied = (t) => t === 'peer' || t === 'route';
  await reconciler.reconcile(MON10);

  assert.deepEqual(removeCalls, ['PK_P1='], 'removePeer called once with public_key');
  assert.equal(syncCalls, 1, 'caddy sync requested once (route became denied)');
  const denyLog = logged.filter(l => l.type === 'access_window_denied');
  assert.ok(denyLog.length >= 1, 'access_window_denied logged');
});

test('deny -> allow peer: rewriteWgConfig called + activity-logged access_window_allowed', async () => {
  const pid = insertPeer('p1', 'PK_P1=');
  addRule('peer', pid);

  // Baseline: peer denied.
  accessRules.isDenied = (t) => t === 'peer';
  await reconciler.reconcile(MON10);
  assert.deepEqual(removeCalls, ['PK_P1=']);
  const rewriteAfterDeny = rewriteCalls;

  // Flip to allowed.
  accessRules.isDenied = () => false;
  await reconciler.reconcile(MON10);

  assert.ok(rewriteCalls > rewriteAfterDeny, 'rewriteWgConfig called on deny->allow (re-add)');
  const allowLog = logged.filter(l => l.type === 'access_window_allowed');
  assert.ok(allowLog.length >= 1, 'access_window_allowed logged');
});

test('no-op tick: neither removePeer nor requestCaddySync called', async () => {
  const pid = insertPeer('p1', 'PK_P1=');
  const rid = insertRoute('r1.example.com', 'http');
  addRule('peer', pid);
  addRule('route', rid);

  // Baseline denied.
  accessRules.isDenied = () => true;
  await reconciler.reconcile(MON10);
  const removeAfter = removeCalls.length;
  const syncAfter = syncCalls;

  // Same deny-set on next tick -> no-op.
  await reconciler.reconcile(MON10);
  assert.equal(removeCalls.length, removeAfter, 'no new removePeer on unchanged deny-set');
  assert.equal(syncCalls, syncAfter, 'no new caddy sync on unchanged deny-set');
});

test('start()/initial: already-denied enabled peer in initial deny-set gets removePeer; denied L4 route activity-logged', async () => {
  const pid = insertPeer('p1', 'PK_P1=');
  const rid = insertRoute('l4.example.com', 'l4');
  addRule('peer', pid);
  addRule('route', rid);

  // Already denied at boot — lastDenied empty so both are transitions.
  accessRules.isDenied = () => true;
  await reconciler.start();
  try {
    assert.deepEqual(removeCalls, ['PK_P1='], 'initial denied peer disconnected at boot');
    const routeDenyLog = logged.filter(l =>
      l.type === 'access_window_denied' && l.opts && l.opts.details && l.opts.details.target_type === 'route');
    assert.ok(routeDenyLog.length >= 1, 'initial denied L4 route is activity-logged (not silent)');
  } finally {
    reconciler.stop();
  }
});

test('orphan sweep: a rule whose target row no longer exists is deleted', async () => {
  const pid = insertPeer('p1', 'PK_P1=');
  addRule('peer', pid);
  addRule('route', 9999);  // route 9999 does not exist -> orphan
  addRule('peer', 8888);   // peer 8888 does not exist -> orphan

  accessRules.isDenied = () => false;
  await reconciler.reconcile(MON10);

  const remaining = getDb().prepare('SELECT target_type, target_id FROM access_rules').all();
  assert.equal(remaining.length, 1, 'only the rule for the existing peer survives');
  assert.equal(remaining[0].target_type, 'peer');
  assert.equal(remaining[0].target_id, pid);
});

test('peer with enabled=0 + a deny-window rule is NOT in the deny-set (no removePeer)', async () => {
  const pid = insertPeer('disabled-peer', 'PK_DIS=', 0);  // enabled=0
  addRule('peer', pid);

  // isDenied would say denied, but the reconciler must gate peers on enabled=1.
  accessRules.isDenied = () => true;
  await reconciler.reconcile(MON10);

  assert.equal(removeCalls.length, 0, 'disabled peer never triggers removePeer');
  const denyLog = logged.filter(l =>
    l.type === 'access_window_denied' && l.opts && l.opts.details &&
    l.opts.details.target_type === 'peer' && l.opts.details.target_id === pid);
  assert.equal(denyLog.length, 0, 'disabled peer not logged as a transition');
});
