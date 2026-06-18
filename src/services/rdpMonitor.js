'use strict';

const net = require('node:net');
const { getDb } = require('../db/connection');
const config = require('../../config/default');
const logger = require('../utils/logger');

let pollerInterval = null;
const statusCache = new Map();

// Gateway routes are reachable via the server's own public L4 listener,
// not via the LAN host (which the server cannot reach). Probe loopback.
function resolveCheckTarget(route) {
  if ((route.access_mode || 'internal') === 'gateway') {
    return { host: '127.0.0.1', port: route.gateway_listen_port || route.port };
  }
  return { host: route.host, port: route.port };
}

// Mirrors gatewayHealth's staleness definition (last_seen_at stored as epoch ms).
function isGatewayStale(lastSeenAt, thresholdMs, now = Date.now()) {
  if (lastSeenAt == null) return true;
  return (now - lastSeenAt) > thresholdMs;
}

// A gateway route is only reachable if its linked gateway peer still heartbeats —
// otherwise the local L4 listener accepts the connection but the dead gateway
// never forwards it (false-positive "online").
function isGatewayLive(route, db) {
  // Only DIRECT single-peer gateway routes need a heartbeat gate: their L4
  // listener stays up even when the peer is dead (no failover), so the loopback
  // probe alone would false-positive "online". Pool-backed gateway routes
  // (gateway_pool_id set, gateway_peer_id null) are intentionally NOT gated here —
  // caddyConfig removes the L4 listener on pool outage, so the loopback probe is
  // already accurate for them.
  if ((route.access_mode || 'internal') !== 'gateway' || !route.gateway_peer_id) return true;
  const meta = db.prepare('SELECT last_seen_at FROM gateway_meta WHERE peer_id = ?').get(route.gateway_peer_id);
  const row = db.prepare("SELECT value FROM settings WHERE key = 'gateway_down_threshold_s'").get();
  // `|| 90` also guards a corrupt (non-numeric) setting value — intentionally
  // safer than gatewayHealth's raw parseInt (which would yield NaN, i.e. "alive").
  const thresholdMs = (parseInt(row?.value ?? '90', 10) || 90) * 1000;
  return !isGatewayStale(meta?.last_seen_at ?? null, thresholdMs);
}

// Single probe path shared by checkRouteById + checkAll.
async function _probe(route, db) {
  // Gateway-mode routes: a local checkTcp to 127.0.0.1:listen_port hits the
  // server's own L4 listener, which accepts unconditionally → false "online"
  // whenever the gateway is alive but the real host is down. First gate on the
  // gateway heartbeat (dead gateway → offline fast), then ask the gateway to
  // probe the REAL host inside its LAN.
  if ((route.access_mode || 'internal') === 'gateway' && route.gateway_peer_id) {
    if (!isGatewayLive(route, db)) return { online: false, responseTime: null };
    // No real host to probe → a gateway route without host is misconfigured.
    // Report offline rather than falling back to the loopback false-positive.
    if (!route.host || !route.port) return { online: false, responseTime: null };
    const gateways = require('./gateways'); // lazy require avoids a require cycle
    const resp = await gateways.probeGatewayTarget(route.gateway_peer_id, route.host, route.port);
    // Only trust the result if this gateway actually honored the target
    // (new companion sets probed_target). Old companion / call failure →
    // fall back to the legacy loopback probe rather than guess.
    if (resp && resp.probed_target) {
      return { online: !!resp.probe_result, responseTime: resp.probe_latency_ms ?? null };
    }
    const tgt = resolveCheckTarget(route);
    return checkTcp(tgt.host, tgt.port);
  }
  const tgt = resolveCheckTarget(route);
  return checkTcp(tgt.host, tgt.port);
}

function checkTcp(host, port, timeout) {
  return new Promise((resolve) => {
    const start = Date.now();
    const socket = new net.Socket();
    socket.setTimeout(timeout || config.rdp.healthCheckTimeout);
    socket.on('connect', () => {
      const responseTime = Date.now() - start;
      socket.destroy();
      resolve({ online: true, responseTime });
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve({ online: false, responseTime: Date.now() - start });
    });
    socket.on('error', () => {
      socket.destroy();
      resolve({ online: false, responseTime: Date.now() - start });
    });
    socket.connect(port, host);
  });
}

async function checkRouteById(id) {
  const db = getDb();
  const route = db.prepare('SELECT id, name, host, port, access_mode, gateway_peer_id, gateway_listen_port, health_check_enabled FROM rdp_routes WHERE id = ?').get(id);
  if (!route) throw new Error('RDP route not found');
  const result = await _probe(route, db);
  const now = new Date().toISOString();
  statusCache.set(route.id, { online: result.online, lastCheck: now, responseTime: result.responseTime });
  return { id: route.id, online: result.online, responseTime: result.responseTime, lastCheck: now };
}

let _checkAllInFlight = false;

async function checkAll() {
  // Re-entry guard: gateway probes can take up to the per-probe timeout;
  // skip a tick rather than stack overlapping cycles (duplicate load +
  // statusCache races).
  if (_checkAllInFlight) {
    logger.debug('RDP health check still running — skipping this tick');
    return [];
  }
  _checkAllInFlight = true;
  try {
    const db = getDb();
    const routes = db.prepare('SELECT id, name, host, port, access_mode, gateway_peer_id, gateway_listen_port, health_check_enabled FROM rdp_routes WHERE enabled = 1 AND health_check_enabled = 1').all();
    // Parallel: one slow/unreachable gateway must not stall the others.
    const settled = await Promise.allSettled(routes.map(route => _probe(route, db)));
    const results = [];
    routes.forEach((route, i) => {
      const s = settled[i];
      if (s.status === 'fulfilled') {
        const now = new Date().toISOString();
        statusCache.set(route.id, { online: s.value.online, lastCheck: now, responseTime: s.value.responseTime });
        results.push({ id: route.id, name: route.name, online: s.value.online, responseTime: s.value.responseTime });
      } else {
        logger.warn({ routeId: route.id, error: s.reason && s.reason.message }, 'RDP health check failed');
      }
    });
    return results;
  } finally {
    _checkAllInFlight = false;
  }
}

function getStatus(id) {
  return statusCache.get(id) || { online: false, lastCheck: null, responseTime: null };
}

function getAllStatus() {
  const result = {};
  for (const [id, status] of statusCache) {
    result[id] = status;
  }
  return result;
}

function startMonitor() {
  if (pollerInterval) return;
  const interval = config.rdp.healthCheckInterval;
  logger.info({ interval }, 'Starting RDP health check monitor');
  setTimeout(() => {
    checkAll().catch(err => logger.warn({ error: err.message }, 'Initial RDP health check failed'));
  }, 10000);
  pollerInterval = setInterval(() => {
    checkAll().catch(err => logger.warn({ error: err.message }, 'RDP health check cycle failed'));
  }, interval);
}

function stopMonitor() {
  if (pollerInterval) {
    clearInterval(pollerInterval);
    pollerInterval = null;
  }
}

module.exports = { checkTcp, checkRouteById, checkAll, getStatus, getAllStatus, startMonitor, stopMonitor, resolveCheckTarget, isGatewayStale };
