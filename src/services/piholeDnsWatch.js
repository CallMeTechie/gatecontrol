'use strict';

const { createChainWatch, probeDns, INTERVAL_MS, RETRY_MS, TIMEOUT_MS, DOWN_AFTER, UP_AFTER } = require('./dnsChainWatch');

/**
 * Pi-hole as a provider of the DNS chain (services/dnsChain.js): the DNS
 * addresses of the configured instances become the only upstreams of dnsmasq
 * while at least one of them answers. Cadence and hysteresis are the defaults
 * of dnsChainWatch.js — they were chosen for Pi-hole (see there).
 *
 * deps:
 *   loadConfig()  → { enabled, manage_dns_chain, instances[] }
 *   probe(inst)   → Promise<boolean>
 *   onChange(state, status) — called on pihole ⇄ fallback transitions
 */
function piholeProvider({ loadConfig, probe = probeDns, onChange = () => {}, retryMs = RETRY_MS, downAfter = DOWN_AFTER, upAfter = UP_AFTER, intervalMs = INTERVAL_MS }) {
  return {
    id: 'pihole',
    label: 'Pi-hole',
    ecs: true,
    targets() {
      const config = loadConfig();
      return (config.enabled && config.manage_dns_chain && config.instances) || [];
    },
    probe,
    onChange,
    intervalMs,
    retryMs,
    downAfter,
    upAfter,
  };
}

/**
 * createDnsWatch(deps) — a chain watch with Pi-hole as its only provider.
 * The server runs ONE watch for all providers (services/dnsChain.js); this is
 * the same state machine on its own, with the status the Pi-hole pages get.
 *
 * deps: as piholeProvider, plus
 *   dnsChain      → { apply(tokens), revert() }
 *   now()         → ms, injectable for tests
 */
function createDnsWatch(deps) {
  const provider = piholeProvider(deps);
  const watch = createChainWatch({
    providers: () => [provider],
    chain: deps.dnsChain,
    now: deps.now,
    intervalMs: deps.intervalMs,
  });
  const status = () => watch.statusFor('pihole');
  return {
    tick: () => watch.tick().then(status),
    status,
    start: watch.start,
    stop: watch.stop,
    isFallback: () => status().state === 'fallback',
  };
}

module.exports = { piholeProvider, createDnsWatch, probeDns, INTERVAL_MS, RETRY_MS, TIMEOUT_MS, DOWN_AFTER, UP_AFTER };
