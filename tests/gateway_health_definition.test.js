'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

process.env.GC_SECRET = process.env.GC_SECRET || crypto.randomBytes(32).toString('hex');
process.env.GC_ENCRYPTION_KEY = process.env.GC_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

// Pure unit tests against the health-classifier; no DB, no server.
const { _isHeartbeatHealthy: isHealthy } = require('../src/services/gateways');

describe('gateway health: _isHeartbeatHealthy', () => {

  it('returns false for empty / malformed payloads', () => {
    assert.equal(isHealthy(null), false);
    assert.equal(isHealthy(undefined), false);
    assert.equal(isHealthy('string'), false);
  });

  it('stays healthy when a route is unreachable but listeners are up', () => {
    // Bug 1 (2026-04-30): Home Gateway with one offline LAN target was
    // flagged offline because the old definition required all routes
    // reachable. route_reachability is per-route info — gateway liveness
    // depends only on the gateway process itself.
    const health = {
      http_proxy_healthy: true,
      tcp_listeners: [{ port: 13389, status: 'listening' }],
      route_reachability: [
        { route_id: 1, reachable: true },
        { route_id: 2, reachable: false }, // pve1 dead — gateway still up
      ],
    };
    assert.equal(isHealthy(health), true);
  });

  it('stays healthy when self-check reports proxy unhealthy but listeners are up', () => {
    // NAS1 reality: localhost probe reports http_proxy_healthy:false but
    // every TCP listener is bound and answering. The process is alive.
    const health = {
      http_proxy_healthy: false,
      tcp_listeners: [{ port: 2022, status: 'listening' }],
      route_reachability: [
        { route_id: 43, reachable: true,  latency_ms: 2 },
        { route_id: 46, reachable: true,  latency_ms: 1 },
      ],
    };
    assert.equal(isHealthy(health), true);
  });

  it('flags unhealthy when any tcp_listener is explicitly listener_failed', () => {
    // Real listener-bind problem (port collision, permission, etc.) —
    // process is broken regardless of what reachability says.
    const health = {
      http_proxy_healthy: true,
      tcp_listeners: [
        { port: 443, status: 'listening' },
        { port: 80,  status: 'listener_failed' },
      ],
      route_reachability: [{ route_id: 1, reachable: true }],
    };
    assert.equal(isHealthy(health), false);
  });

  it('treats a bare heartbeat with no signals as healthy (process alive)', () => {
    // Very early heartbeat, before the gateway has run any self-check or
    // reachability probe. The mere fact a heartbeat arrived means the
    // process is up.
    assert.equal(isHealthy({ uptime_s: 3 }), true);
    assert.equal(isHealthy({}), true);
  });

  it('healthy when tcp_listeners array is empty (no broken listener evidence)', () => {
    // No listener evidence either way → trust the heartbeat itself.
    assert.equal(isHealthy({ tcp_listeners: [] }), true);
    assert.equal(isHealthy({ tcp_listeners: [], http_proxy_healthy: false }), true);
  });

  it('ignores route_reachability for liveness — even a fully unreachable list', () => {
    // A gateway sitting on an isolated LAN that briefly loses its targets
    // is not itself broken. Per-route badges show the trouble, gateway
    // itself stays online as long as the heartbeat keeps arriving.
    const health = {
      tcp_listeners: [{ port: 443, status: 'listening' }],
      route_reachability: [
        { route_id: 1, reachable: false },
        { route_id: 2, reachable: false },
      ],
    };
    assert.equal(isHealthy(health), true);
  });

});
