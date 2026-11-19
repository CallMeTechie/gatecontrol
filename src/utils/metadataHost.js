'use strict';

/**
 * Cloud metadata addresses (AWS/GCP/Azure/OpenStack, Alibaba, AWS IPv6) are
 * never a target an administrator can enter for a LAN integration (e.g. the
 * LDAP server of the directory sync). Only as IP literals: a host name that
 * resolves there is a deliberate configuration.
 */

const net = require('node:net');

const METADATA_HOSTS = new Set([
  '169.254.169.254',
  '100.100.100.200',
  'fd00:ec2::254',
]);

function normalizeHost(hostname) {
  let h = String(hostname || '').toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (net.isIPv6(h)) {
    // IPv4-mapped (::ffff:169.254.169.254 → WHATWG URL: ::ffff:a9fe:a9fe)
    const m = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
    if (m) {
      const hi = parseInt(m[1], 16), lo = parseInt(m[2], 16);
      return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
    }
    const d = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
    if (d) return d[1];
    // canonical short form, so that fd00:ec2:0::254 and the like match too
    try { return new URL(`http://[${h}]/`).hostname.slice(1, -1); } catch { return h; }
  }
  return h;
}

function isMetadataHost(hostname) {
  return METADATA_HOSTS.has(normalizeHost(hostname));
}

module.exports = { isMetadataHost };
