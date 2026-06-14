'use strict';

const {
  mergeSummary,
  mergeTopList,
  mergeQueryTypes,
  mergeHistory,
  mergeBlocking,
  mapClientsToPeers,
  detectAttribution,
} = require('./piholeAggregate');
const { buildDnsToken } = require('./piholeDnsChain');
const logger = require('../utils/logger');

const REVERT_AFTER = 2;

/**
 * createSync(deps) — Pi-hole poll/aggregate loop with reconciliation + auto-revert.
 *
 * deps:
 *   loadConfig()      → { enabled, sync_interval_sec, manage_dns_chain, instances[] }
 *   clientFactory(inst) → piholeClient
 *   peersProvider()   → [{ id, name, ip }] — may be sync OR async
 *   eventBus          → { publish(type, payload) }
 *   dnsChain          → { apply(ips), revert() }
 *   now()             → Date.now() (ms) — injectable for tests
 *   loadDesired()     → { enabled, timer_ends_at } | null
 */
function createSync(deps) {
  const {
    loadConfig,
    clientFactory,
    peersProvider,
    eventBus,
    dnsChain,
    now = () => Date.now(),
    loadDesired = () => null,
  } = deps;

  let intervalId = null;
  let downCycles = 0;
  let chainReverted = false;

  // Client cache: Map<instanceId, { sig: string, client: piholeClient }>
  // Avoids re-creating (and re-logging-in) clients on every sync cycle,
  // which would hit Pi-hole v6 FTL's login rate-limit / 16-session cap.
  const clientCache = new Map();

  function getOrCreateClient(inst) {
    const sig = `${inst.url}|${inst.app_password}|${inst.verify_tls}`;
    const cached = clientCache.get(inst.id);
    if (cached && cached.sig === sig) return cached.client;
    const client = clientFactory(inst);
    clientCache.set(inst.id, { sig, client });
    return client;
  }

  let cache = {
    summary: null,
    history: [],
    topDomains: [],
    topClients: [],
    queryTypes: {},
    blocking: { state: 'unknown', timer: null },
    instances: [],
    attribution: 'collapsed',
    lastSyncAt: null,
  };

  /**
   * Pull all data from a single client in parallel.
   */
  async function pull(client) {
    const [summary, history, topDomains, topClients, queryTypes, blocking] =
      await Promise.all([
        client.getSummary(),
        client.getHistory(),
        client.getTopDomains(true),
        client.getTopClients(),
        client.getQueryTypes(),
        client.getBlocking(),
      ]);
    return { summary, history, topDomains, topClients, queryTypes, blocking };
  }

  /**
   * Reconcile blocking state across instances against the desired state.
   */
  async function reconcileBlocking(clients, perInstanceBlocking) {
    const desired = loadDesired();
    if (!desired) return;

    // timer_ends_at is in seconds (Unix epoch seconds)
    const remaining = desired.timer_ends_at
      ? Math.round(desired.timer_ends_at - (now() / 1000))
      : 0;

    // If a timer was set but it has already expired, enforce nothing
    if (desired.timer_ends_at && remaining <= 0) return;

    for (let i = 0; i < clients.length; i++) {
      const current = perInstanceBlocking[i];
      if (!current) continue;

      const isEnabled = current.blocking === true;
      if (isEnabled !== desired.enabled) {
        try {
          await clients[i].setBlocking(
            desired.enabled,
            remaining > 0 ? remaining : undefined,
          );
        } catch (err) {
          logger.warn(`[piholeSync] reconcileBlocking failed for ${clients[i].id}: ${err.message}`);
        }
      }
    }
  }

  async function syncOnce() {
    const config = loadConfig();

    if (!config.enabled || !config.instances || !config.instances.length) {
      cache = { ...cache, instances: [], lastSyncAt: now() };
      return cache;
    }

    // Prune cache entries for instances no longer in config
    const activeIds = new Set(config.instances.map(i => i.id));
    for (const id of clientCache.keys()) {
      if (!activeIds.has(id)) clientCache.delete(id);
    }
    const clients = config.instances.map(getOrCreateClient);
    const results = await Promise.allSettled(clients.map(pull));

    // Build per-instance metadata and collect fulfilled data
    const instances = [];
    const perInstanceBlocking = [];
    const ok = [];

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const inst = config.instances[i];

      if (result.status === 'fulfilled') {
        instances.push({ id: inst.id, connected: true });
        perInstanceBlocking.push(result.value.blocking ?? null);
        ok.push(result.value);
      } else {
        instances.push({ id: inst.id, connected: false, error: result.reason?.message });
        perInstanceBlocking.push(null);
      }
    }

    if (ok.length > 0) {
      const peers = await peersProvider();
      const peersByIp = {};
      for (const peer of peers) {
        peersByIp[peer.ip] = peer;
      }
      const peerIps = peers.map(p => p.ip);

      const summary = mergeSummary(ok.map(r => r.summary));
      const topClientsRaw = mergeTopList(ok.map(r => r.topClients), 'ip', 10);
      const topClients = mapClientsToPeers(topClientsRaw, peersByIp);
      const blocking = mergeBlocking(perInstanceBlocking.filter(Boolean));
      const history = mergeHistory(ok.map(r => r.history), config.sync_interval_sec || 60);
      const topDomains = mergeTopList(ok.map(r => r.topDomains), 'domain', 10);
      const queryTypes = mergeQueryTypes(ok.map(r => r.queryTypes));
      const attribution = detectAttribution(topClientsRaw.map(c => c.ip), peerIps);
      const lastSyncAt = now();

      cache = {
        ...cache,
        summary,
        history,
        topDomains,
        topClients,
        queryTypes,
        blocking,
        instances,
        attribution,
        lastSyncAt,
      };

      await reconcileBlocking(clients, perInstanceBlocking);
    } else {
      cache = { ...cache, instances, lastSyncAt: now() };
    }

    // Auto-revert DNS chain logic
    if (config.manage_dns_chain) {
      if (ok.length === 0) {
        downCycles++;
        if (downCycles >= REVERT_AFTER && !chainReverted) {
          try {
            dnsChain.revert();
          } catch (err) {
            logger.warn({ err: err.message }, 'pihole dnsChain.revert() failed');
          }
          chainReverted = true;
        }
      } else {
        downCycles = 0;
        if (chainReverted) {
          const tokens = config.instances.map(buildDnsToken).filter(Boolean);
          try {
            dnsChain.apply(tokens);
          } catch (err) {
            logger.warn({ err: err.message }, 'pihole dnsChain.apply() failed');
          }
          chainReverted = false;
        }
      }
    }

    eventBus.publish('pihole', {
      summary: cache.summary,
      blocking: cache.blocking,
      attribution: cache.attribution,
      instances: cache.instances,
    });

    return cache;
  }

  function start() {
    if (intervalId) return;
    const config = loadConfig();
    const intervalMs = (config.sync_interval_sec || 60) * 1000;
    intervalId = setInterval(
      () => syncOnce().catch(err => logger.warn({ err: err.message }, 'pihole sync cycle failed')),
      intervalMs,
    );
    if (intervalId.unref) intervalId.unref();
  }

  function stop() {
    if (intervalId !== null) {
      clearInterval(intervalId);
      intervalId = null;
    }
  }

  return {
    syncOnce,
    getCache: () => cache,
    start,
    stop,
    triggerResync: () => syncOnce(),
  };
}

module.exports = { createSync };
