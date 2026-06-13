'use strict';

const piholeConfig = require('./piholeConfig');
const { createClient } = require('./piholeClient');
const { createSync } = require('./piholeSync');
const { makeChain } = require('./piholeDnsChain');
const eventBus = require('./eventBus');
const settings = require('./settings');
const peers = require('./peers');
const dns = require('./dns');

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

function applyDnsChain() {
  const cfg = piholeConfig.load();
  try {
    if (cfg.enabled && cfg.manage_dns_chain && cfg.instances.length) {
      dnsChain.apply(cfg.instances.map(i => i.dns_ip).filter(Boolean));
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

module.exports = { getCache, getStatus, setBlocking, getDesired, setDesired, testConnection, applyDnsChain, start, stop, _sync: sync };
