'use strict';

// Why the edge channel of a gateway is down (src/services/edge/reason.js):
// heartbeat + telemetry.edge of the gateway instead of a bare "offline".

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { diagnose, REASONS } = require('../src/services/edge/reason');

const NOW = Date.parse('2026-11-06T12:00:00Z');
const MIN = '1.19.0';
const fresh = { at: '2026-11-06T11:59:40Z', stale: false, edge_host: '1.0.0', connected: false, edge_enabled: true, plugins: [], mqtt: null, fence: null };
const fenceOk = { active: true, backend: 'iptables', error: null };

function run(edge, extra) {
  const telemetry = edge === undefined ? { gateway_version: '1.22.0' } : { gateway_version: '1.22.0', edge };
  return diagnose({ online: false, seenAt: NOW - 20000, now: NOW, thresholdMs: 90000, telemetry, minGateway: MIN, ...extra });
}

describe('edge channel: why it is down', () => {
  it('the channel is up → no reason', () => {
    assert.deepEqual(run(null, { online: true }), { reason: null, detail: null });
  });

  it('no heartbeat within the threshold (or never) → gateway_offline', () => {
    assert.equal(run(null, { seenAt: NOW - 91000 }).reason, 'gateway_offline');
    assert.equal(run(null, { seenAt: null }).reason, 'gateway_offline');
    assert.equal(run(null, { seenAt: NOW - 89000 }).reason, 'edge_missing');
  });

  it('telemetry.edge null → edge_missing (no edge service in the compose file)', () => {
    assert.deepEqual(run(null), { reason: 'edge_missing', detail: null });
  });

  it('no summary of the edge host, or an old one → edge_not_running', () => {
    assert.equal(run({ deployed: true, error: null, fence: fenceOk, host: null }).reason, 'edge_not_running');
    assert.equal(run({ deployed: true, error: null, fence: fenceOk, host: { ...fresh, stale: true } }).reason, 'edge_not_running');
  });

  it('the network fence could not be set → edge_fence with the gateway\'s message (one line, bounded)', () => {
    const err = 'nft: Error: Could not process rule | iptables owner match: iptables v1.8.10 (legacy): Couldn\'t load match `owner\':No such file or directory\n';
    const r = run({ deployed: true, error: null, fence: { active: false, backend: null, error: err }, host: fresh });
    assert.equal(r.reason, 'edge_fence');
    assert.match(r.detail, /owner match/);
    assert.doesNotMatch(r.detail, /\n/);
    const long = run({ deployed: true, error: null, fence: { active: false, backend: null, error: 'x'.repeat(2000) }, host: fresh });
    assert.equal(long.detail.length, 300);
    assert.equal(run({ deployed: true, error: null, fence: { active: false, backend: null, error: null }, host: fresh }).detail, null);
  });

  it('edge host runs but is not connected → edge_not_connected (with the gateway\'s error, if any)', () => {
    assert.deepEqual(run({ deployed: true, error: null, fence: fenceOk, host: fresh }), { reason: 'edge_not_connected', detail: null });
    assert.deepEqual(run({ deployed: true, error: 'resolve: ENOTFOUND', fence: fenceOk, host: fresh }), { reason: 'edge_not_connected', detail: 'resolve: ENOTFOUND' });
    // no fence block at all (never written): not a fence verdict
    assert.equal(run({ deployed: true, error: null, host: fresh }).reason, 'edge_not_connected');
  });

  it('the edge host says it is connected (just reconnecting) → no verdict', () => {
    assert.equal(run({ deployed: true, error: null, fence: fenceOk, host: { ...fresh, connected: true } }).reason, null);
  });

  it('gateways older than the edge release, or without edge telemetry, keep the plain offline', () => {
    assert.equal(run(null, { telemetry: { gateway_version: '1.18.3', edge: null } }).reason, null);
    assert.equal(run(null, { telemetry: { gateway_version: '1.18.3' }, seenAt: null }).reason, null);
    assert.equal(run(undefined).reason, null);
    assert.equal(run(null, { telemetry: null }).reason, null);
    assert.equal(run('broken').reason, null);
    // version unknown: the heartbeat still decides
    assert.equal(run(null, { telemetry: { edge: null } }).reason, 'edge_missing');
  });

  it('the order: gateway away beats everything, a missing host beats the fence', () => {
    assert.equal(run({ deployed: true, error: null, fence: { active: false, error: 'x' }, host: null }).reason, 'edge_not_running');
    assert.equal(run({ deployed: true, error: null, fence: { active: false, error: 'x' }, host: null }, { seenAt: NOW - 600000 }).reason, 'gateway_offline');
  });

  it('every reason is one of REASONS', () => {
    assert.deepEqual(REASONS, ['gateway_offline', 'edge_missing', 'edge_not_running', 'compose_outdated', 'edge_fence', 'edge_not_connected']);
  });

  it('gateway >= 1.23.0 reports the mode: isolated → no fence verdict; fence without fence → compose_outdated', () => {
    const noFence = { active: false, backend: null, error: 'iptables owner match: Couldn\'t load match `owner\'' };
    // edge container without network: the fence does not matter (Synology without xt_owner, new compose)
    assert.equal(run({ deployed: true, error: null, fence: noFence, mode: 'isolated', host: fresh }).reason, 'edge_not_connected');
    assert.equal(run({ deployed: true, error: null, fence: noFence, mode: 'isolated', host: { ...fresh, connected: true } }).reason, null);
    // older compose file (edge in the host network) and no fence → the current compose file is the way out
    const r = run({ deployed: true, error: null, fence: noFence, mode: 'fence', host: fresh });
    assert.equal(r.reason, 'compose_outdated');
    assert.match(r.detail, /owner match/);
    // fence active with an older compose → fine
    assert.equal(run({ deployed: true, error: null, fence: fenceOk, mode: 'fence', host: fresh }).reason, 'edge_not_connected');
    // older gateway (no mode) or an unknown mode → edge_fence as before
    assert.equal(run({ deployed: true, error: null, fence: noFence, host: fresh }).reason, 'edge_fence');
    assert.equal(run({ deployed: true, error: null, fence: noFence, mode: 'other', host: fresh }).reason, 'edge_fence');
  });

  it('modeOf: the mode from telemetry.edge', () => {
    const { modeOf } = require('../src/services/edge/reason');
    assert.equal(modeOf({ edge: { mode: 'isolated' } }), 'isolated');
    assert.equal(modeOf({ edge: { mode: 'fence' } }), 'fence');
    assert.equal(modeOf({ edge: { mode: 'x' } }), null);
    assert.equal(modeOf({ edge: null }), null);
    assert.equal(modeOf(null), null);
  });
});
