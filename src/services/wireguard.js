'use strict';

const { execFile } = require('node:child_process');
const { readFile } = require('node:fs/promises');
const { promisify } = require('node:util');
const config = require('../../config/default');
const logger = require('../utils/logger');

const exec = promisify(execFile);

async function run(cmd, args) {
  try {
    const { stdout } = await exec(cmd, args, { timeout: config.timeouts.wgCommand });
    return stdout.trim();
  } catch (err) {
    logger.error({ cmd, args, error: err.message }, 'Command execution failed');
    return null;
  }
}

/**
 * Parse `wg show <iface> dump` output.
 * Line 1: interface (privkey, pubkey, listenport, fwmark)
 * Lines 2+: peers (pubkey, psk, endpoint, allowedips, handshake, rx, tx, keepalive)
 */
async function getStatus() {
  const iface = config.wireguard.interface;
  const raw = await run('wg', ['show', iface, 'dump']);

  if (!raw) {
    return { running: false, interface: null, peers: [] };
  }

  const lines = raw.split('\n').filter(Boolean);
  if (lines.length === 0) {
    return { running: false, interface: null, peers: [] };
  }

  const ifaceParts = lines[0].split('\t');
  const ifaceData = {
    publicKey: ifaceParts[1] || '',
    listenPort: parseInt(ifaceParts[2], 10) || 0,
    fwmark: ifaceParts[3] || 'off',
  };

  const peers = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split('\t');
    if (parts.length < 8) continue;

    const latestHandshake = parseInt(parts[4], 10) || 0;
    const rx = parseInt(parts[5], 10) || 0;
    const tx = parseInt(parts[6], 10) || 0;

    // Consider online if handshake within last 3 minutes
    const settings = require('./settings');
    const peerTimeout = parseInt(settings.get('data.peer_online_timeout', '180'), 10) || 180;
    const isOnline = latestHandshake > 0 && (Date.now() / 1000 - latestHandshake) < peerTimeout;

    peers.push({
      publicKey: parts[0],
      hasPresharedKey: parts[1] !== '(none)',
      endpoint: parts[2] !== '(none)' ? parts[2] : null,
      allowedIps: parts[3],
      latestHandshake,
      transferRx: rx,
      transferTx: tx,
      persistentKeepalive: parts[7] !== 'off' ? parseInt(parts[7], 10) : 0,
      isOnline,
    });
  }

  return { running: true, interface: ifaceData, peers };
}

/**
 * Get transfer totals from all peers
 */
async function getTransferTotals() {
  const status = await getStatus();
  if (!status.running) return { totalRx: 0, totalTx: 0, peerCount: 0 };

  let totalRx = 0;
  let totalTx = 0;
  for (const peer of status.peers) {
    totalRx += peer.transferRx;
    totalTx += peer.transferTx;
  }

  return {
    totalRx,
    totalTx,
    peerCount: status.peers.length,
    onlineCount: status.peers.filter(p => p.isOnline).length,
  };
}

/**
 * Check if WireGuard interface is up
 */
async function isInterfaceUp() {
  const result = await run('wg', ['show', config.wireguard.interface]);
  return result !== null;
}

/**
 * Restart WireGuard interface
 */
async function restart() {
  const iface = config.wireguard.interface;
  logger.info({ interface: iface }, 'Restarting WireGuard');
  await run('wg-quick', ['down', iface]);
  const result = await run('wg-quick', ['up', iface]);

  if (result === null) {
    logger.error({ interface: iface }, 'WireGuard failed to start');
    return false;
  }

  // Verify interface is actually up
  const up = await isInterfaceUp();
  if (!up) {
    logger.error({ interface: iface }, 'WireGuard started but interface not responding');
    return false;
  }

  logger.info({ interface: iface }, 'WireGuard restarted and verified');
  return true;
}

/**
 * Stop WireGuard interface
 */
async function stop() {
  const iface = config.wireguard.interface;
  logger.info({ interface: iface }, 'Stopping WireGuard');
  const result = await run('wg-quick', ['down', iface]);
  return result !== null;
}

/**
 * Read the raw wg0.conf
 */
async function getConfig() {
  try {
    const content = await readFile(config.wireguard.configPath, 'utf-8');
    // Mask private key
    return content.replace(
      /(PrivateKey\s*=\s*).+/g,
      '$1••••••••••••••••••••••••••••••••••••••••••••'
    );
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to read WG config');
    return null;
  }
}

/**
 * Sync config with running interface.
 * wg syncconf only accepts pure wg directives, so we strip wg-quick lines
 * (Address, DNS, MTU, Table, PreUp, PostUp, PreDown, PostDown, SaveConfig).
 */
async function syncConfig() {
  const iface = config.wireguard.interface;
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const crypto = require('node:crypto');

  try {
    const raw = fs.readFileSync(config.wireguard.configPath, 'utf-8');
    const wgQuickKeys = /^\s*(Address|DNS|MTU|Table|PreUp|PostUp|PreDown|PostDown|SaveConfig)\s*=/i;
    const stripped = raw.split('\n').filter(line => !wgQuickKeys.test(line)).join('\n');

    const tmpFile = path.join(os.tmpdir(), `wg-sync-${iface}-${crypto.randomUUID()}.conf`);
    fs.writeFileSync(tmpFile, stripped, { mode: 0o600 });

    try {
      const result = await run('wg', ['syncconf', iface, tmpFile]);
      return result;
    } finally {
      try { fs.unlinkSync(tmpFile); } catch {}
    }
  } catch (err) {
    logger.error({ error: err.message }, 'Failed to sync WireGuard config');
    return null;
  }
}

/**
 * Ping a single IP and return latency in ms (or null on failure).
 * Uses execFile (not shell exec) — IPs come from WireGuard, not user input.
 */
async function pingHost(ip) {
  try {
    const { stdout } = await exec('ping', ['-c', '1', '-W', '2', ip], { timeout: 5000 });
    const match = stdout.match(/time[=<]([\d.]+)\s*ms/);
    return match ? parseFloat(match[1]) : null;
  } catch {
    return null;
  }
}

/**
 * Measure average latency across all online peers (via ping to their WireGuard IPs)
 */
async function getAverageLatency() {
  const status = await getStatus();
  if (!status.running) return null;

  const onlinePeers = status.peers.filter(p => p.isOnline && p.allowedIps);

  if (onlinePeers.length === 0) return null;

  // Extract the first IP from allowedIps for each peer
  const ips = onlinePeers.map(p => p.allowedIps.split(',')[0].split('/')[0]).filter(Boolean);

  if (ips.length === 0) return null;

  const results = await Promise.all(ips.map(ip => pingHost(ip)));
  const valid = results.filter(r => r !== null);

  if (valid.length === 0) return null;

  const avg = valid.reduce((sum, v) => sum + v, 0) / valid.length;
  return Math.round(avg * 10) / 10;
}

module.exports = {
  getStatus,
  getTransferTotals,
  isInterfaceUp,
  restart,
  stop,
  getConfig,
  syncConfig,
  getAverageLatency,
};
