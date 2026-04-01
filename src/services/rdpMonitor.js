'use strict';

const net = require('node:net');
const { getDb } = require('../db/connection');
const config = require('../../config/default');
const logger = require('../utils/logger');

let pollerInterval = null;
const statusCache = new Map();

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
  const route = db.prepare('SELECT id, name, host, port, health_check_enabled FROM rdp_routes WHERE id = ?').get(id);
  if (!route) throw new Error('RDP route not found');
  const result = await checkTcp(route.host, route.port);
  const now = new Date().toISOString();
  statusCache.set(route.id, { online: result.online, lastCheck: now, responseTime: result.responseTime });
  return { id: route.id, online: result.online, responseTime: result.responseTime, lastCheck: now };
}

async function checkAll() {
  const db = getDb();
  const routes = db.prepare('SELECT id, name, host, port FROM rdp_routes WHERE enabled = 1 AND health_check_enabled = 1').all();
  const results = [];
  for (const route of routes) {
    try {
      const result = await checkTcp(route.host, route.port);
      const now = new Date().toISOString();
      statusCache.set(route.id, { online: result.online, lastCheck: now, responseTime: result.responseTime });
      results.push({ id: route.id, name: route.name, online: result.online, responseTime: result.responseTime });
    } catch (err) {
      logger.warn({ routeId: route.id, error: err.message }, 'RDP health check failed');
    }
  }
  return results;
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

module.exports = { checkTcp, checkRouteById, checkAll, getStatus, getAllStatus, startMonitor, stopMonitor };
