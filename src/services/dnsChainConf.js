'use strict';

const fs = require('node:fs');
const net = require('node:net');

// The managed block carries the name of the provider that put it there:
// `# >>> gatecontrol-vpnfilter >>>` … `# <<< gatecontrol-vpnfilter <<<`.
// Blocks of any name are recognised and removed — also the
// `gatecontrol-pihole` block of the former Pi-hole integration.
// (The block of services/vpnNames.js — the zone of the device names — has
// another form on purpose and is not touched here.)
const beginOf = (provider) => `# >>> gatecontrol-${provider} >>>`;
const endOf = (provider) => `# <<< gatecontrol-${provider} <<<`;
const PROVIDER_RE = /^[a-z][a-z0-9]{0,31}$/;
const ANY_BEGIN_RE = /^# >>> gatecontrol-[a-z0-9]+ >>>$/m;

let logger;
try {
  logger = require('../utils/logger');
} catch {
  logger = { info: () => {} };
}

/**
 * Strip the managed BEGIN..END block of any provider from conf content (if present).
 * @param {string} content
 * @returns {string}
 */
function stripManaged(content) {
  return content.replace(/\n?# >>> gatecontrol-[a-z0-9]+ >>>[\s\S]*?# <<< gatecontrol-[a-z0-9]+ <<<\n?/g, '');
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
 * The upstream `server=` lines of dnsmasq.conf have ONE writer: the instance
 * services/dnsChain.js creates. A chain replaces every `server=` line, so a
 * second writer would silently undo the first one's work.
 *
 * @param {object} opts
 * @param {string}   opts.confPath  - path to dnsmasq.conf
 * @param {string[]} opts.defaults  - default upstream IPs to restore on revert
 * @param {Function} opts.reload    - callback invoked after writing (e.g. to reload dnsmasq)
 * @returns {{ apply(dnsIps: string[], opts?: { provider?: string, ecs?: boolean }): void, revert(): void }}
 */
function makeChain({ confPath, defaults, reload }) {
  let lastApplied = 'default';

  return {
    // provider: whose chain this is (names the managed block). ecs: add the
    // client address to every forwarded query (`add-subnet=32,128`), so the
    // upstream can tell the VPN devices apart.
    apply(dnsIps, { provider = 'vpnfilter', ecs = true } = {}) {
      if (!PROVIDER_RE.test(String(provider))) throw new Error('dns chain: invalid provider name');
      // No upstream at all would leave dnsmasq unable to resolve anything.
      dnsIps = (dnsIps || []).filter(isValidToken);
      if (!dnsIps.length) { this.revert(); return; }
      const key = `${provider}:${ecs ? 'ecs' : 'plain'}:` + dnsIps.join(',');
      if (lastApplied === key) return;

      let content = fs.readFileSync(confPath, 'utf8');

      // If the conf already routes to exactly these upstreams (with ECS), skip the
      // rewrite + reload entirely: no redundant dnsmasq restart (and the brief
      // DNS blip that comes with it) when the server process starts again next
      // to a dnsmasq that kept running. Compared semantically (server= set +
      // add-subnet presence), independent of the exact byte layout.
      const currentServers = (content.match(/^server=.*/gm) || [])
        .map(l => l.slice('server='.length).trim()).sort();
      const hasEcs = /^add-subnet=/m.test(content);
      if (hasEcs === !!ecs && JSON.stringify(currentServers) === JSON.stringify([...dnsIps].sort())) {
        lastApplied = key;
        logger.info(`[dnsChain] ${provider} upstreams already applied, no restart: ${dnsIps.join(', ')}`);
        return;
      }

      content = stripManaged(content);
      // A chain written by anything else (older versions baked the Pi-hole chain
      // in at boot) sits outside the managed block.
      content = stripEcsLines(content);
      content = stripServerLines(content);

      // Ensure content ends with a single newline before the block
      content = content.trimEnd();

      const block = [
        '',
        beginOf(provider),
        ...(ecs ? ['add-subnet=32,128'] : []),
        ...dnsIps.map(ip => `server=${ip}`),
        endOf(provider),
        '',
      ].join('\n');

      fs.writeFileSync(confPath, content + block);
      lastApplied = key;
      logger.info(`[dnsChain] applied ${provider} upstreams: ${dnsIps.join(', ')}`);
      reload();
    },

    revert() {
      // A missing conf throws, as in apply(): the callers treat "no dnsmasq
      // conf here" as "chain cannot be managed", not as a successful revert.
      let content = fs.readFileSync(confPath, 'utf8');

      // Decided by what the conf actually says, not by a marker or by what this
      // process remembers: versions with the Pi-hole integration baked its chain
      // into the conf at boot WITHOUT the managed block, and that chain has to
      // be revertible too (it used to be skipped — the fallback never happened
      // after a container start; today this is what takes a left-over Pi-hole
      // chain out after the update). No rewrite + restart when the conf
      // already routes to exactly the defaults.
      const currentServers = (content.match(/^server=.*/gm) || [])
        .map(l => l.slice('server='.length).trim()).sort();
      const hasEcs = /^add-subnet=/m.test(content);
      const wanted = defaults.map(ip => String(ip).trim()).filter(isValidToken);
      if (!hasEcs && !ANY_BEGIN_RE.test(content)
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
      logger.info('[dnsChain] reverted to defaults');
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
 * Build a dnsmasq server= token for a DNS target (e.g. the filter service).
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

module.exports = { makeChain, buildDnsToken, isValidDnsTarget };
