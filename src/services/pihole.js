'use strict';

const piholeConfig = require('./piholeConfig');
const { createClient } = require('./piholeClient');
const { createSync } = require('./piholeSync');
const { makeChain, buildDnsToken } = require('./piholeDnsChain');
const { createDnsWatch } = require('./piholeDnsWatch');
const eventBus = require('./eventBus');
const settings = require('./settings');
const peers = require('./peers');
const dns = require('./dns');
const nodeDns = require('node:dns');

const DESIRED_KEY = 'pihole_blocking_desired';

function getDesired() {
  const raw = settings.get(DESIRED_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function setDesired(v) {
  if (v === null) {
    settings.set(DESIRED_KEY, '');
  } else {
    settings.set(DESIRED_KEY, JSON.stringify(v));
  }
}

const dnsChain = makeChain({
  confPath: process.env.GC_DNSMASQ_CONF || '/app/config/dnsmasq.conf',
  defaults: (process.env.GC_DNSMASQ_UPSTREAMS || '1.1.1.1,8.8.8.8').split(','),
  // Chain apply/revert changes upstream `server=` lines, which dnsmasq only
  // picks up on a real restart (SIGHUP is insufficient) — use restartDnsmasq.
  reload: () => { if (typeof dns.restartDnsmasq === 'function') dns.restartDnsmasq(); },
});

// Real DNS queries to the chain's upstreams every few seconds; falls back to
// the default upstreams while none answers (see piholeDnsWatch.js).
const dnsWatch = createDnsWatch({
  loadConfig: piholeConfig.load,
  dnsChain,
  onChange: (state, status) => {
    const down = state === 'fallback';
    try {
      require('./activity').log(
        down ? 'pihole_dns_fallback' : 'pihole_dns_restored',
        down
          ? 'Pi-hole DNS does not answer — VPN DNS falls back to the default upstreams (filter off)'
          : 'Pi-hole DNS answers again — VPN DNS goes through Pi-hole',
        { severity: down ? 'warning' : 'info', details: { targets: status.targets } },
      );
    } catch (err) {
      require('../utils/logger').warn({ err: err.message }, 'pihole dns chain: activity log failed');
    }
    const cache = sync.getCache();
    eventBus.publish('pihole', {
      summary: cache.summary,
      blocking: cache.blocking,
      attribution: cache.attribution,
      instances: cache.instances,
      dnsChain: status,
    });
  },
});

async function peersProvider() {
  const all = await peers.getAll();
  return all
    .map(p => ({ id: p.id, name: p.name, ip: dns.extractPeerIp(p.allowed_ips) }))
    .filter(p => p.ip);
}

const sync = createSync({
  loadConfig: piholeConfig.load,
  clientFactory: (inst) => createClient(inst),
  peersProvider,
  eventBus,
  loadDesired: getDesired,
});

function getCache() {
  return sync.getCache();
}

function getStatus() {
  const cache = sync.getCache();
  return { instances: cache.instances, attribution: cache.attribution, lastSyncAt: cache.lastSyncAt, dnsChain: dnsWatch.status() };
}

function setBlocking(enabled, timerSec) {
  const desired = {
    enabled,
    timer_ends_at: timerSec ? Math.floor(Date.now() / 1000) + timerSec : null,
  };
  setDesired(desired);
  return sync.triggerResync();
}

function testConnection(instance) {
  return createClient(instance).testConnection();
}

/**
 * Probe `<dns_ip>:<dns_port>` with a short-timeout DNS query.
 * Returns `{ reachable: bool, blocking: bool|null }`.
 * Never throws — errors degrade to `{ reachable: false, blocking: null }`.
 * @param {string} dns_ip
 * @param {number|string} [dns_port]
 * @returns {Promise<{reachable:boolean, blocking:boolean|null}>}
 */
async function testDns(dns_ip, dns_port) {
  if (!dns_ip) return { reachable: false, blocking: null };
  try {
    const resolver = new nodeDns.promises.Resolver({ timeout: 3000, tries: 1 });
    resolver.setServers([dns_ip + ':' + (parseInt(dns_port, 10) || 53)]);

    let reachable = false;
    try {
      const addrs = await resolver.resolve4('google.com');
      reachable = Array.isArray(addrs) && addrs.length > 0;
    } catch {
      return { reachable: false, blocking: null };
    }

    let blocking = null;
    try {
      const blocked = await resolver.resolve4('doubleclick.net');
      blocking = blocked.length === 0 || blocked.includes('0.0.0.0');
    } catch (err) {
      if (err && (err.code === 'ENODATA' || err.code === 'ENOTFOUND' || err.code === 'ESERVFAIL')) {
        blocking = true;
      } else {
        blocking = null;
      }
    }
    return { reachable, blocking };
  } catch {
    return { reachable: false, blocking: null };
  }
}

/**
 * Hint for the settings page: every DNS address of the managed chain is the
 * tunnel address of one and the same gateway — when that gateway is off, the
 * filter is off (the chain falls back to the default upstreams).
 * @param {{ enabled?: boolean, manage_dns_chain?: boolean, instances?: Array }} cfg
 * @returns {{ name: string, ip: string }|null}
 */
function chainSingleGateway(cfg) {
  if (!cfg || !cfg.enabled || !cfg.manage_dns_chain) return null;
  const ips = [...new Set((cfg.instances || []).map(i => String(i.dns_ip || '').trim()).filter(Boolean))];
  if (ips.length !== 1) return null;
  try {
    const rows = require('../db/connection').getDb()
      .prepare("SELECT name, allowed_ips FROM peers WHERE peer_type = 'gateway'").all();
    const gw = rows.find(r => dns.extractPeerIp(r.allowed_ips) === ips[0]);
    return gw ? { name: gw.name, ip: ips[0] } : null;
  } catch {
    return null;
  }
}

function applyDnsChain() {
  const cfg = piholeConfig.load();
  try {
    const tokens = (cfg.enabled && cfg.manage_dns_chain) ? cfg.instances.map(buildDnsToken).filter(Boolean) : [];
    if (!tokens.length) {
      dnsChain.revert();
    } else if (dnsWatch.status().state === 'pihole') {
      // Known to answer: take over changed addresses at once.
      dnsChain.apply(tokens);
      return;
    }
    // Chain off, just switched on, or fallen back: the watch asks the Pi-hole
    // DNS first and only then makes it the upstream — a resolver that does
    // not answer must never become the only one.
    dnsWatch.tick().catch(() => { /* tick() logs and never rejects */ });
  } catch (err) {
    const logger = require('../utils/logger');
    logger.warn({ err: err.message }, 'pihole applyDnsChain failed (conf missing?)');
  }
}

function start() {
  applyDnsChain();
  dnsWatch.start();
  sync.start();
}

function stop() {
  dnsWatch.stop();
  sync.stop();
}

module.exports = { getCache, getStatus, setBlocking, getDesired, setDesired, testConnection, testDns, buildDnsToken, applyDnsChain, chainSingleGateway, start, stop, _sync: sync, _dnsWatch: dnsWatch };
