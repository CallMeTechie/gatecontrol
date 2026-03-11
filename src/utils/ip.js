'use strict';

const { getDb } = require('../db/connection');
const config = require('../../config/default');

/**
 * Parse CIDR notation to base IP and prefix length
 */
function parseCidr(cidr) {
  const [ip, prefix] = cidr.split('/');
  const parts = ip.split('.').map(Number);
  const prefixLen = parseInt(prefix, 10);
  const ipNum = (parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3];
  return { ipNum, prefixLen };
}

/**
 * Convert number to IP string
 */
function numToIp(num) {
  return [
    (num >>> 24) & 255,
    (num >>> 16) & 255,
    (num >>> 8) & 255,
    num & 255,
  ].join('.');
}

/**
 * Convert IP string to number
 */
function ipToNum(ip) {
  const parts = ip.split('.').map(Number);
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

/**
 * Get the next available IP address in the configured subnet.
 * Skips the gateway IP (.1) and any already-assigned IPs.
 */
function getNextAvailableIp() {
  const db = getDb();
  const { ipNum, prefixLen } = parseCidr(config.wireguard.subnet);

  const mask = (0xFFFFFFFF << (32 - prefixLen)) >>> 0;
  const networkAddr = (ipNum & mask) >>> 0;
  const broadcastAddr = (networkAddr | ~mask) >>> 0;

  // Gather all used IPs
  const usedIps = new Set();

  // Gateway IP is reserved
  usedIps.add(ipToNum(config.wireguard.gatewayIp));

  // Network and broadcast addresses
  usedIps.add(networkAddr);
  usedIps.add(broadcastAddr);

  // All IPs assigned to peers
  const rows = db.prepare('SELECT allowed_ips FROM peers').all();
  for (const row of rows) {
    const peerIp = row.allowed_ips.split('/')[0];
    usedIps.add(ipToNum(peerIp));
  }

  // Find the first available IP
  for (let addr = networkAddr + 2; addr < broadcastAddr; addr++) {
    if (!usedIps.has(addr >>> 0)) {
      return numToIp(addr >>> 0);
    }
  }

  return null; // Subnet exhausted
}

/**
 * Validate that an IP is within the configured subnet
 */
function isInSubnet(ip) {
  const { ipNum: subnetBase, prefixLen } = parseCidr(config.wireguard.subnet);
  const mask = (0xFFFFFFFF << (32 - prefixLen)) >>> 0;
  const targetNum = ipToNum(ip);
  return ((targetNum & mask) >>> 0) === ((subnetBase & mask) >>> 0);
}

module.exports = {
  getNextAvailableIp,
  isInSubnet,
  ipToNum,
  numToIp,
  parseCidr,
};
