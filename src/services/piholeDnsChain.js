'use strict';

const fs = require('node:fs');
const net = require('node:net');

const BEGIN = '# >>> gatecontrol-pihole >>>';
const END = '# <<< gatecontrol-pihole <<<';

let logger;
try {
  logger = require('../utils/logger');
} catch {
  logger = { info: () => {} };
}

/**
 * Strip the managed BEGIN..END block from conf content (if present).
 * @param {string} content
 * @returns {string}
 */
function stripManaged(content) {
  const escapedBegin = BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedEnd = END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\\n?${escapedBegin}[\\s\\S]*?${escapedEnd}\\n?`, 'g');
  return content.replace(re, '');
}

/**
 * Remove plain top-level `server=` lines from content.
 * @param {string} content
 * @returns {string}
 */
function stripServerLines(content) {
  return content
    .split('\n')
    .filter(line => !/^server=/.test(line))
    .join('\n');
}

/**
 * Remove top-level `add-subnet=` lines from content.
 * @param {string} content
 * @returns {string}
 */
function stripEcsLines(content) {
  return content
    .split('\n')
    .filter(line => !/^add-subnet=/.test(line))
    .join('\n');
}

/**
 * Factory for a dnsmasq upstream/ECS chain manager.
 *
 * @param {object} opts
 * @param {string}   opts.confPath  - path to dnsmasq.conf
 * @param {string[]} opts.defaults  - default upstream IPs to restore on revert
 * @param {Function} opts.reload    - callback invoked after writing (e.g. to reload dnsmasq)
 * @returns {{ apply(dnsIps: string[]): void, revert(): void }}
 */
function makeChain({ confPath, defaults, reload }) {
  let lastApplied = 'default';

  return {
    apply(dnsIps) {
      // No upstream at all would leave dnsmasq unable to resolve anything.
      dnsIps = (dnsIps || []).filter(isValidToken);
      if (!dnsIps.length) { this.revert(); return; }
      const key = 'managed:' + dnsIps.join(',');
      if (lastApplied === key) return;

      let content = fs.readFileSync(confPath, 'utf8');

      // If the conf already routes to exactly these upstreams with ECS, skip the
      // rewrite + reload entirely. entrypoint.sh bakes the same chain into the
      // conf at boot, so this avoids a redundant dnsmasq restart (and the brief
      // DNS blip that comes with it) on every container start. Compared
      // semantically (server= set + add-subnet presence), independent of the
      // exact byte layout entrypoint.sh vs. this writer produce.
      const currentServers = (content.match(/^server=.*/gm) || [])
        .map(l => l.slice('server='.length).trim()).sort();
      const hasEcs = /^add-subnet=/m.test(content);
      if (hasEcs && JSON.stringify(currentServers) === JSON.stringify([...dnsIps].sort())) {
        lastApplied = key;
        logger.info(`[piholeDnsChain] upstreams already applied, no restart: ${dnsIps.join(', ')}`);
        return;
      }

      content = stripManaged(content);
      // A chain baked in by entrypoint.sh sits outside the managed block.
      content = stripEcsLines(content);
      content = stripServerLines(content);

      // Ensure content ends with a single newline before the block
      content = content.trimEnd();

      const block = [
        '',
        BEGIN,
        'add-subnet=32,128',
        ...dnsIps.map(ip => `server=${ip}`),
        END,
        '',
      ].join('\n');

      fs.writeFileSync(confPath, content + block);
      lastApplied = key;
      logger.info(`[piholeDnsChain] applied upstreams: ${dnsIps.join(', ')}`);
      reload();
    },

    revert() {
      let content;
      try {
        content = fs.readFileSync(confPath, 'utf8');
      } catch {
        lastApplied = 'default';
        return;
      }

      // Decided by what the conf actually says, not by a marker or by what this
      // process remembers: entrypoint.sh bakes the Pi-hole chain into the conf
      // at boot WITHOUT the managed block, and that chain has to be revertible
      // too (it used to be skipped — the fallback never happened after a
      // container start). No rewrite + restart when the conf already routes to
      // exactly the defaults.
      const currentServers = (content.match(/^server=.*/gm) || [])
        .map(l => l.slice('server='.length).trim()).sort();
      const hasEcs = /^add-subnet=/m.test(content);
      const wanted = defaults.map(ip => String(ip).trim()).filter(isValidToken);
      if (!hasEcs && !content.includes(BEGIN)
        && JSON.stringify(currentServers) === JSON.stringify([...wanted].sort())) {
        lastApplied = 'default';
        return;
      }

      content = stripManaged(content);
      content = stripEcsLines(content);
      content = stripServerLines(content);
      content = content.trimEnd();

      const serverLines = wanted.map(ip => `server=${ip}`).join('\n');
      fs.writeFileSync(confPath, content + '\n' + serverLines + '\n');
      lastApplied = 'default';
      logger.info('[piholeDnsChain] reverted to defaults');
      reload();
    },
  };
}

/**
 * A DNS address/port as it may appear in a dnsmasq `server=` line: an IP
 * literal (nothing else — a line break would smuggle further dnsmasq options
 * into the conf) and a port 1–65535 (empty = 53).
 * @param {{ dns_ip?: string, dns_port?: number|string }} inst
 * @returns {boolean}
 */
function isValidDnsTarget(inst) {
  if (!inst || typeof inst.dns_ip !== 'string' || net.isIP(inst.dns_ip) === 0) return false;
  const raw = inst.dns_port;
  if (raw === undefined || raw === null || raw === '') return true;
  if (!/^\d{1,5}$/.test(String(raw))) return false;
  const port = Number(raw);
  return port >= 1 && port <= 65535;
}

/**
 * Build a dnsmasq server= token for a pihole instance.
 * Returns `ip#port` when dns_port is set and not 53, else just `ip`.
 * Returns null when dns_ip is absent or not a valid address/port.
 * @param {{ dns_ip?: string, dns_port?: number|string }} inst
 * @returns {string|null}
 */
function buildDnsToken(inst) {
  if (!isValidDnsTarget(inst)) return null;
  const port = parseInt(inst.dns_port, 10);
  return (port && port !== 53) ? `${inst.dns_ip}#${port}` : inst.dns_ip;
}

// What the writer itself accepts, whatever the caller passes: ip or ip#port.
function isValidToken(token) {
  if (typeof token !== 'string') return false;
  const [ip, port, ...rest] = token.split('#');
  return rest.length === 0 && isValidDnsTarget({ dns_ip: ip, dns_port: port });
}

module.exports = { makeChain, buildDnsToken, isValidDnsTarget, BEGIN, END };
