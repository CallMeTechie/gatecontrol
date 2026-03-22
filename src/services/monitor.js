'use strict';

const net = require('node:net');
const https = require('node:https');
const http = require('node:http');
const { getDb } = require('../db/connection');
const config = require('../../config/default');
const settings = require('./settings');
const activity = require('./activity');
const webhook = require('./webhook');
const circuitBreaker = require('./circuitBreaker');
const logger = require('../utils/logger');

let pollerInterval = null;

/**
 * Get monitoring settings
 */
function getSettings() {
  return {
    interval: parseInt(settings.get('monitoring.interval', '60'), 10) || 60,
    emailAlerts: settings.get('monitoring.email_alerts', 'false') === 'true',
    alertEmail: settings.get('monitoring.alert_email', ''),
  };
}

/**
 * HTTP(S) health check — returns { up: boolean, responseTime: number }
 */
async function checkHttp(targetIp, targetPort, useHttps) {
  const start = Date.now();

  return new Promise((resolve) => {
    const mod = useHttps ? https : http;
    const options = {
      hostname: targetIp,
      port: targetPort,
      path: '/',
      method: 'GET',
      timeout: config.timeouts.monitorHttp,
      headers: { 'User-Agent': 'GateControl-Monitor/1.0' },
      // Accept self-signed certificates for backend HTTPS
      ...(useHttps ? { rejectUnauthorized: false } : {}),
    };

    const req = mod.request(options, (res) => {
      const responseTime = Date.now() - start;
      const up = res.statusCode >= 200 && res.statusCode < 400;
      res.resume(); // Consume response to free memory
      resolve({ up, responseTime });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ up: false, responseTime: Date.now() - start });
    });

    req.on('error', () => {
      resolve({ up: false, responseTime: Date.now() - start });
    });

    req.end();
  });
}

/**
 * TCP connect check — returns { up: boolean, responseTime: number }
 */
function checkTcp(targetIp, targetPort) {
  return new Promise((resolve) => {
    const start = Date.now();
    const socket = new net.Socket();
    socket.setTimeout(config.timeouts.monitorTcp);

    socket.on('connect', () => {
      const responseTime = Date.now() - start;
      socket.destroy();
      resolve({ up: true, responseTime });
    });

    socket.on('timeout', () => {
      socket.destroy();
      resolve({ up: false, responseTime: Date.now() - start });
    });

    socket.on('error', () => {
      socket.destroy();
      resolve({ up: false, responseTime: Date.now() - start });
    });

    socket.connect(targetPort, targetIp);
  });
}

/**
 * Check a single route and update its status
 */
async function checkRoute(route) {
  const db = getDb();
  let result;

  // Determine target IP (peer WG IP or direct target_ip)
  let targetIp = route.target_ip;
  if (route.peer_id) {
    const peer = db.prepare('SELECT allowed_ips FROM peers WHERE id = ?').get(route.peer_id);
    if (peer) targetIp = peer.allowed_ips.split('/')[0];
  }

  if (!targetIp || !route.target_port) {
    return null;
  }

  if (route.route_type === 'l4') {
    result = await checkTcp(targetIp, route.target_port);
  } else {
    result = await checkHttp(targetIp, route.target_port, !!route.backend_https);
  }

  const newStatus = result.up ? 'up' : 'down';
  const oldStatus = route.monitoring_status;
  const statusChanged = oldStatus && oldStatus !== newStatus;
  const now = new Date().toISOString();

  // Update route monitoring fields
  const updateFields = {
    monitoring_status: newStatus,
    monitoring_last_check: now,
    monitoring_response_time: result.responseTime,
  };
  if (statusChanged) {
    updateFields.monitoring_last_change = now;
  }

  db.prepare(`
    UPDATE routes SET
      monitoring_status = ?,
      monitoring_last_check = ?,
      monitoring_response_time = ?,
      monitoring_last_change = COALESCE(?, monitoring_last_change)
    WHERE id = ?
  `).run(
    updateFields.monitoring_status,
    updateFields.monitoring_last_check,
    updateFields.monitoring_response_time,
    statusChanged ? updateFields.monitoring_last_change : null,
    route.id
  );

  // Handle status change
  if (statusChanged) {
    const severity = newStatus === 'down' ? 'error' : 'success';
    const eventType = newStatus === 'down' ? 'route_down' : 'route_up';
    const message = newStatus === 'down'
      ? `Route "${route.domain}" is DOWN (${result.responseTime}ms)`
      : `Route "${route.domain}" recovered (${result.responseTime}ms)`;

    activity.log(eventType, message, {
      source: 'monitor',
      severity,
      details: { routeId: route.id, domain: route.domain, status: newStatus, responseTime: result.responseTime },
    });

    webhook.notify(eventType, message, {
      routeId: route.id,
      domain: route.domain,
      status: newStatus,
      responseTime: result.responseTime,
      previousStatus: oldStatus,
    });

    // Email alert
    const cfg = getSettings();
    if (cfg.emailAlerts && cfg.alertEmail) {
      try {
        const { sendMonitoringAlert } = require('./email');
        await sendMonitoringAlert({
          to: cfg.alertEmail,
          domain: route.domain,
          status: newStatus,
          responseTime: result.responseTime,
          target: `${targetIp}:${route.target_port}`,
        });
      } catch (err) {
        logger.warn({ err: err.message, domain: route.domain }, 'Failed to send monitoring email alert');
      }
    }

    logger.info({ routeId: route.id, domain: route.domain, status: newStatus, responseTime: result.responseTime }, 'Route status changed');
  }

  // Circuit breaker integration
  const cbResult = circuitBreaker.checkAndUpdate(route.id, result.up);
  if (cbResult && cbResult.statusChanged) {
    const cbStatus = cbResult.newStatus;
    if (cbStatus === 'open') {
      activity.log('circuit_breaker_open', `Circuit breaker opened for "${route.domain}" — returning 503`, {
        source: 'monitor',
        severity: 'warning',
        details: { routeId: route.id, domain: route.domain, cbStatus },
      });
      // Update Caddy to return 503 for this route
      try {
        const { syncToCaddy } = require('./routes');
        await syncToCaddy();
      } catch (err) {
        logger.warn({ err: err.message, routeId: route.id }, 'Failed to sync Caddy after circuit breaker open');
      }
    } else if (cbStatus === 'closed') {
      activity.log('circuit_breaker_closed', `Circuit breaker closed for "${route.domain}" — normal operation restored`, {
        source: 'monitor',
        severity: 'success',
        details: { routeId: route.id, domain: route.domain, cbStatus },
      });
      // Restore normal Caddy config
      try {
        const { syncToCaddy } = require('./routes');
        await syncToCaddy();
      } catch (err) {
        logger.warn({ err: err.message, routeId: route.id }, 'Failed to sync Caddy after circuit breaker close');
      }
    }
  }

  return { ...result, status: newStatus, changed: statusChanged };
}

/**
 * Check a single route by ID (manual check)
 */
async function checkRouteById(routeId) {
  const db = getDb();
  const route = db.prepare('SELECT * FROM routes WHERE id = ?').get(routeId);
  if (!route) throw new Error('Route not found');
  return checkRoute(route);
}

/**
 * Run all monitoring checks
 */
async function runChecks() {
  try {
    // Check circuit breaker timeouts (open -> half-open transitions)
    circuitBreaker.checkTimeouts();

    const db = getDb();
    const routes = db.prepare('SELECT * FROM routes WHERE monitoring_enabled = 1 AND enabled = 1').all();

    if (routes.length === 0) return;

    // Check for half-open circuits that need a Caddy sync
    const halfOpenRoutes = routes.filter(r => r.circuit_breaker_enabled && r.circuit_breaker_status === 'half-open');
    if (halfOpenRoutes.length > 0) {
      try {
        const { syncToCaddy } = require('./routes');
        await syncToCaddy();
      } catch (err) {
        logger.warn({ err: err.message }, 'Failed to sync Caddy for half-open circuit breakers');
      }
    }

    // Run checks in parallel (max 10 concurrent)
    const batchSize = 10;
    for (let i = 0; i < routes.length; i += batchSize) {
      const batch = routes.slice(i, i + batchSize);
      await Promise.all(batch.map(r => checkRoute(r)));
    }
  } catch (err) {
    logger.error({ error: err.message }, 'Monitoring check cycle failed');
  }
}

/**
 * Start the monitoring poller
 */
function startMonitor() {
  if (pollerInterval) return;
  const cfg = getSettings();
  const intervalMs = cfg.interval * 1000;
  logger.info({ intervalMs }, 'Starting uptime monitor');
  // Initial check after 10s (let services start)
  setTimeout(runChecks, 10000);
  pollerInterval = setInterval(runChecks, intervalMs);
}

/**
 * Stop the monitoring poller
 */
function stopMonitor() {
  if (pollerInterval) {
    clearInterval(pollerInterval);
    pollerInterval = null;
    logger.info('Uptime monitor stopped');
  }
}

/**
 * Get monitoring summary for dashboard
 */
function getSummary() {
  const db = getDb();
  const total = db.prepare('SELECT COUNT(*) as cnt FROM routes WHERE monitoring_enabled = 1 AND enabled = 1').get().cnt;
  const up = db.prepare("SELECT COUNT(*) as cnt FROM routes WHERE monitoring_enabled = 1 AND enabled = 1 AND monitoring_status = 'up'").get().cnt;
  const down = db.prepare("SELECT COUNT(*) as cnt FROM routes WHERE monitoring_enabled = 1 AND enabled = 1 AND monitoring_status = 'down'").get().cnt;
  return { total, up, down };
}

module.exports = {
  getSettings,
  checkRoute,
  checkRouteById,
  runChecks,
  startMonitor,
  stopMonitor,
  getSummary,
};
