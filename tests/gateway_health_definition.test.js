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

  it('treats all-reachable route_reachability as healthy even if self-check fails', () => {
    // This is the NAS1 reality: localhost probes fail but routes work.
    const health = {
      http_proxy_healthy: false,
      api_healthy: false,
      tcp_listeners: [{ port: 2022, status: 'listener_failed' }],
      route_reachability: [
        { route_id: 43, reachable: true,  latency_ms: 2 },
        { route_id: 46, reachable: true,  latency_ms: 1 },
        { route_id: 47, reachable: true,  latency_ms: 1 },
      ],
    };
    assert.equal(isHealthy(health), true);
  });

  it('flags unhealthy when any configured route is unreachable', () => {
    const health = {
      http_proxy_healthy: true,
      route_reachability: [
        { route_id: 1, reachable: true  },
        { route_id: 2, reachable: false },
      ],
    };
    assert.equal(isHealthy(health), false);
  });

  it('falls back to self-check when no route_reachability present', () => {
    // Self-check healthy
    assert.equal(isHealthy({
      http_proxy_healthy: true,
      tcp_listeners: [{ port: 443, status: 'listening' }],
    }), true);
    // Self-check: proxy down
    assert.equal(isHealthy({
      http_proxy_healthy: false,
      tcp_listeners: [],
    }), false);
    // Self-check: listener failed
    assert.equal(isHealthy({
      http_proxy_healthy: true,
      tcp_listeners: [{ port: 80, status: 'listener_failed' }],
    }), false);
  });

  it('treats a bare heartbeat with no signals as healthy (process alive)', () => {
    // Very early heartbeat, before the gateway has run any self-check or
    // reachability probe. The mere fact a heartbeat arrived means the
    // process is up.
    assert.equal(isHealthy({ uptime_s: 3 }), true);
    assert.equal(isHealthy({}), true);
  });

  it('empty route_reachability array defers to self-check', () => {
    // No routes to probe; self-check fails → unhealthy
    assert.equal(isHealthy({
      route_reachability: [],
      http_proxy_healthy: false,
    }), false);
    // No routes to probe; self-check passes → healthy
    assert.equal(isHealthy({
      route_reachability: [],
      http_proxy_healthy: true,
    }), true);
  });

});
