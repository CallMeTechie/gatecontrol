'use strict';

const piholeConfig = require('./piholeConfig');
const { createClient } = require('./piholeClient');
const { createSync } = require('./piholeSync');
const { makeChain, buildDnsToken } = require('./piholeDnsChain');
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
  reload: () => { if (typeof dns.reloadDnsmasq === 'function') dns.reloadDnsmasq(); },
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
  dnsChain,
  loadDesired: getDesired,
});

function getCache() {
  return sync.getCache();
}

function getStatus() {
  const cache = sync.getCache();
  return { instances: cache.instances, attribution: cache.attribution, lastSyncAt: cache.lastSyncAt };
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

function applyDnsChain() {
  const cfg = piholeConfig.load();
  try {
    if (cfg.enabled && cfg.manage_dns_chain && cfg.instances.length) {
      const tokens = cfg.instances.map(buildDnsToken).filter(Boolean);
      dnsChain.apply(tokens);
    } else {
      dnsChain.revert();
    }
  } catch (err) {
    const logger = require('../utils/logger');
    logger.warn({ err: err.message }, 'pihole applyDnsChain failed (conf missing?)');
  }
}

function start() {
  applyDnsChain();
  sync.start();
}

function stop() {
  sync.stop();
}

module.exports = { getCache, getStatus, setBlocking, getDesired, setDesired, testConnection, testDns, buildDnsToken, applyDnsChain, start, stop, _sync: sync };
