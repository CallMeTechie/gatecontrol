'use strict';

const peers = require('./peers');
const routes = require('./routes');
const system = require('./system');
const { getDb } = require('../db/connection');
const logger = require('../utils/logger');

const appStartTime = Date.now();

/**
 * Escape label values for Prometheus text format
 * Backslash, double-quote and newline must be escaped
 */
function escapeLabelValue(str) {
  if (!str) return '';
  return String(str)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');
}

/**
 * Format a single metric line with optional labels
 */
function metricLine(name, labels, value) {
  if (labels && Object.keys(labels).length > 0) {
    const labelStr = Object.entries(labels)
      .map(([k, v]) => `${k}="${escapeLabelValue(v)}"`)
      .join(',');
    return `${name}{${labelStr}} ${value}`;
  }
  return `${name} ${value}`;
}

/**
 * Format a complete metric block with HELP and TYPE
 */
function metricBlock(name, help, type, lines) {
  const parts = [
    `# HELP ${name} ${help}`,
    `# TYPE ${name} ${type}`,
  ];
  for (const line of lines) {
    parts.push(line);
  }
  return parts.join('\n');
}

/**
 * Collect all metrics and return Prometheus text format
 */
async function collect() {
  const blocks = [];

  try {
    // ─── Peer metrics ─────────────────────────────────────
    const allPeers = await peers.getAll();
    const totalPeers = allPeers.length;
    const onlinePeers = allPeers.filter(p => p.isOnline).length;
    const enabledPeers = allPeers.filter(p => p.enabled).length;

    blocks.push(metricBlock('gatecontrol_peers_total', 'Total number of WireGuard peers', 'gauge', [
      metricLine('gatecontrol_peers_total', null, totalPeers),
    ]));

    blocks.push(metricBlock('gatecontrol_peers_online', 'Number of online WireGuard peers', 'gauge', [
      metricLine('gatecontrol_peers_online', null, onlinePeers),
    ]));

    blocks.push(metricBlock('gatecontrol_peers_enabled', 'Number of enabled WireGuard peers', 'gauge', [
      metricLine('gatecontrol_peers_enabled', null, enabledPeers),
    ]));

    // Per-peer status
    const peerStatusLines = [];
    for (const p of allPeers) {
      const ip = p.allowed_ips ? p.allowed_ips.split('/')[0] : '';
      peerStatusLines.push(metricLine('gatecontrol_peer_status', { name: p.name, ip }, p.isOnline ? 1 : 0));
    }
    if (peerStatusLines.length > 0) {
      blocks.push(metricBlock('gatecontrol_peer_status', 'Peer online status (1=online, 0=offline)', 'gauge', peerStatusLines));
    }

    // Per-peer transfer
    const rxLines = [];
    const txLines = [];
    for (const p of allPeers) {
      if (p.transferRx !== undefined && p.transferRx !== null) {
        rxLines.push(metricLine('gatecontrol_peer_transfer_rx_bytes', { name: p.name }, p.transferRx));
      }
      if (p.transferTx !== undefined && p.transferTx !== null) {
        txLines.push(metricLine('gatecontrol_peer_transfer_tx_bytes', { name: p.name }, p.transferTx));
      }
    }
    if (rxLines.length > 0) {
      blocks.push(metricBlock('gatecontrol_peer_transfer_rx_bytes', 'Received bytes per peer', 'gauge', rxLines));
    }
    if (txLines.length > 0) {
      blocks.push(metricBlock('gatecontrol_peer_transfer_tx_bytes', 'Transmitted bytes per peer', 'gauge', txLines));
    }

    // ─── Route metrics ────────────────────────────────────
    const allRoutes = routes.getAll();
    const totalRoutes = allRoutes.length;
    const activeRoutes = allRoutes.filter(r => r.enabled).length;

    blocks.push(metricBlock('gatecontrol_routes_total', 'Total number of routes', 'gauge', [
      metricLine('gatecontrol_routes_total', null, totalRoutes),
    ]));

    blocks.push(metricBlock('gatecontrol_routes_active', 'Number of enabled routes', 'gauge', [
      metricLine('gatecontrol_routes_active', null, activeRoutes),
    ]));

    // Per-route monitoring status
    const monitoredRoutes = allRoutes.filter(r => r.monitoring_enabled && r.monitoring_status);
    if (monitoredRoutes.length > 0) {
      const routeStatusLines = [];
      for (const r of monitoredRoutes) {
        routeStatusLines.push(metricLine('gatecontrol_route_monitoring_status', { domain: r.domain || '' }, r.monitoring_status === 'up' ? 1 : 0));
      }
      blocks.push(metricBlock('gatecontrol_route_monitoring_status', 'Route monitoring status (1=up, 0=down)', 'gauge', routeStatusLines));
    }

    // ─── System metrics ───────────────────────────────────
    const cpu = system.getCpuUsage();
    const memory = system.getMemoryUsage();
    const uptimeSeconds = Math.floor((Date.now() - appStartTime) / 1000);

    blocks.push(metricBlock('gatecontrol_cpu_usage_percent', 'CPU usage percentage', 'gauge', [
      metricLine('gatecontrol_cpu_usage_percent', null, cpu.percent),
    ]));

    blocks.push(metricBlock('gatecontrol_memory_usage_percent', 'Memory usage percentage', 'gauge', [
      metricLine('gatecontrol_memory_usage_percent', null, memory.percent),
    ]));

    blocks.push(metricBlock('gatecontrol_uptime_seconds', 'Application uptime in seconds', 'gauge', [
      metricLine('gatecontrol_uptime_seconds', null, uptimeSeconds),
    ]));

  } catch (err) {
    logger.error({ error: err.message }, 'Failed to collect metrics');
  }

  return blocks.join('\n\n') + '\n';
}

module.exports = {
  collect,
};
